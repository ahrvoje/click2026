/** Identify which worker<->main message types flood during the wedge. */
import puppeteer from "puppeteer-core";
import { existsSync } from "node:fs";

const CANDIDATES = [
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
];
const executablePath = CANDIDATES.find(existsSync);
const G = "BAZwT0op9oCPwv4fbUBlYhZNTLWoMWUVqEQ8xKfnQsn3x4PKt47JGRdYDfb6UbTL78wRXbK8Ws6c3aUfBy92vL5lL6nUN0JIAC_VXHlrdmh--gARN2eDLsX1C2iWvN8_4mQd4herw4VwH-K-epPKFuset0BPnhyIPfzp4qR0uxH42GI5";
const url = `http://localhost:8000/src/index.html?v=5&g=${G}&cb=flood2`;
const t0 = Date.now();
const ts = () => ((Date.now() - t0) / 1000).toFixed(1).padStart(6);

const browser = await puppeteer.launch({
    executablePath, headless: "new", protocolTimeout: 240000,
    args: ["--enable-unsafe-webgpu", "--enable-features=Vulkan", "--no-sandbox"],
});
try {
    const page = await browser.newPage();
    page.on("console", (msg) => {
        const text = msg.text();
        if (msg.type() === "error" || text.startsWith("MSGSTATS")) console.log(`${ts()}s ${text.slice(0, 400)}`);
    });
    page.on("pageerror", (e) => console.log(`${ts()}s [pageerror] ${String(e).slice(0, 200)}`));

    await page.evaluateOnNewDocument(() => {
        const inbound = {};   // worker -> main, by type
        const outbound = {};  // main -> worker, by type
        let inboundTotal = 0;
        const report = () => {
            console.log(`MSGSTATS in=${JSON.stringify(inbound)} out=${JSON.stringify(outbound)}`);
        };
        const RealWorker = window.Worker;
        window.Worker = class extends RealWorker {
            constructor(url, opts) {
                super(url, opts);
                this.addEventListener("message", (event) => {
                    const type = event.data?.type ?? "?";
                    inbound[type] = (inbound[type] ?? 0) + 1;
                    if (++inboundTotal % 5000 === 0) report();
                });
            }
            postMessage(...args) {
                const type = args[0]?.type ?? "?";
                outbound[type] = (outbound[type] ?? 0) + 1;
                super.postMessage(...args);
            }
        };
        // also try a timer report — will only fire while the thread still yields
        setInterval(report, 2000);
    });

    await page.goto(url, { waitUntil: "networkidle0", timeout: 60000 });
    console.log(`${ts()}s loaded`);
    // concurrent fast scrub; don't await — the thread may wedge mid-way
    page.evaluate(async () => {
        const canvas = document.getElementById("gameCanvas");
        for (let i = 0; i < 36; i++) {
            canvas.dispatchEvent(new WheelEvent("wheel", { deltaY: 100, bubbles: true, cancelable: true }));
            await new Promise((r) => setTimeout(r, 150));
        }
    }).then(() => console.log(`${ts()}s scrub complete`))
        .catch((e) => console.log(`${ts()}s scrub aborted: ${String(e).slice(0, 100)}`));

    await new Promise((r) => setTimeout(r, 90000));
} finally {
    await browser.close().catch(() => {});
}
console.log(`${ts()}s done`);
