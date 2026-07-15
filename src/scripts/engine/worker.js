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
 *      move is proved
 *
 * Analysis ends in exactly four ways: a new position arrives, EVERY move is
 * proven optimal ("proven"), SETTLE_PASSES unchanged *global* max-width
 * passes plus a private max-width audit find nothing on a board too large to
 * enumerate ("settled"), or the pool sends "stop" because a user-configured
 * limit was reached (first zero-score line, analysis time, position count) —
 * never by an arbitrary internal timer. Stagnation first
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
 * Date: Sun Jul 12, 2026
 */

// These query revisions must match ENGINE_ASSET_VERSION in engine-ui.js.
// Versioning the complete module graph prevents a cached pre-change helper
// from making the worker fail during static module linking.
import { createGpu, dominantColor } from "./gpu.js?build=20260715-engine2";
import {
    analysisState, canTransferExactSuffix, caretakerProofCandidates, createSearchProgress,
    exactCandidateOrder, mirrorClickedPrefixTasks, positionProofCandidates, recordSearchPass,
    remainingAfterMove, roundRobinPrefixTasks, settlementReady, shouldGpuCaretake,
    summarizePositionProof,
} from "./schedule.js?build=20260715-engine2";
import { laneOwnsRoot, laneSeed } from "./pool.js?build=20260715-engine2";

const workerParams = new URL(self.location.href).searchParams;
const LANES = Math.max(1, Number.parseInt(workerParams.get("lanes") ?? "1", 10) || 1);
const LANE = Math.min(LANES - 1,
    Math.max(0, Number.parseInt(workerParams.get("lane") ?? "0", 10) || 0));
const GPU_ALLOWED = workerParams.get("gpu") !== "0";
// cpu=0 (settings "Use CPU" off): the WASM core still provides the instant
// baselines and replay validation, but sustained search is GPU-only
const CPU_ALLOWED = workerParams.get("cpu") !== "0";

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
const COORDINATED_PREFIX_BUDGET = 250000; // one resumable proof quantum
const COORDINATED_PREFIX_BUDGET_MAX = 8000000;
const COORDINATED_MAX_SPLIT_PREFIX = 3; // deeper tasks rotate over a board-deduplicated frontier
const LINE_BUDGET = 64000000;   // initial memo-guided line seek; rare retries escalate ×4
const WIDEN_WIDTHS = [8, 32, 128, 512, 2048];
// A clicked child receives deterministic lane-partitioned beams, then private
// diversified retries. Mirror that bounded early allocation inside each
// unresolved parent row so its second moves do not compete in one giant heap.
const VIRTUAL_CHILD_PASSES = [
    [128, 0], [512, 0], [2048, 0], [2048, 1], [2048, 2],
];
const VIRTUAL_CHILD_PROOF_BUDGETS = [100000, 1000000];
const PREFIX_CONTEXT_PLAYOUTS = 32;
const PREFIX_CONTEXT_SOFT_PLAYOUTS = 4;
// The cheap nested tier audits every root. Expensive retries remain focused
// on rows already close to their sound bound, which is where a click can turn
// an apparently difficult tail into an immediate proof.
const NESTED_PREFIX_STRONG_GAP = 5;
// Receding-horizon repair is a bounded fair frontier, not the Cartesian
// product of a whole move tree. These first contexts include the reported
// third-ply cliffs while keeping the pre-continuous allocation finite.
const NESTED_PREFIX_CONTEXTS_PER_PARENT = 256;
const NESTED_PREFIX_PASSES = [[128, 0], [2048, 1]];
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
const pendingGpuBatches = new Set(); // logical batches in flight (pipelined)
// Two logical batches stay queued so the JS turnaround of a completed batch
// (verify, collect, repack) overlaps device execution of the next one instead
// of draining the GPU at every macrotask boundary.
const GPU_PIPELINE_BATCHES = 2;

let job = null;
let jobVersion = 0;
let kickWaiter = null;
const jobChangeWaiters = new Set();

// warm-start memory: boardKey -> last posted move list (lines, scores, proofs);
// insertion order doubles as LRU order
const resultCache = new Map();
let prevAnalysis = null; // { key, moves } of the most recently analyzed position
let caretakerStopJob = null;
let thresholdPlan = null; // pool-coordinated complete second-move coverage

// fast macrotask yield — setTimeout(0) clamps, a MessageChannel does not
const tickChannel = new MessageChannel();
const tickQueue = [];
tickChannel.port1.onmessage = () => tickQueue.shift()?.();
const nextTick = () => new Promise((resolve) => {
    tickQueue.push(resolve);
    tickChannel.port2.postMessage(0);
});

const mem = () => new Uint8Array(eng.memory.buffer);
// `k` is WASM's deterministic ascending-representative enumeration index. It
// remains attached to a row when collectResults() sorts rows for display, and
// unlike representative-cell modulo it balances root counts across the pool.
const owns = (move) => laneOwnsRoot(move.k, LANE, LANES);
const ownedMoves = (moves) => moves.filter(owns);
const ownedComplete = (moves) => ownedMoves(moves).every((move) => move.exact);
const childRemaining = (move) => remainingAfterMove(eng.getRemaining(), move);

self.onmessage = (event) => {
    const msg = event.data;
    if (msg.type === "analyze") {
        job = msg;
        caretakerStopJob = null;
        thresholdPlan = null;
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
    } else if (msg.type === "stop" && job && msg.id === job.id) {
        // A user-configured limit (first zero, time, position count) ended
        // this analysis. The pool has already emitted the terminal snapshot,
        // so drop the job like a position change: every stage aborts at its
        // next staleness check and the lane sleeps until the next analyze.
        job = null;
        caretakerStopJob = null;
        thresholdPlan = null;
        eng?.thresholdCancel();
        jobVersion++;
        for (const wake of jobChangeWaiters) wake();
        jobChangeWaiters.clear();
    } else if (msg.type === "stop-caretaker" && job && msg.id === job.id) {
        // Every CPU-only peer has reached a terminal snapshot. A lane-zero
        // GPU playout loop cannot turn their unresolved positive bounds into
        // proofs, so let the pool settle instead of reporting fictitious
        // perpetual work.
        caretakerStopJob = msg.id;
    } else if (msg.type === "threshold-plan" && job && msg.id === job.id) {
        thresholdPlan = {
            id: msg.id,
            epoch: msg.epoch,
            target: msg.target,
            roots: Array.isArray(msg.roots) ? msg.roots.slice() : [],
            round: -1,
            tasks: null,
        };
    } else if (msg.type === "threshold-frontier" && thresholdPlan &&
        msg.id === thresholdPlan.id && msg.epoch === thresholdPlan.epoch &&
        msg.target === thresholdPlan.target) {
        eng?.thresholdCancel();
        thresholdPlan = {
            ...thresholdPlan,
            round: msg.round,
            tasks: Array.isArray(msg.tasks) ? msg.tasks.map((task) => ({
                rootCell: task.rootCell,
                prefix: Array.isArray(task.prefix) ? task.prefix.slice() : [],
            })) : [],
        };
    } else if (msg.type === "threshold-cancel" && thresholdPlan &&
        msg.id === thresholdPlan.id && msg.epoch === thresholdPlan.epoch) {
        thresholdPlan = null;
        eng?.thresholdCancel();
    } else if (msg.type === "threshold-root-bound" && eng && job && msg.id === job.id) {
        // A pool certificate for root A is independent of a live threshold
        // search for root B. Cancelling here destroyed unrelated distributed
        // work whenever one row completed ahead of its peers.
        eng.seedRootLowerByCell(msg.rootCell, msg.lower);
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
    // Batches submitted by the replaced position still update lifetime
    // counters when they complete. Let this position start its CPU baseline
    // immediately, but hold its GPU counter baseline until those old bounded
    // dispatches drain. Until then posts report zero new GPU work.
    const inheritedGpu = pendingGpuBatches.size > 0 ?
        Promise.allSettled([...pendingGpuBatches]) : null;
    let gpuStart = inheritedGpu === null ? (gpu?.getStats?.() ?? {}) : null;
    const gpuBaselineReady = inheritedGpu === null ? Promise.resolve() :
        inheritedGpu.then(() => { // allSettled — disableGpu handles failures
            gpuStart = gpu?.getStats?.() ?? {};
        });

    mem().set(myJob.board, IO);
    eng.setBoard();
    // Capture the exact one-ply relation before any search mutates IO. It is
    // the proof boundary for carrying an exact parent result into the next
    // displayed position; replaying a legal suffix alone proves only an upper
    // bound on an unrelated board.
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
        // Coalesce to the shared cadence at the source. Several stages post
        // per completed pass/task; on a warm cache those complete in
        // microseconds and sixteen lanes posting per iteration can flood the
        // main thread with tens of thousands of messages per second — enough
        // to starve clicks and the next analyze indefinitely. A suppressed
        // snapshot is never lost: every stage posts again within the interval
        // and the terminal (settled) snapshot always goes through.
        if (settled !== true && performance.now() - lastPost < POST_INTERVAL_MS) {
            return moves;
        }
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

    // Keep up to GPU_PIPELINE_BATCHES logical batches (each internally striped
    // over the GPU resource slots) continuously queued.  Batch preparation and
    // replay verification execute only at ordinary JavaScript task boundaries,
    // never concurrently with a WASM call.  The GPU owns copies of its boards
    // after submission, so the CPU remains free to advance beam/exact chunks
    // in the meantime.
    const launchGpuBatch = () => {
        if (pendingGpuBatches.size >= GPU_PIPELINE_BATCHES || gpuState !== "on") return false;
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
                pendingGpuBatches.delete(pending);
                if (gpuPumpEnabled && !isStale() && gpuState === "on" &&
                    latestGpuMoves.some((move) => !move.exact)) {
                    // Use a macrotask rather than an unbounded microtask chain:
                    // position-change messages stay promptly preemptive even
                    // with a mock/driver that resolves a batch immediately.
                    void nextTick().then(() => fillGpuPipeline());
                }
            });
        pendingGpuBatches.add(pending);
        return true;
    };
    const fillGpuPipeline = () => {
        let launched = false;
        while (launchGpuBatch()) launched = true;
        return launched;
    };
    const startGpuPump = (fallback = gpuPumpFallback) => {
        gpuPumpFallback = fallback;
        gpuPumpEnabled = true;
        return fillGpuPipeline();
    };
    const stopGpuPump = () => { gpuPumpEnabled = false; };
    const drainGpu = async () => {
        if (pendingGpuBatches.size === 0) return;
        // resolve when ANY in-flight batch settles; failures are handled by
        // the batch's own catch, so the race result itself is irrelevant
        const pending = Promise.race([...pendingGpuBatches]).then(() => {}, () => {});
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

    // CPU root ownership is disjoint, but WebGPU can cheaply sample every
    // root.  Lane zero therefore remains as a GPU caretaker after its own CPU
    // roots finish, consuming replay-validated proof/line seeds broadcast by
    // the pool until the global table is exact.  This is the case that used to
    // leave the GPU idle after roughly one second in a multi-lane analysis.
    const coordinatedProofPending = (snapshot) => {
        const proof = summarizePositionProof(snapshot, (move) => move.lower);
        return proof.positionUpper > 0 && !proof.positionExact &&
            snapshot.some((move) => !move.exact &&
                move.lower < proof.positionUpper &&
                childRemaining(move) <= EXACT_TRY_REMAINING);
    };

    const finishLaneIfComplete = async (snapshot) => {
        if (!ownedComplete(snapshot)) return false;
        if (!virtualChildAuditComplete) return false;
        if (coordinatedProofPending(snapshot)) {
            // The pool may assign this otherwise-idle lane a fixed-prefix
            // certificate from another lane's root. Returning here would make
            // complete cross-lane coverage impossible.
            return false;
        }
        if (caretakerStopJob === myJob.id) {
            stopGpuPump();
            post(true);
            return true;
        }
        if (caretakerProofCandidates(snapshot, { lane: LANE, owns,
            childRemainingOf: childRemaining, gate: EXACT_TRY_REMAINING }).length > 0) {
            // Unproven in-band satellite roots: stay alive so the exact
            // ladder adopts them on this lane's full value memo — a lite
            // satellite can thrash for minutes on a child it proves in
            // seconds. The pool merges any lane's proof and re-seeds the
            // stuck owner.
            return false;
        }
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
            if (caretakerStopJob === myJob.id) {
                stopGpuPump();
                post(true);
                return true;
            }
            fillGpuPipeline();
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

    // GPU-only mode (settings "Use CPU" off): the greedy baselines and child
    // tables above are the whole CPU contribution — all sustained search is
    // the replay-validated GPU playout pump. When WebGPU is unavailable or
    // fails, fall through to the normal CPU schedule so analysis always runs.
    if (!CPU_ALLOWED && gpuState === "on") {
        await gpuBaselineReady;
        if (isStale()) return;
        latestGpuMoves = moves;
        startGpuPump(1024);
        for (;;) {
            if (isStale()) { stopGpuPump(); return; }
            fillGpuPipeline();
            await drainGpu();
            if (isStale()) { stopGpuPump(); return; }

            let current = collectResults().moves;
            latestGpuMoves = current;
            if (current.every((move) => move.exact) || gpuState !== "on") {
                stopGpuPump();
                post(true);
                return;
            }
            if (performance.now() - lastPost > POST_INTERVAL_MS) current = post(false);
            latestGpuMoves = current;
        }
    }

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

    // Compact children already qualify for the persistent exact ladder below.
    // Do not make them wait behind a potentially billion-node heuristic
    // emulation of the position reached after a click. Larger children still
    // receive the bounded virtual allocation before continuous search.
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
    const coordinatedLadder = createCoordinatedThresholdLadder(isStale, postIfDue);
    const ladder = createExactLadder(isStale);
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

        const coordinated = await coordinatedLadder.advance(moves);
        if (coordinated.active) {
            if (coordinated.changed || performance.now() - lastPost > POST_INTERVAL_MS) {
                moves = post(false);
            }
            continue;
        }

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

        // An owned-complete lane held open only because a coordinated proof
        // may still be assigned has no beam or playout of its own left: its
        // partition heap exhausts instantly and the pass loop degenerates
        // into a hot spin that burns a full core for minutes. Idle at the
        // post cadence instead — frontier tasks, peer proofs and position
        // changes all arrive by message, and every exit condition above is
        // re-checked each beat.
        if (ownedMoves(moves).every((move) => move.exact)) {
            await new Promise((resolve) => setTimeout(resolve, POST_INTERVAL_MS));
            postIfDue();
            continue;
        }

        // Width answers one question: has the best attainable position score
        // improved? Tail-row changes must not hold the top search at width 512.
        const tier = Math.min(WIDTH_TIERS.length - 1, Math.floor(progress.bestFruitless / 4));

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

        // A lane with no ordinal-owned roots can otherwise complete an empty
        // beam/playout cycle without a single task boundary. Yield once so a
        // newly issued cross-root frontier arrives before settlement logic.
        await nextTick();
        if (isStale()) return;

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
        if (!coordinatedProofPending(moves) &&
            settlementReady(progress, SETTLE_PASSES, eng.getRemaining(),
            EXACT_REMAINING, uncoveredPrivate + uncoveredExact)) {
            stopGpuPump();
            post(true);
            return;
        }
    }
}

// Reproduce the clicked child's bounded beam allocation without abandoning the
// parent position. All lanes intentionally build the same stable pair list;
// its ordinal assignment is exhaustive, disjoint and balanced even when the
// legal cell representatives cluster badly modulo the lane count.
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

    // Keep two finite orders: round-robin for the cheap discovery tier, so a
    // wide child cannot delay every other parent's first turn; parent-major
    // for stronger retries, so each virtual child receives the same bounded
    // serial allocation it would receive after its parent is clicked.
    const tasks = roundRobinPrefixTasks(byParent)
        .map((entry) => entry.second)
        .filter((task) => task.ordinal % LANES === LANE);
    const parentTasks = allPairs.filter((task) => task.ordinal % LANES === LANE);

    // A freshly clicked child first gives each of its roots a one-ply greedy
    // table and independent hard/soft playouts, with tabu recomputed after the
    // selected second move. Lift exactly those constructive phases before the
    // more expensive proof/beam portfolio. The arbitrary-prefix WASM entry
    // points keep the original first move in every recorded line.
    let contextTurns = 0;
    for (const task of tasks) {
        if (isStale()) return moves;
        const current = moves.find((move) => move.cell === task.cell);
        if (!current || current.exact || current.lower >= current.score) continue;

        mem().set(Uint8Array.of(task.second), IO);
        eng.probeRootPrefixTable(current.k, 1);
        const prefixSeed = laneSeed(1 + task.ordinal * PREFIX_CONTEXT_PLAYOUTS,
            LANE, 5);
        mem().set(Uint8Array.of(task.second), IO);
        eng.playoutRootPrefix(current.k, 1, PREFIX_CONTEXT_PLAYOUTS, prefixSeed);
        mem().set(Uint8Array.of(task.second), IO);
        eng.playoutRootPrefixSoft(
            current.k, 1, PREFIX_CONTEXT_SOFT_PLAYOUTS, prefixSeed);
        contextTurns++;
        if ((contextTurns & 7) === 0) {
            moves = collectResults().moves;
            postIfDue();
            await nextTick();
        }
    }
    moves = post(false);

    // The clicked child gives every second move an independent bounded proof
    // turn. Reproduce that allocation first, in fair geometric budget tiers,
    // targeting the parent's sound lower bound. A target witness is enough to
    // prove the parent; a miss proves nothing and cannot poison later work.
    for (let tier = 0; tier < VIRTUAL_CHILD_PROOF_BUDGETS.length; tier++) {
        const budget = VIRTUAL_CHILD_PROOF_BUDGETS[tier];
        // Rotate parents at every tier. A strong retry is precisely where a
        // later parent used to wait behind every second move of earlier
        // parents, even though the same row solved almost immediately after
        // it was clicked. Diagonal order gives every visible parent one
        // comparable post-click turn before any parent receives a second.
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

        // After the cheap 100k pass, descend one more ply before spending the
        // 1M retry and all wide second-move beams. This mirrors what happens
        // when the player enters a child: its newly exposed roots receive a
        // fair turn promptly. Keeping the receding-horizon audit behind every
        // expensive second-ply retry was the remaining source of the supplied
        // FA/DC parent-versus-click latency inversion.
        if (tier === 0) {
            moves = await runNestedPrefixPortfolio(
                moves, parents, isStale, post, postIfDue);
            if (isStale()) return moves;
        }
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

async function runNestedPrefixPortfolio(moves, parents, isStale, post, postIfDue) {
    const liveCells = new Set(moves
        .filter((move) => !move.exact && move.lower < move.score)
        .map((move) => move.cell));
    const byParent = [];
    let buildTurns = 0;

    // Only rows still unresolved at this frontier need a deeper allocation.
    // Each parent's local ordinals are rebuilt exactly as they are after that
    // parent is clicked, so omitting an already-proved sibling cannot renumber
    // or orphan any of this parent's work.
    for (const parent of parents) {
        if (!liveCells.has(parent.cell)) continue;
        const secondCount = eng.childGroupsToIO(parent.k);
        const secondReps = mem().slice(IO + 256, IO + 256 + secondCount);
        const secondSizes = mem().slice(IO + 512, IO + 512 + secondCount);
        // childGroupsToIO is already in the clicked board's stable root-index
        // order. Do not re-sort these roots by size: runVirtualChildPortfolio
        // sorts only the moves below each root, and that distinction controls
        // both its fair order and its lane ownership.
        const seconds = Array.from(secondReps, (second, index) => ({
            second,
            size: secondSizes[index],
        }));

        const branches = [];
        for (const entry of seconds) {
            if (isStale()) return moves;
            mem().set(Uint8Array.of(entry.second), IO);
            const thirdCount = eng.prefixGroupsToIO(parent.k, 1);
            if (thirdCount < 0) continue;
            const thirdReps = mem().slice(IO + 256, IO + 256 + thirdCount);
            const thirdSizes = mem().slice(IO + 512, IO + 512 + thirdCount);
            const thirds = Array.from(thirdReps, (third, index) => ({
                third,
                size: thirdSizes[index],
            })).sort((a, b) => b.size - a.size || a.third - b.third);
            const tasks = thirds.map(({ third }) => ({
                cell: parent.cell,
                prefix: [entry.second, third],
            }));
            branches.push({
                second: entry.second,
                tasks,
            });
            buildTurns++;
            if ((buildTurns & 7) === 0) await nextTick();
        }

        // Diagonal order is the parent-side analogue of giving every visible
        // child root one turn. Bound the initial frontier: an exhaustive
        // first×second×third Cartesian portfolio was itself the source of
        // multi-billion-node stalls and merely moved the cliff one ply.
        const parentTasks = mirrorClickedPrefixTasks(
            branches, NESTED_PREFIX_CONTEXTS_PER_PARENT);
        byParent.push({ cell: parent.cell, seconds: parentTasks });
    }

    const fairTasks = roundRobinPrefixTasks(byParent)
        .map((entry) => entry.second)
        .filter((task) => task.postClickOrdinal % LANES === LANE);

    // Discovery phase: one small exact target probe plus two complementary
    // heaps per context. Running the complete mini-portfolio context-by-
    // context lets a decisive third move land immediately instead of waiting
    // behind the same pass for every unrelated triple.
    for (const task of fairTasks) {
        if (isStale()) return moves;
        let current = moves.find((move) => move.cell === task.cell);
        if (!current || current.exact || current.lower >= current.score) continue;

        mem().set(Uint8Array.from(task.prefix), IO);
        const token = eng.exactBeginRootPrefixSeek(
            current.k, task.prefix.length, VIRTUAL_CHILD_PROOF_BUDGETS[0], current.lower);
        if (token !== 0) {
            let result = -1;
            while (result === -1) {
                if (isStale()) return moves;
                result = eng.exactStep(EXACT_CHUNK);
                postIfDue();
                await nextTick();
            }
            eng.exactCommitRootPrefix(token);
            moves = collectResults().moves;
            current = moves.find((move) => move.cell === task.cell);
        }

        for (const [width, seed] of NESTED_PREFIX_PASSES) {
            if (!current || current.exact || current.lower >= current.score ||
                current.score - current.lower > NESTED_PREFIX_STRONG_GAP) break;
            mem().set(Uint8Array.from(task.prefix), IO);
            if (eng.beamBeginRootPrefix(
                current.k, task.prefix.length, width, seed) !== 1) continue;
            for (;;) {
                if (isStale()) return moves;
                if (eng.beamStep(CHUNK) === 1) break;
                postIfDue();
                await nextTick();
            }
            moves = collectResults().moves;
            current = moves.find((move) => move.cell === task.cell);
        }
        postIfDue();
    }
    moves = post(false);

    // Strong target probes are a second fair round. By now a beam-resolvable
    // context such as DC→GD→DB has already returned; the 1M-node allocation
    // is retained for exact-only corridors such as FA→AC→DA.
    for (const task of fairTasks) {
        if (isStale()) return moves;
        const current = moves.find((move) => move.cell === task.cell);
        if (!current || current.exact || current.lower >= current.score ||
            current.score - current.lower > NESTED_PREFIX_STRONG_GAP) continue;
        mem().set(Uint8Array.from(task.prefix), IO);
        const token = eng.exactBeginRootPrefixSeek(
            current.k, task.prefix.length, VIRTUAL_CHILD_PROOF_BUDGETS[1], current.lower);
        if (token === 0) continue;
        let result = -1;
        while (result === -1) {
            if (isStale()) return moves;
            result = eng.exactStep(EXACT_CHUNK);
            postIfDue();
            await nextTick();
        }
        eng.exactCommitRootPrefix(token);
        moves = collectResults().moves;
        postIfDue();
    }
    moves = post(false);
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

// The pool composes a positive proof from a complete partition of one root
// child's legal second moves. Each lane keeps one assigned prefix's threshold
// DFS resident until it either finds a better line or certifies that entire
// prefix above the target. A single miss never changes the parent bound.
function createCoordinatedThresholdLadder(isStale, postIfDue) {
    let state = null;

    const samePlan = (plan) => state && plan && state.id === plan.id &&
        state.epoch === plan.epoch && state.target === plan.target &&
        state.round === plan.round;

    const cancel = () => {
        if (state?.running) eng.thresholdCancel();
        state = null;
    };

    const sync = (moves) => {
        const plan = thresholdPlan;
        if (!plan) {
            cancel();
            return false;
        }
        if (plan.tasks === null) {
            if (!samePlan(plan)) {
                cancel();
                state = { ...plan, tasks: [], at: 0, running: false };
            }
            return true;
        }
        if (samePlan(plan)) return true;
        cancel();
        const tasks = [];
        for (let ordinal = 0; ordinal < plan.tasks.length; ordinal++) {
            if (ordinal % LANES !== LANE) continue;
            const source = plan.tasks[ordinal];
            const row = moves.find((move) => move.cell === source.rootCell);
            if (!row || !Array.isArray(source.prefix) || source.prefix.length >= 80) {
                throw new Error(`invalid coordinated threshold task ${source.rootCell}/${source.prefix}`);
            }
            tasks.push({
                rootCell: source.rootCell,
                prefix: source.prefix.slice(),
                k: row.k,
                attempts: 0,
            });
        }
        state = {
            ...plan,
            tasks,
            at: 0,
            running: false,
        };
        return true;
    };

    const postOutcome = (type, task, children = undefined) => {
        self.postMessage({
            type,
            id: state.id,
            epoch: state.epoch,
            target: state.target,
            round: state.round,
            rootCell: task.rootCell,
            prefix: task.prefix,
            ...(children === undefined ? {} : { children }),
        });
        state.tasks.splice(state.at, 1);
        if (state.at >= state.tasks.length) state.at = 0;
        state.running = false;
    };

    const finish = (result, task) => {
        const plan = state;
        const merged = eng.thresholdMerge();
        state.running = false;
        if (result <= plan.target) {
            // The prefixed constructive line is already in the root table.
            // Retire this lane's plan locally before posting: an immediate
            // memo-backed witness could otherwise restart in a tight loop
            // before the pool's cancel message gets a task turn.
            state.tasks.length = 0;
            state.at = 0;
            return { active: true, changed: merged >= 0 };
        }
        if (result !== plan.target + 1 || merged !== result) {
            throw new Error(`invalid coordinated threshold result ${result}/${merged}`);
        }
        postOutcome("threshold-prefix-miss", task);
        return { active: true, changed: false };
    };

    return {
        async advance(moves) {
            if (!sync(moves)) return { active: false, changed: false };
            if (!state || state.at >= state.tasks.length) {
                await nextTick();
                return { active: true, changed: false };
            }

            const task = state.tasks[state.at];
            if (!state.running) {
                mem().set(Uint8Array.from(task.prefix), IO);
                const budget = Math.min(COORDINATED_PREFIX_BUDGET_MAX,
                    COORDINATED_PREFIX_BUDGET * 2 ** Math.min(task.attempts, 5));
                const begun = eng.thresholdBeginRootPrefix(
                    task.k, task.prefix.length, state.target, budget);
                if (begun === -2) {
                    throw new Error(`invalid coordinated threshold prefix ${task.rootCell}/${task.prefix}`);
                }
                if (begun >= 0) {
                    const completed = finish(begun, task);
                    await nextTick();
                    return completed;
                }
                state.running = true;
            }

            for (let slice = 0; slice < 4; slice++) {
                if (isStale()) return { active: true, changed: false };
                const result = eng.thresholdStep(EXACT_CHUNK);
                if (result === -1) {
                    postIfDue();
                    await nextTick();
                    if (!samePlan(thresholdPlan)) return { active: true, changed: false };
                    continue;
                }
                if (result === -2) {
                    state.running = false;
                    if (task.prefix.length >= COORDINATED_MAX_SPLIT_PREFIX) {
                        // Keep every completed VTT certificate, but rotate the
                        // unfinished state so one hard prefix cannot hold all
                        // later roots behind it. The budget escalates on every
                        // return to this stable task/lane, limiting deterministic
                        // retracing while preserving cross-task transpositions.
                        task.attempts++;
                        if (state.tasks.length > 1) {
                            eng.thresholdCancel();
                            state.tasks.splice(state.at, 1);
                            state.tasks.push(task);
                            if (state.at >= state.tasks.length) state.at = 0;
                        }
                        postIfDue();
                        await nextTick();
                        return { active: true, changed: false };
                    }

                    // Split a root exactly once into its complete legal
                    // second-move manifest. Every fixed child then remains a
                    // resumable DFS until it returns a witness or certificate.
                    eng.thresholdCancel();
                    mem().set(Uint8Array.from(task.prefix), IO);
                    const count = eng.prefixGroupsToIO(task.k, task.prefix.length);
                    if (count <= 0) {
                        throw new Error(`coordinated threshold cannot split ${task.rootCell}/${task.prefix}`);
                    }
                    const children = Array.from(mem().slice(IO + 256, IO + 256 + count))
                        .sort((a, b) => a - b);
                    const childStates = [];
                    for (const child of children) {
                        const extended = [...task.prefix, child];
                        mem().set(Uint8Array.from(extended), IO);
                        if (eng.prefixGroupsToIO(task.k, extended.length) < 0) {
                            throw new Error(`coordinated threshold child is invalid ${task.rootCell}/${extended}`);
                        }
                        childStates.push({
                            cell: child,
                            board: mem().slice(IO, IO + SIZE * SIZE),
                        });
                    }
                    postOutcome("threshold-prefix-split", task, childStates);
                    await nextTick();
                    return { active: true, changed: false };
                }
                const completed = finish(result, task);
                await nextTick();
                return completed;
            }
            return { active: true, changed: false };
        },
    };
}

// Exact-proof ladder: compact endgames try incumbent-driven branch and bound
// first; larger proving-gate positions start the persistent value memo
// directly. The memo is shared across roots, retries and later analysis
// positions. Improving terminals are retained as durable lines inside WASM;
// a memo-guided witness DFS repairs any remaining policy-cache gap.
function createExactLadder(isStale) {
    const exhausted = new Map(); // cell -> last value-solve budget tried
    const thresholdExhausted = new Map(); // cell:target -> last retained threshold budget
    const lineExhausted = new Map(); // cell -> last guided witness budget tried
    const boundTried = new Set();
    let active = null; // { k, cell, mode: "threshold" | "bound" | "value" | "line", ... }

    return {
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

        shouldPrioritize(moves) {
            if (active?.mode === "threshold") return true;
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
            if (active && moves.find((m) => m.cell === active.cell)?.exact) {
                if (active.mode === "threshold") eng.thresholdCancel();
                active = null;
            }
            if (active?.mode === "threshold") {
                const proof = summarizePositionProof(moves, (move) => move.lower);
                const row = moves.find((move) => move.cell === active.cell);
                if (proof.positionExact || proof.positionUpper <= 0 ||
                    active.target !== proof.positionUpper - 1 || !row ||
                    row.lower >= proof.positionUpper) {
                    eng.thresholdCancel();
                    active = null;
                }
            }

            if (!active) {
                const proof = summarizePositionProof(moves, (move) => move.lower);
                // For a positive incumbent U, proving the position only asks
                // whether any root reaches U-1. Give every threatening compact
                // root to its normal owner and run the persistent Boolean
                // threshold solver. A completed miss raises that row's lower
                // bound to U; all lanes' independent misses then compose into
                // the board-wide proof, while a hit supplies a better line.
                const thresholdNext = proof.positionUpper > 0 && !proof.positionExact
                    ? moves.filter((move) => owns(move) && !move.exact &&
                        move.lower < proof.positionUpper &&
                        childRemaining(move) <= EXACT_TRY_REMAINING)
                        .sort((a, b) => a.size - b.size || a.score - b.score ||
                            a.cell - b.cell)[0]
                    : null;
                if (thresholdNext) {
                    const started = this.startThreshold(
                        thresholdNext, proof.positionUpper - 1);
                    if (started !== null) return started;
                }

                // Least-invested budget first, then the broadest child
                // (smallest removed root group): fresh roots all get their
                // first bounded attempt — in the memo-warming broad order —
                // before any hard sibling escalates a tier. One un-enumerable
                // child can otherwise monopolize the lane for minutes while
                // a root behind it is provable within its very first budget.
                const investedOf = (move) => exhausted.get(move.cell) ?? 0;
                const next = active ? null : exactCandidateOrder(
                    moves.filter((m) => owns(m) && !m.exact &&
                        childRemaining(m) <= EXACT_TRY_REMAINING), investedOf)[0] ??
                    // Adopt stuck satellite-owned in-band roots: proofs the
                    // position certainly owes, on this lane's full value memo.
                    exactCandidateOrder(this.caretakerCandidates(moves), investedOf)[0];
                if (!active && !next) return false; // no child is inside the exact gate

                const remaining = next ? childRemaining(next) : active.remaining;

                if (!active && remaining <= BOUND_TRY_REMAINING && !boundTried.has(next.cell)) {
                    boundTried.add(next.cell);
                    active = { k: next.k, cell: next.cell, mode: "bound",
                        budget: BOUND_BUDGET, target: -1, remaining };
                    eng.exactBeginChild(next.k, BOUND_BUDGET);
                } else if (!active) {
                    const started = this.startValue(next);
                    if (started !== null) return started;
                }
            }

            // Match the clicked child size, not the untouched parent size.
            const slices = active.remaining <= EXACT_REMAINING ? 8 : 4;

            // a bounded number of chunks per cycle, then back to the beams
            for (let c = 0; c < slices; c++) {
                if (isStale()) return false;
                const mode = active.mode;
                const r = mode === "value" ? eng.vsStep(EXACT_CHUNK) :
                    mode === "threshold" ? eng.thresholdStep(EXACT_CHUNK) :
                        eng.exactStep(EXACT_CHUNK);
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

                if (mode === "threshold") {
                    if (r === -2) {
                        thresholdExhausted.set(
                            `${active.cell}:${active.target}`, active.budget);
                        active = null;
                        return false;
                    }
                    const merged = eng.thresholdMerge();
                    active = null;
                    return merged >= 0;
                }

                if (mode === "value") {
                    if (r === -2) { // budget out — memo kept, retry escalates
                        exhausted.set(active.cell, active.budget);
                        active = null;
                        return false;
                    }
                    return this.finishValue(r);
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

        startThreshold(move, target) {
            const key = `${move.cell}:${target}`;
            const previous = thresholdExhausted.get(key) ?? EXACT_BUDGET / 4;
            const budget = Math.min(EXACT_BUDGET_MAX, previous * 4);
            active = { k: move.k, cell: move.cell, mode: "threshold", budget, target,
                remaining: childRemaining(move) };
            const immediate = eng.thresholdBeginChild(move.k, target, budget);
            if (immediate === -2) { active = null; return false; }
            if (immediate >= 0) {
                const merged = eng.thresholdMerge();
                active = null;
                return merged >= 0;
            }
            return null;
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
            wasmURL.searchParams.set("build", "20260715-engine2");
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
