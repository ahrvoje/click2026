/**
 * Real-browser repro of the reported game: load the user's URL, step forward
 * through the trouble region like a player, and watch for the stuck
 * "analyzing…" state, console errors, and page crashes.
 *
 * Usage: node repro-e2e.mjs [--to=36] [--dwell=800] [--watch=45000] [--headed]
 */
import puppeteer from "puppeteer-core";
import { existsSync } from "node:fs";

const option = (name, fallback) =>
    process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const TO = Number(option("to", "36"));
const DWELL = Number(option("dwell", "800"));
const WATCH = Number(option("watch", "45000"));
const HEADED = process.argv.includes("--headed");

const CANDIDATES = [
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
];
const executablePath = CANDIDATES.find(existsSync);
if (!executablePath) { console.error("no Chrome/Edge found"); process.exit(1); }

const G = "BAZwT0op9oCPwv4fbUBlYhZNTLWoMWUVqEQ8xKfnQsn3x4PKt47JGRdYDfb6UbTL78wRXbK8Ws6c3aUfBy92vL5lL6nUN0JIAC_VXHlrdmh--gARN2eDLsX1C2iWvN8_4mQd4herw4VwH-K-epPKFuset0BPnhyIPfzp4qR0uxH42GI5";
const url = `http://localhost:8000/src/index.html?v=5&g=${G}`;

const t0 = Date.now();
const ts = () => ((Date.now() - t0) / 1000).toFixed(1).padStart(6);

const browser = await puppeteer.launch({
    executablePath,
    headless: HEADED ? false : "new",
    protocolTimeout: 180000,
    args: ["--enable-unsafe-webgpu", "--enable-features=Vulkan", "--no-sandbox"],
});

let crashed = false;
try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1300, height: 900 });
    page.on("console", (msg) => {
        if (["error", "warning"].includes(msg.type())) {
            console.log(`${ts()}s [console.${msg.type()}] ${msg.text().slice(0, 400)}`);
        }
    });
    page.on("pageerror", (e) => console.log(`${ts()}s [pageerror] ${String(e).slice(0, 400)}`));
    page.on("error", (e) => { crashed = true; console.log(`${ts()}s [PAGE CRASHED] ${e}`); });

    await page.goto(url, { waitUntil: "networkidle0" });
    console.log(`${ts()}s loaded`);

    // engine on (analysis is on by default; normalize to on)
    if (!await page.$eval("#engineButton", (b) => b.classList.contains("active"))) {
        await page.click("#engineButton");
    }

    const snap = () => page.evaluate(() => ({
        move: document.getElementById("moveValue")?.textContent,
        status: document.getElementById("engineStatus")?.textContent?.slice(0, 140),
        rows: document.querySelectorAll("#engineList .engineRow").length,
        scores: [...document.querySelectorAll("#engineList .engineScore")]
            .slice(0, 6).map((e) => e.textContent),
        exact: [...document.querySelectorAll("#engineList .engineExact")]
            .filter((e) => e.textContent === "✓").length,
    })).catch((e) => ({ error: String(e).slice(0, 120) }));

    // step forward through the game like a player
    for (let move = 1; move <= TO; move++) {
        await page.evaluate(() => {
            document.getElementById("gameCanvas").dispatchEvent(
                new WheelEvent("wheel", { deltaY: 100, bubbles: true, cancelable: true }));
        }).catch(() => { crashed = true; });
        if (crashed) break;
        await new Promise((r) => setTimeout(r, DWELL));
        const s = await snap();
        console.log(`${ts()}s move=${s.move} rows=${s.rows} exact=${s.exact} scores=${JSON.stringify(s.scores)} status=${JSON.stringify(s.status)}`);
    }

    // dwell on the final position and watch
    console.log(`${ts()}s watching final position for ${WATCH / 1000}s...`);
    let lastSig = "";
    let stuckSince = Date.now();
    const deadline = Date.now() + WATCH;
    while (Date.now() < deadline && !crashed) {
        await new Promise((r) => setTimeout(r, 3000));
        const s = await snap();
        const sig = JSON.stringify(s);
        if (sig !== lastSig) { lastSig = sig; stuckSince = Date.now(); }
        console.log(`${ts()}s rows=${s.rows} exact=${s.exact} scores=${JSON.stringify(s.scores)} status=${JSON.stringify(s.status)}` +
            (Date.now() - stuckSince > 12000 ? "  *** UNCHANGED 12s+" : ""));
        if (/proven|settled/.test(s.status ?? "")) break;
    }

    // NEW GAME must reset the engine display — regression probe for the report
    if (!crashed) {
        await page.click("#startButton").catch(() => {});
        await new Promise((r) => setTimeout(r, 4000));
        const s = await snap();
        console.log(`${ts()}s after NEW GAME: rows=${s.rows} status=${JSON.stringify(s.status)}`);
        if (s.rows === 0) console.log(`${ts()}s *** NEW GAME left the engine with no rows (stuck?)`);
    }
} finally {
    await browser.close().catch(() => {});
}
console.log(`${ts()}s done crashed=${crashed}`);
