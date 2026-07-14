/**
 * Click2026 — WebGPU playout accelerator.
 *
 * Runs massive batches of tabu-color random playouts on the GPU: one thread
 * per playout, one dispatch row per candidate move. The WGSL kernel is a
 * bit-identical twin of playoutRun() in asm/engine.ts — same xorshift128 RNG,
 * same enumeration order, same tabu policy, same collapse rules — so any GPU
 * minimum can be re-derived on the CPU from its seed. The worker replays every
 * adopted result through the WASM core (playoutVerify) before trusting it, and
 * disables the GPU path permanently on the first mismatch.
 *
 * Internally each thread holds its board as register-resident bitplanes (an
 * occupancy mask plus three color-bit planes of 144 bits each) instead of
 * per-cell private arrays, so flood fill, gravity and column compaction are
 * bit-parallel ALU work with no spilled local-memory traffic. Enumeration
 * scans groups twice per move (count, then locate the RNG pick), which keeps
 * the RNG stream and group order exactly equal to the CPU twin. See
 * tools/gpu.kernel.test.mjs for the word-level equivalence proof harness.
 *
 * The kernel returns, per candidate, the packed minimum
 * (finalRemaining << 24 | seedIndex) plus an exact processed-position count,
 * both reduced per workgroup before one global atomic per metric.
 * The full move line is reconstructed CPU-side by replaying the winning seed.
 *
 * Copyright 2014-2026, Hrvoje Abraham ahrvoje@gmail.com
 * Released under the MIT license.
 * https://opensource.org/licenses/MIT
 *
 * Date: Mon Jul 13, 2026
 */

const MAX_CHILDREN = 80;
const WORKGROUP = 64;

// dominant color of a 144-byte board (ties -> lower color id); the JS twin of
// dominantColor() in asm/engine.ts, used to feed the kernel's tabu buffer
export function dominantColor(board) {
    const counts = [0, 0, 0, 0, 0, 0];
    for (let c = 0; c < 144; c++) counts[board[c]]++;
    let best = 0, bestCount = 0;
    for (let c = 1; c <= 5; c++) {
        if (counts[c] > bestCount) {
            bestCount = counts[c];
            best = c;
        }
    }
    return best;
}

// Compact model tag for the telemetry row: "NVIDIA GeForce RTX 4080" and
// "ANGLE (Intel, Intel(R) UHD Graphics 770 (0x00004680) Direct3D11 ...)" turn
// into "RTX4080" and "UHD770". Brand and backend words identify nothing the
// row does not already say, so they are dropped; only the model remains.
export function compactGpuModel(rawName) {
    let name = String(rawName ?? "");
    const angle = name.match(/^ANGLE \([^,]*,\s*([^,]*?)(?:,[^)]*)?\)$/);
    if (angle) name = angle[1];
    name = name
        .replace(/\(0x[0-9A-Fa-f]+\)/g, " ")
        .replace(/\((?:R|TM|C)\)/gi, " ")
        .replace(/\b(?:Direct3D|D3D|Vulkan|Metal|OpenGL)\S*\b[\s\S]*$/i, " ")
        .replace(/\bvs_\d+\S*[\s\S]*$/i, " ")
        .replace(/\b(?:NVIDIA|GeForce|Intel|AMD|ATI|Radeon|Apple|Qualcomm|Microsoft|Samsung|Graphics|Corporation|Inc)\b\.?/gi, " ")
        .replace(/[^0-9A-Za-z ]+/g, " ")
        .trim();
    if (name === "") return "";
    const compact = name.split(/\s+/).join("");
    return compact.length > 12 ? compact.slice(0, 12) : compact;
}

// WebGPU adapter identity is usually redacted to vendor/architecture, but the
// WebGL renderer string still names the actual model. Worker-safe; returns ""
// wherever OffscreenCanvas WebGL or the debug extension is unavailable.
function probeWebglRenderer() {
    try {
        if (typeof OffscreenCanvas === "undefined") return "";
        const gl = new OffscreenCanvas(1, 1).getContext("webgl");
        if (!gl) return "";
        const info = gl.getExtension("WEBGL_debug_renderer_info");
        const renderer = String(gl.getParameter(
            info ? info.UNMASKED_RENDERER_WEBGL : gl.RENDERER) ?? "");
        gl.getExtension("WEBGL_lose_context")?.loseContext();
        return renderer;
    } catch {
        return "";
    }
}

// The kernel keeps the whole game in registers as bitplanes: one occupancy
// mask plus three color-bit planes (colors 1..5 in binary), each a 144-bit
// mask over column-major cells (bit index = cell = col * 12 + row) packed
// into vec4<u32> + u32. The previous kernel's ~1.8 KB of per-thread private
// arrays spilled to device memory and dominated its runtime; these masks are
// register-resident and flood fill becomes bit-parallel dilation.
function playoutMaskWords(predicate) {
    const words = [0, 0, 0, 0, 0];
    for (let bit = 0; bit < 144; bit++) {
        if (predicate(bit)) words[bit >> 5] |= 1 << (bit & 31);
    }
    return words.map((word) => `0x${(word >>> 0).toString(16).toUpperCase()}u`);
}

const NOT_ROW0 = playoutMaskWords((bit) => bit % 12 !== 0);
const NOT_ROW11 = playoutMaskWords((bit) => bit % 12 !== 11);

// Boards arrive packed four cells per u32 (36 words per child). Mask word w
// covers cells [32w, 32w+32) = buffer words [8w, 8w+8); word 4 holds only
// cells 128..143. Generated per mask word so every plane store is static.
const PLAYOUT_UNPACK = [0, 1, 2, 3, 4].map((w) => {
    const lanes = ["x", "y", "z", "w"];
    const store = (name, value) => (w < 4
        ? `${name}.lo.${lanes[w]} = ${value};` : `${name}.hi = ${value};`);
    return `{
            var o = 0u; var a0 = 0u; var a1 = 0u; var a2 = 0u;
            for (var j = 0u; j < ${w === 4 ? 4 : 8}u; j += 1u) {
                let word = BOARDS[boardsBase + ${w * 8}u + j];
                for (var k = 0u; k < 4u; k += 1u) {
                    let color = (word >> (k * 8u)) & 0xFFu;
                    if (color != 0u) {
                        let bit = 1u << (j * 4u + k);
                        o |= bit;
                        if ((color & 1u) != 0u) { a0 |= bit; }
                        if ((color & 2u) != 0u) { a1 |= bit; }
                        if ((color & 4u) != 0u) { a2 |= bit; }
                    }
                }
            }
            ${store("occ", "o")}
            ${store("pl0", "a0")}
            ${store("pl1", "a1")}
            ${store("pl2", "a2")}
        }`;
}).join(" ");

const SHADER = /* wgsl */ `
struct Params {
    children: u32,
    playouts: u32,
    seedBase: u32,
    seedOffset: u32,
}

@group(0) @binding(0) var<uniform> P: Params;
@group(0) @binding(1) var<storage, read> BOARDS: array<u32>;   // children * 36 words, 4 cells each
@group(0) @binding(2) var<storage, read> TABU: array<u32>;     // children
@group(0) @binding(3) var<storage, read_write> OUT: array<atomic<u32>>; // children, (final << 24) | seedIdx
@group(0) @binding(4) var<storage, read_write> POSITIONS: array<atomic<u32>>; // exact visited-board count

// One 144-bit board mask: bits 0..127 in lo, 128..143 in hi (low 16 bits).
struct M144 { lo: vec4<u32>, hi: u32 }

// bits whose row is 0 / 11 removed — column-boundary masks for row shifts
const NOT_ROW0_LO = vec4<u32>(${NOT_ROW0.slice(0, 4).join(", ")});
const NOT_ROW0_HI = ${NOT_ROW0[4]};
const NOT_ROW11_LO = vec4<u32>(${NOT_ROW11.slice(0, 4).join(", ")});
const NOT_ROW11_HI = ${NOT_ROW11[4]};

var<private> occ: M144;
var<private> pl0: M144;
var<private> pl1: M144;
var<private> pl2: M144;
var<private> rx: u32;
var<private> ry: u32;
var<private> rz: u32;
var<private> rw: u32;

var<workgroup> wgMin: atomic<u32>;
var<workgroup> wgPositions: atomic<u32>;

// xorshift128 — bit-identical twin of rngNext()/rngSeed() in asm/engine.ts
fn rngNext() -> u32 {
    let t = rx ^ (rx << 11u);
    rx = ry; ry = rz; rz = rw;
    rw = (rw ^ (rw >> 19u)) ^ (t ^ (t >> 8u));
    return rw;
}

fn rngSeed(seed: u32) {
    rx = seed ^ 0x9E3779B9u;
    ry = seed * 1664525u + 1013904223u;
    rz = seed ^ 0x85EBCA6Bu;
    rw = seed * 2246822519u + 374761393u;
    if (rw == 0u) { rw = 0x6C078965u; }
    for (var i = 0; i < 4; i++) { rngNext(); }
}

fn mAnd(a: M144, b: M144) -> M144 { return M144(a.lo & b.lo, a.hi & b.hi); }
fn mOr(a: M144, b: M144) -> M144 { return M144(a.lo | b.lo, a.hi | b.hi); }
fn mAndNot(a: M144, b: M144) -> M144 { return M144(a.lo & ~b.lo, a.hi & ~b.hi); }
fn mIsZero(a: M144) -> bool { return all(a.lo == vec4<u32>()) && a.hi == 0u; }
fn mEq(a: M144, b: M144) -> bool { return all(a.lo == b.lo) && a.hi == b.hi; }

fn mPop(a: M144) -> u32 {
    let c = countOneBits(a.lo);
    return c.x + c.y + c.z + c.w + countOneBits(a.hi);
}

// lowest set bit index; callers guarantee a non-zero mask
fn mFtb(a: M144) -> u32 {
    if (a.lo.x != 0u) { return firstTrailingBit(a.lo.x); }
    if (a.lo.y != 0u) { return 32u + firstTrailingBit(a.lo.y); }
    if (a.lo.z != 0u) { return 64u + firstTrailingBit(a.lo.z); }
    if (a.lo.w != 0u) { return 96u + firstTrailingBit(a.lo.w); }
    return 128u + firstTrailingBit(a.hi);
}

fn mBit(cell: u32) -> M144 {
    let w = cell >> 5u;
    let b = 1u << (cell & 31u);
    return M144(vec4<u32>(
        select(0u, b, w == 0u), select(0u, b, w == 1u),
        select(0u, b, w == 2u), select(0u, b, w == 3u)), select(0u, b, w == 4u));
}

fn wordAt(a: M144, w: u32) -> u32 {
    var v = select(a.lo.x, a.lo.y, w == 1u);
    v = select(v, a.lo.z, w == 2u);
    v = select(v, a.lo.w, w == 3u);
    v = select(v, a.hi, w == 4u);
    return select(v, 0u, w > 4u);
}

fn mHas(a: M144, cell: u32) -> bool {
    return ((wordAt(a, cell >> 5u) >> (cell & 31u)) & 1u) != 0u;
}

// row + 1 inside each column (cell + 1); nothing may enter row 0
fn mUp(a: M144) -> M144 {
    let carry = vec4<u32>(0u, a.lo.x, a.lo.y, a.lo.z) >> vec4<u32>(31u);
    return M144(((a.lo << vec4<u32>(1u)) | carry) & NOT_ROW0_LO,
        ((a.hi << 1u) | (a.lo.w >> 31u)) & NOT_ROW0_HI);
}

// row - 1 inside each column (cell - 1); nothing may enter row 11
fn mDown(a: M144) -> M144 {
    let carry = vec4<u32>(a.lo.y, a.lo.z, a.lo.w, a.hi) << vec4<u32>(31u);
    return M144(((a.lo >> vec4<u32>(1u)) | carry) & NOT_ROW11_LO,
        (a.hi >> 1u) & NOT_ROW11_HI);
}

// col + 1 (cell + 12); bits past cell 143 fall off the board
fn mRight(a: M144) -> M144 {
    let carry = vec4<u32>(0u, a.lo.x, a.lo.y, a.lo.z) >> vec4<u32>(20u);
    return M144((a.lo << vec4<u32>(12u)) | carry,
        ((a.hi << 12u) | (a.lo.w >> 20u)) & 0xFFFFu);
}

// col - 1 (cell - 12)
fn mLeft(a: M144) -> M144 {
    let carry = vec4<u32>(a.lo.y, a.lo.z, a.lo.w, a.hi) << vec4<u32>(20u);
    return M144((a.lo >> vec4<u32>(12u)) | carry, a.hi >> 12u);
}

fn neighborsOf(a: M144) -> M144 {
    return mOr(mOr(mUp(a), mDown(a)), mOr(mLeft(a), mRight(a)));
}

fn colorAt(cell: u32) -> u32 {
    return u32(mHas(pl0, cell)) | (u32(mHas(pl1, cell)) << 1u) |
        (u32(mHas(pl2, cell)) << 2u);
}

// occupied cells whose color equals \`color\` — branchless plane intersection
fn sameColorMask(color: u32) -> M144 {
    let lo = occ.lo
        & select(~pl0.lo, pl0.lo, (color & 1u) != 0u)
        & select(~pl1.lo, pl1.lo, (color & 2u) != 0u)
        & select(~pl2.lo, pl2.lo, (color & 4u) != 0u);
    let hi = occ.hi
        & select(~pl0.hi, pl0.hi, (color & 1u) != 0u)
        & select(~pl1.hi, pl1.hi, (color & 2u) != 0u)
        & select(~pl2.hi, pl2.hi, (color & 4u) != 0u);
    return M144(lo, hi);
}

// bit-parallel flood fill: dilate the seed inside its color plane to fixpoint
fn floodFrom(seed: M144, same: M144) -> M144 {
    var grp = seed;
    loop {
        let grown = mAnd(mOr(grp, neighborsOf(grp)), same);
        if (mEq(grown, grp)) { return grp; }
        grp = grown;
    }
}

// 12-bit column field at base = col * 12; a field spans at most two words
fn field12(a: M144, base: u32) -> u32 {
    let w = base >> 5u;
    let s = base & 31u;
    let straddles = s > 20u;
    let high = select(0u, wordAt(a, w + 1u) << (32u - s), straddles);
    return ((wordAt(a, w) >> s) | high) & 0xFFFu;
}

fn withWordCleared(a: M144, w: u32, bits: u32) -> M144 {
    return M144(vec4<u32>(
        a.lo.x & ~select(0u, bits, w == 0u),
        a.lo.y & ~select(0u, bits, w == 1u),
        a.lo.z & ~select(0u, bits, w == 2u),
        a.lo.w & ~select(0u, bits, w == 3u)),
        a.hi & ~select(0u, bits, w == 4u));
}

fn withWordOr(a: M144, w: u32, bits: u32) -> M144 {
    return M144(vec4<u32>(
        a.lo.x | select(0u, bits, w == 0u),
        a.lo.y | select(0u, bits, w == 1u),
        a.lo.z | select(0u, bits, w == 2u),
        a.lo.w | select(0u, bits, w == 3u)),
        a.hi | select(0u, bits, w == 4u));
}

fn setField12(a: M144, base: u32, value: u32) -> M144 {
    let w = base >> 5u;
    let s = base & 31u;
    var r = withWordCleared(a, w, 0xFFFu << s);
    r = withWordOr(r, w, value << s);
    let straddles = s > 20u;
    r = withWordCleared(r, w + 1u, select(0u, 0xFFFu >> (32u - s), straddles));
    r = withWordOr(r, w + 1u, select(0u, value >> (32u - s), straddles));
    return r;
}

// gravity inside one just-cleared column; true when the column emptied —
// the twin of the touched-column loop of collapse() in asm/engine.ts
fn collapseColumn(col: u32) -> bool {
    let base = col * 12u;
    let colOcc = field12(occ, base);
    let fallen = (1u << countOneBits(colOcc)) - 1u;
    if (colOcc == fallen) { return colOcc == 0u; }
    let c0 = field12(pl0, base);
    let c1 = field12(pl1, base);
    let c2 = field12(pl2, base);
    var n0 = 0u;
    var n1 = 0u;
    var n2 = 0u;
    var rem = colOcc;
    var k = 0u;
    while (rem != 0u) {
        let j = firstTrailingBit(rem);
        rem &= rem - 1u;
        let bit = 1u << k;
        n0 |= select(0u, bit, ((c0 >> j) & 1u) != 0u);
        n1 |= select(0u, bit, ((c1 >> j) & 1u) != 0u);
        n2 |= select(0u, bit, ((c2 >> j) & 1u) != 0u);
        k += 1u;
    }
    occ = setField12(occ, base, fallen);
    pl0 = setField12(pl0, base, n0);
    pl1 = setField12(pl1, base, n1);
    pl2 = setField12(pl2, base, n2);
    return false;
}

// stable left compaction of non-empty columns; runs only when a move just
// emptied a column, exactly like collapse() in asm/engine.ts
fn compactColumns() {
    var srcCols = 0u;
    for (var col = 0u; col < 12u; col += 1u) {
        srcCols |= select(0u, 1u << col, mHas(occ, col * 12u));
    }
    // occupied columns already form a prefix — nothing to move
    if (srcCols == (1u << countOneBits(srcCols)) - 1u) { return; }
    var rebuiltOcc = M144(vec4<u32>(), 0u);
    var rebuilt0 = M144(vec4<u32>(), 0u);
    var rebuilt1 = M144(vec4<u32>(), 0u);
    var rebuilt2 = M144(vec4<u32>(), 0u);
    var rem = srcCols;
    var dst = 0u;
    while (rem != 0u) {
        let src = firstTrailingBit(rem);
        rem &= rem - 1u;
        let srcBase = src * 12u;
        let dstBase = dst * 12u;
        rebuiltOcc = setField12(rebuiltOcc, dstBase, field12(occ, srcBase));
        rebuilt0 = setField12(rebuilt0, dstBase, field12(pl0, srcBase));
        rebuilt1 = setField12(rebuilt1, dstBase, field12(pl1, srcBase));
        rebuilt2 = setField12(rebuilt2, dstBase, field12(pl2, srcBase));
        dst += 1u;
    }
    occ = rebuiltOcc;
    pl0 = rebuilt0;
    pl1 = rebuilt1;
    pl2 = rebuilt2;
}

@compute @workgroup_size(${WORKGROUP})
fn main(@builtin(workgroup_id) wg: vec3<u32>, @builtin(local_invocation_index) li: u32) {
    if (li == 0u) {
        atomicStore(&wgMin, 0xFFFFFFFFu);
        atomicStore(&wgPositions, 0u);
    }
    workgroupBarrier();

    let child = wg.y;
    let t = wg.x * ${WORKGROUP}u + li;
    var result = 0xFFFFFFFFu;
    // Match the CPU counter exactly: one processed position is a non-terminal
    // board whose legal groups were enumerated and from which a move is made.
    // The terminal board is inspected for termination but is not expanded.
    var positions = 0u;

    if (t < P.playouts && child < P.children) {
        let boardsBase = child * 36u;
        ${PLAYOUT_UNPACK}

        rngSeed(P.seedBase + t);
        let tabu = TABU[child];

        // playout loop — the twin of playoutRun() in asm/engine.ts; groups
        // are enumerated twice per move (count, then locate the pick), which
        // consumes exactly one rngNext() per move like the CPU and is far
        // cheaper than spilling per-group representative arrays
        for (var mv = 0u; mv < 80u; mv += 1u) {
            // count clickable groups (n) and non-tabu clickable groups
            // (cand) in ascending representative-cell order
            var n = 0u;
            var cand = 0u;
            var unv = occ;
            while (!mIsZero(unv)) {
                let cell = mFtb(unv);
                let color = colorAt(cell);
                let seed = mBit(cell);
                let grp = floodFrom(seed, sameColorMask(color));
                unv = mAndNot(unv, grp);
                if (!mEq(grp, seed)) {
                    n += 1u;
                    if (color != tabu) { cand += 1u; }
                }
            }
            if (n == 0u) { break; }
            positions += 1u;

            // Prefer non-tabu groups; the worker supplements this
            // exploitation batch with full-support CPU samples.
            var wantNonTabu = false;
            var pick = 0u;
            if (cand > 0u) {
                pick = rngNext() % cand;
                wantNonTabu = true;
            } else {
                pick = rngNext() % n;
            }

            // second pass: same order, stop at the picked group
            var grp = M144(vec4<u32>(), 0u);
            var seen = 0u;
            unv = occ;
            while (!mIsZero(unv)) {
                let cell = mFtb(unv);
                let color = colorAt(cell);
                let seed = mBit(cell);
                let cur = floodFrom(seed, sameColorMask(color));
                unv = mAndNot(unv, cur);
                if (!mEq(cur, seed) && (!wantNonTabu || color != tabu)) {
                    if (seen == pick) { grp = cur; break; }
                    seen += 1u;
                }
            }

            // remove the group, then collapse — the twin of
            // applyEnumeratedMove() + collapse() in asm/engine.ts
            occ = mAndNot(occ, grp);
            pl0 = mAndNot(pl0, grp);
            pl1 = mAndNot(pl1, grp);
            pl2 = mAndNot(pl2, grp);
            var emptied = false;
            for (var col = 0u; col < 12u; col += 1u) {
                if (field12(grp, col * 12u) != 0u) {
                    emptied = collapseColumn(col) || emptied;
                }
            }
            if (emptied) { compactColumns(); }
        }

        result = (mPop(occ) << 24u) | (P.seedOffset + t);
    }

    // One workgroup-reduced contribution per metric instead of one global
    // atomic per playout: every thread of a workgroup shares one candidate
    // row (child = workgroup y), so this is exact and far less contended.
    atomicMin(&wgMin, result);
    atomicAdd(&wgPositions, positions);
    workgroupBarrier();
    if (li == 0u && child < P.children) {
        atomicMin(&OUT[child], atomicLoad(&wgMin));
        atomicAdd(&POSITIONS[child], atomicLoad(&wgPositions));
    }
}
`;

const MAX_PACKED_PLAYOUTS = 0x1000000; // seedIdx occupies the low 24 bits
const EVAL_WORDS = 6;

const PROFILE_DEFAULTS = Object.freeze({
    mobile: Object.freeze({ initial: 512, min: 128, max: 4096, targetMs: 40, inFlight: 1, evalThreshold: 256 }),
    integrated: Object.freeze({ initial: 1024, min: 256, max: 16384, targetMs: 55, inFlight: 2, evalThreshold: 192 }),
    balanced: Object.freeze({ initial: 1024, min: 256, max: 16384, targetMs: 60, inFlight: 2, evalThreshold: 160 }),
    discrete: Object.freeze({ initial: 2048, min: 512, max: 65536, targetMs: 75, inFlight: 3, evalThreshold: 96 }),
});

function clamp(value, lo, hi) {
    return Math.max(lo, Math.min(hi, value));
}

// Kept pure and exported so the capability policy can be tested without a GPU.
export function gpuProfileFor(adapterInfo = {}, mobile = false) {
    if (mobile) return "mobile";
    const text = (`${adapterInfo.vendor ?? ""} ${adapterInfo.architecture ?? ""} ` +
        `${adapterInfo.device ?? ""} ${adapterInfo.description ?? ""}`).toLowerCase();
    // AMD exposes many APUs simply as "AMD Radeon(TM) Graphics". Treating
    // every occurrence of Radeon as a discrete card overcommits those common
    // notebook GPUs. Explicit RX/Pro/Instinct and legacy discrete model names
    // still select the high-throughput profile.
    const amdDiscrete = /\bradeon[^\n]*(?:\brx\s*\d|\bpro\s+(?:w|wx|\d)|\binstinct\b|\br[579]\s*\d|\bhd\s*\d{4}|\bvii\b|\b\d{4}\s*(?:xtx?|gre)\b)/.test(text) ||
        /\brx\s*\d/.test(text);
    const amdIntegrated = /\bradeon(?:\(tm\))?\s+graphics\b|\bradeon\s+\d{3,4}m\s+graphics\b|\bradeon\s+vega\s+\d+\s+graphics\b|\bamd\s+apu\b/.test(text);
    if (/nvidia|geforce|rtx|gtx|intel.*arc|\barc\s*[ab]\d/.test(text) || amdDiscrete) return "discrete";
    if (amdIntegrated) return "integrated";
    if (/intel|apple|qualcomm|adreno|mali|powervr|integrated|iris|uhd/.test(text)) return "integrated";
    return "balanced";
}

// observedPlayoutsPerMs is aggregate throughput across every candidate row.
// The result is always a workgroup multiple, bounded both for responsiveness
// and by the 24-bit result encoding used by the deterministic verifier.
export function calculateRecommendedGpuPlayouts(profile, children, observedPlayoutsPerMs = 0,
    targetMs = undefined, deviceMaximum = MAX_PACKED_PLAYOUTS) {
    const defaults = PROFILE_DEFAULTS[profile] ?? PROFILE_DEFAULTS.balanced;
    const rows = Math.max(1, Number.isFinite(children) ? Math.floor(children) : 1);
    const target = clamp(Number.isFinite(targetMs) ? targetMs : defaults.targetMs, 8, 250);
    let wanted;
    if (observedPlayoutsPerMs > 0 && Number.isFinite(observedPlayoutsPerMs)) {
        wanted = observedPlayoutsPerMs * target / rows;
    } else {
        // Small row counts need more samples per row to fill a wide GPU.
        const fill = clamp(Math.sqrt(32 / rows), 1, 4);
        wanted = defaults.initial * fill;
    }
    const maximum = Math.max(WORKGROUP, Math.min(defaults.max, Math.floor(deviceMaximum)));
    const rounded = Math.round(wanted / WORKGROUP) * WORKGROUP;
    return clamp(rounded, Math.min(defaults.min, maximum), maximum);
}

// Exact CPU twin of the optional GPU board-feature kernel. These features are
// suitable for heuristic ranking only; none is accepted as a proof bound.
export function evaluateBoardFeatures(board) {
    if (!board || board.length < 144) throw new RangeError("board must contain 144 cells");
    const counts = new Uint16Array(6);
    let remaining = 0;
    let colorMask = 0;
    let adjacentPairs = 0;
    let columnMask = 0;
    for (let c = 0; c < 144; c++) {
        const value = board[c];
        if (value === 0) continue;
        remaining++;
        if (value <= 5) {
            counts[value]++;
            colorMask |= 1 << value;
        }
        const col = Math.floor(c / 12);
        const row = c % 12;
        columnMask |= 1 << col;
        if (col > 0 && board[c - 12] === value) adjacentPairs++;
        if (row > 0 && board[c - 1] === value) adjacentPairs++;
    }
    let dominant = 0;
    let dominantCount = 0;
    for (let color = 1; color <= 5; color++) {
        if (counts[color] > dominantCount) {
            dominant = color;
            dominantCount = counts[color];
        }
    }
    let colorCount = 0;
    for (let color = 1; color <= 5; color++) colorCount += (colorMask >> color) & 1;
    let occupiedColumns = 0;
    for (let col = 0; col < 12; col++) occupiedColumns += (columnMask >> col) & 1;
    return { remaining, colorMask, colorCount, dominant, dominantCount, adjacentPairs, occupiedColumns };
}

const EVAL_SHADER = /* wgsl */ `
struct EvalParams {
    boards: u32,
    pad0: u32,
    pad1: u32,
    pad2: u32,
}

@group(0) @binding(0) var<uniform> EP: EvalParams;
@group(0) @binding(1) var<storage, read> EVAL_BOARDS: array<u32>;
@group(0) @binding(2) var<storage, read_write> FEATURES: array<u32>;

fn evalCell(boardIndex: u32, cell: u32) -> u32 {
    let word = EVAL_BOARDS[boardIndex * 36u + cell / 4u];
    return (word >> ((cell % 4u) * 8u)) & 0xFFu;
}

@compute @workgroup_size(${WORKGROUP})
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
    let boardIndex = gid.x;
    if (boardIndex >= EP.boards) { return; }

    var counts: array<u32, 6>;
    var remaining = 0u;
    var colorMask = 0u;
    var adjacentPairs = 0u;
    var columnMask = 0u;
    for (var cell = 0u; cell < 144u; cell += 1u) {
        let value = evalCell(boardIndex, cell);
        if (value == 0u) { continue; }
        remaining += 1u;
        if (value <= 5u) {
            counts[value] += 1u;
            colorMask |= 1u << value;
        }
        let col = cell / 12u;
        let row = cell % 12u;
        columnMask |= 1u << col;
        if (col > 0u && evalCell(boardIndex, cell - 12u) == value) { adjacentPairs += 1u; }
        if (row > 0u && evalCell(boardIndex, cell - 1u) == value) { adjacentPairs += 1u; }
    }

    var dominant = 0u;
    var dominantCount = 0u;
    for (var color = 1u; color <= 5u; color += 1u) {
        if (counts[color] > dominantCount) {
            dominant = color;
            dominantCount = counts[color];
        }
    }
    let base = boardIndex * ${EVAL_WORDS}u;
    FEATURES[base] = remaining;
    FEATURES[base + 1u] = colorMask;
    FEATURES[base + 2u] = dominant;
    FEATURES[base + 3u] = dominantCount;
    FEATURES[base + 4u] = adjacentPairs;
    FEATURES[base + 5u] = countOneBits(columnMask);
}
`;

// Creates the accelerator, or null when WebGPU is unavailable on this device.
// Concurrent runBatch calls are intentionally supported: independent resource
// slots keep uploads/readbacks legal while queueing enough work to hide map and
// JavaScript scheduling latency.
export async function createGpu(options = {}) {
    if (typeof navigator === "undefined" || !("gpu" in navigator)) return null;

    let adapter;
    let device;
    try {
        try {
            adapter = await navigator.gpu.requestAdapter({
                powerPreference: options.powerPreference ?? "high-performance",
            });
        } catch {
            // Older implementations may reject an unknown options member.
        }
        if (!adapter) adapter = await navigator.gpu.requestAdapter();
        if (!adapter) return null;

        const timestampWanted = options.timestampQueries !== false &&
            adapter.features?.has?.("timestamp-query");
        try {
            device = await adapter.requestDevice(timestampWanted ?
                { requiredFeatures: ["timestamp-query"] } : undefined);
        } catch {
            // Timestamp queries are diagnostics, never a reason to lose GPU
            // acceleration on a browser with an incomplete implementation.
            if (!timestampWanted) throw new Error("WebGPU device request failed");
            device = await adapter.requestDevice();
        }
    } catch {
        return null;
    }

    let adapterInfo = {};
    try {
        const raw = adapter.info ?? (adapter.requestAdapterInfo ? await adapter.requestAdapterInfo() : {});
        adapterInfo = {
            vendor: raw?.vendor ?? "",
            architecture: raw?.architecture ?? "",
            device: raw?.device ?? "",
            description: raw?.description ?? "",
        };
    } catch {
        // Adapter identity is optional and often intentionally redacted.
    }
    // Model tag for the telemetry row. Chrome blanks device/description, so
    // fall back to the WebGL renderer string — but only when it names the
    // same vendor: on dual-GPU machines WebGL may run on the other adapter,
    // and a confidently wrong model is worse than the architecture tag.
    let adapterModel = compactGpuModel(adapterInfo.device) ||
        compactGpuModel(adapterInfo.description);
    if (adapterModel === "") {
        const renderer = probeWebglRenderer();
        const vendor = (adapterInfo.vendor ?? "").toLowerCase();
        if (renderer !== "" && (vendor === "" || renderer.toLowerCase().includes(vendor))) {
            adapterModel = compactGpuModel(renderer);
        }
    }
    adapterInfo.model = adapterModel || adapterInfo.architecture || "";

    const ua = navigator.userAgent ?? "";
    const mobile = navigator.userAgentData?.mobile === true || /iPhone|iPad|iPod|Android|Mobile/i.test(ua) ||
        (/Macintosh/i.test(ua) && (navigator.maxTouchPoints ?? 0) > 1);
    const profile = options.profile ?? gpuProfileFor(adapterInfo, mobile);
    const defaults = PROFILE_DEFAULTS[profile] ?? PROFILE_DEFAULTS.balanced;
    const limits = adapter.limits ?? {};
    const maxWorkgroups = Math.max(1, Number(limits.maxComputeWorkgroupsPerDimension ?? 65535));
    const maxChildren = Math.max(1, Math.min(MAX_CHILDREN, maxWorkgroups));
    const maxPlayoutsPerDispatch = Math.max(WORKGROUP,
        Math.min(MAX_PACKED_PLAYOUTS, maxWorkgroups * WORKGROUP));
    const storageLimit = Number(limits.maxStorageBufferBindingSize ?? (128 * 1024 * 1024));
    const bufferLimit = Number(limits.maxBufferSize ?? storageLimit);
    const maxEvalBoards = Math.max(1, Math.min(4096, maxWorkgroups * WORKGROUP,
        Math.floor(Math.min(storageLimit, bufferLimit) / (36 * 4))));
    const requestedInFlight = Number(options.maxInFlight ?? defaults.inFlight);
    const maxInFlight = clamp(Math.floor(Number.isFinite(requestedInFlight) ?
        requestedInFlight : defaults.inFlight), 1, 4);
    const timestampEnabled = device.features?.has?.("timestamp-query") === true;
    const requestedTargetMs = Number(options.targetBatchMs ?? defaults.targetMs);
    const targetBatchMs = clamp(Number.isFinite(requestedTargetMs) ?
        requestedTargetMs : defaults.targetMs, 8, 250);

    const shaderModule = device.createShaderModule({ code: SHADER });
    const pipeline = await device.createComputePipelineAsync({
        layout: "auto",
        compute: { module: shaderModule, entryPoint: "main" },
    });

    let destroyed = false;
    let terminalError = null;
    let evalState = "available";
    let evalPipelinePromise = null;
    let throughputEwma = 0;
    const createdAt = performance.now();
    const stats = {
        calls: 0,
        dispatchesSubmitted: 0,
        dispatchesCompleted: 0,
        dispatchesFailed: 0,
        candidatesSubmitted: 0,
        playoutsSubmitted: 0,
        playoutsCompleted: 0,
        positionsProcessed: 0,
        bytesUploaded: 0,
        bytesRead: 0,
        queueWaitMs: 0,
        dispatchWallMs: 0,
        gpuTimeMs: 0,
        gpuTimedDispatches: 0,
        inFlight: 0,
        queued: 0,
        peakInFlight: 0,
        peakQueued: 0,
        evaluationCalls: 0,
        evaluationDispatches: 0,
        evaluationBoardsGpu: 0,
        evaluationBoardsCpu: 0,
        evaluationWallMs: 0,
        evaluationCpuWallMs: 0,
        evaluationGpuTimeMs: 0,
        evaluationFallbacks: 0,
        evaluationVerificationFailures: 0,
        lastBatch: null,
    };

    // mapAsync intervals from striped submissions overlap. Summing each
    // dispatch's wall time would count the overlap two or three times on
    // devices without timestamp queries, so keep the union of intervals in
    // which at least one dispatch of each kind is outstanding.
    const playoutWallActivity = { active: 0, startedAt: 0, totalMs: 0 };
    const evaluationWallActivity = { active: 0, startedAt: 0, totalMs: 0 };

    function beginWallActivity(activity, now = performance.now()) {
        if (activity.active++ === 0) activity.startedAt = now;
    }

    function endWallActivity(activity, now = performance.now()) {
        if (activity.active <= 0) return;
        if (--activity.active === 0) {
            activity.totalMs += Math.max(0, now - activity.startedAt);
            activity.startedAt = 0;
        }
    }

    function wallActivityMs(activity, now = performance.now()) {
        return activity.totalMs + (activity.active > 0
            ? Math.max(0, now - activity.startedAt) : 0);
    }

    function createSlot(index) {
        const paramsBuf = device.createBuffer({
            label: `playout params ${index}`,
            size: 16,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });
        const boardsBuf = device.createBuffer({
            label: `playout boards ${index}`,
            size: maxChildren * 36 * 4,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
        });
        const tabuBuf = device.createBuffer({
            label: `playout tabu ${index}`,
            size: maxChildren * 4,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
        });
        const outBuf = device.createBuffer({
            label: `playout result ${index}`,
            size: maxChildren * 4,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
        });
        const positionsBuf = device.createBuffer({
            label: `playout positions ${index}`,
            size: maxChildren * 4,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
        });
        const readBuf = device.createBuffer({
            label: `playout readback ${index}`,
            size: maxChildren * 8 + (timestampEnabled ? 16 : 0),
            usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
        });
        const slot = {
            index, paramsBuf, boardsBuf, tabuBuf, outBuf, positionsBuf, readBuf,
            eval: null,
            querySet: null,
            queryResolveBuf: null,
        };
        if (timestampEnabled) {
            slot.querySet = device.createQuerySet({ type: "timestamp", count: 2 });
            slot.queryResolveBuf = device.createBuffer({
                label: `timestamp resolve ${index}`,
                size: 16,
                usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC,
            });
        }
        slot.bindGroup = device.createBindGroup({
            layout: pipeline.getBindGroupLayout(0),
            entries: [
                { binding: 0, resource: { buffer: paramsBuf } },
                { binding: 1, resource: { buffer: boardsBuf } },
                { binding: 2, resource: { buffer: tabuBuf } },
                { binding: 3, resource: { buffer: outBuf } },
                { binding: 4, resource: { buffer: positionsBuf } },
            ],
        });
        return slot;
    }

    const slots = Array.from({ length: maxInFlight }, (_, i) => createSlot(i));
    const freeSlots = slots.slice();
    const slotWaiters = [];

    function rejectWaiters(error) {
        while (slotWaiters.length > 0) slotWaiters.shift().reject(error);
    }

    function acquireSlot() {
        if (terminalError) return Promise.reject(terminalError);
        if (freeSlots.length > 0) return Promise.resolve(freeSlots.pop());
        return new Promise((resolve, reject) => slotWaiters.push({ resolve, reject }));
    }

    function releaseSlot(slot) {
        if (terminalError) return;
        const waiter = slotWaiters.shift();
        if (waiter) waiter.resolve(slot);
        else freeSlots.push(slot);
    }

    device.lost.then((info) => {
        if (destroyed) return;
        terminalError = new Error(`WebGPU device lost${info?.message ? `: ${info.message}` : ""}`);
        rejectWaiters(terminalError);
    });

    function validateBoards(boards) {
        if (!boards || !Number.isInteger(boards.length)) throw new TypeError("boards must be an array-like value");
        for (let i = 0; i < boards.length; i++) {
            if (!boards[i] || boards[i].length < 144) throw new RangeError(`board ${i} must contain 144 cells`);
        }
    }

    function packBoards(boards) {
        const packed = new Uint32Array(boards.length * 36);
        for (let k = 0; k < boards.length; k++) {
            for (let c = 0; c < 144; c++) {
                packed[k * 36 + (c >> 2)] |= boards[k][c] << ((c & 3) * 8);
            }
        }
        return packed;
    }

    function beginTimedPass(encoder, slot) {
        return timestampEnabled ? encoder.beginComputePass({
            timestampWrites: {
                querySet: slot.querySet,
                beginningOfPassWriteIndex: 0,
                endOfPassWriteIndex: 1,
            },
        }) : encoder.beginComputePass();
    }

    function appendTimestampReadback(encoder, slot, destination, offset) {
        if (!timestampEnabled) return;
        encoder.resolveQuerySet(slot.querySet, 0, 2, slot.queryResolveBuf, 0);
        encoder.copyBufferToBuffer(slot.queryResolveBuf, 0, destination, offset, 16);
    }

    function readGpuMilliseconds(mapped, offset) {
        if (!timestampEnabled) return null;
        const view = new DataView(mapped);
        const begin = view.getBigUint64(offset, true);
        const end = view.getBigUint64(offset + 8, true);
        if (end < begin) return null;
        return Number(end - begin) / 1e6;
    }

    async function runPlayoutDispatch(boards, tabu, playouts, seedBase, seedOffset) {
        const queuedAt = performance.now();
        const packed = packBoards(boards);
        const tabuData = Uint32Array.from(tabu);
        stats.queued++;
        stats.peakQueued = Math.max(stats.peakQueued, stats.queued);
        let slot;
        try {
            slot = await acquireSlot();
        } finally {
            stats.queued--;
        }
        const acquiredAt = performance.now();
        stats.queueWaitMs += acquiredAt - queuedAt;
        stats.inFlight++;
        stats.peakInFlight = Math.max(stats.peakInFlight, stats.inFlight);
        let mapped = false;
        let wallActive = false;
        try {
            if (terminalError) throw terminalError;
            const children = boards.length;
            const childBytes = children * 4;
            const timestampOffset = childBytes * 2;
            const readBytes = timestampOffset + (timestampEnabled ? 16 : 0);
            device.queue.writeBuffer(slot.paramsBuf, 0,
                new Uint32Array([children, playouts, seedBase >>> 0, seedOffset]));
            device.queue.writeBuffer(slot.boardsBuf, 0, packed);
            device.queue.writeBuffer(slot.tabuBuf, 0, tabuData);
            device.queue.writeBuffer(slot.outBuf, 0, new Uint32Array(children).fill(0xFFFFFFFF));
            device.queue.writeBuffer(slot.positionsBuf, 0, new Uint32Array(children));

            const encoder = device.createCommandEncoder();
            const pass = beginTimedPass(encoder, slot);
            pass.setPipeline(pipeline);
            pass.setBindGroup(0, slot.bindGroup);
            pass.dispatchWorkgroups(Math.ceil(playouts / WORKGROUP), children);
            pass.end();
            encoder.copyBufferToBuffer(slot.outBuf, 0, slot.readBuf, 0, childBytes);
            encoder.copyBufferToBuffer(slot.positionsBuf, 0, slot.readBuf, childBytes, childBytes);
            appendTimestampReadback(encoder, slot, slot.readBuf, timestampOffset);

            const submittedAt = performance.now();
            device.queue.submit([encoder.finish()]);
            beginWallActivity(playoutWallActivity, submittedAt);
            wallActive = true;
            stats.dispatchesSubmitted++;
            stats.candidatesSubmitted += children;
            stats.playoutsSubmitted += children * playouts;
            stats.bytesUploaded += packed.byteLength + tabuData.byteLength + 16 + childBytes * 2;

            await slot.readBuf.mapAsync(GPUMapMode.READ, 0, readBytes);
            mapped = true;
            const completedAt = performance.now();
            const range = slot.readBuf.getMappedRange(0, readBytes);
            const minima = new Uint32Array(range, 0, children).slice();
            const positions = new Uint32Array(range, childBytes, children).slice();
            const gpuMs = readGpuMilliseconds(range, timestampOffset);
            slot.readBuf.unmap();
            mapped = false;

            let totalPositions = 0;
            for (const value of positions) totalPositions += value;
            const totalPlayouts = children * playouts;
            const wallMs = completedAt - submittedAt;
            const activeMs = gpuMs !== null && gpuMs > 0 ? gpuMs : wallMs;
            if (timestampEnabled && totalPlayouts >= 512 && children >= 2 && activeMs > 0) {
                const observed = totalPlayouts / activeMs;
                throughputEwma = throughputEwma === 0 ? observed : throughputEwma * 0.7 + observed * 0.3;
            }
            stats.dispatchesCompleted++;
            stats.playoutsCompleted += totalPlayouts;
            stats.positionsProcessed += totalPositions;
            stats.bytesRead += readBytes;
            if (gpuMs !== null) {
                stats.gpuTimeMs += gpuMs;
                stats.gpuTimedDispatches++;
            }
            stats.lastBatch = {
                children,
                playoutsPerChild: playouts,
                playouts: totalPlayouts,
                positions: totalPositions,
                queueWaitMs: acquiredAt - queuedAt,
                wallMs,
                gpuMs,
                positionsPerSecond: activeMs > 0 ? Math.round(totalPositions * 1000 / activeMs) : 0,
            };
            return Array.from(minima, (value, i) => ({
                final: value >>> 24,
                seedIdx: value & 0xFFFFFF,
                positions: positions[i],
            }));
        } catch (error) {
            stats.dispatchesFailed++;
            if (mapped) {
                try { slot.readBuf.unmap(); } catch { /* already invalid after device loss */ }
            }
            throw error;
        } finally {
            if (wallActive) endWallActivity(playoutWallActivity);
            stats.inFlight--;
            releaseSlot(slot);
        }
    }

    async function ensureEvalPipeline() {
        if (evalState === "failed") return null;
        if (!evalPipelinePromise) {
            evalPipelinePromise = (async () => {
                const module = device.createShaderModule({ code: EVAL_SHADER });
                return device.createComputePipelineAsync({
                    layout: "auto",
                    compute: { module, entryPoint: "main" },
                });
            })().catch(() => {
                evalState = "failed";
                return null;
            });
        }
        return evalPipelinePromise;
    }

    function ensureEvalSlot(slot, evalPipeline) {
        if (slot.eval) return slot.eval;
        const paramsBuf = device.createBuffer({
            label: `evaluation params ${slot.index}`,
            size: 16,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });
        const boardsBuf = device.createBuffer({
            label: `evaluation boards ${slot.index}`,
            size: maxEvalBoards * 36 * 4,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
        });
        const featuresBuf = device.createBuffer({
            label: `evaluation features ${slot.index}`,
            size: maxEvalBoards * EVAL_WORDS * 4,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
        });
        const readBuf = device.createBuffer({
            label: `evaluation readback ${slot.index}`,
            size: maxEvalBoards * EVAL_WORDS * 4 + (timestampEnabled ? 16 : 0),
            usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
        });
        const bindGroup = device.createBindGroup({
            layout: evalPipeline.getBindGroupLayout(0),
            entries: [
                { binding: 0, resource: { buffer: paramsBuf } },
                { binding: 1, resource: { buffer: boardsBuf } },
                { binding: 2, resource: { buffer: featuresBuf } },
            ],
        });
        slot.eval = { paramsBuf, boardsBuf, featuresBuf, readBuf, bindGroup };
        return slot.eval;
    }

    async function runEvaluationDispatch(boards, evalPipeline) {
        const queuedAt = performance.now();
        const packed = packBoards(boards);
        stats.queued++;
        stats.peakQueued = Math.max(stats.peakQueued, stats.queued);
        let slot;
        try {
            slot = await acquireSlot();
        } finally {
            stats.queued--;
        }
        const acquiredAt = performance.now();
        stats.queueWaitMs += acquiredAt - queuedAt;
        stats.inFlight++;
        stats.peakInFlight = Math.max(stats.peakInFlight, stats.inFlight);
        let mapped = false;
        let wallActive = false;
        try {
            if (terminalError) throw terminalError;
            const resources = ensureEvalSlot(slot, evalPipeline);
            const featureBytes = boards.length * EVAL_WORDS * 4;
            const readBytes = featureBytes + (timestampEnabled ? 16 : 0);
            device.queue.writeBuffer(resources.paramsBuf, 0, new Uint32Array([boards.length, 0, 0, 0]));
            device.queue.writeBuffer(resources.boardsBuf, 0, packed);

            const encoder = device.createCommandEncoder();
            const pass = beginTimedPass(encoder, slot);
            pass.setPipeline(evalPipeline);
            pass.setBindGroup(0, resources.bindGroup);
            pass.dispatchWorkgroups(Math.ceil(boards.length / WORKGROUP));
            pass.end();
            encoder.copyBufferToBuffer(resources.featuresBuf, 0, resources.readBuf, 0, featureBytes);
            appendTimestampReadback(encoder, slot, resources.readBuf, featureBytes);
            const submittedAt = performance.now();
            device.queue.submit([encoder.finish()]);
            beginWallActivity(evaluationWallActivity, submittedAt);
            wallActive = true;

            await resources.readBuf.mapAsync(GPUMapMode.READ, 0, readBytes);
            mapped = true;
            const completedAt = performance.now();
            const range = resources.readBuf.getMappedRange(0, readBytes);
            const words = new Uint32Array(range, 0, boards.length * EVAL_WORDS).slice();
            const gpuMs = readGpuMilliseconds(range, featureBytes);
            resources.readBuf.unmap();
            mapped = false;
            const wallMs = completedAt - submittedAt;
            stats.evaluationDispatches++;
            stats.evaluationBoardsGpu += boards.length;
            stats.bytesUploaded += packed.byteLength + 16;
            stats.bytesRead += readBytes;
            if (gpuMs !== null) stats.evaluationGpuTimeMs += gpuMs;
            const results = [];
            for (let i = 0; i < boards.length; i++) {
                const base = i * EVAL_WORDS;
                const colorMask = words[base + 1];
                let colorCount = 0;
                for (let color = 1; color <= 5; color++) colorCount += (colorMask >> color) & 1;
                results.push({
                    remaining: words[base],
                    colorMask,
                    colorCount,
                    dominant: words[base + 2],
                    dominantCount: words[base + 3],
                    adjacentPairs: words[base + 4],
                    occupiedColumns: words[base + 5],
                });
            }
            return results;
        } finally {
            if (wallActive) endWallActivity(evaluationWallActivity);
            if (mapped) {
                try { slot.eval?.readBuf.unmap(); } catch { /* already invalid after device loss */ }
            }
            stats.inFlight--;
            releaseSlot(slot);
        }
    }

    function cpuEvaluate(boards) {
        const started = performance.now();
        const results = boards.map(evaluateBoardFeatures);
        stats.evaluationBoardsCpu += boards.length;
        stats.evaluationCpuWallMs += performance.now() - started;
        return results;
    }

    const api = {
        capabilities: Object.freeze({
            profile,
            mobile,
            adapter: Object.freeze({ ...adapterInfo }),
            timestampQueries: timestampEnabled,
            workgroupSize: WORKGROUP,
            maxChildrenPerDispatch: maxChildren,
            maxPlayoutsPerDispatch,
            maxEncodedPlayouts: MAX_PACKED_PLAYOUTS,
            maxInFlight,
            maxEvaluationBoardsPerDispatch: maxEvalBoards,
            evaluationAssist: true,
            targetBatchMs,
        }),

        // boards: array of Uint8Array(144). The original result fields remain
        // compatible; positions is an additive exact telemetry field.
        async runBatch(boards, tabu, playouts, seedBase) {
            if (terminalError) throw terminalError;
            validateBoards(boards);
            if (!tabu || tabu.length < boards.length) throw new RangeError("tabu must contain one color per board");
            if (!Number.isInteger(playouts) || playouts <= 0 || playouts > MAX_PACKED_PLAYOUTS) {
                throw new RangeError(`playouts must be between 1 and ${MAX_PACKED_PLAYOUTS}`);
            }
            stats.calls++;
            if (boards.length === 0) return [];
            const logicalBatchStartedAt = performance.now();

            const jobs = [];
            for (let childStart = 0; childStart < boards.length; childStart += maxChildren) {
                const childEnd = Math.min(boards.length, childStart + maxChildren);
                const boardChunk = Array.prototype.slice.call(boards, childStart, childEnd);
                const tabuChunk = Array.prototype.slice.call(tabu, childStart, childEnd);
                // Large logical batches are striped across the slot pool even
                // when they fit in one legal dispatch. Each stripe still has
                // enough long-running threads to occupy the device, while the
                // following command is already queued when the previous one
                // reaches its tiny result copy/map phase.
                const invocations = boardChunk.length * playouts;
                const stripes = Math.min(maxInFlight, Math.max(1, Math.ceil(invocations / 32768)));
                const sampleChunkLimit = Math.min(maxPlayoutsPerDispatch,
                    Math.max(WORKGROUP, Math.ceil(playouts / stripes / WORKGROUP) * WORKGROUP));
                for (let sampleOffset = 0; sampleOffset < playouts; sampleOffset += sampleChunkLimit) {
                    const samples = Math.min(sampleChunkLimit, playouts - sampleOffset);
                    jobs.push({
                        childStart,
                        sampleOffset,
                        promise: runPlayoutDispatch(boardChunk, tabuChunk, samples,
                            ((seedBase >>> 0) + sampleOffset) >>> 0, sampleOffset),
                    });
                }
            }
            const completed = await Promise.all(jobs.map(async (job) => ({
                ...job,
                values: await job.promise,
            })));
            const merged = Array.from({ length: boards.length }, () => ({
                final: 255,
                seedIdx: 0xFFFFFF,
                positions: 0,
            }));
            for (const job of completed) {
                for (let i = 0; i < job.values.length; i++) {
                    const target = merged[job.childStart + i];
                    const value = job.values[i];
                    target.positions += value.positions;
                    const oldPacked = target.final * 0x1000000 + target.seedIdx;
                    const newPacked = value.final * 0x1000000 + value.seedIdx;
                    if (newPacked < oldPacked) {
                        target.final = value.final;
                        target.seedIdx = value.seedIdx;
                    }
                }
            }
            if (!timestampEnabled) {
                const totalPlayouts = boards.length * playouts;
                const wallMs = performance.now() - logicalBatchStartedAt;
                if (totalPlayouts >= 512 && boards.length >= 2 && wallMs > 0) {
                    const observed = totalPlayouts / wallMs;
                    throughputEwma = throughputEwma === 0 ? observed :
                        throughputEwma * 0.7 + observed * 0.3;
                }
            }
            return merged;
        },

        // Multiple callers may submit without awaiting; the resource pool
        // pipelines up to capabilities.maxInFlight independent batches.
        submitBatch(boards, tabu, playouts, seedBase) {
            return this.runBatch(boards, tabu, playouts, seedBase);
        },

        recommendPlayouts(children, requestedTargetMs = targetBatchMs) {
            return calculateRecommendedGpuPlayouts(profile, children, throughputEwma,
                requestedTargetMs, maxPlayoutsPerDispatch);
        },

        // Optional, non-proof beam assist. Small batches deliberately stay on
        // the CPU because their WebGPU transfer/map overhead exceeds 144-cell
        // feature scans. GPU results are sample-verified against the CPU twin;
        // a mismatch permanently falls back to CPU evaluation only.
        async evaluateBoards(boards, evalOptions = {}) {
            validateBoards(boards);
            stats.evaluationCalls++;
            if (boards.length === 0) return [];
            const threshold = Math.max(1, Math.floor(evalOptions.gpuThreshold ?? defaults.evalThreshold));
            if (evalState === "failed" || (!evalOptions.forceGpu && boards.length < threshold)) {
                if (evalState === "failed") stats.evaluationFallbacks++;
                return cpuEvaluate(Array.from(boards));
            }
            const evalPipeline = await ensureEvalPipeline();
            if (!evalPipeline) {
                stats.evaluationFallbacks++;
                return cpuEvaluate(Array.from(boards));
            }
            try {
                const chunks = [];
                for (let start = 0; start < boards.length; start += maxEvalBoards) {
                    const chunk = Array.prototype.slice.call(boards, start, start + maxEvalBoards);
                    chunks.push({ start, promise: runEvaluationDispatch(chunk, evalPipeline) });
                }
                const parts = await Promise.all(chunks.map(async (chunk) => ({
                    start: chunk.start,
                    values: await chunk.promise,
                })));
                const results = new Array(boards.length);
                for (const part of parts) {
                    for (let i = 0; i < part.values.length; i++) results[part.start + i] = part.values[i];
                }
                if (evalOptions.verify !== false) {
                    const sampleIndices = new Set([0, Math.floor(boards.length / 2), boards.length - 1]);
                    for (const index of sampleIndices) {
                        const cpu = evaluateBoardFeatures(boards[index]);
                        if (JSON.stringify(cpu) !== JSON.stringify(results[index])) {
                            evalState = "failed";
                            stats.evaluationVerificationFailures++;
                            stats.evaluationFallbacks++;
                            return cpuEvaluate(Array.from(boards));
                        }
                    }
                }
                return results;
            } catch {
                evalState = "failed";
                stats.evaluationFallbacks++;
                return cpuEvaluate(Array.from(boards));
            }
        },

        getStats() {
            const now = performance.now();
            const elapsedMs = Math.max(0.001, now - createdAt);
            const dispatchWallMs = wallActivityMs(playoutWallActivity, now);
            const evaluationWallMs = wallActivityMs(evaluationWallActivity, now);
            // dispatchWallMs is the union of all overlapping slot intervals.
            // gpuTimeMs deliberately remains the sum of timestamped passes,
            // which is valuable diagnostics but over-counts concurrent stripes
            // and is therefore not a duty-cycle or aggregate-rate denominator.
            const activeMs = dispatchWallMs > 0 ? dispatchWallMs : stats.gpuTimeMs;
            return {
                ...stats,
                dispatchWallMs,
                evaluationWallMs,
                lastBatch: stats.lastBatch ? { ...stats.lastBatch } : null,
                elapsedMs,
                profile,
                evaluationState: evalState,
                observedPlayoutsPerMs: throughputEwma,
                recommendedPlayouts: this.recommendPlayouts(maxChildren),
                activePositionsPerSecond: activeMs > 0 ? Math.round(stats.positionsProcessed * 1000 / activeMs) : 0,
                lifetimePositionsPerSecond: Math.round(stats.positionsProcessed * 1000 / elapsedMs),
            };
        },

        getCapabilities() {
            return { ...this.capabilities, evaluationState: evalState };
        },

        destroy() {
            if (destroyed) return;
            destroyed = true;
            terminalError = new Error("WebGPU accelerator destroyed");
            rejectWaiters(terminalError);
            for (const slot of slots) {
                try { slot.querySet?.destroy(); } catch { /* optional resource */ }
                for (const resource of [slot.paramsBuf, slot.boardsBuf, slot.tabuBuf, slot.outBuf,
                    slot.positionsBuf, slot.readBuf, slot.queryResolveBuf, slot.eval?.paramsBuf,
                    slot.eval?.boardsBuf, slot.eval?.featuresBuf, slot.eval?.readBuf]) {
                    try { resource?.destroy(); } catch { /* device may already be lost */ }
                }
            }
            device.destroy();
        },
    };
    return api;
}
