/** Diagnose main-thread wedge: load page, probe responsiveness, and when
 *  wedged use CDP Debugger.pause to capture the exact executing stack. */
import puppeteer from "puppeteer-core";
import { existsSync } from "node:fs";

const CANDIDATES = [
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
];
const executablePath = CANDIDATES.find(existsSync);

const G = "BAZwT0op9oCPwv4fbUBlYhZNTLWoMWUVqEQ8xKfnQsn3x4PKt47JGRdYDfb6UbTL78wRXbK8Ws6c3aUfBy92vL5lL6nUN0JIAC_VXHlrdmh--gARN2eDLsX1C2iWvN8_4mQd4herw4VwH-K-epPKFuset0BPnhyIPfzp4qR0uxH42GI5";
const url = `http://localhost:8000/src/index.html?v=5&g=${G}&cb=wedge1`;
const t0 = Date.now();
const ts = () => ((Date.now() - t0) / 1000).toFixed(1).padStart(6);

const browser = await puppeteer.launch({
    executablePath, headless: "new", protocolTimeout: 600000,
    args: ["--enable-unsafe-webgpu", "--enable-features=Vulkan", "--no-sandbox"],
});
try {
    const page = await browser.newPage();
    page.on("console", (msg) => {
        if (msg.type() === "error") console.log(`${ts()}s [console.error] ${msg.text().slice(0, 300)}`);
    });
    page.on("pageerror", (e) => console.log(`${ts()}s [pageerror] ${String(e).slice(0, 300)}`));

    const client = await page.createCDPSession();
    await client.send("Debugger.enable");

    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 120000 });
    console.log(`${ts()}s loaded`);

    // fast player-like scrubbing: forward through the game with short pauses
    const wheel = (dir, n, delay) => page.evaluate(async (dir, n, delay) => {
        const canvas = document.getElementById("gameCanvas");
        for (let i = 0; i < n; i++) {
            canvas.dispatchEvent(new WheelEvent("wheel", { deltaY: dir * 100, bubbles: true, cancelable: true }));
            await new Promise((r) => setTimeout(r, delay));
        }
    }, dir, n, delay);
    const scrub = Promise.race([
        (async () => {
            await wheel(1, 36, 150);
            await wheel(-1, 8, 100);
            await wheel(1, 8, 200);
            console.log(`${ts()}s scrub complete`);
        })().catch((e) => console.log(`${ts()}s scrub failed: ${String(e).slice(0, 120)}`)),
        new Promise((r) => setTimeout(r, 30000)),
    ]);

    const probe = async (label) => {
        const alive = await Promise.race([
            page.evaluate(() => 1).then(() => true).catch(() => false),
            new Promise((r) => setTimeout(() => r(false), 3000)),
        ]);
        console.log(`${ts()}s probe(${label}): main thread ${alive ? "responsive" : "WEDGED"}`);
        return alive;
    };

    let wedged = false;
    for (let i = 0; i < 40; i++) {
        await new Promise((r) => setTimeout(r, 2000));
        if (!(await probe(`t+${i * 2}s`))) { wedged = true; break; }
    }

    if (wedged) {
        const paused = new Promise((resolve) => client.once("Debugger.paused", resolve));
        await client.send("Debugger.pause");
        const event = await Promise.race([paused, new Promise((r) => setTimeout(() => r(null), 15000))]);
        if (!event) {
            console.log(`${ts()}s Debugger.pause never fired — thread stuck in native/wasm or a single JS task that ignores interrupts`);
        } else {
            console.log(`${ts()}s PAUSED, reason=${event.reason}; stack:`);
            for (const frame of event.callFrames.slice(0, 25)) {
                console.log(`   at ${frame.functionName || "(anon)"} ${frame.url.split("/").pop()}:${frame.location.lineNumber + 1}`);
            }
            await client.send("Debugger.resume").catch(() => {});
        }
    }
} finally {
    await browser.close().catch(() => {});
}
console.log(`${ts()}s done`);
