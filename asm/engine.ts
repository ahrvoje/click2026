/**
 * Click2026 — analysis engine core (AssemblyScript → WebAssembly).
 *
 * Mirrors the exact rules of src/scripts/board.js (flood fill, collapse down,
 * collapse left, group enumeration order). The Node test suite proves the two
 * implementations equivalent on random boards — see tools/engine.test.mjs.
 *
 * Search strategy (documented in docs/ENGINE.md):
 *   - anytime iterative-widening beam search over the move DAG,
 *   - per-layer transposition dedup via 64-bit Zobrist hashes,
 *   - tabu-color random playouts refining every root move (bit-identical twin
 *     of the WebGPU kernel in src/scripts/engine/gpu.js, verified by replay),
 *   - budgeted branch & bound DFS proving exact optima on small boards.
 *
 * Every reported score is constructively achievable: the engine stores a
 * replayable move line for each root move's best-known outcome.
 *
 * Copyright 2014-2026, Hrvoje Abraham ahrvoje@gmail.com
 * Released under the MIT license.
 * https://opensource.org/licenses/MIT
 *
 * Date: Sat Jul 11, 2026
 */

// board geometry — must match src/scripts/board.js
const SIZE: i32 = 12;
const CELLS: i32 = 144;
const COLORS: i32 = 5;

// search limits
const MAX_WIDTH: i32 = 16384;       // beam arena capacity (stagnation escalates up to this)
const MAX_ROOTS: i32 = 80;          // legal first moves never exceed 72 (each removes >= 2 cells)
const LINE_MAX: i32 = 80;           // longest possible move line, with headroom
const EDGE_MAX: i32 = MAX_WIDTH * (LINE_MAX + 4);
const HASH_CAP: i32 = 1 << 17;      // per-layer dedup table (power of two)
const HASH_MASK: i32 = HASH_CAP - 1;
const HASH_PROBES: i32 = 32;        // linear probing give-up bound
const TT_CAP: i32 = 1 << 20;        // exact solver transposition table
const TT_MASK: i32 = TT_CAP - 1;
const EXACT_STACK: i32 = 80;        // exact solver DFS depth bound

const NO_EDGE: u32 = 0xFFFFFFFF;
const NO_SCORE: i32 = 0x7FFFFFFF;

// evaluation weights (see docs/ENGINE.md "Evaluation function"); tunable via
// setWeights, defaults tuned with tools/engine.tune.mjs on 2026-07-11:
// 56/60 random boards cleared, mean 0.27 cells left under the live schedule
let W_DEAD: f32 = 6.0;              // cells of a color with exactly one cell left — stuck forever
let W_SINGLE: f32 = 2.0;            // size-1 components of otherwise pairable colors
let W_FRAG: f32 = 0.6;              // extra components per color beyond the first
let W_FROZEN: f32 = 0.5;            // cells of a "frozen" color: >= 2 cells but no playable pair
let NOISE_SCALE: f32 = 1.2;         // eval jitter amplitude of stochastic diversification passes

// ---------------------------------------------------------------------------
// static buffers (runtime "stub": allocated once at start, never freed)
// ---------------------------------------------------------------------------

const IO = new StaticArray<u8>(16384);          // JS <-> WASM exchange buffer
const ROOT_BOARD = new StaticArray<u8>(CELLS);  // the position under analysis

const ZOB = new StaticArray<u64>(CELLS * COLORS);

// shared scan scratch
const VISITED = new StaticArray<u8>(CELLS);
const STACK = new StaticArray<u8>(CELLS);
const GROUP_CELLS = new StaticArray<u8>(CELLS);
const REPS = new StaticArray<u8>(MAX_ROOTS);
const REP_COLORS = new StaticArray<u8>(MAX_ROOTS);
const REP_SIZES = new StaticArray<u8>(MAX_ROOTS);

// beam arenas — two banks flipped between layers
const BOARDS_A = new StaticArray<u8>(MAX_WIDTH * CELLS);
const BOARDS_B = new StaticArray<u8>(MAX_WIDTH * CELLS);
const META_ROOT_A = new StaticArray<u8>(MAX_WIDTH);
const META_ROOT_B = new StaticArray<u8>(MAX_WIDTH);
const META_EDGE_A = new StaticArray<u32>(MAX_WIDTH);
const META_EDGE_B = new StaticArray<u32>(MAX_WIDTH);

// candidate heap (replace-max selection of the next layer), slot-indexed data
const H_EVAL = new StaticArray<f32>(MAX_WIDTH);
const H_ORD = new StaticArray<u32>(MAX_WIDTH);     // heap order -> slot id
const H_EDGE_PAR = new StaticArray<u32>(MAX_WIDTH);
const H_MOVE = new StaticArray<u8>(MAX_WIDTH);

// per-layer dedup
const DEDUP_KEY = new StaticArray<u64>(HASH_CAP);
const DEDUP_STAMP = new StaticArray<u32>(HASH_CAP);

// line reconstruction edges: (parent edge, move) per surviving beam node
const EDGE_PAR = new StaticArray<u32>(EDGE_MAX);
const EDGE_MOVE = new StaticArray<u8>(EDGE_MAX);

// per-root results, persistent across the passes of one analysis
const ROOT_REP = new StaticArray<u8>(MAX_ROOTS);
const ROOT_COLOR = new StaticArray<u8>(MAX_ROOTS);
const ROOT_SIZE = new StaticArray<u8>(MAX_ROOTS);
const ROOT_BEST = new StaticArray<i32>(MAX_ROOTS);
const ROOT_EXACT = new StaticArray<u8>(MAX_ROOTS);
const ROOT_LINE_LEN = new StaticArray<u8>(MAX_ROOTS);
const ROOT_LINES = new StaticArray<u8>(MAX_ROOTS * LINE_MAX);
const ROOT_CELLS_LEN = new StaticArray<u8>(MAX_ROOTS);
const ROOT_CELLS = new StaticArray<u8>(CELLS);     // root groups are disjoint, 144 cells suffice
const ROOT_CELLS_OFF = new StaticArray<u16>(MAX_ROOTS);

// scratch boards
const SCRATCH = new StaticArray<u8>(CELLS);        // candidate child during expansion
const PLAYOUT_BOARD = new StaticArray<u8>(CELLS);
const PLAYOUT_LINE = new StaticArray<u8>(LINE_MAX);

// exact solver
const EX_BOARDS = new StaticArray<u8>(EXACT_STACK * CELLS);
const EX_REPS = new StaticArray<u8>(EXACT_STACK * MAX_ROOTS);
const EX_COUNT = new StaticArray<i32>(EXACT_STACK);
const EX_CURSOR = new StaticArray<i32>(EXACT_STACK);
const EX_MOVE = new StaticArray<u8>(EXACT_STACK);
const EX_LINE = new StaticArray<u8>(LINE_MAX);
const TT_KEY = new StaticArray<u64>(TT_CAP);
const TT_STAMP = new StaticArray<u32>(TT_CAP);

// ---------------------------------------------------------------------------
// tiny utils
// ---------------------------------------------------------------------------

// @ts-ignore: decorator is valid AssemblyScript
@inline
function pu8(arr: StaticArray<u8>): usize { return changetype<usize>(arr); }

// @ts-ignore
@inline
function cellAt(bd: usize, i: i32): u8 { return load<u8>(bd + <usize>i); }

// @ts-ignore
@inline
function setCellAt(bd: usize, i: i32, v: u8): void { store<u8>(bd + <usize>i, v); }

// splitmix64 — deterministic Zobrist table
function initZobrist(): void {
    let s: u64 = 0x9E3779B97F4A7C15;
    for (let i = 0; i < CELLS * COLORS; i++) {
        s += 0x9E3779B97F4A7C15;
        let z = s;
        z = (z ^ (z >> 30)) * 0xBF58476D1CE4E5B9;
        z = (z ^ (z >> 27)) * 0x94D049BB133111EB;
        unchecked(ZOB[i] = z ^ (z >> 31));
    }
}
initZobrist();

// xorshift128 (Marsaglia) — bit-identical twin lives in the WGSL playout shader
let rngX: u32 = 0, rngY: u32 = 0, rngZ: u32 = 0, rngW: u32 = 0;

function rngNext(): u32 {
    const t = rngX ^ (rngX << 11);
    rngX = rngY; rngY = rngZ; rngZ = rngW;
    rngW = (rngW ^ (rngW >> 19)) ^ (t ^ (t >> 8));
    return rngW;
}

function rngSeed(seed: u32): void {
    rngX = seed ^ 0x9E3779B9;
    rngY = seed * 1664525 + 1013904223;
    rngZ = seed ^ 0x85EBCA6B;
    rngW = seed * 2246822519 + 374761393;
    if (rngW == 0) rngW = 0x6C078965; // keep away from the all-zero fixpoint
    for (let i = 0; i < 4; i++) rngNext();
}

// ---------------------------------------------------------------------------
// board primitives — rule-exact ports of src/scripts/board.js
// ---------------------------------------------------------------------------

// flood fill of the same-colored group containing `start`; returns group size,
// writes member cell indices to GROUP_CELLS
function floodFill(bd: usize, start: i32): i32 {
    const color = cellAt(bd, start);
    if (color == 0) return 0;

    memory.fill(pu8(VISITED), 0, CELLS);
    unchecked(VISITED[start] = 1);
    unchecked(STACK[0] = <u8>start);
    let sp = 1;
    let count = 0;

    while (sp > 0) {
        const cell = <i32>unchecked(STACK[--sp]);
        unchecked(GROUP_CELLS[count++] = <u8>cell);

        const col = cell / SIZE, row = cell % SIZE;
        if (col > 0 && cellAt(bd, cell - SIZE) == color && !unchecked(VISITED[cell - SIZE])) {
            unchecked(VISITED[cell - SIZE] = 1); unchecked(STACK[sp++] = <u8>(cell - SIZE));
        }
        if (col < SIZE - 1 && cellAt(bd, cell + SIZE) == color && !unchecked(VISITED[cell + SIZE])) {
            unchecked(VISITED[cell + SIZE] = 1); unchecked(STACK[sp++] = <u8>(cell + SIZE));
        }
        if (row > 0 && cellAt(bd, cell - 1) == color && !unchecked(VISITED[cell - 1])) {
            unchecked(VISITED[cell - 1] = 1); unchecked(STACK[sp++] = <u8>(cell - 1));
        }
        if (row < SIZE - 1 && cellAt(bd, cell + 1) == color && !unchecked(VISITED[cell + 1])) {
            unchecked(VISITED[cell + 1] = 1); unchecked(STACK[sp++] = <u8>(cell + 1));
        }
    }

    return count;
}

// gravity down inside columns, then compact non-empty columns left;
// equivalent to collapseDown + collapseLeft of board.js
function collapse(bd: usize): void {
    for (let col = 0; col < SIZE; col++) {
        const base = bd + <usize>(col * SIZE);
        let row = 0;
        for (let j = 0; j < SIZE; j++) {
            const v = load<u8>(base + <usize>j);
            store<u8>(base + <usize>j, 0);
            if (v != 0) {
                store<u8>(base + <usize>row, v);
                row++;
            }
        }
    }

    let write = 0;
    for (let col = 0; col < SIZE; col++) {
        if (cellAt(bd, col * SIZE) != 0) {
            if (write != col) {
                memory.copy(bd + <usize>(write * SIZE), bd + <usize>(col * SIZE), SIZE);
                memory.fill(bd + <usize>(col * SIZE), 0, SIZE);
            }
            write++;
        }
    }
}

// removes the group containing `cell` (if size >= 2) and collapses; returns group size
function applyMove(bd: usize, cell: i32): i32 {
    const size = floodFill(bd, cell);
    if (size < 2) return 0;

    for (let k = 0; k < size; k++) {
        setCellAt(bd, <i32>unchecked(GROUP_CELLS[k]), 0);
    }
    collapse(bd);
    return size;
}

// all clickable groups in board.js scan order (ascending cell index, rep = first
// cell met by the scan); fills REPS/REP_COLORS/REP_SIZES, returns group count
function enumerateGroups(bd: usize): i32 {
    memory.fill(pu8(VISITED), 0, CELLS);
    let count = 0;

    for (let cell = 0; cell < CELLS; cell++) {
        if (unchecked(VISITED[cell])) continue;
        const color = cellAt(bd, cell);
        if (color == 0) continue;

        unchecked(VISITED[cell] = 1);
        unchecked(STACK[0] = <u8>cell);
        let sp = 1, size = 0;
        while (sp > 0) {
            const c = <i32>unchecked(STACK[--sp]);
            size++;
            const col = c / SIZE, row = c % SIZE;
            if (col > 0 && cellAt(bd, c - SIZE) == color && !unchecked(VISITED[c - SIZE])) {
                unchecked(VISITED[c - SIZE] = 1); unchecked(STACK[sp++] = <u8>(c - SIZE));
            }
            if (col < SIZE - 1 && cellAt(bd, c + SIZE) == color && !unchecked(VISITED[c + SIZE])) {
                unchecked(VISITED[c + SIZE] = 1); unchecked(STACK[sp++] = <u8>(c + SIZE));
            }
            if (row > 0 && cellAt(bd, c - 1) == color && !unchecked(VISITED[c - 1])) {
                unchecked(VISITED[c - 1] = 1); unchecked(STACK[sp++] = <u8>(c - 1));
            }
            if (row < SIZE - 1 && cellAt(bd, c + 1) == color && !unchecked(VISITED[c + 1])) {
                unchecked(VISITED[c + 1] = 1); unchecked(STACK[sp++] = <u8>(c + 1));
            }
        }

        if (size >= 2 && count < MAX_ROOTS) {
            unchecked(REPS[count] = <u8>cell);
            unchecked(REP_COLORS[count] = color);
            unchecked(REP_SIZES[count] = <u8>size);
            count++;
        }
    }

    return count;
}

// ---------------------------------------------------------------------------
// evaluation — one scan computing components, remaining, hash and mobility
// ---------------------------------------------------------------------------

let evalRemaining: i32 = 0;
let evalHash: u64 = 0;
let evalHasMoves: bool = false;

const colorTotal = new StaticArray<i32>(COLORS + 1);
const colorComps = new StaticArray<i32>(COLORS + 1);
const colorHasPair = new StaticArray<i32>(COLORS + 1);

// heuristic value of a board, lower is better; fills evalRemaining, evalHash
// and evalHasMoves as side products of the same scan
function evalBoard(bd: usize, noiseSeed: u32): f32 {
    memory.fill(pu8(VISITED), 0, CELLS);
    for (let c = 0; c <= COLORS; c++) {
        unchecked(colorTotal[c] = 0);
        unchecked(colorComps[c] = 0);
        unchecked(colorHasPair[c] = 0);
    }

    let remaining = 0;
    let hash: u64 = 0;
    let singles = 0;
    let hasMoves = false;

    for (let cell = 0; cell < CELLS; cell++) {
        const color = cellAt(bd, cell);
        if (color != 0) {
            remaining++;
            hash ^= unchecked(ZOB[cell * COLORS + <i32>color - 1]);
        }
        if (unchecked(VISITED[cell]) || color == 0) continue;

        unchecked(VISITED[cell] = 1);
        unchecked(STACK[0] = <u8>cell);
        let sp = 1, size = 0;
        while (sp > 0) {
            const c = <i32>unchecked(STACK[--sp]);
            size++;
            const col = c / SIZE, row = c % SIZE;
            if (col > 0 && cellAt(bd, c - SIZE) == color && !unchecked(VISITED[c - SIZE])) {
                unchecked(VISITED[c - SIZE] = 1); unchecked(STACK[sp++] = <u8>(c - SIZE));
            }
            if (col < SIZE - 1 && cellAt(bd, c + SIZE) == color && !unchecked(VISITED[c + SIZE])) {
                unchecked(VISITED[c + SIZE] = 1); unchecked(STACK[sp++] = <u8>(c + SIZE));
            }
            if (row > 0 && cellAt(bd, c - 1) == color && !unchecked(VISITED[c - 1])) {
                unchecked(VISITED[c - 1] = 1); unchecked(STACK[sp++] = <u8>(c - 1));
            }
            if (row < SIZE - 1 && cellAt(bd, c + 1) == color && !unchecked(VISITED[c + 1])) {
                unchecked(VISITED[c + 1] = 1); unchecked(STACK[sp++] = <u8>(c + 1));
            }
        }

        const ci = <i32>color;
        unchecked(colorTotal[ci] = unchecked(colorTotal[ci]) + size);
        unchecked(colorComps[ci] = unchecked(colorComps[ci]) + 1);
        if (size == 1) {
            singles++;
        } else {
            hasMoves = true;
            unchecked(colorHasPair[ci] = 1);
        }
    }

    evalRemaining = remaining;
    evalHash = hash;
    evalHasMoves = hasMoves;

    let dead = 0;   // colors reduced to a single cell — that cell is stuck forever
    let frag = 0;   // components beyond the first, per color
    let frozen = 0; // cells of colors with >= 2 cells but no playable pair anywhere:
                    // only a gravity merge can save them, most end up as leftovers
    for (let c = 1; c <= COLORS; c++) {
        const total = unchecked(colorTotal[c]);
        if (total == 1) dead++;
        else if (total > 1 && !unchecked(colorHasPair[c])) frozen += total;
        const comps = unchecked(colorComps[c]);
        if (comps > 1) frag += comps - 1;
    }

    let value = <f32>remaining
        + W_DEAD * <f32>dead
        + W_SINGLE * <f32>(singles - dead)
        + W_FRAG * <f32>frag
        + W_FROZEN * <f32>frozen;

    if (noiseSeed != 0) {
        // deterministic per-board jitter diversifies repeated stochastic passes
        let n = hash ^ (<u64>noiseSeed * 0x9E3779B97F4A7C15);
        n = (n ^ (n >> 29)) * 0xBF58476D1CE4E5B9;
        value += NOISE_SCALE * (<f32>(n & 1023) / <f32>1024);
    }

    return value;
}

function boardRemaining(bd: usize): i32 {
    let r = 0;
    for (let cell = 0; cell < CELLS; cell++) {
        if (cellAt(bd, cell) != 0) r++;
    }
    return r;
}

function boardHash(bd: usize): u64 {
    let hash: u64 = 0;
    for (let cell = 0; cell < CELLS; cell++) {
        const color = cellAt(bd, cell);
        if (color != 0) hash ^= unchecked(ZOB[cell * COLORS + <i32>color - 1]);
    }
    return hash;
}

// ---------------------------------------------------------------------------
// analysis state
// ---------------------------------------------------------------------------

let rootCount: i32 = 0;
let rootRemaining: i32 = 0;
let nodesExpanded: u64 = 0;

// beam pass state
let passWidth: i32 = 0;
let passNoise: u32 = 0;
let passActive: bool = false;
let curArena: i32 = 0;              // 0 -> bank A is the current layer
let curCount: i32 = 0;
let curCursor: i32 = 0;
let layerDepth: i32 = 0;
let heapSize: i32 = 0;
let edgeCount: i32 = 0;
let dedupStamp: u32 = 0;

function curBoards(): usize { return curArena == 0 ? pu8(BOARDS_A) : pu8(BOARDS_B); }
function nxtBoards(): usize { return curArena == 0 ? pu8(BOARDS_B) : pu8(BOARDS_A); }

function curRoot(i: i32): i32 {
    return curArena == 0 ? <i32>unchecked(META_ROOT_A[i]) : <i32>unchecked(META_ROOT_B[i]);
}

function curEdge(i: i32): u32 {
    return curArena == 0 ? unchecked(META_EDGE_A[i]) : unchecked(META_EDGE_B[i]);
}

function setNxtRoot(i: i32, root: i32): void {
    if (curArena == 0) unchecked(META_ROOT_B[i] = <u8>root);
    else unchecked(META_ROOT_A[i] = <u8>root);
}

function setNxtEdge(i: i32, edge: u32): void {
    if (curArena == 0) unchecked(META_EDGE_B[i] = edge);
    else unchecked(META_EDGE_A[i] = edge);
}

// ---------------------------------------------------------------------------
// root move bookkeeping
// ---------------------------------------------------------------------------

// materialize the move line ending with (parentEdge, lastMove) into ROOT_LINES[root]
function recordLine(root: i32, parentEdge: u32, lastMove: i32): void {
    let len = 1;
    let e = parentEdge;
    while (e != NO_EDGE) {
        len++;
        e = unchecked(EDGE_PAR[e]);
    }
    if (len > LINE_MAX) return; // cannot happen, defensive

    let at = len - 1;
    unchecked(ROOT_LINES[root * LINE_MAX + at] = <u8>lastMove);
    e = parentEdge;
    while (e != NO_EDGE) {
        at--;
        unchecked(ROOT_LINES[root * LINE_MAX + at] = unchecked(EDGE_MOVE[e]));
        e = unchecked(EDGE_PAR[e]);
    }
    unchecked(ROOT_LINE_LEN[root] = <u8>len);
}

// a finished line under `root` reached `final` remaining cells
function reportTerminal(root: i32, final: i32, parentEdge: u32, lastMove: i32): void {
    if (final < unchecked(ROOT_BEST[root])) {
        unchecked(ROOT_BEST[root] = final);
        recordLine(root, parentEdge, lastMove);
    }
}

// ---------------------------------------------------------------------------
// greedy rollout — instant baseline score for a root move (largest group first)
// ---------------------------------------------------------------------------

// PLAYOUT_BOARD holds the child board after the root move on entry
function greedyRollout(root: i32): void {
    let len = 1;
    unchecked(PLAYOUT_LINE[0] = unchecked(ROOT_REP[root]));

    while (len < LINE_MAX) {
        const n = enumerateGroups(pu8(PLAYOUT_BOARD));
        if (n == 0) break;

        let best = 0;
        for (let g = 1; g < n; g++) {
            if (unchecked(REP_SIZES[g]) > unchecked(REP_SIZES[best])) best = g;
        }

        unchecked(PLAYOUT_LINE[len] = unchecked(REPS[best]));
        len++;
        applyMove(pu8(PLAYOUT_BOARD), <i32>unchecked(REPS[best]));
    }

    const final = boardRemaining(pu8(PLAYOUT_BOARD));
    if (final < unchecked(ROOT_BEST[root])) {
        unchecked(ROOT_BEST[root] = final);
        unchecked(ROOT_LINE_LEN[root] = <u8>len);
        memory.copy(pu8(ROOT_LINES) + <usize>(root * LINE_MAX), pu8(PLAYOUT_LINE), len);
    }
}

// ---------------------------------------------------------------------------
// public API — position setup
// ---------------------------------------------------------------------------

export function ioPtr(): usize {
    return pu8(IO);
}

// reads a 144-byte column-major board from IO, resets all analysis state,
// enumerates root moves; returns the number of legal moves
export function setBoard(): i32 {
    memory.copy(pu8(ROOT_BOARD), pu8(IO), CELLS);
    nodesExpanded = 0;
    passActive = false;
    layerDepth = 0;
    passWidth = 0;
    rootRemaining = boardRemaining(pu8(ROOT_BOARD));

    rootCount = enumerateGroups(pu8(ROOT_BOARD));
    let cellsOff = 0;
    for (let k = 0; k < rootCount; k++) {
        unchecked(ROOT_REP[k] = unchecked(REPS[k]));
        unchecked(ROOT_COLOR[k] = unchecked(REP_COLORS[k]));
        unchecked(ROOT_SIZE[k] = unchecked(REP_SIZES[k]));
        unchecked(ROOT_BEST[k] = NO_SCORE);
        unchecked(ROOT_EXACT[k] = 0);
        unchecked(ROOT_LINE_LEN[k] = 0);

        // store the group cells for UI outlines (groups are disjoint)
        const size = floodFill(pu8(ROOT_BOARD), <i32>unchecked(ROOT_REP[k]));
        unchecked(ROOT_CELLS_OFF[k] = <u16>cellsOff);
        unchecked(ROOT_CELLS_LEN[k] = <u8>size);
        memory.copy(pu8(ROOT_CELLS) + <usize>cellsOff, pu8(GROUP_CELLS), size);
        cellsOff += size;
    }

    // instant baseline for every root move: greedy largest-group rollout
    for (let k = 0; k < rootCount; k++) {
        memory.copy(pu8(PLAYOUT_BOARD), pu8(ROOT_BOARD), CELLS);
        applyMove(pu8(PLAYOUT_BOARD), <i32>unchecked(ROOT_REP[k]));
        greedyRollout(k);
    }

    return rootCount;
}

export function getRemaining(): i32 {
    return rootRemaining;
}

export function setWeights(dead: f32, single: f32, frag: f32, frozen: f32, noise: f32): void {
    W_DEAD = dead;
    W_SINGLE = single;
    W_FRAG = frag;
    W_FROZEN = frozen;
    NOISE_SCALE = noise;
}

// ---------------------------------------------------------------------------
// beam search — one anytime pass of fixed width
// ---------------------------------------------------------------------------

// max-heap of candidate slots ordered by eval, worst on top (replace-max selection)
function heapSiftUp(pos: i32): void {
    const slot = unchecked(H_ORD[pos]);
    const val = unchecked(H_EVAL[slot]);
    while (pos > 0) {
        const parent = (pos - 1) >> 1;
        const pSlot = unchecked(H_ORD[parent]);
        if (unchecked(H_EVAL[pSlot]) >= val) break;
        unchecked(H_ORD[pos] = pSlot);
        pos = parent;
    }
    unchecked(H_ORD[pos] = slot);
}

function heapSiftDown(pos: i32): void {
    const slot = unchecked(H_ORD[pos]);
    const val = unchecked(H_EVAL[slot]);
    for (;;) {
        let child = 2 * pos + 1;
        if (child >= heapSize) break;
        let cSlot = unchecked(H_ORD[child]);
        if (child + 1 < heapSize && unchecked(H_EVAL[unchecked(H_ORD[child + 1])]) > unchecked(H_EVAL[cSlot])) {
            child++;
            cSlot = unchecked(H_ORD[child]);
        }
        if (unchecked(H_EVAL[cSlot]) <= val) break;
        unchecked(H_ORD[pos] = cSlot);
        pos = child;
    }
    unchecked(H_ORD[pos] = slot);
}

// true if hash was absent (and inserts it); saturates gracefully
function dedupInsert(hash: u64): bool {
    let at = <i32>(hash & <u64>HASH_MASK);
    for (let probe = 0; probe < HASH_PROBES; probe++) {
        if (unchecked(DEDUP_STAMP[at]) != dedupStamp) {
            unchecked(DEDUP_STAMP[at] = dedupStamp);
            unchecked(DEDUP_KEY[at] = hash);
            return true;
        }
        if (unchecked(DEDUP_KEY[at]) == hash) return false;
        at = (at + 1) & HASH_MASK;
    }
    return true; // table region saturated — allow potential duplicate
}

// pass setup shared by beamBegin/beamBeginRoot; onlyRoot -1 = all root moves
function beamInit(width: i32, noiseSeed: u32, onlyRoot: i32): void {
    if (width > MAX_WIDTH) width = MAX_WIDTH;
    passWidth = width;
    passNoise = noiseSeed;
    edgeCount = 0;
    layerDepth = 1;
    dedupStamp++;

    // layer 1: every selected root child is kept, regardless of width
    curArena = 0;
    curCount = 0;
    curCursor = 0;

    for (let k = 0; k < rootCount; k++) {
        if (onlyRoot >= 0 && k != onlyRoot) continue;
        const bd = curBoards() + <usize>(curCount * CELLS);
        memory.copy(bd, pu8(ROOT_BOARD), CELLS);
        applyMove(bd, <i32>unchecked(ROOT_REP[k]));

        evalBoard(bd, 0); // fills evalRemaining / evalHasMoves

        if (!evalHasMoves) {
            reportTerminal(k, evalRemaining, NO_EDGE, <i32>unchecked(ROOT_REP[k]));
            continue; // terminal children do not enter the layer
        }

        unchecked(EDGE_PAR[edgeCount] = NO_EDGE);
        unchecked(EDGE_MOVE[edgeCount] = unchecked(ROOT_REP[k]));
        unchecked(META_ROOT_A[curCount] = <u8>k);
        unchecked(META_EDGE_A[curCount] = <u32>edgeCount);
        edgeCount++;
        curCount++;
    }

    heapSize = 0;
    passActive = curCount > 0;
}

// starts an anytime pass; noiseSeed 0 = deterministic, else stochastic variant
export function beamBegin(width: i32, noiseSeed: u32): void {
    beamInit(width, noiseSeed, -1);
}

// root-locked pass: the whole beam explores only the subtree of root move k,
// deepening the most promising candidates instead of re-searching everything
export function beamBeginRoot(k: i32, width: i32, noiseSeed: u32): void {
    beamInit(width, noiseSeed, k >= 0 && k < rootCount ? k : -1);
}

// expands up to `budget` child evaluations; returns 1 when the pass is finished
export function beamStep(budget: i32): i32 {
    if (!passActive) return 1;

    let spent = 0;

    while (spent < budget) {
        if (curCursor >= curCount) {
            // layer exhausted — promote heap survivors to the next layer
            if (heapSize == 0) {
                passActive = false;
                return 1;
            }

            // append the survivors' edges, now that they are final
            for (let i = 0; i < heapSize; i++) {
                unchecked(EDGE_PAR[edgeCount] = unchecked(H_EDGE_PAR[i]));
                unchecked(EDGE_MOVE[edgeCount] = unchecked(H_MOVE[i]));
                setNxtEdge(i, <u32>edgeCount);
                edgeCount++;
            }

            curArena ^= 1;
            curCount = heapSize;
            curCursor = 0;
            heapSize = 0;
            layerDepth++;
            dedupStamp++;

            if (edgeCount + passWidth + 8 >= EDGE_MAX) {
                // edge arena nearly full — end the pass cleanly (should not happen)
                passActive = false;
                return 1;
            }
            continue;
        }

        const node = curCursor;
        curCursor++;
        const bd = curBoards() + <usize>(node * CELLS);
        const nodeRoot = curRoot(node);
        const nodeEdge = curEdge(node);

        const groups = enumerateGroups(bd);
        nodesExpanded += <u64>groups;
        spent += groups > 0 ? groups : 1;

        for (let g = 0; g < groups; g++) {
            // REPS stays valid throughout: applyMove/evalBoard do not touch it
            const move = <i32>unchecked(REPS[g]);
            memory.copy(pu8(SCRATCH), bd, CELLS);
            applyMove(pu8(SCRATCH), move);

            const value = evalBoard(pu8(SCRATCH), passNoise);

            if (!evalHasMoves) {
                reportTerminal(nodeRoot, evalRemaining, nodeEdge, move);
                continue;
            }

            // beam admission: quick reject against the current worst
            if (heapSize >= passWidth &&
                value >= unchecked(H_EVAL[<i32>unchecked(H_ORD[0])])) {
                continue;
            }

            if (!dedupInsert(evalHash)) continue;

            let slot: i32;
            if (heapSize < passWidth) {
                slot = heapSize;
                heapSize++;
                unchecked(H_EVAL[slot] = value);
                unchecked(H_ORD[heapSize - 1] = <u32>slot);
                memory.copy(nxtBoards() + <usize>(slot * CELLS), pu8(SCRATCH), CELLS);
                unchecked(H_EDGE_PAR[slot] = nodeEdge);
                unchecked(H_MOVE[slot] = <u8>move);
                setNxtRoot(slot, nodeRoot);
                heapSiftUp(heapSize - 1);
            } else {
                slot = <i32>unchecked(H_ORD[0]); // replace the current worst
                unchecked(H_EVAL[slot] = value);
                memory.copy(nxtBoards() + <usize>(slot * CELLS), pu8(SCRATCH), CELLS);
                unchecked(H_EDGE_PAR[slot] = nodeEdge);
                unchecked(H_MOVE[slot] = <u8>move);
                setNxtRoot(slot, nodeRoot);
                heapSiftDown(0);
            }
        }
    }

    return 0;
}

// ---------------------------------------------------------------------------
// tabu-color random playouts — CPU twin of the WebGPU kernel
// ---------------------------------------------------------------------------

// dominant color of the board (ties -> lower color id); 0 for an empty board
function dominantColor(bd: usize): i32 {
    for (let c = 0; c <= COLORS; c++) unchecked(colorTotal[c] = 0);
    for (let cell = 0; cell < CELLS; cell++) {
        const c = <i32>cellAt(bd, cell);
        unchecked(colorTotal[c] = unchecked(colorTotal[c]) + 1);
    }
    let best = 0, bestCount = 0;
    for (let c = 1; c <= COLORS; c++) {
        if (unchecked(colorTotal[c]) > bestCount) {
            bestCount = unchecked(colorTotal[c]);
            best = c;
        }
    }
    return best;
}

let playoutLastLen: i32 = 0;

// one playout from PLAYOUT_BOARD with the given seed; returns final remaining;
// when record is true, moves are appended to PLAYOUT_LINE starting at index 1
// (index 0 is the caller's root move by convention)
function playoutRun(seed: u32, record: bool): i32 {
    rngSeed(seed);
    const tabu = dominantColor(pu8(PLAYOUT_BOARD));
    let len = 1;

    for (;;) {
        const n = enumerateGroups(pu8(PLAYOUT_BOARD));
        if (n == 0) break;

        // prefer non-tabu groups; fall back to all groups
        let candidates = 0;
        for (let g = 0; g < n; g++) {
            if (<i32>unchecked(REP_COLORS[g]) != tabu) candidates++;
        }

        let pick = 0;
        if (candidates > 0) {
            let target = <i32>(rngNext() % <u32>candidates);
            for (let g = 0; g < n; g++) {
                if (<i32>unchecked(REP_COLORS[g]) != tabu) {
                    if (target == 0) { pick = g; break; }
                    target--;
                }
            }
        } else {
            pick = <i32>(rngNext() % <u32>n);
        }

        const move = <i32>unchecked(REPS[pick]);
        if (record && len < LINE_MAX) unchecked(PLAYOUT_LINE[len] = <u8>move);
        len++;
        applyMove(pu8(PLAYOUT_BOARD), move);
    }

    playoutLastLen = len;
    return boardRemaining(pu8(PLAYOUT_BOARD));
}

// n playouts under root k with seeds seedBase..seedBase+n-1; improves the
// root's best score in place, returns the minimum final reached
export function playoutRoot(k: i32, n: i32, seedBase: u32): i32 {
    if (k < 0 || k >= rootCount) return NO_SCORE;

    let minFinal = NO_SCORE;
    let minSeed: u32 = 0;
    for (let i = 0; i < n; i++) {
        memory.copy(pu8(PLAYOUT_BOARD), pu8(ROOT_BOARD), CELLS);
        applyMove(pu8(PLAYOUT_BOARD), <i32>unchecked(ROOT_REP[k]));
        const final = playoutRun(seedBase + <u32>i, false);
        nodesExpanded += 32; // rough playout cost in expansion units, for the stats line
        if (final < minFinal) {
            minFinal = final;
            minSeed = seedBase + <u32>i;
        }
    }

    if (minFinal < unchecked(ROOT_BEST[k])) {
        // replay the winning seed, recording the line
        memory.copy(pu8(PLAYOUT_BOARD), pu8(ROOT_BOARD), CELLS);
        applyMove(pu8(PLAYOUT_BOARD), <i32>unchecked(ROOT_REP[k]));
        unchecked(PLAYOUT_LINE[0] = unchecked(ROOT_REP[k]));
        const check = playoutRun(minSeed, true);
        if (check == minFinal) {
            unchecked(ROOT_BEST[k] = minFinal);
            unchecked(ROOT_LINE_LEN[k] = <u8>playoutLastLen);
            memory.copy(pu8(ROOT_LINES) + <usize>(k * LINE_MAX), pu8(PLAYOUT_LINE), playoutLastLen);
        }
    }

    return minFinal;
}

// verification path for GPU results: replay `seed` under root k and require the
// final remaining to equal `claimed`; on success the result is merged like a
// CPU playout; returns 1 on exact match, 0 on mismatch (caller disables GPU)
export function playoutVerify(k: i32, seed: u32, claimed: i32): i32 {
    if (k < 0 || k >= rootCount) return 0;

    memory.copy(pu8(PLAYOUT_BOARD), pu8(ROOT_BOARD), CELLS);
    applyMove(pu8(PLAYOUT_BOARD), <i32>unchecked(ROOT_REP[k]));
    unchecked(PLAYOUT_LINE[0] = unchecked(ROOT_REP[k]));
    const final = playoutRun(seed, true);

    if (final != claimed) return 0;

    if (final < unchecked(ROOT_BEST[k])) {
        unchecked(ROOT_BEST[k] = final);
        unchecked(ROOT_LINE_LEN[k] = <u8>playoutLastLen);
        memory.copy(pu8(ROOT_LINES) + <usize>(k * LINE_MAX), pu8(PLAYOUT_LINE), playoutLastLen);
    }

    return 1;
}

// warm start: replays a move line (len cells in IO) on the analysis board and
// merges it into its root move's result if it improves it — used to carry
// knowledge across positions (cache hits, suffixes of previously found lines).
// The line is fully replay-validated, so bogus seeds are rejected, never
// trusted. Returns the line's final remaining, or -1 when it does not apply.
export function seedLine(len: i32): i32 {
    if (len < 1 || len > LINE_MAX) return -1;

    memory.copy(pu8(PLAYOUT_BOARD), pu8(ROOT_BOARD), CELLS);

    // the root move is the group containing the line's first cell; its rep is
    // the group's smallest cell index (board.js scan order)
    const size = floodFill(pu8(PLAYOUT_BOARD), <i32>load<u8>(pu8(IO)));
    if (size < 2) return -1;
    let rep = CELLS;
    for (let i = 0; i < size; i++) {
        const c = <i32>unchecked(GROUP_CELLS[i]);
        if (c < rep) rep = c;
    }
    let root = -1;
    for (let k = 0; k < rootCount; k++) {
        if (<i32>unchecked(ROOT_REP[k]) == rep) { root = k; break; }
    }
    if (root < 0) return -1;

    for (let i = 0; i < len; i++) {
        if (applyMove(pu8(PLAYOUT_BOARD), <i32>load<u8>(pu8(IO) + <usize>i)) == 0) return -1;
    }

    const final = boardRemaining(pu8(PLAYOUT_BOARD));
    if (final < unchecked(ROOT_BEST[root])) {
        unchecked(ROOT_BEST[root] = final);
        unchecked(ROOT_LINE_LEN[root] = <u8>len);
        memory.copy(pu8(ROOT_LINES) + <usize>(root * LINE_MAX), pu8(IO), len);
    }
    return final;
}

// warm start: restores a proof flag from a cached analysis of this very board;
// only applies when the root's current best equals the remembered proven score
export function seedExactByCell(cell: i32, score: i32): i32 {
    for (let k = 0; k < rootCount; k++) {
        if (<i32>unchecked(ROOT_REP[k]) == cell) {
            if (unchecked(ROOT_BEST[k]) == score) {
                unchecked(ROOT_EXACT[k] = 1);
                return 1;
            }
            return 0;
        }
    }
    return 0;
}

// writes the child board after root move k into IO (for the GPU pipeline)
export function childToIO(k: i32): i32 {
    if (k < 0 || k >= rootCount) return 0;
    memory.copy(pu8(IO), pu8(ROOT_BOARD), CELLS);
    applyMove(pu8(IO), <i32>unchecked(ROOT_REP[k]));
    return 1;
}

// ---------------------------------------------------------------------------
// exact solver — budgeted branch & bound DFS with transposition table
// ---------------------------------------------------------------------------

let exActive: bool = false;
let exDepth: i32 = 0;
let exBest: i32 = NO_SCORE;
let exBestLen: i32 = 0;
let exNodes: i32 = 0;
let exBudget: i32 = 0;
let exComplete: bool = false;
let ttStamp: u32 = 0;

// admissible lower bound on the final remaining of a board:
// a color with exactly one cell left can never be removed
function lowerBound(bd: usize): i32 {
    for (let c = 0; c <= COLORS; c++) unchecked(colorTotal[c] = 0);
    for (let cell = 0; cell < CELLS; cell++) {
        const c = <i32>cellAt(bd, cell);
        unchecked(colorTotal[c] = unchecked(colorTotal[c]) + 1);
    }
    let lb = 0;
    for (let c = 1; c <= COLORS; c++) {
        if (unchecked(colorTotal[c]) == 1) lb++;
    }
    return lb;
}

function exPush(bd: usize): void {
    const frame = exDepth;
    memory.copy(pu8(EX_BOARDS) + <usize>(frame * CELLS), bd, CELLS);
    const n = enumerateGroups(pu8(EX_BOARDS) + <usize>(frame * CELLS));
    memory.copy(pu8(EX_REPS) + <usize>(frame * MAX_ROOTS), pu8(REPS), n);
    unchecked(EX_COUNT[frame] = n);
    unchecked(EX_CURSOR[frame] = 0);
    exDepth++;
}

// starts an exact search on the analysis board; budget = max node expansions
export function exactBegin(budget: i32): void {
    exActive = true;
    exComplete = false;
    exBest = NO_SCORE;
    exBestLen = 0;
    exNodes = 0;
    exBudget = budget;
    exDepth = 0;
    ttStamp++;

    // the beam's best-known lines are the starting upper bound
    for (let k = 0; k < rootCount; k++) {
        if (unchecked(ROOT_BEST[k]) < exBest) {
            exBest = unchecked(ROOT_BEST[k]);
        }
    }

    exPush(pu8(ROOT_BOARD));
}

// runs up to `chunk` expansions; returns:
//   -1 still running, -2 stopped on budget (exBest stays a valid upper bound),
//   otherwise the proven optimal remaining
export function exactStep(chunk: i32): i32 {
    if (!exActive) return -2;

    let spent = 0;
    while (spent < chunk) {
        if (exDepth == 0) {
            exActive = false;
            exComplete = true;
            return exBest;
        }

        const frame = exDepth - 1;
        const bd = pu8(EX_BOARDS) + <usize>(frame * CELLS);
        const n = unchecked(EX_COUNT[frame]);

        if (n == 0) {
            // terminal: its value is the remaining count
            const value = boardRemaining(bd);
            if (value < exBest) {
                exBest = value;
                exBestLen = frame;
                for (let d = 0; d < frame; d++) {
                    unchecked(EX_LINE[d] = unchecked(EX_MOVE[d]));
                }
            }
            exDepth--;
            continue;
        }

        const cursor = unchecked(EX_CURSOR[frame]);
        if (cursor >= n) {
            exDepth--;
            continue;
        }
        unchecked(EX_CURSOR[frame] = cursor + 1);

        const move = unchecked(EX_REPS[frame * MAX_ROOTS + cursor]);
        memory.copy(pu8(SCRATCH), bd, CELLS);
        applyMove(pu8(SCRATCH), <i32>move);
        unchecked(EX_MOVE[frame] = move);
        exNodes++;
        spent++;
        nodesExpanded++;

        if (exNodes > exBudget) {
            exActive = false;
            return -2;
        }

        // bound: this subtree cannot beat the best known final
        if (lowerBound(pu8(SCRATCH)) >= exBest) continue;

        // transposition: skip boards already explored in this search
        const hash = boardHash(pu8(SCRATCH));
        const at = <i32>(hash & <u64>TT_MASK);
        if (unchecked(TT_STAMP[at]) == ttStamp && unchecked(TT_KEY[at]) == hash) continue;
        unchecked(TT_STAMP[at] = ttStamp);
        unchecked(TT_KEY[at] = hash);

        if (exDepth < EXACT_STACK) {
            exPush(pu8(SCRATCH));
        }
    }

    return -1;
}

// starts an exact search on the child board after root move k, proving (or
// improving) that single move's score; the move's best-known line is the
// starting upper bound, so the search only explores what could beat it
export function exactBeginChild(k: i32, budget: i32): i32 {
    if (k < 0 || k >= rootCount) return 0;

    exActive = true;
    exComplete = false;
    exBest = unchecked(ROOT_BEST[k]);
    exBestLen = 0;
    exNodes = 0;
    exBudget = budget;
    exDepth = 0;
    ttStamp++;

    memory.copy(pu8(PLAYOUT_BOARD), pu8(ROOT_BOARD), CELLS);
    applyMove(pu8(PLAYOUT_BOARD), <i32>unchecked(ROOT_REP[k]));
    exPush(pu8(PLAYOUT_BOARD));
    return 1;
}

// merges a completed child search into root k: the score is now proven
// optimal for that move (and improved if the proof found something better);
// EX_LINE holds moves from the child position, so the root move is prepended
export function exactMergeChild(k: i32): i32 {
    if (!exComplete || k < 0 || k >= rootCount) return NO_SCORE;

    if (exBest < unchecked(ROOT_BEST[k])) {
        unchecked(ROOT_BEST[k] = exBest);
        unchecked(ROOT_LINES[k * LINE_MAX] = unchecked(ROOT_REP[k]));
        for (let d = 0; d < exBestLen; d++) {
            unchecked(ROOT_LINES[k * LINE_MAX + 1 + d] = unchecked(EX_LINE[d]));
        }
        unchecked(ROOT_LINE_LEN[k] = <u8>(exBestLen + 1));
    }

    unchecked(ROOT_EXACT[k] = 1);
    return exBest;
}

// line seek: like exactBeginChild, but with a known target value — everything
// that cannot reach `target` is pruned, so recovering the optimal line after
// the value solver is cheap. exactStep completing with `target` means the
// line was found and recorded (merge with exactMergeChild)
export function exactChildSeek(k: i32, budget: i32, target: i32): i32 {
    if (k < 0 || k >= rootCount) return 0;

    exActive = true;
    exComplete = false;
    exBest = target + 1;
    exBestLen = 0;
    exNodes = 0;
    exBudget = budget;
    exDepth = 0;
    ttStamp++;

    memory.copy(pu8(PLAYOUT_BOARD), pu8(ROOT_BOARD), CELLS);
    applyMove(pu8(PLAYOUT_BOARD), <i32>unchecked(ROOT_REP[k]));
    exPush(pu8(PLAYOUT_BOARD));
    return 1;
}

// merges a completed exact result into the root table: roots whose best equals
// the proven optimum are flagged exact; returns the optimum (or NO_SCORE)
export function exactMerge(): i32 {
    if (!exComplete) return NO_SCORE;

    // the proven-optimal line also improves its root move if it is better
    if (exBestLen > 0) {
        const firstMove = unchecked(EX_LINE[0]);
        for (let k = 0; k < rootCount; k++) {
            if (unchecked(ROOT_REP[k]) == firstMove) {
                if (exBest < unchecked(ROOT_BEST[k])) {
                    unchecked(ROOT_BEST[k] = exBest);
                    unchecked(ROOT_LINE_LEN[k] = <u8>exBestLen);
                    memory.copy(pu8(ROOT_LINES) + <usize>(k * LINE_MAX), pu8(EX_LINE), exBestLen);
                }
                break;
            }
        }
    }

    for (let k = 0; k < rootCount; k++) {
        if (unchecked(ROOT_BEST[k]) == exBest) {
            unchecked(ROOT_EXACT[k] = 1);
        }
    }

    return exBest;
}

// ---------------------------------------------------------------------------
// value solver — full enumeration with a persistent value memo
//
// Computes the EXACT optimal remaining after one root move by enumerating the
// whole reachable subspace, memoizing every board's value (no alpha pruning,
// so memo entries are context-free and reusable). The memo persists across
// root moves of the same position AND across budget escalations: sibling
// subtrees overlap massively, so proving all moves costs little more than
// proving one — and no position is ever analysed twice. This is the record
// that stops the engine from cycling over the same small-board states.
// ---------------------------------------------------------------------------

const VTT_CAP: i32 = 1 << 21;       // value memo (direct-mapped)
const VTT_MASK: i32 = VTT_CAP - 1;
const VTT_KEY = new StaticArray<u64>(VTT_CAP);
const VTT_VAL = new StaticArray<u8>(VTT_CAP);
const VTT_STAMP = new StaticArray<u32>(VTT_CAP);
const EX_MIN = new StaticArray<i32>(EXACT_STACK);
const EX_HASH = new StaticArray<u64>(EXACT_STACK);

let vsActive: bool = false;
let vsDepth: i32 = 0;
let vsNodes: i32 = 0;
let vsBudget: i32 = 0;
let vttStamp: u32 = 0;
let vsRootHash: u64 = 0;

function vttLookup(hash: u64): i32 {
    const at = <i32>(hash & <u64>VTT_MASK);
    if (unchecked(VTT_STAMP[at]) == vttStamp && unchecked(VTT_KEY[at]) == hash) {
        return <i32>unchecked(VTT_VAL[at]);
    }
    return -1;
}

function vttStore(hash: u64, value: i32): void {
    const at = <i32>(hash & <u64>VTT_MASK);
    unchecked(VTT_STAMP[at] = vttStamp);
    unchecked(VTT_KEY[at] = hash);
    unchecked(VTT_VAL[at] = <u8>value);
}

// pushes a board, or resolves it immediately; returns -1 when pushed,
// the board's exact value on a memo hit or terminal
function vsPush(bd: usize): i32 {
    const hash = boardHash(bd);
    const memo = vttLookup(hash);
    if (memo >= 0) return memo;

    const frame = vsDepth;
    memory.copy(pu8(EX_BOARDS) + <usize>(frame * CELLS), bd, CELLS);
    const n = enumerateGroups(pu8(EX_BOARDS) + <usize>(frame * CELLS));

    if (n == 0) {
        const value = boardRemaining(bd);
        vttStore(hash, value);
        return value;
    }

    memory.copy(pu8(EX_REPS) + <usize>(frame * MAX_ROOTS), pu8(REPS), n);
    unchecked(EX_COUNT[frame] = n);
    unchecked(EX_CURSOR[frame] = 0);
    unchecked(EX_MIN[frame] = NO_SCORE);
    unchecked(EX_HASH[frame] = hash);
    vsDepth++;
    return -1;
}

// starts a value solve of the child after root move k; the memo is kept when
// the analysis position is unchanged, so successive moves and retries reuse
// all earlier work. Returns -3 on a bad k, -1 when running (drive with
// vsStep), or the immediate value
export function vsBegin(k: i32, budget: i32): i32 {
    if (k < 0 || k >= rootCount) return -3;

    const rootHash = boardHash(pu8(ROOT_BOARD));
    if (rootHash != vsRootHash || vttStamp == 0) {
        vttStamp++;
        vsRootHash = rootHash;
    }

    vsNodes = 0;
    vsBudget = budget;
    vsDepth = 0;

    memory.copy(pu8(PLAYOUT_BOARD), pu8(ROOT_BOARD), CELLS);
    applyMove(pu8(PLAYOUT_BOARD), <i32>unchecked(ROOT_REP[k]));

    const immediate = vsPush(pu8(PLAYOUT_BOARD));
    vsActive = immediate < 0;
    return immediate;
}

// runs up to `chunk` expansions; -1 still running, -2 budget exhausted
// (memoized work is kept for the retry), else the proven exact value
export function vsStep(chunk: i32): i32 {
    if (!vsActive) return -2;

    let spent = 0;
    while (spent < chunk) {
        const frame = vsDepth - 1;
        const n = unchecked(EX_COUNT[frame]);
        const cursor = unchecked(EX_CURSOR[frame]);

        if (cursor < n) {
            unchecked(EX_CURSOR[frame] = cursor + 1);
            memory.copy(pu8(SCRATCH), pu8(EX_BOARDS) + <usize>(frame * CELLS), CELLS);
            applyMove(pu8(SCRATCH), <i32>unchecked(EX_REPS[frame * MAX_ROOTS + cursor]));
            vsNodes++;
            spent++;
            nodesExpanded++;

            if (vsNodes > vsBudget) {
                vsActive = false;
                return -2;
            }

            if (vsDepth >= EXACT_STACK) { // cannot happen: depth <= 73
                vsActive = false;
                return -2;
            }

            const value = vsPush(pu8(SCRATCH));
            if (value >= 0 && value < unchecked(EX_MIN[frame])) {
                unchecked(EX_MIN[frame] = value);
            }
        } else {
            // frame fully enumerated — memoize and merge into the parent
            const value = unchecked(EX_MIN[frame]);
            vttStore(unchecked(EX_HASH[frame]), value);
            vsDepth--;

            if (vsDepth == 0) {
                vsActive = false;
                return value;
            }
            if (value < unchecked(EX_MIN[vsDepth - 1])) {
                unchecked(EX_MIN[vsDepth - 1] = value);
            }
        }
    }

    return -1;
}

// ---------------------------------------------------------------------------
// result collection
// ---------------------------------------------------------------------------

// IO layout (little-endian), parsed by src/scripts/engine/worker.js:
//   0  u32 rootCount
//   4  u32 nodesLo
//   8  u32 nodesHi
//   12 u32 layerDepth
//   16 u32 passWidth
//   20 u32 remaining (analysis root)
//   24 records, 8 bytes per root: rep u8, color u8, size u8, flags u8, best i32
//   then per root: cellsLen u8 + cells
//   then per root: lineLen u8 + line
export function collect(): i32 {
    const io = pu8(IO);
    store<u32>(io, <u32>rootCount);
    store<u32>(io + 4, <u32>(nodesExpanded & 0xFFFFFFFF));
    store<u32>(io + 8, <u32>(nodesExpanded >> 32));
    store<u32>(io + 12, <u32>layerDepth);
    store<u32>(io + 16, <u32>passWidth);
    store<u32>(io + 20, <u32>rootRemaining);

    let at: usize = 24;
    for (let k = 0; k < rootCount; k++) {
        store<u8>(io + at, unchecked(ROOT_REP[k]));
        store<u8>(io + at + 1, unchecked(ROOT_COLOR[k]));
        store<u8>(io + at + 2, unchecked(ROOT_SIZE[k]));
        store<u8>(io + at + 3, unchecked(ROOT_EXACT[k]));
        store<i32>(io + at + 4, unchecked(ROOT_BEST[k]));
        at += 8;
    }

    for (let k = 0; k < rootCount; k++) {
        const len = <i32>unchecked(ROOT_CELLS_LEN[k]);
        store<u8>(io + at, <u8>len);
        at++;
        memory.copy(io + at, pu8(ROOT_CELLS) + <usize>unchecked(ROOT_CELLS_OFF[k]), len);
        at += len;
    }

    for (let k = 0; k < rootCount; k++) {
        const len = <i32>unchecked(ROOT_LINE_LEN[k]);
        store<u8>(io + at, <u8>len);
        at++;
        memory.copy(io + at, pu8(ROOT_LINES) + <usize>(k * LINE_MAX), len);
        at += len;
    }

    return <i32>at;
}

// ---------------------------------------------------------------------------
// direct board helpers for the Node test suite
// ---------------------------------------------------------------------------

// applies a move to the board in IO, in place; returns removed group size
export function testApply(cell: i32): i32 {
    return applyMove(pu8(IO), cell);
}

// enumerates groups of the board in IO; returns count, reps/colors/sizes at IO+256/384/512
export function testEnumerate(): i32 {
    const n = enumerateGroups(pu8(IO));
    const io = pu8(IO);
    for (let g = 0; g < n; g++) {
        store<u8>(io + 256 + <usize>g, unchecked(REPS[g]));
        store<u8>(io + 384 + <usize>g, unchecked(REP_COLORS[g]));
        store<u8>(io + 512 + <usize>g, unchecked(REP_SIZES[g]));
    }
    return n;
}

// flood fill on the IO board; returns size, cells at IO+256
export function testGroup(cell: i32): i32 {
    const n = floodFill(pu8(IO), cell);
    memory.copy(pu8(IO) + 256, pu8(GROUP_CELLS), n);
    return n;
}

export function testHash(): u32 {
    const h = boardHash(pu8(IO));
    return <u32>(h ^ (h >> 32));
}

// one recorded playout on the IO board (no root move); returns final remaining,
// move line at IO+257 prefixed by its length at IO+256
export function testPlayout(seed: u32): i32 {
    memory.copy(pu8(PLAYOUT_BOARD), pu8(IO), CELLS);
    unchecked(PLAYOUT_LINE[0] = 0);
    const final = playoutRun(seed, true);
    const len = playoutLastLen > 0 ? playoutLastLen - 1 : 0;
    store<u8>(pu8(IO) + 256, <u8>len);
    memory.copy(pu8(IO) + 257, pu8(PLAYOUT_LINE) + 1, len);
    return final;
}
