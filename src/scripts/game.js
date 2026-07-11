/**
 * Click2026 — game engine: board state, move rules, replay and rewind.
 *
 * Copyright 2014-2026, Hrvoje Abraham ahrvoje@gmail.com
 * Released under the MIT license.
 * https://opensource.org/licenses/MIT
 *
 * Date: Sat Sep 06, 2014
 *       Sat Oct 02, 2021
 *       Sat Jul 11, 2026 - modernized to ES module, zero dependencies
 */

import { Serializer } from "./serial.js";

const SIZE = 12;
const COLORS = 5;

const clonePosition = (position) => position.map((column) => [...column]);

export class Game {
    static Status = Object.freeze({ Initial: 0, Ready: 1, Play: 2, Over: 3, AutoPlay: 4 });

    #status = Game.Status.Initial;
    #startPosition = [];
    #currentPosition = [];
    #moves = [];
    #times = [];
    #currentMove = 0;
    #startTime = 0;

    constructor(gameString) {
        if (gameString === undefined) {
            this.#generateNewPosition();
            this.#status = Game.Status.Ready;
            return;
        }

        const gameData = Serializer.deserializeGame(gameString);

        this.#startPosition = Array.isArray(gameData.p) ? clonePosition(gameData.p) : [];
        this.#moves = Array.isArray(gameData.m) ? gameData.m.map((move) => [...move]) : [];
        this.#times = Array.isArray(gameData.t) ? [...gameData.t] : [];

        if (this.#checkGameData()) {
            this.#currentPosition = clonePosition(this.#startPosition);
            this.#status = Game.Status.Over;
        } else {
            this.#moves = [];
            this.#times = [];
            this.#status = Game.Status.Ready;
        }
    }

    #generateNewPosition() {
        this.#startPosition = Array.from({ length: SIZE }, () =>
            Array.from({ length: SIZE }, () => Math.floor(Math.random() * COLORS) + 1));
    }

    // replays the whole game and checks every move actually can be played
    #checkGameData() {
        this.#currentPosition = clonePosition(this.#startPosition);
        this.#currentMove = 0;

        const result = this.#moves.every((move) => this.playMove(move));

        this.#currentPosition = [];
        this.#currentMove = 0;
        return result;
    }

    // flood fill of the same-colored group containing the given field
    #extractGroup([x, y]) {
        const refColor = this.#currentPosition[x]?.[y];

        if (refColor === undefined || refColor === 0) {
            return [];
        }

        const visited = new Set([x * SIZE + y]);
        const group = [];
        const stack = [[x, y]];

        while (stack.length > 0) {
            const [i, j] = stack.pop();
            group.push([i, j]);

            for (const [ni, nj] of [[i - 1, j], [i + 1, j], [i, j - 1], [i, j + 1]]) {
                if (ni >= 0 && ni < SIZE && nj >= 0 && nj < SIZE &&
                    this.#currentPosition[ni][nj] === refColor && !visited.has(ni * SIZE + nj)) {
                    visited.add(ni * SIZE + nj);
                    stack.push([ni, nj]);
                }
            }
        }

        return group;
    }

    #collapseDown() {
        for (let i = 0; i < SIZE; i++) {
            let row = 0;
            for (let j = 0; j < SIZE; j++) {
                const fieldState = this.#currentPosition[i][j];
                this.#currentPosition[i][j] = 0;

                if (fieldState > 0 && fieldState <= COLORS) {
                    this.#currentPosition[i][row++] = fieldState;
                }
            }
        }
    }

    #collapseLeft() {
        // scan all columns except the last
        for (let i = 0; i < SIZE - 1; i++) {
            if (this.#currentPosition[i][0] !== 0) {
                continue;
            }

            // find first non-empty column to the right
            let col = i + 1;
            while (col < SIZE && this.#currentPosition[col][0] === 0) {
                col++;
            }

            // no non-empty column left — the rest of the board is empty
            if (col === SIZE) {
                break;
            }

            // move it into the empty column
            for (let j = 0; j < SIZE; j++) {
                const fieldState = this.#currentPosition[col][j];
                if (fieldState === 0) {
                    break;
                }

                this.#currentPosition[i][j] = fieldState;
                this.#currentPosition[col][j] = 0;
            }
        }
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
    getMoves() { return this.#moves; }
    getTimes() { return this.#times; }
    getStartPosition() { return this.#startPosition; }
    getCurrentPosition() { return this.#currentPosition; }
    getCurrentMove() { return this.#currentMove; }
    getStartTime() { return this.#startTime; }

    startGame() {
        this.#currentPosition = clonePosition(this.#startPosition);
        // manual play starts a fresh recording — a replayed game's old moves are discarded here
        this.#moves = [];
        this.#times = [];
        this.#currentMove = 0;
        this.#startTime = Date.now();
        this.#status = Game.Status.Play;
    }

    // returns to the start position KEEPING the recorded moves and times, so the game
    // can still be navigated or autoplayed; only a manual board click discards them
    replay() {
        this.#currentPosition = [];
        this.#currentMove = 0;
        this.#status = Game.Status.Ready;
    }

    getNextMoveGroup() {
        if (this.#currentMove < this.#moves.length) {
            return this.#extractGroup(this.#moves[this.#currentMove]);
        }

        return [];
    }

    getCurrentMoveTime() {
        if (this.#currentMove <= this.#times.length) {
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
        return Serializer.serializeGame(3, this.#startPosition, this.#moves, this.#times);
    }

    playMove(field) {
        const group = this.#extractGroup(field);

        // only groups of two or more fields can be clicked away
        if (group.length < 2) {
            return false;
        }

        for (const [x, y] of group) {
            this.#currentPosition[x][y] = COLORS + 1;
        }
        this.#collapseDown();
        this.#collapseLeft();
        this.#currentMove++;

        if (this.#status === Game.Status.Play) {
            this.#moves.push(field);

            // first move time is 0 by convention, the rest are ms since game start
            this.#times.push(this.#currentMove === 1 ? 0 : Date.now() - this.#startTime);

            if (this.#isOver()) {
                this.#status = Game.Status.Over;
            }
        }

        return true;
    }

    playNextMove() {
        if (this.#currentMove < this.#moves.length) {
            this.playMove(this.#moves[this.#currentMove]);
        }
    }

    rewindToMove(moveIndex) {
        if (moveIndex < 0 || moveIndex > this.#moves.length) {
            return false;
        }

        this.#currentPosition = clonePosition(this.#startPosition);
        this.#currentMove = 0;

        for (let i = 0; i < moveIndex; i++) {
            this.playMove(this.#moves[i]);
        }

        return true;
    }
}
