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

// Lane zero owns the only WebGPU device.  Its modulo-owned CPU roots can be
// finished before satellite workers have proved their roots; stopping that
// worker at that point also stops otherwise useful, position-wide GPU
// playouts.  Keep it alive only while there is genuine unresolved work.  The
// caller still replay-verifies every GPU candidate and stops immediately on a
// stale position or failed device.
export function shouldGpuCaretake(moves, lane, gpuState) {
    return lane === 0 && gpuState === "on" && moves.some((move) => !move.exact);
}

// Pre/post-play proof parity. A root just above the exact gate crosses it
// after a single removal: the moment it is played, its child position runs
// the escalating value ladder on its own compact moves and can prove in
// seconds what the parent never attempted. Select exactly the threatening
// roots inside that one-move band — a distant root gets no ladder after
// being played either, so it must not receive speculative exact work or
// block settlement. Tight score/lower gaps first: cheapest proofs land
// soonest.
export function parityProofCandidates(moves, {
    childRemainingOf, maxChildGroupOf, exhaustedOf, gate, cap,
}) {
    if (moves.length === 0) return [];
    const incumbent = moves[0].score;
    return moves
        .filter((move) => {
            if (move.exact) return false;
            const remaining = childRemainingOf(move);
            if (remaining <= gate) return false;
            if (remaining - maxChildGroupOf(move) > gate) return false;
            if (exhaustedOf(move) >= cap) return false;
            const canImprove = move.lower < incumbent;
            const canAlsoClear = incumbent === 0 && move.score > 0 && move.lower === 0;
            return canImprove || canAlsoClear;
        })
        .sort((a, b) => (a.score - a.lower) - (b.score - b.lower) ||
            a.score - b.score || b.size - a.size || a.cell - b.cell);
}

// Constructive parity farther above the gate. The moment such a root is
// played, its child re-runs the bounded proof seeks one ply deeper — every
// (second, third) prefix gets its own 100k/1M turn plus per-second B&B
// probes — which is how an unproved row flips to a proven zero within a
// second of being played. Mirror that aggregate branch budget pre-play by
// escalating the one-shot virtual-child pair seeks for every root that can
// still improve the incumbent or match a zero. Only boards small enough that
// the played child could actually prove quickly participate; anything larger
// has no discontinuity to mirror.
export function pairAuditCandidates(moves, {
    childRemainingOf, exhaustedOf, gate, boardRemaining, maxRemaining,
}) {
    if (moves.length === 0 || boardRemaining > maxRemaining) return [];
    const incumbent = moves[0].score;
    return moves
        .filter((move) => {
            if (move.exact || exhaustedOf(move)) return false;
            if (childRemainingOf(move) <= gate) return false;
            const canImprove = move.lower < incumbent;
            const canAlsoClear = incumbent === 0 && move.score > 0 && move.lower === 0;
            return canImprove || canAlsoClear;
        })
        .sort((a, b) => (a.score - a.lower) - (b.score - b.lower) ||
            a.score - b.score || b.size - a.size || a.cell - b.cell);
}

// Exact-ladder rotation: every in-band root gets its bounded value attempt
// before any sibling escalates a tier further. vsBegin resumes only the most
// recently paused root's DFS frontier, so switching roots costs one
// VTT-accelerated re-descent per tier — bounded by the geometric budgets —
// while head-of-line blocking on one hard root starves siblings that are
// provable in seconds the moment they are played.
export function exactCandidateOrder(moves, investedOf) {
    return moves.slice().sort((a, b) => investedOf(a) - investedOf(b) ||
        a.size - b.size || a.score - b.score || a.cell - b.cell);
}

// Primary-lane proof caretaking. Satellite lanes run a much smaller value
// memo and can thrash for minutes on a ~80-cell child the primary's full
// table proves in seconds. Once the primary's own roots are exact it adopts
// every unproven in-band root: exact proofs are lane-independent — the pool
// accepts one proof from any lane and broadcasts it back as a seed, so the
// stuck owner simply drops its grind when the adopted proof arrives.
export function caretakerProofCandidates(moves, { lane, owns, childRemainingOf, gate }) {
    if (lane !== 0) return [];
    if (!moves.filter(owns).every((move) => move.exact)) return [];
    return moves.filter((move) => !owns(move) && !move.exact &&
        childRemainingOf(move) <= gate);
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
