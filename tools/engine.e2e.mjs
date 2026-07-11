/**
 * Click2026 — end-to-end engine check (development tool).
 *
 * Drives the served game in headless Chrome/Edge: toggles the engine on,
 * waits for analysis rows, plays a suggested move on the canvas, verifies the
 * engine re-analyzes the new position, and screenshots the result.
 *
 * Usage: node tools/engine.e2e.mjs   (expects `npm run serve` on port 8123)
 *
 * Copyright 2014-2026, Hrvoje Abraham ahrvoje@gmail.com
 * Released under the MIT license.
 */

import puppeteer from "puppeteer-core";
import { existsSync } from "node:fs";

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

const shot = process.argv.includes("--shot");
let failures = 0;
const check = (ok, title, detail) => {
    console.log(`${ok ? "ok  " : "FAIL"}  ${title}${detail ? "  " + JSON.stringify(detail) : ""}`);
    if (!ok) failures++;
};

const browser = await puppeteer.launch({
    executablePath,
    headless: "new",
    args: ["--enable-unsafe-webgpu", "--enable-features=Vulkan", "--no-sandbox"],
});

try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1200, height: 800 });

    const consoleErrors = [];
    page.on("console", (msg) => { if (msg.type() === "error") consoleErrors.push(msg.text()); });
    page.on("pageerror", (error) => consoleErrors.push(String(error)));

    await page.goto("http://localhost:8123/", { waitUntil: "networkidle0" });
    check(await page.$("#gameCanvas") !== null, "game loads");

    // a fresh page has no position until NEW GAME generates one
    await page.click("#startButton");

    // toggle the engine on
    await page.click("#engineButton");
    check(await page.$eval("#engineButton", (b) => b.classList.contains("active")), "engine button toggles active");
    check(await page.$eval("#engineSection", (s) => !s.hidden), "engine panel appears");

    // wait for analysis rows of the start position
    await page.waitForFunction(() => document.querySelectorAll("#engineList .engineRow").length >= 3, { timeout: 20000 });
    const rows1 = await page.$$eval("#engineList .engineRow", (rows) => rows.map((r) => r.textContent.trim()));
    check(rows1.length >= 3 && rows1.length <= 5, "top move list renders", { rows: rows1 });

    const status1 = await page.$eval("#engineStatus", (s) => s.textContent);
    check(/w\d+ d\d+/.test(status1) && /n\/s/.test(status1), "stats line looks like an engine", { status1 });
    check(/CPU/.test(status1), "compute backend reported", { backend: status1.match(/CPU[^ ]*( \(GPU failed\))?$/)?.[0] });

    // scores must be sorted ascending (best first)
    const scores1 = await page.$$eval("#engineList .engineScore", (els) => els.map((e) => parseInt(e.textContent, 10)));
    check(scores1.every((s, i) => i === 0 || scores1[i - 1] <= s), "scores sorted best-first", { scores1 });

    // play the engine's #1 suggestion by clicking its group cell on the canvas
    const target = await page.evaluate(async () => {
        // reach into the module graph via a dynamic import of the same URL
        const { EngineUI } = await import("/scripts/engine-ui.js");
        return EngineUI.isOn();
    });
    check(target === true, "EngineUI singleton shared with page modules");

    // read the suggested cell from the worker result through the DOM: use the
    // canvas click path instead — click the center of the first row's group
    // via its outline color is complex; simpler: pick any legal group cell by
    // scanning the canvas is overkill — instead replay through the page's own
    // game module:
    const clicked = await page.evaluate(() => {
        return new Promise((resolve) => {
            const canvas = document.getElementById("gameCanvas");
            const rect = canvas.getBoundingClientRect();
            // click cell (0, 11): canvas x = 25*0+6+11 (inside block), y for row j=11
            // pick a clickable cell by probing the shown board through a test click
            // event at successive columns of the bottom row until the move counter changes
            const before = document.getElementById("moveValue").textContent;
            let i = 0;
            const tryClick = () => {
                if (i >= 12) { resolve(false); return; }
                const x = rect.left + 5 + 25 * i + 12;
                const y = rect.top + 5 + 25 * (11 - 0) + 12; // board row j=0 is at the bottom
                canvas.dispatchEvent(new MouseEvent("mousedown", { clientX: x, clientY: y, bubbles: true }));
                setTimeout(() => {
                    if (document.getElementById("moveValue").textContent !== before) resolve(true);
                    else { i++; tryClick(); }
                }, 60);
            };
            tryClick();
        });
    });
    check(clicked, "a move can be played while the engine runs");

    // the engine must pick up the new position and produce fresh rows
    await page.waitForFunction(() => {
        const status = document.getElementById("engineStatus").textContent;
        return document.querySelectorAll("#engineList .engineRow").length > 0 && /w\d+/.test(status);
    }, { timeout: 20000 });
    const scores2 = await page.$$eval("#engineList .engineScore", (els) => els.map((e) => e.textContent));
    check(scores2.length > 0, "engine re-analyzes after the player's move", { scores2 });

    // canvas overlays: rank colors must actually be painted on the canvas
    const overlayPixels = await page.evaluate(() => {
        const ctx = document.getElementById("gameCanvas").getContext("2d");
        const img = ctx.getImageData(0, 0, 310, 310).data;
        const counts = { white: 0, orange: 0 };
        for (let p = 0; p < img.length; p += 4) {
            const [r, g, b] = [img[p], img[p + 1], img[p + 2]];
            if (r > 240 && g > 240 && b > 240) counts.white++;
            if (r > 240 && g > 130 && g < 190 && b < 80) counts.orange++;
        }
        return counts;
    });
    check(overlayPixels.white > 20, "rank-1 outline painted on board", overlayPixels);

    // clicking a suggestion row plays that move; the warm-start cache must
    // carry the known line over, so the new best is never worse than the
    // clicked move's score — even on the very first posted result
    await page.waitForFunction(() => document.querySelectorAll("#engineList .engineRow").length >= 1, { timeout: 20000 });
    const beforeClick = await page.evaluate(() => ({
        move: document.getElementById("moveValue").textContent,
        score: parseInt(document.querySelector("#engineList .engineScore").textContent, 10),
    }));
    // atomic in-page click: the list may re-render between resolving a handle
    // and puppeteer's multi-step click sequence
    await page.evaluate(() =>
        document.querySelector("#engineList .engineRow")
            .dispatchEvent(new MouseEvent("click", { bubbles: true })));
    await new Promise((r) => setTimeout(r, 400));
    const afterClick = await page.evaluate(() => ({
        move: document.getElementById("moveValue").textContent,
        score: parseInt(document.querySelector("#engineList .engineScore")?.textContent ?? "9999", 10),
    }));
    check(afterClick.move !== beforeClick.move, "row click plays the move", { beforeClick, afterClick });
    check(afterClick.score <= beforeClick.score, "warm start keeps the known line", { beforeClick, afterClick });

    // telemetry line: five fixed columns on a single line
    const statusShape = await page.$eval("#engineStatus", (s) => ({
        columns: s.querySelectorAll("span").length,
        height: s.clientHeight,
    }));
    check(statusShape.columns === 5 && statusShape.height < 26, "status line fixed and unwrapped", statusShape);

    // continuous analysis: on a full board (no proofs possible) the engine
    // must keep working indefinitely — nodes strictly increasing, no idle-out
    const nodesOf = async () => page.$eval("#engineStatus .engineStNodes", (s) => {
        const m = s.textContent.match(/([\d.]+)([Mk]?)/);
        return m ? parseFloat(m[1]) * (m[2] === "M" ? 1e6 : m[2] === "k" ? 1e3 : 1) : -1;
    });
    await new Promise((r) => setTimeout(r, 6000));
    const nodesA = await nodesOf();
    await new Promise((r) => setTimeout(r, 6000));
    const nodesB = await nodesOf();
    const statusB = await page.$eval("#engineStatus", (s) => s.textContent);
    check(nodesB > nodesA && nodesA > 0, "analysis keeps running (nodes increasing)", { nodesA, nodesB });
    check(/analyzing…/.test(statusB), "status stays analyzing on a large board", { statusB });

    // toggle off cleans up
    await page.click("#engineButton");
    check(await page.$eval("#engineSection", (s) => s.hidden), "engine panel hides on toggle-off");

    // endgame proving: rewind a recorded game to 10 moves before its end —
    // 32 remaining cells, the size class that used to cycle under the old
    // 32-cell gate; the value solver must prove every move and report complete
    const example = "?position=544341454153245551352111315534254113553554342242333515335513533415541542" +
        "111541422113121311534345113215252332331311244443442542241513343551454125" +
        "&moves=65,54,21,43,31,42,30,29,17,15,13,13,37,24,25,24,14,13,14,26,26,38,38,54,66,78,89,88,88," +
        "77,87,87,73,84,60,37,36,12,1,0,12" +
        "&times=533,929,374,344,492,642,406,218,320,236,178,414,344,266,344,352,484,586,188,264,258," +
        "430,1242,336,679,611,217,455,358,321,171,524,273,235,905,180,406,414,156,320";
    await page.goto("http://localhost:8123/" + example, { waitUntil: "networkidle0" });
    await page.click("#forwardButton");
    await page.evaluate(() => {
        const canvas = document.getElementById("gameCanvas");
        for (let i = 0; i < 10; i++) {
            canvas.dispatchEvent(new WheelEvent("wheel", { deltaY: -100, bubbles: true, cancelable: true }));
        }
    });
    await page.click("#engineButton");
    await page.waitForFunction(
        () => /proven ✓/.test(document.getElementById("engineStatus").textContent),
        { timeout: 90000 });
    const proven = await page.$$eval("#engineList .engineExact", (els) => els.map((e) => e.textContent));
    check(proven.length > 0 && proven.every((t) => t === "✓"), "endgame rows all proven", { proven });
    await page.click("#engineButton");

    if (shot) {
        await page.click("#engineButton");
        await page.waitForFunction(() => document.querySelectorAll("#engineList .engineRow").length >= 1, { timeout: 20000 });
        await new Promise((r) => setTimeout(r, 2500));
        await page.screenshot({ path: process.env.SHOT_PATH ?? "engine-e2e.png" });
        console.log("      screenshot written");
    }

    const relevantErrors = consoleErrors.filter((e) => !/favicon/.test(e));
    check(relevantErrors.length === 0, "no console errors", relevantErrors.length ? { relevantErrors } : undefined);

    // report the GPU state the worker actually reached
    console.log("      status line:", await page.$eval("#engineStatus", (s) => s.textContent).catch(() => "-"));
} finally {
    await browser.close();
}

console.log(failures === 0 ? "\nE2E passed." : `\n${failures} E2E FAILURES`);
process.exit(failures === 0 ? 0 : 1);
