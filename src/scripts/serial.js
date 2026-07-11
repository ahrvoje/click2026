/**
 * Click2026 — game serialization.
 *
 * Four wire formats are supported for backward compatibility with old game links:
 *   v1 (no "v" param) — plain decimal position/moves/times lists
 *   v2               — base-71 packed position, Huffman-coded move deltas, lossy log-coded times
 *   v3               — base-64 position; moves/times exist in two dialects: the deployed
 *                      2021 build packed them base-71 (v2 style), a later build base-64 —
 *                      decoding auto-detects the dialect by replay validation
 *   v4               — single "g" param: one rANS entropy-coded BigInt stream (current format)
 * New games are always serialized as v4. The encoding tables and compression math of all
 * versions are frozen — do not "clean them up", links depend on them.
 *
 * The v4 stream packs, in decode order: the start position (48 uniform base-125 symbols),
 * the move count, a has-times flag, one group-rank symbol per move, one gap symbol per
 * time delta, and the exact total-time residual. Moves are coded as the rank of the
 * clicked group among the clickable groups ordered by distance from the previous click —
 * the decoder replays the game to rebuild the identical candidate list, which is why
 * board.js rules are part of the wire format. Times are log-quantized (~1.4% steps) with
 * error diffusion against the reconstructed clock, so per-move times never drift, stay
 * monotone, and the final total time is exact to the millisecond. Decoded games
 * re-serialize to the identical string, and the rANS end state doubles as an integrity
 * check for corrupted links.
 *
 * Copyright 2014-2026, Hrvoje Abraham ahrvoje@gmail.com
 * Released under the MIT license.
 * https://opensource.org/licenses/MIT
 *
 * Date: Thu Apr 23, 2015
 *       Sat Oct 02, 2021
 *       Sat Jul 11, 2026 - modernized to ES module, zero dependencies
 *       Sat Jul 11, 2026 - v4 wire format
 */

import {
    padZeros,
    topZeros,
    tailZeros,
    swapKeyValue,
    baseXtoBaseY,
    longXtoLongY,
    huffmanEncode,
    huffmanDecode,
    getQueryParams,
} from "./misc.js";

import {
    SIZE,
    COLORS,
    clonePosition,
    removeGroup,
    enumerateGroups,
    validReplay,
} from "./board.js";

// Huffman tables shared by v2 and v3 — frozen wire format, keep verbatim
const dxEncode = {
      "0": "11",
     "-1": "10",
      "1": "00",
     "-2": "0111",
      "2": "0110",
      "3": "01011",
     "-3": "01001",
     "-4": "010100",
      "4": "0100001",
     "-5": "0100010",
      "5": "01010111",
     "-6": "01000000",
      "6": "01000001",
     "-7": "010001111",
      "7": "010001100",
     "-8": "010101100",
      "8": "010001101",
     "-9": "010101010",
      "9": "010001110",
    "-10": "010101011",
     "10": "010101001",
    "-11": "010101000",
     "11": "010101101",
};
const dxDecode = swapKeyValue(dxEncode);

const dyEncode = {
      "0": "11",
     "-1": "10",
      "1": "011",
     "-2": "001",
      "2": "000",
     "-3": "01011",
      "3": "01001",
     "-4": "010101",
      "4": "010000",
     "-5": "0101000",
      "5": "010100100",
     "-6": "010100101",
      "6": "010100110",
     "-7": "010001000",
      "7": "010001101",
     "-8": "010001100",
      "8": "010001011",
     "-9": "010001010",
      "9": "010001001",
    "-10": "010001111",
     "10": "010001110",
    "-11": "0101001110",
     "11": "0101001111",
};
const dyDecode = swapKeyValue(dyEncode);

const firstDigitEncode = {
    "3": "1",
    "2": "01",
    "4": "001",
    "1": "0001",
    "0": "00001",
    "5": "000001",
    "6": "0000001",
    "7": "00000001",
    "8": "000000001",
    "9": "0000000001",
    "x": "00000000001",
};
const firstDigitDecode = swapKeyValue(firstDigitEncode);

const secondDigitEncode = {
    "0": "000",
    "1": "001",
    "2": "010",
    "3": "011",
    "4": "100",
    "5": "1010",
    "6": "1011",
    "7": "1100",
    "8": "1101",
    "9": "1110",
    "x": "1111",
};
const secondDigitDecode = swapKeyValue(secondDigitEncode);

// times are compressed via a lossy log scale: ~2% relative error, far shorter links.
// encode/decode formulas are inverses of each other around delta = 100 ms
const timeDeltaToLog = (delta) => Math.round(25 * Math.sqrt(Math.max(0, Math.log(0.01 * delta))));
const logToTimeDelta = (log) => Math.round(100 * Math.exp((0.04 * log) ** 2));

function logsToCode(logs) {
    let coded = "";
    for (const log of logs) {
        const secondDigit = log % 10;
        const firstDigit = (log - secondDigit) / 10;
        coded += firstDigitEncode[firstDigit];
        coded += secondDigitEncode[secondDigit];
    }
    return coded;
}

function codeToLogs(coded) {
    const logs = [];

    for (let i = 0; i < coded.length; ) {
        let j, firstDigit, secondDigit;

        for (j = 1; j < 12; j++) {
            firstDigit = firstDigitDecode[coded.substring(i, i + j)];
            if (firstDigit !== undefined) break;
        }
        i += j;

        for (j = 3; j < 5; j++) {
            secondDigit = secondDigitDecode[coded.substring(i, i + j)];
            if (secondDigit !== undefined) break;
        }
        i += j;

        logs.push(Number(firstDigit + secondDigit));
    }

    return logs;
}

// reconstructs absolute times from lossy deltas; total time is exact by construction
function timesFromLossyDeltas(deltas, totalTime) {
    // triple total time difference compensation
    // time encoding is lossy, but total time has to be correct
    for (let compensation = 0; compensation < 3; compensation++) {
        const decodedTotalTime = deltas.reduce((a, b) => a + b, 0);
        deltas = deltas.map((x) => Math.round((x * totalTime) / decodedTotalTime));
    }

    const times = [0];
    for (let i = 0; i < deltas.length; i++) {
        times.push(times[i] + deltas[i]);
    }
    // final total time correction should be zero or very small (single digit)
    // coded and decoded total time will now be exactly the same
    times[times.length - 1] = totalTime;

    return times;
}

const deltasOf = (list, component) => {
    const deltas = [];
    for (let i = 1; i < list.length; i++) {
        deltas.push(component === undefined ? list[i] - list[i - 1] : list[i][component] - list[i - 1][component]);
    }
    return deltas;
};

//
// v1 — legacy plain decimal format: ?position=...&moves=...&times=...
//
const Serializer1 = {
    deserialize(positionString, movesString, timesString) {
        let position = [];
        let moves = [];
        let times = [];

        if (typeof positionString === "string") {
            const p = this.stringToPosition(positionString);
            if (p === null) {
                return { p: [], m: [], t: [] };
            }
            position = p;
        }

        if (typeof movesString === "string") {
            moves = this.stringToMoves(movesString) ?? [];
        }

        if (typeof timesString === "string") {
            times = this.stringToTimes(timesString) ?? [];
        }

        return { p: position, m: moves, t: times };
    },

    stringToPosition(positionString) {
        if (positionString.length !== 144) {
            return null;
        }

        const position = [];
        let column = [];

        for (let i = 0; i < positionString.length; i++) {
            const x = parseInt(positionString[i], 10);
            column.push(x > 0 && x < 6 ? x : 0);

            if (column.length === 12) {
                position.push(column);
                column = [];
            }
        }

        return position;
    },

    stringToMoves(movesString) {
        const moves = [];

        for (const code of movesString.split(",")) {
            const fieldCode = parseInt(code, 10);
            const x = Math.floor(fieldCode / 12);
            const y = fieldCode % 12;

            if (!Number.isInteger(fieldCode) || x < 0 || x > 11) {
                return null;
            }
            moves.push([x, y]);
        }

        return moves;
    },

    stringToTimes(timesString) {
        const times = [0];

        for (const [i, delta] of timesString.split(",").entries()) {
            const x = Number(delta);
            if (!Number.isFinite(x)) {
                return null;
            }
            times.push(times[i] + x);
        }

        return times;
    },

    serialize(position, moves, times) {
        let string = "position=" + position.flat().join("");

        if (moves.length > 0) {
            string += "&moves=" + moves.map((field) => 12 * field[0] + field[1]).join(",");
        }

        if (times.length > 0) {
            // times are string coded by move time differences
            string += "&times=" + deltasOf(times).join(",");
        }

        return string;
    },
};

//
// v2 — base-71 packed format: ?v=2&p=...&m=...&t=...
//
const Serializer2 = {
    serializePosition(position) {
        let p0 = "";
        for (let i = 0; i < 12 && position[i][0] !== 0; i++) {
            for (let j = 0; j < 12; j++) {
                p0 += String(position[i][j]);

                if (position[i][j] === 0) {
                    break;
                }
            }
        }

        return topZeros(longXtoLongY(tailZeros(p0), 6, 19, 71, 8));
    },

    deserializePosition(positionString) {
        const base6 = topZeros(longXtoLongY(positionString, 71, 8, 6, 19));

        const position = [];
        for (let i = 0; i < 12; i++) {
            position.push([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
        }

        let column = 0;
        let row = 0;
        for (let i = 0; i < base6.length && column < 12; i++) {
            const x = Number(base6[i]);

            // column starts with 0 = end of position
            if (row === 0 && x === 0) {
                break;
            }

            position[column][row++] = x;

            if (x === 0 || row === 12) {
                column++;
                row = 0;
            }
        }

        return position;
    },

    movesComponentToString(moves, component, huffmanTable) {
        const huffman = huffmanEncode(deltasOf(moves, component), huffmanTable);
        const leadingZeros = huffman.indexOf("1");
        const base71 = longXtoLongY(huffman, 2, 43, 71, 7);

        return baseXtoBaseY(String(moves[0][component]), 10, 71) +
            baseXtoBaseY(String(leadingZeros), 10, 71) +
            topZeros(base71);
    },

    componentStringToMoves(movesStringComponent, huffmanTable) {
        const firstMove = Number(baseXtoBaseY(movesStringComponent[0], 71, 10));
        const leadingZeros = Number(baseXtoBaseY(movesStringComponent[1], 71, 10));
        const huffman = padZeros(topZeros(longXtoLongY(movesStringComponent.substring(2), 71, 7, 2, 43)), leadingZeros);
        const deltas = huffmanDecode(huffman, huffmanTable);
        const movesComponent = [firstMove];

        for (const delta of deltas) {
            movesComponent.push(movesComponent[movesComponent.length - 1] + delta);
        }

        return movesComponent;
    },

    serializeMoves(moves) {
        return this.movesComponentToString(moves, 0, dxEncode) + "," + this.movesComponentToString(moves, 1, dyEncode);
    },

    deserializeMoves(movesString) {
        if (movesString === undefined) {
            return null;
        }

        const [stringX, stringY] = movesString.split(",");
        const movesX = this.componentStringToMoves(stringX, dxDecode);
        const movesY = this.componentStringToMoves(stringY, dyDecode);

        return movesX.map((x, i) => [x, movesY[i]]);
    },

    serializeTimes(times) {
        const coded = logsToCode(deltasOf(times).map(timeDeltaToLog));

        return topZeros(baseXtoBaseY(String(times[times.length - 1]), 10, 71)) + "," +
            topZeros(baseXtoBaseY(String(coded.indexOf("1")), 10, 71)) +
            topZeros(longXtoLongY(coded, 2, 43, 71, 7));
    },

    deserializeTimes(timesString) {
        if (timesString === undefined) {
            return null;
        }

        const [timeBase71, packed] = timesString.split(",");
        const totalTime = Number(baseXtoBaseY(timeBase71, 71, 10));
        const leadingZeros = Number(baseXtoBaseY(packed[0], 71, 10));

        const coded = padZeros(topZeros(longXtoLongY(packed.substring(1), 71, 7, 2, 43)), leadingZeros);
        const deltas = codeToLogs(coded).map(logToTimeDelta);

        return timesFromLossyDeltas(deltas, totalTime);
    },

    deserializeGame(positionString, movesString, timesString) {
        const position = this.deserializePosition(positionString);
        const moves = this.deserializeMoves(movesString);
        if (moves === null) {
            return { p: position, m: [], t: [] };
        }

        const times = this.deserializeTimes(timesString);
        if (times === null) {
            return { p: position, m: moves, t: [] };
        }

        return { p: position, m: moves, t: times };
    },

    serializeGame(position, moves, times) {
        let string = "v=2&p=" + this.serializePosition(position);

        if (moves.length > 0) {
            string += "&m=" + this.serializeMoves(moves);
        }

        if (times.length > 0) {
            string += "&t=" + this.serializeTimes(times);
        }

        return string;
    },
};

//
// v3 — current format, URL-safe base-64 packed: ?v=3&p=...&m=...&t=...
//
const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

const Serializer3 = {
    // full 12x12 board, 5 colors: 3 base-5 digits pack into 7 bits, 6 bits per b64 char
    serializePosition(position) {
        return position
            .flat().map((x) => x - 1).join("")
            .match(/.{3}/g).map((x) => parseInt(x, 5).toString(2).padStart(7, "0")).join("")
            .match(/.{6}/g).map((x) => B64[parseInt(x, 2)]).join("");
    },

    deserializePosition(positionString) {
        return positionString
            .split("").map((x) => B64.indexOf(x).toString(2).padStart(6, "0")).join("")
            .match(/.{7}/g).map((x) => parseInt(x, 2).toString(5).padStart(3, "0")).join("")
            .match(/.{12}/g).map((x) => x.split("").map((y) => parseInt(y, 5) + 1));
    },

    movesComponentToString(moves, component, huffmanTable) {
        const huffman = huffmanEncode(deltasOf(moves, component), huffmanTable);
        const leadingZeros = huffman.indexOf("1");
        const base64 = longXtoLongY(huffman, 2, 6, 64, 1);

        return baseXtoBaseY(String(moves[0][component]), 10, 64) +
            baseXtoBaseY(String(leadingZeros), 10, 64) +
            topZeros(base64);
    },

    componentStringToMoves(movesStringComponent, huffmanTable) {
        const firstMove = Number(baseXtoBaseY(movesStringComponent[0], 64, 10));
        const leadingZeros = Number(baseXtoBaseY(movesStringComponent[1], 64, 10));
        const huffman = padZeros(topZeros(longXtoLongY(movesStringComponent.substring(2), 64, 1, 2, 6)), leadingZeros);
        const deltas = huffmanDecode(huffman, huffmanTable);
        const movesComponent = [firstMove];

        for (const delta of deltas) {
            movesComponent.push(movesComponent[movesComponent.length - 1] + delta);
        }

        return movesComponent;
    },

    serializeMoves(moves) {
        if (moves.length === 0) {
            return undefined;
        }

        return this.movesComponentToString(moves, 0, dxEncode) + "," + this.movesComponentToString(moves, 1, dyEncode);
    },

    // "undefined" accepted for compatibility with old links serialized as "m=undefined"
    deserializeMoves(movesString) {
        if (movesString === undefined || movesString === "undefined" || movesString === "") {
            return null;
        }

        const [stringX, stringY] = movesString.split(",");
        const movesX = this.componentStringToMoves(stringX, dxDecode);
        const movesY = this.componentStringToMoves(stringY, dyDecode);

        return movesX.map((x, i) => [x, movesY[i]]);
    },

    serializeTimes(times) {
        if (times.length === 0) {
            return undefined;
        }

        const coded = logsToCode(deltasOf(times).map(timeDeltaToLog));

        return topZeros(baseXtoBaseY(String(times[times.length - 1]), 10, 64)) + "," +
            topZeros(baseXtoBaseY(String(coded.indexOf("1")), 10, 64)) +
            topZeros(longXtoLongY(coded, 2, 6, 64, 1));
    },

    deserializeTimes(timesString) {
        if (timesString === undefined || timesString === "undefined" || timesString === "") {
            return null;
        }

        const [timeBase64, packed] = timesString.split(",");
        const totalTime = Number(baseXtoBaseY(timeBase64, 64, 10));
        const leadingZeros = Number(baseXtoBaseY(packed[0], 64, 10));

        const coded = padZeros(topZeros(longXtoLongY(packed.substring(1), 64, 1, 2, 6)), leadingZeros);
        const deltas = codeToLogs(coded).map(logToTimeDelta);

        return timesFromLossyDeltas(deltas, totalTime);
    },

    // v3 m/t come in two dialects: the deployed 2021 build packed them exactly like
    // v2 (base-71), a later build like the methods above (base-64). Characters beyond
    // the base-64 range are a certain old-dialect marker; otherwise both decodings are
    // tried and the one whose moves actually replay on the board wins.
    deserializeGame(positionString, movesString, timesString) {
        const position = this.deserializePosition(positionString);
        const oldMarker = /[_.+!*()]/.test((movesString ?? "") + (timesString ?? ""));

        for (const dialect of oldMarker ? [Serializer2] : [this, Serializer2]) {
            try {
                const moves = dialect.deserializeMoves(movesString);
                if (moves !== null && validReplay(position, moves)) {
                    const times = dialect.deserializeTimes(timesString);
                    return { p: position, m: moves, t: Array.isArray(times) && times.every(Number.isFinite) ? times : [] };
                }
            } catch {
                // fall through to the other dialect
            }
        }

        return { p: position, m: [], t: [] };
    },

    serializeGame(position, moves, times) {
        const parts = ["v=3", "p=" + this.serializePosition(position)];

        const m = this.serializeMoves(moves);
        if (m !== undefined) {
            parts.push("m=" + m);
        }

        const t = this.serializeTimes(times);
        if (t !== undefined) {
            parts.push("t=" + t);
        }

        return parts.join("&");
    },
};

//
// v4 — current format: one rANS entropy-coded BigInt stream in a single "g" param
//

// ---- frozen v4 coding tables — wire format, keep verbatim ----

// clicked-group rank frequencies (rank = index in the distance-ordered group list),
// fitted on a corpus of real games; ranks beyond the table share frequency 1
const RANK_FREQ = [640, 320, 188, 100, 64, 32, 18, 14, 9, 6, 4, 3, 3, 2, 2, 2, 2, 2];

// time gap codebook: integer recurrence gives ~1.4% wide log steps, exact below 70 ms;
// all values stay integer-exact in doubles up to GAP_MAX
const GAP_STEP_DIV = 69;
const GAP_MAX = 2 ** 45;

// gap symbol frequencies as piecewise-linear knots over the codebook index,
// fitted on the same corpus (peak around the 300-900 ms click tempo)
const GAP_KNOT_INDEX = [0, 69, 95, 120, 143, 167, 190, 214, 238, 262, 286, 310, 334, 382, 430, 500, 572, 700];
const GAP_KNOT_FREQ = [1, 1, 1, 3, 45, 109, 131, 217, 186, 130, 74, 24, 13, 3, 1, 1, 1, 1];

// number of moves fits [0, 72] — every move removes at least 2 of 144 fields
const MOVES_RADIX = 73;

// total-time residual is coded as bit length (radix) + offset
const RESIDUAL_RADIX = 48;

// ---- tables derived from the constants above with integer-only arithmetic,
//      identical on every platform by construction ----

const GAP_CODEBOOK = [0];
for (let v = 1; v < GAP_MAX; v += Math.max(1, Math.floor(v / GAP_STEP_DIV))) {
    GAP_CODEBOOK.push(v);
}
GAP_CODEBOOK.push(GAP_MAX);

const prefixSums = (freqs) => {
    const sums = [0];
    for (const f of freqs) {
        sums.push(sums[sums.length - 1] + f);
    }
    return sums;
};

const GAP_FREQ = [];
for (let seg = 0; seg < GAP_KNOT_INDEX.length; seg++) {
    const a = GAP_KNOT_INDEX[seg];
    const b = seg + 1 < GAP_KNOT_INDEX.length ? GAP_KNOT_INDEX[seg + 1] : GAP_CODEBOOK.length - 1;
    const fa = GAP_KNOT_FREQ[seg];
    const fb = seg + 1 < GAP_KNOT_INDEX.length ? GAP_KNOT_FREQ[seg + 1] : 1;
    for (let k = a; k < b; k++) {
        GAP_FREQ[k] = fa + Math.floor(((fb - fa) * (k - a)) / (b - a));
    }
}
GAP_FREQ[GAP_CODEBOOK.length - 1] = 1;
const GAP_PREFIX = prefixSums(GAP_FREQ);

const RANK_PREFIX = prefixSums(
    Array.from({ length: 72 }, (_, r) => (r < RANK_FREQ.length ? RANK_FREQ[r] : 1)));

// largest codebook value <= gap
function gapToSymbol(gap) {
    const target = Math.min(Math.max(0, gap), GAP_MAX);
    let lo = 0;
    let hi = GAP_CODEBOOK.length - 1;
    while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (GAP_CODEBOOK[mid] <= target) {
            lo = mid;
        } else {
            hi = mid - 1;
        }
    }
    return lo;
}

// ---- exact rANS on a BigInt state: symbol with frequency f, cumulative c out of
// total T costs log2(T/f) bits; encoding runs the decode transform in reverse, so
// the encoder collects symbols first and folds them right to left ----

class RansEncoder {
    #symbols = [];

    push(freq, cumulative, total) {
        this.#symbols.push([BigInt(freq), BigInt(cumulative), BigInt(total)]);
    }

    uniform(value, radix) {
        this.push(1, value, radix);
    }

    finish() {
        let x = 1n;
        for (let i = this.#symbols.length - 1; i >= 0; i--) {
            const [f, c, T] = this.#symbols[i];
            x = (x / f) * T + c + (x % f);
        }
        return x;
    }
}

class RansDecoder {
    #x;

    constructor(x) {
        this.#x = x;
    }

    // prefix: cumulative frequency sums; returns the decoded symbol index
    symbol(prefix) {
        const T = BigInt(prefix[prefix.length - 1]);
        const r = Number(this.#x % T);

        let lo = 0;
        let hi = prefix.length - 2;
        while (lo < hi) {
            const mid = (lo + hi + 1) >> 1;
            if (prefix[mid] <= r) {
                lo = mid;
            } else {
                hi = mid - 1;
            }
        }

        this.#x = BigInt(prefix[lo + 1] - prefix[lo]) * (this.#x / T) + BigInt(r - prefix[lo]);
        return lo;
    }

    uniform(radix) {
        const T = BigInt(radix);
        const r = this.#x % T;
        this.#x = this.#x / T;
        return Number(r);
    }

    uniformBig(radix) {
        const r = this.#x % radix;
        this.#x = this.#x / radix;
        return r;
    }

    // after a full decode the state must return to the encoder's start value
    verifyEndState() {
        if (this.#x !== 1n) {
            throw new Error("v4 stream integrity check failed");
        }
    }
}

// clickable groups ordered by squared distance from the previous click, ties by scan
// order; the player's next click is usually near the previous one, which makes low
// ranks far more frequent and cheap to code
function orderedGroupIndices(groups, anchor) {
    return groups
        .map((group, index) => ({
            index,
            d: Math.min(...group.cells.map(([x, y]) => (x - anchor[0]) ** 2 + (y - anchor[1]) ** 2)),
        }))
        .sort((a, b) => a.d - b.d || a.index - b.index)
        .map((entry) => entry.index);
}

const Serializer4 = {
    serializeGame(position, moves, times) {
        if (!Array.isArray(position) || position.length !== SIZE ||
            position.some((col) => !Array.isArray(col) || col.length !== SIZE ||
                col.some((c) => !Number.isInteger(c) || c < 1 || c > COLORS))) {
            throw new Error("v4 can only serialize a full 12x12 start position");
        }

        const encoder = new RansEncoder();

        // start position: 3 base-5 fields per uniform base-125 symbol
        const flat = position.flat();
        for (let i = 0; i < flat.length; i += 3) {
            encoder.uniform((flat[i] - 1) * 25 + (flat[i + 1] - 1) * 5 + (flat[i + 2] - 1), 125);
        }

        // replay the game to express each move as the rank of its group; moves that
        // do not replay are dropped entirely, matching the Game class behavior
        const pos = clonePosition(position);
        let anchor = null;
        const rankSymbols = [];
        let valid = Array.isArray(moves);

        for (const move of valid ? moves : []) {
            const groups = enumerateGroups(pos);
            const chosen = groups.findIndex((group) =>
                group.cells.some(([x, y]) => x === move[0] && y === move[1]));

            if (chosen < 0) {
                valid = false;
                break;
            }

            const order = anchor === null ? null : orderedGroupIndices(groups, anchor);
            rankSymbols.push({
                rank: order === null ? chosen : order.indexOf(chosen),
                count: groups.length,
                first: anchor === null,
            });
            anchor = groups[chosen].rep;
            removeGroup(pos, groups[chosen].cells);
        }

        const moveCount = valid ? moves.length : 0;
        encoder.uniform(moveCount, MOVES_RADIX);

        // times are only kept when they are sane: one per move, starting at 0,
        // integer and non-decreasing (always true for games recorded by Game)
        const hasTimes = moveCount > 0 && Array.isArray(times) && times.length === moveCount &&
            times[0] === 0 && times[times.length - 1] < GAP_MAX &&
            times.every((t, i) => Number.isInteger(t) && (i === 0 || t >= times[i - 1]));

        if (moveCount > 0) {
            encoder.uniform(hasTimes ? 1 : 0, 2);
        }

        if (valid) {
            for (const { rank, count, first } of rankSymbols) {
                if (first) {
                    encoder.uniform(rank, count);
                } else {
                    const prefix = RANK_PREFIX;
                    encoder.push(prefix[rank + 1] - prefix[rank], prefix[rank],
                        prefix[Math.min(count, 72)]);
                }
            }
        }

        if (hasTimes) {
            // error-diffusion floor quantization: every gap is measured against the
            // RECONSTRUCTED clock, so absolute move times never drift, stay monotone
            // (floor keeps the reconstruction below the true time), and re-encoding
            // a decoded game reproduces the identical symbol stream
            let reconstructed = 0;
            for (let i = 1; i < moveCount; i++) {
                const symbol = gapToSymbol(times[i] - reconstructed);
                reconstructed += GAP_CODEBOOK[symbol];
                encoder.push(GAP_FREQ[symbol], GAP_PREFIX[symbol], GAP_PREFIX[GAP_PREFIX.length - 1]);
            }

            // non-negative residual makes the total time exact to the millisecond
            const residual = BigInt(times[moveCount - 1] - reconstructed);
            const bits = residual === 0n ? 0 : residual.toString(2).length;
            encoder.uniform(bits, RESIDUAL_RADIX);
            if (bits > 1) {
                encoder.push(1n, residual - (1n << BigInt(bits - 1)), 1n << BigInt(bits - 1));
            }
        }

        let x = encoder.finish();
        let coded = "";
        while (x > 0n) {
            coded = B64[Number(x % 64n)] + coded;
            x /= 64n;
        }

        return "v=4&g=" + coded;
    },

    deserializeGame(gameString) {
        if (typeof gameString !== "string" || gameString.length === 0) {
            return { p: [], m: [], t: [] };
        }

        let x = 0n;
        for (const ch of gameString) {
            const digit = B64.indexOf(ch);
            if (digit < 0) {
                throw new Error("invalid v4 character");
            }
            x = x * 64n + BigInt(digit);
        }

        const decoder = new RansDecoder(x);

        const flat = [];
        for (let i = 0; i < (SIZE * SIZE) / 3; i++) {
            const v = decoder.uniform(125);
            flat.push(Math.floor(v / 25) + 1, Math.floor(v / 5) % 5 + 1, (v % 5) + 1);
        }
        const position = [];
        for (let i = 0; i < SIZE; i++) {
            position.push(flat.slice(i * SIZE, (i + 1) * SIZE));
        }

        const moveCount = decoder.uniform(MOVES_RADIX);
        const hasTimes = moveCount > 0 && decoder.uniform(2) === 1;

        const moves = [];
        const pos = clonePosition(position);
        let anchor = null;

        for (let i = 0; i < moveCount; i++) {
            const groups = enumerateGroups(pos);
            if (groups.length === 0) {
                throw new Error("v4 stream encodes more moves than the board allows");
            }

            let chosen;
            if (anchor === null) {
                chosen = decoder.uniform(groups.length);
            } else {
                const rank = decoder.symbol(RANK_PREFIX.slice(0, Math.min(groups.length, 72) + 1));
                chosen = orderedGroupIndices(groups, anchor)[rank];
            }

            moves.push([...groups[chosen].rep]);
            anchor = groups[chosen].rep;
            removeGroup(pos, groups[chosen].cells);
        }

        let times = [];
        if (hasTimes) {
            times = [0];
            for (let i = 1; i < moveCount; i++) {
                times.push(times[i - 1] + GAP_CODEBOOK[decoder.symbol(GAP_PREFIX)]);
            }

            const bits = decoder.uniform(RESIDUAL_RADIX);
            const residual = bits === 0 ? 0n :
                bits === 1 ? 1n : (1n << BigInt(bits - 1)) + decoder.uniformBig(1n << BigInt(bits - 1));
            times[moveCount - 1] += Number(residual);
        }

        decoder.verifyEndState();

        return { p: position, m: moves, t: times };
    },
};

//
// version dispatcher — public API
//
const unknownVersion = () => {
    globalThis.alert?.("Error: Unknown serialization version");
    return undefined;
};

export const Serializer = {
    serializePosition: (version, position) =>
        version === 3 ? Serializer3.serializePosition(position) : unknownVersion(),

    deserializePosition: (version, serial) =>
        version === 3 ? Serializer3.deserializePosition(serial) : unknownVersion(),

    serializeMoves: (version, moves) =>
        version === 3 ? Serializer3.serializeMoves(moves) : unknownVersion(),

    deserializeMoves: (version, serial) =>
        version === 3 ? Serializer3.deserializeMoves(serial) : unknownVersion(),

    serializeTimes: (version, times) =>
        version === 3 ? Serializer3.serializeTimes(times) : unknownVersion(),

    deserializeTimes: (version, serial) =>
        version === 3 ? Serializer3.deserializeTimes(serial) : unknownVersion(),

    serializeGame(version, position, moves, times) {
        switch (version) {
            case 1: return Serializer1.serialize(position, moves, times);
            case 2: return Serializer2.serializeGame(position, moves, times);
            case 3: return Serializer3.serializeGame(position, moves, times);
            case 4: return Serializer4.serializeGame(position, moves, times);
            default: return unknownVersion();
        }
    },

    // never throws — malformed links deserialize to an empty game
    deserializeGame(gameString) {
        try {
            const gameParams = getQueryParams(gameString);

            switch (gameParams.v) {
                case undefined: return Serializer1.deserialize(gameParams.position, gameParams.moves, gameParams.times);
                case "2": return Serializer2.deserializeGame(gameParams.p, gameParams.m, gameParams.t);
                case "3": return Serializer3.deserializeGame(gameParams.p, gameParams.m, gameParams.t);
                case "4": return Serializer4.deserializeGame(gameParams.g);
                default: return unknownVersion() ?? { p: [], m: [], t: [] };
            }
        } catch {
            return { p: [], m: [], t: [] };
        }
    },
};
