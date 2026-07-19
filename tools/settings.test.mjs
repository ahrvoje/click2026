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
    engineCpuResourcePercent: 1,
    engineGpuResourcePercent: 15,
    engineStopOnZero: false,
    engineMaxTimeEnabled: false,
    engineMaxTimeS: 60,
    engineMaxPositionsEnabled: false,
    engineMaxPositionsM: 1000,
};
// mobile processors are weaker, so the default utilization shares are higher
assert.deepEqual(normalizeSettings(null, { userAgent: "iPhone" }), {
    showMovesSlider: true,
    suggestedMovesMode: SUGGESTED_MOVES_MODES.TOP_5,
    ...engineDefaults,
    engineCpuResourcePercent: 25,
    engineGpuResourcePercent: 40,
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
    const { engineUseCpu, engineUseGpu, engineCpuResourcePercent,
        engineGpuResourcePercent, engineStopOnZero, engineMaxTimeEnabled,
        engineMaxTimeS, engineMaxPositionsEnabled, engineMaxPositionsM } =
        normalizeSettings(value, { userAgent: "Windows" });
    return { engineUseCpu, engineUseGpu, engineCpuResourcePercent,
        engineGpuResourcePercent, engineStopOnZero, engineMaxTimeEnabled,
        engineMaxTimeS, engineMaxPositionsEnabled, engineMaxPositionsM };
};
assert.deepEqual(engineOf({ engineUseCpu: false, engineUseGpu: true }),
    { ...engineDefaults, engineUseCpu: false });
// GPU off keeps the 1%-default CPU searching — no snap needed; both-off still
// forces the CPU checkbox back on (whisper share already nonzero)
assert.deepEqual(engineOf({ engineUseCpu: true, engineUseGpu: false }),
    { ...engineDefaults, engineUseGpu: false });
assert.deepEqual(engineOf({ engineUseCpu: false, engineUseGpu: false }),
    { ...engineDefaults, engineUseGpu: false });

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

// per-processor resource shares: CPU defaults to the 1% whisper mode (exact
// proofs at minimal speed), GPU to 15; 0 = off, nonzero values keep a 1..100
// band, junk falls to the default
assert.equal(engineOf({}).engineCpuResourcePercent, 1);
assert.equal(engineOf({}).engineGpuResourcePercent, 15);
assert.equal(engineOf({ engineCpuResourcePercent: 50 }).engineCpuResourcePercent, 50);
assert.equal(engineOf({ engineGpuResourcePercent: "35" }).engineGpuResourcePercent, 35);
assert.equal(engineOf({ engineCpuResourcePercent: 33.6 }).engineCpuResourcePercent, 34);
assert.equal(engineOf({ engineCpuResourcePercent: 1 }).engineCpuResourcePercent, 1);
assert.equal(engineOf({ engineCpuResourcePercent: 0.4 }).engineCpuResourcePercent, 0);
assert.equal(engineOf({ engineCpuResourcePercent: -20 }).engineCpuResourcePercent, 0);
assert.equal(engineOf({ engineGpuResourcePercent: 250 }).engineGpuResourcePercent, 100);
assert.equal(engineOf({ engineGpuResourcePercent: Number.NaN }).engineGpuResourcePercent, 15);
assert.equal(engineOf({ engineGpuResourcePercent: "junk" }).engineGpuResourcePercent, 15);

// zeroing the GPU share leaves the whisper-default CPU searching; snapping to
// the fallback happens only when the CPU share is explicitly 0 as well
const gpuZeroed = engineOf({ engineGpuResourcePercent: 0 });
assert.equal(gpuZeroed.engineGpuResourcePercent, 0);
assert.equal(gpuZeroed.engineCpuResourcePercent, 1);
assert.equal(gpuZeroed.engineUseCpu, true);
const bothZeroed = engineOf({ engineCpuResourcePercent: 0, engineGpuResourcePercent: 0 });
assert.equal(bothZeroed.engineCpuResourcePercent, 20);
assert.equal(bothZeroed.engineUseCpu, true);
assert.equal(engineOf({ engineUseCpu: false, engineGpuResourcePercent: 0 })
    .engineUseCpu, true); // forced back on — nothing else would search
// a nonzero CPU share is preserved by the fallback rule
assert.equal(engineOf({ engineCpuResourcePercent: 40, engineGpuResourcePercent: 0 })
    .engineCpuResourcePercent, 40);
// GPU-only remains expressible: CPU 0 is honored while the GPU side is active
assert.equal(engineOf({ engineCpuResourcePercent: 0 }).engineCpuResourcePercent, 0);

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
