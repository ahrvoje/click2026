/**
 * Click2026 — board rules shared by the game engine and the v4 serializer:
 * flood fill, gravity collapse, clickable-group enumeration.
 *
 * The v4 wire format depends on these functions being deterministic — the
 * decoder replays the game with them to rebuild the same group lists the
 * encoder saw. Do not change scan order or collapse rules.
 *
 * Copyright 2014-2026, Hrvoje Abraham ahrvoje@gmail.com
 * Released under the MIT license.
 * https://opensource.org/licenses/MIT
 *
 * Date: Sat Jul 11, 2026
 */

export const SIZE = 12;
export const COLORS = 5;

export const clonePosition = (position) => position.map((column) => [...column]);

// flood fill of the same-colored group containing the given field
export function extractGroup(position, [x, y]) {
    const refColor = position[x]?.[y];

    if (refColor === undefined || refColor === 0 || refColor > COLORS) {
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
                position[ni][nj] === refColor && !visited.has(ni * SIZE + nj)) {
                visited.add(ni * SIZE + nj);
                stack.push([ni, nj]);
            }
        }
    }

    return group;
}

export function collapseDown(position) {
    for (let i = 0; i < SIZE; i++) {
        let row = 0;
        for (let j = 0; j < SIZE; j++) {
            const fieldState = position[i][j];
            position[i][j] = 0;

            if (fieldState > 0 && fieldState <= COLORS) {
                position[i][row++] = fieldState;
            }
        }
    }
}

export function collapseLeft(position) {
    // scan all columns except the last
    for (let i = 0; i < SIZE - 1; i++) {
        if (position[i][0] !== 0) {
            continue;
        }

        // find first non-empty column to the right
        let col = i + 1;
        while (col < SIZE && position[col][0] === 0) {
            col++;
        }

        // no non-empty column left — the rest of the board is empty
        if (col === SIZE) {
            break;
        }

        // move it into the empty column
        for (let j = 0; j < SIZE; j++) {
            const fieldState = position[col][j];
            if (fieldState === 0) {
                break;
            }

            position[i][j] = fieldState;
            position[col][j] = 0;
        }
    }
}

// removes a group from the board in place and applies gravity
export function removeGroup(position, group) {
    for (const [x, y] of group) {
        position[x][y] = 0;
    }
    collapseDown(position);
    collapseLeft(position);
}

// all clickable groups (two or more fields) in fixed scan order; the
// representative field is the first group field encountered by the scan
export function enumerateGroups(position) {
    const seen = new Set();
    const groups = [];

    for (let i = 0; i < SIZE; i++) {
        for (let j = 0; j < SIZE; j++) {
            if (seen.has(i * SIZE + j) || position[i][j] === 0) {
                continue;
            }

            const group = extractGroup(position, [i, j]);
            for (const [gi, gj] of group) {
                seen.add(gi * SIZE + gj);
            }

            if (group.length >= 2) {
                groups.push({ rep: [i, j], cells: group });
            }
        }
    }

    return groups;
}

// replays moves on a copy of the position, true if every move is playable
export function validReplay(position, moves) {
    if (!Array.isArray(moves)) {
        return false;
    }

    const pos = clonePosition(position);
    for (const move of moves) {
        if (!Array.isArray(move)) {
            return false;
        }

        const group = extractGroup(pos, move);
        if (group.length < 2) {
            return false;
        }

        removeGroup(pos, group);
    }

    return true;
}
