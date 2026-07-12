/**
 * Pure state transitions for the worker's heuristic-search scheduler.
 * Kept separate so settlement semantics can be regression-tested without a
 * browser or a live WebAssembly worker.
 *
 * Copyright 2014-2026, Hrvoje Abraham ahrvoje@gmail.com
 * Released under the MIT license.
 */

export function createSearchProgress(signature, bestScore) {
    return {
        lastSignature: signature,
        maxGlobalFruitless: 0,
        bestScore,
        bestFruitless: 0,
    };
}

// A pass has two independent notions of progress:
// - only an improved position score resets widening;
// - any row change resets settlement, which counts only actual max globals.
export function recordSearchPass(progress, signature, bestScore, globalWidth, maxWidth) {
    const next = { ...progress };
    if (signature !== progress.lastSignature) {
        next.lastSignature = signature;
        next.maxGlobalFruitless = 0;
    } else if (globalWidth === maxWidth) {
        next.maxGlobalFruitless++;
    }

    if (bestScore < progress.bestScore) {
        next.bestScore = bestScore;
        next.bestFruitless = 0;
    } else {
        next.bestFruitless++;
    }
    return next;
}

export function settlementReady(progress, requiredPasses, remaining, exactGate, uncoveredPrivate) {
    return progress.maxGlobalFruitless >= requiredPasses &&
        uncoveredPrivate === 0 && remaining > exactGate;
}
