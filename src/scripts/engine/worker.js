/**
 * Click2026 — engine worker: anytime analysis scheduler around the WASM core.
 *
 * Runs off the main thread. Receives positions, streams back ranked move
 * lists like a chess engine, and restarts instantly when the player moves.
 *
 * Protocol (see docs/ENGINE.md "Worker protocol"):
 *   main -> worker  {type:"analyze", id, board}   board = Uint8Array(144), column-major
 *   worker -> main  {type:"ready", gpu}
 *                   {type:"result", id, remaining, moves, stats}
 *
 * Analysis schedule per position (each stage refines the previous one, a
 * result is posted after every stage):
 *   1. greedy baselines            — instant score for every root move
 *   2. one-ply child tables        — every second move gets the child's cheap baseline
 *   3. CPU playout portfolio       — strong tabu policy plus full-support samples
 *   4. GPU second-ply assist       — heuristic ranking, CPU/WASM replay boundary
 *   5. widening beam passes        — deterministic, widths 8..2048
 *      with one bounded permanent-only late-game portfolio member
 *   6. virtual-child portfolio     — second moves receive the same lane-
 *      partitioned beam heaps they would get after the first move is played
 *   7. position-proof portfolio    — bounded, fair B&B probes above the
 *      persistent exact gate
 *   8. continuous investigation    — alternating global beam passes (widths
 *      512..16384) and root-locked passes that widen independently per move,
 *      plus playout rounds biased to the current top moves
 *      (GPU-accelerated when WebGPU is available); once the board is small
 *      enough, a hybrid B&B/value-memo ladder takes priority until every
 *      move is proved; threatening roots within one child move of the exact
 *      gate get the same escalating value attempts pre-play (capped per
 *      root) that their child would run right after being played; farther
 *      above the gate (boards ≤ 132), every (first, second, third) prefix
 *      gets the clicked child's own virtual-child schedule — 100k/1M target
 *      seeks plus deterministic and diversified prefix beams — running
 *      back-to-back once the position value is certified; both audits
 *      block settlement until finished or proved; ladder attempts rotate
 *      least-invested-budget first, so one un-enumerable child cannot
 *      starve siblings of their first bounded attempt, and once lane
 *      zero's own roots are exact it adopts unproven satellite-owned
 *      in-band roots on its full-size value memo (satellite memos are 32x
 *      smaller and can thrash for minutes on children the primary proves
 *      in seconds; any lane's proof merges soundly in the pool)
 *
 * Analysis ends in exactly three ways: a new position arrives, EVERY move is
 * proven optimal ("proven"), or SETTLE_PASSES unchanged *global* max-width
 * passes plus a private max-width audit find nothing on a board too large to
 * enumerate ("settled") — never by an arbitrary timer. Stagnation first
 * escalates width and removes root starvation, then stops honestly.
 * Bigger-group hopefuls — moves with larger groups than the current best
 * that might match its score — get first claim on locked passes, playouts
 * and proofs, because equal outcomes with bigger groups are faster to play.
 *
 * Knowledge survives moves: every posted result is cached by board key, and
 * a new analysis is seeded with the cached lines of its own position plus
 * the line suffixes of the previous position and cached one-ply child lines
 * (all replay-validated in WASM), so forward play and rewind retain knowledge.
 *
 * Copyright 2014-2026, Hrvoje Abraham ahrvoje@gmail.com
 * Released under the MIT license.
 * https://opensource.org/licenses/MIT
 *
 * Date: Tue Jul 14, 2026
 */

// These query revisions must match ENGINE_ASSET_VERSION in engine-ui.js.
// Versioning the complete module graph prevents a cached pre-change helper
// from making the worker fail during static module linking.
import { createGpu, dominantColor } from "./gpu.js?build=20260714-pairband1";
import {
    analysisState, canTransferExactSuffix, caretakerProofCandidates, createSearchProgress,
    exactCandidateOrder, pairAuditCandidates, parityProofCandidates, positionProofCandidates,
    recordSearchPass, remainingAfterMove, roundRobinPrefixTasks, settlementReady,
    shouldGpuCaretake, summarizePositionProof,
} from "./schedule.js?build=20260714-pairband1";
import { laneOwnsRoot, laneSeed } from "./pool.js?build=20260714-pairband1";

const workerParams = new URL(self.location.href).searchParams;
const LANES = Math.max(1, Number.parseInt(workerParams.get("lanes") ?? "1", 10) || 1);
const LANE = Math.min(LANES - 1,
    Math.max(0, Number.parseInt(workerParams.get("lane") ?? "0", 10) || 0));
const GPU_ALLOWED = workerParams.get("gpu") !== "0";

const SIZE = 12;
const CHUNK = 16000;            // beam expansions per slice, ~10 ms
const EXACT_CHUNK = 60000;      // exact solver expansions per slice
const EXACT_REMAINING = 56;     // eight exact chunks per scheduler quantum at/below this size
const EXACT_TRY_REMAINING = 88; // up to here: four-chunk quanta, still back-to-back prioritized
const CLEAR_PORTFOLIO_REMAINING = 72; // late positions merit an orthogonal clear-focused beam
const CLEAR_PORTFOLIO_WIDTH = 8192;
const CLEAR_PORTFOLIO_SCORE = 5;
const CLEAR_PORTFOLIO_ROOTS = 2;
const BOUND_TRY_REMAINING = 64; // above this, the fixed B&B probe only delayed hard value proofs
const BOUND_BUDGET = 2000000;   // one fast branch-and-bound attempt before full value solving
const POSITION_PROBE_BUDGET = 2000000; // one fair threshold/proof turn per threatening large-board root
const POSITION_PROBE_ROOTS = 16; // 32M-node board cap; remaining roots keep the normal fairness audit
const EXACT_BUDGET = 8000000;   // first value-memo attempt; retries resume and escalate ×4
const EXACT_BUDGET_MAX = 2000000000; // i32-safe budget per resumable attempt
// Pre/post-play proof parity: a threatening root within one child move of the
// exact gate gets the same escalating value attempts its child position would
// run immediately after being played, capped at roughly what the child's
// first post-play seconds buy (one 8M attempt plus one ×4 retry) so
// settlement stays reachable.
const EXACT_PARITY_BUDGET = 32000000;
// Constructive parity for threatening roots farther above the gate. The
// clicked child re-runs its whole virtual-child portfolio one forced ply
// deeper: every (second, third) prefix gets a 100k then a 1M-node target
// seek plus deterministic and diversified prefix beams. One free ply of
// depth costs more than an order of magnitude — a (first, second) seek at
// 16M and a width-8192 (first, second) beam both provably miss zeros the
// child's 1M seeks / width-2048 beams find quickly. Give threatening
// parents the identical (first, second, third) turns: same subtrees, same
// budgets, same widths. Only boards a played child could plausibly prove
// fast participate. 120 was miscalibrated: on a measured 127-cell position
// two rows stuck at 1/0 through the full (first, second) schedule while
// their played children proved zero from the (second, third) tiers — the
// same rounds below prove them pre-play (one at the 1M seek, one at the
// width-512 prefix beam). 132 covers that whole one-move band; audits stay
// bounded by the threat filter, gap-first ordering and round rotation.
const PAIR_AUDIT_ROUNDS = [
    { seek: 100000 }, { seek: 1000000 },
    { width: 128, seed: 0 }, { width: 512, seed: 0 },
    { width: 2048, seed: 0 }, { width: 2048, seed: 1 }, { width: 2048, seed: 2 },
];
const PAIR_AUDIT_REMAINING = 132;
const LINE_BUDGET = 64000000;   // initial memo-guided line seek; rare retries escalate ×4
const WIDEN_WIDTHS = [8, 32, 128, 512, 2048];
// A clicked child receives deterministic lane-partitioned beams, then private
// diversified retries. Mirror that bounded early allocation inside each
// unresolved parent row so its second moves do not compete in one giant heap.
const VIRTUAL_CHILD_PASSES = [
    [128, 0], [512, 0], [2048, 0], [2048, 1], [2048, 2],
];
const VIRTUAL_CHILD_PROOF_BUDGETS = [100000, 1000000];
const WIDTH_TIERS = [512, 1024, 2048, 4096, 8192, 16384]; // stagnation climbs this ladder
const LOCKED_WIDTHS = [2048, 4096, 8192, 16384]; // each root gets private iterative widening
const SOFT_PLAYOUT_DIVISOR = 8; // supplement hard tabu without replacing its samples
const TOP_RANKS = 5;            // core top-five plus the first positive row get focused compute
const SETTLE_PASSES = 24;       // unchanged max-width global passes before settlement
const CACHE_MAX = 64;           // remembered positions for warm starts
const POST_INTERVAL_MS = 150;
const GPU_BEAM_ASSIST_PER_ROOT = 2;
const GPU_BEAM_ASSIST_MAX_BOARDS = 4096;

let eng = null;
let IO = 0;
let gpu = null;
let gpuState = "off";           // "off" | "on" | "failed"
let pendingGpu = null;          // one shared-buffer batch may be in flight

let job = null;
let jobVersion = 0;
let kickWaiter = null;
const jobChangeWaiters = new Set();

// warm-start memory: boardKey -> last posted move list (lines, scores, proofs);
// insertion order doubles as LRU order
const resultCache = new Map();
let prevAnalysis = null; // { key, moves } of the most recently analyzed position

// fast macrotask yield — setTimeout(0) clamps, a MessageChannel does not
const tickChannel = new MessageChannel();
const tickQueue = [];
tickChannel.port1.onmessage = () => tickQueue.shift()?.();
const nextTick = () => new Promise((resolve) => {
    tickQueue.push(resolve);
    tickChannel.port2.postMessage(0);
});

const mem = () => new Uint8Array(eng.memory.buffer);
const owns = (move) => laneOwnsRoot(move.cell, LANE, LANES);
const ownedMoves = (moves) => moves.filter(owns);
const ownedComplete = (moves) => ownedMoves(moves).every((move) => move.exact);
const childRemaining = (move) => remainingAfterMove(eng.getRemaining(), move);

self.onmessage = (event) => {
    const msg = event.data;
    if (msg.type === "analyze") {
        job = msg;
        jobVersion++;
        for (const wake of jobChangeWaiters) wake();
        jobChangeWaiters.clear();
        if (kickWaiter) {
            kickWaiter();
            kickWaiter = null;
        }
    } else if (msg.type === "merge" && eng && job && msg.id === job.id) {
        // Share only replayable constructive lines and independently proven
        // flags. seedLine validates every move inside WASM before accepting
        // it, so a stale or malformed peer result cannot corrupt this lane.
        for (const seed of msg.seeds ?? []) {
            if (!Array.isArray(seed.line) || seed.line.length === 0 || seed.line.length > 80) continue;
            mem().set(Uint8Array.from(seed.line), IO);
            const final = eng.seedLine(seed.line.length);
            if (seed.exact && final === seed.score) {
                eng.seedExactByCell(seed.line[0], seed.score);
            }
        }
    }
};

// --- result collection -------------------------------------------------------

// parses the collect() snapshot — layout documented in asm/engine.ts
function collectResults() {
    const len = eng.collect();
    const bytes = mem().slice(IO, IO + len);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

    const rootCount = view.getUint32(0, true);
    const nodes = view.getUint32(4, true) + view.getUint32(8, true) * 2 ** 32;
    const depth = view.getUint32(12, true);
    const width = view.getUint32(16, true);
    const remaining = view.getUint32(20, true);

    const moves = [];
    let at = 24;
    for (let k = 0; k < rootCount; k++) {
        const cell = bytes[at];
        moves.push({
            k, // enumeration index — the id WASM calls (playoutRoot, exact…) expect
            cell,
            x: Math.floor(cell / SIZE),
            y: cell % SIZE,
            color: bytes[at + 1],
            size: bytes[at + 2],
            exact: bytes[at + 3] !== 0,
            score: view.getInt32(at + 4, true),
            lower: eng.getRootLower(k),
        });
        at += 8;
    }
    for (let k = 0; k < rootCount; k++) {
        const n = bytes[at++];
        moves[k].cells = Array.from(bytes.slice(at, at + n), (c) => [Math.floor(c / SIZE), c % SIZE]);
        at += n;
    }
    for (let k = 0; k < rootCount; k++) {
        const n = bytes[at++];
        moves[k].line = Array.from(bytes.slice(at, at + n));
        at += n;
    }

    // Optional accounting footer. Keeping it after the variable-length move
    // data preserves compatibility with scalar/older engine binaries.
    const cpu = {
        positions: nodes,
        beamPositions: nodes,
        exactPositions: 0,
        playoutPositions: 0,
        playouts: 0,
        simd: false,
        compact: LANE > 0,
    };
    if (bytes.length >= at + 40 && view.getUint32(at, true) === 0x32544154) {
        const flags = view.getUint32(at + 4, true);
        const u64 = (offset) => view.getUint32(offset, true) +
            view.getUint32(offset + 4, true) * 2 ** 32;
        cpu.beamPositions = u64(at + 8);
        cpu.exactPositions = u64(at + 16);
        cpu.playoutPositions = u64(at + 24);
        cpu.playouts = u64(at + 32);
        cpu.positions = cpu.beamPositions + cpu.exactPositions + cpu.playoutPositions;
        cpu.simd = (flags & 1) !== 0;
        cpu.compact = (flags & 2) !== 0;
    }

    // chess-engine ordering: best score first, then bigger groups
    moves.sort((a, b) => a.score - b.score || b.size - a.size || a.cell - b.cell);

    return { moves, nodes: cpu.positions, depth, width, remaining, cpu };
}

// --- analysis ----------------------------------------------------------------

async function analyze(myJob, isStale) {
    const t0 = performance.now();
    let lastPost = 0;
    let latestGpuMoves = [];
    // Even a satellite whose first-move roots finish early is useful to a
    // clicked child: it would own some of that child's second moves. Keep all
    // lanes alive through the bounded virtual-child audit below.
    let virtualChildAuditComplete = false;
    const key = myJob.board.join(",");
    // A batch submitted by the replaced position still updates lifetime
    // counters when it completes. Let this position start its CPU baseline
    // immediately, but hold its GPU counter baseline until that old bounded
    // dispatch drains. Until then posts report zero new GPU work.
    const inheritedGpu = pendingGpu;
    let gpuStart = inheritedGpu === null ? (gpu?.getStats?.() ?? {}) : null;
    const gpuBaselineReady = inheritedGpu === null ? Promise.resolve() :
        inheritedGpu.catch(() => { /* disableGpu handles failures */ }).then(() => {
            gpuStart = gpu?.getStats?.() ?? {};
        });

    mem().set(myJob.board, IO);
    eng.setBoard();
    // Record the real one-ply child relation before search starts. A replayed
    // suffix is always a useful constructive seed, but it may carry an exact
    // proof only into the board actually produced by its first move.
    const analysisChildKeys = new Map();
    for (const root of collectResults().moves) {
        if (eng.childToIO(root.k) === 1) {
            analysisChildKeys.set(root.cell,
                mem().slice(IO, IO + SIZE * SIZE).join(","));
        }
    }
    seedFromMemory(key);

    const post = (settled) => {
        const { moves, nodes, depth, width, remaining, cpu } = collectResults();
        latestGpuMoves = moves;
        const proof = summarizePositionProof(moves, (move) => move.lower);
        const elapsed = performance.now() - t0;
        const rawGpu = gpu?.getStats?.() ?? {};
        const gpuBaseline = gpuStart ?? rawGpu;
        const gpuPositions = Math.max(0,
            (rawGpu.positionsProcessed ?? 0) - (gpuBaseline.positionsProcessed ?? 0) +
            (rawGpu.evaluationBoardsGpu ?? 0) - (gpuBaseline.evaluationBoardsGpu ?? 0));
        const gpuPlayouts = Math.max(0,
            (rawGpu.playoutsCompleted ?? 0) - (gpuBaseline.playoutsCompleted ?? 0));
        const gpuBatches = Math.max(0,
            (rawGpu.dispatchesCompleted ?? 0) - (gpuBaseline.dispatchesCompleted ?? 0) +
            (rawGpu.evaluationDispatches ?? 0) - (gpuBaseline.evaluationDispatches ?? 0));
        // Wall-activity counters are interval unions, so overlapping striped
        // dispatches count once. Summed timestamp-query durations are useful
        // diagnostics but can be 2-3x wall time on a pooled discrete GPU and
        // must not be displayed as duty time or used as its throughput base.
        const gpuActiveMs = Math.max(0,
            ((rawGpu.dispatchWallMs ?? rawGpu.gpuTimeMs) ?? 0) -
            ((gpuBaseline.dispatchWallMs ?? gpuBaseline.gpuTimeMs) ?? 0) +
            ((rawGpu.evaluationWallMs ?? rawGpu.evaluationGpuTimeMs) ?? 0) -
            ((gpuBaseline.evaluationWallMs ?? gpuBaseline.evaluationGpuTimeMs) ?? 0));
        const gpuStats = {
            positions: gpuPositions,
            pps: gpuPositions / Math.max(1, gpuActiveMs) * 1000,
            playouts: gpuPlayouts,
            batches: gpuBatches,
            activeMs: gpuActiveMs,
            profile: rawGpu.profile ?? null,
            adapter: gpu?.getCapabilities?.().adapter ?? null,
        };

        // remember this position for warm starts (LRU refresh on re-insert)
        resultCache.delete(key);
        resultCache.set(key, moves);
        if (resultCache.size > CACHE_MAX) {
            resultCache.delete(resultCache.keys().next().value);
        }
        prevAnalysis = { key, moves, childKeys: analysisChildKeys };

        self.postMessage({
            type: "result",
            id: myJob.id,
            remaining,
            moves,
            stats: {
                nodes,
                depth,
                width,
                elapsed,
                nps: nodes / Math.max(1, elapsed) * 1000,
                gpu: gpuState,
                settled: settled === true,
                lane: LANE,
                lanes: LANES,
                totalPositions: nodes + gpuStats.positions,
                cpu: {
                    workers: 1,
                    positions: cpu.positions,
                    pps: cpu.positions / Math.max(1, elapsed) * 1000,
                    beamPositions: cpu.beamPositions,
                    exactPositions: cpu.exactPositions,
                    playoutPositions: cpu.playoutPositions,
                    playouts: cpu.playouts,
                    simd: cpu.simd,
                    compact: cpu.compact,
                },
                gpuStats,
                positionLower: proof.positionLower,
                positionUpper: proof.positionUpper,
                positionExact: proof.positionExact,
                allMovesExact: proof.allMovesExact,
                // `optimal` certifies the position value while the worker
                // keeps auditing alternatives; `proven` retains its stronger
                // historical meaning that every move row is exact.
                state: analysisState(proof, settled === true),
            },
        });
        lastPost = performance.now();
        return moves;
    };

    const postIfDue = () => {
        if (performance.now() - lastPost > POST_INTERVAL_MS) post(false);
    };

    // 1. greedy baselines are already in (setBoard), show them immediately
    let moves = post(false);
    if (moves.length === 0) return; // terminal position — nothing to analyze

    let seedBase = laneSeed(1, LANE, 0);
    let gpuSeedBase = laneSeed(0x47505531 ^ (Number(myJob.id) || 0), LANE, 2);
    let gpuPumpEnabled = false;
    let gpuPumpFallback = 512;
    const gpuSamplesFor = (snapshot, fallback) => gpu?.recommendPlayouts?.(
        snapshot.filter((move) => !move.exact).length) ?? fallback;

    // Keep one logical batch (internally striped over the GPU resource slots)
    // continuously queued.  Batch preparation and replay verification execute
    // only at ordinary JavaScript task boundaries, never concurrently with a
    // WASM call.  The GPU owns copies of its boards after submission, so the
    // CPU remains free to advance beam/exact chunks in the meantime.
    const launchGpuBatch = () => {
        if (pendingGpu !== null || gpuState !== "on") return false;
        const snapshot = latestGpuMoves;
        if (!gpuPumpEnabled || isStale() || !snapshot.some((move) => !move.exact)) return false;
        const samples = gpuSamplesFor(snapshot, gpuPumpFallback);
        const seed = gpuSeedBase;
        gpuSeedBase = (gpuSeedBase + samples) >>> 0;
        let pending;
        pending = gpuRound(snapshot, samples, seed, isStale)
            .catch(() => disableGpu())
            .then(() => {
                // A verified playout may have completed a root. Refresh the
                // next batch before requeueing so proved rows consume no more
                // device time. collectResults() is a synchronous WASM call at
                // this task boundary, so it cannot race a beam/exact step.
                if (!isStale() && eng) latestGpuMoves = collectResults().moves;
            })
            .finally(() => {
                if (pendingGpu === pending) pendingGpu = null;
                if (gpuPumpEnabled && !isStale() && gpuState === "on" &&
                    latestGpuMoves.some((move) => !move.exact)) {
                    // Use a macrotask rather than an unbounded microtask chain:
                    // position-change messages stay promptly preemptive even
                    // with a mock/driver that resolves a batch immediately.
                    void nextTick().then(() => launchGpuBatch());
                }
            });
        pendingGpu = pending;
        return true;
    };
    const startGpuPump = (fallback = gpuPumpFallback) => {
        gpuPumpFallback = fallback;
        gpuPumpEnabled = true;
        return launchGpuBatch();
    };
    const stopGpuPump = () => { gpuPumpEnabled = false; };
    const drainGpu = async () => {
        const pending = pendingGpu;
        if (pending === null) return;
        let wakeJobChange;
        const changed = new Promise((resolve) => {
            wakeJobChange = resolve;
            jobChangeWaiters.add(resolve);
        });
        if (isStale()) wakeJobChange();
        try {
            await Promise.race([pending, changed]);
        } finally {
            jobChangeWaiters.delete(wakeJobChange);
        }
    };

    // Created before the lane-completion check: pre-play proof parity work
    // spans lanes, so even a lane whose own roots are complete may still owe
    // pair seeks for threatening roots it does not own.
    const ladder = createExactLadder(isStale, postIfDue);

    // CPU root ownership is disjoint, but WebGPU can cheaply sample every
    // root.  Lane zero therefore remains as a GPU caretaker after its own CPU
    // roots finish, consuming replay-validated proof/line seeds broadcast by
    // the pool until the global table is exact.  This is the case that used to
    // leave the GPU idle after roughly one second in a multi-lane analysis.
    const finishLaneIfComplete = async (snapshot) => {
        if (!ownedComplete(snapshot)) return false;
        if (!virtualChildAuditComplete) return false;
        // Like the virtual-child audit, parity pair seeks are partitioned
        // across every lane. Stay alive until this lane's bounded slice is
        // proved out or capped, or most of a threatening root's second moves
        // would silently lose their escalated audit turns.
        if (ladder.pendingProofCount(snapshot) > 0) return false;
        if (!shouldGpuCaretake(snapshot, LANE, gpuState)) {
            stopGpuPump();
            post(true);
            return true;
        }

        await gpuBaselineReady;
        if (isStale()) { stopGpuPump(); return true; }
        latestGpuMoves = snapshot;
        startGpuPump(1024);
        for (;;) {
            if (isStale()) { stopGpuPump(); return true; }
            if (pendingGpu === null) launchGpuBatch();
            await drainGpu();
            if (isStale()) { stopGpuPump(); return true; }

            let current = collectResults().moves;
            latestGpuMoves = current;
            if (current.every((move) => move.exact) || gpuState !== "on") {
                stopGpuPump();
                post(true);
                return true;
            }
            if (performance.now() - lastPost > POST_INTERVAL_MS) current = post(false);
            latestGpuMoves = current;
        }
    };

    // The child position gives every possible second move an independent
    // greedy baseline. Lift that cheap table into each owned parent root now,
    // instead of forcing a difficult alternative to wait for a max-width beam
    // before discovering the same two-ply tactic after the user clicks it.
    for (const move of moves) {
        if (isStale()) return;
        if (move.exact || !owns(move)) continue;
        eng.probeRootChildTable(move.k);
        if ((move.k & 7) === 7) await nextTick();
    }
    moves = post(false);

    if (await finishLaneIfComplete(moves)) return;

    // 3. quick CPU playout round: 32 playouts per root move
    for (let k = 0; k < moves.length; k++) {
        if (isStale()) return;
        const move = moves.find((candidate) => candidate.k === k);
        if (!move || move.exact || !owns(move)) continue;
        eng.playoutRoot(k, 32, seedBase);
        eng.playoutRootSoft(k, 32 / SOFT_PLAYOUT_DIVISOR, seedBase);
        seedBase += 32;
        if (k % 8 === 7) {
            postIfDue();
            await nextTick();
        }
    }
    moves = post(false);
    if (await finishLaneIfComplete(moves)) return;

    await gpuBaselineReady;
    if (isStale()) return;

    // GPU-ranked second-ply portfolio. Feature scores are heuristic only;
    // selected candidates are completed and replay-validated by WASM before
    // they can update a root result.
    seedBase = await gpuBeamAssist(moves, seedBase, isStale);
    if (isStale()) return;
    moves = post(false);
    if (await finishLaneIfComplete(moves)) return;

    // From here until a stale job, a failed GPU, settlement or a complete
    // proof, completed batches immediately enqueue their successor.  This
    // spans beam passes, proof portfolios and exact-only quanta instead of
    // tying GPU duty cycle to the much slower outer CPU stages.
    startGpuPump(512);

    // 5. deterministic widening beam passes — always the full ladder, even
    // when a clear shows up early: the other top moves still need refining
    for (const width of WIDEN_WIDTHS) {
        eng.beamBeginPartition(width, 0, LANE, LANES);
        for (;;) {
            if (isStale()) return;
            if (eng.beamStep(CHUNK) === 1) break;
            postIfDue();
            await nextTick();
        }
        if (isStale()) return;
        moves = post(false);
        if (await finishLaneIfComplete(moves)) return;

        // Every normal beam shares the tuned fragmentation heuristic. Near
        // the end, add a bounded orthogonal member before the widest default
        // pass: it keeps only progress + proved-permanent penalties, rescuing
        // solutions that must look temporarily fragmented for a move or two.
        if (width === 512) {
            const candidates = moves.filter((m) => owns(m) && !m.exact &&
                childRemaining(m) <= CLEAR_PORTFOLIO_REMAINING &&
                m.score <= CLEAR_PORTFOLIO_SCORE &&
                eng.getRootLower(m.k) === 0).slice(0, CLEAR_PORTFOLIO_ROOTS);
            for (const candidate of candidates) {
                if (isStale()) return;
                eng.beamBeginRootPermanent(candidate.k, CLEAR_PORTFOLIO_WIDTH);
                for (;;) {
                    if (isStale()) return;
                    if (eng.beamStep(CHUNK) === 1) break;
                    postIfDue();
                    await nextTick();
                }
                moves = post(false);
                if (ownedComplete(moves)) break;
            }
            if (await finishLaneIfComplete(moves)) return;
        }
    }

    // Give larger children the search decomposition they would receive after
    // the user clicked into them. Compact children already qualify for the
    // persistent exact ladder, so they bypass this potentially much larger
    // heuristic portfolio. Pair ordinals divide the retained work evenly.
    if (moves.some((move) => !move.exact &&
        childRemaining(move) > EXACT_TRY_REMAINING)) {
        moves = await runVirtualChildPortfolio(moves, isStale, post, postIfDue);
        if (isStale()) return;
    }
    virtualChildAuditComplete = true;
    moves = post(false);
    if (await finishLaneIfComplete(moves)) return;

    // Full value enumeration is intentionally gated on compact children. On
    // larger boards, give the 16 most promising roots that can still beat the
    // incumbent one fair, bounded B&B turn instead. Easy constructive winners
    // can certify the position without being starved behind a hard positive
    // root; a budget miss is discarded as a proof but any terminal witness survives.
    if (eng.getRemaining() > EXACT_TRY_REMAINING) {
        moves = await runPositionProofPortfolio(moves, isStale, post, postIfDue);
        if (isStale()) return;
        if (await finishLaneIfComplete(moves)) return;
    }

    // 8. continuous investigation — runs until the position changes, every
    // move is PROVEN optimal, or nothing new has been found despite climbing
    // the whole width ladder (settled stop); scores only improve over time
    let progress = createSearchProgress(
        moves.map((m) => `${m.cell}:${m.score}:${m.exact ? 1 : 0}`).join("|"),
        moves[0].score);
    let globalSeed = laneSeed(1, LANE, 1);
    const lockedAttempts = new Map(); // cell -> private passes already run
    const lockedMaxWidths = new Map(); // cell -> widest private pass already run
    for (let s = 1; ; s++) {
        if (isStale()) return;

        // Peer lanes stream replay-validated proofs in through "merge" while
        // this lane may be deep inside an exact grind whose cycles never
        // reach a post. Re-read the WASM tables every cycle so an externally
        // proven root cancels its redundant local solve within one quantum
        // and a fully proven table stops this lane instead of letting it run
        // hot behind an all-checkmarked display.
        moves = collectResults().moves;

        if (moves.length > 0 && await finishLaneIfComplete(moves)) return;

        // exact-proof ladder: a bounded quantum per cycle, objective first
        if (await ladder.advance(moves)) {
            moves = post(false);
            progress.lastSignature = moves
                .map((m) => `${m.cell}:${m.score}:${m.exact ? 1 : 0}`).join("|");
            progress.maxGlobalFruitless = 0;
            if (moves[0].score < progress.bestScore) {
                progress.bestScore = moves[0].score;
                progress.bestFruitless = 0;
            }
            continue; // re-rank before spending beam time
        }
        if (isStale()) return;

        // Once exact enumeration is active, complete it without interleaving
        // ever-wider heuristic passes. Value solving is context-free: another
        // beam cannot shrink its state space unless it happens to meet the
        // root lower bound, while a width-16384 pass can delay the retained
        // DFS frontier by seconds. The initial playout/beam schedule above has
        // already supplied constructive incumbents; exact chunks still yield
        // between slices, so position changes remain promptly preemptible.
        if (ladder.shouldPrioritize(moves)) {
            postIfDue();
            continue;
        }

        // Width answers one question: has the best attainable position score
        // improved? Tail-row changes must not hold the top search at width 512.
        const tier = Math.min(WIDTH_TIERS.length - 1, Math.floor(progress.bestFruitless / 4));

        // Proof parity priority: pending pre-play proof work (near-gate value
        // attempts, escalating pair seeks) runs back-to-back — as the played
        // child's own schedule would — once wider beams stop being the
        // purposeful spend: either the position value is already certified so
        // beams cannot change the objective, or the width ladder is exhausted
        // and the private max-width audit has no uncovered root.
        const proofOnly = summarizePositionProof(moves,
            (move) => move.lower).positionExact ||
            (tier === WIDTH_TIERS.length - 1 &&
                uncoveredPrivateCandidates(moves, lockedMaxWidths).length === 0);
        if (proofOnly && ladder.pendingProofCount(moves) > 0) {
            postIfDue();
            continue;
        }

        // odd passes lock the whole beam onto one candidate: bigger-group
        // hopefuls first (can a larger group match the best score?), then the
        // unproven displayed moves; even passes search globally, and the noise
        // seed makes every pass explore a different corridor
        let lockedMove = null;
        if (s % 2 === 1) {
            const preferred = lockCandidates(ownedMoves(moves));
            if (tier === WIDTH_TIERS.length - 1) {
                // Before settlement, audit every root that can still beat the
                // incumbent with its own max-width heap. Preserve the normal
                // heuristic order where possible, then cover the tail.
                const uncovered = uncoveredPrivateCandidates(moves, lockedMaxWidths);
                const uncoveredCells = new Set(uncovered.map((m) => m.cell));
                lockedMove = preferred.find((m) => uncoveredCells.has(m.cell)) ??
                    uncovered[0] ??
                    (preferred.length > 0 ? preferred[(s >> 1) % preferred.length] : null);
            } else if (preferred.length > 0) {
                lockedMove = preferred[(s >> 1) % preferred.length];
            }
        }
        let globalWidth = 0;
        const playoutSeed = seedBase;
        if (lockedMove !== null) {
            const move = lockedMove;
            const attempt = lockedAttempts.get(move.cell) ?? 0;
            const privateTier = Math.min(LOCKED_WIDTHS.length - 1, attempt);
            const width = Math.max(LOCKED_WIDTHS[privateTier], WIDTH_TIERS[tier]);
            eng.beamBeginRoot(move.k, width, attempt); // per-root seeds cover every corridor
            lockedAttempts.set(move.cell, attempt + 1);
            lockedMaxWidths.set(move.cell, Math.max(lockedMaxWidths.get(move.cell) ?? 0, width));
        } else {
            globalWidth = WIDTH_TIERS[tier];
            eng.beamBeginPartition(globalWidth, globalSeed++, LANE, LANES);
        }
        for (;;) {
            if (isStale()) return;
            if (eng.beamStep(CHUNK) === 1) break;
            postIfDue();
            await nextTick();
        }
        moves = post(false);

        // playout refinement, biased to the moves the player actually sees
        if (s % 2 === 0) {
            if (gpuPumpEnabled && gpuState === "on") {
                await cpuSoftPlayoutRound(moves, playoutSeed, isStale);
                if (isStale()) return;
                seedBase = (seedBase + 64) >>> 0;
            } else {
                seedBase = await cpuPlayoutRound(moves, seedBase, isStale);
            }
            if (isStale()) return;
            moves = post(false);
            if (await finishLaneIfComplete(moves)) return;
        }

        // Separate objective progress from whole-list activity. The former
        // widens search; the latter decides whether there is truly nothing
        // left to investigate.
        const sig = moves.map((m) => `${m.cell}:${m.score}:${m.exact ? 1 : 0}`).join("|");
        progress = recordSearchPass(progress, sig, moves[0].score, globalWidth,
            WIDTH_TIERS[WIDTH_TIERS.length - 1]);

        // settled stop: nothing new despite max-width diversified passes, and
        // the board is too large to enumerate — below the proving gate the
        // engine never stops early, proofs always land eventually
        const uncoveredPrivate = uncoveredPrivateCandidates(moves, lockedMaxWidths).length;
        const uncoveredExact = moves.filter((move) => owns(move) && !move.exact &&
            childRemaining(move) <= EXACT_TRY_REMAINING).length;
        const uncoveredProof = ladder.pendingProofCount(moves);
        if (settlementReady(progress, SETTLE_PASSES, eng.getRemaining(),
            EXACT_REMAINING, uncoveredPrivate + uncoveredExact + uncoveredProof)) {
            stopGpuPump();
            post(true);
            return;
        }
    }
}

// Reproduce the clicked child's bounded beam allocation without abandoning the
// parent position. All lanes intentionally build the same stable parent-major
// pair list. Ordinal ownership makes pair work exhaustive, disjoint and
// count-balanced even when representative cells cluster modulo the lane count.
async function runVirtualChildPortfolio(moves, isStale, post, postIfDue) {
    const parents = moves.filter((move) => childRemaining(move) > EXACT_TRY_REMAINING)
        .sort((a, b) => a.k - b.k);
    const byParent = [];
    const allPairs = [];
    for (const parent of parents) {
        const count = eng.childGroupsToIO(parent.k);
        const reps = mem().slice(IO + 256, IO + 256 + count);
        const sizes = mem().slice(IO + 512, IO + 512 + count);
        const entries = Array.from(reps, (second, index) => ({
            second,
            size: sizes[index],
        }))
            .sort((a, b) => b.size - a.size || a.second - b.second);
        const seconds = entries.map((entry) => {
            const task = {
                cell: parent.cell,
                second: entry.second,
                ordinal: allPairs.length,
            };
            allPairs.push(task);
            return task;
        });
        byParent.push({ cell: parent.cell, seconds });
    }

    // Proof tiers rotate parents so a wide child cannot delay every other
    // parent's first serious turn. Beam passes retain the stable parent-major
    // order; both orders cover the same finite pair set.
    const tasks = roundRobinPrefixTasks(byParent)
        .map((entry) => entry.second)
        .filter((task) => task.ordinal % LANES === LANE);
    const parentTasks = allPairs.filter((task) => task.ordinal % LANES === LANE);

    // The clicked child gives every second move an independent bounded proof
    // turn. Reproduce that allocation first, in fair geometric budget tiers,
    // targeting the parent's sound lower bound. A target witness is enough to
    // prove the parent; a miss proves nothing and cannot poison later work.
    for (let tier = 0; tier < VIRTUAL_CHILD_PROOF_BUDGETS.length; tier++) {
        const budget = VIRTUAL_CHILD_PROOF_BUDGETS[tier];
        // Rotate parents at both budgets. A strong retry is where a later
        // parent most needs protection from every child of an earlier one.
        const tierTasks = tasks;
        for (const task of tierTasks) {
            if (isStale()) return moves;
            const current = moves.find((move) => move.cell === task.cell);
            if (!current || current.exact || current.lower >= current.score) continue;
            const target = current.lower;
            if (eng.exactBeginRootChildSeek(
                current.k, task.second, budget, target) !== 1) continue;

            let result = -1;
            while (result === -1) {
                if (isStale()) return moves;
                result = eng.exactStep(EXACT_CHUNK);
                postIfDue();
                await nextTick();
            }
            // Matching no-witness commits only cancel the live prefix; a real
            // target hit prepends both moves and may meet ROOT_LOWER exactly.
            eng.exactCommitRootChild(current.k, task.second);
            const currentMoves = collectResults().moves;
            const updated = currentMoves.find((move) => move.cell === task.cell);
            if (updated && (updated.exact || updated.score < current.score)) {
                moves = post(false);
            } else {
                moves = currentMoves;
                postIfDue();
            }
        }
        moves = post(false);
    }

    for (const [width, seed] of VIRTUAL_CHILD_PASSES) {
        for (const task of parentTasks) {
            if (isStale()) return moves;
            const current = moves.find((move) => move.cell === task.cell);
            if (!current || current.exact || current.lower >= current.score) continue;

            eng.beamBeginRootChild(current.k, task.second, width, seed);
            for (;;) {
                if (isStale()) return moves;
                if (eng.beamStep(CHUNK) === 1) break;
                postIfDue();
                await nextTick();
            }
            const currentMoves = collectResults().moves;
            const updated = currentMoves.find((move) => move.cell === task.cell);
            if (updated && (updated.exact || updated.score < current.score)) {
                moves = post(false);
            } else {
                moves = currentMoves;
                postIfDue();
            }
        }
        moves = post(false);
    }
    return moves;
}

// Above the full-enumeration gate, sequential unbounded proof work is a
// starvation trap: a single hard no-clear root can hide easy winning siblings
// indefinitely. Probe the most promising threatening roots once, in tight-
// bound order, yielding between exact chunks. The board-wide cap prevents a
// no-proof opening from delaying ordinary search; its max-width fairness audit
// still covers the remaining roots. Stop as soon as the position bounds meet.
async function runPositionProofPortfolio(moves, isStale, post, postIfDue) {
    const candidates = positionProofCandidates(moves, (move) => move.lower)
        .filter((move) => owns(move) && childRemaining(move) > EXACT_TRY_REMAINING)
        .slice(0, Math.max(1, Math.ceil(POSITION_PROBE_ROOTS / LANES)));
    for (const candidate of candidates) {
        if (isStale()) return moves;
        const current = moves.find((move) => move.cell === candidate.cell);
        if (!current || current.exact) continue;
        const before = summarizePositionProof(moves, (move) => move.lower);
        if (before.positionExact) break;
        if (current.lower >= before.positionUpper) continue;

        eng.exactBeginChild(current.k, POSITION_PROBE_BUDGET);
        let result = -1;
        while (result === -1) {
            if (isStale()) return moves;
            result = eng.exactStep(EXACT_CHUNK);
            postIfDue();
            await nextTick();
        }

        if (result >= 0) eng.exactMergeChild(current.k);
        else eng.exactCommitChild(current.k); // constructive only; never asserts exactness
        moves = post(false);

        const proof = summarizePositionProof(moves, (move) => move.lower);
        if (proof.positionExact || proof.allMovesExact) break;
    }
    return moves;
}

// moves worth extra attention because the player would rather click a bigger
// group: larger than the best-scoring move's group, score not yet matching
function biggerHopefuls(moves) {
    if (moves.length === 0) return [];
    const best = moves[0].score;
    const bestSize = Math.max(...moves.filter((m) => m.score === best).map((m) => m.size));
    return moves
        .filter((m) => !m.exact && m.score > best && m.size > bestSize)
        .sort((a, b) => b.size - a.size || a.score - b.score)
        .slice(0, 8);
}

// Fast-path root-locked targets: bigger-group hopefuls first, then unproven
// top-five moves and the first positive-score alternative. The latter matches
// the optional UI mode and prevents its sixth displayed row from waiting for
// the late max-tier audit. A separate max-tier audit guarantees tail fairness.
function lockCandidates(moves) {
    const hopefuls = biggerHopefuls(moves);
    const seen = new Set(hopefuls.map((m) => m.cell));
    const top = moves.slice(0, TOP_RANKS).filter((m) => !m.exact && !seen.has(m.cell));
    for (const move of top) seen.add(move.cell);
    const firstPositive = moves.find((m) => m.score > 0 && !m.exact && !seen.has(m.cell));
    return [...hopefuls, ...top, ...(firstPositive ? [firstPositive] : [])];
}

function uncoveredPrivateCandidates(moves, maxWidths) {
    if (moves.length === 0) return [];
    const incumbent = moves[0].score;
    const maxWidth = LOCKED_WIDTHS[LOCKED_WIDTHS.length - 1];
    return moves.filter((m) => {
        if (!owns(m)) return false;
        const lower = eng.getRootLower(m.k);
        const canImprove = lower < incumbent;
        const canAlsoClear = incumbent === 0 && m.score > 0 && lower === 0;
        return !m.exact && (canImprove || canAlsoClear) &&
            (maxWidths.get(m.cell) ?? 0) < maxWidth;
    });
}

// warm start: replay every remembered line that could apply to this position —
// lines cached for this exact board (with their proof flags), plus the
// suffixes of the previous position's lines (after the played move, the rest
// of such a line is a line of THIS position). seedLine() replay-validates
// every candidate inside WASM, so wrong guesses are rejected, never trusted.
// This is what lets a played "0 ★" suggestion keep its clearing line instantly.
function seedFromMemory(key) {
    const seeds = [];

    const cached = resultCache.get(key);
    if (cached) {
        for (const m of cached) {
            if (m.line.length > 0) seeds.push({ line: m.line, exact: m.exact, score: m.score });
        }
    }

    if (prevAnalysis && prevAnalysis.key !== key) {
        for (const m of prevAnalysis.moves) {
            if (m.line.length > 1) {
                seeds.push({
                    line: m.line.slice(1),
                    exact: canTransferExactSuffix(prevAnalysis, m, key),
                    score: m.score,
                });
            }
        }
    }

    // Rewind/general transposition reuse: this position may be the parent of
    // a cached board. Materialize every one-ply child, and when its board key
    // is known, prepend the creating root move to each cached continuation.
    // seedLine replay-validates the composition. This makes moving backward
    // retain a clearing line instead of only supporting forward suffixes.
    const roots = collectResults().moves;
    for (const root of roots) {
        if (eng.childToIO(root.k) !== 1) continue;
        const childKey = mem().slice(IO, IO + SIZE * SIZE).join(",");
        const childMoves = resultCache.get(childKey);
        if (!childMoves || childMoves.length === 0) continue;
        const childPositionExact = summarizePositionProof(
            childMoves, (move) => move.lower).positionExact;
        for (let rank = 0; rank < childMoves.length; rank++) {
            const child = childMoves[rank];
            if (child.line.length === 0) continue;
            seeds.push({
                line: [root.cell, ...child.line],
                exact: childPositionExact && rank === 0,
                score: child.score,
            });
        }
    }

    for (const seed of seeds) {
        if (seed.line.length > 80) continue;
        mem().set(Uint8Array.from(seed.line), IO);
        const final = eng.seedLine(seed.line.length);
        if (seed.exact && final === seed.score) {
            eng.seedExactByCell(seed.line[0], seed.score);
        }
    }
}

// CPU playout round with rank bias: the displayed top moves and bigger-group
// hopefuls get most samples
async function cpuPlayoutRound(moves, seedBase, isStale) {
    const priority = new Set(biggerHopefuls(moves).map((m) => m.cell));
    for (let rank = 0; rank < moves.length; rank++) {
        if (isStale()) return seedBase;
        if (moves[rank].exact || !owns(moves[rank])) continue;
        const n = rank < 8 || priority.has(moves[rank].cell) ? 48 : 8;
        eng.playoutRoot(moves[rank].k, n, seedBase);
        eng.playoutRootSoft(moves[rank].k, Math.max(1, Math.floor(n / SOFT_PLAYOUT_DIVISOR)), seedBase);
        seedBase += n;
        if (rank % 6 === 5) await nextTick();
    }
    return seedBase;
}

// GPU batches retain the strong hard-tabu policy. A small CPU supplement
// gives the combined portfolio full action support without displacing any of
// the exploitation samples or changing their seed sequence.
async function cpuSoftPlayoutRound(moves, seedBase, isStale) {
    const priority = new Set(biggerHopefuls(moves).map((m) => m.cell));
    for (let rank = 0; rank < moves.length; rank++) {
        if (isStale()) return;
        if (moves[rank].exact || !owns(moves[rank])) continue;
        const n = rank < 8 || priority.has(moves[rank].cell) ? 8 : 2;
        eng.playoutRootSoft(moves[rank].k, n, seedBase);
        if (rank % 6 === 5) await nextTick();
    }
}

async function gpuBeamAssist(moves, seedBase, isStale) {
    if (!gpu || gpuState !== "on" || typeof gpu.evaluateBoards !== "function") return seedBase;

    const candidates = [];
    for (const root of moves) {
        if (root.exact || candidates.length >= GPU_BEAM_ASSIST_MAX_BOARDS) continue;
        const count = eng.childGroupsToIO(root.k);
        const seconds = Array.from(mem().slice(IO + 256, IO + 256 + count));
        for (const second of seconds) {
            if (candidates.length >= GPU_BEAM_ASSIST_MAX_BOARDS) break;
            if (eng.grandchildToIO(root.k, second) !== 1) continue;
            candidates.push({
                root,
                second,
                board: mem().slice(IO, IO + SIZE * SIZE),
            });
        }
    }
    if (candidates.length === 0) return seedBase;

    const features = await gpu.evaluateBoards(candidates.map((candidate) => candidate.board));
    if (isStale()) return seedBase;

    // A compact, deliberately non-proof score: progress first, then boards
    // with more immediate connectivity and fewer surviving colors. Keep a
    // small portfolio per root so one superficially attractive root cannot
    // consume the whole assist.
    const byRoot = new Map();
    for (let i = 0; i < candidates.length; i++) {
        const feature = features[i];
        const candidate = candidates[i];
        candidate.rank = feature.remaining + feature.colorCount * 0.75 -
            feature.adjacentPairs * 0.2 - feature.dominantCount * 0.05;
        const list = byRoot.get(candidate.root.cell) ?? [];
        list.push(candidate);
        byRoot.set(candidate.root.cell, list);
    }

    for (const list of byRoot.values()) {
        list.sort((a, b) => a.rank - b.rank || a.second - b.second);
        for (const candidate of list.slice(0, GPU_BEAM_ASSIST_PER_ROOT)) {
            if (isStale()) return seedBase;
            mem().set(candidate.board, IO);
            const final = eng.testPlayout(seedBase++);
            const tailLength = mem()[IO + 256];
            const line = [candidate.root.cell, candidate.second,
                ...mem().slice(IO + 257, IO + 257 + tailLength)];
            if (line.length > 80) continue;
            mem().set(Uint8Array.from(line), IO);
            // Full replay from the original position is the trust boundary.
            // The feature kernel can only choose what to try, never what to
            // believe or prove.
            if (eng.seedLine(line.length) !== final) continue;
        }
    }
    return seedBase;
}

// Exact-proof ladder: compact endgames try incumbent-driven branch and bound
// first; larger proving-gate positions start the persistent value memo
// directly. The memo is shared across roots, retries and later analysis
// positions. Improving terminals are retained as durable lines inside WASM;
// a memo-guided witness DFS repairs any remaining policy-cache gap.
function createExactLadder(isStale, postIfDue) {
    const exhausted = new Map(); // cell -> last value-solve budget tried
    const lineExhausted = new Map(); // cell -> last guided witness budget tried
    const boundTried = new Set();
    const maxChildGroups = new Map(); // cell -> largest group inside the child
    const pairAudits = new Map(); // cell -> { round, index, seconds } seek cursor
    let active = null; // { k, cell, mode: "bound" | "value" | "line" | "pairSeek", budget, target }

    // The board is fixed for the whole analysis, so the child's largest group
    // (which decides whether one more removal crosses the exact gate) is
    // computed once per root. childGroupsToIO only writes the IO scratch and
    // runs at the same task boundaries as collectResults.
    const maxChildGroupOf = (move) => {
        let largest = maxChildGroups.get(move.cell);
        if (largest === undefined) {
            const count = eng.childGroupsToIO(move.k);
            largest = count > 0 ?
                Math.max(...mem().slice(IO + 512, IO + 512 + count)) : 0;
            maxChildGroups.set(move.cell, largest);
        }
        return largest;
    };

    return {
        // Threatening roots inside the one-move band above the exact gate:
        // once played, their child would enter this ladder immediately. They
        // get the same escalating value attempts pre-play, and they block
        // settlement until proved or probed to the parity cap.
        parityCandidates(moves) {
            return parityProofCandidates(moves, {
                childRemainingOf: childRemaining,
                maxChildGroupOf,
                exhaustedOf: (move) => exhausted.get(move.cell) ?? 0,
                gate: EXACT_TRY_REMAINING,
                cap: EXACT_PARITY_BUDGET,
            }).filter(owns);
        },

        // Escalating pair-seek audit: every lane audits its stable slice of
        // each threatening root's second moves — the same lane partition the
        // played child would apply to those moves as its own roots.
        pairCandidates(moves) {
            return pairAuditCandidates(moves, {
                childRemainingOf: childRemaining,
                exhaustedOf: (move) =>
                    (pairAudits.get(move.cell)?.round ?? 0) >= PAIR_AUDIT_ROUNDS.length,
                gate: EXACT_TRY_REMAINING,
                boardRemaining: eng.getRemaining(),
                maxRemaining: PAIR_AUDIT_REMAINING,
            });
        },

        // Unproven in-band roots owned by satellite lanes. Their compact
        // value memos can thrash indefinitely on children this lane's full
        // table proves in seconds, so once lane zero's own roots are exact
        // it adopts them; the pool merges any lane's proof soundly.
        caretakerCandidates(moves) {
            return caretakerProofCandidates(moves, {
                lane: LANE,
                owns,
                childRemainingOf: childRemaining,
                gate: EXACT_TRY_REMAINING,
            });
        },

        // Pre-play proof work still owed before this lane may settle.
        pendingProofCount(moves) {
            return this.parityCandidates(moves).length + this.pairCandidates(moves).length +
                this.caretakerCandidates(moves).length;
        },

        // Begins the next (first, second, third) audit turn, advancing the
        // per-root cursor across the round schedule. The lane owns every
        // LANES-th triple in the same stable big-groups-first order the
        // clicked child would give its own (second, third) pairs, and rounds
        // rotate across roots so one wide root cannot hold every other root
        // at tier zero. Returns the active descriptor or null when every
        // triple has had its full schedule.
        nextPairSeek(moves) {
            const queue = this.pairCandidates(moves)
                .sort((a, b) => (pairAudits.get(a.cell)?.round ?? 0) -
                    (pairAudits.get(b.cell)?.round ?? 0));
            for (const move of queue) {
                let audit = pairAudits.get(move.cell);
                if (!audit) {
                    const count = eng.childGroupsToIO(move.k);
                    const reps = mem().slice(IO + 256, IO + 256 + count);
                    const sizes = mem().slice(IO + 512, IO + 512 + count);
                    const seconds = Array.from(reps, (second, index) => ({
                        second,
                        size: sizes[index],
                    })).sort((a, b) => b.size - a.size || a.second - b.second);
                    const triples = [];
                    let ordinal = 0;
                    for (const { second } of seconds) {
                        const thirdCount = eng.grandchildGroupsToIO(move.k, second);
                        const thirdReps = mem().slice(IO + 256, IO + 256 + thirdCount);
                        const thirdSizes = mem().slice(IO + 512, IO + 512 + thirdCount);
                        const thirds = Array.from(thirdReps, (third, index) => ({
                            third,
                            size: thirdSizes[index],
                        })).sort((a, b) => b.size - a.size || a.third - b.third);
                        for (const { third } of thirds) {
                            if (ordinal++ % LANES === LANE) triples.push({ second, third });
                        }
                    }
                    audit = { round: 0, index: 0, triples };
                    pairAudits.set(move.cell, audit);
                }
                while (audit.round < PAIR_AUDIT_ROUNDS.length) {
                    if (audit.index >= audit.triples.length) {
                        audit.round++;
                        audit.index = 0;
                        break; // fair tiering: other roots reach this round first
                    }
                    const { second, third } = audit.triples[audit.index++];
                    const round = PAIR_AUDIT_ROUNDS[audit.round];
                    if (round.seek !== undefined) {
                        const target = eng.getRootLower(move.k);
                        if (eng.exactBeginRootChildSeek3(
                            move.k, second, third, round.seek, target) === 1) {
                            return { k: move.k, cell: move.cell, mode: "pairSeek",
                                target, second, third, remaining: childRemaining(move) };
                        }
                    } else {
                        eng.beamBeginRootGrandchild(
                            move.k, second, third, round.width, round.seed);
                        return { k: move.k, cell: move.cell, mode: "pairBeam",
                            second, third, remaining: childRemaining(move) };
                    }
                }
            }
            return null;
        },

        shouldPrioritize(moves) {
            // Adopted satellite roots are in-band by construction, so they
            // extend the back-to-back case without changing the mixed-board
            // rule for this lane's own above-gate children.
            const unresolved = moves.filter((move) => owns(move) && !move.exact)
                .concat(this.caretakerCandidates(moves));
            // When every owned child is under the exact gate, finish the
            // retained value frontier back-to-back. On mixed boards, give the
            // eligible children one bounded quantum per cycle without letting
            // one threshold-crossing root starve heuristic work for the rest.
            return unresolved.length > 0 &&
                unresolved.every((move) => childRemaining(move) <= EXACT_TRY_REMAINING);
        },

        // runs a bounded slice; true if a proof finished (rankings may change)
        async advance(moves) {
            if (moves.length === 0) return false;

            // A beam/playout may have reached the root lower bound while a
            // proof was sliced across cycles. Do not keep solving a row that
            // has become exact in the meantime.
            if (active && moves.find((m) => m.cell === active.cell)?.exact) active = null;

            if (!active) {
                // Least-invested budget first, then the broadest child
                // (smallest removed root group): fresh roots all get their
                // first bounded attempt — in the memo-warming broad order —
                // before any hard sibling escalates a tier. One un-enumerable
                // child can otherwise monopolize the lane for minutes while
                // a root behind it is provable within its very first budget.
                const investedOf = (move) => exhausted.get(move.cell) ?? 0;
                const next = exactCandidateOrder(
                    moves.filter((m) => owns(m) && !m.exact &&
                        childRemaining(m) <= EXACT_TRY_REMAINING), investedOf)[0] ??
                    // Adopt stuck satellite-owned in-band roots before the
                    // speculative near-gate parity attempts: they are proofs
                    // the position certainly owes, on the full value memo.
                    exactCandidateOrder(this.caretakerCandidates(moves), investedOf)[0] ??
                    // Proof parity: with no compact child left, spend the
                    // capped escalating attempts on near-gate threats.
                    this.parityCandidates(moves)[0];
                if (next) {
                    const remaining = childRemaining(next);

                    if (remaining <= BOUND_TRY_REMAINING && !boundTried.has(next.cell)) {
                        boundTried.add(next.cell);
                        active = { k: next.k, cell: next.cell, mode: "bound",
                            budget: BOUND_BUDGET, target: -1, remaining };
                        eng.exactBeginChild(next.k, BOUND_BUDGET);
                    } else {
                        const started = this.startValue(next);
                        if (started !== null) return started;
                    }
                } else {
                    // Constructive parity: give the remaining threatening
                    // roots the clicked child's own (second, third) schedule.
                    active = this.nextPairSeek(moves);
                    if (!active) return false; // no proof work owed anywhere
                }
            }

            // A prefix beam runs like every other beam pass: to completion,
            // yielding between chunks. It cannot share cycle quanta because
            // the continuous loop's own passes would reset the beam state.
            if (active.mode === "pairBeam") {
                for (;;) {
                    if (isStale()) return false;
                    if (eng.beamStep(CHUNK) === 1) break;
                    postIfDue();
                    await nextTick();
                }
                const before = moves.find((m) => m.cell === active.cell);
                const updated = collectResults().moves
                    .find((m) => m.cell === active.cell);
                active = null;
                return updated !== undefined && (updated.exact ||
                    (before !== undefined && updated.score < before.score));
            }

            // Match the clicked child size, not the untouched parent size.
            const slices = active.remaining <= EXACT_REMAINING ? 8 : 4;

            // a bounded number of chunks per cycle, then back to the beams
            for (let c = 0; c < slices; c++) {
                if (isStale()) return false;
                const mode = active.mode;
                const r = mode === "value" ? eng.vsStep(EXACT_CHUNK) : eng.exactStep(EXACT_CHUNK);
                if (r === -1) {
                    await nextTick();
                    continue;
                }

                if (mode === "bound") {
                    if (r >= 0) {
                        eng.exactMergeChild(active.k);
                        active = null;
                        return true;
                    }
                    const next = moves.find((m) => m.cell === active.cell);
                    const improved = next ? eng.exactCommitChild(active.k) < next.score : false;
                    active = null;
                    if (improved) return true; // re-collect: it may have met the lower bound
                    if (!next || next.exact) return false;
                    const started = this.startValue(next);
                    if (started !== null) return started;
                    continue;
                }

                if (mode === "value") {
                    if (r === -2) { // budget out — memo kept, retry escalates
                        exhausted.set(active.cell, active.budget);
                        active = null;
                        return false;
                    }
                    return this.finishValue(r);
                }

                if (mode === "pairSeek") {
                    // A (first, second, third) target seek finished. A hit
                    // commits a replayable line and may meet ROOT_LOWER
                    // exactly; exhaustion or a completed non-winning branch
                    // commits nothing and the cursor simply moves on.
                    const committed = eng.exactCommitRootChild3(
                        active.k, active.second, active.third);
                    const hit = committed === active.target;
                    active = null;
                    return hit;
                }

                // line seek finished: exactly `target` means the line is in
                if (r === active.target) {
                    eng.exactMergeChild(active.k);
                    active = null;
                    return true;
                }
                lineExhausted.set(active.cell, active.budget); // retry with a wider guided seek
                active = null;
                return false;
            }
            return false; // still running — resume next cycle
        },

        // Starts or resumes a value enumeration. The per-attempt budget stays
        // within the WASM i32 API; retained DFS/VTT state makes total work
        // across retries unbounded without integer wraparound.
        startValue(move) {
            const previous = exhausted.get(move.cell) ?? EXACT_BUDGET / 4;
            const budget = Math.min(EXACT_BUDGET_MAX, previous * 4);
            active = { k: move.k, cell: move.cell, mode: "value", budget, target: -1,
                remaining: childRemaining(move) };
            const immediate = eng.vsBegin(move.k, budget);
            if (immediate === -3) { active = null; return false; }
            if (immediate >= 0) return this.finishValue(immediate);
            return null;
        },

        // a proven value arrived: flag it directly when the known line already
        // achieves it, otherwise seek the improving line
        finishValue(value) {
            if (eng.seedExactByCell(active.cell, value) === 1) {
                active = null;
                return true;
            }
            if (eng.vsBuildLine(active.k, value) === 1) {
                active = null;
                return true;
            }
            const previous = lineExhausted.get(active.cell) ?? LINE_BUDGET / 4;
            const budget = Math.min(EXACT_BUDGET_MAX, previous * 4);
            eng.exactChildSeek(active.k, budget, value);
            active.mode = "line";
            active.target = value;
            active.budget = budget;
            return false;
        },
    };
}

function disableGpu() {
    try { gpu?.destroy(); } catch { /* device may already be lost */ }
    gpuState = "failed";
    gpu = null;
}

// one GPU playout round over all root children; falls back permanently on the
// first verification mismatch (results are only merged after a CPU replay)
async function gpuRound(moves, playouts, seedBase, isStale) {
    if (!gpu || moves.length === 0) return;

    const boards = [];
    const tabu = [];
    const roots = moves.filter((m) => !m.exact).map((m) => m.k);
    if (roots.length === 0) return;
    for (const k of roots) {
        eng.childToIO(k);
        const child = mem().slice(IO, IO + 144);
        boards.push(child);
        tabu.push(dominantColor(child));
    }

    let results;
    try {
        results = await gpu.runBatch(boards, tabu, playouts, seedBase);
    } catch (error) {
        disableGpu();
        return;
    }
    if (isStale()) return;

    for (let i = 0; i < roots.length; i++) {
        const k = roots[i];
        const { final, seedIdx } = results[i];
        if (final >= 145) continue; // no playout wrote a result
        if (eng.playoutVerify(k, seedBase + seedIdx, final) === 0) {
            // GPU and CPU disagree on a deterministic playout — GPU results
            // cannot be trusted on this device, disable them for good
            disableGpu();
            return;
        }
    }
}

// --- GPU bring-up: run once, cross-check against the CPU twin -----------------

async function initGpu() {
    try {
        gpu = await createGpu();
    } catch (error) {
        disableGpu();
        return;
    }
    if (!gpu) return;

    // self-test: fixed board, fixed seeds — the GPU minimum must replay exactly
    // on the CPU twin; any mismatch disables the GPU path
    const board = new Uint8Array(144);
    let s = 123456789;
    for (let c = 0; c < 144; c++) {
        s = (s * 1103515245 + 12345) & 0x7FFFFFFF;
        board[c] = 1 + (s % 5);
    }

    try {
        const [result] = await gpu.runBatch([board], [dominantColor(board)], 64, 5000);
        mem().set(board, IO);
        const cpuFinal = eng.testPlayout(5000 + result.seedIdx);
        if (cpuFinal !== result.final) throw new Error(`self-test mismatch cpu ${cpuFinal} gpu ${result.final}`);
        gpuState = "on";
    } catch (error) {
        disableGpu();
    }
}

// --- main loop -----------------------------------------------------------------

async function main() {
    const stem = LANE === 0 ? "engine" : "engine-lane";
    let loadError = null;
    for (const name of [`${stem}.wasm`, `${stem}-scalar.wasm`]) {
        try {
            const wasmURL = new URL(`./${name}`, import.meta.url);
            wasmURL.searchParams.set("build", "20260714-pairband1");
            const response = await fetch(wasmURL);
            if (!response.ok) throw new Error(`${name} HTTP ${response.status} ${response.statusText}`);
            const bytes = await response.arrayBuffer();
            const { instance } = await WebAssembly.instantiate(bytes, {
                env: { abort: () => { throw new Error("wasm abort"); } },
            });
            eng = instance.exports;
            break;
        } catch (error) {
            loadError = error;
        }
    }
    if (!eng) throw loadError ?? new Error("no compatible analysis engine binary");
    IO = eng.ioPtr();

    if (GPU_ALLOWED) await initGpu();
    self.postMessage({ type: "ready", gpu: gpuState });

    let doneVersion = 0;
    for (;;) {
        if (!job || doneVersion === jobVersion) {
            await new Promise((resolve) => { kickWaiter = resolve; });
            continue;
        }
        const analysisVersion = jobVersion;
        const analysisJob = job;
        doneVersion = analysisVersion;
        await analyze(analysisJob, () => jobVersion !== analysisVersion);
    }
}

main().catch((error) => {
    self.postMessage({ type: "error", message: String(error?.stack ?? error) });
});
