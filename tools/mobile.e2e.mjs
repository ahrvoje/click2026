/**
 * Click2026 — end-to-end mobile-layout check (development tool).
 *
 * Drives the served game in headless Chrome/Edge at iPhone-class viewports:
 * verifies the page never scrolls, the header holds the small branding with
 * the two-line copyright beside it, the footer holds settings / examples &
 * tests / tree view, the tree toggle swaps the tree in for the engine panel,
 * and board taps still land on the right field on the CSS-scaled canvas.
 *
 * Usage: node tools/mobile.e2e.mjs   (starts its own server on port 8130)
 *
 * Copyright 2014-2026, Hrvoje Abraham ahrvoje@gmail.com
 * Released under the MIT license.
 */

import puppeteer from "puppeteer-core";
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";

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

const PORT = 8130;

let failures = 0;
const check = (ok, title, detail) => {
    console.log(`${ok ? "ok  " : "FAIL"}  ${title}${detail ? "  " + JSON.stringify(detail) : ""}`);
    if (!ok) failures++;
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// repo-root server, so the /src asset paths resolve like on GitHub Pages
const server = spawn("py", ["-m", "http.server", String(PORT), "-d", "."], { stdio: "ignore" });
for (let i = 0; ; i++) {
    try {
        await fetch(`http://localhost:${PORT}/src/index.html`);
        break;
    } catch {
        if (i > 50) {
            console.error("server did not come up");
            process.exit(1);
        }
        await sleep(100);
    }
}

const browser = await puppeteer.launch({
    executablePath,
    headless: "new",
    args: ["--no-sandbox"],
});

try {
    const page = await browser.newPage();
    const consoleErrors = [];
    page.on("console", (msg) => { if (msg.type() === "error") consoleErrors.push(msg.text()); });
    page.on("pageerror", (error) => consoleErrors.push(String(error)));

    const pageOverflows = () => page.evaluate(() => {
        const doc = document.scrollingElement;
        return {
            vertical: doc.scrollHeight - window.innerHeight,
            horizontal: doc.scrollWidth - window.innerWidth,
        };
    });
    const visible = (selector) => page.$eval(selector,
        (e) => getComputedStyle(e).display !== "none" && e.offsetParent !== null);
    const display = (selector) => page.$eval(selector, (e) => getComputedStyle(e).display);

    // iPhone 15/16/17 Pro class: 393 CSS px wide, ~660 px visible with Safari chrome
    for (const [width, height, name] of [[393, 660, "iphone-pro"], [393, 852, "iphone-pro-pwa"]]) {
        await page.setViewport({ width, height, deviceScaleFactor: 3, isMobile: true, hasTouch: true });
        await page.goto(`http://localhost:${PORT}/src/index.html`, { waitUntil: "networkidle2" });
        await sleep(300);

        const overflow = await pageOverflows();
        check(overflow.vertical <= 0 && overflow.horizontal <= 0,
            `${name}: page fits without scrolling`, overflow);

        // header: small branding with the copyright block beside it, same height
        check(await visible("#logoCopy"), `${name}: header copyright shown`);
        const header = await page.evaluate(() => {
            const logo = document.getElementById("logo").getBoundingClientRect();
            const copy = document.getElementById("logoCopy").getBoundingClientRect();
            return {
                sameRow: copy.left > logo.right,
                copyHeight: copy.height,
                logoFont: parseFloat(getComputedStyle(document.getElementById("logo")).fontSize),
            };
        });
        check(header.sameRow, `${name}: copyright right of branding`);
        check(header.copyHeight <= 24, `${name}: copyright stays two thin lines`, header.copyHeight);
        check(header.logoFont <= 22, `${name}: branding reduced`, header.logoFont);
        check(await page.$eval("#rightFooter", (e) => getComputedStyle(e).display === "none"),
            `${name}: footer copyright hidden`);

        // footer: settings, examples & tests, tree view
        for (const id of ["#settingsButton", "#testsToggle", "#treeToggle"]) {
            check(await visible(id), `${name}: ${id} in footer`);
        }

        // board is scaled up but stays inside the viewport
        const board = await page.$eval("#gameCanvas", (e) => e.getBoundingClientRect().toJSON());
        check(board.width > 310 && board.right <= width && board.bottom < height,
            `${name}: board scaled within viewport`, { width: board.width });

        // taps on the scaled canvas must map to the right fields: play moves
        // until the move counter advances (a random board always has groups)
        await page.click("#startButton");
        await sleep(100);
        let moves = 0;
        for (let i = 0; i < 30 && moves === 0; i++) {
            const x = board.x + board.width * (0.08 + 0.84 * ((i * 7) % 30) / 30);
            const y = board.y + board.height * (0.08 + 0.84 * ((i * 11) % 30) / 30);
            await page.mouse.click(x, y);
            await sleep(50);
            moves = await page.$eval("#moveValue", (e) => parseInt(e.textContent, 10) || 0);
        }
        check(moves > 0, `${name}: scaled board taps play moves`, { moves });

        // the engine is on by default — its panel and all content on one page
        await sleep(1200);
        check(!(await page.$eval("#engineSection", (e) => e.hidden)), `${name}: engine section shown`);
        const engineOverflow = await pageOverflows();
        check(engineOverflow.vertical <= 0, `${name}: engine analysis fits the page`, engineOverflow);
        const listBottom = await page.evaluate(() => {
            const rows = document.querySelectorAll("#engineList .engineRow");
            const status = document.getElementById("engineStatus").getBoundingClientRect();
            return {
                rows: rows.length,
                clipped: [...rows].some((r) => r.getBoundingClientRect().bottom > status.top + 1),
            };
        });
        check(listBottom.rows > 0 && !listBottom.clipped,
            `${name}: suggestions fit above the telemetry`, listBottom);

        // tree toggle swaps the tree in for the engine panel, and back
        await page.click("#treeToggle");
        await sleep(100);
        check(await display("#treePanel") !== "none", `${name}: tree shown when toggled on`);
        check(await display("#engineSection") === "none", `${name}: engine hidden while tree on`);
        const treeOverflow = await pageOverflows();
        check(treeOverflow.vertical <= 0, `${name}: tree view fits the page`, treeOverflow);
        const treeRect = await page.$eval("#treePanel", (e) => e.getBoundingClientRect().toJSON());
        check(treeRect.height > 60, `${name}: tree got the leftover space`, { height: treeRect.height });
        await page.click("#treeToggle");
        await sleep(100);
        check(await display("#treePanel") === "none", `${name}: tree hidden when toggled off`);
        check(await display("#engineSection") !== "none", `${name}: engine back when tree off`);
    }

    // desktop stays on the classic layout
    await page.setViewport({ width: 1400, height: 900, deviceScaleFactor: 1, isMobile: false, hasTouch: false });
    await page.goto(`http://localhost:${PORT}/src/index.html`, { waitUntil: "networkidle2" });
    await sleep(300);
    check(await display("#treeToggle") === "none", "desktop: no tree toggle");
    check(await display("#logoCopy") === "none", "desktop: no header copyright");
    check(await visible("#rightFooter"), "desktop: footer copyright shown");
    check(await display("#treePanel") !== "none", "desktop: tree always visible");
    const desktopBoard = await page.$eval("#gameCanvas", (e) => e.getBoundingClientRect().width);
    check(desktopBoard === 310, "desktop: board keeps its size", { width: desktopBoard });

    check(consoleErrors.length === 0, "no console errors", consoleErrors.slice(0, 3));
} finally {
    await browser.close();
    server.kill();
}

process.exit(failures === 0 ? 0 : 1);
