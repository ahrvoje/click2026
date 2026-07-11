/**
 * Click2026 — misc helpers: string padding, base conversions, Huffman coding, query parsing.
 *
 * Copyright 2014-2026, Hrvoje Abraham ahrvoje@gmail.com
 * Released under the MIT license.
 * https://opensource.org/licenses/MIT
 *
 * Date: Mon Sep 08, 2014
 *       Sat Oct 02, 2021
 *       Sat Jul 11, 2026 - modernized to ES module, zero dependencies
 */

export const padZeros = (s, count) => "0".repeat(Math.max(0, count)) + s;

export const padZerosMod = (s, mod) => s.padStart(s.length + (mod - (s.length % mod)) % mod, "0");

// strip leading zeros, but keep a single "0" if the string is all zeros
export const topZeros = (s) => s.replace(/^0+(?=.)/, "");

export const tailZeros = (s) => s.replace(/0+$/, "");

export const swapKeyValue = (d) => Object.fromEntries(Object.entries(d).map(([k, v]) => [v, k]));

// digit alphabet shared by all base conversions, index = digit value (base up to 71)
// all characters are URL-query safe, so serialized games survive inside a link
const CHARS = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ$-_.+!*()";

export function baseXtoBaseY(numberX, baseX, baseY) {
    let number10 = 0;
    for (const ch of numberX) {
        number10 = baseX * number10 + CHARS.indexOf(ch);
    }

    if (number10 === 0) {
        return "0";
    }

    let numberY = "";
    while (number10 > 0) {
        const mod = number10 % baseY;
        numberY = CHARS[mod] + numberY;
        number10 = (number10 - mod) / baseY;
    }

    return numberY;
}

// converts a long digit string between bases chunk by chunk,
// sizeX source digits map to sizeY target digits, so precision never
// exceeds Number.MAX_SAFE_INTEGER no matter how long the string is
export function longXtoLongY(numberX, baseX, sizeX, baseY, sizeY) {
    numberX = padZerosMod(numberX, sizeX);

    let numberY = "";
    for (let i = 0; i < numberX.length / sizeX; i++) {
        numberY += padZerosMod(baseXtoBaseY(numberX.substring(sizeX * i, sizeX * (i + 1)), baseX, baseY), sizeY);
    }

    return numberY;
}

export function huffmanEncode(array, encodeTable) {
    return array.map((x) => encodeTable[x]).join("");
}

export function huffmanDecode(huffmanString, decodeTable) {
    const array = [];
    let code = "";

    for (const bit of huffmanString) {
        code += bit;

        const x = decodeTable[code];
        if (x !== undefined) {
            array.push(Number(x));
            code = "";
        }
    }

    return array;
}

// NOTE: deliberately NOT URLSearchParams — it decodes "+" as a space, which would
// corrupt legacy v2 game links whose base-71 alphabet contains "+", "!", "*", "(", ")"
export function getQueryParams(qs) {
    const result = {};
    const query = qs.split("?")[1] ?? "";

    for (const param of query.split("&")) {
        const [key, value] = param.split("=");
        result[key] = decodeURIComponent(value ?? "");
    }

    return result;
}
