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
 * Date: Sun Jul 12, 2026
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
const TT_WAYS: i32 = 4;
const TT_SETS: i32 = TT_CAP / TT_WAYS;
const TT_SET_MASK: i32 = TT_SETS - 1;
const EXACT_STACK: i32 = 80;        // exact solver DFS depth bound
const PERMANENT_BEAM_REMAINING: i32 = 30; // separator-rich region for heuristic scans
const PERMANENT_EXACT_REMAINING: i32 = 8;  // recompute once when a path enters this late zone

const NO_EDGE: u32 = 0xFFFFFFFF;
const NO_SCORE: i32 = 0x7FFFFFFF;
const TABU_WEIGHT: i32 = 8;          // non-tabu groups are favored, never forced

// evaluation weights (see docs/ENGINE.md "Evaluation function"); tunable via
// setWeights, defaults tuned with tools/engine.tune.mjs on 2026-07-11:
// 55/60 random boards cleared, mean 0.20 left under the validation schedule
let W_DEAD: f32 = 6.0;              // cells proved permanently unremovable
let W_SINGLE: f32 = 2.0;            // size-1 components of otherwise pairable colors
let W_FRAG: f32 = 0.6;              // extra components per color beyond the first
let W_FROZEN: f32 = 0.5;            // cells of a "frozen" color: >= 2 cells but no playable pair
let NOISE_SCALE: f32 = 1.2;         // eval jitter amplitude of stochastic diversification passes
let EVAL_EXTRAS_NONNEGATIVE: bool = true;

// ---------------------------------------------------------------------------
// static buffers (runtime "stub": allocated once at start, never freed)
// ---------------------------------------------------------------------------

const IO = new StaticArray<u8>(16384);          // JS <-> WASM exchange buffer
const ROOT_BOARD = new StaticArray<u8>(CELLS);  // the position under analysis

const ZOB = new StaticArray<u64>(CELLS * COLORS);
const CELL_COL_BIT = new StaticArray<u16>(CELLS);

// shared scan scratch
const VISITED = new StaticArray<u8>(CELLS);
const STACK = new StaticArray<u8>(CELLS);
const GROUP_CELLS = new StaticArray<u8>(CELLS);
const REPS = new StaticArray<u8>(MAX_ROOTS);
const REP_COLORS = new StaticArray<u8>(MAX_ROOTS);
const REP_SIZES = new StaticArray<u8>(MAX_ROOTS);
const REP_OFFSETS = new StaticArray<u8>(MAX_ROOTS);
const ENUM_CELLS = new StaticArray<u8>(CELLS);

// Sound permanent-cell lower-bound scratch. Globally singleton colors seed
// FORCED_CELL; fixed-point separator rules can prove additional cells stuck.
const FORCED_CELL = new StaticArray<u8>(CELLS);
const POT_COLOR_LAST = new StaticArray<u8>(COLORS + 1);
const POT_ROW_MASK = new StaticArray<u16>(CELLS);
const POT_COL_FORCED = new StaticArray<u8>(SIZE);
const POT_COL_COLOR_ROWS = new StaticArray<u16>(SIZE * (COLORS + 1));
const POT_COLORS = new StaticArray<u8>(SIZE);
const POT_SUFFIX_COLORS = new StaticArray<u8>(SIZE + 1);

// beam arenas — two banks flipped between layers
const BOARDS_A = new StaticArray<u8>(MAX_WIDTH * CELLS);
const BOARDS_B = new StaticArray<u8>(MAX_WIDTH * CELLS);
const META_ROOT_A = new StaticArray<u8>(MAX_WIDTH);
const META_ROOT_B = new StaticArray<u8>(MAX_WIDTH);
const META_EDGE_A = new StaticArray<u32>(MAX_WIDTH);
const META_EDGE_B = new StaticArray<u32>(MAX_WIDTH);
const META_REMAIN_A = new StaticArray<u8>(MAX_WIDTH);
const META_REMAIN_B = new StaticArray<u8>(MAX_WIDTH);

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
const ROOT_LOWER = new StaticArray<u8>(MAX_ROOTS);
const ROOT_EXACT = new StaticArray<u8>(MAX_ROOTS);
const ROOT_LINE_LEN = new StaticArray<u8>(MAX_ROOTS);
const ROOT_LINES = new StaticArray<u8>(MAX_ROOTS * LINE_MAX);
const ROOT_CELLS_LEN = new StaticArray<u8>(MAX_ROOTS);
const ROOT_CELLS = new StaticArray<u8>(CELLS);     // root groups are disjoint, 144 cells suffice
const ROOT_CELLS_OFF = new StaticArray<u16>(MAX_ROOTS);

// scratch boards
const SCRATCH = new StaticArray<u8>(CELLS);        // candidate child during expansion
const PLAYOUT_BOARD = new StaticArray<u8>(CELLS);
const PLAYOUT_START = new StaticArray<u8>(CELLS);
const PLAYOUT_LINE = new StaticArray<u8>(LINE_MAX);
const PROBE_REPS = new StaticArray<u8>(MAX_ROOTS);
// Tail moves of an arbitrary fixed prefix. JS writes moves after root k to
// IO[0..prefixLen); validation copies them here before an API is allowed to
// overwrite IO with a materialized board or other output.
const PREFIX_MOVES = new StaticArray<u8>(LINE_MAX);

// exact solver
const EX_BOARDS = new StaticArray<u8>(EXACT_STACK * CELLS);
const EX_REPS = new StaticArray<u8>(EXACT_STACK * MAX_ROOTS);
const EX_COUNT = new StaticArray<i32>(EXACT_STACK);
const EX_CURSOR = new StaticArray<i32>(EXACT_STACK);
const EX_MOVE = new StaticArray<u8>(EXACT_STACK);
const EX_LINE = new StaticArray<u8>(LINE_MAX);
// A live target seek must retain its own prefix: IO and PREFIX_MOVES are shared
// scratch and may be reused between exactStep() slices.
const EX_PREFIX_MOVES = new StaticArray<u8>(LINE_MAX);
const EX_CHILD_LOWER = new StaticArray<u8>(EXACT_STACK * MAX_ROOTS);
const EX_REMAINING = new StaticArray<u8>(EXACT_STACK);
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
function pu16(arr: StaticArray<u16>): usize { return changetype<usize>(arr); }

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
    for (let cell = 0; cell < CELLS; cell++) {
        const bit: u32 = <u32>1 << <u32>(cell / SIZE);
        unchecked(CELL_COL_BIT[cell] = <u16>bit);
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

        const row = cell % SIZE;
        if (cell >= SIZE && cellAt(bd, cell - SIZE) == color && !unchecked(VISITED[cell - SIZE])) {
            unchecked(VISITED[cell - SIZE] = 1); unchecked(STACK[sp++] = <u8>(cell - SIZE));
        }
        if (cell < CELLS - SIZE && cellAt(bd, cell + SIZE) == color && !unchecked(VISITED[cell + SIZE])) {
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
function collapse(bd: usize, touched: u32): void {
    let emptiedColumn = false;
    for (let col = 0; col < SIZE; col++) {
        if (!(touched & (1 << col))) continue;
        const base = bd + <usize>(col * SIZE);
        let row = 0;
        for (let j = 0; j < SIZE; j++) {
            const v = load<u8>(base + <usize>j);
            if (v != 0) {
                // Before the first gap, the cell is already in its final
                // place. After a gap, move it down and clear only its old
                // slot. This preserves stable gravity while avoiding the old
                // clear-and-rewrite pair for every untouched prefix cell.
                if (row != j) {
                    store<u8>(base + <usize>row, v);
                    store<u8>(base + <usize>j, 0);
                }
                row++;
            }
        }
        if (row == 0) emptiedColumn = true;
    }

    // Stable horizontal compaction is necessary only when this move emptied
    // a column. All other columns were already normalized in the parent.
    if (!emptiedColumn) return;

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
    const color = cellAt(bd, cell);
    if (color == 0) return 0;

    // Clearing a cell when it is discovered doubles as the visited mark.
    // Search callers only pass legal representatives; for the public rule
    // helpers an isolated cell is restored below, keeping illegal moves inert.
    unchecked(STACK[0] = <u8>cell);
    setCellAt(bd, cell, 0);
    let sp = 1;
    let size = 0;
    let touched: u32 = 0;

    while (sp > 0) {
        const c = <i32>unchecked(STACK[--sp]);
        size++;
        touched |= <u32>unchecked(CELL_COL_BIT[c]);
        const row = c % SIZE;
        if (c >= SIZE && cellAt(bd, c - SIZE) == color) {
            setCellAt(bd, c - SIZE, 0); unchecked(STACK[sp++] = <u8>(c - SIZE));
        }
        if (c < CELLS - SIZE && cellAt(bd, c + SIZE) == color) {
            setCellAt(bd, c + SIZE, 0); unchecked(STACK[sp++] = <u8>(c + SIZE));
        }
        if (row > 0 && cellAt(bd, c - 1) == color) {
            setCellAt(bd, c - 1, 0); unchecked(STACK[sp++] = <u8>(c - 1));
        }
        if (row < SIZE - 1 && cellAt(bd, c + 1) == color) {
            setCellAt(bd, c + 1, 0); unchecked(STACK[sp++] = <u8>(c + 1));
        }
    }

    if (size < 2) {
        setCellAt(bd, cell, color);
        return 0;
    }
    collapse(bd, touched);
    return size;
}

// all clickable groups in board.js scan order (ascending cell index, rep = first
// cell met by the scan); fills REPS/REP_COLORS/REP_SIZES, returns group count
function enumerateGroups(bd: usize): i32 {
    memory.fill(pu8(VISITED), 0, CELLS);
    let count = 0;
    let memberCount = 0;

    for (let cell = 0; cell < CELLS; cell++) {
        if (unchecked(VISITED[cell])) continue;
        const color = cellAt(bd, cell);
        if (color == 0) continue;

        unchecked(VISITED[cell] = 1);
        unchecked(STACK[0] = <u8>cell);
        const memberOff = memberCount;
        let sp = 1, size = 0;
        while (sp > 0) {
            const c = <i32>unchecked(STACK[--sp]);
            size++;
            unchecked(ENUM_CELLS[memberCount++] = <u8>c);
            const row = c % SIZE;
            if (c >= SIZE && cellAt(bd, c - SIZE) == color && !unchecked(VISITED[c - SIZE])) {
                unchecked(VISITED[c - SIZE] = 1); unchecked(STACK[sp++] = <u8>(c - SIZE));
            }
            if (c < CELLS - SIZE && cellAt(bd, c + SIZE) == color && !unchecked(VISITED[c + SIZE])) {
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
            unchecked(REP_OFFSETS[count] = <u8>memberOff);
            count++;
        } else {
            // Only playable components need retained members. Reuse the slot
            // occupied by a singleton for the next component.
            memberCount = memberOff;
        }
    }

    return count;
}

// Removes group g from the board most recently passed to enumerateGroups.
// Its member cells are already known, so no second flood fill is required.
function applyEnumeratedMove(bd: usize, g: i32): i32 {
    const size = <i32>unchecked(REP_SIZES[g]);
    const off = <i32>unchecked(REP_OFFSETS[g]);
    let touched: u32 = 0;
    for (let k = 0; k < size; k++) {
        const cell = <i32>unchecked(ENUM_CELLS[off + k]);
        setCellAt(bd, cell, 0);
        touched |= <u32>unchecked(CELL_COL_BIT[cell]);
    }
    collapse(bd, touched);
    return size;
}

// ---------------------------------------------------------------------------
// evaluation — one scan computing components, remaining, hash and mobility
// ---------------------------------------------------------------------------

let evalRemaining: i32 = 0;
let evalHash: u64 = 0;
let evalHasMoves: bool = false;
let evalLower: i32 = 0;

const colorTotal = new StaticArray<i32>(COLORS + 1);
const colorComps = new StaticArray<i32>(COLORS + 1);
const colorHasPair = new StaticArray<i32>(COLORS + 1);

// A slab separated by color-disjoint cuts cannot ever interact with outside
// columns. If it has no legal pair now, no move can change it, so every cell
// in the slab is permanent. Returns newly marked cells.
function seedImmutableSlab(bd: usize, firstCol: i32, lastCol: i32): i32 {
    let hasPair = false;
    for (let col = firstCol; col <= lastCol && !hasPair; col++) {
        for (let row = 0; row < SIZE; row++) {
            const cell = col * SIZE + row;
            const color = cellAt(bd, cell);
            if (color == 0) break;
            if (row > 0 && cellAt(bd, cell - 1) == color) { hasPair = true; break; }
            if (col > firstCol && cellAt(bd, cell - SIZE) == color) { hasPair = true; break; }
        }
    }
    if (hasPair) return 0;

    let added = 0;
    for (let col = firstCol; col <= lastCol; col++) {
        for (let row = 0; row < SIZE; row++) {
            const cell = col * SIZE + row;
            if (cellAt(bd, cell) == 0) break;
            if (!unchecked(FORCED_CELL[cell])) {
                unchecked(FORCED_CELL[cell] = 1);
                added++;
            }
        }
    }
    return added;
}

// Strengthens the globally-singleton lower bound to a fixed point of cells
// separated by already-proven permanent blockers. `colorTotal` must describe
// bd on entry. Every returned cell is impossible to remove under any future
// sequence, so the count is admissible for exact pruning.
//
// A cell's possible future rows are over-approximated by [number of forced
// cells below, current row]. Vertical order is invariant; horizontally, a
// column containing a forced cell can never disappear. If no same-color cell
// can possibly touch through those row intervals and barriers, the cell is
// permanent too. Batched iteration derives R-B-R sandwiches, permanent-wall
// partitions, height mismatches and multi-wave cascades without circular
// reasoning.
function permanentLower(bd: usize): i32 {
    memory.fill(pu8(FORCED_CELL), 0, CELLS);
    memory.fill(pu8(POT_COLOR_LAST), 0, COLORS + 1);
    memory.fill(pu8(POT_COLORS), 0, SIZE);

    let columns = 0;
    for (let col = 0; col < SIZE; col++) {
        if (cellAt(bd, col * SIZE) == 0) break;
        let colors: u8 = 0;
        for (let row = 0; row < SIZE; row++) {
            const cell = col * SIZE + row;
            const color = <i32>cellAt(bd, cell);
            if (color == 0) break;
            unchecked(POT_COLOR_LAST[color] = <u8>cell);
            colors |= <u8>(<u32>1 << <u32>color);
        }
        unchecked(POT_COLORS[col] = colors);
        columns++;
    }

    let forced = 0;
    for (let color = 1; color <= COLORS; color++) {
        if (unchecked(colorTotal[color]) == 1) {
            const cell = <i32>unchecked(POT_COLOR_LAST[color]);
            unchecked(FORCED_CELL[cell] = 1);
            forced++;
        }
    }

    // Color-disjoint cuts define independent slabs. A slab with no legal
    // pair is immutable and supplies permanent seeds even when no color is
    // globally singleton (for example a checkerboard terminal island).
    if (columns > 0) {
        unchecked(POT_SUFFIX_COLORS[columns] = 0);
        for (let col = columns - 1; col >= 0; col--) {
            unchecked(POT_SUFFIX_COLORS[col] =
                unchecked(POT_SUFFIX_COLORS[col + 1]) | unchecked(POT_COLORS[col]));
        }
        let first = 0;
        let left: u8 = 0;
        for (let col = 0; col < columns - 1; col++) {
            left |= unchecked(POT_COLORS[col]);
            if ((left & unchecked(POT_SUFFIX_COLORS[col + 1])) == 0) {
                forced += seedImmutableSlab(bd, first, col);
                first = col + 1;
                left = 0;
            }
        }
        forced += seedImmutableSlab(bd, first, columns - 1);
    }

    if (forced == 0) return 0;

    for (;;) {
        memory.fill(pu8(POT_COL_FORCED), 0, SIZE);
        memory.fill(pu16(POT_COL_COLOR_ROWS), 0, SIZE * (COLORS + 1) * sizeof<u16>());

        // A surviving cell can only fall from its current row to the number
        // of already-forced cells below it. ROW_MASK over-approximates every
        // future row it may occupy. A forced cell makes its column permanent.
        for (let col = 0; col < SIZE; col++) {
            let forcedBelow = 0;
            for (let row = 0; row < SIZE; row++) {
                const cell = col * SIZE + row;
                const color = <i32>cellAt(bd, cell);
                if (color == 0) break;
                const high = (<u32>1 << <u32>(row + 1)) - 1;
                const low = (<u32>1 << <u32>forcedBelow) - 1;
                const rows = <u16>(high ^ low);
                unchecked(POT_ROW_MASK[cell] = rows);
                const at = col * (COLORS + 1) + color;
                unchecked(POT_COL_COLOR_ROWS[at] = unchecked(POT_COL_COLOR_ROWS[at]) | rows);
                if (unchecked(FORCED_CELL[cell]) == 1) {
                    unchecked(POT_COL_FORCED[col] = 1);
                    forcedBelow++;
                }
            }
        }

        let pending = 0;
        for (let col = 0; col < SIZE; col++) {
            if (cellAt(bd, col * SIZE) == 0) break;
            for (let row = 0; row < SIZE; row++) {
                const cell = col * SIZE + row;
                const color = <i32>cellAt(bd, cell);
                if (color == 0) break;
                if (unchecked(FORCED_CELL[cell]) != 0) continue;

                let canTouch = false;

                // Vertical order is invariant. The first forced cell remains
                // a possible neighbor itself, but permanently blocks beyond.
                for (let otherRow = row - 1; otherRow >= 0; otherRow--) {
                    const other = col * SIZE + otherRow;
                    if (<i32>cellAt(bd, other) == color) { canTouch = true; break; }
                    if (unchecked(FORCED_CELL[other]) == 1) break;
                }
                if (!canTouch) {
                    for (let otherRow = row + 1; otherRow < SIZE; otherRow++) {
                        const other = col * SIZE + otherRow;
                        if (cellAt(bd, other) == 0) break;
                        if (<i32>cellAt(bd, other) == color) { canTouch = true; break; }
                        if (unchecked(FORCED_CELL[other]) == 1) break;
                    }
                }

                // Non-permanent columns may disappear while order stays
                // stable. Row-range overlap is necessary for a horizontal
                // pair. The first permanent column is reachable; none beyond
                // it can ever become adjacent to this cell's column.
                if (!canTouch) {
                    for (let otherCol = col - 1; otherCol >= 0; otherCol--) {
                        const at = otherCol * (COLORS + 1) + color;
                        if ((unchecked(POT_COL_COLOR_ROWS[at]) & unchecked(POT_ROW_MASK[cell])) != 0) {
                            canTouch = true;
                            break;
                        }
                        if (unchecked(POT_COL_FORCED[otherCol])) break;
                    }
                }
                if (!canTouch) {
                    for (let otherCol = col + 1; otherCol < SIZE; otherCol++) {
                        if (cellAt(bd, otherCol * SIZE) == 0) break;
                        const at = otherCol * (COLORS + 1) + color;
                        if ((unchecked(POT_COL_COLOR_ROWS[at]) & unchecked(POT_ROW_MASK[cell])) != 0) {
                            canTouch = true;
                            break;
                        }
                        if (unchecked(POT_COL_FORCED[otherCol])) break;
                    }
                }

                // Mark only after all cells in this wave have been tested;
                // pending deductions cannot justify one another cyclically.
                if (!canTouch) {
                    unchecked(FORCED_CELL[cell] = 2);
                    pending++;
                }
            }
        }

        if (pending == 0) break;
        for (let cell = 0; cell < CELLS; cell++) {
            if (unchecked(FORCED_CELL[cell]) == 2) unchecked(FORCED_CELL[cell] = 1);
        }
        forced += pending;
    }

    return forced;
}

// Sound delete-relaxation lower bound. A marked cell is only *potentially*
// removable; the least fixed point deliberately ignores conflicts between
// removals and therefore over-approximates every real play sequence.
//
// Seed cells which belong to a legal group now. A same-column pair may become
// adjacent after all cells between it are potentially removable. Two cells in
// different columns may meet after every intervening column is potentially
// empty and their possible future row intervals overlap. Deductions are
// applied in waves so they cannot justify one another circularly.
//
// To see why the complement is permanent, assume a real sequence removes an
// unmarked cell for the first time. Its same-color group partner is vertically
// adjacent after only previously marked intervening cells disappeared, or is
// horizontally adjacent after only previously marked columns/cells changed
// its column and row. The corresponding rule would have marked it: a
// contradiction. Consequently every unmarked occupied cell contributes one
// to an admissible terminal lower bound.
function potentialRemovalLower(bd: usize): i32 {
    // FORCED_CELL is scratch. permanentLower() has already returned before
    // this complementary analysis is called, so the two meanings never
    // overlap live.
    memory.fill(pu8(FORCED_CELL), 0, CELLS);
    let columns = 0;
    while (columns < SIZE && cellAt(bd, columns * SIZE) != 0) columns++;

    // Every member of a currently legal group has an equal-color neighbor.
    for (let col = 0; col < columns; col++) {
        for (let row = 0; row < SIZE; row++) {
            const cell = col * SIZE + row;
            const color = cellAt(bd, cell);
            if (color == 0) break;
            if ((row > 0 && cellAt(bd, cell - 1) == color) ||
                (row + 1 < SIZE && cellAt(bd, cell + 1) == color) ||
                (col > 0 && cellAt(bd, cell - SIZE) == color) ||
                (col + 1 < columns && cellAt(bd, cell + SIZE) == color)) {
                unchecked(FORCED_CELL[cell] = 1);
            }
        }
    }

    for (;;) {
        // Build each column/color's union of possible future rows once per
        // wave. POT_COL_FORCED means "the whole column is potentially
        // removable" in this complementary analysis. This turns the former
        // cell-pair/intervening-column scan into a handful of bit tests.
        memory.fill(pu8(POT_COL_FORCED), 0, SIZE);
        memory.fill(pu16(POT_COL_COLOR_ROWS), 0,
            SIZE * (COLORS + 1) * sizeof<u16>());
        for (let col = 0; col < columns; col++) {
            let notPotentialBelow = 0;
            let allPotential = true;
            for (let row = 0; row < SIZE; row++) {
                const cell = col * SIZE + row;
                const color = <i32>cellAt(bd, cell);
                if (color == 0) break;
                const high = (<u32>1 << <u32>(row + 1)) - 1;
                const low = (<u32>1 << <u32>notPotentialBelow) - 1;
                const rows = <u16>(high ^ low);
                unchecked(POT_ROW_MASK[cell] = rows);
                const at = col * (COLORS + 1) + color;
                unchecked(POT_COL_COLOR_ROWS[at] =
                    unchecked(POT_COL_COLOR_ROWS[at]) | rows);
                if (unchecked(FORCED_CELL[cell]) != 1) {
                    notPotentialBelow++;
                    allPotential = false;
                }
            }
            if (allPotential) unchecked(POT_COL_FORCED[col] = 1);
        }

        let pending = 0;
        for (let col = 0; col < columns; col++) {
            for (let row = 0; row < SIZE; row++) {
                const cell = col * SIZE + row;
                const color = cellAt(bd, cell);
                if (color == 0) break;
                if (unchecked(FORCED_CELL[cell]) != 0) continue;
                let canRemove = false;

                // Scan vertically only until the first not-yet-potential
                // blocker. Encountering the same color first supplies a
                // partner; no quadratic between-pair scan is needed.
                for (let otherRow = row - 1; otherRow >= 0; otherRow--) {
                    const other = col * SIZE + otherRow;
                    if (cellAt(bd, other) == color) {
                        canRemove = true;
                        break;
                    }
                    if (unchecked(FORCED_CELL[other]) != 1) break;
                }
                if (!canRemove) {
                    for (let otherRow = row + 1; otherRow < SIZE; otherRow++) {
                        const other = col * SIZE + otherRow;
                        if (cellAt(bd, other) == 0) break;
                        if (cellAt(bd, other) == color) {
                            canRemove = true;
                            break;
                        }
                        if (unchecked(FORCED_CELL[other]) != 1) break;
                    }
                }

                // Non-potential columns are barriers. The first such column
                // remains a possible partner; only fully potential columns
                // permit looking farther. Row-mask overlap is exactly the
                // relaxed interval test described above.
                const rows = unchecked(POT_ROW_MASK[cell]);
                if (!canRemove) {
                    for (let otherCol = col - 1; otherCol >= 0; otherCol--) {
                        const at = otherCol * (COLORS + 1) + <i32>color;
                        if ((unchecked(POT_COL_COLOR_ROWS[at]) & rows) != 0) {
                            canRemove = true;
                            break;
                        }
                        if (!unchecked(POT_COL_FORCED[otherCol])) break;
                    }
                }
                if (!canRemove) {
                    for (let otherCol = col + 1; otherCol < columns; otherCol++) {
                        const at = otherCol * (COLORS + 1) + <i32>color;
                        if ((unchecked(POT_COL_COLOR_ROWS[at]) & rows) != 0) {
                            canRemove = true;
                            break;
                        }
                        if (!unchecked(POT_COL_FORCED[otherCol])) break;
                    }
                }

                // Value 2 is invisible to every deduction in this wave.
                if (canRemove) {
                    unchecked(FORCED_CELL[cell] = 2);
                    pending++;
                }
            }
        }

        if (pending == 0) break;
        for (let cell = 0; cell < CELLS; cell++) {
            if (unchecked(FORCED_CELL[cell]) == 2) unchecked(FORCED_CELL[cell] = 1);
        }
    }

    let lower = 0;
    for (let cell = 0; cell < CELLS; cell++) {
        if (cellAt(bd, cell) != 0 && unchecked(FORCED_CELL[cell]) == 0) lower++;
    }
    return lower;
}

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
            const row = c % SIZE;
            if (c >= SIZE && cellAt(bd, c - SIZE) == color && !unchecked(VISITED[c - SIZE])) {
                unchecked(VISITED[c - SIZE] = 1); unchecked(STACK[sp++] = <u8>(c - SIZE));
            }
            if (c < CELLS - SIZE && cellAt(bd, c + SIZE) == color && !unchecked(VISITED[c + SIZE])) {
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

    let singletonColors = 0;
    let frag = 0;   // components beyond the first, per color
    let frozen = 0; // cells of colors with >= 2 cells but no playable pair anywhere:
                    // only a gravity merge can save them, most end up as leftovers
    for (let c = 1; c <= COLORS; c++) {
        const total = unchecked(colorTotal[c]);
        if (total == 1) singletonColors++;
        else if (total > 1 && !unchecked(colorHasPair[c])) frozen += total;
        const comps = unchecked(colorComps[c]);
        if (comps > 1) frag += comps - 1;
    }

    const forced = remaining <= PERMANENT_BEAM_REMAINING
        ? permanentLower(bd) : singletonColors;
    evalLower = forced;

    let value = <f32>remaining
        + W_DEAD * <f32>forced
        + W_SINGLE * <f32>(singles - forced)
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
    if (ASC_FEATURE_SIMD) {
        const zero = v128.splat<u8>(0);
        // 144 cells are exactly nine 128-bit vectors. Counting the non-zero
        // lane mask avoids 144 scalar branches in terminal-heavy playout and
        // exact-search paths. A scalar binary is built from the same source
        // for engines without WebAssembly SIMD support.
        for (let cell = 0; cell < CELLS; cell += 16) {
            const occupied = i8x16.ne(v128.load(bd + <usize>cell), zero);
            r += i32.popcnt(i8x16.bitmask(occupied));
        }
        return r;
    }
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
let beamPositions: u64 = 0;
let exactPositions: u64 = 0;
let cpuPlayoutPositions: u64 = 0;
let cpuPlayouts: u64 = 0;

// beam pass state
let passWidth: i32 = 0;
let passNoise: u32 = 0;
let savedSingleWeight: f32 = 0.0;
let savedFragWeight: f32 = 0.0;
let savedFrozenWeight: f32 = 0.0;
let beamWeightsSwapped: bool = false;
// The orthogonal permanent-only pass is meant to explore a complementary
// corridor independent of earlier heuristic luck. Incumbent pruning is sound
// for exact search, but in a bounded beam it changes heap/dedup admission and
// can paradoxically make a better prior score hide a later clearing line.
let passIgnoreIncumbent: bool = false;
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

function curRemaining(i: i32): i32 {
    return curArena == 0 ? <i32>unchecked(META_REMAIN_A[i]) : <i32>unchecked(META_REMAIN_B[i]);
}

function setNxtRemaining(i: i32, remaining: i32): void {
    if (curArena == 0) unchecked(META_REMAIN_B[i] = <u8>remaining);
    else unchecked(META_REMAIN_A[i] = <u8>remaining);
}

// ---------------------------------------------------------------------------
// root move bookkeeping
// ---------------------------------------------------------------------------

// ROOT_BEST is always backed by a replayable line. If it meets the admissible
// permanent-cell bound of that root child, the two bounds coincide and the move
// is proven without enumerating its subtree (in particular, every clear is
// self-proving).
// @ts-ignore
@inline
function maybeMarkRootExact(root: i32): void {
    if (unchecked(ROOT_BEST[root]) == <i32>unchecked(ROOT_LOWER[root])) {
        unchecked(ROOT_EXACT[root] = 1);
    }
}

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
        maybeMarkRootExact(root);
    }
}

// ---------------------------------------------------------------------------
// greedy rollout — instant baseline score for a root move (largest group first)
// ---------------------------------------------------------------------------

// PLAYOUT_BOARD and PLAYOUT_LINE[0..len) hold a legal partial line on entry.
// Returns whether at least one continuation move existed.
function greedyContinue(root: i32, len: i32): bool {
    let moved = false;
    while (len < LINE_MAX) {
        const n = enumerateGroups(pu8(PLAYOUT_BOARD));
        if (n == 0) break;
        nodesExpanded++;
        cpuPlayoutPositions++;
        moved = true;

        let best = 0;
        for (let g = 1; g < n; g++) {
            if (unchecked(REP_SIZES[g]) > unchecked(REP_SIZES[best])) best = g;
        }

        unchecked(PLAYOUT_LINE[len] = unchecked(REPS[best]));
        len++;
        applyEnumeratedMove(pu8(PLAYOUT_BOARD), best);
    }
    cpuPlayouts++;

    const final = boardRemaining(pu8(PLAYOUT_BOARD));
    if (final < unchecked(ROOT_BEST[root])) {
        unchecked(ROOT_BEST[root] = final);
        unchecked(ROOT_LINE_LEN[root] = <u8>len);
        memory.copy(pu8(ROOT_LINES) + <usize>(root * LINE_MAX), pu8(PLAYOUT_LINE), len);
        maybeMarkRootExact(root);
    }
    return moved;
}

// PLAYOUT_BOARD holds the child board after the root move on entry.
function greedyRollout(root: i32): void {
    unchecked(PLAYOUT_LINE[0] = unchecked(ROOT_REP[root]));
    if (!greedyContinue(root, 1)) unchecked(ROOT_EXACT[root] = 1);
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
    // A stale worker job may abandon a portfolio pass between beam slices.
    // Restore the tuned objective before initializing the new position.
    restoreBeamWeights();
    // A genuinely new position starts a new memo generation, so untouched
    // leftovers from earlier positions age and become reclaimable. Re-issuing
    // the same board (e.g. a settings change) keeps the current generation.
    let sameBoard = true;
    for (let cell = 0; cell < CELLS; cell++) {
        if (load<u8>(pu8(ROOT_BOARD) + <usize>cell) != load<u8>(pu8(IO) + <usize>cell)) {
            sameBoard = false;
            break;
        }
    }
    if (!sameBoard) vttGeneration = (vttGeneration + 1) & 255;
    memory.copy(pu8(ROOT_BOARD), pu8(IO), CELLS);
    nodesExpanded = 0;
    beamPositions = 0;
    exactPositions = 0;
    cpuPlayoutPositions = 0;
    cpuPlayouts = 0;
    passActive = false;
    consumeExactPrefix();
    vsActive = false;
    vsPaused = false;
    cancelThreshold();
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
        scanExactStats(pu8(PLAYOUT_BOARD));
        strengthenExactStats(pu8(PLAYOUT_BOARD));
        unchecked(ROOT_LOWER[k] = <u8>statLower);
        greedyRollout(k);
    }

    return rootCount;
}

export function getRemaining(): i32 {
    return rootRemaining;
}

// Copy and replay JS's IO tail prefix below root k. `prefixLen` excludes the
// root move itself. Copying first is essential when `bd == IO`, because the
// materialized board overwrites the input bytes. No caller may use an
// unvalidated prefix to construct a result line.
function materializeRootPrefix(k: i32, prefixLen: i32, bd: usize): bool {
    if (k < 0 || k >= rootCount || prefixLen < 0 || prefixLen >= LINE_MAX) return false;
    if (prefixLen > 0) memory.copy(pu8(PREFIX_MOVES), pu8(IO), prefixLen);

    memory.copy(bd, pu8(ROOT_BOARD), CELLS);
    if (applyMove(bd, <i32>unchecked(ROOT_REP[k])) < 2) return false;
    for (let d = 0; d < prefixLen; d++) {
        const move = <i32>unchecked(PREFIX_MOVES[d]);
        if (move < 0 || move >= CELLS || applyMove(bd, move) < 2) return false;
    }
    return true;
}

function writeRootPrefixLine(k: i32, prefixLen: i32): i32 {
    const len = prefixLen + 1;
    unchecked(PLAYOUT_LINE[0] = unchecked(ROOT_REP[k]));
    for (let d = 0; d < prefixLen; d++) {
        unchecked(PLAYOUT_LINE[d + 1] = unchecked(PREFIX_MOVES[d]));
    }
    return len;
}

// A terminal fixed prefix is itself a complete constructive line.
function reportPrefixTerminal(k: i32, prefixLen: i32, bd: usize): void {
    const final = boardRemaining(bd);
    if (final < unchecked(ROOT_BEST[k])) {
        const len = writeRootPrefixLine(k, prefixLen);
        unchecked(ROOT_BEST[k] = final);
        unchecked(ROOT_LINE_LEN[k] = <u8>len);
        memory.copy(pu8(ROOT_LINES) + <usize>(k * LINE_MAX), pu8(PLAYOUT_LINE), len);
    }
    maybeMarkRootExact(k);
}

// Materialize the board below [root k, IO tail prefix], enumerate its legal
// next moves, and expose the same bridge layout as childGroupsToIO(): board at
// IO, representatives at IO+256, sizes at IO+512. Returns -1 for an invalid
// prefix; zero is a valid terminal prefix.
export function prefixGroupsToIO(k: i32, prefixLen: i32): i32 {
    if (!materializeRootPrefix(k, prefixLen, pu8(IO))) return -1;
    const n = enumerateGroups(pu8(IO));
    for (let g = 0; g < n; g++) {
        store<u8>(pu8(IO) + 256 + <usize>g, unchecked(REPS[g]));
        store<u8>(pu8(IO) + 512 + <usize>g, unchecked(REP_SIZES[g]));
    }
    return n;
}

// Give every legal move after a fixed prefix the same largest-group greedy
// baseline it would receive as a visible root. Results remain attached to the
// original root and include the complete prefix. A deeper branch cannot raise
// the original root's lower bound; prefixLen==0 retains the old whole-child
// lower-bound lift because it exhaustively covers every second move.
export function probeRootPrefixTable(k: i32, prefixLen: i32): i32 {
    if (k < 0 || k >= rootCount || unchecked(ROOT_EXACT[k]) != 0 ||
        prefixLen < 0 || prefixLen + 2 > LINE_MAX) {
        return k >= 0 && k < rootCount ? unchecked(ROOT_BEST[k]) : NO_SCORE;
    }
    if (!materializeRootPrefix(k, prefixLen, pu8(PLAYOUT_START))) {
        return unchecked(ROOT_BEST[k]);
    }

    const n = enumerateGroups(pu8(PLAYOUT_START));
    for (let g = 0; g < n; g++) unchecked(PROBE_REPS[g] = unchecked(REPS[g]));
    if (n == 0) {
        reportPrefixTerminal(k, prefixLen, pu8(PLAYOUT_START));
        return unchecked(ROOT_BEST[k]);
    }

    let childLower = CELLS;
    for (let g = 0; g < n; g++) {
        memory.copy(pu8(PLAYOUT_BOARD), pu8(PLAYOUT_START), CELLS);
        const next = <i32>unchecked(PROBE_REPS[g]);
        const len = writeRootPrefixLine(k, prefixLen);
        unchecked(PLAYOUT_LINE[len] = <u8>next);
        if (applyMove(pu8(PLAYOUT_BOARD), next) < 2) continue;
        scanExactStats(pu8(PLAYOUT_BOARD));
        strengthenExactStats(pu8(PLAYOUT_BOARD));
        if (statLower < childLower) childLower = statLower;
        greedyContinue(k, len + 1);
        if (unchecked(ROOT_EXACT[k]) != 0) break;
    }
    if (prefixLen == 0 && unchecked(ROOT_EXACT[k]) == 0 &&
        childLower > <i32>unchecked(ROOT_LOWER[k])) {
        unchecked(ROOT_LOWER[k] = <u8>childLower);
        maybeMarkRootExact(k);
    }
    return unchecked(ROOT_BEST[k]);
}

// Lift the child position's instant baseline one ply into parent root k.
// After applying k, try every legal second move and finish with the same
// largest-group greedy rollout that setBoard() would give that move if the
// player entered the child position. Every retained result is a fully played
// constructive line; a clear reaches the sound lower bound zero and therefore
// proves the parent row immediately.
export function probeRootChildTable(k: i32): i32 {
    return probeRootPrefixTable(k, 0);
}

// Admissible lower bound for a root child. The worker uses this to spend
// private beam passes only on moves that can still improve the incumbent,
// while guaranteeing that none of those moves is permanently starved.
export function getRootLower(root: i32): i32 {
    return <i32>unchecked(ROOT_LOWER[root]);
}

function restoreBeamWeights(): void {
    passIgnoreIncumbent = false;
    if (!beamWeightsSwapped) return;
    W_SINGLE = savedSingleWeight;
    W_FRAG = savedFragWeight;
    W_FROZEN = savedFrozenWeight;
    beamWeightsSwapped = false;
}

export function setWeights(dead: f32, single: f32, frag: f32, frozen: f32, noise: f32): void {
    restoreBeamWeights();
    passActive = false; // changing an objective invalidates any retained beam heap
    W_DEAD = dead;
    W_SINGLE = single;
    W_FRAG = frag;
    W_FROZEN = frozen;
    NOISE_SCALE = noise;
    EVAL_EXTRAS_NONNEGATIVE = dead >= 0.0 && single >= 0.0 && frag >= 0.0 &&
        frozen >= 0.0 && noise >= 0.0;
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

// Pass setup shared by beam entry points; onlyRoot -1 = all root moves. A
// lane partition keeps independent workers on disjoint root subtrees while
// preserving the exact same per-root search semantics.
function beamInit(width: i32, noiseSeed: u32, onlyRoot: i32, lane: i32, lanes: i32): void {
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
        if (onlyRoot < 0 && lanes > 1 && k % lanes != lane) continue;
        if (unchecked(ROOT_EXACT[k])) continue;
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
        unchecked(META_REMAIN_A[curCount] = <u8>evalRemaining);
        edgeCount++;
        curCount++;
    }

    heapSize = 0;
    passActive = curCount > 0;
}

// Start at depth two under one parent root, partitioning the child position's
// legal moves exactly as a normal beamBeginPartition() would after the player
// clicks that root. The retained edge chain includes both prefix moves, so a
// terminal found by beamStep() remains a replayable line on ROOT_BOARD.
function beamInitRootChildrenPartition(
    k: i32, width: i32, noiseSeed: u32, lane: i32, lanes: i32, onlySecond: i32,
): void {
    // Every begin call abandons the previous pass, including invalid or empty
    // requests. This makes speculative scheduler work safe to issue.
    passActive = false;
    passWidth = 0;
    heapSize = 0;
    curCount = 0;
    curCursor = 0;
    layerDepth = 0;
    edgeCount = 0;

    if (k < 0 || k >= rootCount || width < 1 || unchecked(ROOT_EXACT[k]) != 0) return;
    if (width > MAX_WIDTH) width = MAX_WIDTH;
    if (lanes < 1) lanes = 1;
    lane %= lanes;
    if (lane < 0) lane += lanes;

    passWidth = width;
    passNoise = noiseSeed;
    layerDepth = 2;
    dedupStamp++;
    curArena = 0;

    memory.copy(pu8(PLAYOUT_START), pu8(ROOT_BOARD), CELLS);
    const first = <i32>unchecked(ROOT_REP[k]);
    if (applyMove(pu8(PLAYOUT_START), first) == 0) return;

    // Applying/evaluating one candidate reuses the global enumeration scratch,
    // so retain the complete second-move list before materializing any board.
    const n = enumerateGroups(pu8(PLAYOUT_START));
    for (let g = 0; g < n; g++) unchecked(PROBE_REPS[g] = unchecked(REPS[g]));

    let rootEdge: u32 = NO_EDGE;
    for (let g = 0; g < n; g++) {
        const second = <i32>unchecked(PROBE_REPS[g]);
        if (onlySecond >= 0) {
            if (second != onlySecond) continue;
        } else if (lanes > 1 && g % lanes != lane) continue;

        if (rootEdge == NO_EDGE) {
            rootEdge = <u32>edgeCount;
            unchecked(EDGE_PAR[edgeCount] = NO_EDGE);
            unchecked(EDGE_MOVE[edgeCount] = <u8>first);
            edgeCount++;
        }

        const bd = curBoards() + <usize>(curCount * CELLS);
        memory.copy(bd, pu8(PLAYOUT_START), CELLS);
        if (applyMove(bd, second) == 0) continue;
        evalBoard(bd, 0);

        if (!evalHasMoves) {
            reportTerminal(k, evalRemaining, rootEdge, second);
            if (unchecked(ROOT_EXACT[k]) != 0) break;
            continue;
        }

        unchecked(EDGE_PAR[edgeCount] = rootEdge);
        unchecked(EDGE_MOVE[edgeCount] = <u8>second);
        unchecked(META_ROOT_A[curCount] = <u8>k);
        unchecked(META_EDGE_A[curCount] = <u32>edgeCount);
        unchecked(META_REMAIN_A[curCount] = <u8>evalRemaining);
        edgeCount++;
        curCount++;
    }

    passActive = curCount > 0 && unchecked(ROOT_EXACT[k]) == 0;
}

// Start one private beam at the board below an arbitrary validated fixed
// prefix. Unlike a whole-root heap, this gives the prefix exactly the search
// decomposition it receives after its earlier moves are played. The complete
// edge chain is retained, so reportTerminal() records a line on ROOT_BOARD.
function beamInitRootPrefix(k: i32, prefixLen: i32, width: i32, noiseSeed: u32): bool {
    passActive = false;
    passWidth = 0;
    heapSize = 0;
    curCount = 0;
    curCursor = 0;
    layerDepth = 0;
    edgeCount = 0;

    if (k < 0 || k >= rootCount || width < 1 ||
        unchecked(ROOT_EXACT[k]) != 0 || prefixLen < 0 || prefixLen >= LINE_MAX) return false;
    if (width > MAX_WIDTH) width = MAX_WIDTH;
    if (!materializeRootPrefix(k, prefixLen, pu8(PLAYOUT_START))) return false;

    passWidth = width;
    passNoise = noiseSeed;
    layerDepth = prefixLen + 1;
    dedupStamp++;
    curArena = 0;

    let edge: u32 = NO_EDGE;
    unchecked(EDGE_PAR[edgeCount] = NO_EDGE);
    unchecked(EDGE_MOVE[edgeCount] = unchecked(ROOT_REP[k]));
    edge = <u32>edgeCount;
    edgeCount++;
    for (let d = 0; d < prefixLen; d++) {
        unchecked(EDGE_PAR[edgeCount] = edge);
        unchecked(EDGE_MOVE[edgeCount] = unchecked(PREFIX_MOVES[d]));
        edge = <u32>edgeCount;
        edgeCount++;
    }

    evalBoard(pu8(PLAYOUT_START), 0);
    if (!evalHasMoves) {
        reportPrefixTerminal(k, prefixLen, pu8(PLAYOUT_START));
        return true;
    }

    memory.copy(curBoards(), pu8(PLAYOUT_START), CELLS);
    unchecked(META_ROOT_A[0] = <u8>k);
    unchecked(META_EDGE_A[0] = edge);
    unchecked(META_REMAIN_A[0] = <u8>evalRemaining);
    curCount = 1;
    passActive = true;
    return true;
}

// starts an anytime pass; noiseSeed 0 = deterministic, else stochastic variant
export function beamBegin(width: i32, noiseSeed: u32): void {
    restoreBeamWeights();
    beamInit(width, noiseSeed, -1, 0, 1);
}

// Multi-worker global pass. setBoard() enumerates roots deterministically by
// ascending representative cell, so the ordinal partition is stable while
// keeping every lane's root count within one of every other lane's count.
export function beamBeginPartition(width: i32, noiseSeed: u32, lane: i32, lanes: i32): void {
    restoreBeamWeights();
    if (lanes < 1) lanes = 1;
    lane %= lanes;
    if (lane < 0) lane += lanes;
    beamInit(width, noiseSeed, -1, lane, lanes);
}

// Fair second-ply portfolio for one parent row. Ownership is based on the
// second move's enumeration ordinal, matching the root partition that the same
// position receives after that parent move is played.
export function beamBeginRootChildrenPartition(
    k: i32, width: i32, noiseSeed: u32, lane: i32, lanes: i32,
): void {
    restoreBeamWeights();
    beamInitRootChildrenPartition(k, width, noiseSeed, lane, lanes, -1);
}

// JS writes `prefixLen` tail moves after root k to IO. Returns 1 when the
// prefix was legal (including an already terminal prefix), otherwise 0. A bad
// request always abandons the prior beam pass.
export function beamBeginRootPrefix(
    k: i32, prefixLen: i32, width: i32, noiseSeed: u32,
): i32 {
    restoreBeamWeights();
    return beamInitRootPrefix(k, prefixLen, width, noiseSeed) ? 1 : 0;
}

// Explicit single-prefix member. This is the exact parent-side equivalent of
// playing root k, entering the child position, and root-locking its move at
// secondCell. The second cell must be that legal group's canonical
// representative, as returned by childGroupsToIO().
export function beamBeginRootChild(
    k: i32, secondCell: i32, width: i32, noiseSeed: u32,
): void {
    restoreBeamWeights();
    store<u8>(pu8(IO), <u8>(secondCell >= 0 && secondCell < CELLS ? secondCell : 255));
    beamInitRootPrefix(k, 1, width, noiseSeed);
}

// root-locked pass: the whole beam explores only the subtree of root move k,
// deepening the most promising candidates instead of re-searching everything
export function beamBeginRoot(k: i32, width: i32, noiseSeed: u32): void {
    restoreBeamWeights();
    beamInit(width, noiseSeed, k >= 0 && k < rootCount ? k : -1, 0, 1);
}

// Orthogonal root-locked member for near-clear positions. It ranks by cells
// remaining plus the admissible permanent-cell bound only, allowing temporary
// fragmentation/frozen mass that every tuned-policy beam would discard.
export function beamBeginRootPermanent(k: i32, width: i32): void {
    restoreBeamWeights();
    savedSingleWeight = W_SINGLE;
    savedFragWeight = W_FRAG;
    savedFrozenWeight = W_FROZEN;
    W_SINGLE = 0.0;
    W_FRAG = 0.0;
    W_FROZEN = 0.0;
    beamWeightsSwapped = true;
    beamInit(width, 0, k >= 0 && k < rootCount ? k : -1, 0, 1);
    passIgnoreIncumbent = passActive;
    if (!passActive) restoreBeamWeights();
}

// expands up to `budget` child evaluations; returns 1 when the pass is finished
export function beamStep(budget: i32): i32 {
    if (!passActive) {
        restoreBeamWeights();
        return 1;
    }

    let spent = 0;

    while (spent < budget) {
        if (curCursor >= curCount) {
            // layer exhausted — promote heap survivors to the next layer
            if (heapSize == 0) {
                passActive = false;
                restoreBeamWeights();
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
                restoreBeamWeights();
                return 1;
            }
            continue;
        }

        const node = curCursor;
        curCursor++;
        const bd = curBoards() + <usize>(node * CELLS);
        const nodeRoot = curRoot(node);
        const nodeEdge = curEdge(node);
        const nodeRemaining = curRemaining(node);
        if (unchecked(ROOT_EXACT[nodeRoot])) continue;

        const groups = enumerateGroups(bd);
        nodesExpanded += <u64>groups;
        beamPositions += <u64>groups;
        spent += groups > 0 ? groups : 1;

        for (let g = 0; g < groups; g++) {
            // REPS stays valid throughout: applyMove/evalBoard do not touch it
            const move = <i32>unchecked(REPS[g]);

            // Every evaluation term beyond remaining is nonnegative under the
            // normal weights. Once the heap is full, this lower bound can
            // reject a child before copying, removing, collapsing and scanning
            // it. A terminal that could improve its root is never skipped.
            const childRemaining = nodeRemaining - <i32>unchecked(REP_SIZES[g]);
            if (!passIgnoreIncumbent && EVAL_EXTRAS_NONNEGATIVE && heapSize >= passWidth &&
                <f32>childRemaining >= unchecked(H_EVAL[<i32>unchecked(H_ORD[0])]) &&
                childRemaining >= unchecked(ROOT_BEST[nodeRoot])) {
                continue;
            }
            memory.copy(pu8(SCRATCH), bd, CELLS);
            applyEnumeratedMove(pu8(SCRATCH), g);

            const value = evalBoard(pu8(SCRATCH), passNoise);

            if (!evalHasMoves) {
                reportTerminal(nodeRoot, evalRemaining, nodeEdge, move);
                continue;
            }

            // Unlike the heuristic evaluation, this forced-cell lower bound
            // is permanent. The subtree cannot strictly improve its root.
            if (!passIgnoreIncumbent &&
                evalLower >= unchecked(ROOT_BEST[nodeRoot])) continue;

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
                setNxtRemaining(slot, evalRemaining);
                heapSiftUp(heapSize - 1);
            } else {
                slot = <i32>unchecked(H_ORD[0]); // replace the current worst
                unchecked(H_EVAL[slot] = value);
                memory.copy(nxtBoards() + <usize>(slot * CELLS), pu8(SCRATCH), CELLS);
                unchecked(H_EDGE_PAR[slot] = nodeEdge);
                unchecked(H_MOVE[slot] = <u8>move);
                setNxtRoot(slot, nodeRoot);
                setNxtRemaining(slot, evalRemaining);
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
// when record is true, moves are appended to PLAYOUT_LINE after the caller's
// already-recorded root/prefix. The legacy root and direct-test paths pass 1.
function playoutRun(seed: u32, record: bool, tabu: i32, soft: bool, lineStart: i32): i32 {
    rngSeed(seed);
    let len = lineStart;
    cpuPlayouts++;

    for (;;) {
        const n = enumerateGroups(pu8(PLAYOUT_BOARD));
        if (n == 0) break;
        nodesExpanded++;
        cpuPlayoutPositions++;

        let pick = 0;
        if (soft) {
            // Exploratory portfolio member: non-tabu groups stay favored, but
            // every legal action has support. Other seeds retain the strong
            // original tabu policy for exploitation quality.
            let totalWeight = 0;
            for (let g = 0; g < n; g++) {
                totalWeight += <i32>unchecked(REP_COLORS[g]) == tabu ? 1 : TABU_WEIGHT;
            }
            let target = <i32>(rngNext() % <u32>totalWeight);
            for (let g = 0; g < n; g++) {
                const weight = <i32>unchecked(REP_COLORS[g]) == tabu ? 1 : TABU_WEIGHT;
                if (target < weight) { pick = g; break; }
                target -= weight;
            }
        } else {
            let candidates = 0;
            for (let g = 0; g < n; g++) {
                if (<i32>unchecked(REP_COLORS[g]) != tabu) candidates++;
            }
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
        }

        const move = <i32>unchecked(REPS[pick]);
        if (record && len < LINE_MAX) unchecked(PLAYOUT_LINE[len] = <u8>move);
        len++;
        applyEnumeratedMove(pu8(PLAYOUT_BOARD), pick);
    }

    playoutLastLen = len;
    return boardRemaining(pu8(PLAYOUT_BOARD));
}

// n playouts under [root k, IO tail prefix]. The tabu color is intentionally
// recomputed only after the complete fixed prefix, exactly matching analysis
// of that board after the user plays into it.
function playoutRootPrefixMode(
    k: i32, prefixLen: i32, n: i32, seedBase: u32, soft: bool,
): i32 {
    if (k < 0 || k >= rootCount || prefixLen < 0 || prefixLen >= LINE_MAX || n < 1) {
        return NO_SCORE;
    }
    if (!materializeRootPrefix(k, prefixLen, pu8(PLAYOUT_START))) return NO_SCORE;
    const lineStart = prefixLen + 1;
    const tabu = dominantColor(pu8(PLAYOUT_START));

    let minFinal = NO_SCORE;
    let minSeed: u32 = 0;
    for (let i = 0; i < n; i++) {
        memory.copy(pu8(PLAYOUT_BOARD), pu8(PLAYOUT_START), CELLS);
        const final = playoutRun(seedBase + <u32>i, false, tabu, soft, lineStart);
        if (final < minFinal) {
            minFinal = final;
            minSeed = seedBase + <u32>i;
        }
    }

    if (minFinal < unchecked(ROOT_BEST[k])) {
        // replay the winning seed, recording the line
        memory.copy(pu8(PLAYOUT_BOARD), pu8(PLAYOUT_START), CELLS);
        writeRootPrefixLine(k, prefixLen);
        const check = playoutRun(minSeed, true, tabu, soft, lineStart);
        if (check == minFinal) {
            unchecked(ROOT_BEST[k] = minFinal);
            unchecked(ROOT_LINE_LEN[k] = <u8>playoutLastLen);
            memory.copy(pu8(ROOT_LINES) + <usize>(k * LINE_MAX), pu8(PLAYOUT_LINE), playoutLastLen);
            maybeMarkRootExact(k);
        }
    }

    return minFinal;
}

// Legacy root-only entry point.
function playoutRootMode(k: i32, n: i32, seedBase: u32, soft: bool): i32 {
    return playoutRootPrefixMode(k, 0, n, seedBase, soft);
}

export function playoutRootPrefix(k: i32, prefixLen: i32, n: i32, seedBase: u32): i32 {
    return playoutRootPrefixMode(k, prefixLen, n, seedBase, false);
}

export function playoutRootPrefixSoft(k: i32, prefixLen: i32, n: i32, seedBase: u32): i32 {
    return playoutRootPrefixMode(k, prefixLen, n, seedBase, true);
}

// Exploitation policy: preserves the original hard tabu-color rollout.
export function playoutRoot(k: i32, n: i32, seedBase: u32): i32 {
    return playoutRootMode(k, n, seedBase, false);
}

// Exploration policy: the tabu color is an 8:1 bias rather than an action
// mask. The worker supplements, rather than replaces, hard-tabu samples.
export function playoutRootSoft(k: i32, n: i32, seedBase: u32): i32 {
    return playoutRootMode(k, n, seedBase, true);
}

// verification path for GPU results: replay `seed` under root k and require the
// final remaining to equal `claimed`; on success the result is merged like a
// CPU playout; returns 1 on exact match, 0 on mismatch (caller disables GPU)
export function playoutVerify(k: i32, seed: u32, claimed: i32): i32 {
    if (k < 0 || k >= rootCount) return 0;

    memory.copy(pu8(PLAYOUT_BOARD), pu8(ROOT_BOARD), CELLS);
    applyMove(pu8(PLAYOUT_BOARD), <i32>unchecked(ROOT_REP[k]));
    unchecked(PLAYOUT_LINE[0] = unchecked(ROOT_REP[k]));
    const final = playoutRun(seed, true, dominantColor(pu8(PLAYOUT_BOARD)), false, 1);

    if (final != claimed) return 0;

    if (final < unchecked(ROOT_BEST[k])) {
        unchecked(ROOT_BEST[k] = final);
        unchecked(ROOT_LINE_LEN[k] = <u8>playoutLastLen);
        memory.copy(pu8(ROOT_LINES) + <usize>(k * LINE_MAX), pu8(PLAYOUT_LINE), playoutLastLen);
        maybeMarkRootExact(k);
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
        maybeMarkRootExact(root);
    }
    return final;
}

// Warm start: restores a proof flag from a cached exact value for this root
// child (either the same analysis board or a composed one-ply child cache).
// Only applies when the replayed best equals the remembered proven score.
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

// Accept a caller-composed lower certificate for one root. The pool invokes
// this only after every member of a canonical fixed-prefix manifest has
// completed above the same threshold. Guard the interval here as a second
// trust boundary: a lower bound can only rise and can never cross the root's
// replayable constructive upper bound.
export function seedRootLowerByCell(cell: i32, lower: i32): i32 {
    if (lower < 0 || lower > CELLS) return 0;
    for (let k = 0; k < rootCount; k++) {
        if (<i32>unchecked(ROOT_REP[k]) != cell) continue;
        if (lower < <i32>unchecked(ROOT_LOWER[k]) ||
            lower > unchecked(ROOT_BEST[k])) return 0;
        unchecked(ROOT_LOWER[k] = <u8>lower);
        maybeMarkRootExact(k);
        return 1;
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

// GPU beam-assist bridge: enumerate the legal second-ply moves of root k and
// expose their representatives at IO+256 and sizes at IO+512 while leaving
// the root-child board at IO. The GPU ranks the resulting grandchildren
// heuristically; proof and line acceptance remain entirely in the verified
// CPU/WASM core.
export function childGroupsToIO(k: i32): i32 {
    if (childToIO(k) == 0) return 0;
    const n = enumerateGroups(pu8(IO));
    for (let g = 0; g < n; g++) {
        store<u8>(pu8(IO) + 256 + <usize>g, unchecked(REPS[g]));
        store<u8>(pu8(IO) + 512 + <usize>g, unchecked(REP_SIZES[g]));
    }
    return n;
}

// Materialize one second-ply candidate for GPU feature evaluation.
export function grandchildToIO(k: i32, second: i32): i32 {
    if (childToIO(k) == 0) return 0;
    return applyMove(pu8(IO), second) >= 2 ? 1 : 0;
}

// ---------------------------------------------------------------------------
// exact solver — budgeted branch & bound DFS with transposition table
// ---------------------------------------------------------------------------

let exActive: bool = false;
let exDepth: i32 = 0;
let exBest: i32 = NO_SCORE;
let exBestLen: i32 = 0;
let exHasWitness: bool = false;
let exNodes: i32 = 0;
let exBudget: i32 = 0;
let exComplete: bool = false;
let exSeek: bool = false;
let exSeekTarget: i32 = -1;
let exPrefixRoot: i32 = -1;
let exPrefixLen: i32 = 0;
let exPrefixToken: i32 = 0;
let exNextPrefixToken: i32 = 0;
let ttStamp: u32 = 0;
// Whole-position threshold proofs on the primary lane can borrow the much
// larger value-table key/stamp arrays as a transient seen set. Value entries
// always carry stamp 1; generations 2..255 are therefore unambiguously seen
// entries and can never be consumed as exact values.
let exUseWideSeen: bool = false;
let wideSeenStamp: u8 = 146;

function clearExactPrefix(): void {
    exPrefixRoot = -1;
    exPrefixLen = 0;
    exPrefixToken = 0;
}

function nextExactPrefixToken(): i32 {
    exNextPrefixToken++;
    if (exNextPrefixToken <= 0) exNextPrefixToken = 1;
    return exNextPrefixToken;
}

// A committed or abandoned forced-prefix seek must not remain eligible for
// any whole-position/whole-child merge API. Besides clearing its identity,
// consume the generic exact-search flags and witness that those APIs inspect.
function consumeExactPrefix(): void {
    exActive = false;
    exDepth = 0;
    exBest = NO_SCORE;
    exBestLen = 0;
    exHasWitness = false;
    exNodes = 0;
    exBudget = 0;
    exComplete = false;
    exSeek = false;
    exSeekTarget = -1;
    clearExactPrefix();
}

let statRemaining: i32 = 0;
let statLower: i32 = 0;
let statSingletonLower: i32 = 0;
let statHash: u64 = 0;

// One board pass for the three exact-search side products that used to be
// computed independently. Counts give the singleton lower bound, occupied
// cells give the terminal score, and positions/colors give the TT key.
function scanExactStats(bd: usize): void {
    for (let c = 0; c <= COLORS; c++) unchecked(colorTotal[c] = 0);
    let remaining = 0;
    let hash: u64 = 0;
    for (let cell = 0; cell < CELLS; cell++) {
        const c = <i32>cellAt(bd, cell);
        if (c != 0) {
            remaining++;
            unchecked(colorTotal[c] = unchecked(colorTotal[c]) + 1);
            hash ^= unchecked(ZOB[cell * COLORS + c - 1]);
        }
    }
    let singletonLower = 0;
    for (let c = 1; c <= COLORS; c++) {
        if (unchecked(colorTotal[c]) == 1) singletonLower++;
    }
    statRemaining = remaining;
    statSingletonLower = singletonLower;
    statLower = singletonLower;
    statHash = hash;
}

// Root scans are rare and seed every descendant, so pay for the full
// separator fixed point there. Descendants inherit this bound monotonically.
function strengthenExactStats(bd: usize): void {
    statLower = permanentLower(bd);
}

function exPush(bd: usize, forcedMove: i32): void {
    const frame = exDepth;
    const frameBd = pu8(EX_BOARDS) + <usize>(frame * CELLS);
    if (frameBd != bd) memory.copy(frameBd, bd, CELLS);
    let n = enumerateGroups(frameBd);
    if (forcedMove >= 0 && forcedMove < CELLS) {
        let forced = -1;
        for (let g = 0; g < n; g++) {
            if (<i32>unchecked(REPS[g]) == forcedMove) { forced = g; break; }
        }
        if (forced >= 0) {
            unchecked(REPS[0] = unchecked(REPS[forced]));
            n = 1;
        }
    }
    memory.copy(pu8(EX_REPS) + <usize>(frame * MAX_ROOTS), pu8(REPS), n);
    unchecked(EX_COUNT[frame] = n);
    unchecked(EX_CURSOR[frame] = 0);
    unchecked(EX_LOWER[frame] = <u8>statLower);
    unchecked(EX_REMAINING[frame] = <u8>statRemaining);
    exDepth++;
}

// Returns true when this exact-search state was already present. Four-way
// buckets retain substantially more transpositions than direct mapping at
// the same memory size; replacement can only cause extra work, never pruning.
function ttSeen(hash: u64): bool {
    if (exUseWideSeen) return wideTtSeen(hash);

    const base = <i32>(hash & <u64>TT_SET_MASK) * TT_WAYS;
    let empty = -1;
    for (let way = 0; way < TT_WAYS; way++) {
        const at = base + way;
        if (unchecked(TT_STAMP[at]) != ttStamp) {
            if (empty < 0) empty = at;
        } else if (unchecked(TT_KEY[at]) == hash) {
            return true;
        }
    }
    const at = empty >= 0 ? empty : base + <i32>((hash >> 48) & <u64>(TT_WAYS - 1));
    unchecked(TT_STAMP[at] = ttStamp);
    unchecked(TT_KEY[at] = hash);
    return false;
}

// starts an exact search on the analysis board; budget = max node expansions
export function exactBegin(budget: i32): void {
    consumeExactPrefix();
    cancelThreshold();
    vsPaused = false;
    vsActive = false;
    exActive = true;
    exComplete = false;
    exSeek = false;
    exBest = NO_SCORE;
    exBestLen = 0;
    exHasWitness = false;
    exNodes = 0;
    exBudget = budget;
    exDepth = 0;
    ttStamp++;
    beginWideSeenPass();

    // the beam's best-known lines are the starting upper bound
    for (let k = 0; k < rootCount; k++) {
        if (unchecked(ROOT_BEST[k]) < exBest) {
            exBest = unchecked(ROOT_BEST[k]);
        }
    }

    scanExactStats(pu8(ROOT_BOARD));
    strengthenExactStats(pu8(ROOT_BOARD));
    exPush(pu8(ROOT_BOARD), -1);
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
                exHasWitness = true;
                for (let d = 0; d < frame; d++) {
                    unchecked(EX_LINE[d] = unchecked(EX_MOVE[d]));
                }
            }
            if (exSeek && value == exSeekTarget) {
                // The value solver already proved the target; line seek only
                // needs one constructive witness, not a second full proof.
                exActive = false;
                exComplete = true;
                return value;
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
        if (exDepth >= EXACT_STACK) continue; // cannot happen: depth <= 72
        const child = pu8(EX_BOARDS) + <usize>(exDepth * CELLS);
        memory.copy(child, bd, CELLS);
        applyMove(child, <i32>move);
        unchecked(EX_MOVE[frame] = move);
        exNodes++;
        spent++;
        nodesExpanded++;
        exactPositions++;

        if (exNodes > exBudget) {
            exActive = false;
            return -2;
        }

        // bound: this subtree cannot beat the best known final
        scanExactStats(child);
        if (statRemaining <= PERMANENT_EXACT_REMAINING &&
            <i32>unchecked(EX_REMAINING[frame]) > PERMANENT_EXACT_REMAINING) {
            statLower = permanentLower(child);
        }
        const inheritedLower = <i32>unchecked(EX_LOWER[frame]);
        if (statLower < inheritedLower) statLower = inheritedLower;
        if (statLower >= exBest) continue;

        const hash = statHash;
        let forcedMove = -1;
        if (exSeek) {
            const memo = vttLookup(hash);
            if (memo > exSeekTarget) continue;
            if (memo == exSeekTarget && vttHitMove != 255) forcedMove = vttHitMove;
        }
        if (ttSeen(hash)) continue;
        exPush(child, forcedMove);
    }

    return -1;
}

// starts an exact search on the child board after root move k, proving (or
// improving) that single move's score; the move's best-known line is the
// starting upper bound, so the search only explores what could beat it
export function exactBeginChild(k: i32, budget: i32): i32 {
    consumeExactPrefix();
    cancelThreshold();
    exActive = false;
    if (k < 0 || k >= rootCount) return 0;

    vsPaused = false;
    vsActive = false;
    exActive = true;
    exComplete = false;
    exSeek = false;
    exBest = unchecked(ROOT_BEST[k]);
    exBestLen = 0;
    exHasWitness = false;
    exNodes = 0;
    exBudget = budget;
    exDepth = 0;
    exUseWideSeen = false;
    ttStamp++;

    memory.copy(pu8(PLAYOUT_BOARD), pu8(ROOT_BOARD), CELLS);
    applyMove(pu8(PLAYOUT_BOARD), <i32>unchecked(ROOT_REP[k]));
    scanExactStats(pu8(PLAYOUT_BOARD));
    strengthenExactStats(pu8(PLAYOUT_BOARD));
    exPush(pu8(PLAYOUT_BOARD), -1);
    return 1;
}

// Commits a constructive terminal found by the current child search. This is
// safe even when the node budget was exhausted: the line is an upper bound,
// never an exactness claim. EX_LINE starts in the child position, so prepend
// the root move. Returns the root's resulting best score.
export function exactCommitChild(k: i32): i32 {
    if (exPrefixRoot >= 0 || k < 0 || k >= rootCount) return NO_SCORE;

    if (exHasWitness && exBest < unchecked(ROOT_BEST[k])) {
        unchecked(ROOT_BEST[k] = exBest);
        unchecked(ROOT_LINES[k * LINE_MAX] = unchecked(ROOT_REP[k]));
        for (let d = 0; d < exBestLen; d++) {
            unchecked(ROOT_LINES[k * LINE_MAX + 1 + d] = unchecked(EX_LINE[d]));
        }
        unchecked(ROOT_LINE_LEN[k] = <u8>(exBestLen + 1));
        maybeMarkRootExact(k);
    }

    return unchecked(ROOT_BEST[k]);
}

// Merges a completed child search into root k: exhaustive completion proves
// the move's value in addition to committing any improved witness.
export function exactMergeChild(k: i32): i32 {
    if (exPrefixRoot >= 0 || !exComplete || k < 0 || k >= rootCount) return NO_SCORE;

    exactCommitChild(k);

    unchecked(ROOT_EXACT[k] = 1);
    return exBest;
}

// line seek: like exactBeginChild, but with a known target value — everything
// that cannot reach `target` is pruned, so recovering the optimal line after
// the value solver is cheap. exactStep completing with `target` means the
// line was found and recorded (merge with exactMergeChild)
export function exactChildSeek(k: i32, budget: i32, target: i32): i32 {
    consumeExactPrefix();
    cancelThreshold();
    exActive = false;
    if (k < 0 || k >= rootCount) return 0;

    vsPaused = false;
    vsActive = false;
    exActive = true;
    exComplete = false;
    exSeek = true;
    exSeekTarget = target;
    exBest = target + 1;
    exBestLen = 0;
    exHasWitness = false;
    exNodes = 0;
    exBudget = budget;
    exDepth = 0;
    exUseWideSeen = false;
    ttStamp++;

    memory.copy(pu8(PLAYOUT_BOARD), pu8(ROOT_BOARD), CELLS);
    applyMove(pu8(PLAYOUT_BOARD), <i32>unchecked(ROOT_REP[k]));
    scanExactStats(pu8(PLAYOUT_BOARD));
    strengthenExactStats(pu8(PLAYOUT_BOARD));
    let forcedMove = -1;
    const memo = vttLookup(statHash);
    if (memo == target && vttHitMove != 255) forcedMove = vttHitMove;
    exPush(pu8(PLAYOUT_BOARD), forcedMove);
    return 1;
}

// Targeted exact seek below [root k, IO tail prefix]. The returned positive
// token identifies this exact begin generation. A later begin invalidates it;
// stale commits cannot attach a witness to a different prefix or consume the
// newer live search. Completion proves only the fixed branch. Commit remains
// a constructive upper-bound update unless it meets ROOT_LOWER.
export function exactBeginRootPrefixSeek(
    k: i32, prefixLen: i32, budget: i32, target: i32,
): i32 {
    consumeExactPrefix();
    cancelThreshold();
    vsPaused = false;
    vsActive = false;
    if (k < 0 || k >= rootCount || unchecked(ROOT_EXACT[k]) != 0 ||
        prefixLen < 0 || prefixLen >= LINE_MAX || budget < 0 ||
        target < 0 || target > CELLS || target < <i32>unchecked(ROOT_LOWER[k])) {
        return 0;
    }

    if (!materializeRootPrefix(k, prefixLen, pu8(PLAYOUT_BOARD))) return 0;

    exActive = true;
    exComplete = false;
    exSeek = true;
    exSeekTarget = target;
    exBest = target + 1;
    exBestLen = 0;
    exHasWitness = false;
    exNodes = 0;
    exBudget = budget;
    exDepth = 0;
    exUseWideSeen = false;
    ttStamp++;
    exPrefixRoot = k;
    exPrefixLen = prefixLen;
    exPrefixToken = nextExactPrefixToken();
    if (prefixLen > 0) memory.copy(pu8(EX_PREFIX_MOVES), pu8(PREFIX_MOVES), prefixLen);

    scanExactStats(pu8(PLAYOUT_BOARD));
    strengthenExactStats(pu8(PLAYOUT_BOARD));
    const rootLower = <i32>unchecked(ROOT_LOWER[k]);
    if (statLower < rootLower) statLower = rootLower;
    let forcedMove = -1;
    const memo = vttLookup(statHash);
    if (memo == target && vttHitMove != 255) forcedMove = vttHitMove;
    exPush(pu8(PLAYOUT_BOARD), forcedMove);
    return exPrefixToken;
}

// Commit only the matching live begin token. The full saved prefix is prepended
// to EX_LINE; IO may have been reused since begin. A stale token is a pure
// no-op and deliberately leaves a newer live seek intact.
export function exactCommitRootPrefix(token: i32): i32 {
    if (token <= 0 || exPrefixToken != token || exPrefixRoot < 0) return NO_SCORE;
    if (!exHasWitness) {
        consumeExactPrefix();
        return NO_SCORE;
    }

    const k = exPrefixRoot;
    const len = exBestLen + exPrefixLen + 1;
    if (len > LINE_MAX) {
        consumeExactPrefix();
        return NO_SCORE;
    }

    if (exBest < unchecked(ROOT_BEST[k])) {
        unchecked(ROOT_BEST[k] = exBest);
        unchecked(ROOT_LINES[k * LINE_MAX] = unchecked(ROOT_REP[k]));
        for (let d = 0; d < exPrefixLen; d++) {
            unchecked(ROOT_LINES[k * LINE_MAX + 1 + d] = unchecked(EX_PREFIX_MOVES[d]));
        }
        for (let d = 0; d < exBestLen; d++) {
            unchecked(ROOT_LINES[k * LINE_MAX + 1 + exPrefixLen + d] = unchecked(EX_LINE[d]));
        }
        unchecked(ROOT_LINE_LEN[k] = <u8>len);
    }
    maybeMarkRootExact(k);
    const result = unchecked(ROOT_BEST[k]);
    consumeExactPrefix();
    return result;
}

// Backward-compatible fixed-child wrappers. The old begin contract returns 1
// rather than exposing the generation token; identity is still checked against
// the durable saved prefix before delegating to the token commit.
export function exactBeginRootChildSeek(
    k: i32, secondCell: i32, budget: i32, target: i32,
): i32 {
    store<u8>(pu8(IO), <u8>(secondCell >= 0 && secondCell < CELLS ? secondCell : 255));
    return exactBeginRootPrefixSeek(k, 1, budget, target) > 0 ? 1 : 0;
}

export function exactCommitRootChild(k: i32, secondCell: i32): i32 {
    if (k < 0 || k >= rootCount || exPrefixRoot != k || exPrefixLen != 1 ||
        secondCell < 0 || secondCell >= CELLS ||
        <i32>unchecked(EX_PREFIX_MOVES[0]) != secondCell) {
        return NO_SCORE;
    }
    return exactCommitRootPrefix(exPrefixToken);
}

// merges a completed exact result into the root table: roots whose best equals
// the proven optimum are flagged exact; returns the optimum (or NO_SCORE)
export function exactMerge(): i32 {
    if (exPrefixRoot >= 0 || !exComplete) return NO_SCORE;

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

    // Whole-position completion proves that every root value is at least the
    // global optimum. Persist that shared lower bound so a constructive row at
    // the optimum becomes exact without separately enumerating its child.
    for (let k = 0; k < rootCount; k++) {
        if (<i32>unchecked(ROOT_LOWER[k]) < exBest) {
            unchecked(ROOT_LOWER[k] = <u8>exBest);
        }
        maybeMarkRootExact(k);
    }

    return exBest;
}

// ---------------------------------------------------------------------------
// value solver — exact minimax with a persistent value/policy memo
//
// Computes the exact optimal remaining after one root move. A frame may stop
// when a child attains its admissible lower bound; otherwise it enumerates all
// children. Stored values remain context-free and reusable across root moves,
// budget retries and later positions. Four-way replacement may cause safe
// re-expansion; a retained DFS frontier avoids replaying unfinished ancestors.
// ---------------------------------------------------------------------------

// The hard-proof corpus exceeds the old 2^21 table by an order of magnitude:
// it spent >80% of stores evicting another exact value and re-expanded for
// more than 100 seconds. The primary lane therefore keeps 2^23 entries. Extra
// independent lanes use a smaller table: their job is diversified beam/root
// work, and duplicating the primary's 96 MiB memo would make phones and
// notebooks unsafe. ENGINE_LITE is supplied at build time through asc --use.
// Satellites also run the threshold proof described below. One million
// entries is the smallest useful completed-state memo on hard positive
// endgames; the primary retains eight million entries.
const VTT_CAP: i32 = ENGINE_LITE != 0 ? 1 << 20 : 1 << 23;
const VTT_WAYS: i32 = 4;
const VTT_SETS: i32 = VTT_CAP / VTT_WAYS;
const VTT_SET_MASK: i32 = VTT_SETS - 1;
const VTT_KEY = new StaticArray<u64>(VTT_CAP);
const VTT_DATA = new StaticArray<u16>(VTT_CAP); // low byte value, high byte best move (255 terminal)
const VTT_STAMP = new StaticArray<u8>(VTT_CAP); // 0 empty, 1 occupied
const VTT_REMAINING = new StaticArray<u8>(VTT_CAP);
// Analysis generation of the last store or hit. Entries persist across
// positions by design, but an entry no earlier position ever reused must not
// crowd out the live analysis: certificates could not be stored at all in
// buckets holding four older exact values, so the coordinated threshold
// rotation retained no progress and re-expanded the same subtrees forever on
// a sequentially played game. Ages saturate at the u8 wrap distance; an alias
// merely delays one eviction and can never make a lookup unsound.
const VTT_GEN = new StaticArray<u8>(VTT_CAP);
let vttGeneration: i32 = 0;

// Age of a persistent entry in analysis generations, 0 = touched during the
// current position's analysis.
// @inline
function vttAge(at: i32): i32 {
    return (vttGeneration - <i32>unchecked(VTT_GEN[at])) & 255;
}
const EX_MIN = new StaticArray<i32>(EXACT_STACK);
const EX_BEST_MOVE = new StaticArray<u8>(EXACT_STACK);
const EX_HASH = new StaticArray<u64>(EXACT_STACK);
const EX_LOWER = new StaticArray<u8>(EXACT_STACK);

let vsActive: bool = false;
let vsPaused: bool = false;
let vsPausedRoot: i32 = -1;
let vsDepth: i32 = 0;
let vsNodes: i32 = 0;
let vsBudget: i32 = 0;
let vttHitMove: i32 = -1;

// The primary engine owns an 8M-entry value table. Before any value solve has
// started for a position, whole-board B&B can use its key/stamp storage as an
// 8x larger duplicate filter without allocating another phone-hostile table.
// Compact satellite engines retain the dedicated 1M-entry exact table because
// their value table is smaller. On generation wrap, preserve stamp-1 value
// entries and threshold certificates. Stamps 147..255 are reserved for this
// transient pass; 2..146 persistently encode `value > stamp-2` certificates.
function beginWideSeenPass(): void {
    exUseWideSeen = ENGINE_LITE == 0;
    if (!exUseWideSeen) return;

    wideSeenStamp++;
    if (wideSeenStamp < 147) {
        for (let at = 0; at < VTT_CAP; at++) {
            if (unchecked(VTT_STAMP[at]) >= 147) unchecked(VTT_STAMP[at] = 0);
        }
        wideSeenStamp = 147;
    }
}

function wideTtSeen(hash: u64): bool {
    const base = <i32>(hash & <u64>VTT_SET_MASK) * VTT_WAYS;
    let empty = -1;
    for (let way = 0; way < VTT_WAYS; way++) {
        const at = base + way;
        const stamp = unchecked(VTT_STAMP[at]);
        if (stamp == 0 || (stamp >= 147 && stamp != wideSeenStamp)) {
            if (empty < 0) empty = at;
        }
        if (stamp == wideSeenStamp && unchecked(VTT_KEY[at]) == hash) {
            return true;
        }
    }
    // A bucket full of exact values/certificates remains useful after this
    // one traversal. Failing open merely re-expands this state.
    if (empty < 0) return false;
    const at = empty;
    unchecked(VTT_STAMP[at] = wideSeenStamp);
    unchecked(VTT_KEY[at] = hash);
    return false;
}

function vttLookup(hash: u64): i32 {
    const base = <i32>(hash & <u64>VTT_SET_MASK) * VTT_WAYS;
    for (let way = 0; way < VTT_WAYS; way++) {
        const at = base + way;
        if (unchecked(VTT_STAMP[at]) == 1 && unchecked(VTT_KEY[at]) == hash) {
            const data = unchecked(VTT_DATA[at]);
            vttHitMove = <i32>(data >> 8);
            unchecked(VTT_GEN[at] = <u8>vttGeneration); // reused: keep it live
            return <i32>(data & 255);
        }
    }
    return -1;
}

function vttStore(hash: u64, value: i32, move: i32, remaining: i32): void {
    const base = <i32>(hash & <u64>VTT_SET_MASK) * VTT_WAYS;
    let sameKey = -1;
    let free = -1;
    let deadEntry = -1;
    let stale = -1;
    let staleAge = 0;
    let liveCert = -1;
    let victim = base;
    let victimRemaining = 255;
    for (let way = 0; way < VTT_WAYS; way++) {
        const probe = base + way;
        const stamp = unchecked(VTT_STAMP[probe]);
        if (stamp == 0 || stamp >= 147) {
            if (free < 0) free = probe;
            continue;
        }
        if (unchecked(VTT_KEY[probe]) == hash) {
            sameKey = probe;
            break;
        }
        const keptRemaining = <i32>unchecked(VTT_REMAINING[probe]);
        if (keptRemaining > rootRemaining) {
            // Remaining counts only ever shrink, so an entry above the
            // current analysis root's count can never be looked up again.
            if (deadEntry < 0) deadEntry = probe;
            continue;
        }
        const age = vttAge(probe);
        if (age > staleAge) {
            // Persisted but never reused this analysis: reclaimable, oldest
            // first. Cross-position memory may help, never crowd out the
            // live sub-DAG.
            staleAge = age;
            stale = probe;
        } else if (age == 0 && stamp != 1) {
            if (liveCert < 0) liveCert = probe;
        } else if (age == 0 && keptRemaining < victimRemaining) {
            victimRemaining = keptRemaining;
            victim = probe;
        }
    }
    // Among entries of the current analysis, retain the state with more
    // cells: it roots a larger sub-DAG and is much more expensive to
    // reconstruct. Random replacement at the same capacity proved only 1/10
    // hard roots in 60 s; depth preference proved all 10 in 45 s. Provably
    // unreachable entries go first, then the stalest generation, then live
    // certificates, then the shallowest live value.
    const at = sameKey >= 0 ? sameKey :
        free >= 0 ? free :
        deadEntry >= 0 ? deadEntry :
        stale >= 0 ? stale :
        liveCert >= 0 ? liveCert : victim;
    unchecked(VTT_STAMP[at] = 1);
    unchecked(VTT_KEY[at] = hash);
    unchecked(VTT_DATA[at] = <u16>(value | (move << 8)));
    unchecked(VTT_REMAINING[at] = <u8>remaining);
    unchecked(VTT_GEN[at] = <u8>vttGeneration);
}

// ---------------------------------------------------------------------------
// threshold solver — persistent proof that no line reaches `target`
//
// Whole-value enumeration answers much more than a positive position needs.
// If the incumbent is 1, the proof obligation is only "does a clearing line
// exist?" This resumable OR-DFS stores a state only after every child has
// failed that threshold. Such certificates are context-free and survive
// root changes and clicks; stamp 2+t means the exact statement value > t.
// ---------------------------------------------------------------------------

let tsActive: bool = false;
let tsPaused: bool = false;
let tsComplete: bool = false;
let tsFound: bool = false;
let tsTarget: i32 = -1;
let tsRoot: i32 = -1; // -1 whole position, otherwise child below this root
// -1 searches the whole board/whole root child. A non-negative value searches
// only [root, saved prefix]. Such a branch can contribute a witness
// immediately, but its miss is only one part of a caller-side coverage proof
// and must never raise ROOT_LOWER by itself.
let tsPrefixLen: i32 = -1;
let tsDepth: i32 = 0;
let tsNodes: i32 = 0;
let tsBudget: i32 = 0;
let tsFoundScore: i32 = NO_SCORE;
let tsFoundLen: i32 = 0;

function cancelThreshold(): void {
    tsActive = false;
    tsPaused = false;
    tsComplete = false;
    tsFound = false;
    tsRoot = -1;
    tsPrefixLen = -1;
    tsDepth = 0;
    tsNodes = 0;
    tsBudget = 0;
    tsFoundScore = NO_SCORE;
    tsFoundLen = 0;
}

// A paused threshold frontier owns the exact prefix bytes that created it.
// IO is shared scratch, so callers must rewrite the prefix before every begin;
// comparing it here prevents a retry for branch B from resuming branch A.
function thresholdPrefixMatches(prefixLen: i32): bool {
    if (tsPrefixLen != prefixLen) return false;
    if (prefixLen < 0) return true;
    for (let d = 0; d < prefixLen; d++) {
        if (load<u8>(pu8(IO) + <usize>d) != unchecked(EX_PREFIX_MOVES[d])) {
            return false;
        }
    }
    return true;
}

let thresholdForcedMove: i32 = -1;

// One bucket probe handles both exact values and threshold certificates.
// Returns true when the state is already known above target; an exact value
// at/below target supplies a policy move for witness-first ordering.
function thresholdMemoDead(hash: u64, target: i32): bool {
    thresholdForcedMove = -1;
    const base = <i32>(hash & <u64>VTT_SET_MASK) * VTT_WAYS;
    for (let way = 0; way < VTT_WAYS; way++) {
        const at = base + way;
        const stamp = <i32>unchecked(VTT_STAMP[at]);
        if (unchecked(VTT_KEY[at]) != hash) continue;
        if (stamp == 1) {
            const data = unchecked(VTT_DATA[at]);
            unchecked(VTT_GEN[at] = <u8>vttGeneration); // reused: keep it live
            if (<i32>(data & 255) > target) return true;
            thresholdForcedMove = <i32>(data >> 8);
            return false;
        }
        if (stamp >= 2 && stamp <= 146 && stamp - 2 >= target) {
            unchecked(VTT_GEN[at] = <u8>vttGeneration);
            return true;
        }
    }
    return false;
}

function thresholdStoreCertificate(hash: u64, target: i32, remaining: i32): void {
    const base = <i32>(hash & <u64>VTT_SET_MASK) * VTT_WAYS;
    let at = -1;
    let deadEntry = -1;
    let stale = -1;
    let staleAge = 0;
    let victim = -1;
    let victimRemaining = 255;
    const wanted = target + 2;

    for (let way = 0; way < VTT_WAYS; way++) {
        const probe = base + way;
        const stamp = <i32>unchecked(VTT_STAMP[probe]);
        if (stamp != 0 && unchecked(VTT_KEY[probe]) == hash) {
            if (stamp == 1) return; // an exact value is strictly stronger
            if (stamp >= 2 && stamp <= 146) {
                if (stamp < wanted) unchecked(VTT_STAMP[probe] = <u8>wanted);
                if (<i32>unchecked(VTT_REMAINING[probe]) < remaining) {
                    unchecked(VTT_REMAINING[probe] = <u8>remaining);
                }
                unchecked(VTT_GEN[probe] = <u8>vttGeneration);
                return;
            }
        }
        if ((stamp == 0 || stamp >= 147) && at < 0) {
            at = probe;
            continue;
        }
        if (<i32>unchecked(VTT_REMAINING[probe]) > rootRemaining) {
            // Unreachable from the current analysis root (see vttStore):
            // stale values and certificates from earlier positions must not
            // block the live position's certificates — rotation-based
            // coordinated proofs retain progress only through these stores.
            if (deadEntry < 0) deadEntry = probe;
            continue;
        }
        const age = vttAge(probe);
        if (age > staleAge) {
            // Untouched since an earlier position: reclaimable, oldest first
            // — even when it is an exact value. Without this, buckets filled
            // by previously played positions permanently reject the live
            // position's certificates.
            staleAge = age;
            stale = probe;
        } else if (age == 0 && stamp >= 2 && stamp <= 146) {
            const keptRemaining = <i32>unchecked(VTT_REMAINING[probe]);
            if (keptRemaining < victimRemaining) {
                victimRemaining = keptRemaining;
                victim = probe;
            }
        }
    }

    // Preserve buckets containing four exact values of the current analysis.
    // As with every cache miss, declining to store causes only safe
    // re-expansion.
    if (at < 0) at = deadEntry;
    if (at < 0) at = stale;
    if (at < 0) at = victim;
    if (at < 0) return;
    unchecked(VTT_KEY[at] = hash);
    unchecked(VTT_STAMP[at] = <u8>wanted);
    unchecked(VTT_REMAINING[at] = <u8>remaining);
    unchecked(VTT_GEN[at] = <u8>vttGeneration);
}

function thresholdCapture(score: i32): void {
    tsFound = true;
    tsFoundScore = score;
    tsFoundLen = tsDepth;
    for (let d = 0; d < tsDepth; d++) {
        unchecked(EX_LINE[d] = unchecked(EX_MOVE[d]));
    }
}

// Returns -1 when a frame was pushed, 0 for a certified dead state and 1
// after recording a threshold witness.
function thresholdPush(bd: usize, inheritedLower: i32, parentRemaining: i32): i32 {
    scanExactStats(bd);
    if (parentRemaining < 0) {
        strengthenExactStats(bd);
    } else if (statRemaining <= PERMANENT_EXACT_REMAINING &&
        parentRemaining > PERMANENT_EXACT_REMAINING) {
        statLower = permanentLower(bd);
    }
    if (statLower < inheritedLower) statLower = inheritedLower;

    const hash = statHash;
    if (statLower > tsTarget) {
        return 0;
    }
    if (thresholdMemoDead(hash, tsTarget)) return 0;
    const forcedMove = thresholdForcedMove;

    const frame = tsDepth;
    const frameBd = pu8(EX_BOARDS) + <usize>(frame * CELLS);
    if (frameBd != bd) memory.copy(frameBd, bd, CELLS);
    let n = enumerateGroups(frameBd);
    if (n == 0) {
        if (statRemaining <= tsTarget) {
            thresholdCapture(statRemaining);
            return 1;
        }
        return 0;
    }

    if (forcedMove >= 0) {
        for (let g = 0; g < n; g++) {
            if (<i32>unchecked(REPS[g]) == forcedMove) {
                unchecked(REPS[0] = unchecked(REPS[g]));
                n = 1;
                break;
            }
        }
    }
    memory.copy(pu8(EX_REPS) + <usize>(frame * MAX_ROOTS), pu8(REPS), n);
    unchecked(EX_COUNT[frame] = n);
    unchecked(EX_CURSOR[frame] = 0);
    unchecked(EX_HASH[frame] = hash);
    unchecked(EX_LOWER[frame] = <u8>statLower);
    unchecked(EX_REMAINING[frame] = <u8>statRemaining);
    tsDepth++;
    return -1;
}

// Starts a fresh whole-position threshold decision or resumes the retained
// frontier after a budget stop. Returns -1 while running, -2 only for an
// invalid request, `target` or less for a witness, and target+1 for a complete
// no-target certificate.
function thresholdStart(root: i32, prefixLen: i32, target: i32, budget: i32): i32 {
    if (target < 0 || target > CELLS || budget < 0 ||
        root < -1 || root >= rootCount || prefixLen < -1 ||
        prefixLen >= LINE_MAX || (prefixLen >= 0 && root < 0)) {
        cancelThreshold();
        return -2;
    }
    consumeExactPrefix();
    vsActive = false;
    vsPaused = false;

    if (tsPaused && tsTarget == target && tsRoot == root &&
        thresholdPrefixMatches(prefixLen)) {
        tsPaused = false;
        tsActive = true;
        tsNodes = 0;
        tsBudget = budget;
        return -1;
    }

    cancelThreshold();
    tsTarget = target;
    tsRoot = root;
    tsPrefixLen = prefixLen;
    tsBudget = budget;
    tsActive = true;
    let start = pu8(ROOT_BOARD);
    let inheritedLower = 0;
    let parentRemaining = -1;
    if (root >= 0) {
        if (prefixLen >= 0) {
            if (!materializeRootPrefix(root, prefixLen, pu8(PLAYOUT_BOARD))) {
                cancelThreshold();
                return -2;
            }
            if (prefixLen > 0) {
                memory.copy(pu8(EX_PREFIX_MOVES), pu8(PREFIX_MOVES), prefixLen);
            }
        } else {
            memory.copy(pu8(PLAYOUT_BOARD), pu8(ROOT_BOARD), CELLS);
            if (applyMove(pu8(PLAYOUT_BOARD), <i32>unchecked(ROOT_REP[root])) < 2) {
                cancelThreshold();
                return -2;
            }
        }
        start = pu8(PLAYOUT_BOARD);
        inheritedLower = <i32>unchecked(ROOT_LOWER[root]);
        parentRemaining = rootRemaining;
    }
    const immediate = thresholdPush(start, inheritedLower, parentRemaining);
    if (immediate == 1) {
        tsActive = false;
        tsComplete = true;
        return tsFoundScore;
    }
    if (immediate == 0) {
        tsActive = false;
        tsComplete = true;
        return tsTarget + 1;
    }
    return -1;
}

export function thresholdBegin(target: i32, budget: i32): i32 {
    return thresholdStart(-1, -1, target, budget);
}

export function thresholdBeginChild(k: i32, target: i32, budget: i32): i32 {
    return thresholdStart(k, -1, target, budget);
}

// JS writes `prefixLen` legal moves after root k to IO. The decision result
// uses the ordinary threshold contract, but a completed miss remains local to
// this fixed branch. Only the pool, after covering every legal sibling prefix,
// may compose those misses into a root lower bound.
export function thresholdBeginRootPrefix(
    k: i32, prefixLen: i32, target: i32, budget: i32,
): i32 {
    return thresholdStart(k, prefixLen, target, budget);
}

export function thresholdCancel(): void {
    cancelThreshold();
}

// Runs a bounded slice. Budget exhaustion retains the exact DFS frontier;
// completed certificates already stored in VTT are never rolled back.
export function thresholdStep(chunk: i32): i32 {
    if (!tsActive) return -2;
    let spent = 0;
    while (spent < chunk) {
        if (tsDepth == 0) {
            tsActive = false;
            tsComplete = true;
            return tsTarget + 1;
        }

        const frame = tsDepth - 1;
        const cursor = unchecked(EX_CURSOR[frame]);
        const count = unchecked(EX_COUNT[frame]);
        if (cursor >= count) {
            thresholdStoreCertificate(unchecked(EX_HASH[frame]), tsTarget,
                <i32>unchecked(EX_REMAINING[frame]));
            tsDepth--;
            continue;
        }
        if (tsNodes >= tsBudget) {
            tsActive = false;
            tsPaused = true;
            return -2;
        }
        if (tsDepth >= EXACT_STACK) {
            tsActive = false;
            tsPaused = false;
            return -2;
        }

        unchecked(EX_CURSOR[frame] = cursor + 1);
        const child = pu8(EX_BOARDS) + <usize>(tsDepth * CELLS);
        memory.copy(child, pu8(EX_BOARDS) + <usize>(frame * CELLS), CELLS);
        const move = unchecked(EX_REPS[frame * MAX_ROOTS + cursor]);
        unchecked(EX_MOVE[frame] = move);
        applyMove(child, <i32>move);
        tsNodes++;
        spent++;
        nodesExpanded++;
        exactPositions++;

        const result = thresholdPush(child, <i32>unchecked(EX_LOWER[frame]),
            <i32>unchecked(EX_REMAINING[frame]));
        if (result == 1) {
            tsActive = false;
            tsPaused = false;
            tsComplete = true;
            return tsFoundScore;
        }
    }
    return -1;
}

// Merge only a completed decision. A witness is a constructive line. A miss
// proves the searched whole position—or the selected child root—is above
// target. When every root incumbent was target+1, the merged row bounds
// compose into the global optimum without enumerating larger values.
export function thresholdMerge(): i32 {
    if (!tsComplete) return NO_SCORE;
    if (tsFound) {
        if (tsRoot >= 0) {
            const k = tsRoot;
            const prefixLen = tsPrefixLen >= 0 ? tsPrefixLen : 0;
            const len = tsFoundLen + prefixLen + 1;
            if (len <= LINE_MAX && tsFoundScore < unchecked(ROOT_BEST[k])) {
                unchecked(ROOT_BEST[k] = tsFoundScore);
                unchecked(ROOT_LINES[k * LINE_MAX] = unchecked(ROOT_REP[k]));
                for (let d = 0; d < prefixLen; d++) {
                    unchecked(ROOT_LINES[k * LINE_MAX + 1 + d] =
                        unchecked(EX_PREFIX_MOVES[d]));
                }
                for (let d = 0; d < tsFoundLen; d++) {
                    unchecked(ROOT_LINES[k * LINE_MAX + 1 + prefixLen + d] =
                        unchecked(EX_LINE[d]));
                }
                unchecked(ROOT_LINE_LEN[k] = <u8>len);
            }
            maybeMarkRootExact(k);
        } else if (tsFoundLen > 0) {
            const first = unchecked(EX_LINE[0]);
            for (let k = 0; k < rootCount; k++) {
                if (<i32>unchecked(ROOT_REP[k]) != <i32>first) continue;
                if (tsFoundScore < unchecked(ROOT_BEST[k])) {
                    unchecked(ROOT_BEST[k] = tsFoundScore);
                    unchecked(ROOT_LINE_LEN[k] = <u8>tsFoundLen);
                    memory.copy(pu8(ROOT_LINES) + <usize>(k * LINE_MAX),
                        pu8(EX_LINE), tsFoundLen);
                }
                maybeMarkRootExact(k);
                break;
            }
        }
        return tsFoundScore;
    }

    const lower = tsTarget + 1;
    // Exhausting one fixed prefix proves only that branch. Raising the parent
    // here would turn a single sibling miss into a false minimax certificate.
    if (tsPrefixLen >= 0) return lower;
    const firstRoot = tsRoot >= 0 ? tsRoot : 0;
    const lastRoot = tsRoot >= 0 ? tsRoot + 1 : rootCount;
    for (let k = firstRoot; k < lastRoot; k++) {
        if (<i32>unchecked(ROOT_LOWER[k]) < lower) {
            unchecked(ROOT_LOWER[k] = <u8>lower);
        }
        maybeMarkRootExact(k);
    }
    return lower;
}

// Pushes a board, resolves it immediately, or proves that it cannot improve
// an already resolved sibling. Returns -1 when pushed, an exact value on a
// memo hit/terminal, or CELLS+1 for a safely skipped sibling.
function vsPush(bd: usize, cutoff: i32, inheritedLower: i32, parentRemaining: i32): i32 {
    scanExactStats(bd);
    if (statRemaining <= PERMANENT_EXACT_REMAINING &&
        parentRemaining > PERMANENT_EXACT_REMAINING) {
        statLower = permanentLower(bd);
    }
    if (statLower < inheritedLower) statLower = inheritedLower;
    if (cutoff != NO_SCORE && statLower >= cutoff) return CELLS + 1;
    const hash = statHash;
    const memo = vttLookup(hash);
    if (memo >= 0) return memo;

    const frame = vsDepth;
    const frameBd = pu8(EX_BOARDS) + <usize>(frame * CELLS);
    if (frameBd != bd) memory.copy(frameBd, bd, CELLS);
    const n = enumerateGroups(frameBd);

    if (n == 0) {
        const value = statRemaining;
        // The exact memo is a cache, not durable policy storage. Record an
        // improving terminal directly from the live DFS stack so later table
        // replacement cannot erase the only constructive optimal witness.
        const root = vsPausedRoot;
        if (root >= 0 && root < rootCount && value < unchecked(ROOT_BEST[root]) &&
            vsDepth + 1 <= LINE_MAX) {
            unchecked(ROOT_BEST[root] = value);
            unchecked(ROOT_LINES[root * LINE_MAX] = unchecked(ROOT_REP[root]));
            for (let d = 0; d < vsDepth; d++) {
                unchecked(ROOT_LINES[root * LINE_MAX + 1 + d] = unchecked(EX_MOVE[d]));
            }
            unchecked(ROOT_LINE_LEN[root] = <u8>(vsDepth + 1));
            maybeMarkRootExact(root);
        }
        vttStore(hash, value, 255, statRemaining);
        return value;
    }

    // Cheap pre-copy sibling bounds in the existing stable scan order. An
    // O(n²) ordering experiment reduced nodes but increased total time; keep
    // the cutoff without paying that per-frame sorting cost.
    for (let g = 0; g < n; g++) {
        const color = <i32>unchecked(REP_COLORS[g]);
        const size = <i32>unchecked(REP_SIZES[g]);
        const after = unchecked(colorTotal[color]) - size;
        const singleton = statSingletonLower + (after == 1 ? 1 : 0);
        const lower = statLower > singleton ? statLower : singleton;
        unchecked(EX_REPS[frame * MAX_ROOTS + g] = unchecked(REPS[g]));
        unchecked(EX_CHILD_LOWER[frame * MAX_ROOTS + g] = <u8>lower);
    }
    unchecked(EX_COUNT[frame] = n);
    unchecked(EX_CURSOR[frame] = 0);
    unchecked(EX_MIN[frame] = NO_SCORE);
    unchecked(EX_BEST_MOVE[frame] = 255);
    unchecked(EX_HASH[frame] = hash);
    unchecked(EX_LOWER[frame] = <u8>statLower);
    unchecked(EX_REMAINING[frame] = <u8>statRemaining);
    vsDepth++;
    return -1;
}

// starts a value solve of the child after root move k; the memo is kept when
// the analysis position is unchanged, so successive moves and retries reuse
// all earlier work. Returns -3 on a bad k, -1 when running (drive with
// vsStep), or the immediate value
export function vsBegin(k: i32, budget: i32): i32 {
    consumeExactPrefix();
    cancelThreshold();
    if (k < 0 || k >= rootCount) return -3;

    // A budget retry of the same root resumes the explicit DFS frontier.
    // Completed subtrees remain in VTT either way; retaining the stack also
    // prevents re-walking its unfinished ancestors.
    if (vsPaused && k == vsPausedRoot) {
        vsPaused = false;
        vsActive = true;
        vsNodes = 0;
        vsBudget = budget;
        return -1;
    }
    vsPaused = false;

    vsNodes = 0;
    vsBudget = budget;
    vsDepth = 0;
    vsPausedRoot = k;

    memory.copy(pu8(PLAYOUT_BOARD), pu8(ROOT_BOARD), CELLS);
    applyMove(pu8(PLAYOUT_BOARD), <i32>unchecked(ROOT_REP[k]));

    const immediate = vsPush(pu8(PLAYOUT_BOARD), NO_SCORE,
        <i32>unchecked(ROOT_LOWER[k]), 0);
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

        // Once a child attains this state's admissible lower bound, its value
        // is exact and no unvisited sibling can improve it. Memoizing here is
        // context-free despite the skipped moves.
        if (unchecked(EX_MIN[frame]) != <i32>unchecked(EX_LOWER[frame]) && cursor < n) {
            if (vsNodes >= vsBudget) {
                vsActive = false;
                vsPaused = true;
                return -2;
            }
            if (vsDepth >= EXACT_STACK) { // cannot happen: depth <= 72
                vsActive = false;
                vsPaused = false;
                return -2;
            }

            unchecked(EX_CURSOR[frame] = cursor + 1);
            const childLower = <i32>unchecked(EX_CHILD_LOWER[frame * MAX_ROOTS + cursor]);
            if (unchecked(EX_MIN[frame]) != NO_SCORE && childLower >= unchecked(EX_MIN[frame])) {
                continue;
            }
            const child = pu8(EX_BOARDS) + <usize>(vsDepth * CELLS);
            memory.copy(child, pu8(EX_BOARDS) + <usize>(frame * CELLS), CELLS);
            const move = unchecked(EX_REPS[frame * MAX_ROOTS + cursor]);
            unchecked(EX_MOVE[frame] = move);
            applyMove(child, <i32>move);
            vsNodes++;
            spent++;
            nodesExpanded++;
            exactPositions++;

            const value = vsPush(child, unchecked(EX_MIN[frame]), childLower,
                <i32>unchecked(EX_REMAINING[frame]));
            if (value >= 0 && value < unchecked(EX_MIN[frame])) {
                unchecked(EX_MIN[frame] = value);
                unchecked(EX_BEST_MOVE[frame] = unchecked(EX_REPS[frame * MAX_ROOTS + cursor]));
            }
        } else {
            // frame fully enumerated — memoize and merge into the parent
            const value = unchecked(EX_MIN[frame]);
            vttStore(unchecked(EX_HASH[frame]), value, <i32>unchecked(EX_BEST_MOVE[frame]),
                <i32>unchecked(EX_REMAINING[frame]));
            vsDepth--;

            if (vsDepth == 0) {
                vsActive = false;
                vsPaused = false;
                return value;
            }
            if (value < unchecked(EX_MIN[vsDepth - 1])) {
                unchecked(EX_MIN[vsDepth - 1] = value);
                const parent = vsDepth - 1;
                const moveAt = unchecked(EX_CURSOR[parent]) - 1;
                unchecked(EX_BEST_MOVE[parent] = unchecked(EX_REPS[parent * MAX_ROOTS + moveAt]));
            }
        }
    }

    return -1;
}

// Reconstructs an optimal root line from the exact value memo. Each solved
// entry stores a move attaining its value, so recovery is normally O(line
// length); direct-table eviction is detected and the worker can fall back to
// exactChildSeek. Returns 1 after merging a replayable proven line, else 0.
export function vsBuildLine(k: i32, target: i32): i32 {
    if (k < 0 || k >= rootCount || target < 0 || target > CELLS) return 0;

    memory.copy(pu8(PLAYOUT_BOARD), pu8(ROOT_BOARD), CELLS);
    if (applyMove(pu8(PLAYOUT_BOARD), <i32>unchecked(ROOT_REP[k])) == 0) return 0;
    unchecked(PLAYOUT_LINE[0] = unchecked(ROOT_REP[k]));
    let len = 1;

    for (;;) {
        scanExactStats(pu8(PLAYOUT_BOARD));
        const value = vttLookup(statHash);
        if (value != target) return 0;

        const move = vttHitMove;
        if (move == 255) {
            if (statRemaining != target) return 0;
            if (target < unchecked(ROOT_BEST[k])) {
                unchecked(ROOT_BEST[k] = target);
                unchecked(ROOT_LINE_LEN[k] = <u8>len);
                memory.copy(pu8(ROOT_LINES) + <usize>(k * LINE_MAX), pu8(PLAYOUT_LINE), len);
            }
            if (unchecked(ROOT_BEST[k]) != target) return 0;
            unchecked(ROOT_EXACT[k] = 1);
            return 1;
        }

        if (len >= LINE_MAX || applyMove(pu8(PLAYOUT_BOARD), move) == 0) return 0;
        unchecked(PLAYOUT_LINE[len++] = <u8>move);
    }
    return 0;
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
//   telemetry footer: magic u32, flags u32, then four u64 counters
//     beamPositions, exactPositions, cpuPlayoutPositions, cpuPlayouts
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

    store<u32>(io + at, 0x32544154); // "TAT2": telemetry accounting v2
    at += 4;
    store<u32>(io + at, (ASC_FEATURE_SIMD ? 1 : 0) | (ENGINE_LITE != 0 ? 2 : 0));
    at += 4;
    store<u32>(io + at, <u32>(beamPositions & 0xFFFFFFFF));
    store<u32>(io + at + 4, <u32>(beamPositions >> 32));
    at += 8;
    store<u32>(io + at, <u32>(exactPositions & 0xFFFFFFFF));
    store<u32>(io + at + 4, <u32>(exactPositions >> 32));
    at += 8;
    store<u32>(io + at, <u32>(cpuPlayoutPositions & 0xFFFFFFFF));
    store<u32>(io + at + 4, <u32>(cpuPlayoutPositions >> 32));
    at += 8;
    store<u32>(io + at, <u32>(cpuPlayouts & 0xFFFFFFFF));
    store<u32>(io + at + 4, <u32>(cpuPlayouts >> 32));
    at += 8;

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

// Admissible forced-cell lower bound of the IO board, exposed for exhaustive
// separator validation in the Node suite.
export function testLowerBound(): i32 {
    scanExactStats(pu8(IO));
    strengthenExactStats(pu8(IO));
    return statLower;
}

// Delete-relaxation twin exposed only so the Node suite can compare the
// admissible result with brute-force game values on complete small domains.
export function testPotentialLowerBound(): i32 {
    return potentialRemovalLower(pu8(IO));
}

// one recorded playout on the IO board (no root move); returns final remaining,
// move line at IO+257 prefixed by its length at IO+256
export function testPlayout(seed: u32): i32 {
    memory.copy(pu8(PLAYOUT_BOARD), pu8(IO), CELLS);
    unchecked(PLAYOUT_LINE[0] = 0);
    const final = playoutRun(seed, true, dominantColor(pu8(PLAYOUT_BOARD)), false, 1);
    const len = playoutLastLen > 0 ? playoutLastLen - 1 : 0;
    store<u8>(pu8(IO) + 256, <u8>len);
    memory.copy(pu8(IO) + 257, pu8(PLAYOUT_LINE) + 1, len);
    return final;
}

// Full-support twin used to verify that tabu remains a bias in the exploratory
// portfolio. Layout matches testPlayout.
export function testPlayoutSoft(seed: u32): i32 {
    memory.copy(pu8(PLAYOUT_BOARD), pu8(IO), CELLS);
    unchecked(PLAYOUT_LINE[0] = 0);
    const final = playoutRun(seed, true, dominantColor(pu8(PLAYOUT_BOARD)), true, 1);
    const len = playoutLastLen > 0 ? playoutLastLen - 1 : 0;
    store<u8>(pu8(IO) + 256, <u8>len);
    memory.copy(pu8(IO) + 257, pu8(PLAYOUT_LINE) + 1, len);
    return final;
}
