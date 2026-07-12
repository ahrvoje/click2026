/**
 * Deterministic performance harness for the Click2026 WASM engine.
 *
 * Measures two distinct objectives:
 *   1. heuristic beam node throughput on fixed full boards;
 *   2. nodes needed to prove fixed top-move values on medium endgames.
 *
 * Run: npm run bench:engine
 *      node tools/engine.bench.mjs --wasm path/to/engine.wasm
 */

import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
    SIZE, clonePosition, enumerateGroups, extractGroup, removeGroup,
} from "../src/scripts/board.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const wasmOption = process.argv.find((arg) => arg.startsWith("--wasm="))?.slice(7);
const wasmPath = wasmOption
    ? (isAbsolute(wasmOption) ? wasmOption : resolve(wasmOption))
    : join(root, "src/scripts/engine/engine.wasm");
const wasmBytes = await readFile(wasmPath);

function mulberry32(seed) {
    return () => {
        seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
        let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

const fieldOf = (cell) => [Math.floor(cell / SIZE), cell % SIZE];
const remainingOf = (position) => position.flat().reduce((n, v) => n + (v !== 0), 0);

function positionBytes(position) {
    return Uint8Array.from(position.flat());
}

function replayLine(position, line) {
    const copy = clonePosition(position);
    for (const cell of line) {
        const group = extractGroup(copy, fieldOf(cell));
        if (group.length < 2) return -1;
        removeGroup(copy, group);
    }
    return remainingOf(copy);
}

function playedBoard(seed, depth) {
    const rnd = mulberry32(seed);
    const position = Array.from({ length: SIZE }, () =>
        Array.from({ length: SIZE }, () => 1 + Math.floor(rnd() * 5)));
    for (let d = 0; d < depth; d++) {
        const groups = enumerateGroups(position);
        if (groups.length === 0) break;
        removeGroup(position, groups[Math.floor(rnd() * groups.length)].cells);
    }
    return position;
}

async function makeEngine() {
    const { instance } = await WebAssembly.instantiate(wasmBytes, {
        env: { abort: () => { throw new Error("wasm abort"); } },
    });
    const eng = instance.exports;
    const IO = eng.ioPtr();
    const mem = () => new Uint8Array(eng.memory.buffer);

    function setBoard(position) {
        mem().set(positionBytes(position), IO);
        return eng.setBoard();
    }

    function collect() {
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
            });
        }
        for (let k = 0; k < count; k++) at += 1 + bytes[at];
        for (let k = 0; k < count; k++) {
            const n = bytes[at++];
            roots[k].line = Array.from(bytes.slice(at, at + n));
            at += n;
        }
        return {
            nodes: view.getUint32(4, true) + view.getUint32(8, true) * 2 ** 32,
            roots,
        };
    }

    return { eng, setBoard, collect };
}

async function liveSetup(engine, position) {
    const count = engine.setBoard(position);
    let seedBase = 1;
    for (let k = 0; k < count; k++) {
        engine.eng.playoutRoot(k, 32, seedBase);
        seedBase += 32;
    }
    for (const width of [8, 32, 128, 512, 2048]) {
        engine.eng.beamBegin(width, 0);
        while (engine.eng.beamStep(200_000) === 0) { /* complete pass */ }
    }
}

// --- heuristic throughput ---------------------------------------------------

const beamRnd = mulberry32(0xC11C2026);
const beamBoards = Array.from({ length: 4 }, () =>
    Array.from({ length: SIZE }, () =>
        Array.from({ length: SIZE }, () => 1 + Math.floor(beamRnd() * 5))));
const beamSamples = [];
let beamNodes = 0;
for (let run = 0; run < 3; run++) {
    const engine = await makeEngine();
    let nodes = 0;
    let elapsed = 0;
    for (const board of beamBoards) {
        engine.setBoard(board);
        const start = performance.now();
        engine.eng.beamBegin(512, 0);
        while (engine.eng.beamStep(1_000_000) === 0) { /* complete pass */ }
        elapsed += performance.now() - start;
        nodes += engine.collect().nodes;
    }
    beamNodes = nodes;
    beamSamples.push(nodes / elapsed / 1000);
}
beamSamples.sort((a, b) => a - b);
console.log(`WASM: ${wasmPath}`);
console.log(`beam width 512: ${(beamNodes / 1e6).toFixed(2)}M nodes over ${beamBoards.length} boards, ` +
    `median ${beamSamples[1].toFixed(3)}M nodes/s ` +
    `(samples ${beamSamples.map((n) => n.toFixed(3)).join(", ")})`);

// --- exact proof corpus -----------------------------------------------------

const PROOFS = [
    { seed: 14, depth: 36, rep: 12, expected: 0 },
    { seed: 29, depth: 30, rep: 12, expected: 0 },
    { seed: 89, depth: 28, rep: 62, expected: 0 },
    { seed: 9, depth: 28, rep: 84, expected: 1 },
    { seed: 18, depth: 28, rep: 39, expected: 3 },
];

const proofRows = [];
for (const spec of PROOFS) {
    const position = playedBoard(spec.seed, spec.depth);
    const id = createHash("sha256").update(positionBytes(position)).digest("hex").slice(0, 12);
    const engine = await makeEngine();
    await liveSetup(engine, position);
    const before = engine.collect();
    const rootMove = before.roots.find((move) => move.rep === spec.rep);
    if (!rootMove) throw new Error(`missing fixed root ${spec.rep} for seed ${spec.seed}`);

    let method = "lower-bound";
    let result = rootMove.best;
    const start = performance.now();
    if (!rootMove.exact) {
        method = "branch-bound";
        engine.eng.exactBeginChild(rootMove.k, 2_000_000);
        result = -1;
        while (result === -1) result = engine.eng.exactStep(200_000);

        if (result >= 0) {
            engine.eng.exactMergeChild(rootMove.k);
        } else {
            method = "value-memo";
            let budget = 8_000_000;
            result = engine.eng.vsBegin(rootMove.k, budget);
            for (;;) {
                while (result === -1) result = engine.eng.vsStep(200_000);
                if (result !== -2) break;
                budget = Math.min(2_000_000_000, budget * 4);
                result = engine.eng.vsBegin(rootMove.k, budget);
            }
            if (engine.eng.vsBuildLine(rootMove.k, result) !== 1) {
                engine.eng.exactChildSeek(rootMove.k, 64_000_000, result);
                let seek = -1;
                while (seek === -1) seek = engine.eng.exactStep(200_000);
                if (seek !== result) throw new Error(`line seek failed for seed ${spec.seed}`);
                engine.eng.exactMergeChild(rootMove.k);
            }
        }
    }
    const elapsed = performance.now() - start;
    const after = engine.collect();
    const proven = after.roots.find((move) => move.rep === spec.rep);
    const replayed = replayLine(position, proven.line);
    if (!proven.exact || proven.best !== spec.expected || replayed !== spec.expected) {
        throw new Error(`bad proof seed ${spec.seed}: expected ${spec.expected}, ` +
            `got best=${proven.best} exact=${proven.exact} replay=${replayed}`);
    }
    proofRows.push({
        board: `${spec.seed}/${spec.depth} ${id}`,
        cells: remainingOf(position),
        root: spec.rep,
        score: proven.best,
        method,
        nodes: after.nodes - before.nodes,
        ms: +elapsed.toFixed(2),
    });
}

console.table(proofRows);

// Explicitly benchmark the value-policy path that the hybrid ladder uses
// after a branch-and-bound budget miss. Older comparison binaries may not
// export policy reconstruction yet.
if (typeof (await makeEngine()).eng.vsBuildLine === "function") {
    const position = playedBoard(18, 28);
    const engine = await makeEngine();
    await liveSetup(engine, position);
    const before = engine.collect();
    const move = before.roots.find((rootMove) => rootMove.rep === 39);
    const start = performance.now();
    let value = engine.eng.vsBegin(move.k, 8_000_000);
    while (value === -1) value = engine.eng.vsStep(200_000);
    const solved = engine.collect();
    const built = engine.eng.vsBuildLine(move.k, value);
    const elapsed = performance.now() - start;
    if (value !== 3 || built !== 1) throw new Error("value-policy recovery fixture failed");
    console.log(`value-policy recovery: score ${value}, ${(solved.nodes - before.nodes).toLocaleString()} ` +
        `value nodes, 0 recovery nodes, ${elapsed.toFixed(2)} ms`);
}
