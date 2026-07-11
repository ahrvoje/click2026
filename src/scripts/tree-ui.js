/**
 * Click2026 — position tree UI: renders the game's move tree next to the board.
 *
 * One node per move: the color played as a small square, the A-L column/row label
 * of the canonical block (the group's lowest-leftmost field) and the best engine
 * score recorded for the position. The main line runs vertically, variants branch
 * horizontally to the right. Clicking a node reloads its position on the board.
 *
 * Copyright 2014-2026, Hrvoje Abraham ahrvoje@gmail.com
 * Released under the MIT license.
 * https://opensource.org/licenses/MIT
 *
 * Date: Sat Jul 11, 2026
 */

import { LETTERS } from "./board.js";

const SVG_NS = "http://www.w3.org/2000/svg";

// node box geometry and the row/column lattice pitch (px)
const NODE_W = 54;
const NODE_H = 18;
const COL_W = 62;
const ROW_H = 25;
const PAD = 6;

let container = null;   // scrollable element the SVG is rendered into
let playColors = null;
let onSelect = null;

let lastGame = null;    // rebuild bookkeeping — see update()
let lastSig = null;
let lastFocus = null;

// Band layout with no connectors crossing through chains or nodes. Every branch
// (a chain of first children) occupies one column and every variant subtree a
// contiguous column band right of its parent's column. Branch points hand out
// bands bottom-up, so a lower variant sits right next to its parent chain and
// variants branching higher up shift right to make room for it. A variant elbow
// therefore only ever passes over bands of deeper branch points, whose nodes all
// live strictly below the elbow's row gap — no line crosses a chain or a node.
// Exported for tests.
export function layoutTree(root) {
    const placed = new Map(); // node -> { row, col }

    // returns the rightmost column used by the subtree band
    const placeBranch = (node, row, colStart) => {
        const chain = [node];
        for (let n = node; n.children.length > 0; ) {
            n = n.children[0];
            chain.push(n);
        }
        chain.forEach((n, k) => placed.set(n, { row: row + k, col: colStart }));

        // lower branch points claim their bands first — higher variants shift right
        let nextFree = colStart + 1;
        for (let k = chain.length - 1; k >= 0; k--) {
            for (const variant of chain[k].children.slice(1)) {
                nextFree = placeBranch(variant, row + k + 1, nextFree) + 1;
            }
        }

        return nextFree - 1;
    };

    placeBranch(root, 0, 0);
    return placed;
}

function svgEl(tag, attrs) {
    const node = document.createElementNS(SVG_NS, tag);
    for (const [key, value] of Object.entries(attrs)) {
        node.setAttribute(key, value);
    }
    return node;
}

export const TreeUI = {
    init(hooks) {
        container = hooks.container;
        playColors = hooks.playColors;
        onSelect = hooks.onSelect;
    },

    update(game) {
        const focus = game.getFocus();

        // engine results arrive at a high rate — skip the rebuild when nothing
        // visible changed, otherwise nodes get replaced mid-press (swallowing
        // clicks) and the scroll position fights the user
        let sig = "";
        const walk = (node) => {
            sig += (node.move === null ? "R" : LETTERS[node.move[0]] + LETTERS[node.move[1]]) +
                (node.score ?? "") + (node === focus ? "*" : "") + "(";
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
        let maxCol = 0;
        for (const { row, col } of placed.values()) {
            maxRow = Math.max(maxRow, row);
            maxCol = Math.max(maxCol, col);
        }

        const svg = svgEl("svg", {
            width: 2 * PAD + maxCol * COL_W + NODE_W,
            height: 2 * PAD + maxRow * ROW_H + NODE_H,
        });

        // when elbows of different parents share a row gap (a rare nested-branch
        // case) each gets its own horizontal lane, so the lines stay apart;
        // elbows of one parent share a lane — they fork from the same point
        const gapElbows = new Map(); // parent row -> [{ from, lo, hi, lane }]
        const laneOf = (gap, from, lo, hi) => {
            const list = gapElbows.get(gap) ?? [];
            const lane = list.find((e) => e.from === from)?.lane ??
                Math.min(2, list.filter((e) => e.from !== from && !(hi < e.lo || lo > e.hi)).length);
            list.push({ from, lo, hi, lane });
            gapElbows.set(gap, list);
            return lane;
        };

        // edges first, so the node boxes paint over them
        for (const [node, { row, col }] of placed) {
            if (node.parent === null) {
                continue;
            }

            const p = placed.get(node.parent);
            const px = PAD + p.col * COL_W + NODE_W / 2;
            const py = PAD + p.row * ROW_H + NODE_H;
            const cx = PAD + col * COL_W + NODE_W / 2;
            const cy = PAD + row * ROW_H;

            // straight drop inside a branch, an elbow through the row gap to a variant
            let d;
            if (p.col === col) {
                d = `M ${px} ${py} L ${cx} ${cy}`;
            } else {
                const lane = laneOf(p.row, p.col, Math.min(p.col, col), Math.max(p.col, col));
                const hy = py + [3.5, 1.75, 5.25][lane];
                d = `M ${px} ${py} L ${px} ${hy} L ${cx} ${hy} L ${cx} ${cy}`;
            }
            svg.append(svgEl("path", { class: "treeEdge", d }));
        }

        let focusPlace = null;
        for (const [node, { row, col }] of placed) {
            const g = svgEl("g", {
                class: "treeNode" + (node === focus ? " focus" : ""),
                transform: `translate(${PAD + col * COL_W}, ${PAD + row * ROW_H})`,
            });

            g.append(svgEl("rect", { class: "treeBox", width: NODE_W, height: NODE_H, rx: 3 }));

            if (node.move === null) {
                // the root is the start position — no move to label
                g.append(svgEl("circle", { class: "treeRootMark", cx: 9, cy: NODE_H / 2, r: 3.5 }));
            } else {
                g.append(svgEl("rect", {
                    class: "treeSwatch", x: 4, y: 4, width: 10, height: 10,
                    fill: playColors[node.color - 1],
                }));

                const label = svgEl("text", { class: "treeLabel", x: 18, y: 13 });
                label.textContent = LETTERS[node.move[0]] + LETTERS[node.move[1]];
                g.append(label);
            }

            if (node.score !== null) {
                const score = svgEl("text", { class: "treeScore", x: NODE_W - 4, y: 13, "text-anchor": "end" });
                score.textContent = String(node.score);
                g.append(score);
            }

            // mousedown, like the board — a rebuild between press and release
            // would swallow a full click
            g.addEventListener("mousedown", () => onSelect(node));
            svg.append(g);

            if (node === focus) {
                focusPlace = { row, col };
            }
        }

        // rebuilding must never move the user's scroll position...
        const { scrollLeft, scrollTop } = container;
        container.replaceChildren(svg);
        container.scrollLeft = scrollLeft;
        container.scrollTop = scrollTop;

        // ...only an actual focus change reveals the focused node
        if (focusPlace !== null && focus !== lastFocus) {
            const x = PAD + focusPlace.col * COL_W;
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
