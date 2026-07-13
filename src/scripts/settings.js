/**
 * Click2026 — persisted, platform-aware presentation settings.
 *
 * Search behavior is deliberately not changed here: these preferences only
 * control the move navigator and how many already-ranked engine moves are
 * presented by the main-thread UI.
 */

const STORAGE_KEY = "click2026.settings.v1";

export const SUGGESTED_MOVES_MODES = Object.freeze({
    TOP_5: "top5",
    TOP_5_NONZERO: "top5-nonzero",
    ALL: "all",
});

const VALID_MODES = new Set(Object.values(SUGGESTED_MOVES_MODES));

export function isMobilePlatform(nav = globalThis.navigator ?? {}) {
    const ua = String(nav.userAgent ?? "");
    return nav.userAgentData?.mobile === true ||
        /Android|iPhone|iPad|iPod|Mobile/i.test(ua) ||
        (nav.platform === "MacIntel" && Number(nav.maxTouchPoints) > 1);
}

export function normalizeSettings(value, nav = globalThis.navigator ?? {}) {
    return {
        showMovesSlider: typeof value?.showMovesSlider === "boolean"
            ? value.showMovesSlider : isMobilePlatform(nav),
        suggestedMovesMode: VALID_MODES.has(value?.suggestedMovesMode)
            ? value.suggestedMovesMode : SUGGESTED_MOVES_MODES.TOP_5,
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

    init({ onOpen, onMovesSliderChange, onSuggestedMovesChange }) {
        const dialog = document.getElementById("settingsDialog");
        const button = document.getElementById("settingsButton");
        const sliderCheckbox = document.getElementById("showMovesSlider");
        const modeInputs = [...document.querySelectorAll('input[name="suggestedMovesMode"]')];

        this.value = readSettings(navigator);
        sliderCheckbox.checked = this.value.showMovesSlider;
        for (const input of modeInputs) {
            input.checked = input.value === this.value.suggestedMovesMode;
        }

        const apply = () => {
            const selectedMode = modeInputs.find((input) => input.checked)?.value;
            this.value = normalizeSettings({
                showMovesSlider: sliderCheckbox.checked,
                suggestedMovesMode: selectedMode,
            }, navigator);
            writeSettings(this.value);
            onMovesSliderChange(this.value.showMovesSlider);
            onSuggestedMovesChange(this.value.suggestedMovesMode);
        };

        sliderCheckbox.addEventListener("change", apply);
        for (const input of modeInputs) input.addEventListener("change", apply);
        button.addEventListener("click", () => {
            onOpen();
            dialog.showModal();
        });
        dialog.addEventListener("click", (event) => {
            if (event.target === dialog) dialog.close();
        });

        onMovesSliderChange(this.value.showMovesSlider);
        onSuggestedMovesChange(this.value.suggestedMovesMode);
    },
};
