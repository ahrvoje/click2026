/** Regression tests for platform defaults and suggested-move presentation. */

import assert from "node:assert/strict";
import {
    isMobilePlatform,
    normalizeSettings,
    SUGGESTED_MOVES_MODES,
} from "../src/scripts/settings.js";
import { selectSuggestedMoves } from "../src/scripts/engine-ui.js";

assert.equal(isMobilePlatform({ userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5)" }), true);
assert.equal(isMobilePlatform({
    userAgent: "Mozilla/5.0 (Macintosh)", platform: "MacIntel", maxTouchPoints: 5,
}), true);
assert.equal(isMobilePlatform({
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)", platform: "Win32",
}), false);

assert.deepEqual(normalizeSettings(null, { userAgent: "iPhone" }), {
    showMovesSlider: true,
    suggestedMovesMode: SUGGESTED_MOVES_MODES.TOP_5,
});
assert.deepEqual(normalizeSettings(null, { userAgent: "Windows" }), {
    showMovesSlider: false,
    suggestedMovesMode: SUGGESTED_MOVES_MODES.TOP_5,
});
assert.deepEqual(normalizeSettings({
    showMovesSlider: true, suggestedMovesMode: SUGGESTED_MOVES_MODES.ALL,
}, { userAgent: "Windows" }), {
    showMovesSlider: true,
    suggestedMovesMode: SUGGESTED_MOVES_MODES.ALL,
});

const moves = [0, 0, 0, 0, 0, 2, 3].map((score, cell) => ({ cell, score }));
assert.deepEqual(selectSuggestedMoves(moves, "top5").map((move) => move.cell), [0, 1, 2, 3, 4]);
assert.deepEqual(selectSuggestedMoves(moves, "top5-nonzero").map((move) => move.cell),
    [0, 1, 2, 3, 4, 5]);
assert.deepEqual(selectSuggestedMoves(moves, "all").map((move) => move.cell),
    [0, 1, 2, 3, 4, 5, 6]);

const earlyNonzero = [0, 1, 2, 3, 4, 5].map((score, cell) => ({ cell, score }));
assert.equal(selectSuggestedMoves(earlyNonzero, "top5-nonzero").length, 5);
assert.equal(selectSuggestedMoves(moves, "invalid").length, 5);

console.log("ok    settings and suggested-move modes");
