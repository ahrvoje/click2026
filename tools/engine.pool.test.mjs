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
import {
    canTransferExactSuffix,
    roundRobinPrefixTasks,
} from "../src/scripts/engine/schedule.js";

// Parent-major ordinals stay stable while execution rotates parents fairly.
// Lane filtering therefore covers every pair exactly once without relying on
// clustered board-cell representatives.
const prefixParents = [
    { cell: 10, seconds: [
        { second: 11, ordinal: 0 },
        { second: 12, ordinal: 1 },
        { second: 13, ordinal: 2 },
    ] },
    { cell: 20, seconds: [
        { second: 21, ordinal: 3 },
        { second: 22, ordinal: 4 },
    ] },
];
const fairPrefixTasks = roundRobinPrefixTasks(prefixParents)
    .map((entry) => entry.second);
assert.deepEqual(fairPrefixTasks.map((task) => task.second), [11, 21, 12, 22, 13]);
for (let lanes = 1; lanes <= 4; lanes++) {
    const assigned = Array.from({ length: lanes }, (_, lane) => fairPrefixTasks
        .filter((task) => task.ordinal % lanes === lane))
        .flat();
    assert.deepEqual(assigned.map((task) => task.ordinal).sort((a, b) => a - b),
        [0, 1, 2, 3, 4]);
}
for (const total of [211, 478]) {
    const counts = Array(16).fill(0);
    for (let ordinal = 0; ordinal < total; ordinal++) counts[ordinal % 16]++;
    assert.ok(Math.max(...counts) - Math.min(...counts) <= 1);
}

// Exactness follows only across the recorded real child edge. The same line
// remains reusable constructively on every board because worker replay is the
// independent legality/upper-bound boundary.
const previousAnalysis = {
    childKeys: new Map([[10, "actual-child"]]),
};
assert.equal(canTransferExactSuffix(previousAnalysis,
    { cell: 10, exact: true }, "actual-child"), true);
assert.equal(canTransferExactSuffix(previousAnalysis,
    { cell: 10, exact: true }, "other-child"), false);
assert.equal(canTransferExactSuffix(previousAnalysis,
    { cell: 10, exact: false }, "actual-child"), false);

// Resource policy: one phone lane, two on a constrained notebook, and up to
// sixteen lanes using one 178 MiB primary plus compact 37 MiB satellites.
assert.equal(selectLaneCount({ hardwareConcurrency: 6, deviceMemory: 8, mobile: true }), 1);
assert.equal(selectLaneCount({ hardwareConcurrency: 8, deviceMemory: 8, mobile: false }), 2);
assert.equal(selectLaneCount({ hardwareConcurrency: 10, deviceMemory: 8, mobile: false }), 3);
assert.equal(selectLaneCount({ hardwareConcurrency: 16, deviceMemory: 8, mobile: false }), 4);
assert.equal(selectLaneCount({ hardwareConcurrency: 20, deviceMemory: 8, mobile: false }), 8);
assert.equal(selectLaneCount({ hardwareConcurrency: 24, deviceMemory: 8, mobile: false }), 8);
assert.equal(selectLaneCount({ hardwareConcurrency: 32, deviceMemory: 8, mobile: false }), 16);
assert.equal(selectLaneCount({ hardwareConcurrency: 32, deviceMemory: 2, mobile: false }), 1);
assert.equal(selectLaneCount({ hardwareConcurrency: 32, deviceMemory: 8, mobile: false },
    { maxLanes: 3 }), 3);

// Every root has exactly one stable owner for every supported pool size.
for (let lanes = 1; lanes <= 16; lanes++) {
    for (let cell = 0; cell < 144; cell++) {
        const owners = Array.from({ length: lanes }, (_, lane) =>
            laneOwnsRoot(cell, lane, lanes)).filter(Boolean).length;
        assert.equal(owners, 1);
        assert.equal(rootOwner(cell, lanes), cell % lanes);
    }
}
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
