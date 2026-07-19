/**
 * Repro: resource-throttle balance on move 12 of the supplied benchmark
 * position — reports cpu/gpu wall pps, GPU duty and batches at a given
 * resource percent. Self-contained static server, headless Chrome.
 */

import puppeteer from "puppeteer-core";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join, normalize } from "node:path";

const ROOT = "c:/repos/click2026";
const PORT = 8135;
const OBSERVE_S = Number(process.env.OBSERVE_S || 15);
const GAME = "v=5&g=CsbPv03pg7sXvqMWs1U8RGSdTgUuxAY0IVsnZLLtc6R0L_V_PmJfMf4ADDephP52gJ5cCyFOvdv4mc7_01Y8yn_Kz2ODi03smM-isp7a71bWhMjtZW";

const CANDIDATES = [
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
];
const executablePath = CANDIDATES.find(existsSync);

const MIME = {
    ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript",
    ".css": "text/css", ".wasm": "application/wasm", ".png": "image/png",
};
const server = createServer(async (req, res) => {
    try {
        const url = new URL(req.url, "http://localhost");
        let path = normalize(join(ROOT, decodeURIComponent(url.pathname)));
        if (path.endsWith("\\") || path.endsWith("/")) path = join(path, "index.html");
        const body = await readFile(path);
        res.writeHead(200, { "content-type": MIME[extname(path).toLowerCase()] ?? "application/octet-stream" });
        res.end(body);
    } catch { res.writeHead(404); res.end(); }
});
await new Promise((resolve) => server.listen(PORT, resolve));

// NO_GPU=1 launches without WebGPU flags to exercise the CPU fallback path
const browser = await puppeteer.launch({
    executablePath, headless: "new", protocolTimeout: 180000,
    args: process.env.NO_GPU ? ["--disable-gpu",
        "--disable-features=WebGPU,WebGPUService,Vulkan", "--no-sandbox"] :
        ["--enable-unsafe-webgpu", "--enable-features=Vulkan", "--no-sandbox"],
});

const parse = (text, regex) => Number((text.match(regex)?.[1] ?? "0").replace(/,/g, ""));

async function measure(spec) {
    // spec: "NN" pins both processors; "CC:GG" pins CPU and GPU separately;
    // "default" passes NO override params — the stored-settings path real
    // players hit (this is the path the Number(null)=0 override bug broke)
    const [cpu, gpu] = String(spec).includes(":")
        ? String(spec).split(":") : [spec, spec];
    const override = spec === "default" ? "" :
        `&engineCpuResource=${cpu}&engineGpuResource=${gpu}`;
    const page = await browser.newPage();
    const errors = [];
    page.on("console", (msg) => { if (msg.type() === "error") errors.push(msg.text()); });
    page.on("pageerror", (error) => errors.push(String(error)));
    await page.setViewport({ width: 1200, height: 800 });
    await page.goto(`http://localhost:${PORT}/src/index.html?${GAME}${override}`,
        { waitUntil: "networkidle0" });
    // navigate to move 12
    await page.evaluate(() => {
        const slider = document.getElementById("movesSlider");
        slider.value = "12";
        slider.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await page.waitForFunction(() =>
        document.getElementById("moveValue").textContent.startsWith("12 /"), { timeout: 10000 });
    if (!await page.$eval("#engineButton", (b) => b.classList.contains("active"))) {
        await page.$eval("#engineButton", (button) => button.click());
    }
    try {
        await page.waitForFunction(() =>
            /n\/s/.test(document.getElementById("engineStatus").textContent), { timeout: 30000 });
    } catch (error) {
        const status = await page.evaluate(() =>
            document.getElementById("engineStatus")?.textContent ?? "(no status)");
        console.error(`  status @${spec}: "${status}"; errors:`, errors.slice(0, 5));
        throw error;
    }
    // Continuity probe: batches at the halfway mark vs the end. A pump that
    // dies early shows a frozen batch counter in the second half.
    const snap = () => page.evaluate(() => ({
        total: document.querySelector("#engineStatus .engineStRate")?.title ?? "",
        cpu: document.querySelector("#engineStatus .engineHwCpu")?.title ?? "",
        gpu: document.querySelector("#engineStatus .engineHwGpu")?.title ?? "",
        state: document.querySelector("#engineStatus .engineStState")?.textContent ?? "",
    }));
    await new Promise((resolve) => setTimeout(resolve, OBSERVE_S * 500));
    const midBatches = Number(((await snap()).gpu.match(/batches: ([\d,]+)/)?.[1] ?? "0")
        .replace(/,/g, ""));
    await new Promise((resolve) => setTimeout(resolve, OBSERVE_S * 500));
    const raw = await snap();
    raw.midBatches = midBatches;
    await page.close();
    return {
        percent: spec,
        state: raw.state,
        totalPps: parse(raw.total, /throughput: ([\d,]+)/),
        cpuPps: parse(raw.cpu, /throughput: ([\d,]+)/),
        gpuPps: parse(raw.gpu, /contribution: ([\d,]+)/),
        gpuActivePps: parse(raw.gpu, /active throughput: ([\d,]+)/),
        gpuDuty: parse(raw.gpu, /duty cycle: (\d+)/),
        gpuBatches: parse(raw.gpu, /batches: ([\d,]+)/),
        gpuBatchesFirstHalf: raw.midBatches,
    };
}

try {
    for (const spec of process.argv.slice(2)) {
        const r = await measure(spec);
        console.log(`${r.percent}%: total ${(r.totalPps / 1e6).toFixed(1)}M  ` +
            `cpu ${(r.cpuPps / 1e6).toFixed(1)}M  gpu ${(r.gpuPps / 1e6).toFixed(2)}M  ` +
            `(active ${(r.gpuActivePps / 1e6).toFixed(0)}M/s, duty ${r.gpuDuty}%, ` +
            `batches ${r.gpuBatchesFirstHalf}->${r.gpuBatches}, state ${r.state})`);
    }
} finally {
    await browser.close();
    server.close();
}
