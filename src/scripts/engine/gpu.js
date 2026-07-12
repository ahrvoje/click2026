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
 * The kernel only returns, per candidate, the packed minimum
 * (finalRemaining << 24 | seedIndex) via atomicMin — the full move line is
 * reconstructed CPU-side by replaying the winning seed.
 *
 * Copyright 2014-2026, Hrvoje Abraham ahrvoje@gmail.com
 * Released under the MIT license.
 * https://opensource.org/licenses/MIT
 *
 * Date: Sat Jul 11, 2026
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

const SHADER = /* wgsl */ `
struct Params {
    children: u32,
    playouts: u32,
    seedBase: u32,
    pad: u32,
}

@group(0) @binding(0) var<uniform> P: Params;
@group(0) @binding(1) var<storage, read> BOARDS: array<u32>;   // children * 36 words, 4 cells each
@group(0) @binding(2) var<storage, read> TABU: array<u32>;     // children
@group(0) @binding(3) var<storage, read_write> OUT: array<atomic<u32>>; // children, (final << 24) | seedIdx

var<private> board: array<u32, 144>;
var<private> visited: array<u32, 5>;
var<private> visited2: array<u32, 5>;
var<private> stk: array<u32, 144>;
var<private> reps: array<u32, 80>;
var<private> cols: array<u32, 80>;
var<private> rx: u32;
var<private> ry: u32;
var<private> rz: u32;
var<private> rw: u32;

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

// flood fill during enumeration: marks the shared visited mask, returns size
fn enumFlood(start: u32, color: u32) -> u32 {
    visited[start >> 5u] |= (1u << (start & 31u));
    stk[0] = start;
    var sp = 1u;
    var size = 0u;

    while (sp > 0u) {
        sp -= 1u;
        let c = stk[sp];
        size += 1u;
        let col = c / 12u;
        let row = c % 12u;

        if (col > 0u && board[c - 12u] == color && (visited[(c - 12u) >> 5u] & (1u << ((c - 12u) & 31u))) == 0u) {
            visited[(c - 12u) >> 5u] |= (1u << ((c - 12u) & 31u));
            stk[sp] = c - 12u; sp += 1u;
        }
        if (col < 11u && board[c + 12u] == color && (visited[(c + 12u) >> 5u] & (1u << ((c + 12u) & 31u))) == 0u) {
            visited[(c + 12u) >> 5u] |= (1u << ((c + 12u) & 31u));
            stk[sp] = c + 12u; sp += 1u;
        }
        if (row > 0u && board[c - 1u] == color && (visited[(c - 1u) >> 5u] & (1u << ((c - 1u) & 31u))) == 0u) {
            visited[(c - 1u) >> 5u] |= (1u << ((c - 1u) & 31u));
            stk[sp] = c - 1u; sp += 1u;
        }
        if (row < 11u && board[c + 1u] == color && (visited[(c + 1u) >> 5u] & (1u << ((c + 1u) & 31u))) == 0u) {
            visited[(c + 1u) >> 5u] |= (1u << ((c + 1u) & 31u));
            stk[sp] = c + 1u; sp += 1u;
        }
    }

    return size;
}

// removes the group containing "start" (own visited mask), then collapses —
// the twin of applyMove() + collapse() in asm/engine.ts
fn removeGroupAt(start: u32) {
    let color = board[start];
    for (var w = 0u; w < 5u; w += 1u) { visited2[w] = 0u; }

    visited2[start >> 5u] |= (1u << (start & 31u));
    stk[0] = start;
    var sp = 1u;

    while (sp > 0u) {
        sp -= 1u;
        let c = stk[sp];
        board[c] = 0u;
        let col = c / 12u;
        let row = c % 12u;

        if (col > 0u && board[c - 12u] == color && (visited2[(c - 12u) >> 5u] & (1u << ((c - 12u) & 31u))) == 0u) {
            visited2[(c - 12u) >> 5u] |= (1u << ((c - 12u) & 31u));
            stk[sp] = c - 12u; sp += 1u;
        }
        if (col < 11u && board[c + 12u] == color && (visited2[(c + 12u) >> 5u] & (1u << ((c + 12u) & 31u))) == 0u) {
            visited2[(c + 12u) >> 5u] |= (1u << ((c + 12u) & 31u));
            stk[sp] = c + 12u; sp += 1u;
        }
        if (row > 0u && board[c - 1u] == color && (visited2[(c - 1u) >> 5u] & (1u << ((c - 1u) & 31u))) == 0u) {
            visited2[(c - 1u) >> 5u] |= (1u << ((c - 1u) & 31u));
            stk[sp] = c - 1u; sp += 1u;
        }
        if (row < 11u && board[c + 1u] == color && (visited2[(c + 1u) >> 5u] & (1u << ((c + 1u) & 31u))) == 0u) {
            visited2[(c + 1u) >> 5u] |= (1u << ((c + 1u) & 31u));
            stk[sp] = c + 1u; sp += 1u;
        }
    }

    // gravity down inside columns
    for (var col = 0u; col < 12u; col += 1u) {
        var w = 0u;
        for (var j = 0u; j < 12u; j += 1u) {
            let v = board[col * 12u + j];
            board[col * 12u + j] = 0u;
            if (v != 0u) {
                board[col * 12u + w] = v;
                w += 1u;
            }
        }
    }

    // compact non-empty columns left
    var writeCol = 0u;
    for (var col = 0u; col < 12u; col += 1u) {
        if (board[col * 12u] != 0u) {
            if (writeCol != col) {
                for (var j = 0u; j < 12u; j += 1u) {
                    board[writeCol * 12u + j] = board[col * 12u + j];
                    board[col * 12u + j] = 0u;
                }
            }
            writeCol += 1u;
        }
    }
}

@compute @workgroup_size(${WORKGROUP})
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
    let t = gid.x;
    let child = gid.y;
    if (t >= P.playouts || child >= P.children) { return; }

    // unpack the candidate board (4 cells per word)
    for (var c = 0u; c < 144u; c += 1u) {
        let word = BOARDS[child * 36u + c / 4u];
        board[c] = (word >> ((c % 4u) * 8u)) & 0xFFu;
    }

    rngSeed(P.seedBase + t);
    let tabu = TABU[child];

    // playout loop — the twin of playoutRun() in asm/engine.ts
    // (nb: "move" and "target" are reserved words in WGSL)
    for (var mv = 0u; mv < 80u; mv += 1u) {
        // enumerate clickable groups in ascending cell order
        for (var w = 0u; w < 5u; w += 1u) { visited[w] = 0u; }
        var n = 0u;
        for (var cell = 0u; cell < 144u; cell += 1u) {
            if ((visited[cell >> 5u] & (1u << (cell & 31u))) != 0u) { continue; }
            let color = board[cell];
            if (color == 0u) { continue; }
            let size = enumFlood(cell, color);
            if (size >= 2u && n < 80u) {
                reps[n] = cell;
                cols[n] = color;
                n += 1u;
            }
        }
        if (n == 0u) { break; }

        // Prefer non-tabu groups; the worker supplements this exploitation
        // batch with full-support CPU samples.
        var pick = 0u;
        var cand = 0u;
        for (var g = 0u; g < n; g += 1u) {
            if (cols[g] != tabu) { cand += 1u; }
        }
        if (cand > 0u) {
            var skip = rngNext() % cand;
            for (var g = 0u; g < n; g += 1u) {
                if (cols[g] != tabu) {
                    if (skip == 0u) { pick = g; break; }
                    skip -= 1u;
                }
            }
        } else {
            pick = rngNext() % n;
        }

        removeGroupAt(reps[pick]);
    }

    var remaining = 0u;
    for (var c = 0u; c < 144u; c += 1u) {
        if (board[c] != 0u) { remaining += 1u; }
    }

    atomicMin(&OUT[child], (remaining << 24u) | t);
}
`;

// creates the accelerator, or null when WebGPU is unavailable on this device
export async function createGpu() {
    if (!("gpu" in navigator)) return null;

    let device;
    try {
        // A hint only—the browser retains final adapter choice—but preferable
        // for an explicitly enabled analysis engine. Fall back for browsers
        // that cannot satisfy or do not recognize the preference.
        let adapter = null;
        try {
            adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
        } catch {
            // Older implementations may reject an unknown options member.
        }
        if (!adapter) adapter = await navigator.gpu.requestAdapter();
        if (!adapter) return null;
        device = await adapter.requestDevice();
    } catch {
        return null;
    }

    let lost = false;
    device.lost.then(() => { lost = true; });

    const module = device.createShaderModule({ code: SHADER });
    const pipeline = await device.createComputePipelineAsync({
        layout: "auto",
        compute: { module, entryPoint: "main" },
    });

    const paramsBuf = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const boardsBuf = device.createBuffer({ size: MAX_CHILDREN * 36 * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    const tabuBuf = device.createBuffer({ size: MAX_CHILDREN * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    const outBuf = device.createBuffer({ size: MAX_CHILDREN * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC });
    const readBuf = device.createBuffer({ size: MAX_CHILDREN * 4, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });

    const bindGroup = device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [
            { binding: 0, resource: { buffer: paramsBuf } },
            { binding: 1, resource: { buffer: boardsBuf } },
            { binding: 2, resource: { buffer: tabuBuf } },
            { binding: 3, resource: { buffer: outBuf } },
        ],
    });

    return {
        // boards: array of Uint8Array(144); returns [{final, seedIdx}] per board
        async runBatch(boards, tabu, playouts, seedBase) {
            if (lost) throw new Error("WebGPU device lost");
            const children = Math.min(boards.length, MAX_CHILDREN);

            // pack 4 cells per u32, little-endian
            const packed = new Uint32Array(children * 36);
            for (let k = 0; k < children; k++) {
                for (let c = 0; c < 144; c++) {
                    packed[k * 36 + (c >> 2)] |= boards[k][c] << ((c & 3) * 8);
                }
            }

            device.queue.writeBuffer(paramsBuf, 0, new Uint32Array([children, playouts, seedBase >>> 0, 0]));
            device.queue.writeBuffer(boardsBuf, 0, packed);
            device.queue.writeBuffer(tabuBuf, 0, new Uint32Array(tabu.slice(0, children)));
            device.queue.writeBuffer(outBuf, 0, new Uint32Array(children).fill(0xFFFFFFFF));

            const encoder = device.createCommandEncoder();
            const pass = encoder.beginComputePass();
            pass.setPipeline(pipeline);
            pass.setBindGroup(0, bindGroup);
            pass.dispatchWorkgroups(Math.ceil(playouts / WORKGROUP), children);
            pass.end();
            encoder.copyBufferToBuffer(outBuf, 0, readBuf, 0, children * 4);
            device.queue.submit([encoder.finish()]);

            await readBuf.mapAsync(GPUMapMode.READ, 0, children * 4);
            const out = new Uint32Array(readBuf.getMappedRange(0, children * 4)).slice();
            readBuf.unmap();

            return Array.from(out, (v) => ({ final: v >>> 24, seedIdx: v & 0xFFFFFF }));
        },

        destroy() {
            device.destroy();
        },
    };
}
