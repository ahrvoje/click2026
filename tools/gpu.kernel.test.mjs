/**
 * Word-level equivalence harness for the bitplane WGSL playout kernel.
 *
 * The kernel in gpu.js keeps each board as four 144-bit masks (occupancy +
 * three color-bit planes) in five u32 words and replaces per-cell flood fill
 * with bit-parallel dilation. This test mirrors those word-level operations
 * 1:1 in JavaScript (same constants, same carry formulas, same two-pass
 * enumeration and collapse structure) and proves them equivalent to a plain
 * per-cell oracle of playoutRun() in asm/engine.ts: identical move sequences,
 * identical processed-position counts, identical final boards.
 *
 * Production boards are always collapsed (children of applyMove), so the
 * playout sweep uses normalized inputs, exactly like the live kernel.
 * Run with: node tools/gpu.kernel.test.mjs
 */

import assert from "node:assert/strict";
import { dominantColor } from "../src/scripts/engine/gpu.js";

const W = (x) => x >>> 0;
const ctz32 = (x) => 31 - Math.clz32(x & -x);

function maskWords(predicate) {
    const words = [0, 0, 0, 0, 0];
    for (let bit = 0; bit < 144; bit++) {
        if (predicate(bit)) words[bit >> 5] |= 1 << (bit & 31);
    }
    return words.map(W);
}

const NOT_ROW0 = maskWords((bit) => bit % 12 !== 0);
const NOT_ROW11 = maskWords((bit) => bit % 12 !== 11);

// --- M144 word ops — each mirrors the WGSL helper of the same name ----------

const mZero = () => [0, 0, 0, 0, 0];
const mAnd = (a, b) => a.map((w, i) => W(w & b[i]));
const mOr = (a, b) => a.map((w, i) => W(w | b[i]));
const mAndNot = (a, b) => a.map((w, i) => W(w & ~b[i]));
const mIsZero = (a) => a.every((w) => w === 0);
const mEq = (a, b) => a.every((w, i) => w === b[i]);
const mPop = (a) => a.reduce((total, w) => {
    let v = W(w);
    let count = 0;
    while (v !== 0) { v = W(v & (v - 1)); count++; }
    return total + count;
}, 0);
const mFtb = (a) => {
    for (let i = 0; i < 5; i++) if (a[i] !== 0) return i * 32 + ctz32(a[i]);
    return -1;
};
const mBit = (cell) => {
    const r = mZero();
    r[cell >> 5] = W(1 << (cell & 31));
    return r;
};
const mHas = (a, cell) => ((a[cell >> 5] >>> (cell & 31)) & 1) !== 0;

const mUp = (a) => a.map((w, i) =>
    W(((w << 1) | (i > 0 ? a[i - 1] >>> 31 : 0)) & NOT_ROW0[i]));
const mDown = (a) => a.map((w, i) =>
    W(((w >>> 1) | (i < 4 ? a[i + 1] << 31 : 0)) & NOT_ROW11[i]));
const mRight = (a) => a.map((w, i) => {
    const v = (w << 12) | (i > 0 ? a[i - 1] >>> 20 : 0);
    return W(i === 4 ? v & 0xFFFF : v);
});
const mLeft = (a) => a.map((w, i) =>
    W((w >>> 12) | (i < 4 ? a[i + 1] << 20 : 0)));
const neighborsOf = (a) => mOr(mOr(mUp(a), mDown(a)), mOr(mLeft(a), mRight(a)));

const field12 = (a, base) => {
    const w = base >> 5;
    const s = base & 31;
    const high = s > 20 ? (w + 1 < 5 ? a[w + 1] : 0) << (32 - s) : 0;
    return W(((a[w] >>> s) | high) & 0xFFF);
};
const setField12 = (a, base, value) => {
    const w = base >> 5;
    const s = base & 31;
    const r = a.slice();
    r[w] = W((r[w] & ~W(0xFFF << s)) | W(value << s));
    if (s > 20 && w + 1 < 5) {
        r[w + 1] = W((r[w + 1] & ~(0xFFF >>> (32 - s))) | (value >>> (32 - s)));
    }
    return r;
};

// --- shared xorshift128 — twin of rngNext()/rngSeed() -----------------------

function makeRng(seed) {
    let x = W(seed ^ 0x9E3779B9);
    let y = W(Math.imul(seed, 1664525) + 1013904223);
    let z = W(seed ^ 0x85EBCA6B);
    let w = W(Math.imul(seed, 2246822519) + 374761393);
    if (w === 0) w = 0x6C078965;
    const next = () => {
        const t = W(x ^ (x << 11));
        x = y; y = z; z = w;
        w = W((w ^ (w >>> 19)) ^ (t ^ (t >>> 8)));
        return w;
    };
    for (let i = 0; i < 4; i++) next();
    return next;
}

// --- per-cell oracle: direct port of playoutRun() over a byte board ---------

function oraclePlayout(input, seed, tabu) {
    const board = Uint8Array.from(input);
    const rng = makeRng(seed);
    const moves = [];
    let positions = 0;

    for (;;) {
        const visited = new Uint8Array(144);
        const groups = [];
        for (let cell = 0; cell < 144; cell++) {
            if (visited[cell]) continue;
            const color = board[cell];
            if (color === 0) continue;
            visited[cell] = 1;
            const stack = [cell];
            const members = [];
            while (stack.length > 0) {
                const c = stack.pop();
                members.push(c);
                const row = c % 12;
                for (const nb of [c - 12, c + 12, row > 0 ? c - 1 : -1, row < 11 ? c + 1 : -1]) {
                    if (nb >= 0 && nb < 144 && board[nb] === color && !visited[nb]) {
                        visited[nb] = 1;
                        stack.push(nb);
                    }
                }
            }
            if (members.length >= 2) groups.push({ cell, color, members });
        }
        if (groups.length === 0) break;
        positions++;

        const nonTabu = groups.filter((group) => group.color !== tabu);
        let picked;
        if (nonTabu.length > 0) picked = nonTabu[rng() % nonTabu.length];
        else picked = groups[rng() % groups.length];
        moves.push(picked.cell);

        const touched = new Set();
        for (const c of picked.members) {
            board[c] = 0;
            touched.add(Math.floor(c / 12));
        }
        let emptied = false;
        for (const col of touched) {
            let write = 0;
            for (let j = 0; j < 12; j++) {
                const v = board[col * 12 + j];
                if (v !== 0) {
                    if (write !== j) {
                        board[col * 12 + write] = v;
                        board[col * 12 + j] = 0;
                    }
                    write++;
                }
            }
            if (write === 0) emptied = true;
        }
        if (emptied) {
            let write = 0;
            for (let col = 0; col < 12; col++) {
                if (board[col * 12] !== 0) {
                    if (write !== col) {
                        for (let j = 0; j < 12; j++) {
                            board[write * 12 + j] = board[col * 12 + j];
                            board[col * 12 + j] = 0;
                        }
                    }
                    write++;
                }
            }
        }
    }

    let remaining = 0;
    for (let c = 0; c < 144; c++) if (board[c] !== 0) remaining++;
    return { moves, positions, remaining, board };
}

// --- bitplane simulation: mirrors the WGSL kernel main loop 1:1 -------------

function simPlayout(input, seed, tabu) {
    let occ = mZero();
    let pl0 = mZero();
    let pl1 = mZero();
    let pl2 = mZero();
    for (let cell = 0; cell < 144; cell++) {
        const color = input[cell];
        if (color === 0) continue;
        const bit = mBit(cell);
        occ = mOr(occ, bit);
        if (color & 1) pl0 = mOr(pl0, bit);
        if (color & 2) pl1 = mOr(pl1, bit);
        if (color & 4) pl2 = mOr(pl2, bit);
    }

    const colorAt = (cell) => (mHas(pl0, cell) ? 1 : 0) |
        ((mHas(pl1, cell) ? 1 : 0) << 1) | ((mHas(pl2, cell) ? 1 : 0) << 2);
    const sameColorMask = (color) => {
        const planeTerm = (plane) => (bitSet) => (w, i) =>
            W(w & (bitSet ? plane[i] : ~plane[i]));
        let r = occ.slice();
        r = r.map(planeTerm(pl0)((color & 1) !== 0));
        r = r.map(planeTerm(pl1)((color & 2) !== 0));
        r = r.map(planeTerm(pl2)((color & 4) !== 0));
        return r;
    };
    const floodFrom = (seedBit, same) => {
        let grp = seedBit;
        for (;;) {
            const grown = mAnd(mOr(grp, neighborsOf(grp)), same);
            if (mEq(grown, grp)) return grp;
            grp = grown;
        }
    };
    const collapseColumn = (col) => {
        const base = col * 12;
        const colOcc = field12(occ, base);
        const fallen = W((1 << mPop([colOcc, 0, 0, 0, 0])) - 1);
        if (colOcc === fallen) return colOcc === 0;
        const c0 = field12(pl0, base);
        const c1 = field12(pl1, base);
        const c2 = field12(pl2, base);
        let n0 = 0;
        let n1 = 0;
        let n2 = 0;
        let rem = colOcc;
        let k = 0;
        while (rem !== 0) {
            const j = ctz32(rem);
            rem = W(rem & (rem - 1));
            const bit = 1 << k;
            if ((c0 >>> j) & 1) n0 |= bit;
            if ((c1 >>> j) & 1) n1 |= bit;
            if ((c2 >>> j) & 1) n2 |= bit;
            k++;
        }
        occ = setField12(occ, base, fallen);
        pl0 = setField12(pl0, base, n0);
        pl1 = setField12(pl1, base, n1);
        pl2 = setField12(pl2, base, n2);
        return false;
    };
    const compactColumns = () => {
        let srcCols = 0;
        for (let col = 0; col < 12; col++) {
            if (mHas(occ, col * 12)) srcCols |= 1 << col;
        }
        if (srcCols === (1 << mPop([srcCols, 0, 0, 0, 0])) - 1) return;
        let rebuiltOcc = mZero();
        let rebuilt0 = mZero();
        let rebuilt1 = mZero();
        let rebuilt2 = mZero();
        let rem = srcCols;
        let dst = 0;
        while (rem !== 0) {
            const src = ctz32(rem);
            rem = W(rem & (rem - 1));
            const srcBase = src * 12;
            const dstBase = dst * 12;
            rebuiltOcc = setField12(rebuiltOcc, dstBase, field12(occ, srcBase));
            rebuilt0 = setField12(rebuilt0, dstBase, field12(pl0, srcBase));
            rebuilt1 = setField12(rebuilt1, dstBase, field12(pl1, srcBase));
            rebuilt2 = setField12(rebuilt2, dstBase, field12(pl2, srcBase));
            dst++;
        }
        occ = rebuiltOcc;
        pl0 = rebuilt0;
        pl1 = rebuilt1;
        pl2 = rebuilt2;
    };

    const rng = makeRng(seed);
    const moves = [];
    let positions = 0;

    for (let mv = 0; mv < 80; mv++) {
        // first pass: count clickable groups and non-tabu clickable groups
        let n = 0;
        let cand = 0;
        let unv = occ;
        while (!mIsZero(unv)) {
            const cell = mFtb(unv);
            const color = colorAt(cell);
            const seedBit = mBit(cell);
            const grp = floodFrom(seedBit, sameColorMask(color));
            unv = mAndNot(unv, grp);
            if (!mEq(grp, seedBit)) {
                n++;
                if (color !== tabu) cand++;
            }
        }
        if (n === 0) break;
        positions++;

        let wantNonTabu = false;
        let pick;
        if (cand > 0) {
            pick = rng() % cand;
            wantNonTabu = true;
        } else {
            pick = rng() % n;
        }

        // second pass: same order, stop at the picked group
        let grp = mZero();
        let seen = 0;
        unv = occ;
        while (!mIsZero(unv)) {
            const cell = mFtb(unv);
            const color = colorAt(cell);
            const seedBit = mBit(cell);
            const cur = floodFrom(seedBit, sameColorMask(color));
            unv = mAndNot(unv, cur);
            if (!mEq(cur, seedBit) && (!wantNonTabu || color !== tabu)) {
                if (seen === pick) {
                    grp = cur;
                    moves.push(cell);
                    break;
                }
                seen++;
            }
        }

        occ = mAndNot(occ, grp);
        pl0 = mAndNot(pl0, grp);
        pl1 = mAndNot(pl1, grp);
        pl2 = mAndNot(pl2, grp);
        let emptied = false;
        for (let col = 0; col < 12; col++) {
            if (field12(grp, col * 12) !== 0) {
                emptied = collapseColumn(col) || emptied;
            }
        }
        if (emptied) compactColumns();
    }

    const board = new Uint8Array(144);
    for (let cell = 0; cell < 144; cell++) {
        if (mHas(occ, cell)) board[cell] = colorAt(cell);
    }
    return { moves, positions, remaining: mPop(occ), board };
}

// --- shift helpers: exhaustive single-bit geometry check ---------------------

for (let cell = 0; cell < 144; cell++) {
    const col = Math.floor(cell / 12);
    const row = cell % 12;
    const bit = mBit(cell);
    assert.deepEqual(mUp(bit), row < 11 ? mBit(cell + 1) : mZero(),
        `mUp is wrong at cell ${cell}`);
    assert.deepEqual(mDown(bit), row > 0 ? mBit(cell - 1) : mZero(),
        `mDown is wrong at cell ${cell}`);
    assert.deepEqual(mRight(bit), col < 11 ? mBit(cell + 12) : mZero(),
        `mRight is wrong at cell ${cell}`);
    assert.deepEqual(mLeft(bit), col > 0 ? mBit(cell - 12) : mZero(),
        `mLeft is wrong at cell ${cell}`);
}

for (let col = 0; col < 12; col++) {
    for (let value = 0; value < 0x1000; value += 0x123) {
        let planted = mZero();
        planted = setField12(planted, col * 12, value & 0xFFF);
        assert.equal(field12(planted, col * 12), value & 0xFFF,
            `field12 round-trip failed at column ${col}`);
        for (let other = 0; other < 12; other++) {
            if (other !== col) {
                assert.equal(field12(planted, other * 12), 0,
                    `setField12 leaked from column ${col} into ${other}`);
            }
        }
    }
}

// --- board fixtures (normalized, like every production child board) ---------

function normalized(board) {
    const copy = Uint8Array.from(board);
    for (let col = 0; col < 12; col++) {
        let write = 0;
        for (let j = 0; j < 12; j++) {
            const v = copy[col * 12 + j];
            copy[col * 12 + j] = 0;
            if (v !== 0) copy[col * 12 + write++] = v;
        }
    }
    let write = 0;
    const out = new Uint8Array(144);
    for (let col = 0; col < 12; col++) {
        if (copy[col * 12] !== 0) {
            out.set(copy.subarray(col * 12, col * 12 + 12), write * 12);
            write++;
        }
    }
    return out;
}

function lcg(seed) {
    let s = seed;
    return () => (s = (Math.imul(s, 1103515245) + 12345) & 0x7FFFFFFF);
}

const boards = [];
boards.push(new Uint8Array(144)); // terminal
const mono = new Uint8Array(144).fill(1);
boards.push(mono);
for (const colors of [2, 3, 5]) {
    for (let variant = 0; variant < 4; variant++) {
        const rnd = lcg(1000 * colors + variant);
        const board = new Uint8Array(144);
        for (let c = 0; c < 144; c++) board[c] = 1 + (rnd() % colors);
        boards.push(board);
    }
}
for (let variant = 0; variant < 6; variant++) {
    // normalized sparse boards: random non-empty column prefix, random heights
    const rnd = lcg(7000 + variant);
    const board = new Uint8Array(144);
    const columns = 1 + (rnd() % 12);
    for (let col = 0; col < columns; col++) {
        const height = 1 + (rnd() % 12);
        for (let j = 0; j < height; j++) {
            board[col * 12 + j] = 1 + (rnd() % (2 + (variant % 4)));
        }
    }
    boards.push(normalized(board));
}
const stripes = new Uint8Array(144);
for (let c = 0; c < 144; c++) stripes[c] = 1 + (Math.floor(c / 12) % 5);
boards.push(stripes);
const rows = new Uint8Array(144);
for (let c = 0; c < 144; c++) rows[c] = 1 + (c % 12) % 5;
boards.push(rows);
const checker = new Uint8Array(144);
for (let c = 0; c < 144; c++) {
    checker[c] = 1 + ((Math.floor(c / 12) + c) % 2); // no clickable groups
}
boards.push(checker);

// --- the sweep ---------------------------------------------------------------

let playouts = 0;
let totalPositions = 0;
for (let index = 0; index < boards.length; index++) {
    const board = boards[index];
    const tabus = new Set([dominantColor(board), 0, 3]);
    for (const tabu of tabus) {
        for (let s = 0; s < 16; s++) {
            const seed = 90001 + index * 1621 + s;
            const expected = oraclePlayout(board, seed, tabu);
            const actual = simPlayout(board, seed, tabu);
            const at = `board ${index} tabu ${tabu} seed ${seed}`;
            assert.deepEqual(actual.moves, expected.moves,
                `move sequences diverged (${at})`);
            assert.equal(actual.positions, expected.positions,
                `processed-position counts diverged (${at})`);
            assert.equal(actual.remaining, expected.remaining,
                `final remaining diverged (${at})`);
            assert.deepEqual(Array.from(actual.board), Array.from(expected.board),
                `final boards diverged (${at})`);
            playouts++;
            totalPositions += expected.positions;
        }
    }
}

assert.ok(totalPositions > 10000, "sweep is too small to be meaningful");
console.log(`gpu kernel twin: all checks passed (${playouts} playouts, ` +
    `${totalPositions} positions compared)`);
