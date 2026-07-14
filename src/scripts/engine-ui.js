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

import { canonicalBlock, LETTERS } from "./board.js";
import { EngineWorkerPool } from "./engine/pool.js?build=20260714-regress2";

const TOP_N = 5;
const SUGGESTED_MODE_TOP_5 = "top5";
const SUGGESTED_MODE_TOP_5_NONZERO = "top5-nonzero";
const SUGGESTED_MODE_ALL = "all";
// Keep the module worker, its static imports and the compiled WASM on one
// cache generation. A stale dependency makes a module worker fail before any
// of its error-reporting code can run, yielding only an opaque ErrorEvent.
const ENGINE_ASSET_VERSION = "20260714-regress2";

// rank accent colors, shared by the list rows and the board outlines; picked
// to stay distinguishable from the five play colors and the replay highlight
const RANK_COLORS = ["#FFFFFF", "#FF9E2C", "#FF4DFF", "#B7BDC4", "#9C6B30"];

// board geometry twin of drawField() in click.js: the outline lattice runs
// through the middle of the 2 px gaps between neighboring blocks
const FIELD_PITCH = 25;
const EDGE_LEFT = 5;
const EDGE_BOTTOM = 305;

let hooks = null;          // { getBoardBytes, redraw, playColors, playMove, onResult }
let enabled = false;
let markersOn = true;      // group outlines on the board — toggleable, they distract in real play
let worker = null;
let positionId = 0;
let lastKey = null;
let result = null;         // latest worker result for the current position
let gpuState = "off";
let hoverIndex = null;
let suggestedMovesMode = SUGGESTED_MODE_TOP_5;

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
        // best score of the analyzed position — the game records it on the shown node;
        // a terminal position's own remaining count is its exact score
        hooks.onResult?.(msg.moves.length > 0 ? msg.moves[0].score : msg.remaining);
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
    const workerURL = new URL("./engine/worker.js", import.meta.url);
    workerURL.searchParams.set("build", ENGINE_ASSET_VERSION);
    const requested = Number.parseInt(new URL(location.href).searchParams.get("engineWorkers") ?? "", 10);
    worker = new EngineWorkerPool(workerURL, Number.isFinite(requested)
        ? { laneCount: Math.max(1, Math.min(16, requested)) }
        : undefined);
    worker.onmessage = onWorkerMessage;
    worker.onerror = (event) => {
        renderStatus("engine failed to start — see console");
        const location = event.filename
            ? `${event.filename}:${event.lineno ?? 0}:${event.colno ?? 0}` : "unknown source";
        console.error(`engine worker failed at ${location}:`, event.message || event);
    };
}

//
// rendering — list, status, canvas overlays
//

function renderStatus(text) {
    const status = el("engineStatus");
    status.removeAttribute("aria-label");
    status.removeAttribute("title");
    status.textContent = text;
}

let rowsSig = null; // content signature of the rendered rows, to skip no-op rebuilds

function clearList() {
    el("engineList").replaceChildren();
    hoverIndex = null;
    rowsSig = null;
}

function span(className, text) {
    const s = document.createElement("span");
    s.className = className;
    if (text !== undefined) s.textContent = text;
    return s;
}

function formatCount(n) {
    if (n >= 1e9) return (n / 1e9).toFixed(1) + "B";
    if (n >= 1e6) return (n / 1e6).toFixed(1) + "M";
    if (n >= 1e3) return (n / 1e3).toFixed(0) + "k";
    return String(Math.round(n));
}

function statNumber(...values) {
    for (const value of values) {
        if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value;
    }
    return null;
}

function formatDuration(ms) {
    if (ms < 1000) return `${Math.round(ms)}ms`;

    const seconds = ms / 1000;
    if (seconds < 60) return seconds.toFixed(seconds >= 10 ? 0 : 1) + "s";

    const wholeSeconds = Math.floor(seconds);
    const minutes = Math.floor(wholeSeconds / 60);
    const remainingSeconds = wholeSeconds % 60;
    if (minutes < 60) return `${minutes}m${String(remainingSeconds).padStart(2, "0")}s`;

    const hours = Math.floor(minutes / 60);
    return `${hours}h${String(minutes % 60).padStart(2, "0")}m`;
}

function processorRow(className, label, pps, positions, share, title) {
    const row = span(`engineStatusRow engineProcessorRow ${className}`);
    row.title = title;
    row.append(
        span("engineHwLabel", label),
        span("engineHwRate", pps === null ? "—" : `${formatCount(pps)} pos/s`),
        span("engineHwPositions", positions === null ? "—" : `${formatCount(positions)} pos`),
        span("engineHwShare", `${share}%`),
    );
    return row;
}

export function selectSuggestedMoves(moves, mode = SUGGESTED_MODE_TOP_5) {
    if (mode === SUGGESTED_MODE_ALL) return moves.slice();

    const selected = moves.slice(0, TOP_N);
    if (mode === SUGGESTED_MODE_TOP_5_NONZERO) {
        const firstNonzero = moves.find((move) => move.score > 0);
        if (firstNonzero && !selected.includes(firstNonzero)) selected.push(firstNonzero);
    }
    return selected;
}

function rankColor(index) {
    return RANK_COLORS[index] ?? `hsl(${(210 + index * 47) % 360}, 75%, 55%)`;
}

function renderResult() {
    const list = el("engineList");
    const moves = selectSuggestedMoves(result.moves, suggestedMovesMode);

    if (moves.length === 0) {
        clearList();
        renderStatus(result.remaining === 0 ? "board cleared ★" : `game over — ${result.remaining} left`);
        return;
    }

    // rebuild the rows only when their content changed — most posts only move
    // the telemetry numbers, and keeping the nodes makes row clicks reliable
    const sig = moves.map((m) => `${m.cell}:${m.score}:${m.size}:${m.exact ? 1 : 0}`).join("|");
    if (sig === rowsSig) {
        renderStats();
        return;
    }
    rowsSig = sig;

    const rows = moves.map((move, index) => {
        const row = document.createElement("li");
        row.className = "engineRow";
        row.title = `click to play — best line found leaves ${move.score}, group of ${move.size}` +
            (move.exact ? ", proven optimal" : "");

        const rank = span("engineRank");
        rank.style.borderColor = rankColor(index);

        const square = span("engineSquare");
        square.style.backgroundColor = hooks.playColors[move.color - 1];

        // the suggested block in the same A-L notation the position tree uses
        const block = canonicalBlock(move.cells);

        row.append(
            rank,
            square,
            span("engineLoc", LETTERS[block[0]] + LETTERS[block[1]]),
            span("engineScore", move.score === 0 ? "0 ★" : String(move.score)),
            span("engineSize", "×" + move.size),
            span("engineExact", move.exact ? "✓" : ""),
        );

        row.addEventListener("mouseenter", () => { hoverIndex = index; hooks.redraw(); });
        row.addEventListener("mouseleave", () => { hoverIndex = null; hooks.redraw(); });
        row.addEventListener("click", () => hooks.playMove([move.x, move.y]));
        return row;
    });

    list.replaceChildren(...rows);
    renderStats();
}

// Three aligned logical rows: overall progress, CPU work and GPU work. New
// workers provide the detailed counters; the nodes/nps fallback
// keeps cached/older worker builds readable during a rolling GitHub Pages load.
function renderStats() {
    const s = result.stats;
    const cpu = s.cpu && typeof s.cpu === "object" ? s.cpu : {};
    const gpuStats = s.gpuStats && typeof s.gpuStats === "object" ? s.gpuStats : {};
    const hasDetailedStats = s.cpu !== undefined || s.gpuStats !== undefined;

    const cpuPositions = statNumber(cpu.positions, s.nodes) ?? 0;
    const cpuPps = statNumber(cpu.pps, s.nps) ?? 0;
    const cpuWorkers = statNumber(cpu.workers);
    const beamPositions = statNumber(cpu.beamPositions);
    const exactPositions = statNumber(cpu.exactPositions);
    const cpuPlayoutPositions = statNumber(cpu.playoutPositions);

    const gpuPositions = statNumber(gpuStats.positions);
    const gpuPps = statNumber(gpuStats.pps);
    const gpuActivePps = statNumber(gpuStats.activePps);
    const gpuDuty = statNumber(gpuStats.duty);
    const gpuPlayouts = statNumber(gpuStats.playouts);
    const gpuBatches = statNumber(gpuStats.batches);
    const gpuActiveMs = statNumber(gpuStats.activeMs);
    const gpuProfile = typeof gpuStats.profile === "string" ? gpuStats.profile : null;
    const gpuAdapter = gpuStats.adapter && typeof gpuStats.adapter === "object"
        ? [gpuStats.adapter.vendor, gpuStats.adapter.architecture,
            gpuStats.adapter.device, gpuStats.adapter.description]
            .filter((value, index, values) => value && values.indexOf(value) === index)
            .join(" ")
        : "";

    const totalPositions = statNumber(
        s.totalPositions,
        hasDetailedStats ? cpuPositions + (gpuPositions ?? 0) : null,
        s.nodes,
    ) ?? 0;
    const elapsedMs = statNumber(s.elapsed) ?? 0;
    const totalPps = statNumber(s.totalPps,
        elapsedMs > 0 ? totalPositions / elapsedMs * 1000 : null) ?? 0;
    const elapsedLabel = formatDuration(elapsedMs);
    const attributedPositions = cpuPositions + (gpuPositions ?? 0);
    const cpuShare = attributedPositions > 0
        ? Math.round(cpuPositions / attributedPositions * 100) : 100;
    const gpuShare = 100 - cpuShare;

    const stateLabel = {
        optimal: "optimal ✓",
        proven: "proven ✓",
        settled: "settled",
    }[s.state] ?? "analyzing…";
    const overview = span("engineStatusRow engineStatusOverview");
    const speed = span("engineStRate", `${formatCount(totalPps)} pos/s`);
    speed.title = `combined wall-average throughput: ${Math.round(totalPps).toLocaleString()} positions/s`;
    const total = span("engineStNodes engineStTotal", `${formatCount(totalPositions)} pos`);
    total.title = `combined positions evaluated: ${Math.round(totalPositions).toLocaleString()}`;
    const elapsed = span("engineStTime", `time ${elapsedLabel}`);
    elapsed.title = `analysis elapsed time: ${elapsedLabel}`;
    overview.append(
        span("engineStState", stateLabel),
        speed,
        total,
        elapsed,
    );

    const workerSuffix = cpuWorkers !== null && cpuWorkers > 1 ? `×${Math.round(cpuWorkers)}` : "";
    const cpuLabel = `CPU${workerSuffix}`;
    const cpuTitle = [
        `CPU${cpuWorkers !== null ? ` workers: ${Math.round(cpuWorkers)}` : ""}`,
        `search positions: ${Math.round(cpuPositions).toLocaleString()} (work visits, not unique states)`,
        `wall-average throughput: ${Math.round(cpuPps).toLocaleString()} positions/s`,
        beamPositions > 0 ? `beam positions: ${Math.round(beamPositions).toLocaleString()}` : "",
        exactPositions > 0 ? `exact positions: ${Math.round(exactPositions).toLocaleString()}` : "",
        cpuPlayoutPositions > 0
            ? `playout positions: ${Math.round(cpuPlayoutPositions).toLocaleString()}` : "",
    ].filter(Boolean).join("; ");

    const cpuRow = processorRow("engineHwCpu", cpuLabel,
        cpuPps, cpuPositions, cpuShare, cpuTitle);

    let gpuAccessible;
    let gpuRow;
    if (s.gpu === "on") {
        const gpuTitle = [
            "GPU active",
            gpuProfile ? `profile: ${gpuProfile}` : "",
            gpuAdapter ? `adapter: ${gpuAdapter}` : "",
            gpuPositions !== null ? `positions: ${Math.round(gpuPositions).toLocaleString()}` : "",
            gpuPps !== null ? `wall-average contribution: ${Math.round(gpuPps).toLocaleString()} positions/s` : "",
            gpuActivePps !== null
                ? `active throughput: ${Math.round(gpuActivePps).toLocaleString()} positions/s` : "",
            gpuDuty !== null ? `dispatch duty cycle: ${Math.round(gpuDuty)}%` : "",
            gpuPlayouts > 0 ? `playouts: ${Math.round(gpuPlayouts).toLocaleString()}` : "",
            gpuBatches > 0 ? `batches: ${Math.round(gpuBatches).toLocaleString()}` : "",
            gpuActiveMs > 0 ? `active time: ${formatDuration(gpuActiveMs)}` : "",
        ].filter(Boolean).join("; ");
        gpuAccessible = gpuTitle;
        gpuRow = processorRow("engineHwGpu", "GPU",
            gpuPps ?? 0, gpuPositions ?? 0, gpuShare, gpuTitle);
    } else {
        const failed = s.gpu === "failed";
        gpuAccessible = failed
            ? "GPU off after an initialization or verification failure" : "GPU off; WebGPU unavailable";
        gpuRow = processorRow("engineHwGpu engineHwGpuOff", "GPU",
            null, null, gpuShare,
            failed ? "GPU disabled after an initialization or verification failure" : "WebGPU unavailable");
    }

    const status = el("engineStatus");
    status.setAttribute("aria-label", [
        stateLabel,
        `width ${s.width}`,
        `depth ${s.depth}`,
        `total positions: ${Math.round(totalPositions).toLocaleString()}`,
        `combined wall-average throughput: ${Math.round(totalPps).toLocaleString()} positions/s`,
        `analysis elapsed time: ${elapsedLabel}`,
        cpuTitle,
        gpuAccessible,
    ].join("; "));
    status.replaceChildren(overview, cpuRow, gpuRow);
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

    // group-outline markers on the board can be switched off for real play
    toggleMarkers() {
        markersOn = !markersOn;
        el("markersButton").classList.toggle("active", markersOn);
        hooks.redraw();
    },

    setSuggestedMovesMode(mode) {
        const normalized = [SUGGESTED_MODE_TOP_5, SUGGESTED_MODE_TOP_5_NONZERO,
            SUGGESTED_MODE_ALL].includes(mode) ? mode : SUGGESTED_MODE_TOP_5;
        if (normalized === suggestedMovesMode) return;

        suggestedMovesMode = normalized;
        hoverIndex = null;
        rowsSig = null;
        if (result) renderResult();
        hooks?.redraw();
    },

    // called by the game controller at the end of every board repaint
    drawOverlays(ctx) {
        if (!enabled || !result || !markersOn) return;

        const moves = selectSuggestedMoves(result.moves, suggestedMovesMode);
        ctx.save();
        ctx.lineCap = "square";

        // draw in reverse so the best move's outline ends up on top
        for (let index = moves.length - 1; index >= 0; index--) {
            const emphasized = hoverIndex === index;
            ctx.strokeStyle = rankColor(index);
            ctx.lineWidth = emphasized ? 4 : 2.5;
            ctx.globalAlpha = hoverIndex === null || emphasized ? 0.95 : 0.25;
            strokeGroupOutline(ctx, moves[index].cells);
        }

        ctx.restore();
    },
};
