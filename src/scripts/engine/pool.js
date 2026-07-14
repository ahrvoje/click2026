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
const SATELLITE_MEMORY_MIB = 37;

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
 * satellite uses the compact 37 MiB build, so phones stay at one lane while
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
    // 37 MiB satellites. This is intentionally only a low-memory guard:
    // Navigator.deviceMemory is commonly capped at 8 even on large desktops.
    let byMemory = maxLanes;
    if (memoryGiB > 0) {
        const budgetMiB = memoryGiB * 1024 * 0.10;
        byMemory = budgetMiB < PRIMARY_MEMORY_MIB ? 1 :
            1 + Math.floor((budgetMiB - PRIMARY_MEMORY_MIB) / SATELLITE_MEMORY_MIB);
    }
    return Math.max(1, Math.min(maxLanes, byCores, byMemory));
}

/** A stable, exhaustive and disjoint root partition across worker lanes. */
export function rootOwner(cell, laneCount) {
    const lanes = Math.max(1, Math.floor(laneCount));
    return ((Math.floor(cell) % lanes) + lanes) % lanes;
}

export function laneOwnsRoot(cell, lane, laneCount) {
    return rootOwner(cell, laneCount) === lane;
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
 * smaller-pool restart so no modulo-owned roots are silently abandoned.
 */
export class EngineWorkerPool {
    constructor(workerURL, options = {}) {
        this.onmessage = null;
        this.onerror = null;
        this._Worker = options.Worker ?? globalThis.Worker;
        if (!this._Worker) throw new Error("Web Workers are unavailable");
        this._baseURL = new URL(String(workerURL), globalThis.location?.href ?? import.meta.url);
        this._maxLanes = Math.max(1, Math.floor(options.maxLanes ?? DEFAULT_MAX_LANES));
        const requestedLanes = options.laneCount ?? selectLaneCount(
            options.capabilities ?? detectParallelCapabilities(options.navigator),
            { maxLanes: this._maxLanes });
        this.laneCount = Math.max(1, Math.min(this._maxLanes,
            Math.floor(finiteNumber(requestedLanes, 1))));
        this._workers = [];
        this._ready = new Map();
        this._latest = new Map();
        this._lastAnalyze = null;
        this._sharedSignature = "";
        this._terminalId = null;
        this._generation = 0;
        this._terminated = false;
        this._spawn();
    }

    _spawn() {
        const generation = ++this._generation;
        this._ready.clear();
        this._latest.clear();
        this._workers = Array.from({ length: this.laneCount }, (_, lane) => {
            const url = new URL(this._baseURL);
            url.searchParams.set("lane", String(lane));
            url.searchParams.set("lanes", String(this.laneCount));
            url.searchParams.set("gpu", lane === 0 ? "1" : "0");
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

    _onLaneMessage(lane, message) {
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
            try {
                const merged = mergeLaneResults([...this._latest.values()], this.laneCount);
                if (merged.stats.settled) {
                    this._terminalId = merged.id;
                }
                this._emit(merged);
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
            } catch (error) {
                this._emit({ type: "error", message: String(error?.stack ?? error) });
            }
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

        // Modulo ownership depends on N. Restart every lane with N-1 rather
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
                gpu: lane === 0,
            });
        }
    }

    postMessage(message) {
        if (this._terminated) return;
        if (message?.type === "analyze") {
            this._latest.clear();
            this._sharedSignature = "";
            this._terminalId = null;
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
        for (const worker of this._workers) worker.terminate();
        this._workers = [];
        this._ready.clear();
        this._latest.clear();
    }
}
