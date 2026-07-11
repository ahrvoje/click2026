/**
 * Click2014
 *
 * Copyright 2014, Hrvoje Abraham ahrvoje@gmail.com
 * Released under the MIT license.
 * http://www.opensource.org/licenses/mit-license.php
 *
 * Date: Mon Sep 08, 2014
 *       Sat Oct 02, 2021
 */
/* jshint strict:false */

isString = function (s) {return typeof s == 'string' || s instanceof String};
padZeros = function (s, m) {while(m-- > 0){s = "0" + s} return s};
padZerosMod = function (s, m) {while(s.length % m > 0){s = "0" + s} return s};
appendZeros = function (s, m) {while(m-- > 0){s += "0"} return s};
appendZerosMod = function (s, m) {while(s.length % m > 0){s += "0"} return s};
topZeros = function (s) {var c=0; while(c < s.length && s[c++] === "0"){} return s.substring(c-1)};
tailZeros = function (s) {var c=s.length; while(--c >= 0 && s[c] === "0"){} return s.slice(0, c+1)};
swap_key_value = function (d) {var t={}; for(var key in d){t[d[key]]=key} return t};
sign = function (x) {return typeof x === 'number' ? x ? x < 0 ? -1 : 1 : x === x ? 0 : NaN : NaN;};
sqr = function (x) {return x * x};
sum = function (l) {var s=0; for(var i=0; i<l.length; i++){s+=l[i]} return s};
fmap = function (l, f) {var t=[]; for(var i=0; i<l.length; i++){t.push(f(l[i]))} return t};

getQueryParams = function (qs) {
    var result = {};
    var params = (qs.split('?')[1] || '').split('&');
    var param, paramParts;

    for(param in params) {
        if (params.hasOwnProperty(param)) {
            paramParts = params[param].split('=');
            result[paramParts[0]] = decodeURIComponent(paramParts[1] || "")
        }
    }

    return result
};

extractWheelDelta = function (e) {
    if (e.wheelDelta) {
        return e.wheelDelta
    }

    if (e.originalEvent.detail) {
        return e.originalEvent.detail * -40
    }

    if (e.originalEvent && e.originalEvent.wheelDelta) {
        return e.originalEvent.wheelDelta
    }
};

chars_encode = {  "0":"0",  "1":"1",  "2":"2",  "3":"3",  "4":"4",  "5":"5",  "6":"6",  "7":"7",  "8":"8",  "9":"9",
                 "10":"a", "11":"b", "12":"c", "13":"d", "14":"e", "15":"f", "16":"g", "17":"h", "18":"i", "19":"j",
                 "20":"k", "21":"l", "22":"m", "23":"n", "24":"o", "25":"p", "26":"q", "27":"r", "28":"s", "29":"t",
                 "30":"u", "31":"v", "32":"w", "33":"x", "34":"y", "35":"z", "36":"A", "37":"B", "38":"C", "39":"D",
                 "40":"E", "41":"F", "42":"G", "43":"H", "44":"I", "45":"J", "46":"K", "47":"L", "48":"M", "49":"N",
                 "50":"O", "51":"P", "52":"Q", "53":"R", "54":"S", "55":"T", "56":"U", "57":"V", "58":"W", "59":"X",
                 "60":"Y", "61":"Z", "62":"$", "63":"-", "64":"_", "65":".", "66":"+", "67":"!", "68":"*", "69":"(",
                 "70":")"};
chars_decode = swap_key_value(chars_encode);

baseX_to_baseY = function (numberX, baseX, baseY) {
    var i, number10 = 0, numberY = "", mod;

    for (i=0; i<numberX.length; i++) {
        number10 = baseX * number10 + Number(chars_decode[numberX[i]]);
    }

    if (number10 === 0) {
        return "0"
    }

    while (number10 > 0) {
        mod = number10 % baseY;
        numberY = chars_encode[String(mod)] + numberY;
        number10 = (number10 - mod) / baseY
    }

    return numberY
};

longX_to_longY = function (numberX, baseX, sizeX, baseY, sizeY) {
    var i, numberY = "";

    numberX = padZerosMod(numberX, sizeX);
    for (i = 0; i < numberX.length / sizeX; i++) {
        numberY += padZerosMod(baseX_to_baseY(numberX.substring(sizeX*i, sizeX*i + sizeX), baseX, baseY), sizeY)
    }

    return numberY
};

huffman_encode = function (array, encode_table) {
    var i, t="";

    for (i = 0; i < array.length; i++) {
        t += encode_table[array[i]]
    }

    return t
};

huffman_decode = function (huffmanString, decode_table) {
    var i, code="", x, array=[];

    for (i = 0; i < huffmanString.length; i++) {
        code += huffmanString[i];

        x = decode_table[code];
        if (x !== undefined) {
            array.push(Number(x));
            code = ""
        }
    }

    return array
};
