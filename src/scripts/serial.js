/**
 * Click2014
 *
 * Copyright 2014, Hrvoje Abraham ahrvoje@gmail.com
 * Released under the MIT license.
 * http://www.opensource.org/licenses/mit-license.php
 *
 * Date: Thu Apr 23, 2015
 *       Sat Oct 02, 2021
 */


Serializer1 = (function () {
    var position, moves, times;

    var stringToPosition = function (positionString) {
            var i, x, column;

            position = [];

            if (positionString.length !== 144) {
                return false
            }

            for (i = 0; i < positionString.length; i++) {
                if (i % 12 === 0) {
                    column = []
                }

                x = parseInt(positionString[i], 10);

                if (x > 0 && x < 6) {
                    column.push(parseInt(positionString[i], 10))
                } else {
                    column.push(0)
                }

                if (i % 12 === 11) {
                    position.push(column)
                }
            }

            return true;
        },

        stringToMoves = function (movesString) {
            var i, fieldCodes = movesString.split(','), fieldCode, x, y;

            moves = [];

            for (i = 0; i < fieldCodes.length; i++) {
                fieldCode = parseInt(fieldCodes[i], 10);
                x = Math.floor(fieldCode / 12);
                y = fieldCode % 12;

                if (x < 0 || x > 11) {
                    return false
                }
                moves.push([x, y]);
            }

            return true
        },

        stringToTimes = function (timesString) {
            var i, list = timesString.split(',');

            times = [0];

            for (i = 0; i < list.length; i++) {
                times.push(times[i] + Number(list[i]))
            }

            return true
        },

        deserialize = function (positionString, movesString, timesString) {
            if (isString(positionString)) {
                if (!stringToPosition(positionString)) {
                    return {p:[], m:[], t:[]}
                }
            }

            if (isString(movesString)) {
                if (!stringToMoves(movesString)) {
                    moves = []
                }
            }

            if (isString(timesString)) {
                if (!stringToTimes(timesString)) {
                    times = []
                }
            }

            return {p:position, m:moves, t:times}
        },

        serialize = function (position, moves, times) {
            var i, j, field, string = "position=";

            for (i = 0; i < 12; i++) {
                for (j = 0; j < 12; j++) {
                    string += String(position[i][j])
                }
            }

            if (moves.length > 0) {
                string += "&moves=";

                for (i = 0; i < moves.length; i++) {
                    field = moves[i];
                    string += String(12 * field[0] + field[1]);

                    if (i < moves.length - 1) {
                        string += ","
                    }
                }
            }

            if (times.length > 0) {
                string += "&times=";

                // times are string coded by moves time differences
                for (i = 1; i < times.length; i++) {
                    string += String(times[i] - times[i - 1]);

                    if (i < times.length - 1) {
                        string += ","
                    }
                }
            }

            return string
        };

    // Serializer1 API
    return {
        serialize: serialize,
        deserialize: deserialize
    }
} () );


Serializer2 = (function () {
    var position, moves, times;

    var dx_encode = {
              "0":"11",
             "-1":"10",
              "1":"00",
             "-2":"0111",
              "2":"0110",
              "3":"01011",
             "-3":"01001",
             "-4":"010100",
              "4":"0100001",
             "-5":"0100010",
              "5":"01010111",
             "-6":"01000000",
              "6":"01000001",
             "-7":"010001111",
              "7":"010001100",
             "-8":"010101100",
              "8":"010001101",
             "-9":"010101010",
              "9":"010001110",
            "-10":"010101011",
             "10":"010101001",
            "-11":"010101000",
             "11":"010101101"
            },

        dx_decode = swap_key_value(dx_encode),

        dy_encode = {
              "0":"11",
             "-1":"10",
              "1":"011",
             "-2":"001",
              "2":"000",
             "-3":"01011",
              "3":"01001",
             "-4":"010101",
              "4":"010000",
             "-5":"0101000",
              "5":"010100100",
             "-6":"010100101",
              "6":"010100110",
             "-7":"010001000",
              "7":"010001101",
             "-8":"010001100",
              "8":"010001011",
             "-9":"010001010",
              "9":"010001001",
            "-10":"010001111",
             "10":"010001110",
            "-11":"0101001110",
             "11":"0101001111"
        },

        dy_decode = swap_key_value(dy_encode),

        first_digit_encode = {
            "3":"1",
            "2":"01",
            "4":"001",
            "1":"0001",
            "0":"00001",
            "5":"000001",
            "6":"0000001",
            "7":"00000001",
            "8":"000000001",
            "9":"0000000001",
            "x":"00000000001"
        },

        first_digit_decode = swap_key_value(first_digit_encode),

        second_digit_encode = {
            "0":"000",
            "1":"001",
            "2":"010",
            "3":"011",
            "4":"100",
            "5":"1010",
            "6":"1011",
            "7":"1100",
            "8":"1101",
            "9":"1110",
            "x":"1111"
        },

        second_digit_decode = swap_key_value(second_digit_encode),

        serializePosition = function (position) {
            var i, j, p0;

            p0 = "";
            for (i = 0; i < 12 && position[i][0] !== 0; i++) {
                for (j = 0; j < 12; j++) {
                    p0 += String(position[i][j]);

                    if (position[i][j] === 0) {
                        break
                    }
                }
            }

            return topZeros(longX_to_longY(tailZeros(p0), 6, 19, 71, 8))
        },

        _deserializePosition = function (positionString) {
            var i, column, row, x;
            var base6 = topZeros(longX_to_longY(positionString, 71, 8, 6, 19));

            position = [];
            for (i = 0; i < 12; i++) {
                position.push([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0])
            }

            column = 0; row = 0;
            for (i = 0; i < base6.length && column < 12; i++) {
                x = Number(base6[i]);

                // column starts with 0 = end of position
                if (row == 0 && x == 0) {
                    break
                }

                position[column][row++] = x;

                if (x == 0 || row == 12) {
                    column++;
                    row = 0
                }
            }

            return true
        },

        deserializePosition = function (positionString) {
            if (_deserializePosition(positionString)) {
                return position
            }
            return []
        },

        movesComponentToString = function (moves, component, huffman_table) {
            var i, deltas=[], huffman, leadingZeros, base71;

            for (i = 1; i < moves.length; i++) {
                deltas.push(moves[i][component] - moves[i-1][component])
            }

            huffman = huffman_encode(deltas, huffman_table);
            leadingZeros = huffman.indexOf('1');
            base71 = longX_to_longY(huffman, 2, 43, 71, 7);

            return baseX_to_baseY(String(moves[0][component]), 10, 71) + baseX_to_baseY(String(leadingZeros), 10, 71) + topZeros(base71)
        },

        componentStringToMoves = function (movesStringComponent, huffman_table) {
            var firstMove = Number(baseX_to_baseY(movesStringComponent[0], 71, 10));
            var leadingZeros = Number(baseX_to_baseY(movesStringComponent[1], 71, 10));
            var huffman = padZeros(topZeros(longX_to_longY(movesStringComponent.substring(2), 71, 7, 2, 43)), leadingZeros);
            var deltas = huffman_decode(huffman, huffman_table);
            var movesComponent = [firstMove];

            for (var i = 0; i < deltas.length; i++) {
                movesComponent.push(movesComponent[movesComponent.length - 1] + Number(deltas[i]))
            }

            return movesComponent
        },

        serializeMoves = function (moves) {
            var stringX = movesComponentToString(moves, 0, dx_encode);
            var stringY = movesComponentToString(moves, 1, dy_encode);

            return stringX + "," + stringY
        },

        _deserializeMoves = function (movesString) {
            if (movesString === undefined) {
                return false
            }

            var movesStrings = movesString.split(",");
            var movesX = componentStringToMoves(movesStrings[0], dx_decode);
            var movesY = componentStringToMoves(movesStrings[1], dy_decode);

            moves = [];
            for (var i = 0; i < movesX.length; i++) {
                moves.push([movesX[i], movesY[i]])
            }

            return true
        },

        deserializeMoves = function (movesString) {
            if (_deserializeMoves(movesString)) {
                return moves
            }
            return []
        },

        serializeTimes = function (times) {
            var deltas=[];
            for (i = 1; i < times.length; i++) {
                deltas.push(times[i] - times[i-1])
            }

            var logs = fmap(deltas, function (x) {return Math.round(25 * Math.sqrt(Math.max(0, Math.log(0.01 * x))))});

            var coded = "", first_digit, second_digit;
            for (var i = 0; i < logs.length; i++) {
                second_digit = logs[i] % 10;
                first_digit = (logs[i] - second_digit) / 10;
                coded += first_digit_encode[first_digit];
                coded += second_digit_encode[second_digit];
            }

            return topZeros(baseX_to_baseY(String(times[times.length - 1]), 10, 71)) + "," +
                topZeros(baseX_to_baseY(String(coded.indexOf('1')), 10, 71)) +
                topZeros(longX_to_longY(coded, 2, 43, 71, 7))
        },

        _deserializeTimes = function (timesString) {
            if (timesString === undefined) {
                return false
            }

            var splits = timesString.split(",");
            var time_base71 = splits[0], coded = splits[1];
            var total_time = Number(baseX_to_baseY(time_base71, 71, 10));
            var leadingZeros = Number(baseX_to_baseY(coded[0], 71, 10));

            coded = padZeros(topZeros(longX_to_longY(coded.substring(1), 71, 7, 2, 43)), leadingZeros);

            var i, j, first_digit, second_digit, logs = [];
            for (i = 0; i < coded.length;) {
                for (j = 1; j < 12; j++) {
                    first_digit = first_digit_decode[coded.substring(i, i + j)];
                    if (first_digit !== undefined) {break}
                }
                i += j;

                for (j = 3; j < 5; j++) {
                    second_digit = second_digit_decode[coded.substring(i, i + j)];
                    if (second_digit !== undefined) {break}
                }
                i += j;

                logs.push(Number(first_digit + second_digit));
            }

            var deltas = fmap(logs, function (x) {return Math.round(100 * Math.exp(sqr(0.04 * x)))});

            // triple total time difference compensation
            // time encoding is lossy, but total time has to be correct
            var decoded_total_time;
            for (var compensation = 0; compensation < 3; compensation++) {
                decoded_total_time = sum(deltas);
                deltas = fmap(deltas, function (x) {
                    return Math.round(x * total_time / decoded_total_time)
                });
            }

            times = [0];
            for (i = 0; i < deltas.length; i++) {
                times.push(times[i] + deltas[i])
            }
            // final total time correction should be zero or very small (single digit)
            // coded and decoded total time will now be exactly the same
            times[times.length - 1] = total_time;

            return true
        },

        deserializeTimes = function (timesString) {
            if (_deserializeTimes(timesString)) {
                return times
            }
            return []
        },

        deserializeGame = function (positionString, movesString, timesString) {
            if (!_deserializePosition(positionString)) {
                return {p:[], m:[], t:[]}
            }

            if (!_deserializeMoves(movesString)) {
                return {p:position, m:[], t:[]}
            }

            if (!_deserializeTimes(timesString)) {
                return {p:position, m:moves, t:[]}
            }

            return {p:position, m:moves, t:times}
        },

        serializeGame = function (_position, _moves, _times) {
            var string="v=2";

            string += "&p=" + serializePosition(_position);

            if (_moves.length > 0) {
                string += "&m=" + serializeMoves(_moves)
            }

            if (_times.length > 0) {
                string += "&t=" + serializeTimes(_times)
            }

            return string
        };

    // Serializer2 API
    return {
        serializePosition: serializePosition,
        deserializePosition: deserializePosition,
        serializeMoves: serializeMoves,
        deserializeMoves: deserializeMoves,
        serializeTimes: serializeTimes,
        deserializeTimes: deserializeTimes,
        serializeGame: serializeGame,
        deserializeGame: deserializeGame
    }
} () );


Serializer3 = (function () {
    const
        b64="ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_",

        dx_encode = {
              "0":"11",
             "-1":"10",
              "1":"00",
             "-2":"0111",
              "2":"0110",
              "3":"01011",
             "-3":"01001",
             "-4":"010100",
              "4":"0100001",
             "-5":"0100010",
              "5":"01010111",
             "-6":"01000000",
              "6":"01000001",
             "-7":"010001111",
              "7":"010001100",
             "-8":"010101100",
              "8":"010001101",
             "-9":"010101010",
              "9":"010001110",
            "-10":"010101011",
             "10":"010101001",
            "-11":"010101000",
             "11":"010101101"
            },
        dx_decode = swap_key_value(dx_encode),

        dy_encode = {
              "0":"11",
             "-1":"10",
              "1":"011",
             "-2":"001",
              "2":"000",
             "-3":"01011",
              "3":"01001",
             "-4":"010101",
              "4":"010000",
             "-5":"0101000",
              "5":"010100100",
             "-6":"010100101",
              "6":"010100110",
             "-7":"010001000",
              "7":"010001101",
             "-8":"010001100",
              "8":"010001011",
             "-9":"010001010",
              "9":"010001001",
            "-10":"010001111",
             "10":"010001110",
            "-11":"0101001110",
             "11":"0101001111"
        },
        dy_decode = swap_key_value(dy_encode),

        first_digit_encode = {
            "3":"1",
            "2":"01",
            "4":"001",
            "1":"0001",
            "0":"00001",
            "5":"000001",
            "6":"0000001",
            "7":"00000001",
            "8":"000000001",
            "9":"0000000001",
            "x":"00000000001"
        },
        first_digit_decode = swap_key_value(first_digit_encode),

        second_digit_encode = {
            "0":"000",
            "1":"001",
            "2":"010",
            "3":"011",
            "4":"100",
            "5":"1010",
            "6":"1011",
            "7":"1100",
            "8":"1101",
            "9":"1110",
            "x":"1111"
        },
        second_digit_decode = swap_key_value(second_digit_encode),

        serializePosition = position => position
            .flat().map(x => x - 1).join('')
            .match(/.{3}/g).map(x => parseInt(x,5).toString(2).padStart(7, '0')).join('')
            .match(/.{6}/g).map(x => b64[parseInt(x,2)]).join('')
        ,

        deserializePosition = positionString => positionString
            .split('').map(x => b64.indexOf(x).toString(2).padStart(6, '0')).join('')
            .match(/.{7}/g).map(x => parseInt(x, 2).toString(5).padStart(3, '0')).join('')
            .match(/.{12}/g).map(x => x.split('').map(y => parseInt(y,5) + 1))
        ,

        movesComponentToString = function (moves, component, huffman_table) {
            let i, deltas=[], huffman, leadingZeros, base64;

            for (i = 1; i < moves.length; i++) {
                deltas.push(moves[i][component] - moves[i-1][component])
            }

            huffman = huffman_encode(deltas, huffman_table);
            leadingZeros = huffman.indexOf('1');
            base64 = longX_to_longY(huffman, 2, 6, 64, 1);

            return baseX_to_baseY(String(moves[0][component]), 10, 64) + baseX_to_baseY(String(leadingZeros), 10, 64) + topZeros(base64)
        },

        componentStringToMoves = function (movesStringComponent, huffman_table) {
            let firstMove = Number(baseX_to_baseY(movesStringComponent[0], 64, 10));
            let leadingZeros = Number(baseX_to_baseY(movesStringComponent[1], 64, 10));
            let huffman = padZeros(topZeros(longX_to_longY(movesStringComponent.substring(2), 64, 1, 2, 6)), leadingZeros);
            let deltas = huffman_decode(huffman, huffman_table);
            let movesComponent = [firstMove];

            for (let i = 0; i < deltas.length; i++) {
                movesComponent.push(movesComponent[movesComponent.length - 1] + Number(deltas[i]))
            }

            return movesComponent
        },

        serializeMoves = function (moves) {
            if (moves.length == 0) {
                return
            }

            let stringX = movesComponentToString(moves, 0, dx_encode);
            let stringY = movesComponentToString(moves, 1, dy_encode);

            return stringX + "," + stringY
        },

        deserializeMoves = function (movesString) {
            if (movesString === "undefined") {
                return false
            }

            let movesStrings = movesString.split(",");
            let movesX = componentStringToMoves(movesStrings[0], dx_decode);
            let movesY = componentStringToMoves(movesStrings[1], dy_decode);

            let moves = [];
            for (let i = 0; i < movesX.length; i++) {
                moves.push([movesX[i], movesY[i]])
            }

            return moves
        },

        serializeTimes = function (times) {
            if (times.length == 0) {
                return
            }

            let deltas=[];
            for (i = 1; i < times.length; i++) {
                deltas.push(times[i] - times[i-1])
            }

            let logs = fmap(deltas, function (x) {return Math.round(25 * Math.sqrt(Math.max(0, Math.log(0.01 * x))))});

            let coded = "", first_digit, second_digit;
            for (let i = 0; i < logs.length; i++) {
                second_digit = logs[i] % 10;
                first_digit = (logs[i] - second_digit) / 10;
                coded += first_digit_encode[first_digit];
                coded += second_digit_encode[second_digit];
            }

            return topZeros(baseX_to_baseY(String(times[times.length - 1]), 10, 64)) + "," +
                topZeros(baseX_to_baseY(String(coded.indexOf('1')), 10, 64)) +
                topZeros(longX_to_longY(coded, 2, 6, 64, 1))
        },

        deserializeTimes = function (timesString) {
            if (timesString === "undefined") {
                return false
            }

            let splits = timesString.split(",");
            let time_base64 = splits[0], coded = splits[1];
            let total_time = Number(baseX_to_baseY(time_base64, 64, 10));
            let leadingZeros = Number(baseX_to_baseY(coded[0], 64, 10));

            coded = padZeros(topZeros(longX_to_longY(coded.substring(1), 64, 1, 2, 6)), leadingZeros);

            let i, j, first_digit, second_digit, logs = [];
            for (i = 0; i < coded.length;) {
                for (j = 1; j < 12; j++) {
                    first_digit = first_digit_decode[coded.substring(i, i + j)];
                    if (first_digit !== undefined) {break}
                }
                i += j;

                for (j = 3; j < 5; j++) {
                    second_digit = second_digit_decode[coded.substring(i, i + j)];
                    if (second_digit !== undefined) {break}
                }
                i += j;

                logs.push(Number(first_digit + second_digit));
            }

            let deltas = fmap(logs, function (x) {return Math.round(100 * Math.exp(sqr(0.04 * x)))});

            // triple total time difference compensation
            // time encoding is lossy, but total time has to be correct
            let decoded_total_time;
            for (let compensation = 0; compensation < 3; compensation++) {
                decoded_total_time = sum(deltas);
                deltas = fmap(deltas, function (x) {
                    return Math.round(x * total_time / decoded_total_time)
                });
            }

            let times = [0];
            for (i = 0; i < deltas.length; i++) {
                times.push(times[i] + deltas[i])
            }
            // final total time correction should be zero or very small (single digit)
            // coded and decoded total time will now be exactly the same
            times[times.length - 1] = total_time;

            return times
        },

        deserializeGame = (positionString, movesString, timesString) => ({
            p : deserializePosition(positionString),
            m : deserializeMoves(movesString),
            t : deserializeTimes(timesString),
        }),

        serializeGame = (position, moves, times) =>
            ["v=3", "p=" + serializePosition(position), "m=" + serializeMoves(moves), "t=" + serializeTimes(times)].join('&')
    ;

    // Serializer3 API
    return {
        serializePosition: serializePosition,
        deserializePosition: deserializePosition,
        serializeMoves: serializeMoves,
        deserializeMoves: deserializeMoves,
        serializeTimes: serializeTimes,
        deserializeTimes: deserializeTimes,
        serializeGame: serializeGame,
        deserializeGame: deserializeGame
    }
} () );


Serializer = (function () {
    var serializePosition = function (version, position) {
            // determine the serialization version and act accordingly
            if (version === 3) {
                return Serializer3.serializePosition(position)
            } else {
                window.alert("Error: Unknown serialization version")
            }
        },

        deserializePosition = function (version, serial) {
            // determine the serialization version and act accordingly
            if (version === 3) {
                return Serializer3.deserializePosition(serial)
            } else {
                window.alert("Error: Unknown serialization version")
            }
        },

        serializeMoves = function (version, moves) {
            // determine the serialization version and act accordingly
            if (version === 3) {
                return Serializer3.serializeMoves(moves)
            } else {
                window.alert("Error: Unknown serialization version")
            }
        },

        deserializeMoves = function (version, serial) {
            // determine the serialization version and act accordingly
            if (version === 3) {
                return Serializer3.deserializeMoves(serial)
            } else {
                window.alert("Error: Unknown serialization version")
            }
        },

        serializeTimes = function (version, times) {
            // determine the serialization version and act accordingly
            if (version === 3) {
                return Serializer3.serializeTimes(times)
            } else {
                window.alert("Error: Unknown serialization version")
            }
        },

        deserializeTimes = function (version, serial) {
            // determine the serialization version and act accordingly
            if (version === 3) {
                return Serializer3.deserializeTimes(serial)
            } else {
                window.alert("Error: Unknown serialization version")
            }
        },

        serializeGame = function (version, position, moves, times) {
            // determine the serialization version and act accordingly
            if (version === 1) {
                return Serializer1.serialize(position, moves, times)
            } else if (version === 2) {
                return Serializer2.serializeGame(position, moves, times)
            } else if (version === 3) {
                return Serializer3.serializeGame(position, moves, times)
            } else {
                window.alert("Error: Unknown serialization version")
            }
        },

        deserializeGame = function (gameString) {
            var gameParams = getQueryParams(gameString);

            // determine the serialization version and act accordingly
            if (gameParams.v === undefined) {
                return Serializer1.deserialize(gameParams.position, gameParams.moves, gameParams.times)
            } else if (gameParams.v === "2") {
                return Serializer2.deserializeGame(gameParams.p, gameParams.m, gameParams.t)
            } else if (gameParams.v === "3") {
                return Serializer3.deserializeGame(gameParams.p, gameParams.m, gameParams.t)
            } else {
                window.alert("Error: Unknown serialization version")
            }
        };

    // Serializer API
    return {
        serializePosition: serializePosition,
        deserializePosition: deserializePosition,
        serializeMoves: serializeMoves,
        deserializeMoves: deserializeMoves,
        serializeTimes: serializeTimes,
        deserializeTimes: deserializeTimes,
        serializeGame: serializeGame,
        deserializeGame: deserializeGame
    }
} () );
