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

// Engine resource utilization per processor: the share of the CPU-search
// lanes and of the GPU device the analysis may keep busy. 0 turns that
// processor's sustained search off entirely (with CPU at 0 the instant
// baselines and replay validation still run). The desktop defaults pair the
// power-efficient GPU playout pump with the 1% CPU whisper mode — a single
// lane trickling toward exact proofs — so long continuous play stays quiet
// while proofs still land. Mobile processors are far weaker, so those
// defaults would barely move the analysis — mobile starts at higher shares
// instead. When the GPU side is off or unavailable and the CPU share is 0,
// the CPU fallback snaps to a modest nonzero share instead
// (see normalizeSettings).
const MIN_RESOURCE_PERCENT = 1;
const MAX_RESOURCE_PERCENT = 100;
const DEFAULT_CPU_RESOURCE_PERCENT = 1;
const DEFAULT_GPU_RESOURCE_PERCENT = 15;
const MOBILE_CPU_RESOURCE_PERCENT = 25;
const MOBILE_GPU_RESOURCE_PERCENT = 40;
const FALLBACK_CPU_RESOURCE_PERCENT = 20;

function limitNumber(value, fallback, max) {
    const number = Math.round(Number(value));
    if (!Number.isFinite(number) || number < 1) return fallback;
    return Math.min(number, max);
}

function limitPercent(value, fallback) {
    const number = Math.round(Number(value));
    if (!Number.isFinite(number)) return fallback;
    if (number <= 0) return 0;
    return Math.min(MAX_RESOURCE_PERCENT, Math.max(MIN_RESOURCE_PERCENT, number));
}

export function isMobilePlatform(nav = globalThis.navigator ?? {}) {
    const ua = String(nav.userAgent ?? "");
    return nav.userAgentData?.mobile === true ||
        /Android|iPhone|iPad|iPod|Mobile/i.test(ua) ||
        (nav.platform === "MacIntel" && Number(nav.maxTouchPoints) > 1);
}

export function normalizeSettings(value, nav = globalThis.navigator ?? {}) {
    const mobile = isMobilePlatform(nav);
    const engineUseGpu = value?.engineUseGpu !== false;
    // at least one processor stays enabled; CPU is the universal fallback
    let engineUseCpu = value?.engineUseCpu !== false || !engineUseGpu;
    const engineGpuResourcePercent = limitPercent(value?.engineGpuResourcePercent,
        mobile ? MOBILE_GPU_RESOURCE_PERCENT : DEFAULT_GPU_RESOURCE_PERCENT);
    let engineCpuResourcePercent = limitPercent(value?.engineCpuResourcePercent,
        mobile ? MOBILE_CPU_RESOURCE_PERCENT : DEFAULT_CPU_RESOURCE_PERCENT);
    // A zero CPU share is only meaningful while the GPU is enabled with a
    // nonzero share; otherwise nothing would search, so the universal CPU
    // fallback snaps on at a modest utilization.
    if (!(engineUseGpu && engineGpuResourcePercent > 0) &&
        (!engineUseCpu || engineCpuResourcePercent === 0)) {
        engineUseCpu = true;
        if (engineCpuResourcePercent === 0) {
            engineCpuResourcePercent = FALLBACK_CPU_RESOURCE_PERCENT;
        }
    }
    return {
        showMovesSlider: typeof value?.showMovesSlider === "boolean"
            ? value.showMovesSlider : mobile,
        suggestedMovesMode: VALID_MODES.has(value?.suggestedMovesMode)
            ? value.suggestedMovesMode : SUGGESTED_MOVES_MODES.TOP_5,
        engineUseCpu,
        engineUseGpu,
        engineCpuResourcePercent,
        engineGpuResourcePercent,
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
        const cpuResourceInput = document.getElementById("engineCpuResourcePercent");
        const cpuResourceValue = document.getElementById("engineCpuResourcePercentValue");
        const gpuResourceInput = document.getElementById("engineGpuResourcePercent");
        const gpuResourceValue = document.getElementById("engineGpuResourcePercentValue");
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
            cpuResourceInput.value = String(this.value.engineCpuResourcePercent);
            cpuResourceValue.textContent = `${this.value.engineCpuResourcePercent}%`;
            cpuResourceInput.disabled = !this.value.engineUseCpu;
            gpuResourceInput.value = String(this.value.engineGpuResourcePercent);
            gpuResourceValue.textContent = `${this.value.engineGpuResourcePercent}%`;
            gpuResourceInput.disabled = !this.value.engineUseGpu;
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
                engineCpuResourcePercent: cpuResourceInput.value,
                engineGpuResourcePercent: gpuResourceInput.value,
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
            cpuResourceInput, gpuResourceInput, zeroCheckbox, timeCheckbox, timeInput,
            positionsCheckbox, positionsInput];
        for (const input of applyInputs) input.addEventListener("change", apply);
        // Reflect each slider's live position in its label before release; the
        // throttle itself is committed by the "change" apply above.
        cpuResourceInput.addEventListener("input", () => {
            cpuResourceValue.textContent = `${cpuResourceInput.value}%`;
        });
        gpuResourceInput.addEventListener("input", () => {
            gpuResourceValue.textContent = `${gpuResourceInput.value}%`;
        });
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
