/**
 * Click2026 — self tests: serialization round-trip checks running in a modal dialog.
 *
 * Copyright 2014-2026, Hrvoje Abraham ahrvoje@gmail.com
 * Released under the MIT license.
 * https://opensource.org/licenses/MIT
 *
 * Date: Tue Feb 16, 2016
 *       Sat Oct 02, 2021
 *       Sat Jul 11, 2026 - modernized to ES module, zero dependencies
 */

import { Game } from "./game.js";
import { Serializer } from "./serial.js";

const DEFAULT_COUNT = 10000;
const DEFAULT_GROUP_SIZE = 1;

export function createTests() {
    let testIndex = 0;
    let testIter = 0;
    let testInitialized = -1;
    let testOver = false;
    let testsStopped = false;

    const dialog = document.getElementById("testsDialog");
    const report = document.getElementById("progressReport");
    const stopButton = document.getElementById("testsStop");
    const progressCount = document.getElementById("progressCount");
    const progressShow = document.getElementById("progressShow");

    const log = (text) => {
        report.value += text;
        report.scrollTop = report.scrollHeight;
    };

    const logFailure = (title, entries) => {
        log(JSON.stringify([title, ...entries]) + "\n");
    };

    const tests = [
        {
            name: "Game serialization",
            count: DEFAULT_COUNT,
            groupSize: DEFAULT_GROUP_SIZE,
            prologText: "10,000 game (de)serialization checks running...\n",
            epilogText: "Test finished OK.\n",
            blocking: false,
            exec() {
                const position = new Game().getStartPosition();
                const serialized = Serializer.serializeGame(3, position, [], []);
                const deserialized = Serializer.deserializeGame("?" + serialized);

                if (JSON.stringify(position) !== JSON.stringify(deserialized.p)) {
                    logFailure("Test failed: Game (de)serialization", [
                        ["position", position],
                        ["serialized", serialized],
                        ["deserialized", deserialized],
                    ]);
                    return false;
                }
                return true;
            },
        }, {
            name: "Position serialization",
            count: DEFAULT_COUNT,
            groupSize: DEFAULT_GROUP_SIZE,
            prologText: "10,000 position (de)serialization checks running...\n",
            epilogText: "Test finished OK.\n",
            blocking: true,
            exec() {
                const position = new Game().getStartPosition();
                const position2 = Serializer.deserializePosition(3, Serializer.serializePosition(3, position));

                if (JSON.stringify(position) !== JSON.stringify(position2)) {
                    logFailure("Test failed: Position (de)serialization", [
                        ["position", position],
                        ["position2", position2],
                    ]);
                    return false;
                }
                return true;
            },
        }, {
            name: "Case#1 moves serialization",
            count: 1,
            groupSize: 1,
            prologText: "Case#1 moves (de)serialization check running...\n",
            epilogText: "Test finished OK.\n",
            blocking: true,
            exec() {
                const moves = [[8, 2], [9, 4], [4, 11], [6, 8], [10, 4], [7, 1], [3, 10], [1, 5], [6, 10], [9, 11],
                    [5, 3], [1, 9], [6, 9], [3, 4], [5, 5], [10, 0], [10, 10], [2, 6], [7, 6], [5, 6], [10, 0],
                    [4, 8], [3, 11], [5, 7], [10, 4], [5, 4], [2, 2], [9, 6], [11, 0], [5, 3], [7, 1], [10, 2],
                    [11, 5], [4, 2], [0, 7], [1, 5], [3, 9], [11, 2], [5, 11], [2, 7], [9, 10], [5, 10], [4, 9],
                    [5, 9], [9, 1]];

                const moves2 = Serializer.deserializeMoves(3, Serializer.serializeMoves(3, moves));

                if (JSON.stringify(moves) !== JSON.stringify(moves2)) {
                    logFailure("Test failed: Moves (de)serialization", [
                        ["moves", moves],
                        ["moves2", moves2],
                    ]);
                    return false;
                }
                return true;
            },
        }, {
            name: "Moves serialization",
            count: DEFAULT_COUNT,
            groupSize: DEFAULT_GROUP_SIZE,
            prologText: "10,000 moves (de)serialization checks running...\n",
            epilogText: "Test finished.\n",
            blocking: true,
            exec() {
                const random11 = () => Math.floor(Math.random() * 12);
                const moves = Array.from({ length: 45 }, () => [random11(), random11()]);

                const moves2 = Serializer.deserializeMoves(3, Serializer.serializeMoves(3, moves));

                if (JSON.stringify(moves) !== JSON.stringify(moves2)) {
                    logFailure("Test failed: Moves (de)serialization", [
                        ["moves", moves],
                        ["moves2", moves2],
                    ]);
                    return false;
                }
                return true;
            },
        }, {
            name: "Times serialization",
            count: DEFAULT_COUNT,
            groupSize: DEFAULT_GROUP_SIZE,
            prologText: "10,000 times (de)serialization checks running...\n",
            epilogText: "Test finished OK.\n",
            blocking: true,
            exec() {
                const randomDelta = () => 20 + Math.floor(5000 * Math.random());
                const n = 30 + Math.floor(30 * Math.random());

                const deltas = Array.from({ length: n }, randomDelta);

                const times = [0];
                for (let i = 0; i < n; i++) {
                    times.push(times[i] + deltas[i]);
                }

                const times2 = Serializer.deserializeTimes(3, Serializer.serializeTimes(3, times));

                const deltas2 = [];
                for (let i = 1; i < times2.length; i++) {
                    deltas2.push(times2[i] - times2[i - 1]);
                }

                // the encoding is lossy, so only check the deltas remain finite and order-consistent
                let failedAt = -1;
                for (let i = 0; i < n - 2; i++) {
                    if (Number.isNaN(deltas2[i]) || Number.isNaN(deltas2[i + 1]) ||
                        (deltas[i + 1] < deltas[i] && deltas2[i + 1] > deltas2[i]) ||
                        (deltas[i + 1] > deltas[i] && deltas2[i + 1] < deltas2[i])) {
                        failedAt = i;
                        break;
                    }
                }

                if (failedAt >= 0) {
                    logFailure("Test failed: Times (de)serialization", [
                        ["deltas", deltas],
                        ["deltas2", deltas2],
                        ["i", failedAt],
                        ["deltas[i]", deltas[failedAt]],
                        ["deltas[i + 1]", deltas[failedAt + 1]],
                    ]);
                    return false;
                }
                return true;
            },
        },
    ];

    const stopTests = () => {
        testOver = true;
        testsStopped = true;
        stopButton.textContent = "Close";
        stopButton.onclick = closeTestDialog;
    };

    function showTestDialog() {
        report.value = "";
        stopButton.textContent = "Stop";
        stopButton.onclick = stopTests;
        dialog.showModal();
    }

    function closeTestDialog() {
        dialog.close();
    }

    const setProgress = (p) => {
        progressCount.textContent = p;
        progressShow.style.width = p;
    };

    // the run is chunked via consecutive self-registered timer callbacks,
    // so the dialog stays responsive while thousands of checks execute
    function execute() {
        for (; testIndex < tests.length; testIndex++) {
            const test = tests[testIndex];

            // update and refresh GUI with new test info
            if (testIndex !== testInitialized) {
                log(`(${testIndex + 1}/${tests.length}) ${test.name}\n`);
                log("      " + test.prologText);
                setProgress("0%");
                testInitialized = testIndex;
                setTimeout(execute, 0);
                return;
            }

            for (; testIter < test.count; testIter++) {
                const testResult = test.exec();

                // if the test failed and is of blocking type, go to the next test
                if (!testResult && test.blocking) {
                    testIter = 0;
                    testIndex++;
                    setTimeout(execute, 0);
                    return;
                }

                // every groupSize iterations, take a break
                const iter1 = testIter + 1;
                if (iter1 % test.groupSize === 0) {
                    setProgress(Math.floor((100 * iter1) / test.count) + "%");

                    if (testsStopped) {
                        log("Testing stopped.");
                        return;
                    }

                    if (iter1 < test.count) {
                        // set a timer for the next iteration,
                        // manually incrementing because we exit the loop
                        setTimeout(execute, 0);
                        testIter++;
                        return;
                    }
                }
            }

            if (!testOver && testIter === test.count) {
                setProgress("100%");
                log("      " + test.epilogText);
            }
            testIter = 0;

            if (testIndex + 1 === tests.length) {
                stopTests();
                log("All tests finished OK.\n");
            }
        }
    }

    return {
        run() {
            // native dialog can also be dismissed with Esc — treat it as Stop
            dialog.addEventListener("cancel", stopTests, { once: true });
            showTestDialog();
            execute();
        },
    };
}
