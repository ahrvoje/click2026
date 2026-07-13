/**
 * Click2026 — engine test suite (Node).
 *
 * Proves the WASM engine equivalent to the reference rules in
 * src/scripts/board.js and validates search results by replaying every
 * claimed line through the JS rules:
 *
 *   1. rule equivalence on random boards (groups, moves, enumeration order)
 *   2. full random playthroughs staying bit-identical in both implementations
 *   3. beam search: every root score must replay to its claimed final
 *   4. playout determinism (fixed seed -> fixed line -> fixed final)
 *   5. exact solver vs brute force on small boards
 *   6. example games from click.js analyzed end to end
 *
 * Run: npm run test:engine
 *
 * Copyright 2014-2026, Hrvoje Abraham ahrvoje@gmail.com
 * Released under the MIT license.
 */

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const assetSourcePaths = {
    index: "src/index.html",
    main: "src/scripts/main.js",
    click: "src/scripts/click.js",
    ui: "src/scripts/engine-ui.js",
    worker: "src/scripts/engine/worker.js",
    e2e: "tools/engine.e2e.mjs",
};
const assetSources = Object.fromEntries(await Promise.all(
    Object.entries(assetSourcePaths).map(async ([name, path]) =>
        [name, await readFile(join(root, path), "utf8")])),
);

const { SIZE, clonePosition, extractGroup, removeGroup, enumerateGroups } =
    await import("../src/scripts/board.js");
const { Game } = await import("../src/scripts/game.js");
const {
    createSearchProgress,
    recordSearchPass,
    settlementReady,
    summarizePositionProof,
    analysisState,
    positionProofCandidates,
} =
    await import("../src/scripts/engine/schedule.js");

// --- wasm setup -------------------------------------------------------------

const wasmBytes = await readFile(join(root, "src/scripts/engine/engine.wasm"));
const { instance } = await WebAssembly.instantiate(wasmBytes, {
    env: { abort: () => { throw new Error("wasm abort"); } },
});
const eng = instance.exports;
const IO = eng.ioPtr();

const mem = () => new Uint8Array(eng.memory.buffer);
const memU32 = () => new Uint32Array(eng.memory.buffer);
const memI32 = () => new Int32Array(eng.memory.buffer);

// --- helpers ----------------------------------------------------------------

// deterministic RNG for reproducible tests
function mulberry32(seed) {
    return () => {
        seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
        let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

const cellOf = ([x, y]) => x * SIZE + y;
const fieldOf = (cell) => [Math.floor(cell / SIZE), cell % SIZE];

function positionToBytes(position) {
    const bytes = new Uint8Array(144);
    for (let i = 0; i < SIZE; i++) {
        for (let j = 0; j < SIZE; j++) {
            bytes[i * SIZE + j] = position[i]?.[j] ?? 0;
        }
    }
    return bytes;
}

function bytesToPosition(bytes) {
    return Array.from({ length: SIZE }, (_, i) =>
        Array.from({ length: SIZE }, (_, j) => bytes[i * SIZE + j]));
}

function randomPosition(rnd) {
    return Array.from({ length: SIZE }, () =>
        Array.from({ length: SIZE }, () => Math.floor(rnd() * 5) + 1));
}

// plays `steps` random legal moves on a copy, returns the resulting position
function randomlyPlayed(position, rnd, steps) {
    const pos = clonePosition(position);
    for (let s = 0; s < steps; s++) {
        const groups = enumerateGroups(pos);
        if (groups.length === 0) break;
        const group = groups[Math.floor(rnd() * groups.length)];
        removeGroup(pos, group.cells);
    }
    return pos;
}

function setIOBoard(position) {
    mem().set(positionToBytes(position), IO);
}

function readIOBoard() {
    return bytesToPosition(mem().slice(IO, IO + 144));
}

const remainingOf = (position) =>
    position.flat().reduce((n, v) => n + (v > 0 ? 1 : 0), 0);

// replays a move line (cell indices) through the JS rules; returns final
// remaining, or -1 if any move is illegal
function replayLine(position, line) {
    const pos = clonePosition(position);
    for (const cell of line) {
        const group = extractGroup(pos, fieldOf(cell));
        if (group.length < 2) return -1;
        removeGroup(pos, group);
    }
    return remainingOf(pos);
}

// parses a collect() snapshot from wasm IO — layout documented in asm/engine.ts
function collectResults() {
    const len = eng.collect();
    const bytes = mem().slice(IO, IO + len);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

    const rootCount = view.getUint32(0, true);
    const stats = {
        nodes: view.getUint32(4, true) + view.getUint32(8, true) * 2 ** 32,
        depth: view.getUint32(12, true),
        width: view.getUint32(16, true),
        remaining: view.getUint32(20, true),
    };

    const roots = [];
    let at = 24;
    for (let k = 0; k < rootCount; k++) {
        roots.push({
            rep: bytes[at], color: bytes[at + 1], size: bytes[at + 2],
            exact: bytes[at + 3] !== 0, best: view.getInt32(at + 4, true),
        });
        at += 8;
    }
    for (let k = 0; k < rootCount; k++) {
        const n = bytes[at++];
        roots[k].cells = Array.from(bytes.slice(at, at + n));
        at += n;
    }
    for (let k = 0; k < rootCount; k++) {
        const n = bytes[at++];
        roots[k].line = Array.from(bytes.slice(at, at + n));
        at += n;
    }

    return { stats, roots };
}

// --- test runner ------------------------------------------------------------

let failures = 0;

function check(ok, title, detail) {
    if (!ok) {
        failures++;
        console.error(`FAIL  ${title}`);
        if (detail !== undefined) console.error("      " + JSON.stringify(detail));
    }
}

function suite(name, fn) {
    const before = failures;
    const t0 = performance.now();
    fn();
    const dt = (performance.now() - t0).toFixed(0);
    console.log(`${failures === before ? "ok  " : "FAIL"}  ${name} (${dt} ms)`);
}

// --- 1 + 2: rule equivalence ------------------------------------------------

suite("rule equivalence on random boards", () => {
    const rnd = mulberry32(20260711);

    for (let iter = 0; iter < 400; iter++) {
        const depth = Math.floor(rnd() * 30);
        const position = randomlyPlayed(randomPosition(rnd), rnd, depth);

        // group extraction at every cell
        setIOBoard(position);
        for (let probe = 0; probe < 10; probe++) {
            const cell = Math.floor(rnd() * 144);
            const jsGroup = extractGroup(position, fieldOf(cell)).map(cellOf).sort((a, b) => a - b);
            const n = eng.testGroup(cell);
            const wasmGroup = Array.from(mem().slice(IO + 256, IO + 256 + n)).sort((a, b) => a - b);
            check(JSON.stringify(jsGroup) === JSON.stringify(wasmGroup),
                "extractGroup mismatch", { iter, cell, jsGroup, wasmGroup });
        }

        // enumeration: same groups, same order, same reps
        setIOBoard(position);
        const jsGroups = enumerateGroups(position);
        const n = eng.testEnumerate();
        check(n === jsGroups.length, "enumerate count mismatch", { iter, n, js: jsGroups.length });
        for (let g = 0; g < Math.min(n, jsGroups.length); g++) {
            const rep = mem()[IO + 256 + g];
            const size = mem()[IO + 512 + g];
            check(rep === cellOf(jsGroups[g].rep) && size === jsGroups[g].cells.length,
                "enumerate group mismatch", { iter, g, rep, jsRep: cellOf(jsGroups[g].rep) });
        }

        // full playthrough with random moves, boards compared after every move
        const pos = clonePosition(position);
        setIOBoard(pos);
        for (;;) {
            const groups = enumerateGroups(pos);
            if (groups.length === 0) break;
            const group = groups[Math.floor(rnd() * groups.length)];
            const clicked = group.cells[Math.floor(rnd() * group.cells.length)];

            removeGroup(pos, extractGroup(pos, clicked));
            const removed = eng.testApply(cellOf(clicked));

            check(removed === group.cells.length, "removed size mismatch", { iter, removed });
            check(JSON.stringify(readIOBoard()) === JSON.stringify(pos),
                "board mismatch after move", { iter, clicked });
        }
    }
});

// --- 3: beam search achievability --------------------------------------------

suite("beam search: every score replays to its claimed final", () => {
    const rnd = mulberry32(77);

    for (let iter = 0; iter < 12; iter++) {
        const position = randomlyPlayed(randomPosition(rnd), rnd, Math.floor(rnd() * 20));
        setIOBoard(position);
        const rootCount = eng.setBoard();

        const jsGroups = enumerateGroups(position);
        check(rootCount === jsGroups.length, "root count mismatch", { iter, rootCount });

        for (const width of [8, 32, 128]) {
            eng.beamBegin(width, 0);
            while (eng.beamStep(50000) === 0) { /* run pass to completion */ }
        }
        eng.beamBegin(256, 12345); // one stochastic pass
        while (eng.beamStep(50000) === 0) { /* run */ }

        const { roots, stats } = collectResults();
        check(stats.remaining === remainingOf(position), "remaining mismatch", { iter });

        for (const r of roots) {
            check(r.best < 1e9 && r.line.length > 0, "root without result", { iter, r });
            check(r.line[0] === r.rep, "line does not start with the root move", { iter, r });
            const replayed = replayLine(position, r.line);
            check(replayed === r.best, "score does not replay", { iter, rep: r.rep, best: r.best, replayed });

            const jsGroup = extractGroup(position, fieldOf(r.rep));
            check(r.size === jsGroup.length && r.color === position[fieldOf(r.rep)[0]][fieldOf(r.rep)[1]],
                "root group metadata mismatch", { iter, r });
            check(JSON.stringify([...r.cells].sort((a, b) => a - b)) ===
                JSON.stringify(jsGroup.map(cellOf).sort((a, b) => a - b)),
                "root group cells mismatch", { iter, rep: r.rep });
        }
    }
});

// --- 4: playouts -------------------------------------------------------------

suite("playouts: deterministic, legal, lines replay", () => {
    const rnd = mulberry32(4242);

    for (let iter = 0; iter < 30; iter++) {
        const position = randomlyPlayed(randomPosition(rnd), rnd, Math.floor(rnd() * 25));
        const seed = Math.floor(rnd() * 2 ** 31) + 1;

        setIOBoard(position);
        const final1 = eng.testPlayout(seed);
        const len1 = mem()[IO + 256];
        const line1 = Array.from(mem().slice(IO + 257, IO + 257 + len1));

        setIOBoard(position);
        const final2 = eng.testPlayout(seed);
        const len2 = mem()[IO + 256];
        const line2 = Array.from(mem().slice(IO + 257, IO + 257 + len2));

        check(final1 === final2 && JSON.stringify(line1) === JSON.stringify(line2),
            "playout not deterministic", { iter, seed });
        check(replayLine(position, line1) === final1,
            "playout line does not replay", { iter, seed, final1 });
    }

    // playoutRoot must only ever improve scores, with replayable lines
    const position = randomPosition(mulberry32(99));
    setIOBoard(position);
    eng.setBoard();
    const before = collectResults().roots.map((r) => r.best);
    for (let k = 0; k < before.length; k++) eng.playoutRoot(k, 24, 1000 + 100 * k);
    const after = collectResults().roots;
    after.forEach((r, k) => {
        check(r.best <= before[k], "playoutRoot made a score worse", { k });
        check(replayLine(position, r.line) === r.best, "playoutRoot line broken", { k, best: r.best });
    });

    // The soft portfolio member is supplemental: it must preserve every hard
    // result and any newly adopted line must remain constructive.
    for (let k = 0; k < after.length; k++) eng.playoutRootSoft(k, 8, 5000 + 100 * k);
    const afterSoft = collectResults().roots;
    afterSoft.forEach((r, k) => {
        check(r.best <= after[k].best, "playoutRootSoft made a score worse", { k });
        check(replayLine(position, r.line) === r.best,
            "playoutRootSoft line broken", { k, best: r.best });
    });
});

suite("playouts: tabu is a bias, not a hard action mask", () => {
    const position = Array.from({ length: SIZE }, () => Array(SIZE).fill(0));
    position[0][0] = position[0][1] = 1;
    position[1][0] = position[1][1] = 1; // dominant color, one group of four
    position[2][0] = position[2][1] = 2; // non-tabu alternative

    let sawTabuFirst = false, sawAlternativeFirst = false;
    for (let seed = 1; seed <= 256 && !(sawTabuFirst && sawAlternativeFirst); seed++) {
        setIOBoard(position);
        eng.testPlayoutSoft(seed);
        const len = mem()[IO + 256];
        const first = mem()[IO + 257];
        check(len === 2, "two-group playout has wrong length", { seed, len });
        const color = position[Math.floor(first / SIZE)][first % SIZE];
        if (color === 1) sawTabuFirst = true;
        if (color === 2) sawAlternativeFirst = true;
    }
    check(sawTabuFirst && sawAlternativeFirst,
        "soft tabu did not preserve support for every legal first move",
        { sawTabuFirst, sawAlternativeFirst });
});

// --- 4b: warm starts and root-locked passes ------------------------------------

suite("warm start: lines and proofs transfer across positions", () => {
    const rnd = mulberry32(31337);

    for (let iter = 0; iter < 8; iter++) {
        const position = randomPosition(rnd);
        setIOBoard(position);
        eng.setBoard();
        for (const width of [8, 32, 128]) {
            eng.beamBegin(width, 0);
            while (eng.beamStep(100000) === 0) { /* run */ }
        }
        const best = collectResults().roots.reduce((a, b) => (a.best <= b.best ? a : b));
        if (best.line.length < 2) continue;

        // play the best move in JS, then seed the line suffix into the child
        const child = clonePosition(position);
        removeGroup(child, extractGroup(child, fieldOf(best.line[0])));
        setIOBoard(child);
        eng.setBoard();
        const suffix = best.line.slice(1);
        mem().set(Uint8Array.from(suffix), IO);
        const final = eng.seedLine(suffix.length);
        check(final === best.best, "seeded suffix does not reproduce the score", { iter, final, best: best.best });

        const seeded = collectResults().roots;
        check(Math.min(...seeded.map((r) => r.best)) <= best.best,
            "seeding failed to carry the line", { iter, best: best.best });
        for (const r of seeded) {
            check(replayLine(child, r.line) === r.best, "seeded root line broken", { iter, rep: r.rep });
        }

        // a seed starting on an empty cell must be rejected
        const emptyCell = child.flatMap((col, i) => col.map((v, j) => [v, i * 12 + j]))
            .find(([v]) => v === 0)?.[1];
        if (emptyCell !== undefined) {
            mem().set(Uint8Array.from([emptyCell]), IO);
            check(eng.seedLine(1) === -1, "empty-cell seed accepted", { iter, emptyCell });
        }
    }

    // proof flags survive re-analysis of the same position
    const board = Array.from({ length: 12 }, () => Array(12).fill(0));
    const brnd = mulberry32(999);
    for (let i = 0; i < 5; i++) for (let j = 0; j < 4; j++) board[i][j] = 1 + Math.floor(brnd() * 3);
    setIOBoard(board);
    eng.setBoard();
    eng.exactBeginChild(0, 2_000_000);
    let r = -1;
    while (r === -1) r = eng.exactStep(200_000);
    if (r >= 0) {
        eng.exactMergeChild(0);
        const proven = collectResults().roots[0];
        check(proven.exact && proven.best === r, "child proof did not merge", { r, proven });

        setIOBoard(board);
        eng.setBoard(); // fresh analysis: flags gone
        check(!collectResults().roots[0].exact, "exact flag survived setBoard");

        mem().set(Uint8Array.from(proven.line), IO);
        check(eng.seedLine(proven.line.length) === proven.best, "proof line seed failed");
        check(eng.seedExactByCell(proven.rep, proven.best) === 1, "seedExactByCell rejected");
        const restored = collectResults().roots[0];
        check(restored.exact && restored.best === proven.best, "proof not restored", { restored });
    }
});

suite("intrinsic proofs: terminal and lower-bound scores need no search", () => {
    const board = Array.from({ length: SIZE }, () => Array(SIZE).fill(0));
    board[0][0] = 1;
    board[0][1] = 1;
    board[0][2] = 2; // permanently single after the only legal move

    setIOBoard(board);
    check(eng.setBoard() === 1, "intrinsic proof fixture has wrong root count");
    let { roots, stats } = collectResults();
    check(eng.getRootLower(0) === 1, "exported root lower bound is wrong", {
        lower: eng.getRootLower(0),
    });
    check(roots[0].best === 1 && roots[0].exact,
        "score matching the singleton-color lower bound was not auto-proven", roots[0]);
    check(replayLine(board, roots[0].line) === 1,
        "auto-proven lower-bound line does not replay", roots[0]);

    // Proven roots are not admitted into later heuristic passes.
    eng.beamBegin(128, 0);
    check(eng.beamStep(1000) === 1, "beam searched an already proven root");
    ({ roots, stats } = collectResults());
    check(stats.nodes === 0, "proven-root beam work changed the node counter", stats);

    board[0][2] = 0;
    setIOBoard(board);
    eng.setBoard();
    roots = collectResults().roots;
    check(eng.getRootLower(0) === 0, "zero fixture has a nonzero root lower bound", {
        lower: eng.getRootLower(0),
    });
    check(roots[0].best === 0 && roots[0].exact,
        "constructive zero score was not auto-proven", roots[0]);
});

suite("permanent separators: fixed-point lower bound is sound", () => {
    const empty = () => Array.from({ length: SIZE }, () => Array(SIZE).fill(0));

    // Horizontal R-B-R: the globally singleton B makes its column permanent,
    // so the two globally unique R partners can never become adjacent.
    const horizontal = empty();
    horizontal[0][0] = 1;
    horizontal[1][0] = 2;
    horizontal[2][0] = 1;
    horizontal[3][0] = horizontal[3][1] = 3;
    horizontal[4][0] = horizontal[4][1] = 4;
    setIOBoard(horizontal);
    check(eng.testLowerBound() === 3, "horizontal RBR lower bound missed", {
        lower: eng.testLowerBound(),
    });
    check(eng.setBoard() === 2, "horizontal RBR fixture has wrong root count");
    let roots = collectResults().roots;
    check(roots.every((_, k) => eng.getRootLower(k) === 3),
        "horizontal RBR root bounds were not strengthened");
    check(roots.every((root) => root.best === 3 && root.exact),
        "horizontal RBR scores were not intrinsically proven", roots);

    // Vertical order inside a column is invariant, so the singleton B also
    // permanently separates the only two R cells above and below it.
    const vertical = empty();
    vertical[0][0] = 1;
    vertical[0][1] = 2;
    vertical[0][2] = 1;
    vertical[1][0] = vertical[1][1] = 3;
    setIOBoard(vertical);
    check(eng.testLowerBound() === 3, "vertical RBR lower bound missed", {
        lower: eng.testLowerBound(),
    });

    // Fixed point: B proves both R cells; their now-permanent columns prove
    // both outer G cells in the following wave.
    const cascade = empty();
    cascade[0][0] = 4;
    cascade[1][0] = 1;
    cascade[2][0] = 2;
    cascade[3][0] = 1;
    cascade[4][0] = 4;
    cascade[5][0] = cascade[5][1] = 3;
    setIOBoard(cascade);
    check(eng.testLowerBound() === 5, "separator fixed point did not cascade", {
        lower: eng.testLowerBound(),
    });

    // A color-disjoint slab with no legal pair is immutable even without a
    // singleton seed. The left 2x2 checkerboard can never interact with the
    // two active one-color slabs on its right.
    const island = empty();
    island[0][0] = 1; island[0][1] = 2;
    island[1][0] = 2; island[1][1] = 1;
    island[2][0] = island[2][1] = 3;
    island[3][0] = island[3][1] = 4;
    setIOBoard(island);
    check(eng.testLowerBound() === 4, "immutable disjoint slab was not proved", {
        lower: eng.testLowerBound(),
    });
    check(eng.setBoard() === 2, "immutable-slab fixture has wrong root count");
    roots = collectResults().roots;
    check(roots.every((root) => root.best === 4 && root.exact),
        "immutable-slab roots were not intrinsically proven", roots);

    // The same slab proof must run for large roots even when no color is a
    // singleton. Every child still has 40 cells, beyond the late-beam gate.
    const largeIsland = empty();
    largeIsland[0][0] = 1; largeIsland[0][1] = 2;
    largeIsland[1][0] = 2; largeIsland[1][1] = 1;
    for (let col = 2; col < SIZE; col++) {
        const color = 3 + (col - 2) % 3;
        for (let row = 0; row < 4; row++) largeIsland[col][row] = color;
    }
    setIOBoard(largeIsland);
    check(eng.setBoard() === 10, "large immutable-slab fixture has wrong root count");
    roots = collectResults().roots;
    check(roots.every((root, k) => root.best === 4 && root.exact && eng.getRootLower(k) === 4),
        "large no-singleton slab roots were not proved at setup", roots);

    // Counterexamples to naive isolation: the separator is removable, so
    // horizontal column closure or vertical fall joins and clears the R pair.
    const closes = empty();
    closes[0][0] = 1;
    closes[1][0] = closes[1][1] = 2;
    closes[2][0] = 1;
    setIOBoard(closes);
    check(eng.testLowerBound() === 0, "removable horizontal separator was treated as permanent");
    eng.setBoard();
    roots = collectResults().roots;
    check(roots.length === 1 && roots[0].best === 0 && roots[0].exact,
        "horizontal mergeable counterexample no longer clears", roots);

    const falls = empty();
    falls[0][0] = 1;
    falls[0][1] = falls[0][2] = 2;
    falls[0][3] = 1;
    setIOBoard(falls);
    check(eng.testLowerBound() === 0, "removable vertical separator was treated as permanent");
    eng.setBoard();
    roots = collectResults().roots;
    check(roots.length === 1 && roots[0].best === 0 && roots[0].exact,
        "vertical mergeable counterexample no longer clears", roots);

    // Exhaust every normalized board up to 3x3 with three colors. A shared
    // brute-force memo covers the entire reachable state family cheaply.
    const columns = [];
    for (let height = 1; height <= 3; height++) {
        const make = (prefix) => {
            if (prefix.length === height) { columns.push(prefix); return; }
            for (let color = 1; color <= 3; color++) make([...prefix, color]);
        };
        make([]);
    }
    const memo = new Map();
    const brute = (position) => {
        let key = "";
        for (let col = 0; col < 3; col++) {
            for (let row = 0; row < 3; row++) key += String.fromCharCode(48 + position[col][row]);
        }
        const cached = memo.get(key);
        if (cached !== undefined) return cached;
        const groups = enumerateGroups(position);
        if (groups.length === 0) {
            const value = remainingOf(position);
            memo.set(key, value);
            return value;
        }
        let value = Infinity;
        for (const group of groups) {
            const child = clonePosition(position);
            removeGroup(child, group.cells);
            value = Math.min(value, brute(child));
        }
        memo.set(key, value);
        return value;
    };

    let checked = 0;
    let violation = null;
    const enumerateBoards = (chosen, width) => {
        if (violation) return;
        if (chosen.length === width) {
            const position = empty();
            for (let col = 0; col < width; col++) {
                for (let row = 0; row < chosen[col].length; row++) position[col][row] = chosen[col][row];
            }
            setIOBoard(position);
            const lower = eng.testLowerBound();
            const optimum = brute(position);
            checked++;
            if (lower > optimum) violation = { chosen, lower, optimum };
            return;
        }
        for (const column of columns) enumerateBoards([...chosen, column], width);
    };
    for (let width = 0; width <= 3; width++) enumerateBoards([], width);
    check(checked === 60_880, "separator exhaustive corpus incomplete", { checked });
    check(violation === null, "separator lower bound exceeded exact optimum", violation);
});

suite("value solver: exact per-move values from one shared enumeration", () => {
    const rnd = mulberry32(60451);

    function bruteForce(position, memo = new Map()) {
        const key = position.flat().join("");
        const seen = memo.get(key);
        if (seen !== undefined) return seen;
        const groups = enumerateGroups(position);
        if (groups.length === 0) {
            const r = remainingOf(position);
            memo.set(key, r);
            return r;
        }
        let best = Infinity;
        for (const group of groups) {
            const pos = clonePosition(position);
            removeGroup(pos, extractGroup(pos, group.rep));
            best = Math.min(best, bruteForce(pos, memo));
        }
        memo.set(key, best);
        return best;
    }

    const runValue = (k, budget) => {
        let r = eng.vsBegin(k, budget);
        while (r === -1) r = eng.vsStep(200_000);
        return r;
    };

    for (let iter = 0; iter < 10; iter++) {
        // small dense boards, brute-force verifiable
        const cols = 4 + Math.floor(rnd() * 2), rows = 3 + Math.floor(rnd() * 2);
        const position = Array.from({ length: SIZE }, () => Array(SIZE).fill(0));
        for (let i = 0; i < cols; i++) {
            for (let j = 0; j < rows; j++) position[i][j] = 1 + Math.floor(rnd() * 3);
        }
        if (enumerateGroups(position).length === 0) continue;

        setIOBoard(position);
        eng.setBoard();
        const roots = collectResults().roots;

        // ladder flow for every move: value -> flag or line-seek -> merge
        for (let k = 0; k < roots.length; k++) {
            const childPos = clonePosition(position);
            removeGroup(childPos, extractGroup(childPos, fieldOf(roots[k].rep)));
            const expected = enumerateGroups(childPos).length === 0
                ? remainingOf(childPos) : bruteForce(childPos);

            const value = runValue(k, 20_000_000);
            check(value === expected, "value solver wrong", { iter, k, value, expected });
            if (value !== expected) continue;

            // A fresh value traversal must preserve its improving terminal
            // directly from the live DFS stack. Exact memo entries are a
            // replaceable cache and cannot be the only copy of the witness.
            if (iter === 0 && k === 0) {
                const witnessed = collectResults().roots[k];
                check(witnessed.best === value && replayLine(position, witnessed.line) === value,
                    "value solver did not retain its terminal witness", { value, witnessed });
            }

            const built = eng.vsBuildLine(k, value);
            check(built === 1, "value memo failed to reconstruct an optimal line",
                { iter, k, value });
            if (built !== 1 && eng.seedExactByCell(roots[k].rep, value) !== 1) {
                eng.exactChildSeek(k, 20_000_000, value);
                let r = -1;
                while (r === -1) r = eng.exactStep(200_000);
                check(r === value, "line seek missed the proven value", { iter, k, r, value });
                if (r === value) eng.exactMergeChild(k);
            }
        }

        const proven = collectResults().roots;
        for (const r of proven) {
            check(r.exact, "move left unproven", { iter, rep: r.rep });
            check(replayLine(position, r.line) === r.best, "proven line does not replay", { iter, rep: r.rep });
        }
    }

    // wasm-vs-wasm consistency on a bigger board: the minimum over per-move
    // values must equal the root optimum of the branch & bound solver
    const big = Array.from({ length: SIZE }, () => Array(SIZE).fill(0));
    const brnd = mulberry32(777);
    for (let i = 0; i < 8; i++) for (let j = 0; j < 4; j++) big[i][j] = 1 + Math.floor(brnd() * 3);
    setIOBoard(big);
    eng.setBoard();
    const rootsBig = collectResults().roots;
    let minValue = Infinity;
    for (let k = 0; k < rootsBig.length; k++) {
        const v = runValue(k, 50_000_000);
        check(v >= 0, "big-board value solve did not finish", { k, v });
        minValue = Math.min(minValue, v);
    }
    eng.exactBegin(50_000_000);
    let r = -1;
    while (r === -1) r = eng.exactStep(400_000);
    if (r >= 0) check(r === minValue, "value solver disagrees with B&B optimum", { r, minValue });
});

suite("max-width pass (w=16384) stays sound", () => {
    const rnd = mulberry32(46368);
    const position = randomlyPlayed(randomPosition(rnd), rnd, 25); // mid-sized board
    setIOBoard(position);
    eng.setBoard();

    eng.beamBegin(16384, 7);
    while (eng.beamStep(400000) === 0) { /* run */ }

    const { roots, stats } = collectResults();
    check(stats.width === 16384, "width not accepted", { width: stats.width });
    for (const r of roots) {
        check(replayLine(position, r.line) === r.best, "wide-pass line broken", { rep: r.rep, best: r.best });
    }
});

suite("root-locked passes improve only their move", () => {
    const position = randomPosition(mulberry32(2718));
    setIOBoard(position);
    eng.setBoard();
    const before = collectResults().roots.map((r) => r.best);

    eng.beamBeginRoot(0, 64, 0);
    while (eng.beamStep(100000) === 0) { /* run */ }

    const after = collectResults().roots;
    check(after[0].best <= before[0], "locked root regressed", { before: before[0], after: after[0].best });
    for (let k = 1; k < after.length; k++) {
        check(after[k].best === before[k], "non-locked root changed", { k });
    }
    for (const r of after) {
        check(replayLine(position, r.line) === r.best, "line broken after locked pass", { rep: r.rep });
    }
});

suite("permanent-only portfolio crosses temporary fragmentation", () => {
    // Supplied game at move 25, compact columns bottom-up. Every tuned beam
    // stalls above zero because the clearing line is temporarily fragmented;
    // the orthogonal permanent-only member must retain and replay that line.
    const compact = [
        "5424343", "54", "534", "552444", "515141",
        "12342443225", "313245151", "342415341", "353121411211",
    ];
    const position = Array.from({ length: SIZE }, (_, col) =>
        Array.from({ length: SIZE }, (_, row) => Number(compact[col]?.[row] ?? 0)));
    setIOBoard(position);
    eng.setBoard();
    let roots = collectResults().roots;
    const k = roots.findIndex((root) => root.rep === 62); // FC
    check(k >= 0, "move-25 clearing root FC is missing");
    if (k < 0) return;

    // Mirror the worker stages up through width 512, then its bounded
    // score-ordered portfolio audit.
    let seed = 1;
    for (let root = 0; root < roots.length; root++) {
        eng.playoutRoot(root, 32, seed);
        eng.playoutRootSoft(root, 4, seed);
        seed += 32;
    }
    for (const width of [8, 32, 128, 512]) {
        eng.beamBegin(width, 0);
        while (eng.beamStep(400_000) === 0) { /* complete pass */ }
    }
    roots = collectResults().roots;
    const ordered = roots.map((root, index) => ({ ...root, index }))
        .sort((a, b) => a.best - b.best || b.size - a.size || a.rep - b.rep);
    const candidates = ordered.filter((root) => !root.exact &&
        eng.getRootLower(root.index) === 0).slice(0, 2);
    check(ordered[0].best <= 5 && candidates.some((root) => root.index === k),
        "move-25 clear fell outside the bounded worker portfolio", ordered);
    for (const candidate of candidates) {
        eng.beamBeginRootPermanent(candidate.index, 8192);
        while (eng.beamStep(400_000) === 0) { /* run complementary pass */ }
        if (collectResults().roots.some((root) => root.best === 0)) break;
    }
    roots = collectResults().roots;
    check(roots[k].best === 0 && roots[k].exact,
        "permanent-only portfolio missed the move-25 clear", roots[k]);
    check(replayLine(position, roots[k].line) === 0,
        "move-25 portfolio line does not replay to a clean board", roots[k]);

    // The admissible separator bound must stay zero along this solution; the
    // original miss is heuristic focusing, not an unsound permanent prune.
    const replay = clonePosition(position);
    for (const cell of roots[k].line) {
        setIOBoard(replay);
        check(eng.testLowerBound() === 0, "clear line received a positive permanent bound", { cell });
        removeGroup(replay, extractGroup(replay, fieldOf(cell)));
    }
});

suite("counterexample: root-private beam width escalates past starvation", () => {
    const game = new Game("?v=5&g=Bp-rtMfMUUaxsQwaoLBDFQp4_m1oPxZc7RzdEmIsH6ErajTAL9v9H5JAlMB");
    const position = game.getStartPosition();
    setIOBoard(position);
    eng.setBoard();
    const initial = collectResults().roots;
    const k = initial.findIndex((root) => root.rep === 18);
    check(k >= 0, "counterexample clearing root is missing");
    if (k < 0) return;

    eng.beamBeginRoot(k, 2048, 0);
    while (eng.beamStep(400_000) === 0) { /* width below the known cliff */ }
    const narrow = collectResults().roots[k];
    check(replayLine(position, narrow.line) === narrow.best,
        "narrow private-beam line does not replay", narrow);

    // Today this fixture needs 4096. If a future evaluator clears at 2048,
    // that is an improvement, not a regression; do not reject it.
    if (narrow.best > 0) {
        eng.beamBeginRoot(k, 4096, 0);
        while (eng.beamStep(400_000) === 0) { /* private iterative widening */ }
    }
    const wide = collectResults().roots[k];
    check(wide.best === 0 && wide.exact,
        "widened private beam failed to recover the clearing corridor", wide);
    check(replayLine(position, wide.line) === 0,
        "counterexample clearing line does not replay", wide);
});

suite("scheduler: settlement counts only unchanged max-width global passes", () => {
    const maxWidth = 16384;
    let progress = createSearchProgress("top=2;tail=8", 2);

    // Locked and submaximal work still advances the widening clock, but it
    // cannot spend the settlement budget.
    progress = recordSearchPass(progress, "top=2;tail=8", 2, 0, maxWidth);
    progress = recordSearchPass(progress, "top=2;tail=8", 2, 8192, maxWidth);
    check(progress.maxGlobalFruitless === 0 && progress.bestFruitless === 2,
        "non-max passes corrupted scheduler counters", progress);

    // Tail churn resets settlement, but must not reset objective widening.
    progress = recordSearchPass(progress, "top=2;tail=7", 2, maxWidth, maxWidth);
    check(progress.maxGlobalFruitless === 0 && progress.bestFruitless === 3,
        "tail progress reset objective stagnation", progress);

    for (let i = 0; i < 24; i++) {
        progress = recordSearchPass(progress, "top=2;tail=7", 2, maxWidth, maxWidth);
        // Interleaved private passes are deliberately not counted.
        progress = recordSearchPass(progress, "top=2;tail=7", 2, 0, maxWidth);
    }
    check(progress.maxGlobalFruitless === 24,
        "settlement did not count actual max-width globals", progress);
    check(!settlementReady(progress, 24, 144, 56, 1),
        "scheduler settled before private root coverage");
    check(settlementReady(progress, 24, 144, 56, 0),
        "scheduler did not settle after global and private exhaustion");
    check(!settlementReady(progress, 24, 56, 56, 0),
        "scheduler settled inside the exact-solving gate");

    progress = recordSearchPass(progress, "top=1;tail=7", 1, 0, maxWidth);
    check(progress.bestFruitless === 0 && progress.bestScore === 1,
        "best-score improvement did not reset widening", progress);
});

suite("scheduler: position proof is distinct from an exact move table", () => {
    // The first move's static bound is deliberately weak. Once that row is
    // exact, its proved score is the effective lower bound and certifies the
    // position even though a worse alternative remains unresolved.
    const partlyExact = [
        { k: 0, cell: 3, size: 2, score: 2, exact: true },
        { k: 1, cell: 9, size: 4, score: 5, exact: false },
    ];
    const rawLower = new Map([[0, 0], [1, 4]]);
    const lowerOf = (move) => rawLower.get(move.k);
    const proof = summarizePositionProof(partlyExact, lowerOf);

    check(proof.positionLower === 2 && proof.positionUpper === 2,
        "exact row score did not strengthen the position lower bound", proof);
    check(proof.positionExact && !proof.allMovesExact,
        "partial move-table proof was classified incorrectly", proof);
    check(analysisState(proof, false) === "optimal",
        "running analysis hid a proved position value", analysisState(proof, false));

    const allExact = partlyExact.map((move) => ({ ...move, exact: true }));
    const complete = summarizePositionProof(allExact, lowerOf);
    check(analysisState(complete, false) === "proven",
        "exact move table was not classified as proven", complete);

    const unresolved = summarizePositionProof([
        { k: 0, cell: 3, size: 2, score: 2, exact: false },
        { k: 1, cell: 9, size: 4, score: 5, exact: false },
    ], lowerOf);
    check(!unresolved.positionExact && analysisState(unresolved, true) === "settled",
        "stopped unproved position was not classified as settled", unresolved);

    const candidates = positionProofCandidates([
        { k: 0, cell: 30, size: 2, score: 3, exact: false },
        { k: 1, cell: 20, size: 2, score: 2, exact: false },
        { k: 2, cell: 10, size: 5, score: 2, exact: false },
        { k: 3, cell: 40, size: 3, score: 4, exact: true },
    ], (move) => new Map([[0, 0], [1, 1], [2, 1], [3, 0]]).get(move.k));
    check(JSON.stringify(candidates.map((move) => move.k)) === JSON.stringify([2, 1, 0]),
        "position-proof probes are not ordered by tight gap and group size", candidates);
});

suite("worker asset graph uses one cache generation", () => {
    const match = assetSources.ui.match(/ENGINE_ASSET_VERSION\s*=\s*"([^"]+)"/);
    check(match !== null, "engine asset version is missing from the UI bootstrap");
    if (!match) return;
    const version = match[1];
    const expected = {
        index: `scripts/main.js?build=${version}`,
        main: `./click.js?build=${version}`,
        click: `./engine-ui.js?build=${version}`,
        workerGpu: `./gpu.js?build=${version}`,
        workerSchedule: `./schedule.js?build=${version}`,
        workerWasm: `wasmURL.searchParams.set("build", "${version}")`,
        e2e: `/scripts/engine-ui.js?build=${version}`,
    };
    for (const [name, token] of Object.entries(expected)) {
        const source = name.startsWith("worker") ? assetSources.worker : assetSources[name];
        check(source.includes(token), `cache generation mismatch in ${name}`, { version, token });
    }
});

suite("supplied v5 position: bounded root proof certifies the global zero", () => {
    const game = new Game("?v=5&g=Bp90fqatzsB7kFTAXXPCEWyEfOe9QpfTxpzrosY7GaqDbBs0gqCRIQnwnZa");
    const position = game.getStartPosition();
    check(remainingOf(position) === 144, "supplied proof fixture is not the full board", {
        remaining: remainingOf(position),
    });

    setIOBoard(position);
    const rootCount = eng.setBoard();
    check(rootCount === 27, "supplied proof fixture has the wrong root count", { rootCount });

    // Mirror the deterministic CPU portion of the worker's production setup.
    let seed = 1;
    for (let k = 0; k < rootCount; k++) {
        eng.playoutRoot(k, 32, seed);
        eng.playoutRootSoft(k, 4, seed);
        seed += 32;
    }
    for (const width of [8, 32, 128, 512, 2048]) {
        eng.beamBegin(width, 0);
        while (eng.beamStep(400_000) === 0) { /* complete production pass */ }
    }

    const asMoves = () => collectResults().roots.map((root, k) => ({
        ...root,
        k,
        cell: root.rep,
        score: root.best,
    }));
    const lowerOf = (move) => eng.getRootLower(move.k);
    let moves = asMoves();
    let proof = summarizePositionProof(moves, lowerOf);
    const candidates = positionProofCandidates(moves, lowerOf);
    const beforeProbeNodes = collectResults().stats.nodes;
    const budget = 2_000_000;
    let attempts = 0;

    // A budget-out may still have discovered a constructive zero. Commit the
    // witness without claiming exhaustive per-move exactness, then recompute
    // the global proof before trying the next threatening root.
    for (const candidate of candidates) {
        if (proof.positionExact || attempts >= 3) break;
        attempts++;
        eng.exactBeginChild(candidate.k, budget);
        let result = -1;
        while (result === -1) result = eng.exactStep(200_000);
        if (result >= 0) eng.exactMergeChild(candidate.k);
        else if (result === -2) eng.exactCommitChild(candidate.k);
        moves = asMoves();
        proof = summarizePositionProof(moves, lowerOf);
    }

    const after = collectResults();
    const probeNodes = after.stats.nodes - beforeProbeNodes;
    const winner = moves.find((move) => move.score === proof.positionUpper && move.exact);
    check(proof.positionExact && proof.positionLower === 0 && proof.positionUpper === 0,
        "bounded root probes did not certify the supplied position", { proof, attempts });
    check(winner !== undefined && replayLine(position, winner.line) === 0,
        "supplied position has no replayable exact clearing line", winner);
    check(attempts > 0 && attempts <= 3 && probeNodes <= attempts * (budget + 1),
        "supplied position proof exceeded its bounded probe envelope",
        { attempts, probeNodes, budget });
});

suite("budgeted child proof keeps a witness without claiming exactness", () => {
    const columns = [
        "155541400000", "535500000000", "240000000000", "531240000000",
        "513100000000", "251000000000", "553112100000", "334121000000",
        "121531215000", "344323150000", "532435342530", "000000000000",
    ];
    const position = columns.map((column) => Array.from(column, Number));
    setIOBoard(position);
    eng.setBoard();

    const before = collectResults().roots[0];
    const lower = eng.getRootLower(0);
    eng.exactBeginChild(0, 20_000);
    let result = -1;
    while (result === -1) result = eng.exactStep(10_000);
    check(result === -2, "partial-witness fixture unexpectedly completed", { result, before });

    const committed = eng.exactCommitChild(0);
    const after = collectResults().roots[0];
    check(committed === after.best && after.best < before.best,
        "budget exhaustion discarded its constructive improvement", { before, after, committed });
    check(after.best > lower && !after.exact,
        "partial positive witness was unsafely marked exact", { lower, after });
    check(replayLine(position, after.line) === after.best,
        "committed partial witness does not replay", after);
});

// --- 5: exact solver vs brute force -------------------------------------------

suite("exact solver agrees with brute force on small boards", () => {
    const rnd = mulberry32(5150);

    // reference: exhaustive DFS minimum over all move sequences
    function bruteForce(position, memo = new Map()) {
        const key = position.flat().join("");
        const seen = memo.get(key);
        if (seen !== undefined) return seen;

        const groups = enumerateGroups(position);
        if (groups.length === 0) {
            const r = remainingOf(position);
            memo.set(key, r);
            return r;
        }
        let best = Infinity;
        for (const group of groups) {
            const pos = clonePosition(position);
            removeGroup(pos, extractGroup(pos, group.rep));
            best = Math.min(best, bruteForce(pos, memo));
        }
        memo.set(key, best);
        return best;
    }

    // small dense boards (collapsed by construction) with guaranteed groups
    function smallBoard() {
        const cols = 4 + Math.floor(rnd() * 2);
        const rows = 3 + Math.floor(rnd() * 2);
        const position = Array.from({ length: SIZE }, () => Array(SIZE).fill(0));
        for (let i = 0; i < cols; i++) {
            for (let j = 0; j < rows; j++) {
                position[i][j] = 1 + Math.floor(rnd() * 3);
            }
        }
        return position;
    }

    let solved = 0;
    for (let iter = 0; iter < 15; iter++) {
        const position = smallBoard();
        if (enumerateGroups(position).length === 0) continue;

        setIOBoard(position);
        eng.setBoard();
        eng.exactBegin(2_000_000);
        let result = -1;
        while (result === -1) result = eng.exactStep(200_000);
        if (result === -2) continue; // budget exceeded — no claim made, nothing to check

        const expected = bruteForce(position);
        check(result === expected, "exact solver wrong", { iter, result, expected });

        eng.exactMerge();
        const { roots } = collectResults();
        const bestRoot = Math.min(...roots.map((r) => r.best));
        check(bestRoot === result, "exact merge did not surface the optimum", { iter, bestRoot, result });
        for (const r of roots.filter((x) => x.exact)) {
            const childPos = clonePosition(position);
            removeGroup(childPos, extractGroup(childPos, fieldOf(r.rep)));
            const expectedMove = enumerateGroups(childPos).length === 0
                ? remainingOf(childPos) : bruteForce(childPos);
            check(r.best === expectedMove, "exact flag has wrong per-move value",
                { iter, r, expectedMove });
        }
        solved++;

        // per-move proofs: each root child solved exactly must match the brute
        // force of its child position, carry the flag, and stay replayable
        for (let k = 0; k < roots.length; k++) {
            const childPos = clonePosition(position);
            removeGroup(childPos, extractGroup(childPos, fieldOf(roots[k].rep)));
            const expectedChild = enumerateGroups(childPos).length === 0
                ? remainingOf(childPos) : bruteForce(childPos);

            eng.exactBeginChild(k, 2_000_000);
            let r = -1;
            while (r === -1) r = eng.exactStep(200_000);
            if (r === -2) continue;
            check(r === expectedChild, "child exact solver wrong", { iter, k, r, expectedChild });
            check(eng.exactMergeChild(k) === expectedChild, "child merge value wrong", { iter, k });
        }
        const proven = collectResults().roots;
        for (const r of proven.filter((x) => x.exact)) {
            check(replayLine(position, r.line) === r.best, "proven line does not replay", { iter, r });
        }
    }
    check(solved >= 10, "too few exact instances solved", { solved });
});

// --- 6: example games ---------------------------------------------------------

suite("example games: engine analyzes real start positions", () => {
    const examples = [
        "?position=544341454153245551352111315534254113553554342242333515335513533415541542111541422113121311534345113215252332331311244443442542241513343551454125&moves=65,54,21&times=533,929,374",
        "?position=325543113314113135211541443415522322133121452555454312541423142452333321342251314552432544244431224151231425333345115312311242234331554443232431&moves=34,19,29&times=529,648,453",
    ];

    for (const [idx, str] of examples.entries()) {
        const game = new Game(str);
        const position = game.getStartPosition();
        check(position.length === SIZE, "example failed to load", { idx });

        setIOBoard(position);
        eng.setBoard();
        for (const width of [8, 32, 128, 512]) {
            eng.beamBegin(width, 0);
            while (eng.beamStep(100000) === 0) { /* run */ }
        }

        const { roots, stats } = collectResults();
        const best = Math.min(...roots.map((r) => r.best));
        const bestRoot = roots.find((r) => r.best === best);
        check(replayLine(position, bestRoot.line) === best, "example best line broken", { idx });
        console.log(`      example ${idx + 1}: ${stats.remaining} cells, ${roots.length} moves, ` +
            `best final ${best} (${(stats.nodes / 1e6).toFixed(1)}M nodes)`);
    }
});

// --- benchmark ----------------------------------------------------------------

suite("benchmark", () => {
    const rnd = mulberry32(1);
    const position = randomPosition(rnd);
    setIOBoard(position);
    eng.setBoard();

    const t0 = performance.now();
    eng.beamBegin(512, 0);
    while (eng.beamStep(100000) === 0) { /* run */ }
    const dt = performance.now() - t0;
    const { stats } = collectResults();
    console.log(`      width 512 pass: ${(stats.nodes / 1e6).toFixed(2)}M nodes in ${dt.toFixed(0)} ms ` +
        `(${(stats.nodes / dt / 1000).toFixed(2)}M nodes/s)`);

    // quality snapshot: full widening schedule on 10 fresh boards
    let cleared = 0, totalFinal = 0;
    const t1 = performance.now();
    for (let b = 0; b < 10; b++) {
        setIOBoard(randomPosition(rnd));
        eng.setBoard();
        for (const width of [8, 32, 128, 512]) {
            eng.beamBegin(width, 0);
            while (eng.beamStep(100000) === 0) { /* run */ }
        }
        const { roots } = collectResults();
        const best = Math.min(...roots.map((r) => r.best));
        totalFinal += best;
        if (best === 0) cleared++;
    }
    const dt1 = performance.now() - t1;
    console.log(`      quality: ${cleared}/10 boards cleared, mean final ${(totalFinal / 10).toFixed(1)}, ` +
        `${(dt1 / 10).toFixed(0)} ms/board`);
});

console.log(failures === 0 ? "\nAll engine tests passed." : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
