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
 *   2. CPU playout portfolio       — strong tabu policy plus full-support samples
 *   3. widening beam passes        — deterministic, widths 8..2048
 *      with one bounded permanent-only late-game portfolio member
 *   4. position-proof portfolio    — bounded, fair B&B probes above the
 *      persistent exact gate
 *   5. continuous investigation    — alternating global beam passes (widths
 *      512..16384) and root-locked passes that widen independently per move,
 *      plus playout rounds biased to the current top moves
 *      (GPU-accelerated when WebGPU is available); once the board is small
 *      enough, a hybrid B&B/value-memo ladder takes priority until every
 *      move is proved
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
 * Date: Sun Jul 12, 2026
 */

// These query revisions must match ENGINE_ASSET_VERSION in engine-ui.js.
// Versioning the complete module graph prevents a cached pre-change helper
// from making the worker fail during static module linking.
import { createGpu, dominantColor } from "./gpu.js?build=20260712-proof2";
import {
    analysisState, createSearchProgress, positionProofCandidates,
    recordSearchPass, settlementReady, summarizePositionProof,
} from "./schedule.js?build=20260712-proof2";

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
const LINE_BUDGET = 64000000;   // initial memo-guided line seek; rare retries escalate ×4
const WIDEN_WIDTHS = [8, 32, 128, 512, 2048];
const WIDTH_TIERS = [512, 1024, 2048, 4096, 8192, 16384]; // stagnation climbs this ladder
const LOCKED_WIDTHS = [2048, 4096, 8192, 16384]; // each root gets private iterative widening
const SOFT_PLAYOUT_DIVISOR = 8; // supplement hard tabu without replacing its samples
const TOP_RANKS = 5;            // moves shown in the UI — get the focused compute
const SETTLE_PASSES = 24;       // unchanged max-width global passes before settlement
const CACHE_MAX = 64;           // remembered positions for warm starts
const POST_INTERVAL_MS = 150;

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
        const proof = summarizePositionProof(moves, (move) => move.lower);

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
    if (moves.every((m) => m.exact)) { post(true); return; }

    let seedBase = 1;
    const launchGpu = (snapshot, samples, seed) => {
        if (pendingGpu !== null || gpuState !== "on") return false;
        let pending;
        pending = gpuRound(snapshot, samples, seed, isStale)
            .catch(() => disableGpu())
            .finally(() => {
                if (pendingGpu === pending) pendingGpu = null;
            });
        pendingGpu = pending;
        return true;
    };
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

    // 2. quick CPU playout round: 32 playouts per root move
    for (let k = 0; k < moves.length; k++) {
        if (isStale()) return;
        if (moves.find((m) => m.k === k)?.exact) continue;
        eng.playoutRoot(k, 32, seedBase);
        eng.playoutRootSoft(k, 32 / SOFT_PLAYOUT_DIVISOR, seedBase);
        seedBase += 32;
        if (k % 8 === 7) {
            postIfDue();
            await nextTick();
        }
    }
    moves = post(false);
    if (moves.every((m) => m.exact)) { post(true); return; }

    // 3. deterministic widening beam passes — always the full ladder, even
    // when a clear shows up early: the other top moves still need refining
    for (const width of WIDEN_WIDTHS) {
        // GPU playout state is independent once submitted. Let it run while
        // the CPU expands the beam instead of idling through map/readback.
        const gpuLaunched = launchGpu(moves, 512, seedBase);
        if (gpuLaunched) seedBase += 512;
        eng.beamBegin(width, 0);
        for (;;) {
            // The submitted batch owns only GPU buffers now. A stale job can
            // return immediately; the next job uses the CPU until it clears.
            if (isStale()) return;
            if (eng.beamStep(CHUNK) === 1) break;
            postIfDue();
            await nextTick();
        }
        if (gpuLaunched) await drainGpu();
        if (isStale()) return;
        moves = post(false);
        if (moves.every((m) => m.exact)) { post(true); return; }

        // Every normal beam shares the tuned fragmentation heuristic. Near
        // the end, add a bounded orthogonal member before the widest default
        // pass: it keeps only progress + proved-permanent penalties, rescuing
        // solutions that must look temporarily fragmented for a move or two.
        if (width === 512 && eng.getRemaining() <= CLEAR_PORTFOLIO_REMAINING &&
            moves[0].score <= CLEAR_PORTFOLIO_SCORE) {
            const candidates = moves.filter((m) => !m.exact &&
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
                if (moves.every((m) => m.exact)) break;
            }
            if (moves.every((m) => m.exact)) { post(true); return; }
        }
    }

    // Full value enumeration is intentionally gated on compact endgames. On
    // larger boards, give the 16 most promising roots that can still beat the
    // incumbent one fair, bounded B&B turn instead. Easy constructive winners
    // can certify the position without being starved behind a hard positive
    // root; a budget miss is discarded as a proof but any terminal witness survives.
    if (eng.getRemaining() > EXACT_TRY_REMAINING) {
        moves = await runPositionProofPortfolio(moves, isStale, post, postIfDue);
        if (isStale()) return;
        if (moves.every((m) => m.exact)) { post(true); return; }
    }

    // 5. continuous investigation — runs until the position changes, every
    // move is PROVEN optimal, or nothing new has been found despite climbing
    // the whole width ladder (settled stop); scores only improve over time
    const ladder = createExactLadder(isStale);
    let progress = createSearchProgress(
        moves.map((m) => `${m.cell}:${m.score}:${m.exact ? 1 : 0}`).join("|"),
        moves[0].score);
    let globalSeed = 1;
    const lockedAttempts = new Map(); // cell -> private passes already run
    const lockedMaxWidths = new Map(); // cell -> widest private pass already run
    for (let s = 1; ; s++) {
        if (isStale()) return;

        if (moves.length > 0 && moves.every((m) => m.exact)) {
            post(true); // proven: the position is fully understood
            return;
        }

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

        // odd passes lock the whole beam onto one candidate: bigger-group
        // hopefuls first (can a larger group match the best score?), then the
        // unproven displayed moves; even passes search globally, and the noise
        // seed makes every pass explore a different corridor
        let lockedMove = null;
        if (s % 2 === 1) {
            const preferred = lockCandidates(moves);
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
        const gpuLaunched = s % 2 === 0 && launchGpu(moves, 1024, playoutSeed);
        if (gpuLaunched) seedBase += 1024;
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
            eng.beamBegin(globalWidth, globalSeed++);
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
            if (gpuLaunched) {
                await cpuSoftPlayoutRound(moves, playoutSeed, isStale);
                if (isStale()) return;
                await drainGpu();
            } else {
                seedBase = await cpuPlayoutRound(moves, seedBase, isStale);
            }
            if (isStale()) return;
            moves = post(false);
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
        if (settlementReady(progress, SETTLE_PASSES, eng.getRemaining(),
            EXACT_REMAINING, uncoveredPrivate)) {
            post(true);
            return;
        }
    }
}

// Above the full-enumeration gate, sequential unbounded proof work is a
// starvation trap: a single hard no-clear root can hide easy winning siblings
// indefinitely. Probe the most promising threatening roots once, in tight-
// bound order, yielding between exact chunks. The board-wide cap prevents a
// no-proof opening from delaying ordinary search; its max-width fairness audit
// still covers the remaining roots. Stop as soon as the position bounds meet.
async function runPositionProofPortfolio(moves, isStale, post, postIfDue) {
    const candidates = positionProofCandidates(moves, (move) => move.lower)
        .slice(0, POSITION_PROBE_ROOTS);
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
// top-five moves. A separate max-tier audit below guarantees tail fairness.
function lockCandidates(moves) {
    const hopefuls = biggerHopefuls(moves);
    const seen = new Set(hopefuls.map((m) => m.cell));
    const top = moves.slice(0, TOP_RANKS).filter((m) => !m.exact && !seen.has(m.cell));
    return [...hopefuls, ...top];
}

function uncoveredPrivateCandidates(moves, maxWidths) {
    if (moves.length === 0) return [];
    const incumbent = moves[0].score;
    const maxWidth = LOCKED_WIDTHS[LOCKED_WIDTHS.length - 1];
    return moves.filter((m) => {
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
            if (m.line.length > 1) seeds.push({ line: m.line.slice(1) });
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
        if (moves[rank].exact) continue;
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
        if (moves[rank].exact) continue;
        const n = rank < 8 || priority.has(moves[rank].cell) ? 8 : 2;
        eng.playoutRootSoft(moves[rank].k, n, seedBase);
        if (rank % 6 === 5) await nextTick();
    }
}

// Exact-proof ladder: compact endgames try incumbent-driven branch and bound
// first; larger proving-gate positions start the persistent value memo
// directly. The memo is shared across roots, retries and later analysis
// positions. Improving terminals are retained as durable lines inside WASM;
// a memo-guided witness DFS repairs any remaining policy-cache gap.
function createExactLadder(isStale) {
    const exhausted = new Map(); // cell -> last value-solve budget tried
    const lineExhausted = new Map(); // cell -> last guided witness budget tried
    const boundTried = new Set();
    let active = null; // { k, cell, mode: "bound" | "value" | "line", budget, target }

    return {
        shouldPrioritize(moves) {
            return moves.some((move) => !move.exact) && eng.getRemaining() <= EXACT_TRY_REMAINING;
        },

        // runs a bounded slice; true if a proof finished (rankings may change)
        async advance(moves) {
            const remaining = eng.getRemaining();
            if (moves.length === 0 || remaining > EXACT_TRY_REMAINING) return false;

            // Full speed below the gate; a meaningful half-sized quantum
            // above it. One chunk per cycle let beam work reach settlement
            // while a much cheaper exact result was still starved.
            const slices = remaining <= EXACT_REMAINING ? 8 : 4;

            // A beam/playout may have reached the root lower bound while a
            // proof was sliced across cycles. Do not keep solving a row that
            // has become exact in the meantime.
            if (active && moves.find((m) => m.cell === active.cell)?.exact) active = null;

            if (!active) {
                // Prove the broadest child first (smallest removed root
                // group). Its exact traversal reaches the most shared
                // descendants and warms the persistent value memo for the
                // narrower siblings; score order is only the tie-breaker.
                // On the hard corpus this changes all-root completion from
                // repeated table-thrashing traversals into one broad solve
                // followed by mostly memo-backed proofs.
                const next = moves.filter((m) => !m.exact)
                    .sort((a, b) => a.size - b.size || a.score - b.score || a.cell - b.cell)[0];
                if (!next) return false; // everything proven

                if (remaining <= BOUND_TRY_REMAINING && !boundTried.has(next.cell)) {
                    boundTried.add(next.cell);
                    active = { k: next.k, cell: next.cell, mode: "bound",
                        budget: BOUND_BUDGET, target: -1 };
                    eng.exactBeginChild(next.k, BOUND_BUDGET);
                } else {
                    const started = this.startValue(next);
                    if (started !== null) return started;
                }
            }

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
            active = { k: move.k, cell: move.cell, mode: "value", budget, target: -1 };
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
    const wasmURL = new URL("./engine.wasm", import.meta.url);
    wasmURL.searchParams.set("build", "20260712-proof2");
    const response = await fetch(wasmURL, { cache: "no-store" });
    if (!response.ok) throw new Error(`engine.wasm HTTP ${response.status} ${response.statusText}`);
    const bytes = await response.arrayBuffer();
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
        const analysisVersion = jobVersion;
        const analysisJob = job;
        doneVersion = analysisVersion;
        await analyze(analysisJob, () => jobVersion !== analysisVersion);
    }
}

main().catch((error) => {
    self.postMessage({ type: "error", message: String(error?.stack ?? error) });
});
