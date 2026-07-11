/**
 * Click2014
 *
 * Copyright 2014, Hrvoje Abraham ahrvoje@gmail.com
 * Released under the MIT license.
 * http://www.opensource.org/licenses/mit-license.php
 *
 * Date: Sat Sep 06, 2014
 *       Sat Oct 02, 2021
 */
/* jshint strict:false */
/* jslint nomen: true */
/* global $:false */
/* global getQueryParams:false */

// Game object
var Game = function (gameString) {
    // private variables
    var Status = {Initial: 0, Ready: 1, Play: 2, Over: 3, AutoPlay: 4},
        status = Status.Initial,
        startPosition = [],
        currentPosition = [],
        moves = [],
        times = [],
        mask = [],
        currentMove = null,
        startTime = null,
        error = null;

    // private methods
    var generateMask = function () {
            var i, j, column;

            mask = [];
            for (i = 0; i < 12; i++) {
                column = [];
                for (j = 0; j < 12; j++) {
                    column.push(0)
                }
                mask.push(column)
            }
        },

        clearMask = function () {
            var i, j;

            for (i = 0; i < 12; i++) {
                for (j = 0; j < 12; j++) {
                    mask[i][j] = 0
                }
            }
        },

        generateNewPosition = function () {
            var i, j, column;

            startPosition = [];
            for (i = 0; i < 12; i++) {
                column = [];
                for (j = 0; j < 12; j++) {
                    column.push(Math.floor(Math.random() * 5) + 1)
                }

                startPosition.push(column)
            }
        },

        startGame = function () {
            currentPosition = $.extend(true, [], startPosition);
            startTime = new Date().getTime();
            status = Status.Play;
        },

        replay = function () {
            currentPosition = [];
            moves = [];
            times = [];
            currentMove = 0;
            status = Status.Ready;
        },

        extractGroup = function (field, context) {
            var x = field[0], y = field[1];

            if (context === undefined) {
                // static variable equivalents
                extractGroup.refColor = currentPosition[x][y];
                extractGroup.group = [];
                clearMask(); // already should be clean, but just in case

                // if field is empty
                if (extractGroup.refColor === 0) {
                    return extractGroup.group
                }
            }

            extractGroup.group.push([x, y]);
            mask[x][y] = 1;

            if (x > 0) {
                if (currentPosition[x - 1][y] === extractGroup.refColor && mask[x - 1][y] === 0) {
                    extractGroup([x - 1, y], true)
                }
            }

            if (x < 11) {
                if (currentPosition[x + 1][y] === extractGroup.refColor && mask[x + 1][y] === 0) {
                    extractGroup([x + 1, y], true)
                }
            }

            if (y > 0) {
                if (currentPosition[x][y - 1] === extractGroup.refColor && mask[x][y - 1] === 0) {
                    extractGroup([x, y - 1], true)
                }
            }

            if (y < 11) {
                if (currentPosition[x][y + 1] === extractGroup.refColor && mask[x][y + 1] === 0) {
                    extractGroup([x, y + 1], true)
                }
            }

            if (context === undefined) {
                clearMask();
                return extractGroup.group;
            }
        },

        getNextMoveGroup = function () {
            if (currentMove < moves.length) {
                return extractGroup(moves[currentMove])
            }

            return []
        },

        markGroup = function (group, mark) {
            var k, field;

            for (k = 0; k < group.length; k++) {
                field = group[k];
                currentPosition[field[0]][field[1]] = mark;
            }
        },

        collapseDown = function () {
            var i, j, row, fieldState;

            for (i = 0; i < 12; i++) {
                row = 0;
                for (j = 0; j < 12; j++) {
                    fieldState = currentPosition[i][j];

                    if (fieldState > 0 && fieldState < 6) {
                        currentPosition[i][j] = 0;
                        currentPosition[i][row] = fieldState;
                        row++;
                    } else {
                        currentPosition[i][j] = 0
                    }
                }
            }
        },

        collapseLeft = function () {
            var i, col, j, fieldState;

            // scan all columns excepts the last
            for (i = 0; i < 11; i++) {
                if (currentPosition[i][0] === 0) {
                    // find first non-empty column
                    for (col = i + 1; col < 12; col++) {
                        if (currentPosition[col][0] > 0) {
                            break
                        }
                    }

                    // if it is not the last column
                    // copy it to the empty column and make it empty
                    if (col < 12) {
                        for (j = 0; j < 12; j++) {
                            fieldState = currentPosition[col][j];

                            if (fieldState === 0) {
                                break
                            }

                            currentPosition[i][j] = fieldState;
                            currentPosition[col][j] = 0;
                        }
                    } else {
                        break
                    }
                }
            }
        },

        collapseGroup = function () {
            collapseDown();
            collapseLeft();
        },

        addMove = function (move) {
            if (move[0] >= 0 && move[0] < 12 && move[1] >= 0 && move[1] < 12) {
                moves.push(move)
            } else {
                error = -1;
                return error;
            }
        },

        addTime = function (time) {
            if (typeof time === "number" && time >= 0) {
                times.push(time)
            } else {
                error = -1;
                return error
            }
        },

        getCurrentMoveTime = function () {
            if (currentMove <= times.length) {
                return times[currentMove - 1]
            }
        },

        isOver = function () {
            var i, j, fieldState;

            // try to find at least two connected fields of the same color
            for (i = 0; i < 12; i++) {
                // stop scanning if you came to empty part
                if (currentPosition[i][0] === 0) {
                    return true
                }

                for (j = 0; j < 12; j++) {
                    fieldState = currentPosition[i][j];

                    if (fieldState > 0) {
                        if (i < 11) {
                            if (currentPosition[i + 1][j] === fieldState) {
                                return false
                            }
                        }

                        if (j < 11) {
                            if (currentPosition[i][j + 1] === fieldState) {
                                return false
                            }
                        }
                    } else {
                        break
                    }
                }
            }

            return true
        },

        playMove = function (field) {
            var group = extractGroup(field);

            if (group.length < 2) {
                return false
            }

            // if clicked group is larger than a single field
            markGroup(group, 6);
            collapseGroup();
            currentMove++;

            if (status === Status.Play) {
                // moves are base 12 coded, as maximal value of coordinates is 11 (0 - 11)
                // this is no pain and makes game link a lot shorter!
                addMove(field);

                if (currentMove !== 1) {
                    addTime(new Date().getTime() - startTime)
                } else {
                    addTime(0)
                }

                if (isOver()) {
                    status = Status.Over
                }
            }

            return true
        },

        playNextMove = function () {
            if (currentMove < moves.length) {
                playMove(moves[currentMove])
            }
        },

        rewindToMove = function (moveIndex) {
            var i;

            if (moveIndex < 0 || moveIndex > moves.length) {
                return false
            }

            currentPosition = $.extend(true, [], startPosition);
            currentMove = 0;

            for (i = 0; i < moveIndex; i++) {
                playMove(moves[i])
            }

            return true
        },

        getScore = function () {
            var i, j, position, score = 0;

            if (status === Status.Initial) {
                return 0
            }

            if (status === Status.Ready) {
                position = startPosition
            } else {
                position = currentPosition
            }

            if (position === undefined || position[0] === undefined) {
                return 0
            }

            for (i = 0; i < 12; i++) {
                // stop counting if you came to empty column
                if (position[i][0] === 0) {
                    break
                }

                for (j = 0; j < 12; j++) {
                    if (position[i][j] > 0) {
                        score++
                    } else {
                        // stop counting if you came to empty row
                        break
                    }
                }
            }

            return score
        },

        getString = function () {
            return Serializer.serializeGame(3, startPosition, moves, times)
        },

        // replays the game and checks every move actually can be played
        checkGameData = function () {
            var i, result = true;

            currentPosition = $.extend(true, [], startPosition);

            for (i = 0; i < moves.length; i++) {
                if (!playMove(moves[i])) {
                    result = false;
                    break;
                }
            }

            currentPosition = [];
            return result
        };

    //************************************
    // execute remaining constructor steps
    generateMask();

    if (gameString === undefined) {
        generateNewPosition();
        status = Status.Ready
    } else {
        var gameData = Serializer.deserializeGame(gameString);

        startPosition = $.extend(true, [], gameData.p);
        moves = $.extend(true, [], gameData.m);
        times = $.extend(true, [], gameData.t);

        if (checkGameData()) {
            currentPosition = $.extend(true, [], gameData.p);
            status = Status.Over
        } else {
            moves = [];
            times = [];
            status = Status.Ready
        }
    }

    currentMove = 0;
    startTime = 0;
    error = 0;
    //************************************

    // Game API methods and const. variables
    return {
        Status: Status,
        getStatus: function () {return status},
        setStatus: function (_status){status = _status},
        getMoves: function () {return moves},
        getTimes: function () {return times},
        getStartPosition: function () {return startPosition},
        getCurrentPosition: function () {return currentPosition},
        getCurrentMove: function () {return currentMove},
        getStartTime: function () {return startTime},
        getError: function () {return error},
        startGame: startGame,
        getNextMoveGroup: getNextMoveGroup,
        getCurrentMoveTime: getCurrentMoveTime,
        getScore: getScore,
        getString: getString,
        playMove: playMove,
        playNextMove: playNextMove,
        replay: replay,
        rewindToMove: rewindToMove
    };
};
