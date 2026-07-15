/** Stress repro: rapid navigation across the trouble region, many cycles.
 *  Instruments Worker construction (pool restarts) and worker error posts. */
import puppeteer from "puppeteer-core";
import { existsSync } from "node:fs";

const CANDIDATES = [
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
];
const executablePath = CANDIDATES.find(existsSync);
const option = (name, fallback) =>
    process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const CYCLES = Number(option("cycles", "6"));
const LOWPOWER = process.argv.includes("--lowpower");

const G = "BAZwT0op9oCPwv4fbUBlYhZNTLWoMWUVqEQ8xKfnQsn3x4PKt47JGRdYDfb6UbTL78wRXbK8Ws6c3aUfBy92vL5lL6nUN0JIAC_VXHlrdmh--gARN2eDLsX1C2iWvN8_4mQd4herw4VwH-K-epPKFuset0BPnhyIPfzp4qR0uxH42GI5";
const url = `http://localhost:8000/src/index.html?v=5&g=${G}`;
const t0 = Date.now();
const ts = () => ((Date.now() - t0) / 1000).toFixed(1).padStart(6);

const args = ["--enable-unsafe-webgpu", "--enable-features=Vulkan", "--no-sandbox"];
if (LOWPOWER) args.push("--use-webgpu-power-preference=force-low-power");
const browser = await puppeteer.launch({ executablePath, headless: "new", protocolTimeout: 240000, args });

let crashed = false;
let anomalies = 0;
try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1300, height: 900 });
    page.on("console", (msg) => {
        const text = msg.text();
        if (msg.type() === "error" || /WORKER-SPAWN|WORKER-ERR/.test(text)) {
            console.log(`${ts()}s [${msg.type()}] ${text.slice(0, 300)}`);
        }
    });
    page.on("pageerror", (e) => console.log(`${ts()}s [pageerror] ${String(e).slice(0, 300)}`));
    page.on("error", (e) => { crashed = true; console.log(`${ts()}s [PAGE CRASHED] ${e}`); });

    await page.evaluateOnNewDocument(() => {
        const RealWorker = window.Worker;
        let spawnCount = 0;
        window.Worker = class extends RealWorker {
            constructor(url, opts) {
                super(url, opts);
                spawnCount++;
                console.log(`WORKER-SPAWN #${spawnCount} ${opts?.name ?? ""}`);
                this.addEventListener("message", (event) => {
                    if (event.data?.type === "error") {
                        console.log(`WORKER-ERR ${opts?.name ?? ""}: ${String(event.data.message).split("\n").slice(0, 3).join(" | ").slice(0, 400)}`);
                    }
                });
                this.addEventListener("error", (event) => {
                    console.log(`WORKER-ERR(event) ${opts?.name ?? ""}: ${event.message ?? event}`);
                });
            }
        };
    });

    await page.goto(url, { waitUntil: "networkidle0" });
    if (!await page.$eval("#engineButton", (b) => b.classList.contains("active"))) {
        await page.click("#engineButton");
    }

    const snap = () => page.evaluate(() => ({
        move: document.getElementById("moveValue")?.textContent,
        status: document.getElementById("engineStatus")?.textContent?.slice(0, 60),
        rows: document.querySelectorAll("#engineList .engineRow").length,
    })).catch((e) => ({ error: String(e).slice(0, 80) }));

    const wheel = (dir, n, delay) => page.evaluate(async (dir, n, delay) => {
        const canvas = document.getElementById("gameCanvas");
        for (let i = 0; i < n; i++) {
            canvas.dispatchEvent(new WheelEvent("wheel", { deltaY: dir * 100, bubbles: true, cancelable: true }));
            await new Promise((r) => setTimeout(r, delay));
        }
    }, dir, n, delay);

    for (let cycle = 1; cycle <= CYCLES && !crashed; cycle++) {
        // fast forward to 36, quick rewind to 28, forward again — player-like scrubbing
        await wheel(1, 36, 180);
        await new Promise((r) => setTimeout(r, 1500));
        await wheel(-1, 8, 120);
        await new Promise((r) => setTimeout(r, 1500));
        await wheel(1, 8, 250);

        // watch the final position; anomaly = analyzing with no rows for >6s
        let noRowsSince = null;
        for (let watch = 0; watch < 10 && !crashed; watch++) {
            await new Promise((r) => setTimeout(r, 1000));
            const s = await snap();
            const bad = s.rows === 0 && /analyzing/.test(s.status ?? "");
            if (bad && noRowsSince === null) noRowsSince = Date.now();
            if (!bad) noRowsSince = null;
            if (noRowsSince && Date.now() - noRowsSince > 6000) {
                anomalies++;
                console.log(`${ts()}s *** ANOMALY cycle ${cycle}: stuck analyzing with no rows: ${JSON.stringify(s)}`);
                break;
            }
        }
        const end = await snap();
        console.log(`${ts()}s cycle ${cycle}: move=${end.move} rows=${end.rows} status=${JSON.stringify(end.status)}`);

        // reset for next cycle via rewind to 0
        await wheel(-1, 40, 60);
        await new Promise((r) => setTimeout(r, 800));
    }
} finally {
    await browser.close().catch(() => {});
}
console.log(`${ts()}s done crashed=${crashed} anomalies=${anomalies}`);
