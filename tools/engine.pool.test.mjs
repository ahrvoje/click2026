/** Regression tests for adaptive worker policy, partitioning and merge logic. */

import {
    EngineWorkerPool,
    laneOwnsRoot,
    laneSeed,
    mergeLaneResults,
    rootOwner,
    selectLaneCount,
} from "../src/scripts/engine/pool.js";

import assert from "node:assert/strict";

// Resource policy: one phone lane, two on a constrained notebook, and up to
// sixteen lanes using one 178 MiB primary plus compact 46 MiB satellites.
assert.equal(selectLaneCount({ hardwareConcurrency: 6, deviceMemory: 8, mobile: true }), 1);
assert.equal(selectLaneCount({ hardwareConcurrency: 8, deviceMemory: 8, mobile: false }), 2);
assert.equal(selectLaneCount({ hardwareConcurrency: 10, deviceMemory: 8, mobile: false }), 3);
assert.equal(selectLaneCount({ hardwareConcurrency: 16, deviceMemory: 8, mobile: false }), 4);
assert.equal(selectLaneCount({ hardwareConcurrency: 20, deviceMemory: 8, mobile: false }), 8);
assert.equal(selectLaneCount({ hardwareConcurrency: 24, deviceMemory: 8, mobile: false }), 8);
assert.equal(selectLaneCount({ hardwareConcurrency: 32, deviceMemory: 8, mobile: false }), 16);
assert.equal(selectLaneCount({ hardwareConcurrency: 32, deviceMemory: 4, mobile: false }), 6);
assert.equal(selectLaneCount({ hardwareConcurrency: 32, deviceMemory: 2, mobile: false }), 1);
assert.equal(selectLaneCount({ hardwareConcurrency: 32, deviceMemory: 8, mobile: false },
    { maxLanes: 3 }), 3);

// Every root ordinal has exactly one stable owner for every supported pool
// size. Consecutive enumeration indices also keep lane counts within one.
for (let lanes = 1; lanes <= 16; lanes++) {
    for (let rootIndex = 0; rootIndex < 144; rootIndex++) {
        const owners = Array.from({ length: lanes }, (_, lane) =>
            laneOwnsRoot(rootIndex, lane, lanes)).filter(Boolean).length;
        assert.equal(owners, 1);
        assert.equal(rootOwner(rootIndex, lanes), rootIndex % lanes);
    }
    for (let rootCount = 0; rootCount <= 72; rootCount++) {
        const counts = Array(lanes).fill(0);
        for (let rootIndex = 0; rootIndex < rootCount; rootIndex++) {
            counts[rootOwner(rootIndex, lanes)]++;
        }
        assert.ok(Math.max(...counts) - Math.min(...counts) <= 1);
    }
}
assert.equal(new Set(Array.from({ length: 15 }, (_, k) => rootOwner(k, 16))).size, 15);
const seeds = new Set();
for (let lane = 0; lane < 16; lane++) {
    for (let pass = 0; pass < 16; pass++) seeds.add(laneSeed(1, lane, pass));
}
assert.equal(seeds.size, 256);
assert.ok(!seeds.has(0));

const move = (cell, score, lower, exact = false, lineLength = 3) => ({
    k: cell, cell, x: 0, y: cell, color: 1, size: 2, score, lower, exact,
    cells: [[0, cell]], line: Array.from({ length: lineLength }, () => cell),
});
const laneResult = (lane, moves, extra = {}) => ({
    type: "result", id: 7, remaining: 100, moves,
    stats: {
        nodes: 1000 * (lane + 1), elapsed: 1000, depth: lane + 2,
        width: 512 * (lane + 1), gpu: lane === 0 ? "on" : "off",
        settled: false,
        cpu: {
            positions: 1000 * (lane + 1), pps: 1000 * (lane + 1),
            beamPositions: 800, exactPositions: 100, playoutPositions: 100,
            playouts: 4,
        },
        gpuStats: lane === 0 ? {
            positions: 16000, pps: 32000, playouts: 512,
            batches: 1, activeMs: 500, profile: "discrete",
            adapter: { vendor: "NVIDIA", description: "GeForce RTX 4080" },
        } : {},
        ...extra,
    },
});

// Constructive bounds merge by min(score)/max(lower), exact proof wins, and
// the final ranking is recomputed rather than inherited from a lane.
const merged = mergeLaneResults([
    laneResult(0, [move(0, 5, 0), move(1, 4, 1)]),
    laneResult(1, [move(0, 3, 2), move(1, 4, 4, true, 2)]),
], 2);
assert.deepEqual(merged.moves.map(({ cell, score, lower, exact }) =>
    ({ cell, score, lower, exact })), [
    { cell: 0, score: 3, lower: 2, exact: false },
    { cell: 1, score: 4, lower: 4, exact: true },
]);
assert.equal(merged.stats.cpu.workers, 2);
assert.equal(merged.stats.cpu.positions, 3000);
assert.equal(merged.stats.cpu.pps, 3000);
assert.equal(merged.stats.cpu.beamPositions, 1600);
assert.equal(merged.stats.gpuStats.positions, 16000);
assert.equal(merged.stats.gpuStats.pps, 16000);
assert.equal(merged.stats.gpuStats.activePps, 32000);
assert.equal(merged.stats.gpuStats.duty, 50);
assert.equal(merged.stats.gpuStats.profile, "discrete");
assert.equal(merged.stats.gpuStats.adapter.description, "GeForce RTX 4080");
assert.equal(merged.stats.totalPositions, 19000);
assert.equal(merged.stats.totalPps, 19000);
assert.equal(merged.stats.nodes, 3000);
assert.equal(merged.stats.gpu, "on");
assert.equal(merged.stats.state, "analyzing");

// Pool throughput is total work / analysis wall time, never the sum of stale
// lifetime averages reported by lanes that may already have stopped.
const honestRate = mergeLaneResults([
    laneResult(0, [move(0, 5, 0)], {
        elapsed: 1000,
        settled: true,
        cpu: { positions: 1000, pps: 1000 },
        gpuStats: {},
    }),
    laneResult(1, [move(0, 5, 0)], {
        elapsed: 4000,
        cpu: { positions: 4000, pps: 1000 },
        gpuStats: {},
    }),
], 2);
assert.equal(honestRate.stats.cpu.positions, 5000);
assert.equal(honestRate.stats.cpu.pps, 1250);
assert.equal(honestRate.stats.nps, 1250);

// Proofs from different lanes compose into an all-root proof.
const proved = mergeLaneResults([
    laneResult(0, [move(0, 2, 2, true), move(1, 6, 1)], { settled: true }),
    laneResult(1, [move(0, 4, 0), move(1, 6, 6, true)], { settled: true }),
], 2);
assert.equal(proved.stats.allMovesExact, true);
assert.equal(proved.stats.positionLower, 2);
assert.equal(proved.stats.positionUpper, 2);
assert.equal(proved.stats.state, "proven");

assert.throws(() => mergeLaneResults([
    laneResult(0, [move(0, 2, 2, true)]),
    laneResult(1, [move(0, 3, 3, true)]),
]), /proof disagreement/);
assert.throws(() => mergeLaneResults([
    laneResult(0, [move(0, 2, 2, true)]),
    laneResult(1, [move(0, 1, 0, false)]),
]), /contradicts proof/);

// Every reported and composed interval must remain valid. In particular, a
// peer lower bound above an exact value or above another peer's constructive
// witness is a contradiction, even when each individual peer interval looked
// locally ordered before composition.
assert.throws(() => mergeLaneResults([
    laneResult(0, [move(0, Number.NaN, 0)]),
]), /invalid worker bounds/);
assert.throws(() => mergeLaneResults([
    laneResult(0, [move(0, 3, Number.POSITIVE_INFINITY)]),
]), /invalid worker bounds/);
assert.throws(() => mergeLaneResults([
    laneResult(0, [move(0, 2, 3)]),
]), /invalid worker bounds/);
assert.throws(() => mergeLaneResults([
    laneResult(0, [move(0, 2, 0)]),
    laneResult(1, [move(0, 5, 4)]),
]), /lower bound contradicts constructive score/);
assert.throws(() => mergeLaneResults([
    laneResult(0, [move(0, 2, 0, true)]),
    laneResult(1, [move(0, 5, 3)]),
]), /lower bound contradicts proof/);
assert.throws(() => mergeLaneResults([
    laneResult(0, [{ ...move(0, 2, 0), exact: 1 }]),
]), /invalid worker exact flag/);

// An exhaustive proof may legitimately be stronger than the static lower
// bound reported by that worker; the merge promotes its effective lower bound
// to the proven value.
const promotedExact = mergeLaneResults([
    laneResult(0, [move(0, 5, 1, true)]),
]);
assert.deepEqual({ score: promotedExact.moves[0].score, lower: promotedExact.moves[0].lower,
    exact: promotedExact.moves[0].exact }, { score: 5, lower: 5, exact: true });

// Main-thread pool wiring: only lane zero owns GPU, analyze boards are cloned,
// and streaming lane results are merged.
class FakeWorker {
    static instances = [];
    constructor(url) {
        this.url = url;
        this.messages = [];
        this.terminated = false;
        FakeWorker.instances.push(this);
    }
    postMessage(message) { this.messages.push(message); }
    terminate() { this.terminated = true; }
    emit(data) { this.onmessage({ data }); }
}

const pool = new EngineWorkerPool("https://example.test/worker.js", {
    Worker: FakeWorker,
    laneCount: 2,
});
assert.equal(FakeWorker.instances[0].url.searchParams.get("gpu"), "1");
assert.equal(FakeWorker.instances[1].url.searchParams.get("gpu"), "0");
const emitted = [];
pool.onmessage = (event) => emitted.push(event.data);
const board = new Uint8Array(144).fill(1);
pool.postMessage({ type: "analyze", id: 7, board });
board[0] = 5;
assert.equal(FakeWorker.instances[0].messages[0].board[0], 1);
assert.notEqual(FakeWorker.instances[0].messages[0].board,
    FakeWorker.instances[1].messages[0].board);
FakeWorker.instances[0].emit({ type: "ready", gpu: "on" });
assert.equal(emitted.length, 0);
FakeWorker.instances[1].emit({ type: "ready", gpu: "off" });
assert.deepEqual(emitted.pop(), { type: "ready", gpu: "on", workers: 2 });
FakeWorker.instances[0].emit(laneResult(0, [move(0, 5, 0), move(1, 4, 1)]));
FakeWorker.instances[1].emit(laneResult(1, [move(0, 3, 2), move(1, 4, 4, true)]));
assert.equal(emitted.at(-1).moves[0].score, 3);
assert.equal(emitted.at(-1).stats.cpu.workers, 2);

// Exact rows can compose one message before every lane has sent its stopped
// snapshot. That bounded wind-down is `optimal`, never a changing `proven`.
// Once the final stopped snapshot produces `proven`, the pool latches it and
// ignores any queued same-position result so terminal counters cannot move.
FakeWorker.instances[0].emit(laneResult(0,
    [move(0, 2, 2, true), move(1, 6, 1)], { settled: true }));
FakeWorker.instances[1].emit(laneResult(1,
    [move(0, 4, 0), move(1, 6, 6, true)], { settled: false }));
const windingDown = emitted.at(-1);
assert.equal(windingDown.stats.allMovesExact, true);
assert.equal(windingDown.stats.settled, false);
assert.equal(windingDown.stats.state, "optimal");

FakeWorker.instances[1].emit(laneResult(1,
    [move(0, 4, 0), move(1, 6, 6, true)], { settled: true }));
const terminal = emitted.at(-1);
assert.equal(terminal.stats.settled, true);
assert.equal(terminal.stats.state, "proven");
const terminalEmissions = emitted.length;
FakeWorker.instances[1].emit(laneResult(1,
    [move(0, 4, 0), move(1, 6, 6, true)], {
        settled: true,
        cpu: { positions: 999999, pps: 999999 },
    }));
assert.equal(emitted.length, terminalEmissions);
assert.equal(emitted.at(-1).stats.totalPositions, terminal.stats.totalPositions);
pool.terminate();
assert.ok(FakeWorker.instances.every((worker) => worker.terminated));

// A positive bound is a distributed proof over a complete adaptive frontier.
// A hard task may split, but neither the split nor partial/duplicate misses
// can raise a root until every resulting branch is covered.
FakeWorker.instances = [];
const thresholdPool = new EngineWorkerPool("https://example.test/worker.js", {
    Worker: FakeWorker,
    laneCount: 2,
});
const thresholdEmitted = [];
thresholdPool.onmessage = (event) => thresholdEmitted.push(event.data);
thresholdPool.postMessage({ type: "analyze", id: 7, board: new Uint8Array(144) });
const thresholdMoves = [move(0, 1, 0), move(1, 1, 0)];
FakeWorker.instances[0].emit({ ...laneResult(0, thresholdMoves), remaining: 84 });
FakeWorker.instances[1].emit({ ...laneResult(1, thresholdMoves), remaining: 84 });
const plans = FakeWorker.instances.map((worker) =>
    worker.messages.find((message) => message.type === "threshold-plan"));
assert.ok(plans.every(Boolean));
assert.deepEqual(plans.map(({ roots, target }) => ({ roots, target })), [
    { roots: [0, 1], target: 0 },
    { roots: [0, 1], target: 0 },
]);
const plan = plans[0];
const proofBoard = (value) => new Uint8Array(144).fill(value);
const outcome = (lane, type, rootCell, prefix, extra = {}) =>
    FakeWorker.instances[lane].emit({
        type,
        id: 7,
        epoch: plan.epoch,
        target: 0,
        round: extra.round ?? 0,
        rootCell,
        prefix,
        ...extra,
    });
outcome(0, "threshold-prefix-split", 0, [], { children: [
    { cell: 10, board: proofBoard(1) },
    { cell: 20, board: proofBoard(2) },
] });
assert.ok(FakeWorker.instances.every((worker) =>
    !worker.messages.some((message) => message.type === "threshold-root-bound")));
outcome(1, "threshold-prefix-miss", 1, []);
assert.ok(FakeWorker.instances.every((worker) => worker.messages.some((message) =>
    message.type === "threshold-root-bound" && message.rootCell === 1 && message.lower === 1)));
const roundOne = FakeWorker.instances[0].messages.find((message) =>
    message.type === "threshold-frontier" && message.round === 1);
assert.deepEqual(roundOne.tasks, [
    { rootCell: 0, prefix: [10] },
    { rootCell: 0, prefix: [20] },
]);
const miss = (lane, prefix) => FakeWorker.instances[lane].emit({
    type: "threshold-prefix-miss",
    id: 7,
    epoch: plan.epoch,
    target: 0,
    round: 1,
    rootCell: 0,
    prefix,
});
miss(0, [10]);
miss(0, [10]); // duplicate is idempotent
assert.equal(FakeWorker.instances[0].messages.filter((message) =>
    message.type === "threshold-root-bound" && message.rootCell === 0).length, 0);
miss(1, [20]);
assert.ok(FakeWorker.instances.every((worker) => worker.messages.some((message) =>
    message.type === "threshold-root-bound" && message.rootCell === 0 && message.lower === 1)));
assert.ok(FakeWorker.instances.every((worker) => worker.messages.some((message) =>
    message.type === "threshold-cancel" && message.id === 7 &&
    message.epoch === plan.epoch)),
"completed coordinated frontier cancels every worker's local idle ladder");
assert.deepEqual(thresholdEmitted.at(-1).moves.map(({ score, lower, exact }) =>
    ({ score, lower, exact })), [
    { score: 1, lower: 1, exact: true },
    { score: 1, lower: 1, exact: true },
]);
const boundMessages = FakeWorker.instances[0].messages.filter((message) =>
    message.type === "threshold-root-bound").length;
miss(1, [20]); // stale completed-plan traffic is ignored
assert.equal(FakeWorker.instances[0].messages.filter((message) =>
    message.type === "threshold-root-bound").length, boundMessages);
thresholdPool.terminate();

// Commuting move orders that reach the exact same 144-byte board are one
// threshold state. A single miss may discharge every participating root, but
// the pool must retain one replayable prefix per root until that miss lands.
FakeWorker.instances = [];
const aliasPool = new EngineWorkerPool("https://example.test/worker.js", {
    Worker: FakeWorker,
    laneCount: 2,
});
const aliasEmitted = [];
aliasPool.onmessage = (event) => aliasEmitted.push(event.data);
aliasPool.postMessage({ type: "analyze", id: 7, board: new Uint8Array(144) });
FakeWorker.instances[0].emit({ ...laneResult(0, thresholdMoves), remaining: 84 });
FakeWorker.instances[1].emit({ ...laneResult(1, thresholdMoves), remaining: 84 });
const aliasPlan = FakeWorker.instances[0].messages.find((message) =>
    message.type === "threshold-plan");
const aliasSplit = (lane, rootCell, child, boardState) =>
    FakeWorker.instances[lane].emit({
        type: "threshold-prefix-split",
        id: 7,
        epoch: aliasPlan.epoch,
        target: 0,
        round: 0,
        rootCell,
        prefix: [],
        children: [{ cell: child, board: boardState }],
    });
const sharedState = proofBoard(3);
aliasSplit(0, 0, 10, sharedState);
aliasSplit(1, 1, 20, sharedState.slice());
const aliasRound = FakeWorker.instances[0].messages.find((message) =>
    message.type === "threshold-frontier" && message.round === 1);
assert.deepEqual(aliasRound.tasks, [{ rootCell: 0, prefix: [10] }]);
FakeWorker.instances[0].emit({
    type: "threshold-prefix-miss",
    id: 7,
    epoch: aliasPlan.epoch,
    target: 0,
    round: 1,
    rootCell: 0,
    prefix: [10],
});
for (const rootCell of [0, 1]) {
    assert.ok(FakeWorker.instances.every((worker) => worker.messages.some((message) =>
        message.type === "threshold-root-bound" &&
        message.rootCell === rootCell && message.lower === 1)));
}
assert.deepEqual(aliasEmitted.at(-1).moves.map(({ lower, exact }) => ({ lower, exact })), [
    { lower: 1, exact: true },
    { lower: 1, exact: true },
]);
aliasPool.terminate();

// A CPU-only peer that has exhausted its search must release lane zero from
// an otherwise unbounded GPU caretaker loop. This is a control message only;
// it does not manufacture an exact result for the unresolved peer row.
FakeWorker.instances = [];
const caretakerPool = new EngineWorkerPool("https://example.test/worker.js", {
    Worker: FakeWorker,
    laneCount: 2,
});
caretakerPool.postMessage({ type: "analyze", id: 7, board: new Uint8Array(144) });
FakeWorker.instances[0].emit(laneResult(0,
    [move(0, 3, 2), move(1, 4, 1)], { settled: false }));
FakeWorker.instances[1].emit(laneResult(1,
    [move(0, 3, 2), move(1, 4, 1)], { settled: true }));
assert.ok(FakeWorker.instances[0].messages.some((message) =>
    message.type === "stop-caretaker" && message.id === 7));
caretakerPool.terminate();

// Losing a lane changes modulo ownership. The pool must restart every lane
// at N-1 and replay the current position, never silently strand failed roots.
FakeWorker.instances = [];
const fallbackPool = new EngineWorkerPool("https://example.test/worker.js", {
    Worker: FakeWorker,
    laneCount: 3,
});
fallbackPool.postMessage({ type: "analyze", id: 8, board: new Uint8Array(144) });
const firstGeneration = FakeWorker.instances.slice();
firstGeneration[2].onerror({ message: "synthetic lane failure" });
assert.ok(firstGeneration.every((worker) => worker.terminated));
const secondGeneration = FakeWorker.instances.slice(3);
assert.equal(fallbackPool.laneCount, 2);
assert.equal(secondGeneration.length, 2);
assert.ok(secondGeneration.every((worker) => worker.messages[0].id === 8));
assert.ok(secondGeneration.every((worker) => worker.messages[0].lanes === 2));
fallbackPool.terminate();

console.log("ok    adaptive engine worker pool");
