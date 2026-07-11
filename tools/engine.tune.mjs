/**
 * Click2026 — evaluation weight tuning harness (development tool).
 *
 * Grid-searches the three eval weights over a fixed set of random boards and
 * reports clear rate / mean final remaining under a realistic pass schedule.
 * The winning weights become the defaults in asm/engine.ts — see the
 * "Evaluation function" section of docs/ENGINE.md for the last results.
 *
 * Run: npm run tune:engine
 *
 * Copyright 2014-2026, Hrvoje Abraham ahrvoje@gmail.com
 * Released under the MIT license.
 */

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const wasmBytes = await readFile(join(root, "src/scripts/engine/engine.wasm"));
const { instance } = await WebAssembly.instantiate(wasmBytes, {
    env: { abort: () => { throw new Error("wasm abort"); } },
});
const eng = instance.exports;
const IO = eng.ioPtr();
const mem = () => new Uint8Array(eng.memory.buffer);

function mulberry32(seed) {
    return () => {
        seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
        let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

// fixed benchmark set
const BOARDS = [];
{
    const rnd = mulberry32(0xC11C2026);
    for (let b = 0; b < 60; b++) {
        const bytes = new Uint8Array(144);
        for (let c = 0; c < 144; c++) bytes[c] = 1 + Math.floor(rnd() * 5);
        BOARDS.push(bytes);
    }
}

function bestFinal(board, widths) {
    mem().set(board, IO);
    eng.setBoard();
    for (const width of widths) {
        eng.beamBegin(width, 0);
        while (eng.beamStep(200000) === 0) { /* run */ }
    }
    const len = eng.collect();
    const bytes = mem().slice(IO, IO + len);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const rootCount = view.getUint32(0, true);
    let best = Infinity;
    for (let k = 0; k < rootCount; k++) {
        best = Math.min(best, view.getInt32(24 + 8 * k + 4, true));
    }
    return best;
}

function evaluate(dead, single, frag, widths) {
    eng.setWeights(dead, single, frag, 0.5, 1.2);
    let clears = 0, total = 0;
    for (const board of BOARDS) {
        const final = bestFinal(board, widths);
        total += final;
        if (final === 0) clears++;
    }
    return { clears, mean: total / BOARDS.length };
}

const grid = [];
console.log("grid search over 60 boards, schedule [8, 32, 128]:");
for (const dead of [2, 4, 6]) {
    for (const single of [0.8, 1.4, 2.0]) {
        for (const frag of [0.3, 0.6, 1.0]) {
            const t0 = performance.now();
            const { clears, mean } = evaluate(dead, single, frag, [8, 32, 128]);
            const dt = ((performance.now() - t0) / 1000).toFixed(1);
            grid.push({ dead, single, frag, clears, mean });
            console.log(`  dead ${dead} single ${single} frag ${frag}  ->  ` +
                `${clears}/60 cleared, mean ${mean.toFixed(2)}  (${dt}s)`);
        }
    }
}

grid.sort((a, b) => b.clears - a.clears || a.mean - b.mean);
console.log("\ntop 5:");
for (const g of grid.slice(0, 5)) {
    console.log(`  dead ${g.dead} single ${g.single} frag ${g.frag}: ${g.clears}/60, mean ${g.mean.toFixed(2)}`);
}

console.log("\nvalidation of top 2 with the full live schedule [8..512 + stochastic]:");
for (const g of grid.slice(0, 2)) {
    eng.setWeights(g.dead, g.single, g.frag, 0.5, 1.2);
    let clears = 0, total = 0;
    for (const board of BOARDS) {
        mem().set(board, IO);
        eng.setBoard();
        for (const width of [8, 32, 128, 512]) {
            eng.beamBegin(width, 0);
            while (eng.beamStep(200000) === 0) { /* run */ }
        }
        for (let s = 1; s <= 2; s++) {
            eng.beamBegin(256, s);
            while (eng.beamStep(200000) === 0) { /* run */ }
        }
        const len = eng.collect();
        const bytes = mem().slice(IO, IO + len);
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        const rootCount = view.getUint32(0, true);
        let best = Infinity;
        for (let k = 0; k < rootCount; k++) best = Math.min(best, view.getInt32(24 + 8 * k + 4, true));
        total += best;
        if (best === 0) clears++;
    }
    console.log(`  dead ${g.dead} single ${g.single} frag ${g.frag}: ${clears}/60 cleared, mean ${(total / 60).toFixed(2)}`);
}
