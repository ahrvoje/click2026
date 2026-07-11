/**
 * Click2026 — UI controller: canvas rendering, timers, autoplay and replay controls.
 *
 * Copyright 2014-2026, Hrvoje Abraham ahrvoje@gmail.com
 * Released under the MIT license.
 * https://opensource.org/licenses/MIT
 *
 * Date: Fri Aug 08, 2014
 *       Sat Jul 11, 2026 - modernized to ES module, zero dependencies
 */

import { Game } from "./game.js";
import { EngineUI } from "./engine-ui.js";

const examples = [
    "?position=544341454153245551352111315534254113553554342242333515335513533415541542111541422113121311534345113215252332331311244443442542241513343551454125&moves=65,54,21,43,31,42,30,29,17,15,13,13,37,24,25,24,14,13,14,26,26,38,38,54,66,78,89,88,88,77,87,87,73,84,60,37,36,12,1,0,12&times=533,929,374,344,492,642,406,218,320,236,178,414,344,266,344,352,484,586,188,264,258,430,1242,336,679,611,217,455,358,321,171,524,273,235,905,180,406,414,156,320",
    "?position=544341454153245551352111315534254113553554342242333515335513533415541542111541422113121311534345113215252332331311244443442542241513343551454125&moves=22,45,44,31,42,30,30,29,17,5,4,13,13,25,24,24,39,50,39,38,51,36,49,49,48,60,48,24,37,38,51,61,52,61,61,49,49,24,36,26,14,25,0,0&times=169,172,360,149,156,180,180,171,180,188,509,250,468,287,197,836,298,406,186,422,282,304,156,281,251,290,203,984,187,1250,446,1062,774,374,148,492,766,142,452,282,313,280,149",
    "?position=325543113314113135211541443415522322133121452555454312541423142452333321342251314552432544244431224151231425333345115312311242234331554443232431&moves=34,19,29,20,6,17,14,17,27,26,13,61,62,61,61,62,61,60,52,84,84,60,63,60,60,49,49,49,36,12,12,12,13,25,12,41,51,39,52,52,51,51,39,49,36,24,25,24&times=529,648,453,202,172,462,562,373,697,366,1196,437,399,303,401,663,180,1186,1188,446,1203,414,524,290,492,616,704,242,446,156,296,367,407,467,1361,344,983,399,180,352,421,600,298,188,594,367,171",
];

const colors = {
    backgroundColor: "#000000",
    playColors: ["#FF0000", "#00BF00", "#0000FF", "#EFEF00", "#00DFFF"],
    highlightColor: "#FFCC66",
};

// board geometry (px): 12x12 fields, 25px grid pitch, 5px board margin
const CANVAS_SIZE = 310;
const FIELD_PITCH = 25;
const BOARD_MARGIN = 5;

// display timer refresh ~60 fps, autoplay move scheduler polls at 10 ms —
// these values shape the replay timing precision, keep them
const TIMER_INTERVAL_MS = 17;
const AUTOPLAY_INTERVAL_MS = 10;

// clicks faster than this are treated as one (debounces double-fired events)
const MIN_DOUBLE_CLICK_MS = 5;

let game = null;
let canvas = null;
let ctx = null;
let updateTimerInterval = null;
let autoPlayTimerInterval = null;
let autoPlayGameStartTime = null;
let autoPlaySystemStartTime = null;
let lastClickTime = null;

const el = (id) => document.getElementById(id);

//
// rendering
//

function drawBackground() {
    ctx.fillStyle = colors.backgroundColor;
    ctx.fillRect(0, 0, CANVAS_SIZE, CANVAS_SIZE);
}

function drawField(i, j, color) {
    ctx.beginPath();
    ctx.rect(FIELD_PITCH * i + 6, 300 - FIELD_PITCH * (j + 1) + 6, 23, 23);
    ctx.stroke();

    ctx.fillStyle = color;
    ctx.fill();
}

function highlightGroup(group) {
    const position = game.getCurrentPosition();

    ctx.strokeStyle = colors.highlightColor;
    ctx.lineWidth = 4;

    for (const [i, j] of group) {
        drawField(i, j, colors.playColors[position[i][j] - 1]);
    }
}

function drawAllFields() {
    const { Status } = Game;

    drawBackground();

    ctx.lineWidth = 4;
    ctx.strokeStyle = colors.backgroundColor;

    let position;
    if (game.getStatus() === Status.Ready) {
        position = game.getStartPosition();
    } else if ([Status.Play, Status.Over, Status.AutoPlay].includes(game.getStatus())) {
        position = game.getCurrentPosition();
    } else {
        return;
    }

    if (position?.[0] === undefined) {
        return;
    }

    for (let i = 0; i < 12; i++) {
        // stop drawing at the empty part of the board
        if (position[i][0] === 0) {
            break;
        }

        for (let j = 0; j < 12; j++) {
            const color = position[i][j];

            // stop drawing this column at its empty part
            if (color === 0) {
                break;
            }

            drawField(i, j, colors.playColors[color - 1]);
        }
    }

    if (game.getStatus() === Status.Over || game.getStatus() === Status.AutoPlay) {
        highlightGroup(game.getNextMoveGroup());
    }

    EngineUI.drawOverlays(ctx);
}

// the position currently shown on the board as engine bytes (column-major,
// index = column * 12 + row), or null when nothing analyzable is shown
function shownBoardBytes() {
    const { Status } = Game;

    let position = null;
    if (game.getStatus() === Status.Ready) {
        position = game.getStartPosition();
    } else if ([Status.Play, Status.Over, Status.AutoPlay].includes(game.getStatus())) {
        position = game.getCurrentPosition();
    }

    if (position?.[0] === undefined) {
        return null;
    }

    const bytes = new Uint8Array(144);
    for (let i = 0; i < 12; i++) {
        for (let j = 0; j < 12; j++) {
            bytes[i * 12 + j] = position[i][j];
        }
    }

    return bytes;
}

//
// status row
//

function updateTimer() {
    const now = Date.now();
    const currentTime = game.getStatus() === Game.Status.AutoPlay
        ? (now - autoPlaySystemStartTime + autoPlayGameStartTime) / 1000
        : (now - game.getStartTime()) / 1000;

    el("timeValue").textContent = String(currentTime);
}

function updateTimeText() {
    const currentMoveTime = game.getCurrentMove() === 0 ? 0 : game.getCurrentMoveTime();
    el("timeValue").textContent = currentMoveTime ? String(currentMoveTime / 1000) : "0";
}

function updateScore() {
    el("scoreValue").textContent = game.getScore();
}

function updateMove() {
    el("moveValue").textContent = `${game.getCurrentMove()} / ${game.getMoves().length}`;
}

function refreshInterface() {
    drawAllFields();
    updateTimeText();
    updateScore();
    updateMove();
}

//
// controls
//

const showButtons = () => el("control").classList.remove("disabled");
const hideButtons = () => el("control").classList.add("disabled");

function prepareInterface() {
    clearInterval(updateTimerInterval);
    clearInterval(autoPlayTimerInterval);
    showButtons();
    drawAllFields();
    el("timeValue").textContent = "0";
    el("scoreValue").textContent = game.getScore();
    el("moveValue").textContent = `0 / ${game.getMoves().length}`;
    el("autoPauseButton").hidden = true;
    el("autoPlayButton").hidden = false;
    EngineUI.onPositionChanged();
}

function gameFromString(gameString) {
    game = new Game(gameString);
    prepareInterface();
}

function getMousePos(event) {
    const rect = canvas.getBoundingClientRect();
    return {
        x: Math.floor((event.clientX - rect.left - BOARD_MARGIN) / FIELD_PITCH),
        y: 11 - Math.floor((event.clientY - rect.top - BOARD_MARGIN) / FIELD_PITCH),
    };
}

function playField(field) {
    if (game.playMove(field)) {
        drawAllFields();
        updateScore();
        updateMove();
        EngineUI.onPositionChanged();
    }

    if (game.getStatus() === Game.Status.Over) {
        clearInterval(updateTimerInterval);

        // make sure timer shows the exact time of the last move played
        updateTimeText();
        showButtons();
    }
}

function processClick(event) {
    const { x, y } = getMousePos(event);
    playField([x, y]);
}

// engine hook: clicking a suggested move plays it exactly like a board click,
// including the first-click transition that starts a fresh game
function playEngineMove(field) {
    if (game.getStatus() === Game.Status.Ready) {
        hideButtons();
        game.startGame();
        lastClickTime = game.getStartTime();

        updateTimerInterval = setInterval(updateTimer, TIMER_INTERVAL_MS);
        updateScore();
        updateMove();
        EngineUI.onPositionChanged();
    }

    if (game.getStatus() === Game.Status.Play) {
        playField(field);
        lastClickTime = Date.now();
    }
}

function processMouseWheel(delta) {
    // mouse wheel rewinding enabled only when there is a recording to navigate
    if (delta === 0 || !ensureNavigable()) {
        return;
    }

    game.rewindToMove(game.getCurrentMove() + (delta < 0 ? 1 : -1));
    refreshInterface();
    EngineUI.onPositionChanged();
}

function autoPlayMove() {
    const autoPlayTime = Date.now() - autoPlaySystemStartTime + autoPlayGameStartTime;
    updateTimer();

    if (autoPlayTime >= game.getTimes()[game.getCurrentMove()]) {
        game.playNextMove();
        drawAllFields();
        updateMove();
        updateScore();
        EngineUI.onPositionChanged();
    }

    if (game.getCurrentMove() === game.getMoves().length) {
        stopAutoPlay();
    }
}

//
// public API
//

export function onCanvasClick(event) {
    let firstClick = false;

    if (game.getStatus() === Game.Status.Ready) {
        hideButtons();
        game.startGame();
        lastClickTime = game.getStartTime();

        updateTimerInterval = setInterval(updateTimer, TIMER_INTERVAL_MS);
        updateScore();
        updateMove(); // starting manual play resets the recording, so refresh the counter
        EngineUI.onPositionChanged();

        firstClick = true;
    }

    if (game.getStatus() === Game.Status.Play) {
        const currentTime = Date.now();

        if (firstClick || currentTime - lastClickTime > MIN_DOUBLE_CLICK_MS) {
            processClick(event);
        }

        lastClickTime = currentTime;
    }
}

export function startNewGame() {
    game = new Game();
    prepareInterface();
}

export function replayStartPosition() {
    game.replay();
    prepareInterface();
}

export function stopAutoPlay() {
    el("autoPauseButton").hidden = true;
    el("autoPlayButton").hidden = false;
    clearInterval(autoPlayTimerInterval);
    updateTimeText();
    game.setStatus(Game.Status.Over);
}

export function autoPlay() {
    ensureNavigable();

    if (game.getStatus() === Game.Status.Over) {
        // exit if game is already at the end
        if (game.getCurrentMove() === game.getMoves().length) {
            return;
        }

        autoPlayGameStartTime = game.getCurrentMove() > 0 ? game.getTimes()[game.getCurrentMove() - 1] : 0;

        el("autoPlayButton").hidden = true;
        el("autoPauseButton").hidden = false;
        autoPlayTimerInterval = setInterval(autoPlayMove, AUTOPLAY_INTERVAL_MS);
        autoPlaySystemStartTime = Date.now();
        game.setStatus(Game.Status.AutoPlay);
    } else if (game.getStatus() === Game.Status.AutoPlay) {
        // game is autoplaying and should be paused
        stopAutoPlay();
    }
}

// rewinding is only meaningful when there is a recording to navigate; guarding here
// keeps a fresh game from being force-switched to the Over state
const canRewind = () => game.getStatus() === Game.Status.Over || game.getStatus() === Game.Status.AutoPlay;

// after Replay the game sits in Ready with its recording kept — materialize it at
// move 0 so navigation, autoplay and wheel rewinding work immediately again
function ensureNavigable() {
    if (game.getStatus() === Game.Status.Ready && game.getMoves().length > 0) {
        game.rewindToMove(0);
        game.setStatus(Game.Status.Over);
    }
    return canRewind();
}

export function rewindBackward() {
    if (!ensureNavigable()) {
        return;
    }

    game.rewindToMove(0);
    stopAutoPlay();
    refreshInterface();
    EngineUI.onPositionChanged();
}

export function rewindForward() {
    if (!ensureNavigable()) {
        return;
    }

    game.rewindToMove(game.getMoves().length);
    stopAutoPlay();
    refreshInterface();
    EngineUI.onPositionChanged();
}

export function importGame(importedString) {
    if (importedString !== "" && importedString !== null && importedString !== undefined) {
        gameFromString(importedString);
    }
}

export function promptGameLink() {
    window.prompt("Copy link to clipboard (Ctrl+C)",
        String(document.location).split("?", 1)[0] + "?" + game.getString());
}

export function loadExample(exampleIndex) {
    if (exampleIndex >= 0 && exampleIndex < examples.length) {
        gameFromString(examples[exampleIndex]);
    }
}

export function toggleEngine() {
    EngineUI.toggle();
}

export function init() {
    canvas = el("gameCanvas");
    ctx = canvas.getContext("2d");

    EngineUI.init({
        getBoardBytes: shownBoardBytes,
        redraw: drawAllFields,
        playColors: colors.playColors,
        playMove: playEngineMove,
    });

    canvas.addEventListener("mousedown", onCanvasClick);

    // wheel rewinding; preventDefault keeps the page from scrolling while over the board
    canvas.addEventListener("wheel", (event) => {
        event.preventDefault();
        processMouseWheel(-event.deltaY);
    }, { passive: false });

    gameFromString(document.location.search);
}
