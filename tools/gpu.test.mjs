/**
 * Pure-JavaScript checks for WebGPU capability policy and CPU feature twin.
 * Run with: node tools/gpu.test.mjs
 */

import assert from "node:assert/strict";
import {
    calculateRecommendedGpuPlayouts,
    dominantColor,
    evaluateBoardFeatures,
    gpuProfileFor,
} from "../src/scripts/engine/gpu.js";

assert.equal(gpuProfileFor({ vendor: "NVIDIA", description: "GeForce RTX 4080" }), "discrete");
assert.equal(gpuProfileFor({ vendor: "Intel", architecture: "Gen-12LP" }), "integrated");
assert.equal(gpuProfileFor({ vendor: "AMD", description: "AMD Radeon(TM) Graphics" }), "integrated");
assert.equal(gpuProfileFor({ vendor: "AMD", device: "Radeon 780M Graphics" }), "integrated");
assert.equal(gpuProfileFor({ vendor: "AMD", description: "Radeon Vega 8 Graphics" }), "integrated");
assert.equal(gpuProfileFor({ vendor: "AMD", description: "AMD Radeon RX 7900 XTX" }), "discrete");
assert.equal(gpuProfileFor({ vendor: "AMD", description: "Radeon Pro W7800" }), "discrete");
assert.equal(gpuProfileFor({ vendor: "NVIDIA" }, true), "mobile");
assert.equal(gpuProfileFor({}, false), "balanced");

const initialDesktop = calculateRecommendedGpuPlayouts("discrete", 80);
assert.equal(initialDesktop, 2048);
assert.equal(initialDesktop % 64, 0);
const observedDesktop = calculateRecommendedGpuPlayouts("discrete", 80, 1600, 75);
assert.equal(observedDesktop, 1472);
assert.equal(observedDesktop % 64, 0);
assert.equal(calculateRecommendedGpuPlayouts("mobile", 1, 1e9), 4096);
assert.equal(calculateRecommendedGpuPlayouts("mobile", 80, 0, 40, 256), 256);

const board = new Uint8Array(144);
board[0] = 1;
board[1] = 1;
board[2] = 2;
board[12] = 1;
board[13] = 2;
assert.equal(dominantColor(board), 1);
assert.deepEqual(evaluateBoardFeatures(board), {
    remaining: 5,
    colorMask: 0b110,
    colorCount: 2,
    dominant: 1,
    dominantCount: 3,
    adjacentPairs: 2,
    occupiedColumns: 2,
});

const tie = new Uint8Array(144);
tie[0] = 2;
tie[1] = 1;
assert.equal(dominantColor(tie), 1, "dominant-color ties use the lower id");

console.log("gpu helpers: all checks passed");
