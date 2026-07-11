/**
 * Click2014
 *
 * Copyright 2014, Hrvoje Abraham ahrvoje@gmail.com
 * Released under the MIT license.
 * http://www.opensource.org/licenses/mit-license.php
 *
 * Date: Fri Aug 08, 2014
 */
/* jshint strict: false */
/* global $: false */
/* global extractWheelDelta: false */

var Click = (function () {
    // private variables
    var examples = [
            "?position=544341454153245551352111315534254113553554342242333515335513533415541542111541422113121311534345113215252332331311244443442542241513343551454125&moves=65,54,21,43,31,42,30,29,17,15,13,13,37,24,25,24,14,13,14,26,26,38,38,54,66,78,89,88,88,77,87,87,73,84,60,37,36,12,1,0,12&times=533,929,374,344,492,642,406,218,320,236,178,414,344,266,344,352,484,586,188,264,258,430,1242,336,679,611,217,455,358,321,171,524,273,235,905,180,406,414,156,320",
            "?position=544341454153245551352111315534254113553554342242333515335513533415541542111541422113121311534345113215252332331311244443442542241513343551454125&moves=22,45,44,31,42,30,30,29,17,5,4,13,13,25,24,24,39,50,39,38,51,36,49,49,48,60,48,24,37,38,51,61,52,61,61,49,49,24,36,26,14,25,0,0&times=169,172,360,149,156,180,180,171,180,188,509,250,468,287,197,836,298,406,186,422,282,304,156,281,251,290,203,984,187,1250,446,1062,774,374,148,492,766,142,452,282,313,280,149",
            "?position=325543113314113135211541443415522322133121452555454312541423142452333321342251314552432544244431224151231425333345115312311242234331554443232431&moves=34,19,29,20,6,17,14,17,27,26,13,61,62,61,61,62,61,60,52,84,84,60,63,60,60,49,49,49,36,12,12,12,13,25,12,41,51,39,52,52,51,51,39,49,36,24,25,24&times=529,648,453,202,172,462,562,373,697,366,1196,437,399,303,401,663,180,1186,1188,446,1203,414,524,290,492,616,704,242,446,156,296,367,407,467,1361,344,983,399,180,352,421,600,298,188,594,367,171"
        ],
        colors = {backgroundColor: "#000000", playColors: ["#FF0000", "#00BF00", "#0000FF", "#EFEF00", "#00DFFF"], highlightColor: "#FFCC66"},
        game = null,
        drawingCanvas = null,
        drawingContext = null,
        updateTimerInterval = null,
        autoPlayTimerInterval = null,
        autoPlayGameStartTime = null,
        autoPlaySystemStartTime = null,
        lastClickTime = null;

    // private methods
    var getMousePos = function (event) {
            var rect = $('#gameCanvas')[0].getBoundingClientRect();
            return {
                x: Math.floor((event.clientX - rect.left - 5) / 25),
                y: 11 - Math.floor((event.clientY - rect.top - 5) / 25)
            };
        },

        drawBackground = function () {
            drawingContext.rect(0, 0, 310, 310);
            drawingContext.fillStyle = colors.backgroundColor;
            drawingContext.fill()
        },

        drawField = function (i, j, color) {
            drawingContext.beginPath();
            drawingContext.rect(25 * i + 6, 300 - 25 * (j + 1) + 6, 23, 23);
            drawingContext.stroke();

            drawingContext.fillStyle = color;
            drawingContext.fill();
        },

        highlightGroup = function (group) {
            var i, playColorIndex, position = game.getCurrentPosition();

            drawingContext.strokeStyle = colors.highlightColor;
            drawingContext.lineWidth = 4;

            for (i = 0; i < group.length; i++) {
                playColorIndex = position[group[i][0]][group[i][1]] - 1;
                drawField(group[i][0], group[i][1], colors.playColors[playColorIndex]);
            }
        },

        drawAllFields = function () {
            var i, j, color, position;

            drawBackground();

            drawingContext.lineWidth = 4;
            drawingContext.strokeStyle = colors.backgroundColor;

            if (game.getStatus() === game.Status.Ready) {
                position = game.getStartPosition()
            } else if (game.getStatus() === game.Status.Play || game.getStatus() === game.Status.Over || game.getStatus() === game.Status.AutoPlay) {
                position = game.getCurrentPosition()
            } else {
                return
            }

            if (position === undefined || position[0] === undefined) {
                return
            }

            for (i = 0; i < 12; i++) {
                // stop drawing if you came to empty part
                if (position[i][0] === 0) {
                    break
                }

                for (j = 0; j < 12; j++) {
                    color = position[i][j];

                    // stop drawing this column if you came to empty column part
                    if (color === 0) {
                        break
                    }

                    drawField(i, j, colors.playColors[color - 1]);
                }
            }

            if (game.getStatus() === game.Status.Over || game.getStatus() === game.Status.AutoPlay) {
                var nextMoveGroup = game.getNextMoveGroup();
                highlightGroup(nextMoveGroup);
            }
        },

        updateTimer = function () {
            var currentTime;

            if (game.getStatus() !== game.Status.AutoPlay) {
                currentTime = (new Date().getTime() - game.getStartTime()) / 1000.0
            } else {
                currentTime = (new Date().getTime() - autoPlaySystemStartTime + autoPlayGameStartTime) / 1000.0
            }

            $('#timeValue')[0].textContent = String(currentTime);
            return currentTime;
        },

        updateTimeText = function () {
            var timeText, currentMoveTime;

            if (game.getCurrentMove() === 0) {
                timeText = "0";
            } else {
                currentMoveTime = game.getCurrentMoveTime();

                if (currentMoveTime === undefined || currentMoveTime === 0) {
                    timeText = "0";
                } else {
                    timeText = String(currentMoveTime / 1000.0);
                }
            }

            $('#timeValue')[0].textContent = timeText;
        },

        updateScore = function () {
            var currentScore = game.getScore();
            $('#scoreValue')[0].textContent = currentScore;
            return currentScore;
        },

        updateMove = function () {
            $('#moveValue')[0].textContent = game.getCurrentMove() + " / " + game.getMoves().length
        },

        refreshInterface = function () {
            drawAllFields();
            updateTimeText();
            updateScore();
            updateMove();
        },

        showButtons = function () {
            $("#control-overlay").css("display", "none");
            $("#control").css("-webkit-filter", "none")
        },

        hideButtons = function () {
            $("#control-overlay").css("display", "initial");
            $("#control").css("-webkit-filter", "opacity(0.2)")
        },

        prepareInterface = function () {
            clearInterval(updateTimerInterval);
            clearInterval(autoPlayTimerInterval);
            showButtons();
            drawAllFields();
            $("#timeValue").text("0");
            $("#scoreValue").text(game.getScore());
            $("#moveValue").text("0 / " + game.getMoves().length);
            $(".visible").filter(".on").show();
        },

        gameFromString = function (gameString) {
            game = new Game(gameString);
            prepareInterface();
        },

        processClick = function (event) {
            var mousePos = getMousePos(event);

            if (game.playMove([mousePos.x, mousePos.y])) {
                drawAllFields();
                updateScore();
                updateMove();
            }

            if (game.getStatus() === game.Status.Over) {
                clearInterval(updateTimerInterval);

                // make sure timer shows exact time of the last move played
                updateTimeText();
                showButtons();
            }
        },

        processMouseWheel = function (delta) {
            // mouse wheel rewinding enabled only for finished games
            if (game.getStatus() !== game.Status.Over) {
                return
            }

            if (delta === undefined) {
                return
            }

            if (delta < 0) {
                game.rewindToMove(game.getCurrentMove() + 1)
            } else {
                game.rewindToMove(game.getCurrentMove() - 1)
            }

            drawAllFields();
            updateScore();
            updateMove();
            updateTimeText();
        },

        autoPlayMove = function () {
            var autoPlayTime = new Date().getTime() - autoPlaySystemStartTime + autoPlayGameStartTime;
            updateTimer();

            if (autoPlayTime >= game.getTimes()[game.getCurrentMove()]) {
                game.playNextMove();
                drawAllFields();
                updateMove();
                updateScore();
            }

            if (game.getCurrentMove() === game.getMoves().length) {
                $("#autoPauseButton").hide();
                $("#autoPlayButton").show();
                clearInterval(autoPlayTimerInterval);
                updateTimeText();
                game.setStatus(game.Status.Over);
            }
        },

        displayWarning = function (message) {
            $("#gameExamples").remove();
            $("#game").remove();
            $("#footer").remove();
            $("#mainRight")
                .html(message)
                .css({
                    "min-width": "900px",
                    "max-height": "35px",
                    "margin": "200px 500px 0 50px",
                    "z-index": 5555,
                    "background-color": "AntiqueWhite",
                    "border-radius": "5px",
                    "text-align": "center"
                });

            // create gray overlay over the entire page
            $("body").append("<div id='overlay'></div>");

            $("#overlay")
                .height($(document).height())
                .css({
                    "opacity" : 0.3,
                    "position": "absolute",
                    "top": 0,
                    "left": 0,
                    "background-color": "black",
                    "width": "100%",
                    "z-index": 5000
                });
        },

        checkBrowser = function () {
            // Opera 8.0+ (UA detection to detect Blink/v8-powered Opera)
            var isOpera = !!window.opera || navigator.userAgent.indexOf(' OPR/') >= 0;
            var isFirefox = typeof InstallTrigger !== 'undefined';   // Firefox 1.0+
            var isChrome = !!window.chrome && !isOpera;              // Chrome 1+

            //var isIE = /*@cc_on!@*/false || !!document.documentMode; // At least IE6
            // At least Safari 3+: "[object HTMLElementConstructor]"
            //var isSafari = Object.prototype.toString.call(window.HTMLElement).indexOf('Constructor') > 0;

            var warningDiv = $("#Warning");
            $(warningDiv).css("display", "none");

            if (isChrome) {
                var chromeVersion = parseInt(navigator.userAgent.match(/Chrome\/(\d+)\./)[1], 10);

                if (chromeVersion < 33) {
                    displayWarning("Please use Chrome 33 or newer!");
                    return false;
                }

                $("#gameCanvas").on("mousewheel", function (event) {
                    processMouseWheel(extractWheelDelta(event))
                });

                return true;
            }

            if (isFirefox) {
                var firefoxVersion = parseInt(navigator.userAgent.match(/Firefox\/(\d+)\./)[1], 10);

                if (firefoxVersion < 30) {
                    displayWarning("Please use Firefox 30 or newer!");
                    return false;
                }

                $("#gameCanvas").on("DOMMouseScroll", function (event) {
                    processMouseWheel(extractWheelDelta(event))
                });

                return true;
            }

            if (isOpera) {
                var operaVersion = parseInt(navigator.userAgent.match(/OPR\/(\d+)\./)[1], 10);

                if (operaVersion < 25) {
                    displayWarning("Please use Opera 25 or newer!");
                    return false;
                }

                $("#gameCanvas").on("mousewheel", function (event) {
                    processMouseWheel(extractWheelDelta(event))
                });

                return true;
            }

            displayWarning("Please use Chrome, Firefox or Opera browser!");
            return false;
        },

        promptGameLink = function () {
            window.prompt("Copy link to clipboard (Ctrl+C)",
                String(document.location).split("?", 1)[0] + "?" + game.getString());
        },

        onCanvasClick = function (event) {
            var firstClick = false;

            if (game.getStatus() === game.Status.Ready) {
                hideButtons();
                game.startGame();
                lastClickTime = game.getStartTime();

                updateTimerInterval = setInterval(updateTimer, 17);
                updateScore();

                firstClick = true;
            }

            if (game.getStatus() === game.Status.Play) {
                var currentTime = new Date().getTime();

                // minimal double click time 5ms
                if (firstClick || currentTime - lastClickTime > 5) {
                    processClick(event);
                }

                lastClickTime = currentTime;
            }
        },

        startNewGame = function () {
            game = new Game();
            prepareInterface();
        },

        replayStartPosition = function () {
            game.replay();
            prepareInterface();
        },

        stopAutoPlay = function () {
            $("#autoPauseButton").hide();
            $("#autoPlayButton").show();
            clearInterval(autoPlayTimerInterval);
            updateTimeText();
            game.setStatus(game.Status.Over);
        },

        autoPlay = function () {
            // if game is Over and it can be autoPlayed
            if (game.getStatus() === game.Status.Over) {
                // exit if game is already at the end
                if (game.getCurrentMove() === game.getMoves().length) {
                    return
                }

                if (game.getCurrentMove() > 0) {
                    autoPlayGameStartTime = game.getTimes()[game.getCurrentMove() - 1]
                } else {
                    autoPlayGameStartTime = 0
                }

                $("#autoPlayButton").hide();
                $("#autoPauseButton").show();
                autoPlayTimerInterval = setInterval(autoPlayMove, 10);
                autoPlaySystemStartTime = new Date().getTime();
                game.setStatus(game.Status.AutoPlay);
            } else if (game.getStatus() === game.Status.AutoPlay) {
                // if game is autoPlaying and should be paused
                stopAutoPlay()
            }
        },

        rewindBackward = function () {
            game.rewindToMove(0);
            stopAutoPlay();
            refreshInterface();
        },

        rewindForward = function () {
            game.rewindToMove(game.getMoves().length);
            stopAutoPlay();
            refreshInterface();
        },

        importGame = function (importedString) {
            if (importedString !== "" && importedString !== null) {
                gameFromString(importedString)
            }
        },

        loadExample = function (exampleIndex) {
            if (exampleIndex >= 0 && exampleIndex < examples.length) {
                gameFromString(examples[exampleIndex])
            }
        },

        init = function () {
            if (!checkBrowser()) {
                return
            }

            drawingCanvas = $("#gameCanvas")[0];
            drawingContext = drawingCanvas.getContext("2d");

            gameFromString(document.location.search);
        };

    // Click API
    return {
        promptGameLink: promptGameLink,
        onCanvasClick: onCanvasClick,
        startNewGame: startNewGame,
        replayStartPosition: replayStartPosition,
        autoPlay: autoPlay,
        stopAutoPlay: stopAutoPlay,
        rewindBackward: rewindBackward,
        rewindForward: rewindForward,
        importGame: importGame,
        loadExample: loadExample,
        init: init
    };
} () );
