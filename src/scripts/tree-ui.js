/**
 * Click2026 — position tree UI: renders the game's move tree next to the board.
 *
 * One node per move: the move number in dark gray, the color played as a small
 * square, the A-L column/row label of the canonical block (the group's
 * lowest-leftmost field) and the best engine score recorded for the position.
 * Nodes flow horizontally and wrap like chess notation: variants break in right
 * after the position they branch from, each on a new row indented one step per
 * depth and carrying its chronological creation number in front of the
 * indentation, then the interrupted
 * line resumes on a fresh row at its own indent — so every move sits on a row
 * of the line it belongs to. A node whose position has no legal move left
 * carries a dark game-over bar on its right. Clicking a node reloads its
 * position on the board.
 *
 * Copyright 2014-2026, Hrvoje Abraham ahrvoje@gmail.com
 * Released under the MIT license.
 * https://opensource.org/licenses/MIT
 *
 * Date: Sat Jul 11, 2026
 */

import { LETTERS } from "./board.js";

const SVG_NS = "http://www.w3.org/2000/svg";

// node box geometry and the flow-layout metrics (px): nodes lay out at a fixed
// horizontal pitch and wrap within the fixed content width; each variant depth
// indents its rows by a third of a node width
const NODE_W = 68;
const NODE_H = 18;
const ROW_H = 20;
const PITCH = NODE_W + 4;
const INDENT = Math.round(NODE_W / 3);
const PAD = 6;
const CONTENT_W = 296; // fits the fixed 318px panel beside a vertical scrollbar
const DOUBLE_PRESS_MS = 500;

let container = null;   // scrollable element the SVG is rendered into
let playColors = null;
let onSelect = null;
let onReplay = null;

let lastGame = null;    // rebuild bookkeeping — see update()
let lastSig = null;
let lastFocus = null;
let lastPressedNode = null;
let lastPressedAt = -Infinity;

// Chess-notation flow layout. A line (a chain of first children) lays out
// horizontally and wraps into rows at its indent. When a move has alternatives,
// the variant chains break in right after the previous move, each on its own
// row indented one step deeper, and the line then resumes on a fresh row at
// its own indent, starting with that move — no move stays behind on the row
// of another line. A variant chain's chronological creation number (the game's
// variantNum) is exposed on the chain's first node (0 = main line). Exported
// for tests.
export function layoutTree(root, contentWidth = CONTENT_W) {
    const placed = new Map(); // node -> { row, x, variant }
    let row = 0;

    const placeChain = (start, indent) => {
        let x = PAD + indent;
        for (let node = start; node !== undefined; node = node.children[0]) {
            // alternatives break in right after the previous move; the line then
            // resumes on its own fresh row, beginning with the move they rival
            if (node !== start && node.parent.children.length > 1) {
                for (const variant of node.parent.children.slice(1)) {
                    row += 1;
                    placeChain(variant, indent + INDENT);
                }
                row += 1;
                x = PAD + indent;
            }
            if (x + NODE_W > contentWidth - PAD && x > PAD + indent) {
                row += 1;
                x = PAD + indent;
            }
            placed.set(node, { row, x, variant: node === start ? start.variantNum ?? 0 : 0 });
            x += PITCH;
        }
    };

    placeChain(root, 0);
    return placed;
}

function svgEl(tag, attrs) {
    const node = document.createElementNS(SVG_NS, tag);
    for (const [key, value] of Object.entries(attrs)) {
        node.setAttribute(key, value);
    }
    return node;
}

function moveNumber(node) {
    let n = 0;
    for (let p = node; p.parent !== null; p = p.parent) {
        n += 1;
    }
    return n;
}

export const TreeUI = {
    init(hooks) {
        container = hooks.container;
        playColors = hooks.playColors;
        onSelect = hooks.onSelect;
        onReplay = hooks.onReplay;
    },

    update(game) {
        const focus = game.getFocus();
        const replayNodes = new Set(game.getReplayNodes());
        replayNodes.add(game.getRoot());

        // engine results arrive at a high rate — skip the rebuild when nothing
        // visible changed, otherwise nodes get replaced mid-press (swallowing
        // clicks) and the scroll position fights the user
        let sig = "";
        const walk = (node) => {
            sig += (node.move === null ? "R" : LETTERS[node.move[0]] + LETTERS[node.move[1]]) +
                (node.score ?? "") + (node === focus ? "*" : "") +
                (replayNodes.has(node) ? "!" : "") + "(";
            for (const child of node.children) {
                walk(child);
            }
            sig += ")";
        };
        walk(game.getRoot());

        if (game === lastGame && sig === lastSig) {
            return;
        }
        lastGame = game;
        lastSig = sig;

        const placed = layoutTree(game.getRoot());

        let maxRow = 0;
        let maxX = 0;
        for (const { row, x } of placed.values()) {
            maxRow = Math.max(maxRow, row);
            maxX = Math.max(maxX, x);
        }

        const svg = svgEl("svg", {
            width: Math.max(CONTENT_W, maxX + NODE_W + PAD),
            height: 2 * PAD + maxRow * ROW_H + NODE_H,
        });

        let focusPlace = null;
        for (const [node, { row, x, variant }] of placed) {
            const g = svgEl("g", {
                class: "treeNode" + (node === focus ? " focus" : "") +
                    (replayNodes.has(node) ? " replay" : ""),
                transform: `translate(${x}, ${PAD + row * ROW_H})`,
            });

            g.append(svgEl("rect", { class: "treeBox", width: NODE_W, height: NODE_H, rx: 3 }));

            // the variant number sits in front of the indentation of the
            // chain's first node — variant 3's move 41 reads as 3m41
            if (variant > 0) {
                const num = svgEl("text", { class: "treeVariantNum", x: -3, y: 13, "text-anchor": "end" });
                num.textContent = String(variant);
                g.append(num);
            }

            if (node.move === null) {
                // the root is the start position — no move to label
                g.append(svgEl("circle", { class: "treeRootMark", cx: 9, cy: NODE_H / 2, r: 3.5 }));
            } else {
                const num = svgEl("text", { class: "treeMoveNum", x: 16, y: 13, "text-anchor": "end" });
                num.textContent = String(moveNumber(node));
                g.append(num);

                g.append(svgEl("rect", {
                    class: "treeSwatch", x: 19, y: 4, width: 10, height: 10,
                    fill: playColors[node.color - 1],
                }));

                const label = svgEl("text", { class: "treeLabel", x: 32, y: 13 });
                label.textContent = LETTERS[node.move[0]] + LETTERS[node.move[1]];
                g.append(label);
            }

            if (node.score !== null) {
                const score = svgEl("text", { class: "treeScore", x: NODE_W - 4, y: 13, "text-anchor": "end" });
                score.textContent = String(node.score);
                g.append(score);
            }

            // no legal move is left at this node — the game ends here
            if (node.over) {
                g.append(svgEl("line", {
                    class: "treeOverMark", x1: NODE_W + 3, y1: 1, x2: NODE_W + 3, y2: NODE_H - 1,
                }));
            }

            // mousedown, like the board — a rebuild between press and release
            // would swallow a full click
            g.addEventListener("mousedown", (event) => {
                const now = performance.now();
                let isDoublePress = false;
                if (event.button === 0) {
                    isDoublePress = lastPressedNode === node && now - lastPressedAt <= DOUBLE_PRESS_MS;
                    lastPressedNode = isDoublePress ? null : node;
                    lastPressedAt = isDoublePress ? -Infinity : now;
                } else {
                    lastPressedNode = null;
                    lastPressedAt = -Infinity;
                }

                onSelect(node);
                if (isDoublePress) {
                    onReplay?.(node);
                }
            });
            svg.append(g);

            if (node === focus) {
                focusPlace = { row, x };
            }
        }

        // rebuilding must never move the user's scroll position...
        const { scrollLeft, scrollTop } = container;
        container.replaceChildren(svg);
        container.scrollLeft = scrollLeft;
        container.scrollTop = scrollTop;

        // ...only an actual focus change reveals the focused node
        if (focusPlace !== null && focus !== lastFocus) {
            const x = focusPlace.x;
            const y = PAD + focusPlace.row * ROW_H;

            if (x < container.scrollLeft) {
                container.scrollLeft = Math.max(0, x - PAD);
            } else if (x + NODE_W > container.scrollLeft + container.clientWidth) {
                container.scrollLeft = x + NODE_W + PAD - container.clientWidth;
            }

            if (y < container.scrollTop) {
                container.scrollTop = Math.max(0, y - PAD);
            } else if (y + NODE_H > container.scrollTop + container.clientHeight) {
                container.scrollTop = y + NODE_H + PAD - container.clientHeight;
            }
        }
        lastFocus = focus;
    },
};
