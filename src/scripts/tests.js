/**
 * Click2014
 *
 * Copyright 2014, Hrvoje Abraham ahrvoje@gmail.com
 * Released under the MIT license.
 * http://www.opensource.org/licenses/mit-license.php
 *
 * Date: Tue Feb 16, 2016
 *       Sat Oct 02, 2021
 */

Tests = (function () {
    var testIndex = 0, testIter = 0, testInitialized = -1, testOver = false, testsStopped = false,
        report = $("#progressReport"), defaultCount = 10000, defaultGroupSize = 1,

        tests = [{
            name: 'Game serialization',
            count: defaultCount,
            groupSize: defaultGroupSize,
            prologText: '10,000 game (de)serialization checks running...\n',
            epilogText: 'Test finished OK.\n',
            blocking: false,
            exec: function () {
                var position, serialized, deserialized;

                position = Game().getStartPosition();
                serialized = Serializer.serializeGame(3, position, [], []);
                deserialized = Serializer.deserializeGame('?' + serialized);
                if (JSON.stringify(position) != JSON.stringify(deserialized.p)) {
                    log(JSON.stringify(
                            ['Test failed: Position (de)serialization',
                                ['position', position],
                                ['serialized', serialized],
                                ['deserialized', deserialized]
                            ]) + "\n");
                    return false
                }
                return true
            }}, {
            name: 'Position serialization',
            count: defaultCount,
            groupSize: defaultGroupSize,
            prologText: '10,000 position (de)serialization checks running...\n',
            epilogText: 'Test finished OK.\n',
            blocking: true,
            exec: function () {
                var position, position2;

                position = Game().getStartPosition();
                position2 = Serializer.deserializePosition(3, Serializer.serializePosition(3, position));
                if (JSON.stringify(position) != JSON.stringify(position2)) {
                    log(JSON.stringify(
                            ['Test failed: Position (de)serialization',
                                ['position', position],
                                ['position2', position2]
                            ]) + "\n");
                    return false
                }
                return true
            }}, {
            name: 'Case#1 moves serialization',
            count: 1,
            groupSize: 1,
            prologText: 'Case#1 moves (de)serialization check running...\n',
            epilogText: 'Test finished OK.\n',
            blocking: true,
            exec: function () {
                var moves = [[8,2],[9,4],[4,11],[6,8],[10,4],[7,1],[3,10],[1,5],[6,10],[9,11],[5,3],[1,9],[6,9],[3,4],
                    [5,5],[10,0],[10,10],[2,6],[7,6],[5,6],[10,0],[4,8],[3,11],[5,7],[10,4],[5,4],[2,2],[9,6],[11,0],
                    [5,3],[7,1],[10,2],[11,5],[4,2],[0,7],[1,5],[3,9],[11,2],[5,11],[2,7],[9,10],[5,10],[4,9],[5,9],[9,1]],
                    moves2;

                moves2 = Serializer.deserializeMoves(3, Serializer.serializeMoves(3, moves));
                if (JSON.stringify(moves) != JSON.stringify(moves2)) {
                    log(JSON.stringify(
                            ['Test failed: Moves (de)serialization',
                                ['moves', moves],
                                ['moves2', moves2]
                            ]) + "\n");
                    return false
                }
                return true
            }}, {
            name: 'Moves serialization',
            count: defaultCount,
            groupSize: defaultGroupSize,
            prologText: '10,000 moves (de)serialization checks running...\n',
            epilogText: 'Test finished.\n',
            blocking: true,
            exec: function () {
                var random11, moves = [], moves2;

                random11 = function () {
                    return Math.floor(Math.random() * 12)
                };

                for (var i = 0; i < 45; i++) {
                    moves.push([random11(), random11()])
                }

                moves2 = Serializer.deserializeMoves(3, Serializer.serializeMoves(3, moves));
                if (JSON.stringify(moves) != JSON.stringify(moves2)) {
                    log(JSON.stringify(
                            ['Test failed: Moves (de)serialization',
                                ['moves', moves],
                                ['moves2', moves2]
                            ]) + "\n");
                    return false
                }
                return true
            }}, {
            name: 'Times serialization',
            count: defaultCount,
            groupSize: defaultGroupSize,
            prologText: '10,000 times (de)serialization checks running...\n',
            epilogText: 'Test finished OK.\n',
            blocking: true,
            exec: function () {
                var randomDelta, n, i, deltas, times, times2, deltas2, result;

                randomDelta = function () {
                    return 20 + Math.floor(5000 * Math.random())
                };

                n = 30 + Math.floor(30 * Math.random());

                deltas = [];
                for (i = 0; i < n; i++) {
                    deltas.push(randomDelta())
                }

                times = [0];
                for (i = 0; i < n; i++) {
                    times.push(times[i] + deltas[i])
                }

                times2 = Serializer.deserializeTimes(3, Serializer.serializeTimes(3, times));

                deltas2=[];
                for (i = 1; i < times2.length; i++) {
                    deltas2.push(times2[i] - times2[i - 1])
                }

                result = true;
                for (i = 0; i < n - 2; i++) {
                    if (isNaN(deltas2[i]) || isNaN(deltas2[i + 1]) ||
                        (deltas[i + 1] < deltas[i] && deltas2[i + 1] > deltas2[i]) ||
                        (deltas[i + 1] > deltas[i] && deltas2[i + 1] < deltas2[i])) {
                        result = false;
                        break;
                    }
                }

                if (!result) {
                    log(JSON.stringify(
                            ['Test failed: Times (de)serialization',
                                ['deltas', deltas],
                                ['deltas2', deltas2],
                                ['i', i],
                                ['deltas[i]', deltas[i]],
                                ['deltas[i + 1]', deltas[i + 1]]
                            ]) + "\n");
                    return result
                }
                return result
            }}
        ],

        stopTest = function () {
            testOver = true;
            testsStopped = true;
            $("#testsStop1").text("Close").unbind("click").click(closeTestDialog);
        },

        showTestDialog = function () {
            $("#modalOverlay").show();
            $("#progressReport").text("");
            $("#testsStop1").text("Stop").unbind("click").click(stopTest);
            $("#testsDialog").show();
        },

        closeTestDialog = function () {
            $("#testsDialog").hide();
            $("#modalOverlay").hide();
        },

        log = function (text) {
            report.text(report.text() + text)
        },

        setProgress = function (p) {
            $("#pc1").text(p);
            $("#ps1").width(p);
        },

        // method implements rather ugly logic due to its async nature
        // it is executed via consecutive self-registered timer callbacks
        // while the execution state is controlled via global variables
        execute = function () {
            var test, testResult, iter1;

            for (; testIndex < tests.length; testIndex++) {
                test = tests[testIndex];

                // Update and refresh GUI with new test info
                if (testIndex != testInitialized) {
                    log("(" + (testIndex + 1) + "/" + (tests.length) + ") " + test.name + "\n");
                    log("      " + test.prologText);
                    setProgress("0%");
                    testInitialized = testIndex;
                    window.setTimeout(execute, 0);
                    return;
                }

                for (; testIter < test.count; testIter++) {
                    testResult = test.exec();

                    // If test failed and is of blocking type, go to another test
                    if (!testResult && test.blocking) {
                        testIter = 0;
                        testIndex++;
                        window.setTimeout(execute, 0);
                        return
                    }

                    // Every groupSize iterations, take a break
                    iter1 = testIter + 1;
                    if (iter1 % test.groupSize == 0) {
                        setProgress(Math.floor(100 * iter1 / test.count) + "%");

                        if (testsStopped) {
                            log("Testing stopped.");
                            return
                        }

                        if (iter1 < test.count) {
                            // Set a timer for the next iteration
                            window.setTimeout(execute, 0);
                            // Manually increment because we exit the loop
                            testIter++;
                            return
                        }
                    }
                }

                if (!testOver && testIter == test.count) {
                    setProgress(Math.floor(100 * iter1 / test.count) + "%");
                    log("      " + test.epilogText);
                }
                testIter = 0;

                if (testIndex + 1 == tests.length) {
                    stopTest();
                    log("All tests finished OK.\n");
                }
            }
        },

        run = function () {
            showTestDialog();
            execute();
        };

    // Tests API
    return {
        run: run
    }
});
