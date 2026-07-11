/**
 * Click2026 — end-to-end position-tree and official-time check (development tool).
 *
 * Drives the served game in headless Chrome/Edge: plays a timed game on the board,
 * verifies the clock stops on the first non-board control interaction, creates a
 * variant branch, navigates the tree by clicking nodes and by mouse wheel, checks
 * the dash shown for untimed positions and the v5 link round-trip.
 *
 * Usage: node tools/tree.e2e.mjs   (expects `npm run serve` on port 8123)
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

let failures = 0;
const check = (ok, title, detail) => {
    console.log(`${ok ? "ok  " : "FAIL"}  ${title}${detail ? "  " + JSON.stringify(detail) : ""}`);
    if (!ok) failures++;
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
    executablePath,
    headless: "new",
    args: ["--no-sandbox"],
});

try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1400, height: 900 });

    const consoleErrors = [];
    page.on("console", (msg) => { if (msg.type() === "error") consoleErrors.push(msg.text()); });
    page.on("pageerror", (error) => consoleErrors.push(String(error)));

    // page helpers evaluated in the browser context
    const moveValue = () => page.$eval("#moveValue", (e) => e.textContent);
    const timeValue = () => page.$eval("#timeValue", (e) => e.textContent);
    const treeNodeCount = () => page.$$eval("#treeScroll .treeNode", (n) => n.length);
    const treeColumnCount = () => page.$$eval("#treeScroll .treeNode", (nodes) =>
        new Set(nodes.map((n) => n.getAttribute("transform").match(/translate\((\d+)/)[1])).size);

    // clicks board cells left to right along a row until the move counter changes
    const playAnyMove = (row = 0) => page.evaluate((j) => new Promise((resolve) => {
        const canvas = document.getElementById("gameCanvas");
        const rect = canvas.getBoundingClientRect();
        const before = document.getElementById("moveValue").textContent;
        let i = 0;
        const tryClick = () => {
            if (i >= 12) { resolve(false); return; }
            const x = rect.left + 5 + 25 * i + 12;
            const y = rect.top + 5 + 25 * (11 - j) + 12;
            canvas.dispatchEvent(new MouseEvent("mousedown", { clientX: x, clientY: y, bubbles: true }));
            setTimeout(() => {
                if (document.getElementById("moveValue").textContent !== before) resolve(true);
                else { i++; tryClick(); }
            }, 40);
        };
        tryClick();
    }), row);

    const wheel = (deltaY) => page.evaluate((d) => {
        document.getElementById("gameCanvas").dispatchEvent(
            new WheelEvent("wheel", { deltaY: d, bubbles: true, cancelable: true }));
    }, deltaY);

    //
    // A — official time: clock runs on pure board play, stops on any control
    //
    await page.goto("http://localhost:8123/", { waitUntil: "networkidle0" });
    await page.click("#startButton");

    check(await treeNodeCount() === 1, "fresh game shows the root node only");

    check(await playAnyMove(), "first board click plays a move");
    check(await playAnyMove(), "second board click plays a move");
    check(await moveValue() === "2 / 2", "move counter follows timed play", { move: await moveValue() });

    const t1 = await timeValue();
    await sleep(250);
    const t2 = await timeValue();
    check(t1 !== t2 && t2 !== "–", "clock is running during board play", { t1, t2 });

    // buttons must stay active during play
    const pe = await page.$eval("#backwardButton", (b) => getComputedStyle(b).pointerEvents);
    check(pe !== "none", "controls stay enabled during play", { pointerEvents: pe });

    // pressing any control stops the clock for good
    await page.click("#autoPlayButton");
    await sleep(100);
    const t3 = await timeValue();
    await sleep(250);
    const t4 = await timeValue();
    check(t3 === t4 && !Number.isNaN(parseFloat(t3)), "control click stops the clock at the last move time", { t3, t4 });

    // play continues untimed — the new move extends the line, time shows a dash
    check(await playAnyMove(), "board play continues after the clock stopped");
    check(await moveValue() === "3 / 3", "untimed move extends the line", { move: await moveValue() });
    check(await timeValue() === "–", "untimed position shows a dash", { time: await timeValue() });
    check(await treeNodeCount() === 4, "tree records root + 3 moves", { nodes: await treeNodeCount() });

    //
    // B — variants: branch to the right, tree clicks and wheel navigation
    //
    await wheel(-100); // one move back
    await sleep(50);
    check(await moveValue() === "2 / 3", "wheel rewinds one move", { move: await moveValue() });

    // probe for a move different from the recorded one — the tree must branch;
    // if the probe happens to replay the recorded move, back up and try further cells
    let branched = false;
    for (let row = 0; row < 12 && !branched; row++) {
        const before = await treeNodeCount();
        if (!await playAnyMove(row)) continue;
        if (await treeNodeCount() > before) {
            branched = true;
        } else {
            await wheel(-100); // replayed the existing move — rewind and probe on
            await sleep(50);
        }
    }
    check(branched, "a different move branches a variant");
    check(await treeColumnCount() >= 2, "variant occupies its own column", { columns: await treeColumnCount() });
    check(await timeValue() === "–", "variant position shows a dash");

    // autoplay is meaningless off the main line — the play button must do nothing
    const moveBefore = await moveValue();
    await page.click("#autoPlayButton");
    await sleep(300);
    check(await moveValue() === moveBefore && await page.$eval("#autoPauseButton", (b) => b.hidden),
        "autoplay refuses to run on a variant", { move: await moveValue() });

    // clicking the root node reloads the start position of the main line
    await page.evaluate(() => document.querySelector("#treeScroll .treeNode")
        .dispatchEvent(new MouseEvent("mousedown", { bubbles: true })));
    await sleep(50);
    check(await moveValue() === "0 / 3", "root node click reloads the start position", { move: await moveValue() });
    check(await timeValue() === "0", "time is 0 at the start position");

    // wheel down from the root follows the main line, where time is official
    await wheel(100);
    await sleep(50);
    check(await moveValue() === "1 / 3", "wheel forward follows the main line", { move: await moveValue() });
    check(await timeValue() !== "–", "main line move shows its official time", { time: await timeValue() });

    // clicking the variant leaf jumps to its position
    const focusMoved = await page.evaluate(() => {
        const nodes = [...document.querySelectorAll("#treeScroll .treeNode")];
        const byCol = (n) => Number(n.getAttribute("transform").match(/translate\((\d+)/)[1]);
        const variant = nodes.reduce((a, b) => (byCol(a) >= byCol(b) ? a : b));
        variant.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
        return true;
    });
    await sleep(50);
    check(focusMoved && await moveValue() === "3 / 3" && await timeValue() === "–",
        "variant node click reloads its position, time is a dash",
        { move: await moveValue(), time: await timeValue() });

    //
    // C — serialization: the link carries the whole tree and survives a reload
    //
    const link = await page.evaluate(() => {
        let captured = null;
        window.prompt = (title, value) => { captured = value; return null; };
        document.getElementById("linkButton").click();
        return captured;
    });
    check(typeof link === "string" && link.includes("v=5&g="), "link with variants serializes as v5",
        { link: link?.slice(0, 90) + "…" });

    const nodesBeforeReload = await treeNodeCount();
    await page.goto(link, { waitUntil: "networkidle0" });
    check(await treeNodeCount() === nodesBeforeReload, "reloaded link restores the whole tree",
        { nodes: await treeNodeCount(), expected: nodesBeforeReload });
    check(await moveValue() === "0 / 3", "reloaded game sits at the start of the main line", { move: await moveValue() });

    //
    // D — tree panel geometry: constant height, light background
    //
    const heightEngineOff = await page.$eval("#treePanel", (p) => p.offsetHeight);
    await page.click("#engineButton");
    const heightEngineOn = await page.$eval("#treePanel", (p) => p.offsetHeight);
    check(heightEngineOff === heightEngineOn, "tree panel height constant across engine toggle",
        { heightEngineOff, heightEngineOn });
    const bg = await page.$eval("#treePanel", (p) => getComputedStyle(p).backgroundColor);
    check(bg !== "rgb(0, 0, 0)", "tree panel background is light", { bg });

    //
    // engine scores land in the focused tree node
    //
    await page.waitForFunction(
        () => document.querySelector("#treeScroll .treeNode.focus .treeScore")?.textContent.length > 0,
        { timeout: 30000 });

    // with the engine list fully populated, the board column reaches the same
    // height the tree panel keeps at all times
    await page.waitForFunction(() => document.querySelectorAll("#engineList .engineRow").length >= 5, { timeout: 30000 });
    const mainHeight = await page.$eval("#gameMain", (p) => p.offsetHeight);
    check(Math.abs(mainHeight - heightEngineOn) <= 2, "tree panel matches the full board column",
        { mainHeight, panel: heightEngineOn });
    const score = await page.$eval("#treeScroll .treeNode.focus .treeScore", (e) => e.textContent);
    check(/^\d+$/.test(score), "engine score recorded on the focused node", { score });

    // node selection stays reliable while the engine streams results — click a
    // different node each round and verify the focus lands on its lattice cell
    let selectionOk = true;
    for (let k = 0; k < 5 && selectionOk; k++) {
        selectionOk = await page.evaluate((round) => {
            const nodes = [...document.querySelectorAll("#treeScroll .treeNode")];
            const target = nodes[round % nodes.length];
            const cell = target.getAttribute("transform");
            target.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
            return new Promise((resolve) => setTimeout(() =>
                resolve(document.querySelector("#treeScroll .treeNode.focus")?.getAttribute("transform") === cell),
                100));
        }, k);
        await sleep(300); // let the engine post a few results between attempts
    }
    check(selectionOk, "tree nodes clickable while the engine runs");

    // suggestion rows carry the A-L block location
    const locs = await page.$$eval("#engineList .engineLoc", (els) => els.map((e) => e.textContent));
    check(locs.length > 0 && locs.every((l) => /^[A-L]{2}$/.test(l)),
        "engine rows show A-L block locations", { locs });

    // the marker toggle removes the group outlines from the board
    const whitePixels = () => page.evaluate(() => {
        const img = document.getElementById("gameCanvas").getContext("2d").getImageData(0, 0, 310, 310).data;
        let white = 0;
        for (let p = 0; p < img.length; p += 4) {
            if (img[p] > 240 && img[p + 1] > 240 && img[p + 2] > 240) white++;
        }
        return white;
    });
    const withMarkers = await whitePixels();
    await page.click("#markersButton");
    const withoutMarkers = await whitePixels();
    check(withMarkers > 20 && withoutMarkers < withMarkers / 10,
        "marker toggle hides engine outlines", { withMarkers, withoutMarkers });
    await page.click("#markersButton");
    check(await whitePixels() > 20, "marker toggle restores engine outlines");

    await page.click("#engineButton");

    //
    // board coordinate labels: A..L over the columns, A at the bottom row
    //
    const labels = await page.evaluate(() => ({
        cols: [...document.querySelectorAll("#boardColLabels span")].map((s) => s.textContent).join(""),
        rows: [...document.querySelectorAll("#boardRowLabels span")].map((s) => s.textContent).join(""),
    }));
    check(labels.cols === "ABCDEFGHIJKL" && labels.rows === "LKJIHGFEDCBA",
        "discrete A-L board labels rendered", labels);

    //
    // E — legacy example still replays with times
    //
    await page.goto("http://localhost:8123/?position=5443414541532455513521113155342541135535543422423335153355135334155415421" +
        "11541422113121311534345113215252332331311244443442542241513343551454125" +
        "&moves=65,54,21,43,31,42,30,29,17,15,13,13,37,24,25,24,14,13,14,26,26,38,38,54,66,78,89,88,88,77,87,87,73,84,60," +
        "37,36,12,1,0,12&times=533,929,374,344,492,642,406,218,320,236,178,414,344,266,344,352,484,586,188,264,258,430," +
        "1242,336,679,611,217,455,358,321,171,524,273,235,905,180,406,414,156,320", { waitUntil: "networkidle0" });
    check(await treeNodeCount() === 42, "legacy example loads into the tree", { nodes: await treeNodeCount() });
    check(await treeColumnCount() === 1, "legacy example is a single main line");

    await page.click("#autoPlayButton");
    await sleep(1500);
    await page.click("#autoPauseButton");
    const replayed = await moveValue();
    check(parseInt(replayed, 10) > 0, "legacy example autoplays with times", { move: replayed });

    // a 42-node tree overflows the panel — the user's scroll must survive the
    // engine streaming results (no jump back to the focused node)
    await page.click("#engineButton");
    await page.evaluate(() => { document.getElementById("treeScroll").scrollTop = 40; });
    await sleep(1500);
    const scrollTop = await page.$eval("#treeScroll", (e) => e.scrollTop);
    check(scrollTop === 40, "user scroll survives engine updates", { scrollTop });
    await page.click("#engineButton");

    const relevantErrors = consoleErrors.filter((e) => !/favicon/.test(e));
    check(relevantErrors.length === 0, "no console errors", relevantErrors.length ? { relevantErrors } : undefined);
} finally {
    await browser.close();
}

console.log(failures === 0 ? "\nTree E2E passed." : `\n${failures} TREE E2E FAILURES`);
process.exit(failures === 0 ? 0 : 1);
