/**
 * Click2026 — end-to-end engine check (development tool).
 *
 * Drives the served game in headless Chrome/Edge: toggles the engine on,
 * waits for analysis rows, plays a suggested move on the canvas, verifies the
 * engine re-analyzes the new position, and screenshots the result.
 *
 * Usage: node tools/engine.e2e.mjs   (expects `npm run serve` on port 8123)
 * Override the origin with BASE_URL, for example http://localhost:8124.
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
const baseURL = (process.env.BASE_URL || "http://localhost:8123").replace(/\/$/, "");
const recursiveTimeoutMs = Number(process.env.RECURSIVE_TIMEOUT_MS || 90000);
const compactObservationMs = Number(process.env.COMPACT_OBSERVATION_MS || 15000);
let failures = 0;
const check = (ok, title, detail) => {
    console.log(`${ok ? "ok  " : "FAIL"}  ${title}${detail ? "  " + JSON.stringify(detail) : ""}`);
    if (!ok) failures++;
};

const browser = await puppeteer.launch({
    executablePath,
    headless: "new",
    protocolTimeout: 120000,
    args: ["--enable-unsafe-webgpu", "--enable-features=Vulkan", "--no-sandbox"],
});

try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1200, height: 800 });

    const consoleErrors = [];
    page.on("console", (msg) => { if (msg.type() === "error") consoleErrors.push(msg.text()); });
    page.on("pageerror", (error) => consoleErrors.push(String(error)));

    await page.goto(`${baseURL}/`, { waitUntil: "networkidle0" });
    await page.evaluate(() => localStorage.removeItem("click2026.settings.v1"));
    await page.reload({ waitUntil: "networkidle0" });
    check(await page.$("#gameCanvas") !== null, "game loads");
    check(await page.$eval("#movesSliderRow", (row) => row.hidden),
        "moves slider defaults off on desktop");
    check(await page.$eval("#settingsButton", (button) =>
        Boolean(button.compareDocumentPosition(document.getElementById("testsToggle")) & Node.DOCUMENT_POSITION_FOLLOWING)),
        "settings precedes examples and tests in the status bar");
    await page.click("#settingsButton");
    check(await page.$eval("#settingsDialog", (dialog) => dialog.open), "settings dialog opens");
    check(await page.$eval('input[name="suggestedMovesMode"][value="top5"]', (input) => input.checked),
        "top 5 is the default suggested-move mode");
    await page.click("#showMovesSlider");
    check(await page.$eval("#movesSliderRow", (row) => !row.hidden),
        "settings can show the moves slider on desktop");
    await page.click("#settingsDialog .settingsClose");

    // a fresh page has no position until NEW GAME generates one
    await page.click("#startButton");

    // The app currently starts analysis by default; keep the check valid if
    // that preference changes by normalizing to "on" instead of blindly
    // toggling the current state.
    if (!await page.$eval("#engineButton", (b) => b.classList.contains("active"))) {
        await page.click("#engineButton");
    }
    check(await page.$eval("#engineButton", (b) => b.classList.contains("active")), "engine button toggles active");
    check(await page.$eval("#engineSection", (s) => !s.hidden), "engine panel appears");

    // wait for analysis rows of the start position
    await page.waitForFunction(() => document.querySelectorAll("#engineList .engineRow").length >= 3, { timeout: 20000 });
    const rows1 = await page.$$eval("#engineList .engineRow", (rows) => rows.map((r) => r.textContent.trim()));
    check(rows1.length >= 3 && rows1.length <= 5, "top move list renders", { rows: rows1 });
    await page.click("#settingsButton");
    await page.click('input[name="suggestedMovesMode"][value="all"]');
    await page.click("#settingsDialog .settingsClose");
    await page.waitForFunction(() => document.querySelectorAll("#engineList .engineRow").length > 5,
        { timeout: 5000 });
    check(await page.$$eval("#engineList .engineRow", (rows) => rows.length) > 5,
        "all mode renders beyond the top five");
    await page.click("#settingsButton");
    await page.click('input[name="suggestedMovesMode"][value="top5"]');
    await page.click("#settingsDialog .settingsClose");

    const status1 = await page.$eval("#engineStatus", (s) => s.textContent);
    check(!/w\d+ d\d+/.test(status1) && /pos\/s/.test(status1),
        "three-row stats look like an engine", { status1 });
    const analysisTime = await page.$eval("#engineStatus .engineStTime", (s) => ({
        text: s.textContent,
        title: s.title,
        aria: s.closest("#engineStatus").getAttribute("aria-label"),
    }));
    check(/^time (?:\d+ms|\d+(?:\.\d)?s|\d+m\d{2}s|\d+h\d{2}m)$/.test(analysisTime.text)
        && /analysis elapsed time:/.test(analysisTime.title)
        && /analysis elapsed time:/.test(analysisTime.aria),
        "analysis elapsed time is visible and accessible", analysisTime);
    check(/CPU/.test(status1), "compute backend reported", { backend: status1.match(/CPU[^ ]*( \(GPU failed\))?$/)?.[0] });

    // scores must be sorted ascending (best first)
    const scores1 = await page.$$eval("#engineList .engineScore", (els) => els.map((e) => parseInt(e.textContent, 10)));
    check(scores1.every((s, i) => i === 0 || scores1[i - 1] <= s), "scores sorted best-first", { scores1 });

    // play the engine's #1 suggestion by clicking its group cell on the canvas
    const target = await page.evaluate(async () => {
        // reach into the module graph via a dynamic import of the same URL
        const { EngineUI } = await import("/src/scripts/engine-ui.js?build=20260713-proof13");
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
    const sliderAfterMove = await page.$eval("#movesSlider", (slider) => ({
        value: Number(slider.value), max: Number(slider.max),
        output: document.getElementById("movesSliderOutput").textContent,
    }));
    check(sliderAfterMove.value === 1 && sliderAfterMove.max >= 1 && /^1 \/ /.test(sliderAfterMove.output),
        "moves slider follows played moves", sliderAfterMove);
    await page.$eval("#movesSlider", (slider) => {
        slider.value = "0";
        slider.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await page.waitForFunction(() => document.getElementById("moveValue").textContent.startsWith("0 /"));
    check(await page.$eval("#movesSlider", (slider) => slider.value) === "0",
        "moves slider rewinds the shown position");
    await page.click("#forwardButton");

    // the engine must pick up the new position and produce fresh rows
    await page.waitForFunction(() => {
        const status = document.getElementById("engineStatus").textContent;
        return document.querySelectorAll("#engineList .engineRow").length > 0 && /pos\/s/.test(status);
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

    // Telemetry uses separate overview, CPU and GPU rows. The three leading
    // processor columns must line up so totals and rates compare vertically.
    const statusShape = await page.$eval("#engineStatus", (s) => ({
        rows: s.querySelectorAll(":scope > .engineStatusRow").length,
        height: s.clientHeight,
        text: s.textContent,
        details: s.querySelectorAll(".engineHwDetail").length,
        shares: [...s.querySelectorAll(".engineHwShare")]
            .map((node) => Number.parseInt(node.textContent, 10)),
        columnsAligned: (() => {
            const overview = s.querySelector(".engineStatusOverview");
            const cpu = s.querySelector(".engineHwCpu");
            const gpu = s.querySelector(".engineHwGpu");
            if (!overview || !cpu || !gpu) return false;
            const rows = [overview, cpu, gpu].map((row) => [...row.children]
                .slice(0, 4).map((node) => node.getBoundingClientRect().left));
            return rows[0].every((left, index) => rows.slice(1)
                .every((positions) => Math.abs(left - positions[index]) < 1));
        })(),
    }));
    check(statusShape.rows === 3 && statusShape.height >= 39 && statusShape.height < 60,
        "status uses three responsive logical rows", statusShape);
    check(statusShape.columnsAligned,
        "CPU and GPU telemetry columns align vertically", statusShape);
    check(!statusShape.text.includes("CPU+GPU") && !statusShape.text.includes("integrated"),
        "status omits redundant backend/profile labels", statusShape);
    check(statusShape.details === 0
        && !/\b(?:beam|play|active|duty|playouts|batches|busy)\b/.test(statusShape.text),
        "status omits detailed CPU/GPU counters", statusShape);
    check(statusShape.shares.length === 2
        && statusShape.shares.every(Number.isFinite)
        && statusShape.shares[0] + statusShape.shares[1] === 100,
        "CPU and GPU position shares total 100%", statusShape);

    // continuous analysis: on a full board (no proofs possible) the engine
    // must keep working indefinitely — nodes strictly increasing, no idle-out
    const nodesOf = async () => page.$eval("#engineStatus .engineStNodes", (s) => {
        const m = s.textContent.match(/([\d.]+)([BMk]?)/);
        const scale = m?.[2] === "B" ? 1e9 : m?.[2] === "M" ? 1e6 :
            m?.[2] === "k" ? 1e3 : 1;
        return m ? parseFloat(m[1]) * scale : -1;
    });
    await new Promise((r) => setTimeout(r, 6000));
    const nodesA = await nodesOf();
    await new Promise((r) => setTimeout(r, 6000));
    const nodesB = await nodesOf();
    const statusB = await page.$eval("#engineStatus", (s) => s.textContent);
    // `optimal` certifies the position score but deliberately keeps auditing
    // alternative rows, so only the two actual stop states excuse no progress.
    const terminal = /proven ✓|settled/.test(statusB);
    check(nodesA > 0 && (nodesB > nodesA || terminal),
        "analysis either progresses or reaches a valid terminal state", { nodesA, nodesB, statusB });
    check(/analyzing…|optimal ✓|proven ✓|settled/.test(statusB),
        "status remains a valid engine state", { statusB });

    // toggle off cleans up
    if (await page.$eval("#engineButton", (b) => b.classList.contains("active"))) {
        await page.click("#engineButton");
    }
    check(await page.$eval("#engineSection", (s) => s.hidden), "engine panel hides on toggle-off");

    // Regression: every first move in this position clears, but several rows
    // used to remain at 1 for 60+ seconds even though playing that row exposed
    // a clearing second move immediately. Show the complete table and require
    // the parent-side virtual-child portfolio to certify all 22 rows.
    const starvationCase = "?v=5&g=Bp-rtMfMUUaxsQwaoLBDFQp4_m1oPxZc7RzdEmIsH6ErajTAL9v9H5JAlMB";
    const consistencyStart = performance.now();
    await page.goto(`${baseURL}/${starvationCase}`, { waitUntil: "networkidle0" });
    await page.click("#settingsButton");
    await page.click('input[name="suggestedMovesMode"][value="all"]');
    await page.click("#settingsDialog .settingsClose");
    if (!await page.$eval("#engineButton", (b) => b.classList.contains("active"))) {
        await page.click("#engineButton");
    }
    await page.waitForFunction(
        () => document.querySelectorAll("#engineList .engineRow").length === 22 &&
            [...document.querySelectorAll("#engineList .engineExact")]
                .every((exact) => exact.textContent === "✓"),
        { timeout: 90000 });
    const starvationResult = await page.evaluate(() => ({
        rows: [...document.querySelectorAll("#engineList .engineRow")].map((row) => ({
            location: row.querySelector(".engineLoc").textContent,
            score: parseInt(row.querySelector(".engineScore").textContent, 10),
            exact: row.querySelector(".engineExact").textContent,
        })),
        status: document.getElementById("engineStatus").textContent,
    }));
    starvationResult.elapsedMs = Math.round(performance.now() - consistencyStart);
    check(starvationResult.rows.length === 22 &&
        starvationResult.rows.every((row) => row.score === 0 && row.exact === "✓") &&
        ["FA", "CD", "HC", "KG"].every((location) =>
            starvationResult.rows.some((row) => row.location === location && row.exact === "✓")),
    "virtual-child portfolio proves every formerly starved parent row", starvationResult);
    await page.click("#settingsButton");
    await page.click('input[name="suggestedMovesMode"][value="top5"]');
    await page.click("#settingsDialog .settingsClose");
    if (await page.$eval("#engineButton", (b) => b.classList.contains("active"))) {
        await page.click("#engineButton");
    }

    // Recursive pre/post-click consistency regression. At move 6 select the
    // JH variant (the second branch). FA and DC used to remain at 1 for tens
    // of seconds, although entering either child exposed a zero almost
    // immediately through one more virtual-child split.
    const recursiveCase = "?v=5&g=c8_xC_qbkOmoL9PZI-OPrF1IvXT0gZS4-eB6ANOq1WKyA6e1WMZK-_U0qw4HFOrYA0HyOF3Gd0XWMZZfgVegxTEykEHwefiPh";
    await page.goto(`${baseURL}/src/index.html${recursiveCase}`, { waitUntil: "networkidle0" });
    if (await page.$eval("#engineButton", (b) => b.classList.contains("active"))) {
        await page.click("#engineButton");
    }
    await page.click("#settingsButton");
    await page.click('input[name="suggestedMovesMode"][value="all"]');
    await page.click("#settingsDialog .settingsClose");
    const selectedJHVariant = await page.evaluate(() => {
        const candidates = [...document.querySelectorAll("#treeScroll .treeNode")]
            .filter((node) => node.querySelector(".treeLabel")?.textContent === "JH");
        const positioned = candidates.map((node) => {
            const match = node.getAttribute("transform")?.match(/translate\(([-\d.]+)/);
            return { node, x: match ? Number(match[1]) : -Infinity };
        }).sort((a, b) => b.x - a.x);
        const variant = positioned[0]?.node;
        variant?.dispatchEvent(new MouseEvent("mousedown", {
            bubbles: true, cancelable: true, button: 0,
        }));
        return { count: candidates.length, selected: Boolean(variant) };
    });
    const recursiveSelection = await page.evaluate(() => ({
        move: document.getElementById("moveValue").textContent,
        remaining: document.getElementById("scoreValue").textContent,
        focus: document.querySelector("#treeScroll .treeNode.focus .treeLabel")?.textContent,
    }));
    check(selectedJHVariant.count === 2 && selectedJHVariant.selected &&
        recursiveSelection.move === "6 / 15" && recursiveSelection.remaining === "103" &&
        recursiveSelection.focus === "JH",
    "recursive consistency regression selects move 6 JH variant");
    if (!await page.$eval("#engineButton", (b) => b.classList.contains("active"))) {
        await page.click("#engineButton");
    }
    const recursiveStart = performance.now();
    await page.waitForFunction(() => {
        const rows = [...document.querySelectorAll("#engineList .engineRow")];
        return ["FA", "DC"].every((location) => rows.some((row) =>
            row.querySelector(".engineLoc")?.textContent === location &&
            parseInt(row.querySelector(".engineScore")?.textContent ?? "9999", 10) === 0 &&
            row.querySelector(".engineExact")?.textContent === "✓"));
    }, { timeout: recursiveTimeoutMs });
    const recursiveResult = await page.evaluate(() => ({
        rows: [...document.querySelectorAll("#engineList .engineRow")].map((row) => ({
            location: row.querySelector(".engineLoc")?.textContent,
            score: parseInt(row.querySelector(".engineScore")?.textContent ?? "9999", 10),
            exact: row.querySelector(".engineExact")?.textContent,
        })),
        status: document.getElementById("engineStatus").textContent,
    }));
    recursiveResult.elapsedMs = Math.round(performance.now() - recursiveStart);
    check(["FA", "DC"].every((location) => recursiveResult.rows.some((row) =>
        row.location === location && row.score === 0 && row.exact === "✓")),
    "parent analysis resolves FA/DC without playing either move", recursiveResult);
    if (await page.$eval("#engineButton", (b) => b.classList.contains("active"))) {
        await page.click("#engineButton");
    }

    // The G7 link stores a tree but not its selected node. Reproduce the only
    // recorded positive leaf explicitly: move 15, 84 cells. This remains a
    // hard universal proof, so the regression is deliberately bounded: it
    // checks that the intended position is analyzed, work advances, and any
    // certification exposed by the UI agrees with the row-level exact marks.
    // This checks progress/certification semantics, not peak throughput. Four
    // lanes keep headless Chrome's DevTools thread responsive while the hard
    // universal proof runs; the supplied 16-lane performance case is covered
    // independently by the focused regression above.
    const compactProofCase = "?v=5&g=G7hGDfQ_u8-RuUiNwlBPWQYGCitOqgY9Zi1Z-F0sf3WHSpfuQsGhchAYNCVsfRfGbplq37oZTqDrFgFqovNPzrBidRg_D&engineWorkers=4";
    await page.goto(`${baseURL}/src/index.html${compactProofCase}`, { waitUntil: "networkidle0" });
    if (await page.$eval("#engineButton", (b) => b.classList.contains("active"))) {
        await page.click("#engineButton");
    }
    await page.evaluate(() => {
        const slider = document.getElementById("movesSlider");
        slider.value = slider.max;
        slider.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const compactSelection = await page.evaluate(() => ({
        move: document.getElementById("moveValue").textContent,
        remaining: document.getElementById("scoreValue").textContent,
        focus: document.querySelector("#treeScroll .treeNode.focus .treeLabel")?.textContent,
    }));
    check(compactSelection.move === "15 / 15" && compactSelection.remaining === "84" &&
        compactSelection.focus === "DC",
        "compact positive-proof regression selects the recorded move-15 leaf");
    await page.click("#settingsButton");
    await page.click('input[name="suggestedMovesMode"][value="all"]');
    await page.click("#settingsDialog .settingsClose");
    if (!await page.$eval("#engineButton", (b) => b.classList.contains("active"))) {
        await page.click("#engineButton");
    }
    const compactStart = performance.now();
    await page.waitForFunction(() =>
        document.querySelectorAll("#engineList .engineRow").length === 15 &&
        /pos\/s/.test(document.getElementById("engineStatus").textContent),
    { timeout: 20000 });
    const compactInitialNodes = await nodesOf();
    await new Promise((resolve) => setTimeout(resolve, compactObservationMs));
    const compactResult = await page.evaluate(() => ({
        rows: [...document.querySelectorAll("#engineList .engineRow")].map((row) => ({
            location: row.querySelector(".engineLoc")?.textContent,
            score: parseInt(row.querySelector(".engineScore")?.textContent ?? "9999", 10),
            exact: row.querySelector(".engineExact")?.textContent === "✓",
        })),
        status: document.getElementById("engineStatus").textContent,
    }));
    compactResult.initialNodes = compactInitialNodes;
    compactResult.finalNodes = await nodesOf();
    compactResult.elapsedMs = Math.round(performance.now() - compactStart);
    const compactExactRows = compactResult.rows.filter((row) => row.exact);
    const compactBestScore = Math.min(...compactResult.rows.map((row) => row.score));
    const compactCertificationConsistent = /proven ✓/.test(compactResult.status)
        ? compactExactRows.length === compactResult.rows.length
        : /optimal ✓/.test(compactResult.status)
            ? compactExactRows.some((row) => row.score === compactBestScore)
            : true;
    check(compactResult.rows.length === 15 &&
        compactResult.finalNodes > compactResult.initialNodes,
    "hard positive position makes bounded analysis progress", compactResult);
    check(compactCertificationConsistent,
        "hard positive position never advertises certification without matching exact rows",
        compactResult);
    if (await page.$eval("#engineButton", (b) => b.classList.contains("active"))) {
        await page.click("#engineButton");
    }

    // Regression: this full-board position has an easy-to-certify clearing
    // move mixed with a much harder positive alternative. The position value
    // must be reported as optimal without waiting for every row to be exact.
    const positionProofCase = "?v=5&g=Bp90fqatzsB7kFTAXXPCEWyEfOe9QpfTxpzrosY7GaqDbBs0gqCRIQnwnZa";
    const positionProofStart = performance.now();
    await page.goto(`${baseURL}/${positionProofCase}`, { waitUntil: "networkidle0" });
    if (!await page.$eval("#engineButton", (b) => b.classList.contains("active"))) {
        await page.click("#engineButton");
    }
    await page.waitForFunction(
        () => /optimal ✓/.test(document.getElementById("engineStatus").textContent),
        { timeout: 20000 });
    const positionProofElapsedMs = Math.round(performance.now() - positionProofStart);
    const positionProofResult = await page.evaluate(() => ({
        score: parseInt(document.querySelector("#engineList .engineScore")?.textContent ?? "9999", 10),
        exact: document.querySelector("#engineList .engineExact")?.textContent,
        status: document.getElementById("engineStatus").textContent,
    }));
    positionProofResult.elapsedMs = positionProofElapsedMs;
    check(positionProofResult.score === 0 && positionProofResult.exact === "✓" &&
        /optimal ✓/.test(positionProofResult.status),
    "full-board mixed-complexity position reaches a certified optimum",
    positionProofResult);
    if (await page.$eval("#engineButton", (b) => b.classList.contains("active"))) {
        await page.click("#engineButton");
    }

    // Regression: move 25 of this recording needs a temporarily fragmented
    // corridor. The bounded permanent-only portfolio must resolve FC to a
    // replayable/proven zero before the normal heuristic can settle at 2.
    const fragmentationCase = "?v=5&g=BanJkAhMlxgvWGHOJNM7B0JS-20PRwJU6AfudCmzcF3cYlDaHIhRydZ8xoRe7e3Hxd2HzIMOEa_X26eg_wQQA5waAY4ZYkm_Oa-pX8KVh3Xa73NcBt2VpwT9tkxjGcluEc34dyGau_uyeWIs6ESM-bdaaxMfG3CKk8PUIEmUrQawuUVtAd8Xp98UWFLIIJuKpFkoL6sMzQGB_h0mSn9";
    await page.goto(`${baseURL}/${fragmentationCase}`, { waitUntil: "networkidle0" });
    if (await page.$eval("#engineButton", (b) => b.classList.contains("active"))) {
        await page.click("#engineButton");
    }
    await page.evaluate(() => {
        const canvas = document.getElementById("gameCanvas");
        for (let i = 0; i < 25; i++) {
            canvas.dispatchEvent(new WheelEvent("wheel", {
                deltaY: 100, bubbles: true, cancelable: true,
            }));
        }
    });
    check((await page.$eval("#moveValue", (e) => e.textContent)).startsWith("25 / 48"),
        "fragmentation regression navigates to move 25");
    if (!await page.$eval("#engineButton", (b) => b.classList.contains("active"))) {
        await page.click("#engineButton");
    }
    await page.waitForFunction(() => Array.from(document.querySelectorAll("#engineList .engineRow"))
        .some((row) => row.querySelector(".engineLoc")?.textContent === "FC" &&
            parseInt(row.querySelector(".engineScore")?.textContent ?? "9999", 10) === 0 &&
            row.querySelector(".engineExact")?.textContent === "✓"), { timeout: 30000 });
    const fragmentationResult = await page.evaluate(() => {
        const row = Array.from(document.querySelectorAll("#engineList .engineRow"))
            .find((candidate) => candidate.querySelector(".engineLoc")?.textContent === "FC");
        return {
            score: row?.querySelector(".engineScore")?.textContent,
            exact: row?.querySelector(".engineExact")?.textContent,
            status: document.getElementById("engineStatus").textContent,
        };
    });
    check(fragmentationResult.score === "0 ★" && fragmentationResult.exact === "✓",
        "permanent-only portfolio clears the move-25 fragmentation regression",
        fragmentationResult);
    if (await page.$eval("#engineButton", (b) => b.classList.contains("active"))) {
        await page.click("#engineButton");
    }

    // endgame proving: rewind a recorded game to 10 moves before its end —
    // 32 remaining cells, the size class that used to cycle under the old
    // 32-cell gate; the value solver must prove every move and report complete
    const example = "?position=544341454153245551352111315534254113553554342242333515335513533415541542" +
        "111541422113121311534345113215252332331311244443442542241513343551454125" +
        "&moves=65,54,21,43,31,42,30,29,17,15,13,13,37,24,25,24,14,13,14,26,26,38,38,54,66,78,89,88,88," +
        "77,87,87,73,84,60,37,36,12,1,0,12" +
        "&times=533,929,374,344,492,642,406,218,320,236,178,414,344,266,344,352,484,586,188,264,258," +
        "430,1242,336,679,611,217,455,358,321,171,524,273,235,905,180,406,414,156,320";
    await page.goto(`${baseURL}/${example}`, { waitUntil: "networkidle0" });
    await page.click("#forwardButton");
    await page.evaluate(() => {
        const canvas = document.getElementById("gameCanvas");
        for (let i = 0; i < 10; i++) {
            canvas.dispatchEvent(new WheelEvent("wheel", { deltaY: -100, bubbles: true, cancelable: true }));
        }
    });
    if (!await page.$eval("#engineButton", (b) => b.classList.contains("active"))) {
        await page.click("#engineButton");
    }
    await page.waitForFunction(
        () => /proven ✓/.test(document.getElementById("engineStatus").textContent),
        { timeout: 90000 });
    const proven = await page.$$eval("#engineList .engineExact", (els) => els.map((e) => e.textContent));
    check(proven.length > 0 && proven.every((t) => t === "✓"), "endgame rows all proven", { proven });
    const terminalStatus = await page.$eval("#engineStatus", (status) => status.textContent);
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const terminalStatusLater = await page.$eval("#engineStatus", (status) => status.textContent);
    check(terminalStatusLater === terminalStatus,
        "proven status freezes positions, rates and elapsed time",
        { terminalStatus, terminalStatusLater });
    if (await page.$eval("#engineButton", (b) => b.classList.contains("active"))) {
        await page.click("#engineButton");
    }

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
