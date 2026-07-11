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
 *   2. CPU playout round           — tabu-color random playouts per root
 *   3. widening beam passes        — deterministic, widths 8..2048
 *   4. continuous investigation    — endless diversified beam passes (widths
 *      cycling 256..4096) plus playout rounds biased to the current top
 *      moves (GPU-accelerated when WebGPU is available), interleaved with an
 *      exact-proof ladder that solves each root move's child position once
 *      the board is small enough
 *
 * Analysis never idles out: it ends only when EVERY move's score is proven
 * optimal (the board is then fully understood) or a new position arrives.
 *
 * Copyright 2014-2026, Hrvoje Abraham ahrvoje@gmail.com
 * Released under the MIT license.
 * https://opensource.org/licenses/MIT
 *
 * Date: Sat Jul 11, 2026
 */

import { createGpu, dominantColor } from "./gpu.js";

const SIZE = 12;
const CHUNK = 16000;            // beam expansions per slice, ~10 ms
const EXACT_CHUNK = 60000;      // exact solver expansions per slice
const EXACT_REMAINING = 32;     // exact proving starts at or below this many cells
const EXACT_BUDGET = 2000000;   // first proof attempt per move; escalates ×4
const EXACT_MAX_BUDGET = 32000000;
const WIDEN_WIDTHS = [8, 32, 128, 512, 2048];
const DEEP_WIDTHS = [2048, 256, 512, 1024];   // continuous-phase cycle
const DEEP_FULL_EVERY = 8;      // every n-th continuous pass runs at full width 4096
const POST_INTERVAL_MS = 150;

let eng = null;
let IO = 0;
let gpu = null;
let gpuState = "off";           // "off" | "on" | "failed"

let job = null;
let jobVersion = 0;
let kickWaiter = null;

// fast macrotask yield — setTimeout(0) clamps, a MessageChannel does not
const tickChannel = new MessageChannel();
const tickQueue = [];
tickChannel.port1.onmessage = () => tickQueue.shift()?.();
const nextTick = () => new Promise((resolve) => {
    tickQueue.push(resolve);
    tickChannel.port2.postMessage(0);
});

const mem = () => new Uint8Array(eng.memory.buffer);

self.onmessage = (event) => {
    const msg = event.data;
    if (msg.type === "analyze") {
        job = msg;
        jobVersion++;
        if (kickWaiter) {
            kickWaiter();
            kickWaiter = null;
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

    // chess-engine ordering: best score first, then bigger groups
    moves.sort((a, b) => a.score - b.score || b.size - a.size || a.cell - b.cell);

    return { moves, nodes, depth, width, remaining };
}

// --- analysis ----------------------------------------------------------------

async function analyze(myJob, isStale) {
    const t0 = performance.now();
    let lastPost = 0;

    mem().set(myJob.board, IO);
    eng.setBoard();

    const post = (settled) => {
        const { moves, nodes, depth, width, remaining } = collectResults();
        self.postMessage({
            type: "result",
            id: myJob.id,
            remaining,
            moves,
            stats: {
                nodes,
                depth,
                width,
                elapsed: performance.now() - t0,
                nps: nodes / Math.max(1, performance.now() - t0) * 1000,
                gpu: gpuState,
                settled: settled === true,
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

    let seedBase = 1;

    // 2. quick CPU playout round: 32 playouts per root move
    for (let k = 0; k < moves.length; k++) {
        if (isStale()) return;
        eng.playoutRoot(k, 32, seedBase);
        seedBase += 32;
        if (k % 8 === 7) {
            postIfDue();
            await nextTick();
        }
    }
    moves = post(false);

    // 3. deterministic widening beam passes — always the full ladder, even
    // when a clear shows up early: the other top moves still need refining
    for (const width of WIDEN_WIDTHS) {
        eng.beamBegin(width, 0);
        for (;;) {
            if (isStale()) return;
            if (eng.beamStep(CHUNK) === 1) break;
            postIfDue();
            await nextTick();
        }
        moves = post(false);

        if (gpuState === "on") {
            await gpuRound(moves.length, 512, seedBase, isStale);
            seedBase += 512;
            if (isStale()) return;
            moves = post(false);
        }
    }

    // 4. continuous investigation — runs until the position changes or every
    // move's score is PROVEN optimal; scores can only improve over time
    const ladder = createExactLadder(isStale);
    for (let s = 1; ; s++) {
        if (isStale()) return;

        if (moves.length > 0 && moves.every((m) => m.exact)) {
            post(true); // the position is fully understood — nothing left to compute
            return;
        }

        // exact-proof ladder: one bounded slice per cycle, best-ranked first
        if (await ladder.advance(moves)) {
            moves = post(false);
            continue; // re-rank before spending beam time
        }
        if (isStale()) return;

        // diversified beam pass; the noise seed makes every pass explore a
        // different corridor, the width cycle periodically goes full depth
        const width = s % DEEP_FULL_EVERY === 0 ? 4096 : DEEP_WIDTHS[s % DEEP_WIDTHS.length];
        eng.beamBegin(width, s);
        for (;;) {
            if (isStale()) return;
            if (eng.beamStep(CHUNK) === 1) break;
            postIfDue();
            await nextTick();
        }
        moves = post(false);

        // playout refinement, biased to the moves the player actually sees
        if (s % 2 === 0) {
            if (gpuState === "on") {
                await gpuRound(moves.length, 1024, seedBase, isStale);
                seedBase += 1024;
            } else {
                seedBase = await cpuPlayoutRound(moves, seedBase, isStale);
            }
            if (isStale()) return;
            moves = post(false);
        }
    }
}

// CPU playout round with rank bias: the displayed top moves get most samples
async function cpuPlayoutRound(moves, seedBase, isStale) {
    for (let rank = 0; rank < moves.length; rank++) {
        if (isStale()) return seedBase;
        const n = rank < 8 ? 48 : 8;
        eng.playoutRoot(moves[rank].k, n, seedBase);
        seedBase += n;
        if (rank % 6 === 5) await nextTick();
    }
    return seedBase;
}

// exact-proof ladder: once the board is small enough, solve each root move's
// child position to optimality, best-ranked moves first, with escalating
// budgets; a proof both hardens the score (✓ in the UI) and often improves it
function createExactLadder(isStale) {
    const exhausted = new Map(); // cell -> largest budget already tried
    let active = null;           // { k, cell, budget }

    return {
        // runs a bounded slice; true if a proof finished (rankings may change)
        async advance(moves) {
            if (moves.length === 0 || eng.getRemaining() > EXACT_REMAINING) return false;

            if (!active) {
                const next = moves.find((m) => !m.exact &&
                    (exhausted.get(m.cell) ?? 0) < EXACT_MAX_BUDGET);
                if (!next) return false; // everything proven or out of budget

                const budget = Math.min(EXACT_MAX_BUDGET, (exhausted.get(next.cell) ?? EXACT_BUDGET / 4) * 4);
                eng.exactBeginChild(next.k, budget);
                active = { k: next.k, cell: next.cell, budget };
            }

            // up to ~8 chunks per cycle, then hand control back to the beams
            for (let c = 0; c < 8; c++) {
                if (isStale()) return false;
                const result = eng.exactStep(EXACT_CHUNK);
                if (result === -1) {
                    await nextTick();
                    continue;
                }
                if (result === -2) {
                    exhausted.set(active.cell, active.budget); // retry later, ×4 budget
                } else {
                    eng.exactMergeChild(active.k);
                }
                active = null;
                return result !== -2;
            }
            return false; // proof still running — resume next cycle
        },
    };
}

// one GPU playout round over all root children; falls back permanently on the
// first verification mismatch (results are only merged after a CPU replay)
async function gpuRound(rootCount, playouts, seedBase, isStale) {
    if (!gpu || rootCount === 0) return;

    const boards = [];
    const tabu = [];
    for (let k = 0; k < rootCount; k++) {
        eng.childToIO(k);
        const child = mem().slice(IO, IO + 144);
        boards.push(child);
        tabu.push(dominantColor(child));
    }

    let results;
    try {
        results = await gpu.runBatch(boards, tabu, playouts, seedBase);
    } catch (error) {
        gpuState = "failed";
        gpu = null;
        return;
    }
    if (isStale()) return;

    for (let k = 0; k < rootCount; k++) {
        const { final, seedIdx } = results[k];
        if (final >= 145) continue; // no playout wrote a result
        if (eng.playoutVerify(k, seedBase + seedIdx, final) === 0) {
            // GPU and CPU disagree on a deterministic playout — GPU results
            // cannot be trusted on this device, disable them for good
            gpuState = "failed";
            gpu = null;
            return;
        }
    }
}

// --- GPU bring-up: run once, cross-check against the CPU twin -----------------

async function initGpu() {
    try {
        gpu = await createGpu();
    } catch (error) {
        gpu = null;
        gpuState = "failed";
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
        gpu = null;
        gpuState = "failed";
    }
}

// --- main loop -----------------------------------------------------------------

async function main() {
    const wasmURL = new URL("./engine.wasm", import.meta.url);
    const bytes = await (await fetch(wasmURL)).arrayBuffer();
    const { instance } = await WebAssembly.instantiate(bytes, {
        env: { abort: () => { throw new Error("wasm abort"); } },
    });
    eng = instance.exports;
    IO = eng.ioPtr();

    await initGpu();
    self.postMessage({ type: "ready", gpu: gpuState });

    let doneVersion = 0;
    for (;;) {
        if (!job || doneVersion === jobVersion) {
            await new Promise((resolve) => { kickWaiter = resolve; });
            continue;
        }
        doneVersion = jobVersion;
        await analyze(job, () => jobVersion !== doneVersion);
    }
}

main().catch((error) => {
    self.postMessage({ type: "error", message: String(error?.stack ?? error) });
});
