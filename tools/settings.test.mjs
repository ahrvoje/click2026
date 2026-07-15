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

const engineDefaults = {
    engineUseCpu: true,
    engineUseGpu: true,
    engineStopOnZero: false,
    engineMaxTimeEnabled: false,
    engineMaxTimeS: 60,
    engineMaxPositionsEnabled: false,
    engineMaxPositionsM: 1000,
};
assert.deepEqual(normalizeSettings(null, { userAgent: "iPhone" }), {
    showMovesSlider: true,
    suggestedMovesMode: SUGGESTED_MOVES_MODES.TOP_5,
    ...engineDefaults,
});
assert.deepEqual(normalizeSettings(null, { userAgent: "Windows" }), {
    showMovesSlider: false,
    suggestedMovesMode: SUGGESTED_MOVES_MODES.TOP_5,
    ...engineDefaults,
});
assert.deepEqual(normalizeSettings({
    showMovesSlider: true, suggestedMovesMode: SUGGESTED_MOVES_MODES.ALL,
}, { userAgent: "Windows" }), {
    showMovesSlider: true,
    suggestedMovesMode: SUGGESTED_MOVES_MODES.ALL,
    ...engineDefaults,
});

// engine settings: processors round-trip, but never both off — CPU is the
// universal fallback when a stored/imported value disables everything
const engineOf = (value) => {
    const { engineUseCpu, engineUseGpu, engineStopOnZero, engineMaxTimeEnabled,
        engineMaxTimeS, engineMaxPositionsEnabled, engineMaxPositionsM } =
        normalizeSettings(value, { userAgent: "Windows" });
    return { engineUseCpu, engineUseGpu, engineStopOnZero, engineMaxTimeEnabled,
        engineMaxTimeS, engineMaxPositionsEnabled, engineMaxPositionsM };
};
assert.deepEqual(engineOf({ engineUseCpu: false, engineUseGpu: true }),
    { ...engineDefaults, engineUseCpu: false });
assert.deepEqual(engineOf({ engineUseCpu: true, engineUseGpu: false }),
    { ...engineDefaults, engineUseGpu: false });
assert.deepEqual(engineOf({ engineUseCpu: false, engineUseGpu: false }),
    { ...engineDefaults, engineUseGpu: false }); // both off forces CPU back on

// stop conditions: both limits may be enabled simultaneously, and the numeric
// values are sanitized to bounded positive integers
assert.deepEqual(engineOf({
    engineStopOnZero: true,
    engineMaxTimeEnabled: true, engineMaxTimeS: 90,
    engineMaxPositionsEnabled: true, engineMaxPositionsM: 250,
}), {
    ...engineDefaults,
    engineStopOnZero: true,
    engineMaxTimeEnabled: true, engineMaxTimeS: 90,
    engineMaxPositionsEnabled: true, engineMaxPositionsM: 250,
});
assert.equal(engineOf({ engineMaxTimeS: "42" }).engineMaxTimeS, 42);
assert.equal(engineOf({ engineMaxTimeS: 0 }).engineMaxTimeS, 60);
assert.equal(engineOf({ engineMaxTimeS: -5 }).engineMaxTimeS, 60);
assert.equal(engineOf({ engineMaxTimeS: Number.NaN }).engineMaxTimeS, 60);
assert.equal(engineOf({ engineMaxTimeS: 1e9 }).engineMaxTimeS, 86400);
assert.equal(engineOf({ engineMaxPositionsM: 2.6 }).engineMaxPositionsM, 3);
assert.equal(engineOf({ engineMaxPositionsM: 1e9 }).engineMaxPositionsM, 1000000);
assert.equal(engineOf({ engineMaxPositionsM: "junk" }).engineMaxPositionsM, 1000);

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
