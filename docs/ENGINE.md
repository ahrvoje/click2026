# Click2026 Analysis Engine

A chess-engine-style analysis assistant for the Click2026 puzzle: while the
player plays, it continuously searches the current position in an adaptive
pool of background workers and shows the five most promising moves, each
scored by the fewest
blocks it is known to leave on the board. The search core is WebAssembly
(compiled from AssemblyScript), with optional WebGPU playout and heuristic
ranking paths. CPU and GPU work are counted separately in the UI.

This document is the maintenance manual: game analysis, algorithms, data
layout, protocols, tuning method, and the reasoning behind each decision.

---

## 1. The game, formally

* Board: 12 × 12 cells, 5 colors, column-major state `position[col][row]`,
  `row 0` at the bottom. `0` = empty. (`src/scripts/board.js` is the single
  source of truth for the rules.)
* A move clicks any *group* — a maximal 4-connected (full-side adjacency)
  same-color region of **size ≥ 2** — and removes it. Columns then collapse
  down; empty columns are closed by shifting the right part left (stable
  order). Single cells are not clickable.
* The game ends when no group of ≥ 2 exists. The objective is to **minimize
  the number of remaining blocks**; 0 (a clean board) is perfect.

### Consequences that shape the engine

* Every move removes ≥ 2 cells → a game from a full board lasts ≤ 72 moves;
  search depth is bounded and *every* line terminates.
* Moves are **not** independent: gravity + column closing means removing one
  group can merge or split others. The move graph is a DAG with heavy
  transpositions (different orders of "independent" moves often reach the
  same board), which per-depth hashing exploits.
* Deciding whether a board can be cleared completely (Clickomania) is
  **NP-complete** for 2 columns and 5 colors, or for 5 columns and 3 colors
  ([Biedl et al.](https://erikdemaine.org/papers/ClickomaniaGameTheory2000/)).
  Exhaustive search of a 144-cell, 5-color start is hopeless: branching is
  20–35 near the start and the state space is astronomically large. An
  engine must therefore be *heuristic and anytime* — but it can still be
  **exact on small endgames** (Section 6) and *honest* everywhere: every
  score it reports is backed by a concrete line it actually found
  (see "Score semantics" below).
* A color reduced to exactly **one cell** can never be removed (counts never
  grow), so it seeds a permanent-cell lower bound. Permanent cells can in
  turn create permanent columns and vertical barriers; a fixed-point future-
  touch analysis proves additional `R-B-R`-style leftovers. This bound is
  used by both heuristic focusing and exact proof.

## 2. Strategy and tactics (what the engine — and a human — should do)

1. **Preserve the glue.** The most frequent color forms the connectivity
   backbone. Removing it early splinters the board into color islands.
   Playing the *other* colors first lets gravity merge the dominant color
   into one huge group that is removed late, often clearing whole regions.
   The engine's playout portfolio encodes this as a strong bias. Most samples
   never click the dominant post-root color while any alternative exists; a
   smaller full-support member gives every legal group non-zero probability
   (non-tabu groups have 8× the weight). The second member matters when a
   solution must temporarily break the usual strategic rule.
2. **Never orphan a color.** Leaving a color with a single cell is a
   guaranteed leftover; leaving it with 2–3 scattered cells is a probable
   one. The evaluation punishes "dead" cells hardest, then size-1 fragments.
3. **Fight fragmentation.** Each color should ideally live in one connected
   component. Components merge only through gravity, so moves that connect
   same-colored regions (vertically by removing what separates them in a
   column, horizontally by emptying a whole column between them) are the
   main constructive tactic.
4. **Think in columns near the end.** Column closing is the only horizontal
   motion; emptying an entire column is often the only way to join two
   distant halves of a color.
5. **Count the endgame.** Below ~30 blocks the position is exactly solvable
   in milliseconds — intuition can and should be replaced by proof. The
   engine does this automatically (✓ rows in the list are proven optimal).

## 3. Architecture

```
main thread                         independent module workers
──────────────────────────────      ────────────────────────────────────────
click.js ──position──► engine-ui.js ─► EngineWorkerPool ─┬─► lane 0: primary WASM + WebGPU
   ▲                         ▲                           ├─► lane 1: compact WASM
   │ drawOverlays(ctx)       └──── merged results ──────┼─► ...
canvas + engineList                                      └─► lane N-1: compact WASM
```

`EngineWorkerPool` uses ordinary independent workers and private WASM memories,
not `SharedArrayBuffer`. It therefore works from static GitHub Pages without
COOP/COEP headers. Root-scoped work is divided deterministically by the root's
stable enumeration ordinal modulo the active lane count. Root enumeration is
ascending by representative cell, so every worker agrees on ownership while
lane root counts differ by at most one. Lane 0 owns WebGPU; the other lanes are
CPU-only. The bounded virtual-child portfolio likewise partitions its complete
second-ply task list by stable ordinal. For the deeper pre-click consistency
portfolio, each unresolved first move independently recreates the task ordinals
that its child position would receive after that move was clicked; ownership is
`postClickOrdinal % lanes`. Execution is diagonally interleaved across that
child's roots and then round-robin across the original parent rows. Results are
soundly combined on the main thread and useful lines/proofs are sent back to
every lane as replay-validated warm starts.

| File | Role |
| --- | --- |
| `asm/engine.ts` | AssemblyScript search core → primary/compact, SIMD/scalar WASM binaries |
| `src/scripts/engine/pool.js` | adaptive lane policy, root ownership, result/proof merge, worker recovery |
| `src/scripts/engine/worker.js` | anytime scheduler, protocol, GPU orchestration |
| `src/scripts/engine/schedule.js` | pure, unit-tested stagnation/settlement state transitions |
| `src/scripts/engine/gpu.js` | adaptive WebGPU playout/feature kernels, resource pool, counters + CPU twins |
| `src/scripts/engine-ui.js` | button state, move list, canvas outlines |
| `src/scripts/click.js` | position change notifications, redraw hook |
| `tools/engine.test.mjs` | Node proof of rule equivalence + search validity |
| `tools/engine.pool.test.mjs` | lane selection, root partition and sound merge tests |
| `tools/gpu.test.mjs` | GPU profile, packing, counters and CPU-twin helper tests |
| `tools/engine.tune.mjs` | evaluation weight tuning harness |
| `tools/engine.e2e.mjs` | headless-browser end-to-end check |

The rules are implemented **twice by design** (JS `board.js` for the game,
AssemblyScript for speed) and once more in WGSL. The Node test suite replays
random games move-by-move through both CPU implementations and requires
bit-identical boards; the GPU twin is checked at runtime (Section 7). If you
change any rule, change all three and let the tests arbitrate.

### CPU lane and memory policy

The automatic lane cap is 16. Phones and tablets detected from the browser's
mobile hints use one lane. Other devices use 1/2/3/4/8/16 lanes for at most
4/8/12/16/24/more than 24 logical processors respectively. When
`navigator.deviceMemory` is available, a conservative budget of roughly 10%
of the reported memory can reduce that count. The API is privacy-rounded and
often capped, so it is used as a low-memory guard rather than proof that a
desktop has little RAM.

Lane 0 loads the full 2^23-entry value/certificate memo and starts at about
178 MiB of WASM linear memory. Each additional lane loads a compact 2^20-entry
memo and starts at about 46 MiB. Compact lanes can still run every search stage
on their owned roots; their smaller memo trades exact-search cache retention
for safe total memory. Sixteen lanes reserve about 868 MiB in total. The
`deviceMemory` guard is applied only to reported values below 8 GiB, because
browsers commonly cap the value at 8 GiB even on larger desktops. Use
`?engineWorkers=N` to force 1–16 lanes for diagnosis and benchmarks.
If a lane fails, the pool restarts all lanes with one fewer worker because the
modulo partition changes with `N`; continuing the survivors would abandon the
failed lane's roots.

### Score semantics (important)

A move's score is **the number of blocks left after the best line the engine
has found so far starting with that move** — an *achievable upper bound* on
the true optimum, never a guess. Internally every root move stores its best
line; the Node suite replays those lines through `board.js` and fails if a
claimed score does not reproduce. `0 ★` means a full clear is in hand; `✓`
means the score is proved optimal, either by equality with an admissible bound
or by exact search. Scores only ever improve (decrease) while the engine keeps
thinking, exactly like a chess engine deepening.

The whole position has a constructive upper bound equal to the minimum root
score. Its admissible lower bound is the minimum, over all roots, of the exact
score for a proved row and that row's `lower` bound otherwise. Equality proves
the position optimum even if some non-optimal alternatives remain unresolved;
this is reported separately from proving every row.

## 4. Search pipeline (per position)

Implemented in `worker.js::analyze()` independently in every lane; every stage
refines that lane's per-root result table inside WASM and posts a snapshot to
the pool. Each worker constructs the same immediate greedy table so a complete
move list is available at once. CPU playouts, partitioned global beams,
root-private beams, bounded proof probes and exact ladders normally work only
on roots owned by that lane; the finite virtual-prefix stages described below
apply their own deterministic cross-lane partition. Stochastic lanes receive
independent non-zero seed streams. The stable root partition is exhaustive and
disjoint; changing the lane count requires a complete pool restart.

For each root, the pool retains the minimum replayable score (constructive
upper bound) and maximum sound lower bound. One exact result proves that root;
disagreeing exact values or a constructive value below an exact proof are
treated as errors. Whenever the merged line/proof set changes, it is broadcast
to all lanes. `seedLine` and `seedExactByCell` replay and validate those peer
claims inside WASM before adopting them, so worker communication cannot turn a
heuristic or malformed line into a score or proof.

0. **Warm start** (`seedFromMemory` → `seedLine`/`seedExactByCell`): each
   worker keeps an LRU cache (64 positions) of every move list it has
   posted. A new analysis is seeded with the cached lines of its own
   position plus the *suffixes* of the previous position's lines. A suffix
   that replays on the new board is always only a constructive upper bound
   unless the new board key equals the exact one-ply child recorded for that
   previous root move. Only that actual parent→child relation may transfer the
   previous row's exact flag; replaying the same legal suffix on an unrelated
   board cannot transfer its lower-bound proof. For rewind/general
   transposition reuse the worker also
   materializes each one-ply child; if that child board is cached, its line is
   prepended with the creating root move. Every seed is replay-validated
   inside WASM before being merged (wrong guesses are rejected, never trusted).
   Same-board cached proofs are restored when the seeded score matches, and a
   proved cached child may prove its creating parent row. Consequence:
   playing a suggested `0 ★` move can never make the engine "lose" the
   clearing line, and revisiting a position (rewind) restores everything
   it ever knew about it instantly.
1. **Greedy baselines** (`setBoard`): for each legal move, a
   largest-group-first rollout. Instant (~15 ms for 144 cells), guarantees
   every root has a real score before anything else is shown. Each root child
   also gets an admissible permanent-cell lower bound; a baseline that meets
   it is proven immediately.
2. **One-ply child table** (`probeRootChildTable`): for every owned unresolved
   root, materialize its child and give *each* legal second move the same cheap
   largest-group continuation it would receive as a root if the player clicked
   into that child position. This closes the tactical asymmetry where entering
   the child could reveal an exact zero in milliseconds while the equivalent
   parent row waited for a very wide beam. All retained lines are fully
   replayable constructive witnesses. The minimum permanent lower bound over
   the grandchildren safely strengthens the parent row; equality proves it,
   and a clearing line proves itself at lower bound zero. The pass is bounded
   to one shallow table per root and is partitioned by normal lane ownership.
3. **CPU playout portfolio**: 32 hard-tabu random playouts plus 4
   full-support soft-tabu playouts per unproven root (`playoutRoot` and
   `playoutRootSoft`) owned by the lane. The original high-quality policy is
   preserved; the supplement removes its zero-probability blind spot.
4. **GPU second-ply assist** (lane 0 when WebGPU is active): WASM exports up
   to 4096 legal boards after two moves. A small GPU feature kernel ranks them
   by progress/connectivity features and keeps two candidates per root. WASM
   completes each selected candidate with a playout and replays the entire
   line from the original board through `seedLine`. The GPU score is therefore
   only a work-order hint; it is never a score, lower bound or proof.
5. **Iterative-widening beam search**: deterministic passes with widths
   8 → 32 → 128 → 512 → 2048. Each pass expands layer by layer (layer *d* =
   boards after *d* moves), keeps the best `width` children per layer by
   evaluation (replace-max heap), dedups transpositions inside a layer via
   64-bit Zobrist hashes, and reports every terminal reached. All unproven
   root moves are kept in layer 1 regardless of width. Later layers share a
   heap, so continuous search also supplies private per-root passes (below)
   rather than assuming that initial inclusion prevents starvation.
   A pass over a full board costs roughly `width × 60 layers × 25 children`
   evaluations; on the development benchmark the optimized core processes
   about 1.9–2.0 M considered children/s. Proven roots are omitted, and a
   remaining-count lower bound rejects hopeless children before board copy,
   removal, collapse and evaluation.
   Global passes start with only the roots assigned to this lane
   (`beamBeginPartition`); descendant work remains local to that worker.
   On positions with at most 72 cells whose current best is at most 5, after
   width 512 and before width 2048, the leading two zero-lower-bound roots
   also receive one root-private
   width-8192 **permanent-only portfolio** pass. It ranks only by cells
   remaining plus proved-permanent cells. This bounded orthogonal objective
   preserves corridors that temporarily accumulate fragments/frozen colors
   immediately before a gravity merge, instead of asking random noise to
   overcome the same scalar bias in every beam. Its bounded frontier ignores
   the current nonzero incumbent when pruning, so an earlier score improvement
   cannot paradoxically hide a clearing corridor from the complementary pass.
6. **Virtual-child and receding-horizon consistency portfolio**: after the
   initial width-2048 beam, every unresolved parent whose child remains above
   the exact gate materializes its legal second moves. The complete sorted
   `(first, second)` list receives a stable ordinal partition across lanes, and
   all lanes remain alive until this bounded audit finishes. This is the same
   decomposition the engine would receive after the player clicked `first`;
   second moves no longer compete forever inside one first-root heap. Each pair
   gets the clicked child's one-ply table, hard/soft playouts, fair 100k- and
   1 M-node target-seek tiers, and explicit prefix beams at widths 128, 512 and
   2048 (deterministic plus two diversified width-2048 seeds).

   A click would expose the same problem one ply deeper, so still-live parents
   also receive a bounded third-ply frontier. For each original parent, second
   moves remain in the clicked board's stable root-index order; the third moves
   below each second move are ordered largest-first. A parent-major
   `postClickOrdinal` is assigned before scheduling, exactly reproducing the
   lane identity (`postClickOrdinal % lanes`) that the task would have after the
   original parent was clicked. Execution then diagonally interleaves the
   second branches so each gets its first third-move context before any gets a
   second, and round-robin interleaves the original parents. At most 256
   `[second, third]` contexts per parent enter this frontier. Proving or
   filtering an unrelated original parent therefore cannot renumber, duplicate
   or orphan another parent's work. Every context gets a 100k-node target
   probe; rows within five cells of their sound bound also get width-128/2048
   beams and a later 1 M-node probe.

   Every retained line contains `[first, second, third, ...tail]` as applicable
   and is replayable from the original board. Prefix work is constructive only:
   a target witness may prove the parent when it meets that parent's independent
   admissible lower bound, but exhaustion or a completed non-winning prefix
   never raises the parent bound. The 256-context cap is deliberate: exhaustive
   first×second×third expansion caused multi-billion-node stalls and merely
   moved the search cliff one ply instead of repairing it.
7. **Large-board position-proof portfolio**: after the virtual-child audit, a
   child above the `remaining ≤ 88` persistent-exact gate receives
   a fair, bounded branch-and-bound pass. Up to 16 unresolved roots whose lower
   bounds can beat the incumbent get at most 2 M nodes each (32 M nodes per
   board) before the worker returns to ordinary search, preventing one
   difficult positive-valued alternative from monopolizing proof work while
   an easy optimal sibling waits. Remaining roots retain the continuous
   max-width fairness audit. A completed child proof is merged normally.
   If a budget expires, any better terminal witness found so far is still
   retained as a constructive score/line improvement, but exhaustion alone
   never sets the row's exact flag. The portfolio stops as soon as the global
   lower and upper bounds meet; ordinary continuous investigation still audits
   the unresolved alternatives.
8. **Continuous investigation** — ends in exactly three ways: a new
   position arrives, every move is **proven**, or the search is **settled**
   (stagnant at the top of the width ladder on a board too large to
   enumerate) — never by an arbitrary timer:
   * **bigger-group priority**: moves whose group is *larger* than the best-
     scoring move's group but whose score has not yet matched it
      ("hopefuls") get first claim on locked passes and playout samples.
      Exact work uses the opposite, proof-oriented order: the smallest root
      group first. That child retains the most cells, so its traversal covers
      the broadest descendant DAG and warms the shared exact-value memo for
      narrower roots. With the same memo on `played-18-24`, display-score
      order proved only 2/10 roots in 60 s; broadest-first proved 10/10 in
      about 45 s.
      Rationale: the rating is time-based, and equal outcomes through
     bigger groups need fewer clicks — when the player sees a `0 ★` on a
     2-group, the engine actively investigates whether the big group
     clears too (ties already rank bigger groups first);
   * alternating passes: odd passes are **root-locked** — the whole beam
     explores one subtree, with that root's private width escalating
     2048 → 4096 → 8192 → 16384 and its own attempt-seed stream (hopefuls
     first, then the unproven top 5 and the first positive-score row). Even
     passes search globally with an
     independent seed stream. Once the global tier reaches 16384, a fairness
      audit gives every unresolved root whose admissible lower bound can beat
      the incumbent—or can match a zero incumbent—its own width-16384 pass.
      The engine cannot settle until
     this audit is complete; a weak-looking winning first move therefore
     cannot be permanently starved by the shared global heap;
   * **objective stagnation escalates width**: global passes start at 512
     and climb 512 → 1024 → … → 16384 according to passes without an
     improvement to the *best position score*. Improvements and proofs in
     low-ranked rows no longer reset this ladder. Wider beams buy exploration
     of the objective instead of letting irrelevant tail churn hold the
     search at a narrow width;
   * every 2nd pass a playout round biased to the displayed moves and the
     hopefuls (GPU batch of 1024 hard-tabu samples/root plus a small CPU
     soft-tabu supplement when available; otherwise CPU 48+6 samples for
     prioritized moves and 8+1 for the rest);
   * the **threshold/exact-proof ladder** (Section 6): after the initial
     playout and widening schedule, root children with
     `parentRemaining - move.size ≤ 88` are eligible for a pool-coordinated
     fixed-prefix threshold frontier. With a positive position incumbent `U`,
     its tasks ask the cheaper Boolean question whether a threatening child can
     reach `U-1`. A witness improves the constructive line; a row lower bound
     rises to `U` only after the coordinator has received exhaustive misses for
     that row's complete dependency set. The coordinator deduplicates exact
     board states across roots and paths before redistributing deeper work.
     Once the position value is known, the conventional B&B/value ladder keeps
     proving alternative rows. At child remaining `≤ 64` it first tries a
     2 M-node incumbent-driven B&B; 65–88 goes directly to the persistent exact
     value memo. Value retries retain their DFS frontier and completed cache
     entries; budgets escalate ×4 up to the WASM-safe i32 limit. A finished
     exact proof marks the row ✓.
   Proof and terminal states are distinct. **`optimal ✓`** means the global
   position bounds agree, so the best achievable score cannot change; the
   worker nevertheless keeps the existing playout, locked-pass and max-width
   fairness audit running for unresolved alternatives. An all-exact merge also
   remains `optimal` for the bounded interval in which lanes drain and post
   their final snapshots. **`proven ✓`** is emitted only after every move is
   exact *and* every lane has stopped, then the pool latches that terminal
   snapshot so positions, elapsed time and rates cannot change afterward.
   **`settled`**
   means an as-yet-unproved position reached 24 completed, unchanged *global*
   width-16384 passes above the proving gate, after the private max-width audit
   described above; locked and submaximal passes do not consume that budget.
   Any unresolved child inside the exact gate also blocks settlement.
   The engine stops honestly instead of cycling. An optimal position can also
   finish that alternative audit without losing its `optimal` state; the
   protocol's independent `settled` flag says whether compute has stopped.
   Below the gate it never settles:
   proofs always land eventually. Scores are maintained as monotone minima,
   so the top list only ever gets more reliable with time; any player move
   restarts analysis on the new position (stale results discarded by id).

### Interactivity

Each worker runs search in ~10 ms WASM slices (`beamStep(16000)`) and yields
through a `MessageChannel` macrotask between slices, so a new `analyze`
message preempts within milliseconds. Results are posted at most every
150 ms plus once per completed stage, then incrementally merged by the pool.
An already-submitted GPU dispatch cannot be cancelled, but stale CPU analysis
returns immediately and the new position resumes GPU submissions after the
shared device resources become available.

## 5. Evaluation function

For a candidate board (computed in one component-labeling scan,
`evalBoard`):

```
value = remaining
      + W_DEAD   · #{cells proved permanently stuck}      // exact lower bound
      + W_SINGLE · #{size-1 components of live colors}    // probable leftovers
      + W_FRAG   · Σ_colors max(0, components − 1)        // fragmentation
      + W_FROZEN · #{cells of frozen colors}              // hopeless-color mass
      (+ deterministic noise in stochastic passes)
```

Lower is better. `remaining` rewards progress, the penalties encode
Section 2. A **frozen** color has ≥ 2 cells but no playable pair anywhere on
the board — only a lucky gravity merge can save those cells, so each one is
a probable leftover (`W_FROZEN 0.5`, tuned: 48/60 clears vs 46/60 without).
Frozen cells are *usually* lost but not provably—columns can still close and
merge them—so that feature remains heuristic-only. The exact lower bound is
seeded by globally singleton colors. It also detects color-disjoint column
slabs: if no color occurs outside a slab and the slab has no legal pair, no
future move can change it, so every cell in it is permanent. From those
seeds, the analysis repeatedly proves a cell permanent when no same-color
cell can possibly touch it: vertical order cannot cross a permanent cell, a
column containing one can never disappear, and possible future row intervals
must overlap for horizontal contact. Deductions are batched per wave to avoid
circular reasoning.

This covers horizontal and vertical `R-B-R`, permanent walls, forced-height
mismatches, and cascades where one dead color proves another color dead. Full
geometry is evaluated only in separator-rich late beam states; roots are
always strengthened, and exact descendants inherit the bound with one late
recomputation. The bound was exhaustively checked against every normalized
3-color board up to 3×3 (60,880 boards) with no violation. Removable
separators such as `R-BB-R` remain unpruned and are explicit regressions.

The tuned weights remain the primary policy. The permanent-only portfolio
sets `W_SINGLE`, `W_FRAG` and `W_FROZEN` effectively to zero for one bounded
private pass; `W_DEAD` remains because it is admissible. Effective weights
are selected once at pass setup, so the normal per-node hot path has no policy
branch. This is deliberately targeted rather than a second global schedule.

Weights are **empirical**, tuned with `npm run tune:engine` (60 fixed random
boards, full-clear rate as the primary criterion). Grid results, 2026-07-11
(schedule [8, 32, 128], clears/60 | mean final):

| dead \ single·frag | 0.8·0.3 | 0.8·0.6 | 1.4·0.6 | 2.0·0.3 | **2.0·0.6** | 2.0·1.0 |
|---|---|---|---|---|---|---|
| 2 | 27 | 31 | 30 | 42 | 42 | 40 |
| 4 | 29 | 32 | 35 | 44 | 44 | 43 |
| **6** | 29 | 31 | 39 | 44 | **46** | 41 |

Winner **W_DEAD 6.0, W_SINGLE 2.0, W_FRAG 0.6** (checked up to single = 4.0 —
2.0 stays best); adding **W_FROZEN 0.5** lifted the fast-schedule clear rate
to 48/60. Validated with the tuning validation schedule ([8..512] + 2
stochastic passes): **55/60 boards cleared, mean 0.20 blocks left** — the
live engine searches far deeper than this benchmark. To re-tune after
changing anything, run the harness and update the defaults in
`asm/engine.ts`.

### Search-core hot path

The beam counter is the number of legal children considered. The optimized
child path preserves the exact JS rules while avoiding redundant work:

* enumeration retains each legal component's member cells, so selecting it
  clears known cells instead of flood-filling the same group again;
* generic removal clears a cell as soon as it enters the flood stack, using
  the zero as its visited mark;
* removal accumulates a touched-column mask. Vertical gravity scans only
  those columns, and horizontal compaction runs only if one became empty;
* gravity leaves an already normalized prefix in place and moves/clears cells
  only after the first gap, avoiding a clear-and-rewrite pair for every
  occupied cell;
* each beam node carries its remaining count. With nonnegative evaluation
  weights, `childRemaining` is a cheap evaluation lower bound; once the heap
  is full, children that cannot enter it or improve a terminal root score are
  rejected before board copy/removal/evaluation.

The default binaries enable WebAssembly SIMD; `boardRemaining` counts the nine
16-byte vectors with lane masks instead of 144 scalar branches. A scalar build
from the same source is selected automatically if SIMD compilation or
instantiation is unavailable. This is an implementation fallback, not a
different search policy or result format.

`npm run bench:engine` runs a fixed beam corpus plus medium exact-proof
positions. Keep node counts, proof values and replay validation stable when
changing this path; wall-clock comparisons should use several runs on an
otherwise idle machine.

## 6. Exact solver

Before any enumeration, each root child gets the permanent-cell lower bound
described in Section 5. Every stored score is a constructive upper bound;
equality of the two bounds proves that move immediately. Thus a replayable
score 0 is self-proving, while separator positions can also prove positive
scores without enumeration. Proven roots are removed from subsequent beam,
CPU-playout and GPU-playout work.

Budgeted branch & bound DFS (`exactBegin`/`exactStep`/`exactMerge`):

* upper bound: best line already known from the beams (start value);
* lower bound (admissible): propagated permanent cells plus newly created
  singleton colors; subtrees whose bound reaches the incumbent are cut;
* transposition table: a dedicated 2^20-entry four-way seen table, keyed by
  Zobrist hash. A primary whole-position `exactBegin` pass can instead borrow
  available key/stamp slots from the 2^23-entry value table as a transient,
  larger duplicate filter; exact values and threshold certificates are never
  overwritten by that pass. Replacement or a protected full bucket can cause
  re-expansion but never an invalid prune;
* child boards are generated directly in the next explicit-stack frame, and
  remaining count, lower bound and hash are fused into one board scan;
* explicit stack, budget-limited and resumable in chunks, so it never
  blocks the worker loop.

Entry points sharing the machinery:

* `exactBegin` — B&B solve of the analysis root (used by the tests as
  ground truth against brute force);
* `exactBeginChild(k)` / `exactMergeChild(k)` — B&B solve of the position
  *after* root move `k`, seeded with that move's best-known line as the
  upper bound;
* `exactChildSeek(k, budget, target)` — like the child solve but with a
  *known* target value. It stops at the first matching terminal witness; the
  target was already proven by the value solver, so a second proof is waste;
* `exactBeginRootPrefixSeek(k, prefixLen, budget, target)` /
  `exactCommitRootPrefix(token)` — a target seek below an arbitrary explicit
  prefix supplied through IO. The positive begin-generation token prevents a
  stale completion from attaching a witness to a later prefix. The saved root
  and prefix are prepended to the recorded tail. The older
  `exactBeginRootChildSeek`/`exactCommitRootChild` pair is the one-prefix-move
  wrapper used by the second-ply portfolio. Completing or exhausting one
  prefix never proves the whole parent; only a constructive target that meets
  the independently computed parent lower bound can set the exact flag.

Above the persistent-exact gate, the post-beam position-proof portfolio uses
the same child B&B machinery with a hard 2 M-node budget per root. It is a
prioritized witness/proof portfolio capped at 16 roots / 32 M nodes, not an
attempt to enumerate the full opening:
budget exhaustion preserves a better replayable terminal line but does not
claim that root is exact. The portfolio terminates early when the minimum
constructive score equals the minimum admissible root bound. Continuous beam
and playout work then remains available to improve or prove the other rows.

### Threshold-certificate solver

For a positive incumbent, computing every exact minimax value answers more
than the position proof requires. `thresholdBegin(target)` and
`thresholdBeginChild(k, target)` instead decide whether any terminal with
`remaining ≤ target` exists. `thresholdStep` is a resumable explicit-stack
OR-DFS. A witness is copied into a durable replayable line. A state is stored
as a no-target certificate only after all of its children have failed, so the
context-free statement is exactly `value > target`; budget exhaustion never
creates a certificate or raises a bound. `thresholdMerge` raises every root
lower bound after a completed whole-position miss, but only root `k` after a
completed child miss.

The threshold solver shares the persistent value table using disjoint stamp
ranges:

* `0` is empty;
* `1` is an exact value plus policy move;
* `2..146` encodes the certificate `value > stamp - 2`;
* `147..255` is reserved for transient generations of the primary's wide
  whole-position B&B seen set.

An exact value is stronger than a certificate. A certificate for target `T`
also discharges every lower target, while an exact value at or below `T`
supplies witness-first move ordering. Four-way replacement prefers durable
exact entries and larger completed sub-DAGs; declining or losing a cache entry
causes only safe re-expansion.

For a positive incumbent `U`, the pool coordinates a complete fixed-prefix
frontier at target `U - 1` for every row with
`lower ≤ U - 1 < score` whose child has at most 88 cells. The initial frontier
has one empty-prefix task per candidate.
Tasks in each broadcast frontier have stable ordinal ownership
(`taskOrdinal % lanes`), so a retry stays on the same lane. A worker runs
`thresholdBeginRootPrefix` with a 250k-node budget. If that budget is exhausted
before the fixed prefix reaches length three, it returns the task's *complete*
legal-child manifest and a materialized 144-byte successor board for each
child; the next round can split again through prefix depth three.

The pool groups successor tasks by exact equality of all 144 board bytes, not
by a Zobrist or content hash. One representative task retains every
participating root alias, with one replayable prefix per root, so commuting
move orders are searched once without losing any root's proof obligation. A
prefix miss discharges all of its aliases, but a root lower bound rises to `U`
only after every dependency currently representing that root has returned an
exhaustive miss. A split never counts as a miss. Thus state sharing reduces
work without letting a partial frontier certify a row.

At prefix depth three, an exhausted hard task rotates behind the other tasks
assigned to its lane while completed value-table certificates are retained.
Its budget doubles on each return from 250k up to 8 M nodes; a lone task can
resume directly. A frontier is hard-limited to 8192 unique board states and
65536 root aliases. Exceeding either limit cancels and blacklists that
`(position, target)` plan instead of truncating it, because dropping one branch
would make a later lower bound unsound. A witness improves the constructive
line and causes an obsolete target plan to be replaced; changing the board or
plan epoch likewise cancels stale work.

The worker-local `thresholdBeginChild` path remains available to the ordinary
exact ladder when no coordinated plan is active. Its first retained attempt is
8 M nodes and retries escalate ×4 up to 2 B nodes. Changing its root/target or
starting an incompatible exact/value search cancels that retained DFS state,
so a stale decision cannot be merged into another obligation.

### Value solver (`vsBegin` / `vsStep` / `vsBuildLine`)

The B&B solvers prune by bound, which makes their transposition entries
context-dependent — fine for one proof, wasteful for many. The **value
solver** instead computes context-free minimax values with memoization. A
frame normally evaluates every child, but finalizes early when a resolved
child reaches that board's admissible lower bound: no remaining child can do
better, so the stored value is still exact. Values, a best move and the
state's remaining count are stored in a persistent, four-way memo. The primary
lane uses 2^23 entries (`VTT`, 96 MiB across keys/data/occupancy/depth); compact
satellites use 2^20 entries. Full exact-value buckets evict the
lowest-remaining state, retaining the larger sub-DAG that is more expensive to
reconstruct. Entries are shared within one worker

* across that lane's owned root moves and budget escalations,
* across later analysis positions in the same worker — playing a move turns
  the new board into a previously searched descendant,
* with a retained DFS frontier on budget exhaustion, so a retry continues
  the unfinished branch rather than walking down to it again.

WASM memories are private, so transposition entries themselves are not shared
between workers. What crosses lanes is the smaller and safer artifact: an
achievable line and, when available, its exact value, replay-validated by the
receiving WASM instance.

The policy move stored with each value lets `vsBuildLine` reconstruct an
optimal line in roughly one lookup per move. Because a cache entry can still
be replaced, every improving terminal is also copied directly from the live
DFS stack into the root's durable replay line. If a later root is resolved
mostly from shared memo hits and its policy chain has a gap,
`exactChildSeek` follows surviving exact policy entries and searches only the
missing segment. On the hard corpus this reduced line recovery from a
potential second proof to tens or hundreds of nodes. The live ladder tries a
2 M-node B&B first only at `remaining ≤ 64`; from 65 through 88 it starts the
shared value traversal immediately.

Once one sibling has exact value `m`, another child whose sound lower bound
is already `≥ m` is skipped before board copy. A stronger post-materialization
check supplies a second cutoff. Skipped children are never memoized as exact;
the parent remains exact because they cannot improve its resolved minimum.
Root separator bounds propagate monotonically. Recomputing the geometric
fixed point at every node reduced nodes but increased time, so it is refreshed
only once when a path first enters the final eight cells.

The persistent threshold/exact ladder is gated per root at
`parentRemaining - rootGroupSize ≤ 88`, which is exactly the remaining count
seen after that move is played. With a positive incumbent `U`, the coordinated
frontier described above takes precedence and seeks `U-1`; its bounded slices
yield to the event loop but not to another CPU heuristic pass while that plan
remains active. The position becomes optimal once every threatening row's
complete aliased dependency set has missed and all effective root lowers reach
`U`, without enumerating irrelevant values above `U`. The exact-value phase
still follows to prove alternative rows. In the worker-local ladder, child
positions at or below 56 run eight chunks per scheduler quantum and 57–88 run
four; mixed boards interleave those local quanta with heuristic work. The
engine cannot settle while an eligible proof obligation remains unresolved.
Above the per-child gate, the bounded virtual-child and per-root B&B portfolios
run before continuous heuristic search. For those beams,
a global seen-set is deliberately NOT used:
stochastic passes revisit
states *on purpose* with different noise and beam context — blocking
revisits would break diversification, and no memory could come close to
covering the ~10^60 opening space anyway. Below the gate, enumeration wins;
above it, diversification does — and when even max-width diversification
stops producing changes, the engine settles instead of cycling (Section 4).

Verified against exhaustive JS brute force on hundreds of small boards in
the test suite — root optima, per-child B&B proofs, per-child value solves and
whole/child threshold decisions on both sides of the true value (plus a
wasm-vs-wasm cross-check of the value solvers on 32-cell boards), including
line replayability and one-node threshold resumption throughout.

## 7. WebGPU acceleration

Only lane 0 creates a WebGPU device. `gpu.js` requests the high-performance
adapter but accepts the browser's final choice, then selects a conservative
profile from mobile hints and available adapter identity:

| Profile | Samples/root (initial; range) | Target batch | In-flight slots |
| --- | --- | --- | --- |
| mobile | 512; 128–4096 | 40 ms | 1 |
| integrated | 1024; 256–8192 | 55 ms | 2 |
| balanced/unknown | 1024; 256–8192 | 60 ms | 2 |
| discrete | 2048; 512–16384 | 75 ms | 3 |

After the first batches, `recommendPlayouts()` uses an EWMA of observed
aggregate playout throughput, the number of candidate rows and the profile's
target duration. Counts remain workgroup-aligned and within device dispatch
limits and the 24-bit seed-index encoding. This keeps an iPhone-sized device
responsive while giving a desktop discrete GPU enough independent work.

### Playout kernel

The hard-tabu WGSL kernel is the deterministic twin of `playoutRun()` in
`asm/engine.ts`: same xorshift128 RNG, ascending-cell enumeration, dominant-
color taboo and stable collapse. Boards travel packed four cells per `u32`.
Each playout thread atomically contributes its exact expanded-board count—one
for every non-terminal board from which it applies a move, matching the CPU
playout definition; the final terminal board is excluded—and competes to write
`(finalRemaining << 24) | seedIndex`. Readback is therefore
two `u32` values per candidate (best result plus position count), not a result
per GPU thread.

Large logical batches are split by candidate and sample ranges and striped
over a private pool of 1–3 resources in the normal profiles (the API permits
up to 4 for tests/overrides). Multiple dispatches can be queued while another
slot is mapping its tiny readback. After the initial feature assist, a bounded
pump keeps one logical batch continuously queued across CPU beam, proof and
exact stages. Completion refreshes the unresolved-root snapshot, replay-
verifies winning seeds in WASM, then queues the successor at a macrotask
boundary. If lane 0 finishes its CPU-owned roots first, it remains a GPU
caretaker while satellite lanes continue, so useful position-wide GPU sampling
does not stop merely because lane 0's root partition finished. Once every
CPU-only peer has posted `settled`, the pool sends a job-scoped `stop-caretaker`
control message; lane 0 stops the pump and posts its own terminal snapshot.
Exact completion, a new job or device failure also stops it. This handshake
prevents the caretaker loop from keeping counters and elapsed time alive after
all CPU peers have reached their terminal state.

Optional timestamp queries measure actual compute-pass time. They are never a
requirement: device creation retries without the feature and telemetry falls
back to the union of dispatch wall intervals, so striped submissions do not
double-count overlapping waits. The exact GPU position counter, completed
playouts, dispatch count and active time feed the hardware telemetry row. The
main GPU `pos/s` is its effective contribution over analysis wall time; the
detail row separately reports active-kernel `pos/s` and dispatch duty cycle.

### Heuristic board-feature kernel

The second GPU kernel scans up to 4096 second-ply boards and returns remaining
cells, color mask/dominant color, dominant count, adjacent equal pairs and
occupied columns. Small batches stay on the CPU when transfer overhead would
dominate (profile thresholds range from 96 boards on discrete GPUs to 256 on
mobile). Three samples—first, middle and last—are checked against the exact JS
twin. A feature mismatch disables only this optional ranking kernel and uses
the CPU twin; it cannot affect correctness. Section 4 describes how WASM
completes and fully replays candidates selected by these heuristic features.

### Trust and failure behavior

At startup, a 64-seed self-test must match the CPU/WASM twin. Every winning
playout seed is then replayed by `playoutVerify`; only a matching replay can
update a root line. A playout mismatch disables WebGPU for the session. The
device-loss promise also rejects queued slot waiters and causes the worker to
destroy/disable the accelerator. Already-submitted work may finish after a
position changes, but stale results are ignored by analysis id. Before a new
position snapshots its GPU counters, it waits for that bounded old dispatch,
so the old position's work is not charged to the new telemetry row.

When WebGPU is absent, refused or lost, search continues CPU-only with the same
score/proof semantics. GPU output can choose work and provide replayable
witness candidates; it is never trusted as an exact value or proof.

## 8. Worker protocol

```
UI → pool       {type:"analyze", id, board}      // Uint8Array(144), col-major, cell = col*12+row
pool → lane     {type:"analyze", id, board, lane, lanes, gpu}
pool → lane     {type:"merge", id, seeds}        // merged lines/proofs; replay-validated in WASM
pool → lane     {type:"threshold-plan", id, epoch, target, roots}
pool → lane     {type:"threshold-frontier", id, epoch, target, round, tasks}
lane → pool     {type:"threshold-prefix-split", ..., rootCell, prefix, children}
lane → pool     {type:"threshold-prefix-miss", ..., rootCell, prefix}
pool → lane     {type:"threshold-root-bound" | "threshold-cancel", ...}
pool → lane 0   {type:"stop-caretaker", id}      // CPU-only peers settled; stop the GPU pump
pool → UI       {type:"ready", gpu, workers}      // gpu = "on" | "off" | "failed"
                {type:"result", id, remaining, moves, stats}
                {type:"error", message}
```

`moves` is the full sorted list (best first, ties to larger groups):
`{k, cell, x, y, color(1-5), size, score, lower, exact, cells:[[x,y]…], line:[cell…]}`
where `k` is the WASM enumeration index expected by `playoutRoot`/
`exactBeginChild`/`childToIO`. Merged `stats` contains the legacy CPU aliases
`nodes` and `nps`, search `depth`/`width`/`elapsed`, `totalPositions`/`totalPps`,
`gpu`, `settled`, `state`,
the proof fields, and these processor-specific counters:

```
cpu: {
  workers, positions, pps,
  beamPositions, exactPositions, playoutPositions, playouts
}
gpuStats: {
  positions, pps, activePps, duty, playouts, batches, activeMs,
  profile, adapter
}
```

CPU `positions` is the sum of beam children considered, exact nodes expanded
and non-terminal boards expanded by CPU playouts across lanes. `playouts` is the
number of completed CPU samples, not another position count. GPU `positions`
uses the same per-playout expansion definition, plus feature
boards ranked on GPU; `batches` includes completed playout and feature
dispatches. CPU `pps`, GPU `pps` and `totalPps` are totals divided by merged
analysis wall time; stopped workers therefore cannot leave stale rates in the
display. `activePps` divides GPU work by dispatch-active time and `duty` is the
active/wall percentage. Positions are exact work visits, but are not unique
states: separate worker memories can revisit transpositions. These are no
longer estimates derived from the former rough `nodes += 32` accounting.

`positionUpper` is the minimum root score. `positionLower` is the minimum of
each exact row's score and each unresolved row's admissible `lower`; equality
sets `positionExact`.
`allMovesExact` is true only when every row is exact. Accordingly, `state` is
`"analyzing"` without a global proof, `"optimal"` when the position optimum is
proved or an all-exact table is completing its final lane snapshots,
`"proven"` when every move is proved and every lane has stopped, and
`"settled"` when an unproved search stops on stagnation. `settled` is an
independent indication that compute has stopped, so it may become true while
`state` remains `"optimal"`. The pool latches the first terminal snapshot and
ignores any queued same-position result. The UI ignores
any result whose `id` differs from the current position id; lanes and the pool
apply the same stale-id rule. Ids increase on
every real position change (identical re-posts are deduped by board key, so
rewind→same-board does not restart analysis needlessly).

The result-buffer byte layout WASM→JS is documented at `collect()` in
`asm/engine.ts` and parsed in `worker.js::collectResults()` — keep the two
in sync.

## 9. UI

* **Button** `#engineButton` (in `index.html`, bound in `main.js`): inline
  SVG — accent-blue disc, white CPU-chip glyph, hover swaps to the orange
  accent like every other control; toggled-on state adds a blue ring. The
  play-time lockout rule in `click2026.css` (`#control.disabled …`)
  deliberately exempts the engine button and panel so analysis can be
  toggled and read **while playing**.
* **Settings** `#settingsDialog`: the footer status-bar button immediately
  before `examples & tests` opens persisted presentation preferences. The
  moves slider defaults to shown on mobile platforms and hidden on desktop;
  the explicit **Show** checkbox overrides that platform default. Suggested
  moves can show **Top 5** (default), **Top 5 and first non-zero**, or **All**.
  The middle mode adds the first positive-score move only when the top five
  are all zero, so it contains at most six rows.
* **Moves slider** `#movesSlider`: located immediately below the board and
  above **NEW GAME**. It tracks the current/maximum move and navigates the
  selected replay route continuously. Using it has the same official-time
  consequence as rewind, tree, or other non-board controls.
* **List** `#engineList` (rendered by `engine-ui.js`): 5, up to 6, or all rows
  according to the setting —
  hollow *rank swatch* in the rank color, filled square in the *block color*
  of the group to click, the score (`0 ★` = clears), `×size`, and ✓ when
  proven. Hovering a row emphasizes that group on the board and dims the
  other outlines; **clicking a row plays that move** through the normal game
  flow (including the first-click game start), indistinguishable from a
  board click for the recording. Rows are only rebuilt when their content
  changes, so a click can never land on a row that was just swapped out by
  a telemetry update.
* **Three-row telemetry** `#engineStatus`: the overview row shows state
  (`analyzing…` / `optimal ✓` / `proven ✓` / `settled`),
  combined wall-average throughput, combined positions and elapsed analysis
  time. Separate,
  vertically aligned CPU and GPU rows attribute rates and exact position totals
  to `CPU×N` and `GPU`. Rate occupies column two and position total occupies
  column three in both processor rows, placing both totals directly under the
  combined total. Column four places each processor's share of evaluated
  positions directly under wall time; the displayed CPU and GPU percentages
  are complementary and therefore always total 100%. Beam/playout counters,
  duty, batches and busy time are kept
  out of the visible panel. They, the selected device profile and adapter
  identity remain available in tooltips without consuming visible telemetry
  space. Tooltips
  and one composed `aria-label` expose the
  unabridged values. The fixed shared grid keeps all three logical rows aligned
  on the 310 px board and iPhone-sized layouts.
* **Board outlines**: each listed group's boundary is stroked in its rank
  color (`RANK_COLORS` in `engine-ui.js` — white, orange, magenta, silver,
  bronze; additional rows in **All** mode use deterministic HSL hues). The
  first five are chosen to clash with neither the five play colors nor the
  replay highlight. The outline path runs through the 2 px gaps between blocks —
  geometry twin of `drawField()`; if the board metrics in `click.js` ever
  change, update `FIELD_PITCH`/`EDGE_*` in `engine-ui.js` too.
* The engine analyzes whatever the board *shows*: the start position before
  the first click (plan the opening!), the live position during play, each
  step during autoplay/rewind — `click.js` notifies `EngineUI` at every
  mutation point and `EngineUI` dedups by board content.

## 10. Build, test, develop

```
npm ci                    # reproducible AssemblyScript + browser tools
npm run build:engine:primary # full-memo SIMD + scalar binaries
npm run build:engine:lanes   # compact-memo SIMD + scalar satellite binaries
npm run build:engine      # build all four WASM variants
npm run test:engine       # build + pool/GPU helpers + full Node engine suite
npm run test:pool         # adaptive selection, partition and merge only
npm run test:gpu          # pure GPU profile/packing/counter helpers only
npm run test:settings     # platform defaults + suggested-move selection
npm run bench:engine      # fixed beam-throughput and exact-proof corpus
npm run bench:engine:hard # deterministic >100 s baseline tails; all-root JSON results
npm run tune:engine       # evaluation weight grid search
npm run serve             # serve repository root at http://localhost:8123/
node tools/engine.e2e.mjs [--shot]   # headless end-to-end against the served game
```

The four committed binaries are each about 16 KB on disk:
`engine.wasm`, `engine-scalar.wasm`, `engine-lane.wasm` and
`engine-lane-scalar.wasm`. A primary worker first tries the SIMD primary and a
satellite first tries the SIMD compact binary; either falls back to its scalar
counterpart. Playing therefore needs no toolchain and remains dependency-free
at runtime.

Serve the **repository root**, not `src`, because module and test URLs are now
root-relative to the repository layout. Root `index.html` immediately replaces
the location with relative `src/index.html`, preserving query parameters and
the hash. This is compatible with a GitHub Pages project served only from its
repository root and also keeps shared game links intact. No server routes,
cross-origin isolation headers or build-time rewriting are required.

The page entry chain and the engine module graph carry the same explicit
`build` query revision (`ENGINE_ASSET_VERSION` in `engine-ui.js`). Bump that
revision in `index.html`, `main.js`, `click.js`, `engine-ui.js`, the worker's
static imports/WASM URL, and the E2E singleton import whenever an engine graph
interface changes. This prevents a long-lived browser cache from linking a
new worker against an older helper module or WASM binary.

Current reference numbers (this machine, 2026-07-13): the deterministic
single-WASM benchmark is ~1.96 M CPU positions/s in both SIMD and scalar
builds (the measured corpus is not dominated by the SIMD-counted operation).
On a hard live browser fixture, the 16-lane pool plus continuous GPU pump
processed 146.3 M CPU and 43.5 M GPU positions—189.8 M total—in 4.7 s. The GPU
completed 135 dispatches, was busy for 4.1 s, and processed 10.7 M positions/s
while active. Easier starts prove in under a second and correctly stop with a
much smaller count. Position counts are workload-specific visits rather than
unique states or hardware instructions, so the meaningful comparisons are
wall time and proof/solution quality on the same board.

The preceding single-core reference was ~1.9–2.0 M considered children/s in
the fixed width-512 beam corpus, versus
~1.68–1.73 M before the hot-path changes. The medium proof corpus has three
clear roots proven directly from bound equality (0 enumeration nodes), a
positive score-1 root proven in ~1.11 M B&B nodes, and a score-3 root in
~0.20 M nodes. Memo-policy line recovery adds no search nodes. Permanent
bounds and sibling cutoffs reduced a deterministic 165-position value corpus
by about 3.9% in nodes in a one-off before/after development run and modestly
reduced its alternating-run median wall time while preserving opening
throughput. The short quality snapshot is
9/10 full boards cleared with mean 0.1 left; the broader 60-board validation
remains 55/60 with mean 0.20. The move-25 temporary-fragmentation regression
is proved clear by the complementary member in about 410k considered children
and 120–130 ms; repeated tuned-policy beams had remained at score 2 beyond
62 M children.

The separate hard harness persists two full midgame boards discovered by a
deterministic seed/depth screen and proves every root, not merely the best
position value. With the pre-change WASM, `played-18-24` proved 0/10 roots in
105 s and `played-15-24` proved only 4/12 in 150 s. The final production build
proved 10/10 in 44.7–48.3 s and 12/12 in 67.0–74.9 s respectively on this
machine: measured lower-bound speedups of >2.17× and >2.00× because both
baselines were still unfinished. Profiling the first case showed 11.0 M VTT
misses in 10 s,
8.94 M occupied-bucket replacements, and only 70 frames reaching their
admissible lower bound. This is why the retained changes target memo capacity,
depth-preferred replacement, broad-root reuse and proof scheduling rather
than another scalar beam-evaluation tweak.

The supplied 144-cell mixed-complexity regression (`v5` payload beginning
`Bp90fq…`) has 27 roots with static lower bound 0. The bounded portfolio
certifies root BD as a clear in 1,461,960 B&B nodes; the deterministic Node
test reaches the global proof in about 1.0–1.7 s and the full headless-
browser workflow reports `optimal ✓` in about 1.4–2.0 s on the development
machine. The old all-row interpretation was still analyzing after 200 s
because a hard
positive alternative could dominate the audit.

The separate 22-root consistency regression (`v5` payload beginning
`Bp-rtMf…`) exposed a different defect: after roughly 60–70 s and more than
500 M aggregate positions, whole-root beams still left FA, CD, HC and KG at
score 1, while entering any of those children exposed a short clearing second
branch. Profiling FA measured about 13 s across three failed width-16384
whole-root passes versus about 0.35 s for its isolated `[60, 1]` prefix. The
virtual-child portfolio now proves all 22 parent rows without a click. Measured
end-to-end times on this machine were approximately 10 s with 16 lanes, 16 s
with 8, 28 s with 4 and 62 s with one lane. The one-lane result is slower
because the finite child portfolios are necessarily serial, but it completes;
the former unbounded heap-starvation tail is gone.

## 11. Limitations and future directions

* **Exact-proof memory is deliberate**: the 2^23 value memo raises the
  primary worker's initial WASM linear memory from about 74 MiB to 178 MiB;
  each 2^20-entry compact satellite is about 46 MiB. The automatic lane/memory
  policy is conservative but necessarily heuristic because browser capability
  values are rounded. Forcing too many workers can create memory pressure. The hard
  corpus showed a sharp cache-capacity cliff at 2^22 entries; a 6.3 M-entry
  three-way experiment saved memory but slowed the 78-cell proof from about
  45 s to 51.5 s. This engine favors the requested worst-case latency on a
  desktop-class machine.
* **Exact tables use 64-bit Zobrist identity**: a hash match is treated as a
  board match. The collision probability is negligible for game analysis but
  not mathematically zero; formal proof certificates would require a second
  independent fingerprint or full-board verification on TT hits. This does
  not apply to pool-coordinated threshold-frontier grouping, which compares
  all 144 board bytes exactly.
* **Beam cross-move reuse is line-level**: the warm-start cache carries
  replayable best lines across positions, while the beam frontier is rebuilt.
  Exact flags transfer only for the same cached board, an actual recorded
  one-ply child, or a proved cached-child composition; a replayable suffix on
  an unrelated board remains an upper bound. Exact VTT values and threshold
  certificates do persist within each worker across positions. True beam
  pondering (searching the expected child while the player thinks) is the next
  step up.
* **Parallelism is mostly root-level**: bounded second- and third-ply virtual
  contexts are distributed across lanes, and the positive threshold solver is
  the exception that redistributes a pool-coordinated, exact-board-deduplicated
  fixed-prefix frontier. Long-lived value/private work remains root-owned.
  Each WASM instance is single-threaded and the pool caps itself at sixteen
  lanes. Immediate baselines and private tables are duplicated; a hard
  depth-three threshold task remains on its stable lane and there is no
  mid-round work stealing. Sharing a live DFS stack or transposition table
  would require synchronization and, for shared memory, cross-origin isolation
  that ordinary GitHub Pages does not provide.
* **Permanent reachability remains conservative**: the future-touch graph is
  an over-approximation, so connected cells may still be impossible to join.
  Exact column-slab canonicalization is sound at proven interaction-free cuts
  and reduced targeted node counts, but its repeated cut scan did not reduce
  mixed-corpus wall time and was deliberately not retained.
* **Symmetry canonicalization is unexploited**: color renaming and reversal of
  the contiguous occupied columns preserve exact value. They may improve VTT
  reuse, but normalization overhead and mirrored policy coordinates should be
  instrumented before adding them to the exact hot path.
* **Beam eval is still local**: the permanent-only member removes one scalar
  blind spot, but neither policy models which color to farm. A color-plan
  feature (dominant-color connectivity potential) remains promising.
* **GPU scope is still heuristic acceleration**: playouts and second-ply
  feature ranking use WebGPU, while beam and exact expansion remain on CPU.
  Wide GPUs need enough roots/samples to amortize submission and divergent
  flood-fill work; late positions naturally under-utilize them. Layer-parallel
  beam/exact expansion is possible but remains a research project.
* **Telemetry rates are workload-specific**: CPU positions include beam,
  exact and CPU-playout work; GPU positions include playout states and feature
  boards, with GPU rate measured over active device time. They answer “is this
  processor doing work?” but are not directly comparable instructions/s.
* The in-app "Run tests…" dialog runs synchronous tests only; engine tests
  live in Node (`npm run test:engine`) to keep the dialog untouched.
* UI ideas: preview a row's whole line move-by-move on long-press; a
  strength limiter; an "auto-pilot" that plays the top suggestion.
