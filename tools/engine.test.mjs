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

const { SIZE, clonePosition, extractGroup, removeGroup, enumerateGroups } =
    await import("../src/scripts/board.js");
const { Game } = await import("../src/scripts/game.js");

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
            check(r.best === result, "exact flag on non-optimal root", { iter, r });
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
