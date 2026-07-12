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

    // Edges are painted in two passes (ordinary first, replay last), so associate
    // each edge with its destination node by SVG endpoint rather than DOM order.
    const treeState = () => page.$eval("#treeScroll svg", (svg) => {
        const edges = [...svg.querySelectorAll(".treeEdge")];
        return [...svg.querySelectorAll(".treeNode")].map((node) => {
            const transform = node.getAttribute("transform");
            const match = transform.match(/translate\(([\d.]+),\s*([\d.]+)\)/);
            const x = Number(match[1]);
            const y = Number(match[2]);
            const incoming = edges.find((edge) => {
                const end = edge.getPointAtLength(edge.getTotalLength());
                return Math.abs(end.x - (x + 27)) < 0.1 && Math.abs(end.y - y) < 0.1;
            });
            const style = incoming === undefined ? null : getComputedStyle(incoming);
            return {
                transform,
                focus: node.classList.contains("focus"),
                replay: incoming?.classList.contains("replay") ?? false,
                stroke: style?.stroke ?? null,
                strokeWidth: style === null ? null : parseFloat(style.strokeWidth),
            };
        });
    });

    const focusedTreeNode = async () => (await treeState()).find((node) => node.focus);
    const treeNodeCenter = (transform) => page.$$eval("#treeScroll .treeNode", (nodes, wanted) => {
        const node = nodes.find((candidate) => candidate.getAttribute("transform") === wanted);
        if (node === undefined) return null;
        const rect = node.getBoundingClientRect();
        return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    }, transform);

    // Use real pointer input. The first press may rebuild the SVG, while the
    // second press must still reach the replacement node and select its route.
    const pressTreeNode = async (transform, count = 1) => {
        const point = await treeNodeCenter(transform);
        if (point === null) return false;
        for (let k = 0; k < count; k++) {
            await page.mouse.click(point.x, point.y);
            if (k + 1 < count) await sleep(40);
        }
        await sleep(50);
        return true;
    };

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

    const playCell = ([i, j]) => page.evaluate(([column, row]) => new Promise((resolve) => {
        const canvas = document.getElementById("gameCanvas");
        const rect = canvas.getBoundingClientRect();
        const before = document.getElementById("moveValue").textContent;
        canvas.dispatchEvent(new MouseEvent("mousedown", {
            clientX: rect.left + 5 + 25 * column + 12,
            clientY: rect.top + 5 + 25 * (11 - row) + 12,
            bubbles: true,
        }));
        setTimeout(() => resolve(document.getElementById("moveValue").textContent !== before), 40);
    }), [i, j]);

    //
    // A — official time: clock runs on pure board play, stops on any control
    //
    await page.goto("http://localhost:8123/", { waitUntil: "networkidle0" });
    check(await page.$eval("#engineButton", (button) => button.classList.contains("active")) &&
        !await page.$eval("#engineSection", (section) => section.hidden),
        "engine analysis is on by default");
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

    const defaultTree = await treeState();
    const defaultEdges = defaultTree.filter((node) => node.stroke !== null);
    const mainLeafTransform = defaultTree.find((node) => node.focus)?.transform;
    check(defaultEdges.length === 3 && defaultEdges.every((edge) => edge.replay),
        "default replay route is the full vertical main line",
        { replayEdges: defaultEdges.filter((edge) => edge.replay).length });
    check(defaultEdges.every((edge) => edge.stroke === "rgb(255, 0, 0)" && edge.strokeWidth >= 3),
        "default replay route is drawn thick and red",
        { styles: defaultEdges.map(({ stroke, strokeWidth }) => ({ stroke, strokeWidth })) });

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

    const branchTree = await treeState();
    const variantLeafTransform = branchTree.find((node) => node.focus)?.transform;
    const mainLeafAfterBranch = branchTree.find((node) => node.transform === mainLeafTransform);
    const variantLeaf = branchTree.find((node) => node.transform === variantLeafTransform);
    const normalEdge = branchTree.find((node) => node.stroke !== null && !node.replay);
    const branchTransforms = branchTree.map((node) => node.transform).sort();
    check(branchTree.filter((node) => node.replay).length === 3 &&
        variantLeaf?.replay && !mainLeafAfterBranch?.replay,
        "new variant automatically becomes the replay route",
        { main: mainLeafAfterBranch, variant: variantLeaf });
    check(variantLeaf?.stroke === "rgb(255, 0, 0)" &&
        variantLeaf.strokeWidth > (normalEdge?.strokeWidth ?? Infinity),
        "selected variant edge is red and thicker than ordinary edges",
        { replay: variantLeaf && { stroke: variantLeaf.stroke, width: variantLeaf.strokeWidth },
            ordinary: normalEdge && { stroke: normalEdge.stroke, width: normalEdge.strokeWidth } });

    // The selected route also drives autoplay. Variant pacing is deliberately
    // synthetic, while its positions continue to show no official time.
    await page.click("#replayButton");
    await sleep(50);
    check(await moveValue() === "0 / 3" && await timeValue() === "0",
        "Replay returns to the selected route's start", { move: await moveValue(), time: await timeValue() });
    await page.click("#autoPlayButton");
    await sleep(1300);
    check((await focusedTreeNode())?.transform === variantLeafTransform &&
        await moveValue() === "3 / 3" && await timeValue() === "–" &&
        await page.$eval("#autoPauseButton", (b) => b.hidden),
        "autoplay follows the selected variant at an untimed cadence",
        { move: await moveValue(), time: await timeValue(), focus: (await focusedTreeNode())?.transform });

    // Both forward controls use the selected route.
    await page.click("#forwardButton");
    await sleep(50);
    check((await focusedTreeNode())?.transform === variantLeafTransform && await moveValue() === "3 / 3",
        "forward-to-end follows the automatically selected variant",
        { focus: (await focusedTreeNode())?.transform, expected: variantLeafTransform });

    await page.click("#replayButton");
    for (let k = 0; k < 3; k++) {
        await wheel(100);
        await sleep(30);
    }
    check((await focusedTreeNode())?.transform === variantLeafTransform,
        "wheel forward follows the automatically selected variant",
        { focus: (await focusedTreeNode())?.transform, expected: variantLeafTransform });

    // A genuine two-press mouse gesture must survive the focus rebuild triggered
    // by its first press, switch the route, and leave structural layout untouched.
    const doublePressed = await pressTreeNode(mainLeafTransform, 2);
    const mainReplayTree = await treeState();
    check(doublePressed && mainReplayTree.find((node) => node.transform === mainLeafTransform)?.replay &&
        !mainReplayTree.find((node) => node.transform === variantLeafTransform)?.replay,
        "double mouse click switches replay to the chosen main-line node");
    check(JSON.stringify(mainReplayTree.map((node) => node.transform).sort()) === JSON.stringify(branchTransforms),
        "switching replay route does not reorder or move tree nodes");

    // A single click still means focus only; it must not promote the clicked path.
    const singlePressed = await pressTreeNode(variantLeafTransform);
    const afterSingleClick = await treeState();
    check(singlePressed && (await focusedTreeNode())?.transform === variantLeafTransform &&
        !afterSingleClick.find((node) => node.transform === variantLeafTransform)?.replay &&
        afterSingleClick.find((node) => node.transform === mainLeafTransform)?.replay,
        "single tree-node click changes focus without changing replay route");
    check(await moveValue() === "3 / 3" && await timeValue() === "–",
        "variant node click reloads its position, time is a dash",
        { move: await moveValue(), time: await timeValue() });

    await page.click("#replayButton");
    await page.click("#forwardButton");
    await sleep(50);
    check((await focusedTreeNode())?.transform === mainLeafTransform,
        "single click did not change the route used by replay and forward",
        { focus: (await focusedTreeNode())?.transform, expected: mainLeafTransform });

    await page.click("#replayButton");
    await wheel(100);
    await sleep(50);
    check(await moveValue() === "1 / 3" && await timeValue() !== "–",
        "main replay route retains official move times",
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
    const reloadedTree = await treeState();
    check(reloadedTree.find((node) => node.transform === mainLeafTransform)?.replay &&
        !reloadedTree.find((node) => node.transform === variantLeafTransform)?.replay,
        "reloaded game defaults replay selection to the vertical main line");

    //
    // D — tree panel geometry: constant height, light background
    //
    const heightEngineOn = await page.$eval("#treePanel", (p) => p.offsetHeight);
    await page.click("#engineButton");
    const heightEngineOff = await page.$eval("#treePanel", (p) => p.offsetHeight);
    check(heightEngineOff === heightEngineOn, "tree panel height constant across engine toggle",
        { heightEngineOff, heightEngineOn });
    const bg = await page.$eval("#treePanel", (p) => getComputedStyle(p).backgroundColor);
    check(bg !== "rgb(0, 0, 0)", "tree panel background is light", { bg });

    await page.click("#engineButton");

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
    check(await page.$eval("#engineButton", (button) => button.classList.contains("active")),
        "engine remains on by default after navigation");
    await page.evaluate(() => { document.getElementById("treeScroll").scrollTop = 40; });
    await sleep(1500);
    const scrollTop = await page.$eval("#treeScroll", (e) => e.scrollTop);
    check(scrollTop === 40, "user scroll survives engine updates", { scrollTop });
    await page.click("#engineButton");

    //
    // F — responsive tree width: five columns by default, then grow or scroll
    //
    const examplePosition = "544341454153245551352111315534254113553554342242333515335513533415541542" +
        "111541422113121311534345113215252332331311244443442542241513343551454125";
    const rootMoves = [[0, 1], [0, 5], [0, 7], [0, 9], [1, 2], [2, 5], [3, 0]];
    await page.setViewport({ width: 1800, height: 900 });
    await page.goto(`http://localhost:8123/?position=${examplePosition}`, { waitUntil: "networkidle0" });

    const panelGeometry = () => page.evaluate(() => {
        const panel = document.getElementById("treePanel");
        const scroll = document.getElementById("treeScroll");
        const rect = panel.getBoundingClientRect();
        return {
            width: panel.offsetWidth,
            clientWidth: scroll.clientWidth,
            scrollWidth: scroll.scrollWidth,
            right: rect.right,
            viewport: window.innerWidth,
        };
    });

    const baselinePanel = await panelGeometry();
    check(baselinePanel.width >= 317 && baselinePanel.width <= 320,
        "tree panel baseline is five lattice columns wide", baselinePanel);

    for (let k = 0; k < rootMoves.length; k++) {
        if (k > 0) {
            await page.evaluate(() => document.querySelector("#treeScroll .treeNode")
                .dispatchEvent(new MouseEvent("mousedown", { bubbles: true })));
            await sleep(20);
        }
        check(await playCell(rootMoves[k]), `deterministic root variant ${k + 1} created`, { cell: rootMoves[k] });

        if (k === 4) {
            const fiveColumns = await panelGeometry();
            check(await treeColumnCount() === 5 && fiveColumns.width === baselinePanel.width &&
                fiveColumns.scrollWidth <= fiveColumns.clientWidth + 1,
                "five columns fit the baseline tree panel without horizontal scrolling", fiveColumns);
        }
        if (k === 5) {
            const sixColumns = await panelGeometry();
            check(await treeColumnCount() === 6 && sixColumns.width > baselinePanel.width + 50 &&
                sixColumns.scrollWidth <= sixColumns.clientWidth + 1,
                "sixth column expands the tree panel when viewport space allows", sixColumns);
        }
    }

    const sevenColumnsWide = await panelGeometry();
    check(await treeColumnCount() === 7 && sevenColumnsWide.width > baselinePanel.width + 110 &&
        sevenColumnsWide.scrollWidth <= sevenColumnsWide.clientWidth + 1,
        "wide viewport expands to show seven columns without horizontal scrolling", sevenColumnsWide);

    await page.setViewport({ width: 1000, height: 900 });
    await sleep(100);
    const sevenColumnsClamped = await panelGeometry();
    check(sevenColumnsClamped.width < sevenColumnsWide.width &&
        sevenColumnsClamped.scrollWidth > sevenColumnsClamped.clientWidth &&
        sevenColumnsClamped.right <= sevenColumnsClamped.viewport + 1,
        "constrained viewport clamps the panel and enables horizontal scrolling", sevenColumnsClamped);

    const relevantErrors = consoleErrors.filter((e) => !/favicon/.test(e));
    check(relevantErrors.length === 0, "no console errors", relevantErrors.length ? { relevantErrors } : undefined);
} finally {
    await browser.close();
}

console.log(failures === 0 ? "\nTree E2E passed." : `\n${failures} TREE E2E FAILURES`);
process.exit(failures === 0 ? 0 : 1);
