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
import { clonePosition, extractGroup, removeGroup, enumerateGroups } from "./board.js";

const DEFAULT_COUNT = 10000;
const DEFAULT_GROUP_SIZE = 1;

// random legal game with synthetic times, used by the v4 round-trip test
function randomRecordedGame() {
    const position = new Game().getStartPosition();

    const moves = [];
    const pos = clonePosition(position);
    const targetMoves = Math.floor(Math.random() * 73);
    while (moves.length < targetMoves) {
        const groups = enumerateGroups(pos);
        if (groups.length === 0) {
            break;
        }
        const group = groups[Math.floor(Math.random() * groups.length)];
        moves.push([...group.cells[Math.floor(Math.random() * group.cells.length)]]);
        removeGroup(pos, group.cells);
    }

    const times = [];
    if (moves.length > 0 && Math.random() > 0.1) {
        times.push(0);
        for (let i = 1; i < moves.length; i++) {
            const r = Math.random();
            const delta = r < 0.02 ? 0 : r < 0.04 ? Math.floor(Math.random() * 2 ** 31) : Math.floor(20 + 5000 * Math.random());
            times.push(times[i - 1] + delta);
        }
    }

    return { position, moves, times };
}

// random position tree with variant branches and engine scores, plus synthetic
// times covering a random prefix of the main line — used by the v5 round-trip test
function randomTreeGame() {
    const position = new Game().getStartPosition();

    let nodesLeft = 60;
    const randomNode = (pos, depth) => {
        const node = {
            move: null,
            score: Math.random() < 0.4 ? Math.floor(Math.random() * 145) : null,
            children: [],
        };

        const groups = enumerateGroups(pos);
        const r = Math.random();
        let want = depth > 25 || nodesLeft <= 0 ? 0 : r < 0.15 ? 0 : r < 0.85 ? 1 : r < 0.97 ? 2 : 3;
        want = Math.min(want, groups.length);

        const picked = new Set();
        while (picked.size < want) {
            picked.add(Math.floor(Math.random() * groups.length));
        }

        for (const groupIndex of picked) {
            const group = groups[groupIndex];
            const next = clonePosition(pos);
            removeGroup(next, group.cells);

            nodesLeft--;
            const child = randomNode(next, depth + 1);
            child.move = [...group.cells[Math.floor(Math.random() * group.cells.length)]];
            node.children.push(child);
        }

        return node;
    };
    const root = randomNode(clonePosition(position), 0);

    let mainLength = 0;
    for (let node = root; node.children.length > 0; node = node.children[0]) {
        mainLength++;
    }

    const times = [];
    if (mainLength > 0 && Math.random() > 0.2) {
        const timedCount = 1 + Math.floor(Math.random() * mainLength);
        times.push(0);
        for (let i = 1; i < timedCount; i++) {
            times.push(times[i - 1] + Math.floor(20 + 5000 * Math.random()));
        }
    }

    return { position, root, times };
}

// deep tree comparison by replay: both moves must select the same group, scores and
// child counts must match exactly; returns true when the trees are equivalent
function sameTree(pos1, node1, pos2, node2) {
    if (node1.score !== node2.score || node1.children.length !== node2.children.length) {
        return false;
    }

    for (let i = 0; i < node1.children.length; i++) {
        const g1 = extractGroup(pos1, node1.children[i].move);
        const g2 = extractGroup(pos2, node2.children[i].move);
        if (g1.length < 2 || g1.length !== g2.length) {
            return false;
        }

        const next1 = clonePosition(pos1);
        const next2 = clonePosition(pos2);
        removeGroup(next1, g1);
        removeGroup(next2, g2);

        if (JSON.stringify(next1) !== JSON.stringify(next2) ||
            !sameTree(next1, node1.children[i], next2, node2.children[i])) {
            return false;
        }
    }

    return true;
}

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
            name: "v4 game serialization",
            count: 2000,
            groupSize: 20,
            prologText: "2,000 v4 game round-trip checks running...\n",
            epilogText: "Test finished OK.\n",
            blocking: true,
            exec() {
                const { position, moves, times } = randomRecordedGame();

                const serialized = Serializer.serializeGame(4, position, moves, times);
                const d = Serializer.deserializeGame("?" + serialized);

                let ok = JSON.stringify(d.p) === JSON.stringify(position) && d.m.length === moves.length;

                // decoded moves must replay to the same board states as the originals
                const pos1 = clonePosition(position);
                const pos2 = clonePosition(position);
                for (let i = 0; ok && i < moves.length; i++) {
                    const g1 = extractGroup(pos1, moves[i]);
                    const g2 = extractGroup(pos2, d.m[i]);
                    ok = g1.length >= 2 && g1.length === g2.length;
                    removeGroup(pos1, g1);
                    removeGroup(pos2, g2);
                    ok = ok && JSON.stringify(pos1) === JSON.stringify(pos2);
                }

                if (ok && times.length > 0) {
                    // total time exact, times monotone, every move time within the
                    // quantization bound of the recorded one
                    ok = d.t.length === times.length && d.t[d.t.length - 1] === times[times.length - 1];
                    for (let i = 1; ok && i < times.length; i++) {
                        const err = times[i] - d.t[i];
                        ok = d.t[i] >= d.t[i - 1] &&
                            (i === times.length - 1 || (err >= 0 && err <= Math.max(1, (times[i] - d.t[i - 1]) / 69 + 1)));
                    }
                } else if (ok) {
                    ok = d.t.length === 0;
                }

                // decoded game must re-serialize to the identical string
                ok = ok && Serializer.serializeGame(4, d.p, d.m, d.t) === serialized;

                if (!ok) {
                    logFailure("Test failed: v4 game round-trip", [
                        ["position", position],
                        ["moves", moves],
                        ["times", times],
                        ["serialized", serialized],
                        ["deserialized", d],
                    ]);
                    return false;
                }
                return true;
            },
        }, {
            name: "v5 tree serialization",
            count: 500,
            groupSize: 5,
            prologText: "500 v5 position-tree round-trip checks running...\n",
            epilogText: "Test finished OK.\n",
            blocking: true,
            exec() {
                const { position, root, times } = randomTreeGame();

                const serialized = Serializer.serializeGameTree(position, root, times);
                const d = Serializer.deserializeGame("?" + serialized);

                let ok = JSON.stringify(d.p) === JSON.stringify(position) &&
                    d.tree !== undefined &&
                    sameTree(clonePosition(position), root, clonePosition(d.p), d.tree);

                if (ok && times.length > 0) {
                    // total time of the timed prefix is exact, times stay monotone
                    ok = d.t.length === times.length && d.t[d.t.length - 1] === times[times.length - 1];
                    for (let i = 1; ok && i < times.length; i++) {
                        const err = times[i] - d.t[i];
                        ok = d.t[i] >= d.t[i - 1] &&
                            (i === times.length - 1 || (err >= 0 && err <= Math.max(1, (times[i] - d.t[i - 1]) / 69 + 1)));
                    }
                } else if (ok) {
                    ok = d.t.length === 0;
                }

                // decoded game must re-serialize to the identical string
                ok = ok && Serializer.serializeGameTree(d.p, d.tree, d.t) === serialized;

                // a Game built from the link must serialize back to the same link,
                // unless the tree is trivial enough for the shorter v4 format
                if (ok) {
                    const gameString = new Game("?" + serialized).getString();
                    ok = gameString === serialized || gameString.startsWith("v=4&");
                }

                if (!ok) {
                    logFailure("Test failed: v5 tree round-trip", [
                        ["position", position],
                        ["tree", root],
                        ["times", times],
                        ["serialized", serialized],
                        ["deserialized", d],
                    ]);
                    return false;
                }
                return true;
            },
        }, {
            name: "Legacy link compatibility",
            count: 1,
            groupSize: 1,
            prologText: "v2/v3 legacy link decoding checks running...\n",
            epilogText: "Test finished OK.\n",
            blocking: true,
            exec() {
                // 2021-deployed v3 dialect (base-71 moves/times)
                const wild = "?v=3&p=feNbne25-HeiPenCCk7MmBeesRyyeIDFCgdc1h_I4VbXl2CzWihjyOmI" +
                    "&m=403tUpC1-(C9xC54lxWSe,909pFO4.*pUIfl+OqOR+Ym" +
                    "&t=3_6,1ro*69rk4AA.6(nvuVCjNZuQMe_4!rYPFj5i1n8";
                const wildGame = new Game(wild);

                // v2 link
                const v2 = "?v=2&p=cTwQyHpc746X!j0)+)lJ6SA2viItJh!I4p+OvWdyciYJh_S*x(oEF_dfy+pUi" +
                    "&m=303FyOWwb!Ynvljq.u-(h,b179aWJaRW37KFhOq-5p83&t=47S,1H2yNsy+4xZmu*-YqD2oOdVdgAtA-V7S.ZUB$wIb";
                const v2Game = new Game(v2);

                if (wildGame.getMoves().length !== 49 || wildGame.getTimes()[48] !== 19673 ||
                    v2Game.getMoves().length !== 45 || v2Game.getTimes().length !== 45) {
                    logFailure("Test failed: legacy link decoding", [
                        ["v3 moves", wildGame.getMoves().length],
                        ["v3 total", wildGame.getTimes()[48]],
                        ["v2 moves", v2Game.getMoves().length],
                    ]);
                    return false;
                }
                return true;
            },
        }, {
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
