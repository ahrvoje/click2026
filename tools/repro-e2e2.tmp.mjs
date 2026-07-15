/** Long-task instrumented repro: where does the main thread stall? */
import puppeteer from "puppeteer-core";
import { existsSync } from "node:fs";

const CANDIDATES = [
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
];
const executablePath = CANDIDATES.find(existsSync);
const option = (name, fallback) =>
    process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const WORKERS = option("workers", "");
const DWELL = Number(option("dwell", "1500"));

const G = "BAZwT0op9oCPwv4fbUBlYhZNTLWoMWUVqEQ8xKfnQsn3x4PKt47JGRdYDfb6UbTL78wRXbK8Ws6c3aUfBy92vL5lL6nUN0JIAC_VXHlrdmh--gARN2eDLsX1C2iWvN8_4mQd4herw4VwH-K-epPKFuset0BPnhyIPfzp4qR0uxH42GI5";
const url = `http://localhost:8000/src/index.html?v=5&g=${G}` + (WORKERS ? `&engineWorkers=${WORKERS}` : "");
const t0 = Date.now();
const ts = () => ((Date.now() - t0) / 1000).toFixed(1).padStart(6);

const browser = await puppeteer.launch({
    executablePath, headless: "new", protocolTimeout: 240000,
    args: ["--enable-unsafe-webgpu", "--enable-features=Vulkan", "--no-sandbox"],
});
try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1300, height: 900 });
    page.on("console", (msg) => {
        if (msg.type() === "error") console.log(`${ts()}s [console.error] ${msg.text().slice(0, 300)}`);
    });
    page.on("error", (e) => console.log(`${ts()}s [PAGE CRASHED] ${e}`));

    await page.evaluateOnNewDocument(() => {
        window.__longTasks = [];
        window.__statusLog = [];
        new PerformanceObserver((list) => {
            for (const entry of list.getEntries()) {
                window.__longTasks.push({ start: Math.round(entry.startTime), dur: Math.round(entry.duration) });
            }
        }).observe({ entryTypes: ["longtask"] });
        // sample engine status twice a second from a timer; gaps in samples
        // reveal main-thread stalls even while remote evaluate is blocked
        setInterval(() => {
            const status = document.getElementById("engineStatus")?.textContent ?? "";
            const move = document.getElementById("moveValue")?.textContent ?? "";
            window.__statusLog.push({ t: Math.round(performance.now()), move, s: status.slice(0, 60) });
        }, 500);
    });

    await page.goto(url, { waitUntil: "networkidle0" });
    if (!await page.$eval("#engineButton", (b) => b.classList.contains("active"))) {
        await page.click("#engineButton");
    }

    for (let move = 1; move <= 36; move++) {
        await page.evaluate(() => {
            document.getElementById("gameCanvas").dispatchEvent(
                new WheelEvent("wheel", { deltaY: 100, bubbles: true, cancelable: true }));
        });
        await new Promise((r) => setTimeout(r, move >= 27 ? DWELL : 400));
    }
    await new Promise((r) => setTimeout(r, 20000));

    const data = await page.evaluate(() => ({
        longTasks: window.__longTasks,
        gaps: (() => {
            const log = window.__statusLog;
            const gaps = [];
            for (let i = 1; i < log.length; i++) {
                if (log[i].t - log[i - 1].t > 1200) {
                    gaps.push({ from: log[i - 1], to: log[i], gapMs: log[i].t - log[i - 1].t });
                }
            }
            return gaps;
        })(),
        tail: window.__statusLog.slice(-8),
    }));
    const big = data.longTasks.filter((t) => t.dur > 200);
    console.log(`long tasks >200ms: ${big.length}`);
    for (const t of big.slice(0, 40)) console.log(`  at ${(t.start / 1000).toFixed(1)}s dur ${t.dur}ms`);
    console.log(`status sampling gaps >1.2s: ${data.gaps.length}`);
    for (const gap of data.gaps.slice(0, 30)) {
        console.log(`  ${(gap.from.t / 1000).toFixed(1)}s -> ${(gap.to.t / 1000).toFixed(1)}s (${gap.gapMs}ms) at move ${gap.to.move} status ${JSON.stringify(gap.to.s)}`);
    }
    console.log("tail:", JSON.stringify(data.tail, null, 1).slice(0, 1200));
} finally {
    await browser.close().catch(() => {});
}
