/**
 * Click2026 — engine UI: toggle button state, top-moves list, board overlays.
 *
 * Main-thread side of the analysis engine. Owns the worker lifecycle, posts
 * the shown position whenever it changes, renders the ranked move list below
 * the control buttons and outlines the suggested groups on the canvas in the
 * matching rank colors — engine internals live in scripts/engine/.
 *
 * Copyright 2014-2026, Hrvoje Abraham ahrvoje@gmail.com
 * Released under the MIT license.
 * https://opensource.org/licenses/MIT
 *
 * Date: Sat Jul 11, 2026
 */

const TOP_N = 5;

// rank accent colors, shared by the list rows and the board outlines; picked
// to stay distinguishable from the five play colors and the replay highlight
const RANK_COLORS = ["#FFFFFF", "#FF9E2C", "#FF4DFF", "#B7BDC4", "#9C6B30"];

// board geometry twin of drawField() in click.js: the outline lattice runs
// through the middle of the 2 px gaps between neighboring blocks
const FIELD_PITCH = 25;
const EDGE_LEFT = 5;
const EDGE_BOTTOM = 305;

let hooks = null;          // { getBoardBytes, redraw, playColors }
let enabled = false;
let worker = null;
let positionId = 0;
let lastKey = null;
let result = null;         // latest worker result for the current position
let gpuState = "off";
let hoverIndex = null;

const el = (id) => document.getElementById(id);

//
// worker lifecycle
//

function onWorkerMessage(event) {
    const msg = event.data;

    if (msg.type === "ready") {
        gpuState = msg.gpu;
        if (!result) {
            renderStatus(lastKey === null ? "engine ready — no position" : "analyzing…");
        }
        return;
    }

    if (msg.type === "result") {
        if (msg.id !== positionId) return; // stale analysis of a previous position
        result = msg;
        renderResult();
        hooks.redraw();
        return;
    }

    if (msg.type === "error") {
        renderStatus("engine error — see console");
        console.error("engine worker:", msg.message);
    }
}

function startWorker() {
    worker = new Worker(new URL("./engine/worker.js", import.meta.url), { type: "module" });
    worker.onmessage = onWorkerMessage;
    worker.onerror = (event) => {
        renderStatus("engine failed to start — see console");
        console.error("engine worker:", event.message ?? event);
    };
}

//
// rendering — list, status, canvas overlays
//

function renderStatus(text) {
    el("engineStatus").textContent = text;
}

function clearList() {
    el("engineList").replaceChildren();
    hoverIndex = null;
}

function span(className, text) {
    const s = document.createElement("span");
    s.className = className;
    if (text !== undefined) s.textContent = text;
    return s;
}

function formatCount(n) {
    if (n >= 1e6) return (n / 1e6).toFixed(1) + "M";
    if (n >= 1e3) return (n / 1e3).toFixed(0) + "k";
    return String(Math.round(n));
}

function renderResult() {
    const list = el("engineList");
    const moves = result.moves.slice(0, TOP_N);

    if (moves.length === 0) {
        clearList();
        renderStatus(result.remaining === 0 ? "board cleared ★" : `game over — ${result.remaining} left`);
        return;
    }

    const rows = moves.map((move, index) => {
        const row = document.createElement("li");
        row.className = "engineRow";
        row.title = `best line found leaves ${move.score} — group of ${move.size}` +
            (move.exact ? " — proven optimal" : "");

        const rank = span("engineRank");
        rank.style.borderColor = RANK_COLORS[index];

        const square = span("engineSquare");
        square.style.backgroundColor = hooks.playColors[move.color - 1];

        row.append(
            rank,
            square,
            span("engineScore", move.score === 0 ? "0 ★" : String(move.score)),
            span("engineSize", "×" + move.size),
            span("engineExact", move.exact ? "✓" : ""),
        );

        row.addEventListener("mouseenter", () => { hoverIndex = index; hooks.redraw(); });
        row.addEventListener("mouseleave", () => { hoverIndex = null; hooks.redraw(); });
        return row;
    });

    list.replaceChildren(...rows);

    const s = result.stats;
    renderStatus(`${s.settled ? "complete — all moves proven" : "analyzing…"} · w${s.width} d${s.depth}` +
        ` · ${formatCount(s.nodes)} n · ${formatCount(s.nps)} n/s` +
        ` · ${{ on: "CPU+GPU", off: "CPU", failed: "CPU (GPU failed)" }[s.gpu]}`);
}

// strokes the boundary of a group (cells as [x, y]) along the block gaps
function strokeGroupOutline(ctx, cells) {
    const inGroup = new Set(cells.map(([x, y]) => x * 12 + y));
    const has = (x, y) => x >= 0 && x < 12 && y >= 0 && y < 12 && inGroup.has(x * 12 + y);

    ctx.beginPath();
    for (const [x, y] of cells) {
        const xL = FIELD_PITCH * x + EDGE_LEFT;
        const xR = xL + FIELD_PITCH;
        const yB = EDGE_BOTTOM - FIELD_PITCH * y;
        const yT = yB - FIELD_PITCH;

        if (!has(x - 1, y)) { ctx.moveTo(xL, yT); ctx.lineTo(xL, yB); }
        if (!has(x + 1, y)) { ctx.moveTo(xR, yT); ctx.lineTo(xR, yB); }
        if (!has(x, y - 1)) { ctx.moveTo(xL, yB); ctx.lineTo(xR, yB); }
        if (!has(x, y + 1)) { ctx.moveTo(xL, yT); ctx.lineTo(xR, yT); }
    }
    ctx.stroke();
}

//
// public API
//

export const EngineUI = {
    init(uiHooks) {
        hooks = uiHooks;
    },

    isOn() {
        return enabled;
    },

    toggle() {
        if (enabled) {
            enabled = false;
            worker?.terminate();
            worker = null;
            result = null;
            lastKey = null;
            el("engineButton").classList.remove("active");
            el("engineSection").hidden = true;
            hooks.redraw();
        } else {
            enabled = true;
            el("engineButton").classList.add("active");
            el("engineSection").hidden = false;
            clearList();
            renderStatus("starting engine…");
            startWorker();
            this.onPositionChanged();
        }
    },

    // called by the game controller whenever the shown position may have changed
    onPositionChanged() {
        if (!enabled) return;

        const board = hooks.getBoardBytes();
        if (!board) {
            lastKey = null;
            result = null;
            clearList();
            renderStatus("no position");
            return;
        }

        const key = board.join(",");
        if (key === lastKey) return; // same board — keep the running analysis
        lastKey = key;
        positionId++;
        result = null; // old suggestions no longer match the board — drop them
        clearList();
        renderStatus("analyzing…");
        worker.postMessage({ type: "analyze", id: positionId, board });
    },

    // called by the game controller at the end of every board repaint
    drawOverlays(ctx) {
        if (!enabled || !result) return;

        const moves = result.moves.slice(0, TOP_N);
        ctx.save();
        ctx.lineCap = "square";

        // draw in reverse so the best move's outline ends up on top
        for (let index = moves.length - 1; index >= 0; index--) {
            const emphasized = hoverIndex === index;
            ctx.strokeStyle = RANK_COLORS[index];
            ctx.lineWidth = emphasized ? 4 : 2.5;
            ctx.globalAlpha = hoverIndex === null || emphasized ? 0.95 : 0.25;
            strokeGroupOutline(ctx, moves[index].cells);
        }

        ctx.restore();
    },
};
