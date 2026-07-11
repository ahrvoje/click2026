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
 *   4. continuous investigation    — alternating global beam passes (widths
 *      cycling 512..4096) and root-locked passes that deepen one displayed
 *      move at a time, plus playout rounds biased to the current top moves
 *      (GPU-accelerated when WebGPU is available), interleaved with an
 *      exact-proof ladder that solves each root move's child position once
 *      the board is small enough
 *
 * Analysis ends in exactly three ways: a new position arrives, EVERY move is
 * proven optimal ("proven"), or nothing has improved for SETTLE_PASSES
 * passes even at the top of the width ladder on a board too large to
 * enumerate ("settled") — never by an arbitrary timer. Stagnation first
 * escalates width (deeper, provably fresh exploration), then stops honestly.
 * Bigger-group hopefuls — moves with larger groups than the current best
 * that might match its score — get first claim on locked passes, playouts
 * and proofs, because equal outcomes with bigger groups are faster to play.
 *
 * Knowledge survives moves: every posted result is cached by board key, and
 * a new analysis is seeded with the cached lines of its own position plus
 * the line suffixes of the previous position (replay-validated in WASM), so
 * playing a suggested move never makes the engine forget the line it showed.
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
const EXACT_REMAINING = 56;     // full-speed exact proving at or below this many cells
const EXACT_TRY_REMAINING = 88; // above 56 up to here: proving trickles at 1 chunk/cycle
const EXACT_BUDGET = 8000000;   // first proof attempt per move; escalates ×4, uncapped
const LINE_BUDGET = 64000000;   // line seek is bound-directed, rarely needs much
const WIDEN_WIDTHS = [8, 32, 128, 512, 2048];
const WIDTH_TIERS = [512, 1024, 2048, 4096, 8192, 16384]; // stagnation climbs this ladder
const LOCKED_WIDTH = 2048;      // width of root-locked passes deepening one top move
const TOP_RANKS = 5;            // moves shown in the UI — get the focused compute
const SETTLE_PASSES = 24;       // fruitless passes at max width before a settled stop
const CACHE_MAX = 64;           // remembered positions for warm starts
const POST_INTERVAL_MS = 150;

let eng = null;
let IO = 0;
let gpu = null;
let gpuState = "off";           // "off" | "on" | "failed"

let job = null;
let jobVersion = 0;
let kickWaiter = null;

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
    const key = myJob.board.join(",");

    mem().set(myJob.board, IO);
    eng.setBoard();
    seedFromMemory(key);

    const post = (settled) => {
        const { moves, nodes, depth, width, remaining } = collectResults();

        // remember this position for warm starts (LRU refresh on re-insert)
        resultCache.delete(key);
        resultCache.set(key, moves);
        if (resultCache.size > CACHE_MAX) {
            resultCache.delete(resultCache.keys().next().value);
        }
        prevAnalysis = { key, moves };

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
                // "proven": every move optimal; "settled": stagnant at max
                // width on a board too large to enumerate
                state: settled !== true ? "analyzing"
                    : moves.length > 0 && moves.every((m) => m.exact) ? "proven" : "settled",
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

    // 4. continuous investigation — runs until the position changes, every
    // move is PROVEN optimal, or nothing new has been found despite climbing
    // the whole width ladder (settled stop); scores only improve over time
    const ladder = createExactLadder(isStale);
    let lastSig = "";
    let fruitless = 0;
    for (let s = 1; ; s++) {
        if (isStale()) return;

        if (moves.length > 0 && moves.every((m) => m.exact)) {
            post(true); // proven: the position is fully understood
            return;
        }

        // exact-proof ladder: one bounded slice per cycle, hopefuls first
        if (await ladder.advance(moves)) {
            moves = post(false);
            continue; // re-rank before spending beam time
        }
        if (isStale()) return;

        // stagnation climbs the width ladder: the longer nothing improves,
        // the wider (deeper) the global passes get before giving up
        const tier = Math.min(WIDTH_TIERS.length - 1, Math.floor(fruitless / 4));

        // odd passes lock the whole beam onto one candidate: bigger-group
        // hopefuls first (can a larger group match the best score?), then the
        // unproven displayed moves; even passes search globally, and the noise
        // seed makes every pass explore a different corridor
        const locked = s % 2 === 1 ? lockCandidates(moves) : [];
        if (locked.length > 0) {
            eng.beamBeginRoot(locked[(s >> 1) % locked.length].k, LOCKED_WIDTH, s);
        } else {
            eng.beamBegin(WIDTH_TIERS[tier], s);
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
            if (gpuState === "on") {
                await gpuRound(moves.length, 1024, seedBase, isStale);
                seedBase += 1024;
            } else {
                seedBase = await cpuPlayoutRound(moves, seedBase, isStale);
            }
            if (isStale()) return;
            moves = post(false);
        }

        // full-signature progress detector: any score or proof change counts
        const sig = moves.map((m) => `${m.cell}:${m.score}:${m.exact ? 1 : 0}`).join("|");
        if (sig !== lastSig) {
            lastSig = sig;
            fruitless = 0;
        } else {
            fruitless++;
        }

        // settled stop: nothing new despite max-width diversified passes, and
        // the board is too large to enumerate — below the proving gate the
        // engine never stops early, proofs always land eventually
        if (fruitless >= SETTLE_PASSES && tier === WIDTH_TIERS.length - 1 &&
            eng.getRemaining() > EXACT_REMAINING) {
            post(true);
            return;
        }
    }
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

// root-locked pass targets: bigger-group hopefuls first, then unproven top 5
function lockCandidates(moves) {
    const hopefuls = biggerHopefuls(moves);
    const seen = new Set(hopefuls.map((m) => m.cell));
    const top = moves.slice(0, TOP_RANKS).filter((m) => !m.exact && !seen.has(m.cell));
    return [...hopefuls, ...top];
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
            if (m.line.length > 1) seeds.push({ line: m.line.slice(1) });
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
        const n = rank < 8 || priority.has(moves[rank].cell) ? 48 : 8;
        eng.playoutRoot(moves[rank].k, n, seedBase);
        seedBase += n;
        if (rank % 6 === 5) await nextTick();
    }
    return seedBase;
}

// exact-proof ladder: once the board is small enough, prove each root move,
// best-ranked first. Values come from the memoized value solver (vsBegin /
// vsStep) — a full enumeration whose memo is SHARED across the moves of one
// position and across budget retries, so sibling proofs cost little more
// than the first one and no board state is ever analysed twice. When a
// proven value beats the known line, a bound-directed seek recovers the
// optimal line (keeping every displayed score replayable).
function createExactLadder(isStale) {
    const exhausted = new Map(); // cell -> last value-solve budget tried
    let active = null;           // { k, cell, mode: "value" | "line", budget, target }

    return {
        // runs a bounded slice; true if a proof finished (rankings may change)
        async advance(moves) {
            const remaining = eng.getRemaining();
            if (moves.length === 0 || remaining > EXACT_TRY_REMAINING) return false;

            // full speed below the gate, a background trickle above it —
            // the memo keeps every explored state either way
            const slices = remaining <= EXACT_REMAINING ? 8 : 1;

            if (!active) {
                // hopefuls first: proving a bigger group's value directly
                // answers "can I click the big one instead?"
                const next = biggerHopefuls(moves)[0] ?? moves.find((m) => !m.exact);
                if (!next) return false; // everything proven

                // budgets escalate ×4 without a cap: the space is finite, the
                // search preemptible, and the memo keeps all completed work,
                // so a retry resumes instead of starting over
                const budget = (exhausted.get(next.cell) ?? EXACT_BUDGET / 4) * 4;
                active = { k: next.k, cell: next.cell, mode: "value", budget, target: -1 };

                const immediate = eng.vsBegin(next.k, budget);
                if (immediate === -3) { active = null; return false; }
                if (immediate >= 0) return this.finishValue(immediate);
            }

            // a bounded number of chunks per cycle, then back to the beams
            for (let c = 0; c < slices; c++) {
                if (isStale()) return false;
                const r = active.mode === "value" ? eng.vsStep(EXACT_CHUNK) : eng.exactStep(EXACT_CHUNK);
                if (r === -1) {
                    await nextTick();
                    continue;
                }

                if (active.mode === "value") {
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
                exhausted.set(active.cell, active.budget); // seek trouble — retry later
                active = null;
                return false;
            }
            return false; // still running — resume next cycle
        },

        // a proven value arrived: flag it directly when the known line already
        // achieves it, otherwise seek the improving line
        finishValue(value) {
            if (eng.seedExactByCell(active.cell, value) === 1) {
                active = null;
                return true;
            }
            eng.exactChildSeek(active.k, LINE_BUDGET, value);
            active.mode = "line";
            active.target = value;
            return false;
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
