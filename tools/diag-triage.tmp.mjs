/** Triage the main-thread wedge: which lane/GPU config reproduces it?
 *  Keeps the valid v=5 game link; cache-busts via a harmless "cb" param. */
import puppeteer from "puppeteer-core";
import { existsSync } from "node:fs";

const CANDIDATES = [
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
];
const executablePath = CANDIDATES.find(existsSync);
const G = "BAZwT0op9oCPwv4fbUBlYhZNTLWoMWUVqEQ8xKfnQsn3x4PKt47JGRdYDfb6UbTL78wRXbK8Ws6c3aUfBy92vL5lL6nUN0JIAC_VXHlrdmh--gARN2eDLsX1C2iWvN8_4mQd4herw4VwH-K-epPKFuset0BPnhyIPfzp4qR0uxH42GI5";
const base = (cb, extra = "") => `http://localhost:8000/src/index.html?v=5&g=${G}&cb=${cb}${extra}`;
const t0 = Date.now();
const ts = () => ((Date.now() - t0) / 1000).toFixed(1).padStart(6);

const CONFIGS = [
    { name: "16 lanes + webgpu", url: base(1), gpuArgs: true },
    { name: "16 lanes no webgpu", url: base(2), gpuArgs: false },
    { name: "4 lanes + webgpu", url: base(3, "&engineWorkers=4"), gpuArgs: true },
    { name: "1 lane + webgpu", url: base(4, "&engineWorkers=1"), gpuArgs: true },
];

const wheelSource = async (dir, n, delay) => {
    const canvas = document.getElementById("gameCanvas");
    for (let i = 0; i < n; i++) {
        canvas.dispatchEvent(new WheelEvent("wheel", { deltaY: dir * 100, bubbles: true, cancelable: true }));
        await new Promise((r) => setTimeout(r, delay));
    }
};

for (const config of CONFIGS) {
    const args = ["--no-sandbox"];
    if (config.gpuArgs) args.push("--enable-unsafe-webgpu", "--enable-features=Vulkan");
    const browser = await puppeteer.launch({ executablePath, headless: "new", protocolTimeout: 120000, args });
    const tag = (m) => console.log(`${ts()}s [${config.name}] ${m}`);
    try {
        const page = await browser.newPage();
        page.on("dialog", (d) => { tag(`DIALOG: ${d.message().slice(0, 80)}`); d.dismiss().catch(() => {}); });
        page.on("pageerror", (e) => tag(`pageerror: ${String(e).slice(0, 200)}`));
        page.on("console", (msg) => {
            if (msg.type() === "error") tag(`console.error: ${msg.text().slice(0, 200)}`);
        });
        const loaded = await Promise.race([
            page.goto(config.url, { waitUntil: "networkidle0", timeout: 45000 }).then(() => true).catch((e) => { tag(`goto: ${String(e).slice(0, 100)}`); return false; }),
            new Promise((r) => setTimeout(() => r(false), 46000)),
        ]);
        if (!loaded) { tag("did not reach networkidle0"); continue; }
        tag("loaded");

        // probe responsiveness with an independent 5s deadline at each step
        const probe = async (label) => {
            const alive = await Promise.race([
                page.evaluate(() => ({
                    rows: document.querySelectorAll("#engineList .engineRow").length,
                    status: document.getElementById("engineStatus")?.textContent?.slice(0, 45) ?? "",
                })).catch(() => null),
                new Promise((r) => setTimeout(() => r(null), 5000)),
            ]);
            tag(`${label}: ${alive ? `rows=${alive.rows} status=${JSON.stringify(alive.status)}` : "MAIN THREAD WEDGED"}`);
            return alive !== null;
        };

        if (!await probe("t=0")) continue;
        // fast scrub forward like rapid manual play
        const scrubbed = await Promise.race([
            page.evaluate(wheelSource, 1, 36, 150).then(() => true).catch(() => false),
            new Promise((r) => setTimeout(() => r(false), 25000)),
        ]);
        tag(scrubbed ? "scrub complete" : "scrub WEDGED/timed out");
        let ok = true;
        for (let i = 0; i < 6 && ok; i++) {
            await new Promise((r) => setTimeout(r, 3000));
            ok = await probe(`t=+${(i + 1) * 3}s`);
        }
    } finally {
        await browser.close().catch(() => {});
    }
}
console.log(`${ts()}s triage done`);
