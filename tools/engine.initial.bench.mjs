/**
 * Click2026 — initial-position proof-cost benchmark (development tool).
 *
 * Drives the served game in headless Chrome/Edge over a corpus of seeded
 * random full boards, lets the engine run until every root move is proven
 * ("proven ✓"), and records the exact node-evaluation count per position.
 * The sorted counts are summarized as quartile ranges (1-25, 26-50, 51-75,
 * 76-100 for the standard 100-position corpus) for docs/BENCHMARKS.md.
 *
 * Boards are reproducible: board(seed) fills 12x12 cells uniformly from
 * colors 1..5 using mulberry32(seed), seeds are seedBase+1 .. seedBase+count.
 *
 * Usage:
 *   node tools/engine.initial.bench.mjs [--count=100] [--seed-base=1000]
 *       [--timeout=900000] [--port=8213] [--out=results.jsonl] [--start=1]
 *
 * The tool serves the repo root itself; no external server is needed.
 *
 * Copyright 2014-2026, Hrvoje Abraham ahrvoje@gmail.com
 * Released under the MIT license.
 */

import puppeteer from "puppeteer-core";
import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { appendFile, readFile, writeFile } from "node:fs/promises";
import { dirname, extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const option = (name, fallback) =>
    process.argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const count = Number(option("count", "100"));
const seedBase = Number(option("seed-base", "1000"));
const startIndex = Number(option("start", "1"));
const perCaseTimeoutMs = Number(option("timeout", "900000"));
const port = Number(option("port", "8213"));
const outPath = option("out", join(root, "tools", "initial-bench.results.jsonl"));

// --- static server -----------------------------------------------------------

const MIME = {
    ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript",
    ".css": "text/css", ".wasm": "application/wasm", ".json": "application/json",
    ".png": "image/png", ".svg": "image/svg+xml", ".ico": "image/x-icon",
    ".woff": "font/woff", ".woff2": "font/woff2", ".map": "application/json",
};
const server = createServer(async (req, res) => {
    try {
        let path = decodeURIComponent(new URL(req.url, `http://localhost:${port}`).pathname);
        if (path.endsWith("/")) path += "index.html";
        const file = normalize(join(root, path));
        if (!file.startsWith(normalize(root))) throw new Error("outside root");
        const body = await readFile(file);
        res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" });
        res.end(body);
    } catch {
        res.writeHead(404);
        res.end("not found");
    }
});
await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
});
const baseURL = `http://127.0.0.1:${port}`;

// --- corpus ------------------------------------------------------------------

function mulberry32(seed) {
    return () => {
        seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
        let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

function boardDigits(seed) {
    const rnd = mulberry32(seed);
    let digits = "";
    for (let cell = 0; cell < 144; cell++) digits += 1 + Math.floor(rnd() * 5);
    return digits;
}

// --- browser -----------------------------------------------------------------

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
const browser = await puppeteer.launch({
    executablePath,
    headless: "new",
    protocolTimeout: perCaseTimeoutMs + 120_000,
    args: ["--enable-unsafe-webgpu", "--enable-features=Vulkan", "--no-sandbox"],
});

// --- run ---------------------------------------------------------------------

if (startIndex === 1) await writeFile(outPath, "");
const results = [];

try {
    for (let index = startIndex; index <= count; index++) {
        const seed = seedBase + index;
        const digits = boardDigits(seed);
        const page = await browser.newPage();
        const caseStart = performance.now();
        let record;
        try {
            await page.goto(`${baseURL}/src/index.html?position=${digits}`,
                { waitUntil: "networkidle0", timeout: 60_000 });
            if (!await page.$eval("#engineButton", (b) => b.classList.contains("active"))) {
                await page.click("#engineButton");
            }
            let status = "timeout";
            try {
                await page.waitForFunction(() =>
                    /proven ✓|settled|stopped/.test(
                        document.querySelector("#engineStatus .engineStState")?.textContent ?? ""),
                { timeout: perCaseTimeoutMs, polling: 1000 });
                status = await page.$eval("#engineStatus .engineStState",
                    (state) => state.textContent.trim());
            } catch { /* keep status = "timeout", record nodes so far */ }
            record = await page.evaluate(() => {
                const title = document.querySelector("#engineStatus .engineStTotal")?.title ?? "";
                const match = title.match(/([\d,]+)/);
                return {
                    nodes: match ? Number(match[1].replaceAll(",", "")) : -1,
                    elapsed: document.querySelector("#engineStatus .engineStTime")?.textContent ?? "",
                    shares: [...document.querySelectorAll("#engineStatus .engineHwShare")]
                        .map((share) => share.textContent.trim()),
                };
            });
            record.status = status;
        } catch (error) {
            record = { nodes: -1, elapsed: "", shares: [], status: `error: ${error.message}` };
        }
        record.index = index;
        record.seed = seed;
        record.wallMs = Math.round(performance.now() - caseStart);
        results.push(record);
        await appendFile(outPath, JSON.stringify(record) + "\n");
        console.log(`case ${String(index).padStart(3)}  seed ${seed}  ` +
            `${record.status.padEnd(9)}  ${record.nodes.toLocaleString().padStart(15)} nodes  ` +
            `${record.elapsed.padStart(7)}  wall ${(record.wallMs / 1000).toFixed(0)}s`);
        await page.close();
    }
} finally {
    await browser.close();
    server.close();
}

// --- summary -----------------------------------------------------------------

const proven = results.filter((r) => r.status.startsWith("proven")).sort((a, b) => a.nodes - b.nodes);
const other = results.filter((r) => !r.status.startsWith("proven"));
const fmt = (n) => n >= 1e9 ? (n / 1e9).toFixed(2) + "B" :
    n >= 1e6 ? (n / 1e6).toFixed(1) + "M" : n >= 1e3 ? (n / 1e3).toFixed(0) + "k" : String(n);

console.log(`\nproven: ${proven.length}/${results.length}`);
if (other.length) {
    console.log("non-proven cases:");
    for (const r of other) console.log(`  seed ${r.seed}: ${r.status}, ${fmt(r.nodes)} nodes`);
}
if (proven.length >= 4) {
    const quarter = Math.floor(proven.length / 4);
    const labels = ["Q1 (fastest)", "Q2", "Q3", "Q4 (slowest)"];
    for (let q = 0; q < 4; q++) {
        const slice = proven.slice(q * quarter, q === 3 ? proven.length : (q + 1) * quarter);
        console.log(`${labels[q]}  cases ${q * quarter + 1}-${q === 3 ? proven.length : (q + 1) * quarter}` +
            `  ${fmt(slice[0].nodes)} – ${fmt(slice[slice.length - 1].nodes)}`);
    }
    const total = proven.reduce((sum, r) => sum + r.nodes, 0);
    console.log(`median ${fmt(proven[Math.floor(proven.length / 2)].nodes)}, ` +
        `mean ${fmt(total / proven.length)}, total ${fmt(total)}`);
}
console.log(`results: ${outPath}`);
