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

// A first move removes its displayed group before the child analysis starts.
// Proof/portfolio gates must use this value or a 89-cell parent with a 2-cell
// move behaves differently from the resulting 87-cell child position.
export function remainingAfterMove(remaining, move) {
    return Math.max(0, Number(remaining) - Math.max(0, Number(move?.size) || 0));
}

// Interleave prefix work by parent. Every parent gets its Nth second-move turn
// before any parent receives turn N+1, so a wide/hard child list cannot starve
// a short one. Budget tiers are applied outside this pure ordering helper.
export function roundRobinPrefixTasks(parents) {
    const lists = parents.map((parent) => ({
        cell: parent.cell,
        seconds: Array.from(parent.seconds ?? []),
    }));
    const rounds = lists.reduce((max, parent) => Math.max(max, parent.seconds.length), 0);
    const tasks = [];
    for (let round = 0; round < rounds; round++) {
        for (const parent of lists) {
            if (round < parent.seconds.length) {
                tasks.push({ cell: parent.cell, second: parent.seconds[round] });
            }
        }
    }
    return tasks;
}

// Reconstruct the task order and lane identity a position receives after its
// parent move is actually played. `branches` must be in the clicked board's
// stable root-index order; tasks within a branch are already in that root's
// preferred order. Ownership is the parent-major ordinal, while execution is
// diagonal/round-robin across roots. Keeping both values is what makes a
// receding parent search comparable to the post-click search.
export function mirrorClickedPrefixTasks(branches, limit = Infinity) {
    let ordinal = 0;
    const indexed = Array.from(branches ?? [], (branch) =>
        Array.from(branch?.tasks ?? [], (task) => ({
            ...task,
            postClickOrdinal: ordinal++,
        })));
    const rounds = indexed.reduce((max, tasks) => Math.max(max, tasks.length), 0);
    const ordered = [];
    const bounded = Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : Infinity;
    for (let round = 0; round < rounds && ordered.length < bounded; round++) {
        for (const tasks of indexed) {
            if (round < tasks.length) ordered.push(tasks[round]);
            if (ordered.length >= bounded) break;
        }
    }
    return ordered;
}

// Stable ownership for a fixed search context. Unlike a sequential ordinal,
// this does not change when another lane has already proved and omitted an
// unrelated parent. That lets workers build only their still-live context
// queues without duplicating work or leaving a prefix unassigned.
export function prefixTaskOwner(cell, prefix, laneCount) {
    const lanes = Math.max(1, Math.floor(Number(laneCount) || 1));
    let hash = (Math.floor(Number(cell) || 0) + 1) >>> 0;
    for (const move of prefix ?? []) {
        hash ^= (Math.floor(Number(move) || 0) + 1) >>> 0;
        hash = Math.imul(hash, 0x45D9F3B) >>> 0;
        hash ^= hash >>> 16;
    }
    return hash % lanes;
}

// A suffix of an exact root line is exact in the next position only when that
// position is the actual board produced by the root move. Replaying the suffix
// on some other board validates a constructive score, never its lower bound.
export function canTransferExactSuffix(previous, move, nextBoardKey) {
    return move?.exact === true && previous?.childKeys instanceof Map &&
        previous.childKeys.get(move.cell) === nextBoardKey;
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

// Lane zero owns the only WebGPU device. Its ordinal-owned CPU roots can be
// finished before satellite workers have proved their roots; stopping that
// worker at that point also stops otherwise useful, position-wide GPU
// playouts.  Keep it alive only while there is genuine unresolved work.  The
// caller still replay-verifies every GPU candidate and stops immediately on a
// stale position or failed device.
export function shouldGpuCaretake(moves, lane, gpuState) {
    return lane === 0 && gpuState === "on" && moves.some((move) => !move.exact);
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
