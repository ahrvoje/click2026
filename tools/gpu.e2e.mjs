/**
 * Live WebGPU shader/API check. Expects the repository root at localhost:8123.
 * Run with: npm run serve, then node tools/gpu.e2e.mjs
 * Override the origin with BASE_URL, for example http://localhost:8124.
 */

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import puppeteer from "puppeteer-core";

const candidates = [
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
];
const executablePath = candidates.find(existsSync);
if (!executablePath) throw new Error("Chrome or Edge is required");
const baseURL = (process.env.BASE_URL || "http://localhost:8123").replace(/\/$/, "");

const browser = await puppeteer.launch({
    executablePath,
    headless: "new",
    args: ["--enable-unsafe-webgpu", "--enable-features=Vulkan", "--no-sandbox"],
});

try {
    const page = await browser.newPage();
    const browserErrors = [];
    page.on("pageerror", (error) => browserErrors.push(String(error)));
    page.on("console", (message) => {
        if (message.type() === "error") browserErrors.push(message.text());
    });
    await page.goto(`${baseURL}/`, { waitUntil: "domcontentloaded" });
    const result = await page.evaluate(async () => {
        const mod = await import(`/src/scripts/engine/gpu.js?gpu-e2e=${Date.now()}`);
        const gpu = await mod.createGpu({ maxInFlight: 2 });
        if (!gpu) return { unavailable: true };

        const board = new Uint8Array(144);
        let state = 123456789;
        for (let c = 0; c < 144; c++) {
            state = (Math.imul(state, 1103515245) + 12345) & 0x7FFFFFFF;
            board[c] = 1 + (state % 5);
        }
        const tabu = mod.dominantColor(board);
        const [first] = await gpu.runBatch([board], [tabu], 64, 5000);
        const [terminal] = await gpu.runBatch([new Uint8Array(144)], [0], 64, 6000);

        const wasmResponse = await fetch("/src/scripts/engine/engine.wasm");
        const { instance } = await WebAssembly.instantiate(await wasmResponse.arrayBuffer(), {
            env: { abort: () => { throw new Error("wasm abort"); } },
        });
        const eng = instance.exports;
        new Uint8Array(eng.memory.buffer).set(board, eng.ioPtr());
        const cpuFinal = eng.testPlayout(5000 + first.seedIdx);

        const [concurrentA, concurrentB] = await Promise.all([
            gpu.submitBatch([board, board], [tabu, tabu], 128, 7000),
            gpu.submitBatch([board, board], [tabu, tabu], 128, 9000),
        ]);
        const beforeStriped = gpu.getStats().dispatchesCompleted;
        const wideBoards = Array.from({ length: 80 }, () => board);
        await gpu.runBatch(wideBoards, new Uint8Array(80).fill(tabu), 512, 11000);
        const stripedDispatches = gpu.getStats().dispatchesCompleted - beforeStriped;
        const evalBoards = Array.from({ length: 128 }, () => board);
        const evaluated = await gpu.evaluateBoards(evalBoards, { forceGpu: true });
        const cpuFeatures = mod.evaluateBoardFeatures(board);
        const stats = gpu.getStats();
        const capabilities = gpu.getCapabilities();
        gpu.destroy();

        // Exercise the wall-clock fallback explicitly. Concurrent submissions
        // must be measured as one union of active intervals, not the sum of
        // overlapping mapAsync waits.
        const untimed = await mod.createGpu({
            maxInFlight: 3,
            profile: "discrete",
            timestampQueries: false,
        });
        let untimedStats = null;
        let untimedRunMs = 0;
        if (untimed) {
            const wideBoards = Array.from({ length: 80 }, () => board);
            const wideTabu = new Uint8Array(80).fill(tabu);
            const untimedStarted = performance.now();
            await Promise.all([
                untimed.submitBatch(wideBoards, wideTabu, 512, 13000),
                untimed.submitBatch(wideBoards, wideTabu, 512, 15000),
            ]);
            untimedRunMs = performance.now() - untimedStarted;
            untimedStats = untimed.getStats();
            untimed.destroy();
        }
        return {
            unavailable: false,
            first,
            terminal,
            cpuFinal,
            concurrentLengths: [concurrentA.length, concurrentB.length],
            stripedDispatches,
            featureMatch: JSON.stringify(evaluated[0]) === JSON.stringify(cpuFeatures),
            stats,
            capabilities,
            untimedStats,
            untimedRunMs,
        };
    });

    if (result.unavailable) {
        console.log("gpu e2e: WebGPU unavailable; skipped");
    } else {
        assert.equal(result.first.final, result.cpuFinal, "winning GPU seed replays identically in WASM");
        assert.ok(result.first.positions >= 64, "the GPU returned exact processed-position telemetry");
        assert.equal(result.terminal.positions, 0,
            "GPU positions use the CPU definition and exclude a terminal board");
        assert.deepEqual(result.concurrentLengths, [2, 2]);
        assert.ok(result.stripedDispatches >= 2, "large logical batches stripe across pooled submissions");
        assert.equal(result.featureMatch, true, "GPU board features match their CPU twin");
        assert.ok(result.stats.dispatchesCompleted >= 3);
        assert.ok(result.stats.positionsProcessed >= result.first.positions);
        assert.equal(result.stats.evaluationState, "available");
        assert.equal(result.capabilities.evaluationAssist, true);
        if (result.untimedStats) {
            assert.equal(result.untimedStats.gpuTimeMs, 0);
            assert.ok(result.untimedStats.dispatchWallMs > 0);
            assert.ok(result.untimedStats.dispatchWallMs <= result.untimedRunMs + 10,
                "untimed concurrent dispatch intervals are unioned rather than summed");
        }
        assert.deepEqual(browserErrors, []);
        console.log("gpu e2e: all checks passed", {
            profile: result.capabilities.profile,
            timestampQueries: result.capabilities.timestampQueries,
            positions: result.stats.positionsProcessed,
            peakInFlight: result.stats.peakInFlight,
        });
    }
} finally {
    await browser.close();
}
