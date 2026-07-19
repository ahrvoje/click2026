/**
 * Click2026 — entry point: wires the DOM to the game controller.
 *
 * Copyright 2014-2026, Hrvoje Abraham ahrvoje@gmail.com
 * Released under the MIT license.
 * https://opensource.org/licenses/MIT
 *
 * Date: Wed Sep 10, 2014
 *       Sat Jul 11, 2026 - modernized to ES module, zero dependencies
 */

import * as Click from "./click.js?build=20260719-engine11";
import { createTests } from "./tests.js";
import { Settings } from "./settings.js?build=20260719-engine11";

// module scripts are deferred, so the DOM is complete at this point
const el = (id) => document.getElementById(id);

// the game area stays hidden unless scripts actually run
el("game").style.display = "flex";

el("startButton").addEventListener("click", Click.startNewGame);
el("backwardButton").addEventListener("click", Click.rewindBackward);
el("autoPlayButton").addEventListener("click", Click.autoPlay);
el("autoPauseButton").addEventListener("click", Click.autoPlay);
el("forwardButton").addEventListener("click", Click.rewindForward);
el("importButton").addEventListener("click", () => Click.importGame(window.prompt("Paste game link below")));
el("linkButton").addEventListener("click", Click.promptGameLink);
el("replayButton").addEventListener("click", Click.replayStartPosition);
el("engineButton").addEventListener("click", Click.toggleEngine);
el("markersButton").addEventListener("click", Click.toggleEngineMarkers);
el("movesSlider").addEventListener("input", (event) =>
    Click.showMoveFromSlider(Number(event.currentTarget.value)));

for (const exampleIndex of [0, 1, 2]) {
    el(`example${exampleIndex}`).addEventListener("click", () => {
        Click.loadExample(exampleIndex);
        setTimeout(() => {
            Click.stopAutoPlay();
            Click.autoPlay();
        }, 1000);
    });
}

el("runTests").addEventListener("click", () => createTests().run());

el("mail").addEventListener("click", () => window.prompt("Contact mail:", "ahrvoje@gmail.com"));

Click.init();
Settings.init({
    onOpen: Click.onSettingsOpened,
    onMovesSliderChange: Click.setMovesSliderVisible,
    onSuggestedMovesChange: Click.setSuggestedMovesMode,
    onEngineChange: Click.setEngineSettings,
});
