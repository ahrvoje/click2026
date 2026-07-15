/**
 * Click2026 — persisted, platform-aware presentation and engine settings.
 *
 * Presentation preferences only control the move navigator and how many
 * already-ranked engine moves are shown. Engine preferences select the
 * processors the analysis may use (CPU / GPU) and optional stop conditions
 * (first zero-score line, elapsed time, evaluated position count); the search
 * algorithms themselves are not tuned here.
 */

const STORAGE_KEY = "click2026.settings.v1";

export const SUGGESTED_MOVES_MODES = Object.freeze({
    TOP_5: "top5",
    TOP_5_NONZERO: "top5-nonzero",
    ALL: "all",
});

const VALID_MODES = new Set(Object.values(SUGGESTED_MOVES_MODES));

const MAX_TIME_S = 86400;        // one day
const MAX_POSITIONS_M = 1000000; // one trillion positions
const DEFAULT_TIME_S = 60;
const DEFAULT_POSITIONS_M = 1000;

function limitNumber(value, fallback, max) {
    const number = Math.round(Number(value));
    if (!Number.isFinite(number) || number < 1) return fallback;
    return Math.min(number, max);
}

export function isMobilePlatform(nav = globalThis.navigator ?? {}) {
    const ua = String(nav.userAgent ?? "");
    return nav.userAgentData?.mobile === true ||
        /Android|iPhone|iPad|iPod|Mobile/i.test(ua) ||
        (nav.platform === "MacIntel" && Number(nav.maxTouchPoints) > 1);
}

export function normalizeSettings(value, nav = globalThis.navigator ?? {}) {
    const engineUseGpu = value?.engineUseGpu !== false;
    return {
        showMovesSlider: typeof value?.showMovesSlider === "boolean"
            ? value.showMovesSlider : isMobilePlatform(nav),
        suggestedMovesMode: VALID_MODES.has(value?.suggestedMovesMode)
            ? value.suggestedMovesMode : SUGGESTED_MOVES_MODES.TOP_5,
        // at least one processor stays enabled; CPU is the universal fallback
        engineUseCpu: value?.engineUseCpu !== false || !engineUseGpu,
        engineUseGpu,
        engineStopOnZero: value?.engineStopOnZero === true,
        engineMaxTimeEnabled: value?.engineMaxTimeEnabled === true,
        engineMaxTimeS: limitNumber(value?.engineMaxTimeS, DEFAULT_TIME_S, MAX_TIME_S),
        engineMaxPositionsEnabled: value?.engineMaxPositionsEnabled === true,
        engineMaxPositionsM: limitNumber(value?.engineMaxPositionsM,
            DEFAULT_POSITIONS_M, MAX_POSITIONS_M),
    };
}

function readSettings(nav) {
    try {
        return normalizeSettings(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null"), nav);
    } catch {
        return normalizeSettings(null, nav);
    }
}

function writeSettings(value) {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
    } catch {
        // A private/locked-down browser may reject storage. The settings still
        // apply for the current page and safely fall back to defaults next load.
    }
}

export const Settings = {
    value: null,

    init({ onOpen, onMovesSliderChange, onSuggestedMovesChange, onEngineChange }) {
        const dialog = document.getElementById("settingsDialog");
        const button = document.getElementById("settingsButton");
        const sliderCheckbox = document.getElementById("showMovesSlider");
        const modeInputs = [...document.querySelectorAll('input[name="suggestedMovesMode"]')];
        const cpuCheckbox = document.getElementById("engineUseCpu");
        const gpuCheckbox = document.getElementById("engineUseGpu");
        const zeroCheckbox = document.getElementById("engineStopOnZero");
        const timeCheckbox = document.getElementById("engineMaxTimeEnabled");
        const timeInput = document.getElementById("engineMaxTimeS");
        const positionsCheckbox = document.getElementById("engineMaxPositionsEnabled");
        const positionsInput = document.getElementById("engineMaxPositionsM");

        this.value = readSettings(navigator);

        const syncInputs = () => {
            sliderCheckbox.checked = this.value.showMovesSlider;
            for (const input of modeInputs) {
                input.checked = input.value === this.value.suggestedMovesMode;
            }
            cpuCheckbox.checked = this.value.engineUseCpu;
            gpuCheckbox.checked = this.value.engineUseGpu;
            zeroCheckbox.checked = this.value.engineStopOnZero;
            timeCheckbox.checked = this.value.engineMaxTimeEnabled;
            timeInput.value = String(this.value.engineMaxTimeS);
            timeInput.disabled = !this.value.engineMaxTimeEnabled;
            positionsCheckbox.checked = this.value.engineMaxPositionsEnabled;
            positionsInput.value = String(this.value.engineMaxPositionsM);
            positionsInput.disabled = !this.value.engineMaxPositionsEnabled;
        };
        syncInputs();

        // unchecking the last enabled processor turns the other one on, so the
        // engine always has something to search with
        cpuCheckbox.addEventListener("change", () => {
            if (!cpuCheckbox.checked && !gpuCheckbox.checked) gpuCheckbox.checked = true;
        });
        gpuCheckbox.addEventListener("change", () => {
            if (!gpuCheckbox.checked && !cpuCheckbox.checked) cpuCheckbox.checked = true;
        });

        const apply = () => {
            const selectedMode = modeInputs.find((input) => input.checked)?.value;
            this.value = normalizeSettings({
                showMovesSlider: sliderCheckbox.checked,
                suggestedMovesMode: selectedMode,
                engineUseCpu: cpuCheckbox.checked,
                engineUseGpu: gpuCheckbox.checked,
                engineStopOnZero: zeroCheckbox.checked,
                engineMaxTimeEnabled: timeCheckbox.checked,
                engineMaxTimeS: timeInput.value,
                engineMaxPositionsEnabled: positionsCheckbox.checked,
                engineMaxPositionsM: positionsInput.value,
            }, navigator);
            writeSettings(this.value);
            syncInputs();
            onMovesSliderChange(this.value.showMovesSlider);
            onSuggestedMovesChange(this.value.suggestedMovesMode);
            onEngineChange?.(this.value);
        };

        const applyInputs = [sliderCheckbox, ...modeInputs, cpuCheckbox, gpuCheckbox,
            zeroCheckbox, timeCheckbox, timeInput, positionsCheckbox, positionsInput];
        for (const input of applyInputs) input.addEventListener("change", apply);
        button.addEventListener("click", () => {
            onOpen();
            dialog.showModal();
        });
        dialog.addEventListener("click", (event) => {
            if (event.target === dialog) dialog.close();
        });

        onMovesSliderChange(this.value.showMovesSlider);
        onSuggestedMovesChange(this.value.suggestedMovesMode);
        onEngineChange?.(this.value);
    },
};
