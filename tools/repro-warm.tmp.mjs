/**
 * Warm-start invariant repro: the position after the final branch's move 26
 * (CB) must prove at least as fast when reached by sequential play as when
 * the link is loaded and the position selected directly.
 *
 * Usage: node tools/repro-warm.tmp.mjs [fresh|played] [--dwell=3000] [--watch=90000] [--headed]
 */
import puppeteer from "puppeteer-core";
import { existsSync } from "node:fs";
import { Serializer } from "../src/scripts/serial.js";

const MODE = process.argv[2] ?? "played";
const option = (name, fallback) =>
    process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const DWELL = Number(option("dwell", "3000"));
const WATCH = Number(option("watch", "90000"));
const HEADED = process.argv.includes("--headed");

// original link; make the final branch the main line of a fresh v5 link
const G = "BVuawm6QANl15saOTJCVlpE4Zs1AuneUovSM4gfWxIvrYUVyjCkUECAtA10okFa0q0zOMfXjCAs96xrX_Z2g8v-Roo9WWfAO-FlcnChwBE_ewMtLQt0H91-Hqyc9eEazhTk6H9fL8PpxLqnCLtjczNBOoeXQXYxKc8qC_m_4rEX00Md46_wzV1jPlOEsDManx";
const game = Serializer.deserializeGame(`x?v=5&g=${G}`);
const branchesOf = (node, prefix, out) => {
    if (node.children.length === 0) { out.push(prefix); return; }
    for (const ch of node.children) branchesOf(ch, [...prefix, ch.move], out);
};
const all = [];
branchesOf(game.tree, [], all);
const branch = all[all.length - 1]; // 26 moves ending CB
// linear main-line-only tree from the branch
let chainRoot = { score: null, children: [] };
let at = chainRoot;
for (const move of branch) {
    const node = { move, score: null, children: [] };
    at.children = [node];
    at = node;
}
const serial = Serializer.serializeGameTree(game.p, chainRoot, []);
const url = `http://localhost:8000/src/index.html?${serial}`;
console.log("moves:", branch.length, "url length:", url.length);

const CANDIDATES = [
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
];
const executablePath = CANDIDATES.find(existsSync);
if (!executablePath) { console.error("no Chrome/Edge found"); process.exit(1); }

const t0 = Date.now();
const ts = () => ((Date.now() - t0) / 1000).toFixed(1).padStart(6);

const browser = await puppeteer.launch({
    executablePath,
    headless: HEADED ? false : "new",
    protocolTimeout: 240000,
    args: ["--enable-unsafe-webgpu", "--enable-features=Vulkan", "--no-sandbox"],
});

try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1300, height: 900 });
    page.on("console", (msg) => {
        const text = msg.text();
        if (text.includes("[diag") || ["error", "warning"].includes(msg.type())) {
            console.log(`${ts()}s ${text.slice(0, 300)}`);
        }
    });
    page.on("workercreated", (worker) => {
        // dedicated worker console messages do not always reach page "console"
        worker.on?.("console", (msg) => {
            const text = msg.text();
            if (text.includes("[diag")) console.log(`${ts()}s ${text.slice(0, 300)}`);
        });
    });
    page.on("pageerror", (e) => console.log(`${ts()}s [pageerror] ${String(e).slice(0, 300)}`));

    await page.goto(url, { waitUntil: "networkidle0" });
    console.log(`${ts()}s loaded`);
    if (!await page.$eval("#engineButton", (b) => b.classList.contains("active"))) {
        await page.click("#engineButton");
    }

    const snap = () => page.evaluate(() => ({
        move: document.getElementById("moveValue")?.textContent,
        status: document.getElementById("engineStatus")?.textContent?.replace(/\s+/g, " ").slice(0, 160),
        exact: [...document.querySelectorAll("#engineList .engineExact")]
            .filter((e) => e.textContent === "✓").length,
        scores: [...document.querySelectorAll("#engineList .engineScore")]
            .slice(0, 6).map((e) => e.textContent),
    })).catch((e) => ({ error: String(e).slice(0, 120) }));

    const step = () => page.evaluate(() => {
        document.getElementById("gameCanvas").dispatchEvent(
            new WheelEvent("wheel", { deltaY: 100, bubbles: true, cancelable: true }));
    });

    if (MODE === "played") {
        for (let move = 1; move <= branch.length; move++) {
            await step();
            await new Promise((r) => setTimeout(r, DWELL));
            const s = await snap();
            console.log(`${ts()}s move=${s.move} exact=${s.exact} scores=${JSON.stringify(s.scores)} status=${JSON.stringify(s.status)}`);
        }
    } else {
        // jump directly to the last move via repeated fast steps (no dwell —
        // equivalent to dragging the slider to the end)
        for (let move = 1; move <= branch.length; move++) await step();
        console.log(`${ts()}s jumped to end`);
    }

    console.log(`${ts()}s watching final position (${MODE}) for ${WATCH / 1000}s...`);
    const deadline = Date.now() + WATCH;
    const started = Date.now();
    for (;;) {
        const s = await snap();
        console.log(`${ts()}s exact=${s.exact} scores=${JSON.stringify(s.scores)} status=${JSON.stringify(s.status)}`);
        if (/optimal|proven|settled|stopped/.test(s.status ?? "")) {
            console.log(`${ts()}s TERMINAL after ${((Date.now() - started) / 1000).toFixed(1)}s: ${s.status}`);
            break;
        }
        if (Date.now() > deadline) { console.log(`${ts()}s *** STILL ANALYZING at watch timeout`); break; }
        await new Promise((r) => setTimeout(r, 3000));
    }
} finally {
    await browser.close().catch(() => {});
}
console.log(`${ts()}s done`);
