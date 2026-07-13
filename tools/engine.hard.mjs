/**
 * Deterministic all-root proof harness for pathological Click2026 positions.
 *
 * The ordinary benchmark intentionally stays fast. This harness preserves
 * the positions that exposed >100-second proof tails and runs the exact-only
 * policy used by the worker after its initial heuristic setup.
 *
 * Run:
 *   npm run build:engine
 *   node tools/engine.hard.mjs --case=played-18-24 --timeout=120000
 *   node tools/engine.hard.mjs --case=all --wasm=path/to/engine.wasm
 *   node tools/engine.hard.mjs --wasm=old.wasm --order=score --bound-try-remaining=88
 *
 * Copyright 2014-2026, Hrvoje Abraham ahrvoje@gmail.com
 * Released under the MIT license.
 */

import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
    SIZE, clonePosition, extractGroup, removeGroup,
} from "../src/scripts/board.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const option = (name, fallback) =>
    process.argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const caseName = option("case", "all");
const timeoutMs = Number(option("timeout", "120000"));
const proofOrder = option("order", "broad");
const boundTryRemaining = Number(option("bound-try-remaining", "64"));
const wasmOption = option("wasm", join(root, "src/scripts/engine/engine.wasm"));
const wasmPath = isAbsolute(wasmOption) ? wasmOption : resolve(wasmOption);
const wasmBytes = await readFile(wasmPath);
const wasmSha256 = createHash("sha256").update(wasmBytes).digest("hex");

const CASES = [
    {
        id: "played-18-24",
        seed: 18,
        depth: 24,
        columns: [
            "24313421323", "23414531425", "141255", "452313425",
            "515432214214", "52453", "5552", "35", "452", "335", "4222", "31241315",
        ],
        baseline: { timeoutMs: 105_000, proven: 0, roots: 10 },
        expected: { 0: 1, 3: 2, 7: 1, 9: 2, 17: 3, 48: 1, 52: 1, 53: 1, 108: 1, 121: 1 },
    },
    {
        id: "played-15-24",
        seed: 15,
        depth: 24,
        columns: [
            "23332451", "11555131", "31324311", "1514", "425352153", "125514243",
            "255534", "1442111", "13413", "524423", "1322245", "424312151",
        ],
        baseline: { timeoutMs: 150_000, proven: 4, roots: 12 },
        expected: { 1: 0, 7: 0, 12: 0, 14: 0, 49: 0, 50: 0,
            56: 0, 65: 0, 84: 0, 85: 0, 88: 0, 112: 1 },
    },
];

const selected = caseName === "all" ? CASES : CASES.filter((item) => item.id === caseName);
if (selected.length === 0) {
    throw new Error(`unknown case ${caseName}; choose ${CASES.map((item) => item.id).join(", ")}, or all`);
}

const positionOf = (spec) => Array.from({ length: SIZE }, (_, col) =>
    Array.from({ length: SIZE }, (_, row) => Number(spec.columns[col]?.[row] ?? 0)));
const positionBytes = (position) => Uint8Array.from(position.flat());
const remainingOf = (position) => position.flat().reduce((sum, value) => sum + (value !== 0), 0);

function replayLine(position, line) {
    const copy = clonePosition(position);
    for (const cell of line) {
        const group = extractGroup(copy, [Math.floor(cell / SIZE), cell % SIZE]);
        if (group.length < 2) return -1;
        removeGroup(copy, group);
    }
    return remainingOf(copy);
}

async function makeEngine() {
    const { instance } = await WebAssembly.instantiate(wasmBytes, {
        env: { abort: () => { throw new Error("wasm abort"); } },
    });
    const eng = instance.exports;
    const IO = eng.ioPtr();
    const mem = () => new Uint8Array(eng.memory.buffer);
    return { eng, IO, mem };
}

function collect(engine) {
    const { eng, IO, mem } = engine;
    const len = eng.collect();
    const bytes = mem().slice(IO, IO + len);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const count = view.getUint32(0, true);
    const roots = [];
    let at = 24;
    for (let k = 0; k < count; k++, at += 8) {
        roots.push({
            k,
            rep: bytes[at],
            size: bytes[at + 2],
            exact: bytes[at + 3] !== 0,
            best: view.getInt32(at + 4, true),
            lower: eng.getRootLower(k),
        });
    }
    for (let k = 0; k < count; k++) at += 1 + bytes[at];
    for (let k = 0; k < count; k++) {
        const lineLength = bytes[at++];
        roots[k].line = Array.from(bytes.slice(at, at + lineLength));
        at += lineLength;
    }
    return {
        nodes: view.getUint32(4, true) + view.getUint32(8, true) * 2 ** 32,
        remaining: view.getUint32(20, true),
        roots,
    };
}

function setup(engine, position) {
    const { eng, IO, mem } = engine;
    mem().set(positionBytes(position), IO);
    const count = eng.setBoard();
    let seedBase = 1;
    for (let k = 0; k < count; k++) {
        eng.playoutRoot(k, 32, seedBase);
        eng.playoutRootSoft(k, 4, seedBase);
        seedBase += 32;
    }
    for (const width of [8, 32, 128, 512, 2048]) {
        eng.beamBegin(width, 0);
        while (eng.beamStep(500_000) === 0) { /* complete pass */ }
    }
}

async function prove(spec) {
    const position = positionOf(spec);
    const boardBytes = positionBytes(position);
    const boardSha256 = createHash("sha256").update(boardBytes).digest("hex");
    const engine = await makeEngine();
    const setupStart = performance.now();
    setup(engine, position);
    const setupMs = performance.now() - setupStart;
    const initial = collect(engine);
    const order = initial.roots.slice().sort(proofOrder === "score"
        ? ((a, b) => a.best - b.best || b.size - a.size || a.rep - b.rep)
        : ((a, b) => a.size - b.size || a.best - b.best || a.rep - b.rep));
    const deadline = performance.now() + timeoutMs;
    const start = performance.now();
    const rows = [];
    let timedOut = false;

    for (const original of order) {
        const current = collect(engine).roots[original.k];
        if (current.exact) {
            rows.push({ rep: current.rep, size: current.size, value: current.best,
                method: "intrinsic", nodes: 0, ms: 0, replay: replayLine(position, current.line) });
            continue;
        }
        if (performance.now() >= deadline) { timedOut = true; break; }

        const rootStart = performance.now();
        const nodesBefore = collect(engine).nodes;
        let method = "value-memo";
        let value = -2;

        // The 2M threshold probe is productive on compact endgames, but the
        // collected 78/86-cell tails showed it was pure discarded work there.
        if (initial.remaining <= boundTryRemaining) {
            method = "branch-bound";
            engine.eng.exactBeginChild(original.k, 2_000_000);
            value = -1;
            while (value === -1 && performance.now() < deadline) {
                value = engine.eng.exactStep(60_000);
            }
            if (value >= 0) engine.eng.exactMergeChild(original.k);
        }

        if (value < 0) {
            method = "value-memo";
            let budget = 8_000_000;
            value = engine.eng.vsBegin(original.k, budget);
            for (;;) {
                while (value === -1 && performance.now() < deadline) {
                    value = engine.eng.vsStep(60_000);
                }
                if (performance.now() >= deadline && value === -1) break;
                if (value !== -2) break;
                budget = Math.min(2_000_000_000, budget * 4);
                value = engine.eng.vsBegin(original.k, budget);
            }
            if (value >= 0 && engine.eng.seedExactByCell(original.rep, value) !== 1 &&
                engine.eng.vsBuildLine(original.k, value) !== 1) {
                method = "value+guided-line";
                engine.eng.exactChildSeek(original.k, 64_000_000, value);
                let seek = -1;
                while (seek === -1 && performance.now() < deadline) {
                    seek = engine.eng.exactStep(60_000);
                }
                if (seek === value) engine.eng.exactMergeChild(original.k);
                else value = -2;
            }
        }

        const after = collect(engine);
        const proven = after.roots[original.k];
        rows.push({
            rep: proven.rep,
            size: proven.size,
            lower: proven.lower,
            value: value >= 0 ? value : null,
            score: proven.best,
            exact: proven.exact,
            method,
            nodes: after.nodes - nodesBefore,
            ms: Math.round(performance.now() - rootStart),
            replay: replayLine(position, proven.line),
        });
        if (!proven.exact) { timedOut = performance.now() >= deadline; break; }
    }

    const result = collect(engine);
    const replayValid = result.roots.every((move) => replayLine(position, move.line) === move.best);
    const valuesValid = result.roots.every((move) => spec.expected[move.rep] === move.best);
    return {
        case: spec.id,
        generator: { seed: spec.seed, depth: spec.depth },
        boardSha256,
        columns: spec.columns,
        cells: result.remaining,
        roots: result.roots.length,
        baseline: spec.baseline,
        setupMs: Math.round(setupMs),
        solveMs: Math.round(performance.now() - start),
        timeoutMs,
        proofOrder,
        boundTryRemaining,
        timedOut,
        proven: result.roots.filter((move) => move.exact).length,
        replayValid,
        valuesValid,
        proofRows: rows,
    };
}

console.error(`WASM ${wasmPath} (${wasmSha256.slice(0, 16)}...)`);
let failures = 0;
for (const spec of selected) {
    console.error(`proving ${spec.id} (timeout ${timeoutMs} ms)`);
    const result = await prove(spec);
    console.log(JSON.stringify(result));
    if (result.timedOut || result.proven !== result.roots ||
        !result.replayValid || !result.valuesValid) failures++;
}
process.exitCode = failures === 0 ? 0 : 1;
