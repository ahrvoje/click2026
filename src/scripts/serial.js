/**
 * Click2026 — game serialization.
 *
 * Three wire formats are supported for backward compatibility with old game links:
 *   v1 (no "v" param) — plain decimal position/moves/times lists
 *   v2               — base-71 packed position, Huffman-coded move deltas, lossy log-coded times
 *   v3               — like v2 but packed with a URL-safe base-64 alphabet (current format)
 * New games are always serialized as v3. The encoding tables and the lossy time
 * compression math are frozen — do not "clean them up", links depend on them.
 *
 * Copyright 2014-2026, Hrvoje Abraham ahrvoje@gmail.com
 * Released under the MIT license.
 * https://opensource.org/licenses/MIT
 *
 * Date: Thu Apr 23, 2015
 *       Sat Oct 02, 2021
 *       Sat Jul 11, 2026 - modernized to ES module, zero dependencies
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

    deserializeGame(positionString, movesString, timesString) {
        return {
            p: this.deserializePosition(positionString),
            m: this.deserializeMoves(movesString) ?? [],
            t: this.deserializeTimes(timesString) ?? [],
        };
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
                default: return unknownVersion() ?? { p: [], m: [], t: [] };
            }
        } catch {
            return { p: [], m: [], t: [] };
        }
    },
};
