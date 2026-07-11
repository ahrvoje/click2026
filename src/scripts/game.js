/**
 * Click2026 — game engine: board state, move rules, the position tree, replay and rewind.
 *
 * Moves live in a position tree: the main line (the originally played game) runs
 * through first children, later siblings are variant branches. Times are recorded
 * only while the game clock runs, so they always cover a prefix of the main line
 * and stay officially reliable gameplay data — variants are never timed.
 *
 * Copyright 2014-2026, Hrvoje Abraham ahrvoje@gmail.com
 * Released under the MIT license.
 * https://opensource.org/licenses/MIT
 *
 * Date: Sat Sep 06, 2014
 *       Sat Oct 02, 2021
 *       Sat Jul 11, 2026 - modernized to ES module, zero dependencies
 *       Sat Jul 11, 2026 - position tree with variants and engine scores
 */

import { Serializer } from "./serial.js";
import { SIZE, COLORS, clonePosition, extractGroup, removeGroup, canonicalBlock } from "./board.js";

// a position-tree node: the move that created it and everything recorded about it;
// move/color are null for the root (the start position), score is the best (lowest)
// engine evaluation seen for the position at this node
const makeNode = (move, color, parent) => ({ move, color, parent, children: [], score: null });

export class Game {
    static Status = Object.freeze({ Initial: 0, Ready: 1, Play: 2, Over: 3, AutoPlay: 4 });

    #status = Game.Status.Initial;
    #startPosition = [];
    #currentPosition = [];
    #root = makeNode(null, null, null);
    #focus = this.#root;
    #times = [];        // cumulative ms of the timed prefix of the main line
    #currentMove = 0;   // depth of the focus node
    #startTime = 0;

    constructor(gameString) {
        if (gameString === undefined) {
            this.#generateNewPosition();
            this.#status = Game.Status.Ready;
            return;
        }

        const gameData = Serializer.deserializeGame(gameString);
        this.#startPosition = Array.isArray(gameData.p) ? clonePosition(gameData.p) : [];

        // moves arrive either as a full position tree (v5) or as a plain main line —
        // a linear game is just a tree whose nodes have a single child each
        let treeData = gameData.tree;
        if (!treeData) {
            const chain = (Array.isArray(gameData.m) ? gameData.m : [])
                .reduceRight((child, move) => ({ move, children: child ? [child] : [] }), null);
            treeData = { children: chain ? [chain] : [] };
        }

        try {
            this.#root = this.#buildNode(treeData, clonePosition(this.#startPosition), null);
        } catch {
            this.#root = makeNode(null, null, null); // moves that do not replay are dropped entirely
        }
        this.#focus = this.#root;

        const mainLength = this.#mainLineNodes().length;
        this.#times = mainLength > 0 && Array.isArray(gameData.t) ? gameData.t.slice(0, mainLength) : [];

        if (mainLength > 0) {
            this.#currentPosition = clonePosition(this.#startPosition);
            this.#status = Game.Status.Over;
        } else {
            this.#status = Game.Status.Ready;
        }
    }

    #generateNewPosition() {
        this.#startPosition = Array.from({ length: SIZE }, () =>
            Array.from({ length: SIZE }, () => Math.floor(Math.random() * COLORS) + 1));
    }

    // adopts serializer tree data, replay-validating every branch: throws on any move
    // that cannot be played; moves are canonicalized to their lowest-leftmost block
    #buildNode(data, position, parent) {
        const node = makeNode(null, null, parent);
        node.score = Number.isInteger(data.score) && data.score >= 0 ? data.score : null;

        for (const childData of data.children ?? []) {
            const group = extractGroup(position, Array.isArray(childData.move) ? childData.move : [-1, -1]);
            if (group.length < 2) {
                throw new Error("tree move does not replay");
            }

            const move = canonicalBlock(group);
            const next = clonePosition(position);
            removeGroup(next, group);

            const child = this.#buildNode(childData, next, node);
            child.move = move;
            child.color = position[move[0]][move[1]];
            node.children.push(child);
        }

        return node;
    }

    #mainLineNodes() {
        const line = [];
        for (let node = this.#root; node.children.length > 0; ) {
            node = node.children[0];
            line.push(node);
        }
        return line;
    }

    #pathNodes(node) {
        const path = [];
        for (let n = node; n.parent !== null; n = n.parent) {
            path.push(n);
        }
        return path.reverse();
    }

    // the line shown by the move counter and navigation: the path to the focus,
    // continued forward along first children (the main line of the focus node)
    #currentLineNodes() {
        const line = this.#pathNodes(this.#focus);
        for (let node = this.#focus; node.children.length > 0; ) {
            node = node.children[0];
            line.push(node);
        }
        return line;
    }

    #recomputePosition() {
        this.#currentPosition = clonePosition(this.#startPosition);
        const path = this.#pathNodes(this.#focus);

        for (const node of path) {
            removeGroup(this.#currentPosition, extractGroup(this.#currentPosition, node.move));
        }

        this.#currentMove = path.length;
    }

    #isOver() {
        // try to find at least two connected fields of the same color
        for (let i = 0; i < SIZE; i++) {
            // stop scanning at the empty part of the board
            if (this.#currentPosition[i][0] === 0) {
                return true;
            }

            for (let j = 0; j < SIZE; j++) {
                const fieldState = this.#currentPosition[i][j];

                if (fieldState === 0) {
                    break;
                }

                if (i < SIZE - 1 && this.#currentPosition[i + 1][j] === fieldState) {
                    return false;
                }

                if (j < SIZE - 1 && this.#currentPosition[i][j + 1] === fieldState) {
                    return false;
                }
            }
        }

        return true;
    }

    getStatus() { return this.#status; }
    setStatus(status) { this.#status = status; }
    getTimes() { return this.#times; }
    getStartPosition() { return this.#startPosition; }
    getCurrentPosition() { return this.#currentPosition; }
    getCurrentMove() { return this.#currentMove; }
    getStartTime() { return this.#startTime; }
    getRoot() { return this.#root; }
    getFocus() { return this.#focus; }

    getMoves() { return this.#currentLineNodes().map((node) => node.move); }

    // true when the path to the focus follows first children only — the original line
    isFocusOnMainLine() {
        for (let node = this.#focus; node.parent !== null; node = node.parent) {
            if (node.parent.children[0] !== node) {
                return false;
            }
        }
        return true;
    }

    startGame() {
        this.#currentPosition = clonePosition(this.#startPosition);
        // manual play starts a fresh recording — the old position tree is discarded here
        this.#root = makeNode(null, null, null);
        this.#focus = this.#root;
        this.#times = [];
        this.#currentMove = 0;
        this.#startTime = Date.now();
        this.#status = Game.Status.Play;
    }

    // returns to the start position KEEPING the position tree and times, so the game
    // can still be navigated or autoplayed; only a manual board click discards them
    replay() {
        this.#currentPosition = [];
        this.#focus = this.#root;
        this.#currentMove = 0;
        this.#status = Game.Status.Ready;
    }

    getNextMoveGroup() {
        if (this.#focus.children.length > 0) {
            return extractGroup(this.#currentPosition, this.#focus.children[0].move);
        }

        return [];
    }

    // official time exists only on the timed prefix of the main line — undefined
    // anywhere else, where time is neither measured nor meaningful
    getCurrentMoveTime() {
        if (this.#currentMove > 0 && this.#currentMove <= this.#times.length && this.isFocusOnMainLine()) {
            return this.#times[this.#currentMove - 1];
        }

        return undefined;
    }

    getScore() {
        if (this.#status === Game.Status.Initial) {
            return 0;
        }

        const position = this.#status === Game.Status.Ready ? this.#startPosition : this.#currentPosition;

        if (position[0] === undefined) {
            return 0;
        }

        let score = 0;
        for (let i = 0; i < SIZE; i++) {
            // stop counting at the first empty column
            if (position[i][0] === 0) {
                break;
            }

            for (let j = 0; j < SIZE; j++) {
                // stop counting at the empty part of the column
                if (position[i][j] === 0) {
                    break;
                }

                score++;
            }
        }

        return score;
    }

    getString() {
        const isLinear = (node) => node.children.length <= 1 && node.children.every(isLinear);
        const hasScores = (node) => node.score !== null || node.children.some(hasScores);
        const mainLength = this.#mainLineNodes().length;

        // plain single-line games without engine data keep the shorter v4 links —
        // unless the line has an untimed tail, which only v5 can carry with times
        if (isLinear(this.#root) && !hasScores(this.#root) &&
            (this.#times.length === 0 || this.#times.length === mainLength)) {
            return Serializer.serializeGame(4, this.#startPosition,
                this.#mainLineNodes().map((node) => node.move), this.#times);
        }

        const exportNode = (node) =>
            ({ move: node.move, score: node.score, children: node.children.map(exportNode) });
        return Serializer.serializeGameTree(this.#startPosition, exportNode(this.#root), this.#times);
    }

    playMove(field) {
        const group = extractGroup(this.#currentPosition, field);

        // only groups of two or more fields can be clicked away
        if (group.length < 2) {
            return false;
        }

        // same-group clicks are the same move, identified by the canonical block
        const move = canonicalBlock(group);
        const color = this.#currentPosition[move[0]][move[1]];

        removeGroup(this.#currentPosition, group);
        this.#currentMove++;

        // an already recorded move only moves the focus — the tree is not changed;
        // a new move sequence amends the tree, a later sibling starts a variant
        let child = this.#focus.children.find((c) => c.move[0] === move[0] && c.move[1] === move[1]);
        if (child === undefined) {
            child = makeNode(move, color, this.#focus);
            this.#focus.children.push(child);
        }
        this.#focus = child;

        if (this.#status === Game.Status.Play) {
            // first move time is 0 by convention, the rest are ms since game start
            this.#times.push(this.#currentMove === 1 ? 0 : Date.now() - this.#startTime);

            if (this.#isOver()) {
                this.#status = Game.Status.Over;
            }
        }

        return true;
    }

    playNextMove() {
        if (this.#focus.children.length > 0) {
            this.playMove(this.#focus.children[0].move);
        }
    }

    rewindToMove(moveIndex) {
        const line = this.#currentLineNodes();

        if (moveIndex < 0 || moveIndex > line.length) {
            return false;
        }

        this.#focus = moveIndex === 0 ? this.#root : line[moveIndex - 1];
        this.#recomputePosition();
        return true;
    }

    // reloads the position of any tree node; playing from there amends the tree
    focusNode(node) {
        this.#focus = node;
        this.#recomputePosition();
    }

    // best (lowest) engine evaluation seen for the position at the focus node
    recordEngineScore(score) {
        if (Number.isInteger(score) && score >= 0) {
            this.#focus.score = this.#focus.score === null ? score : Math.min(this.#focus.score, score);
        }
    }
}
