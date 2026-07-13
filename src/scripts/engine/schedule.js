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

// A move's constructive score is an upper bound. Its admissible lower bound
// normally supplies the other side; once that move is exact, its exact score
// is the stronger lower bound even when the static bound itself stayed weak.
// The position value is certified when the minimum effective lower bound
// meets the minimum constructive upper bound. This is deliberately separate
// from having an exact value for every alternative move.
export function summarizePositionProof(moves, lowerOf) {
    if (moves.length === 0) {
        return {
            positionLower: null,
            positionUpper: null,
            positionExact: false,
            allMovesExact: false,
        };
    }

    let positionLower = Infinity;
    let positionUpper = Infinity;
    let allMovesExact = true;
    for (const move of moves) {
        positionUpper = Math.min(positionUpper, move.score);
        positionLower = Math.min(positionLower, move.exact ? move.score : lowerOf(move));
        if (!move.exact) allMovesExact = false;
    }
    return {
        positionLower,
        positionUpper,
        positionExact: positionLower === positionUpper,
        allMovesExact,
    };
}

// Preserve the established `proven` meaning (the complete move table is
// exact), while exposing the materially earlier proof of the position value.
export function analysisState(proof, stopped) {
    if (proof.allMovesExact) return "proven";
    if (proof.positionExact) return "optimal";
    return stopped ? "settled" : "analyzing";
}

// One fair bounded proof probe is useful only for roots that can still beat
// the incumbent. Tight score/lower gaps go first, but no threatening root is
// omitted; the caller owns the per-root budget and can stop as soon as the
// position value is certified.
export function positionProofCandidates(moves, lowerOf) {
    const proof = summarizePositionProof(moves, lowerOf);
    if (proof.positionExact) return [];
    return moves
        .filter((move) => !move.exact && lowerOf(move) < proof.positionUpper)
        .sort((a, b) => {
            const gapA = a.score - lowerOf(a);
            const gapB = b.score - lowerOf(b);
            return gapA - gapB || a.score - b.score || b.size - a.size || a.cell - b.cell;
        });
}
