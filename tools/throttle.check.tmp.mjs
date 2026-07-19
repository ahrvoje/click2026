/**
 * Empirical resource-throttle check: measures engine n/s at 100% vs 20%
 * resource use on the deterministic example-1 start position.
 * Self-contained: serves the repo root itself, no external server needed.
 */

import puppeteer from "puppeteer-core";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join, normalize } from "node:path";

const ROOT = "c:/repos/click2026";
const PORT = 8134;
const OBSERVE_S = Number(process.env.OBSERVE_S || 12);

const CANDIDATES = [
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
];
const executablePath = CANDIDATES.find(existsSync);
if (!executablePath) {
    console.error("no Chrome/Edge found");
    process.exit(1);
}

const MIME = {
    ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript",
    ".css": "text/css", ".wasm": "application/wasm", ".png": "image/png",
    ".woff2": "font/woff2", ".woff": "font/woff", ".ttf": "font/ttf",
};
const server = createServer(async (req, res) => {
    try {
        const url = new URL(req.url, "http://localhost");
        let path = normalize(join(ROOT, decodeURIComponent(url.pathname)));
        if (path.endsWith("\\") || path.endsWith("/")) path = join(path, "index.html");
        const body = await readFile(path);
        res.writeHead(200, { "content-type": MIME[extname(path).toLowerCase()] ?? "application/octet-stream" });
        res.end(body);
    } catch {
        res.writeHead(404);
        res.end();
    }
});
await new Promise((resolve) => server.listen(PORT, resolve));

const browser = await puppeteer.launch({
    executablePath,
    headless: "new",
    protocolTimeout: 180000,
    args: ["--enable-unsafe-webgpu", "--enable-features=Vulkan", "--no-sandbox"],
});

const parse = (text, regex) =>
    Number((text.match(regex)?.[1] ?? "0").replace(/,/g, ""));

async function measure(percent) {
    const page = await browser.newPage();
    const errors = [];
    page.on("console", (msg) => { if (msg.type() === "error") errors.push(msg.text()); });
    page.on("pageerror", (error) => errors.push(String(error)));
    await page.setViewport({ width: 1200, height: 800 });
    await page.goto(`http://localhost:${PORT}/src/index.html?engineResource=${percent}`,
        { waitUntil: "networkidle0" });
    // deterministic position: example 1 rewound to move 0
    await page.$eval("#example0", (button) => button.click());
    await page.evaluate(() => {
        const slider = document.getElementById("movesSlider");
        slider.value = "0";
        slider.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await page.waitForFunction(() =>
        document.getElementById("moveValue").textContent.startsWith("0 /"), { timeout: 10000 });
    if (!await page.$eval("#engineButton", (b) => b.classList.contains("active"))) {
        await page.$eval("#engineButton", (button) => button.click());
    }
    await page.waitForFunction(() =>
        /n\/s/.test(document.getElementById("engineStatus").textContent), { timeout: 30000 });
    await new Promise((resolve) => setTimeout(resolve, OBSERVE_S * 1000));
    const raw = await page.evaluate(() => ({
        total: document.querySelector("#engineStatus .engineStRate")?.title ?? "",
        cpu: document.querySelector("#engineStatus .engineHwCpu")?.title ?? "",
        gpu: document.querySelector("#engineStatus .engineHwGpu")?.title ?? "",
        state: document.querySelector("#engineStatus .engineStState")?.textContent ?? "",
    }));
    await page.close();
    if (errors.length > 0) console.error(`  errors @${percent}%:`, errors.slice(0, 5));
    return {
        percent,
        state: raw.state,
        totalPps: parse(raw.total, /throughput: ([\d,]+)/),
        cpuPps: parse(raw.cpu, /throughput: ([\d,]+)/),
        gpuPps: parse(raw.gpu, /contribution: ([\d,]+)/),
        gpuOn: /GPU active/.test(raw.gpu),
        gpuTitle: raw.gpu.slice(0, 90),
    };
}

try {
    const full = await measure(100);
    const throttled = await measure(20);
    const fmt = (r) => `${r.percent}%: total ${(r.totalPps / 1e6).toFixed(1)}M n/s ` +
        `(cpu ${(r.cpuPps / 1e6).toFixed(1)}M, gpu ${(r.gpuPps / 1e6).toFixed(1)}M, ` +
        `gpuOn=${r.gpuOn}, state=${r.state})`;
    console.log(fmt(full));
    console.log(fmt(throttled));
    console.log(`ratio total: ${(full.totalPps / Math.max(1, throttled.totalPps)).toFixed(2)}x` +
        `  cpu: ${(full.cpuPps / Math.max(1, throttled.cpuPps)).toFixed(2)}x` +
        `  gpu: ${(full.gpuPps / Math.max(1, throttled.gpuPps)).toFixed(2)}x`);
} finally {
    await browser.close();
    server.close();
}
