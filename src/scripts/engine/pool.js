/**
 * Click2026 — adaptive independent-worker search pool.
 *
 * The pool deliberately uses ordinary module workers rather than shared WASM
 * memory.  It therefore works on static GitHub Pages hosting without
 * COOP/COEP headers and on browsers which do not expose SharedArrayBuffer.
 * Every lane owns a disjoint set of root moves; the main thread combines only
 * constructive upper bounds and independently valid lower/exact bounds.
 */

const DEFAULT_MAX_LANES = 16;
const PRIMARY_MEMORY_MIB = 178;
const SATELLITE_MEMORY_MIB = 46;
// Lane results arrive up to laneCount / POST_INTERVAL times per second — on a
// 16-lane pool that is ~100 per second — and merging, certifying, signing and
// re-emitting on every arrival scales main-thread cost with the lane count,
// enough to starve the page (frozen timer, delayed clicks) during a hard
// analysis. Snapshots are stored immediately; the merge pipeline runs at most
// once per this interval, with a trailing flush so the final snapshot lands.
const MERGE_FLUSH_INTERVAL_MS = 150;
const COORDINATED_THRESHOLD_REMAINING = 88;
// State-deduplicated fixed-prefix frontiers remain bounded on the compact
// proof gate. Never truncate a larger frontier: omitted branches would turn
// an incomplete search into an unsound lower bound. The plan is abandoned and
// blacklisted for that position instead.
const MAX_COORDINATED_THRESHOLD_FRONTIER = 8192;
const MAX_COORDINATED_THRESHOLD_ALIASES = 65536;

function finiteNumber(value, fallback = 0) {
    return Number.isFinite(value) ? Number(value) : fallback;
}

function nonNegative(value, fallback = 0) {
    return Math.max(0, finiteNumber(value, fallback));
}

/** Return the conservative capabilities used by selectLaneCount(). */
export function detectParallelCapabilities(nav = globalThis.navigator ?? {}) {
    const ua = String(nav.userAgent ?? "");
    const mobile = nav.userAgentData?.mobile === true ||
        /Android|iPhone|iPad|iPod|Mobile/i.test(ua);
    return {
        hardwareConcurrency: Math.max(1, Math.floor(finiteNumber(nav.hardwareConcurrency, 2))),
        deviceMemory: finiteNumber(nav.deviceMemory, 0),
        mobile,
    };
}

/**
 * Pick a safe number of full WASM instances.
 *
 * The primary exact-capable instance reserves about 178 MiB. Each beam/root
 * satellite uses the compact 46 MiB build, so phones stay at one lane while
 * many-core desktops can safely reach sixteen. Callers may lower maxLanes, and
 * tests/developer tools may explicitly force a count.
 */
export function selectLaneCount(capabilities, options = {}) {
    const maxLanes = Math.max(1, Math.floor(finiteNumber(
        options.maxLanes, DEFAULT_MAX_LANES)));
    if (Number.isFinite(options.forceLanes)) {
        return Math.max(1, Math.min(maxLanes, Math.floor(options.forceLanes)));
    }

    const cores = Math.max(1, Math.floor(finiteNumber(
        capabilities?.hardwareConcurrency, 2)));
    const memoryGiB = nonNegative(capabilities?.deviceMemory);
    const mobile = capabilities?.mobile === true;
    if (mobile) return 1;

    let byCores;
    if (cores <= 4) byCores = 1;
    else if (cores <= 8) byCores = 2;
    else if (cores <= 12) byCores = 3;
    else if (cores <= 16) byCores = 4;
    else if (cores <= 24) byCores = 8;
    else byCores = 16;

    // Navigator.deviceMemory is privacy-rounded and capped (commonly at
    // 8 GiB), so it is useful for detecting small devices, not large ones.
    // Reserve no more than roughly 10% for the 178 MiB primary plus compact
    // 46 MiB satellites. This is intentionally only a low-memory guard:
    // Navigator.deviceMemory is commonly capped at 8 even on large desktops.
    let byMemory = maxLanes;
    if (memoryGiB > 0 && memoryGiB < 8) {
        const budgetMiB = memoryGiB * 1024 * 0.10;
        byMemory = budgetMiB < PRIMARY_MEMORY_MIB ? 1 :
            1 + Math.floor((budgetMiB - PRIMARY_MEMORY_MIB) / SATELLITE_MEMORY_MIB);
    }
    return Math.max(1, Math.min(maxLanes, byCores, byMemory));
}

/** A stable, exhaustive and count-balanced root partition across worker lanes. */
export function rootOwner(rootIndex, laneCount) {
    const lanes = Math.max(1, Math.floor(laneCount));
    return ((Math.floor(rootIndex) % lanes) + lanes) % lanes;
}

export function laneOwnsRoot(rootIndex, lane, laneCount) {
    return rootOwner(rootIndex, laneCount) === lane;
}

/**
 * Derive independent non-zero 32-bit search seeds for stochastic beam passes.
 * Root ownership prevents duplicate exact/private work; different seeds keep
 * global portfolio lanes from walking the same beam corridor.
 */
export function laneSeed(baseSeed, lane, pass = 0) {
    let x = (Number(baseSeed) >>> 0) ^ Math.imul((lane | 0) + 1, 0x9E3779B1) ^
        Math.imul((pass | 0) + 1, 0x85EBCA77);
    x ^= x >>> 16;
    x = Math.imul(x, 0x7FEB352D);
    x ^= x >>> 15;
    x = Math.imul(x, 0x846CA68B);
    x ^= x >>> 16;
    return (x >>> 0) || 1;
}

function thresholdPlanMatches(plan, message) {
    return plan !== null && message.id === plan.id && message.epoch === plan.epoch &&
        message.target === plan.target;
}

function canonicalThresholdChildren(children) {
    if (!Array.isArray(children)) throw new Error("threshold children are not an array");
    const canonical = children.map((entry) => {
        const cell = Math.floor(finiteNumber(entry?.cell, -1));
        const source = entry?.board;
        const board = source instanceof Uint8Array ? source :
            Array.isArray(source) ? Uint8Array.from(source) : null;
        if (cell < 0 || cell >= 144 || !board || board.length !== 144 ||
            board.some((value) => value > 5)) {
            throw new Error("threshold child has an invalid cell or board");
        }
        // Exact byte equality is the proof identity. Hash-only grouping would
        // make a collision capable of certifying an unrelated branch.
        let stateKey = "";
        for (let at = 0; at < board.length; at += 48) {
            stateKey += String.fromCharCode(...board.subarray(at, at + 48));
        }
        return { cell, stateKey };
    });
    if (canonical.some((entry, index) => index > 0 &&
        entry.cell <= canonical[index - 1].cell)) {
        throw new Error("threshold children are not strictly canonical");
    }
    return canonical;
}

function sameThresholdChildren(left, right) {
    if (left === null || right === null) return left === right;
    return left.length === right.length && left.every((entry, index) =>
        entry.cell === right[index].cell && entry.stateKey === right[index].stateKey);
}

function canonicalPrefix(prefix) {
    if (!Array.isArray(prefix) || prefix.length >= 80) {
        throw new Error("threshold prefix is not a bounded array");
    }
    const canonical = prefix.map((cell) => Math.floor(finiteNumber(cell, -1)));
    if (canonical.some((cell) => cell < 0 || cell >= 144)) {
        throw new Error("threshold prefix contains an invalid cell");
    }
    return canonical;
}

const thresholdTaskKey = (rootCell, prefix) => `${rootCell}/${prefix.join(",")}`;
const thresholdAttemptKey = (id, target) => `${id}/${target}`;

function proofOf(moves) {
    if (moves.length === 0) {
        return {
            positionLower: null,
            positionUpper: null,
            positionExact: false,
            allMovesExact: false,
        };
    }
    const positionUpper = Math.min(...moves.map((move) => move.score));
    const positionLower = Math.min(...moves.map((move) =>
        move.exact ? move.score : move.lower));
    const allMovesExact = moves.every((move) => move.exact);
    return {
        positionLower,
        positionUpper,
        positionExact: positionLower === positionUpper,
        allMovesExact,
    };
}

function normalizedCpu(stats) {
    const cpu = stats?.cpu ?? {};
    return {
        positions: nonNegative(cpu.positions,
            finiteNumber(stats?.cpuPositions, finiteNumber(stats?.nodes, 0))),
        pps: nonNegative(cpu.pps, finiteNumber(stats?.cpuPps, NaN)),
        beamPositions: nonNegative(cpu.beamPositions, stats?.cpuBeamPositions),
        exactPositions: nonNegative(cpu.exactPositions, stats?.cpuExactPositions),
        playoutPositions: nonNegative(cpu.playoutPositions, stats?.cpuPlayoutPositions),
        playouts: nonNegative(cpu.playouts, stats?.cpuPlayouts),
    };
}

function normalizedGpu(stats) {
    const gpu = stats?.gpuStats ?? {};
    return {
        positions: nonNegative(gpu.positions, stats?.gpuPositions),
        pps: nonNegative(gpu.pps, finiteNumber(stats?.gpuPps, NaN)),
        playouts: nonNegative(gpu.playouts, stats?.gpuPlayouts),
        batches: nonNegative(gpu.batches, stats?.gpuBatches),
        activeMs: nonNegative(gpu.activeMs, stats?.gpuActiveMs),
        profile: typeof gpu.profile === "string" ? gpu.profile : null,
        adapter: gpu.adapter && typeof gpu.adapter === "object" ? gpu.adapter : null,
    };
}

function sum(items, key) {
    return items.reduce((total, item) => total + nonNegative(item[key]), 0);
}

function mergeStats(results, moves, expectedLanes) {
    const sourceStats = results.map((result) => result.stats ?? {});
    const elapsed = Math.max(1, ...sourceStats.map((stats) => nonNegative(stats.elapsed)));
    const cpus = sourceStats.map(normalizedCpu);
    const gpus = sourceStats.map(normalizedGpu);
    const cpuPositions = sum(cpus, "positions");
    const gpuPositions = sum(gpus, "positions");
    const gpuActiveMs = sum(gpus, "activeMs");
    const cpuWallPps = cpuPositions / elapsed * 1000;
    const gpuWallPps = gpuPositions / elapsed * 1000;
    const gpuActivePps = gpuPositions / Math.max(1, gpuActiveMs) * 1000;
    const totalPositions = cpuPositions + gpuPositions;
    const gpuIdentity = gpus.find((entry) => entry.profile || entry.adapter) ?? {};
    const proof = proofOf(moves);
    const allLanesStopped = results.length === expectedLanes &&
        sourceStats.every((stats) => stats.settled === true);

    let gpuState = "off";
    if (sourceStats.some((stats) => stats.gpu === "on")) gpuState = "on";
    else if (sourceStats.some((stats) => stats.gpu === "failed")) gpuState = "failed";

    return {
        // Legacy totals remain available to existing UI and tooling.
        nodes: cpuPositions,
        nps: cpuWallPps,
        totalPositions,
        totalPps: totalPositions / elapsed * 1000,
        depth: Math.max(0, ...sourceStats.map((stats) => nonNegative(stats.depth))),
        width: Math.max(0, ...sourceStats.map((stats) => nonNegative(stats.width))),
        elapsed,
        gpu: gpuState,
        settled: allLanesStopped,
        // The exact rows can arrive one lane before the final stopped
        // snapshots. Keep that bounded wind-down labeled `optimal`; `proven`
        // is the immutable terminal snapshot and must never be followed by
        // changing positions/rates.
        state: proof.allMovesExact && allLanesStopped ? "proven" :
            proof.positionExact ? "optimal" :
            allLanesStopped ? "settled" : "analyzing",
        ...proof,
        cpu: {
            workers: expectedLanes,
            positions: cpuPositions,
            // Honest pool wall-average. Summing each lane's lifetime average
            // leaves stale non-zero rates behind after easy owners stop and
            // can overstate late throughput by several times.
            pps: cpuWallPps,
            beamPositions: sum(cpus, "beamPositions"),
            exactPositions: sum(cpus, "exactPositions"),
            playoutPositions: sum(cpus, "playoutPositions"),
            playouts: sum(cpus, "playouts"),
        },
        gpuStats: {
            positions: gpuPositions,
            // `pps` is the effective contribution over analysis wall time;
            // activePps describes kernel throughput only while the GPU works.
            pps: gpuWallPps,
            activePps: gpuActivePps,
            duty: Math.min(100, gpuActiveMs / elapsed * 100),
            profile: gpuIdentity.profile ?? null,
            adapter: gpuIdentity.adapter ?? null,
            playouts: sum(gpus, "playouts"),
            batches: sum(gpus, "batches"),
            activeMs: gpuActiveMs,
        },
    };
}

function mergeMoveVersions(versions, cell) {
    for (const move of versions) {
        if (!Number.isFinite(move?.score) || !Number.isFinite(move?.lower) ||
            move.score < 0 || move.lower < 0 || move.lower > move.score) {
            throw new Error(`invalid worker bounds for root ${cell}`);
        }
        if (typeof move.exact !== "boolean") {
            throw new Error(`invalid worker exact flag for root ${cell}`);
        }
    }

    const exact = versions.filter((move) => move.exact);
    if (exact.length > 0) {
        const value = exact[0].score;
        if (exact.some((move) => move.score !== value)) {
            throw new Error(`worker proof disagreement for root ${cell}`);
        }
        if (versions.some((move) => move.score < value)) {
            throw new Error(`constructive score contradicts proof for root ${cell}`);
        }
        if (versions.some((move) => move.lower > value)) {
            throw new Error(`lower bound contradicts proof for root ${cell}`);
        }
        const chosen = exact.reduce((best, move) =>
            move.line?.length < best.line?.length ? move : best, exact[0]);
        return { ...chosen, score: value, lower: value, exact: true };
    }

    const chosen = versions.reduce((best, move) =>
        move.score < best.score ||
        (move.score === best.score && (move.line?.length ?? Infinity) <
            (best.line?.length ?? Infinity)) ? move : best, versions[0]);
    const lower = Math.max(...versions.map((move) => move.lower));
    if (lower > chosen.score) {
        throw new Error(`lower bound contradicts constructive score for root ${cell}`);
    }
    return {
        ...chosen,
        lower,
        exact: false,
    };
}

/**
 * Soundly merge the latest result from each independent lane.
 *
 * Scores are constructive upper bounds, so the minimum is retained. Lower
 * bounds are independently sound, so the maximum is retained. One exact
 * proof is sufficient for that root; contradictory claims fail closed.
 */
export function mergeLaneResults(laneResults, expectedLanes = laneResults.length) {
    const results = laneResults.filter(Boolean);
    if (results.length === 0) return null;
    const id = results[0].id;
    if (results.some((result) => result.id !== id)) {
        throw new Error("cannot merge results from different positions");
    }
    const remaining = results[0].remaining;
    if (results.some((result) => result.remaining !== remaining)) {
        throw new Error("worker board disagreement");
    }

    const byCell = new Map();
    for (const result of results) {
        for (const move of result.moves ?? []) {
            const versions = byCell.get(move.cell) ?? [];
            versions.push(move);
            byCell.set(move.cell, versions);
        }
    }
    const moves = Array.from(byCell, ([cell, versions]) =>
        mergeMoveVersions(versions, cell));
    moves.sort((a, b) => a.score - b.score || b.size - a.size || a.cell - b.cell);
    return {
        type: "result",
        id,
        remaining,
        moves,
        stats: mergeStats(results, moves, expectedLanes),
    };
}

/**
 * Worker-compatible facade owned by the main thread. Lane zero owns WebGPU
 * and the full exact engine; all satellite lanes are CPU-only. A failed lane causes a full,
 * smaller-pool restart so no ordinal-owned roots are silently abandoned.
 */
export class EngineWorkerPool {
    constructor(workerURL, options = {}) {
        this.onmessage = null;
        this.onerror = null;
        this._Worker = options.Worker ?? globalThis.Worker;
        if (!this._Worker) throw new Error("Web Workers are unavailable");
        this._baseURL = new URL(String(workerURL), globalThis.location?.href ?? import.meta.url);
        this._maxLanes = Math.max(1, Math.floor(options.maxLanes ?? DEFAULT_MAX_LANES));
        // cpuSearch=false keeps a single lane whose sustained work is the GPU
        // playout pump; gpuAllowed=false never grants lane zero WebGPU access
        this._cpuSearch = options.cpuSearch !== false;
        this._gpuAllowed = options.gpuAllowed !== false;
        const requestedLanes = options.laneCount ?? selectLaneCount(
            options.capabilities ?? detectParallelCapabilities(options.navigator),
            { maxLanes: this._maxLanes });
        this._fullLanes = this._cpuSearch ? Math.max(1, Math.min(this._maxLanes,
            Math.floor(finiteNumber(requestedLanes, 1)))) : 1;
        // Resource scaling: at reduced utilization it is better to run fewer
        // lanes flat out than every lane at a small duty cycle — parked cores
        // actually sleep (cooler and quieter than a whole package kept half
        // awake by per-lane pacing timers), each surviving lane keeps a hot
        // persistent value memo, and the main thread merges proportionally
        // fewer snapshots. Only the fractional remainder is paced inside the
        // lanes: 16 lanes at 20% become round(3.2) = 3 lanes at flat out.
        const scaled = this._scaledLanes(options.resourcePercent);
        this._resourcePercent = scaled.percent;
        // Without CPU search the single pump lane's JS is just bookkeeping —
        // never pace it; the GPU device is paced by its own share below.
        this._laneUtilPercent = this._cpuSearch ? scaled.util : 100;
        this.laneCount = scaled.lanes;
        // The GPU device gains nothing from dropped CPU lanes, so it paces
        // against its own raw share, independent of the lane residual.
        this._gpuResourcePercent = Math.min(100, Math.max(1, Math.round(
            finiteNumber(options.gpuResourcePercent, scaled.percent))));
        this._workers = [];
        this._ready = new Map();
        this._latest = new Map();
        this._mergeIntervalMs = Math.max(0, finiteNumber(options.mergeIntervalMs, MERGE_FLUSH_INTERVAL_MS));
        this._mergeFlushTimer = null;
        this._lastMergeFlushAt = -Infinity;
        this._lastAnalyze = null;
        this._sharedSignature = "";
        this._terminalId = null;
        this._caretakerStopId = null;
        this._thresholdEpoch = 0;
        this._thresholdPlan = null;
        this._thresholdFrontier = [];
        this._thresholdFrontierIndex = new Map();
        this._thresholdRootPending = new Map();
        this._thresholdOutcomes = new Map();
        this._thresholdRound = -1;
        this._certifiedLowers = new Map();
        this._thresholdUnplannable = new Set();
        this._generation = 0;
        this._terminated = false;
        this._spawn();
    }

    // Resource percent -> lane count plus per-lane residual utilization. The
    // target is fullLanes × percent lane-equivalents; rounding to whole lanes
    // keeps the total within half a lane of the target and the residual pace
    // (worker.js pace()/GPU gate) absorbs the remainder. Always at least one.
    _scaledLanes(percent) {
        const clamped = Math.min(100, Math.max(1,
            Math.round(finiteNumber(percent, 100))));
        const target = this._fullLanes * clamped / 100;
        const lanes = Math.max(1, Math.round(target));
        return {
            percent: clamped,
            lanes,
            util: Math.min(100, Math.max(1, Math.round(target / lanes * 100))),
        };
    }

    // True when a settings change moves the scaled lane count itself — the
    // caller restarts the pool (like a processor toggle); a same-count change
    // is applied live through a translated throttle message instead. A pool
    // without CPU search is always exactly one pump lane.
    resourceRestartNeeded(percent) {
        if (!this._cpuSearch) return false;
        return this._scaledLanes(percent).lanes !== this.laneCount;
    }

    _spawn() {
        const generation = ++this._generation;
        this._ready.clear();
        this._cancelResultFlush();
        this._latest.clear();
        this._cancelThresholdPlan(false);
        this._certifiedLowers.clear();
        this._thresholdUnplannable.clear();
        this._sharedSignature = "";
        this._terminalId = null;
        this._caretakerStopId = null;
        this._workers = Array.from({ length: this.laneCount }, (_, lane) => {
            const url = new URL(this._baseURL);
            url.searchParams.set("lane", String(lane));
            url.searchParams.set("lanes", String(this.laneCount));
            url.searchParams.set("gpu", lane === 0 && this._gpuAllowed ? "1" : "0");
            url.searchParams.set("cpu", this._cpuSearch ? "1" : "0");
            const worker = new this._Worker(url, {
                type: "module",
                name: `click2026-engine-${lane + 1}-of-${this.laneCount}`,
            });
            worker.onmessage = (event) => {
                if (generation === this._generation) this._onLaneMessage(lane, event.data);
            };
            worker.onerror = (event) => {
                if (generation === this._generation) this._onLaneError(event);
            };
            return worker;
        });
    }

    _emit(data) {
        this.onmessage?.({ data });
    }

    _resetThresholdCoverage() {
        this._thresholdFrontier = [];
        this._thresholdFrontierIndex.clear();
        this._thresholdRootPending.clear();
        this._thresholdOutcomes.clear();
        this._thresholdRound = -1;
    }

    _cancelThresholdPlan(notify = true) {
        const previous = this._thresholdPlan;
        this._thresholdPlan = null;
        this._thresholdEpoch++;
        this._resetThresholdCoverage();
        if (notify && previous) {
            for (const worker of this._workers) {
                worker.postMessage({
                    type: "threshold-cancel",
                    id: previous.id,
                    epoch: previous.epoch,
                });
            }
        }
    }

    _applyCertifiedLowers(merged) {
        if (!merged) return merged;
        for (const move of merged.moves) {
            const certified = this._certifiedLowers.get(move.cell);
            if (!Number.isFinite(certified) || certified <= move.lower) continue;
            if (certified > move.score) {
                throw new Error(`threshold certificate contradicts root ${move.cell}`);
            }
            move.lower = certified;
            if (move.lower === move.score) move.exact = true;
        }
        merged.moves.sort((a, b) => a.score - b.score || b.size - a.size || a.cell - b.cell);
        const proof = proofOf(merged.moves);
        Object.assign(merged.stats, proof);
        merged.stats.state = proof.allMovesExact && merged.stats.settled ? "proven" :
            proof.positionExact ? "optimal" :
            merged.stats.settled ? "settled" : "analyzing";
        return merged;
    }

    _latestMerged() {
        if (this._latest.size === 0) return null;
        return this._applyCertifiedLowers(
            mergeLaneResults([...this._latest.values()], this.laneCount));
    }

    _ensureThresholdPlan(merged) {
        // coordinated proofs are CPU B&B ladders — meaningless without CPU search
        if (!this._cpuSearch) return;
        if (!merged || this._latest.size !== this.laneCount ||
            merged.stats.positionUpper <= 0 || merged.stats.positionExact) {
            if (this._thresholdPlan) this._cancelThresholdPlan();
            return;
        }

        const target = merged.stats.positionUpper - 1;
        if (this._thresholdUnplannable.has(
            thresholdAttemptKey(merged.id, target))) return;
        if (this._thresholdPlan) {
            if (this._thresholdPlan.id === merged.id &&
                this._thresholdPlan.target === target &&
                this._thresholdPlan.roots.every((cell) => {
                    const row = merged.moves.find((move) => move.cell === cell);
                    return row && !row.exact && row.lower <= target && row.score > target;
                })) {
                return;
            }
            this._cancelThresholdPlan();
        }

        const candidates = merged.moves
            .filter((move) => !move.exact && move.lower <= target && move.score > target &&
                merged.remaining - move.size <= COORDINATED_THRESHOLD_REMAINING)
            .sort((a, b) => a.cell - b.cell);
        if (candidates.length === 0) return;

        this._resetThresholdCoverage();
        const plan = {
            id: merged.id,
            epoch: ++this._thresholdEpoch,
            target,
            roots: candidates.map((move) => move.cell),
        };
        this._thresholdPlan = plan;
        this._thresholdRound = 0;
        if (!this._setThresholdFrontier(
            plan.roots.map((rootCell) => ({ rootCell, prefix: [] })))) {
            this._thresholdUnplannable.add(thresholdAttemptKey(plan.id, plan.target));
            this._cancelThresholdPlan();
            return;
        }
        for (const worker of this._workers) {
            worker.postMessage({ type: "threshold-plan", ...plan });
        }
        this._broadcastThresholdFrontier();
    }

    _thresholdMessageError(error) {
        const plan = this._thresholdPlan;
        if (plan) this._thresholdUnplannable.add(
            thresholdAttemptKey(plan.id, plan.target));
        this._emit({ type: "error", message: String(error?.stack ?? error) });
        this._cancelThresholdPlan();
    }

    _broadcastThresholdFrontier() {
        const plan = this._thresholdPlan;
        if (!plan) return;
        const message = {
            type: "threshold-frontier",
            id: plan.id,
            epoch: plan.epoch,
            target: plan.target,
            round: this._thresholdRound,
            tasks: this._thresholdFrontier.map(({ rootCell, prefix }) => ({
                rootCell,
                prefix: prefix.slice(),
            })),
        };
        for (const worker of this._workers) worker.postMessage(message);
    }

    _setThresholdFrontier(tasks) {
        if (tasks.length > MAX_COORDINATED_THRESHOLD_FRONTIER) {
            return false;
        }
        let aliasCount = 0;
        this._thresholdFrontier = tasks.map((task) => {
            const aliases = Array.isArray(task.aliases) && task.aliases.length > 0 ?
                task.aliases.map((alias) => ({
                    rootCell: Math.floor(finiteNumber(alias.rootCell, -1)),
                    prefix: canonicalPrefix(alias.prefix),
                })) : [{
                    rootCell: Math.floor(finiteNumber(task.rootCell, -1)),
                    prefix: canonicalPrefix(task.prefix),
                }];
            if (aliases.some((alias) => alias.rootCell < 0 || alias.rootCell >= 144) ||
                new Set(aliases.map((alias) => alias.rootCell)).size !== aliases.length) {
                throw new Error("threshold task aliases are invalid or duplicate a root");
            }
            aliasCount += aliases.length;
            const representative = aliases[0];
            return {
                rootCell: representative.rootCell,
                prefix: representative.prefix.slice(),
                aliases,
                stateKey: typeof task.stateKey === "string" ? task.stateKey : null,
            };
        });
        if (aliasCount > MAX_COORDINATED_THRESHOLD_ALIASES) {
            this._thresholdFrontier = [];
            return false;
        }
        this._thresholdFrontierIndex.clear();
        this._thresholdRootPending.clear();
        for (let index = 0; index < this._thresholdFrontier.length; index++) {
            const task = this._thresholdFrontier[index];
            const key = thresholdTaskKey(task.rootCell, task.prefix);
            if (this._thresholdFrontierIndex.has(key)) {
                throw new Error(`duplicate threshold frontier task ${key}`);
            }
            this._thresholdFrontierIndex.set(key, index);
            for (const alias of task.aliases) {
                this._thresholdRootPending.set(alias.rootCell,
                    (this._thresholdRootPending.get(alias.rootCell) ?? 0) + 1);
            }
        }
        return true;
    }

    _onThresholdMiss(lane, message) {
        this._acceptThresholdOutcome(lane, message, "miss");
    }

    _onThresholdSplit(lane, message) {
        this._acceptThresholdOutcome(lane, message, "split");
    }

    _certifyThresholdRoot(rootCell) {
        const plan = this._thresholdPlan;
        if (!plan || !plan.roots.includes(rootCell)) return false;
        const lower = plan.target + 1;
        this._certifiedLowers.set(rootCell,
            Math.max(lower, this._certifiedLowers.get(rootCell) ?? 0));
        plan.roots = plan.roots.filter((cell) => cell !== rootCell);
        for (const worker of this._workers) {
            worker.postMessage({
                type: "threshold-root-bound",
                id: plan.id,
                epoch: plan.epoch,
                rootCell,
                lower,
            });
        }
        return true;
    }

    _nextThresholdFrontier() {
        const byState = new Map();
        let aliasCount = 0;
        for (const task of this._thresholdFrontier) {
            const outcome = this._thresholdOutcomes.get(
                thresholdTaskKey(task.rootCell, task.prefix));
            if (outcome.type !== "split") continue;
            for (const child of outcome.children) {
                let grouped = byState.get(child.stateKey);
                if (!grouped) {
                    grouped = {
                        stateKey: child.stateKey,
                        aliases: [],
                        roots: new Set(),
                    };
                    byState.set(child.stateKey, grouped);
                    if (byState.size > MAX_COORDINATED_THRESHOLD_FRONTIER) return null;
                }
                // Every alias is the same exact board before this move, so the
                // canonical child cell produces the same exact successor. One
                // replayable prefix per participating root is sufficient; all
                // other commuting paths have the identical future game.
                for (const alias of task.aliases) {
                    if (grouped.roots.has(alias.rootCell)) continue;
                    grouped.roots.add(alias.rootCell);
                    aliasCount++;
                    if (aliasCount > MAX_COORDINATED_THRESHOLD_ALIASES) return null;
                    grouped.aliases.push({
                        rootCell: alias.rootCell,
                        prefix: [...alias.prefix, child.cell],
                    });
                }
            }
        }
        return [...byState.values()].map(({ stateKey, aliases }) => ({
            stateKey,
            aliases,
        }));
    }

    _emitThresholdProgress() {
        const merged = this._latestMerged();
        if (!merged) return;
        this._emit(merged);
        if (merged.id === this._lastAnalyze?.id) this._ensureThresholdPlan(merged);
    }

    _acceptThresholdOutcome(lane, message, type) {
        if (!thresholdPlanMatches(this._thresholdPlan, message)) return;
        if (message.round !== this._thresholdRound) return;
        const rootCell = Math.floor(finiteNumber(message.rootCell, -1));
        const prefix = canonicalPrefix(message.prefix);
        const key = thresholdTaskKey(rootCell, prefix);
        const index = this._thresholdFrontierIndex.get(key);
        if (index === undefined) {
            throw new Error(`threshold outcome ${key} is outside the frontier`);
        }
        if (index % this.laneCount !== lane) {
            throw new Error(`lane ${lane} does not own threshold task ${key}`);
        }
        let children = null;
        if (type === "split") {
            children = canonicalThresholdChildren(message.children);
            if (children.length === 0 || prefix.length + 1 >= 80) {
                throw new Error(`threshold task ${key} has an invalid split`);
            }
        }
        const previous = this._thresholdOutcomes.get(key);
        if (previous) {
            if (previous.type !== type ||
                !sameThresholdChildren(previous.children, children)) {
                throw new Error(`threshold task ${key} changed its completed outcome`);
            }
            return; // an identical duplicate must not discharge aliases twice
        }
        this._thresholdOutcomes.set(key, { type, children });

        let certified = false;
        if (type === "miss") {
            const task = this._thresholdFrontier[index];
            for (const alias of task.aliases) {
                const pending = (this._thresholdRootPending.get(alias.rootCell) ?? 0) - 1;
                if (pending < 0) {
                    throw new Error(`threshold root ${alias.rootCell} over-completed`);
                }
                this._thresholdRootPending.set(alias.rootCell, pending);
                // A split is never decremented, so zero means the root's
                // complete current dependency set consists only of misses.
                if (pending === 0) {
                    certified = this._certifyThresholdRoot(alias.rootCell) || certified;
                }
            }
        }
        if (this._thresholdOutcomes.size !== this._thresholdFrontier.length) {
            if (certified) this._emitThresholdProgress();
            return;
        }

        const plan = this._thresholdPlan;
        const next = this._nextThresholdFrontier();
        if (next === null) {
            this._thresholdUnplannable.add(
                thresholdAttemptKey(plan.id, plan.target));
            this._cancelThresholdPlan();
            this._emitThresholdProgress();
            return;
        }
        const unresolvedRoots = new Set(next.flatMap((task) =>
            task.aliases.map((alias) => alias.rootCell)));
        const resolvedRoots = plan.roots.filter((cell) => !unresolvedRoots.has(cell));
        for (const rootCell of resolvedRoots) {
            this._certifyThresholdRoot(rootCell);
        }

        this._thresholdOutcomes.clear();
        if (next.length === 0) {
            // The workers keep their own copy of the coordinated plan. Merely
            // clearing the pool state leaves each lane alive with an empty
            // task queue, producing periodic idle results forever after the
            // proof completed. Use the normal protocol transition so every
            // lane cancels its local ladder before final progress is emitted.
            this._cancelThresholdPlan();
        } else {
            plan.roots = [...unresolvedRoots].sort((a, b) => a - b);
            if (!this._setThresholdFrontier(next)) {
                this._thresholdUnplannable.add(
                    thresholdAttemptKey(plan.id, plan.target));
                this._cancelThresholdPlan();
                this._emitThresholdProgress();
                return;
            }
            this._thresholdRound++;
            this._broadcastThresholdFrontier();
        }

        this._emitThresholdProgress();
    }

    _onLaneMessage(lane, message) {
        if (message.type === "threshold-prefix-miss") {
            try {
                this._onThresholdMiss(lane, message);
            } catch (error) {
                this._thresholdMessageError(error);
            }
            return;
        }
        if (message.type === "threshold-prefix-split") {
            try {
                this._onThresholdSplit(lane, message);
            } catch (error) {
                this._thresholdMessageError(error);
            }
            return;
        }
        if (message.type === "ready") {
            this._ready.set(lane, message);
            if (this._ready.size === this.laneCount) {
                const owner = this._ready.get(0);
                this._emit({
                    type: "ready",
                    gpu: owner?.gpu ?? "off",
                    workers: this.laneCount,
                });
            }
            return;
        }
        if (message.type === "result") {
            if (message.id !== this._lastAnalyze?.id) return;
            if (message.id === this._terminalId) return;
            this._latest.set(lane, message);
            this._scheduleResultFlush();
            return;
        }
        if (message.type === "error") {
            this._onLaneError({ message: message.message });
        }
    }

    _onLaneError(event) {
        if (this._terminated) return;
        if (this.laneCount <= 1) {
            this.onerror?.(event);
            return;
        }

        // Ordinal-modulo ownership depends on N. Restart every lane with N-1 rather
        // than leaving one failed lane's roots permanently unsearched.
        for (const worker of this._workers) worker.terminate();
        this.laneCount--;
        this._spawn();
        if (this._lastAnalyze) this._broadcastAnalyze(this._lastAnalyze);
    }

    _broadcastAnalyze(message) {
        for (let lane = 0; lane < this._workers.length; lane++) {
            const board = message.board instanceof Uint8Array ?
                message.board.slice() : Uint8Array.from(message.board);
            this._workers[lane].postMessage({
                ...message,
                board,
                lane,
                lanes: this.laneCount,
                gpu: lane === 0 && this._gpuAllowed,
                // lanes absorb most of the CPU reduction, so each runs the
                // residual; the GPU device is unaffected by lane count and
                // paces against its own raw share
                ...(message.resourcePercent == null ? {} : {
                    resourcePercent: this._laneUtilPercent,
                    gpuResourcePercent: this._gpuResourcePercent,
                }),
            });
        }
    }

    // Rate-limits the merge pipeline (see MERGE_FLUSH_INTERVAL_MS). A flush
    // runs immediately when the interval has already passed, so a lone result
    // still surfaces without delay; bursts coalesce into one trailing flush.
    _scheduleResultFlush() {
        if (this._mergeIntervalMs <= 0) {
            this._flushResults();
            return;
        }
        if (this._mergeFlushTimer !== null) return;
        const wait = this._lastMergeFlushAt + this._mergeIntervalMs - Date.now();
        if (wait <= 0) {
            this._flushResults();
            return;
        }
        this._mergeFlushTimer = setTimeout(() => {
            this._mergeFlushTimer = null;
            this._flushResults();
        }, wait);
    }

    _cancelResultFlush() {
        if (this._mergeFlushTimer !== null) {
            clearTimeout(this._mergeFlushTimer);
            this._mergeFlushTimer = null;
        }
        this._lastMergeFlushAt = -Infinity;
    }

    /**
     * User-configured stop conditions from the analyze message. Any may be
     * combined; the first one satisfied names the stop reason. Falsy/absent
     * fields mean unlimited, so old callers keep the engine's own stops only.
     */
    _limitReached(merged) {
        const limits = this._lastAnalyze?.limits;
        if (!limits) return null;
        if (limits.stopOnZero && merged.moves.length > 0 &&
            merged.moves[0].score === 0) {
            return "zero";
        }
        if (limits.maxTimeMs > 0 && merged.stats.elapsed >= limits.maxTimeMs) {
            return "time";
        }
        if (limits.maxPositions > 0 &&
            merged.stats.totalPositions >= limits.maxPositions) {
            return "positions";
        }
        return null;
    }

    _flushResults() {
        this._lastMergeFlushAt = Date.now();
        if (this._terminated || this._latest.size === 0) return;
        const id = this._lastAnalyze?.id;
        const snapshots = [...this._latest.values()].filter((result) => result.id === id);
        if (snapshots.length === 0 || id === this._terminalId) return;
        try {
            const merged = this._applyCertifiedLowers(
                mergeLaneResults(snapshots, this.laneCount));
            const stopReason = merged.stats.settled ? null : this._limitReached(merged);
            if (stopReason) {
                // a user limit ends the analysis: latch this merged snapshot
                // as terminal and put every lane to sleep; the moves shown are
                // the best found so far, exactly like a settled stop
                merged.stats.settled = true;
                merged.stats.stopReason = stopReason;
                merged.stats.state = merged.stats.allMovesExact ? "proven" : "stopped";
            }
            if (merged.stats.settled) {
                this._terminalId = merged.id;
            }
            this._emit(merged);
            if (stopReason) {
                for (const worker of this._workers) {
                    worker.postMessage({ type: "stop", id: merged.id });
                }
                this._cancelThresholdPlan(false);
                return;
            }
            if (merged.id !== this._lastAnalyze?.id) return;
            if (this.laneCount > 1 && this._caretakerStopId !== merged.id &&
                Array.from({ length: this.laneCount - 1 }, (_, index) => index + 1)
                    .every((peer) => this._latest.get(peer)?.stats?.settled === true)) {
                this._caretakerStopId = merged.id;
                this._workers[0]?.postMessage({ type: "stop-caretaker", id: merged.id });
            }
            const signature = merged.moves.map((move) =>
                `${move.cell}:${move.score}:${move.exact ? 1 : 0}:${move.line?.join(",") ?? ""}`)
                .join("|");
            if (signature !== this._sharedSignature) {
                this._sharedSignature = signature;
                const seeds = merged.moves
                    .filter((move) => Array.isArray(move.line) && move.line.length > 0)
                    .map((move) => ({
                        line: move.line,
                        score: move.score,
                        exact: move.exact,
                    }));
                for (const worker of this._workers) {
                    worker.postMessage({ type: "merge", id: merged.id, seeds });
                }
            }
            this._ensureThresholdPlan(merged);
        } catch (error) {
            this._emit({ type: "error", message: String(error?.stack ?? error) });
        }
    }

    postMessage(message) {
        if (this._terminated) return;
        if (message?.type === "throttle") {
            // Live resource change with an unchanged scaled lane count (the
            // caller restarts the pool otherwise): retranslate the user's
            // percent into the per-lane residual before forwarding.
            const scaled = this._scaledLanes(message.percent);
            this._resourcePercent = scaled.percent;
            this._laneUtilPercent = this._cpuSearch ? scaled.util : 100;
            this._gpuResourcePercent = Math.min(100, Math.max(1, Math.round(
                finiteNumber(message.gpuPercent, scaled.percent))));
            for (const worker of this._workers) {
                worker.postMessage({ type: "throttle",
                    percent: this._laneUtilPercent,
                    gpuPercent: this._gpuResourcePercent });
            }
            return;
        }
        if (message?.type === "analyze") {
            this._cancelResultFlush();
            this._latest.clear();
            this._sharedSignature = "";
            this._terminalId = null;
            this._caretakerStopId = null;
            this._cancelThresholdPlan(false);
            this._certifiedLowers.clear();
            this._thresholdUnplannable.clear();
            this._lastAnalyze = {
                ...message,
                board: message.board instanceof Uint8Array ?
                    message.board.slice() : Uint8Array.from(message.board),
            };
            this._broadcastAnalyze(this._lastAnalyze);
            return;
        }
        for (const worker of this._workers) worker.postMessage(message);
    }

    terminate() {
        this._terminated = true;
        this._generation++;
        this._cancelResultFlush();
        for (const worker of this._workers) worker.terminate();
        this._workers = [];
        this._ready.clear();
        this._latest.clear();
    }
}
