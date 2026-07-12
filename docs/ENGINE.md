# Click2026 Analysis Engine

A chess-engine-style analysis assistant for the Click2026 puzzle: while the
player plays, it continuously searches the current position in a background
worker and shows the five most promising moves, each scored by the fewest
blocks it is known to leave on the board. The search core is WebAssembly
(compiled from AssemblyScript), with an optional WebGPU compute path that runs
tens of thousands of Monte-Carlo playouts per batch.

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
main thread                      worker (engine/worker.js)
────────────────────             ─────────────────────────────────────────
click.js  ──positions──►  engine-ui.js ──{analyze,id,board}──►  scheduler
   ▲                          ▲                                    │
   │ drawOverlays(ctx)        └──────{result,id,moves,stats}◄──────┤
   │ (rank outlines)                                               ▼
canvas + engineList                                    engine.wasm (search core)
                                                       gpu.js (WebGPU playouts)
```

| File | Role |
| --- | --- |
| `asm/engine.ts` | AssemblyScript search core → `src/scripts/engine/engine.wasm` |
| `src/scripts/engine/worker.js` | anytime scheduler, protocol, GPU orchestration |
| `src/scripts/engine/schedule.js` | pure, unit-tested stagnation/settlement state transitions |
| `src/scripts/engine/gpu.js` | WebGPU playout kernel (WGSL) + JS twin helpers |
| `src/scripts/engine-ui.js` | button state, move list, canvas outlines |
| `src/scripts/click.js` | position change notifications, redraw hook |
| `tools/engine.test.mjs` | Node proof of rule equivalence + search validity |
| `tools/engine.tune.mjs` | evaluation weight tuning harness |
| `tools/engine.e2e.mjs` | headless-browser end-to-end check |

The rules are implemented **twice by design** (JS `board.js` for the game,
AssemblyScript for speed) and once more in WGSL. The Node test suite replays
random games move-by-move through both CPU implementations and requires
bit-identical boards; the GPU twin is checked at runtime (Section 7). If you
change any rule, change all three and let the tests arbitrate.

### Score semantics (important)

A move's score is **the number of blocks left after the best line the engine
has found so far starting with that move** — an *achievable upper bound* on
the true optimum, never a guess. Internally every root move stores its best
line; the Node suite replays those lines through `board.js` and fails if a
claimed score does not reproduce. `0 ★` means a full clear is in hand; `✓`
means the score is proved optimal, either by equality with an admissible bound
or by exact search. Scores only ever improve (decrease) while the engine keeps
thinking, exactly like a chess engine deepening.

## 4. Search pipeline (per position)

Implemented in `worker.js::analyze()`; every stage refines the same per-root
result table inside the WASM module and posts a snapshot to the UI:

0. **Warm start** (`seedFromMemory` → `seedLine`/`seedExactByCell`): the
   worker keeps an LRU cache (64 positions) of every move list it has
   posted. A new analysis is seeded with the cached lines of its own
   position plus the *suffixes* of the previous position's lines — after the
   player plays move `m`, the rest of `m`'s line is by construction a line
   of the new position. For rewind/general transposition reuse it also
   materializes each one-ply child; if that child board is cached, its line is
   prepended with the creating root move. Every seed is replay-validated
   inside WASM before being merged (wrong guesses are rejected, never
   trusted), and cached
   proof flags are restored when the seeded score matches. Consequence:
   playing a suggested `0 ★` move can never make the engine "lose" the
   clearing line, and revisiting a position (rewind) restores everything
   it ever knew about it instantly.
1. **Greedy baselines** (`setBoard`): for each legal move, a
   largest-group-first rollout. Instant (~15 ms for 144 cells), guarantees
   every root has a real score before anything else is shown. Each root child
   also gets an admissible permanent-cell lower bound; a baseline that meets
   it is proven immediately.
2. **CPU playout portfolio**: 32 hard-tabu random playouts plus 4
   full-support soft-tabu playouts per unproven root (`playoutRoot` and
   `playoutRootSoft`). The original high-quality policy is preserved; the
   supplement removes its zero-probability blind spot.
3. **Iterative-widening beam search**: deterministic passes with widths
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
   On positions with at most 72 cells whose current best is at most 5, after
   width 512 and before width 2048, the leading two zero-lower-bound roots
   also receive one root-private
   width-8192 **permanent-only portfolio** pass. It ranks only by cells
   remaining plus proved-permanent cells. This bounded orthogonal objective
   preserves corridors that temporarily accumulate fragments/frozen colors
   immediately before a gravity merge, instead of asking random noise to
   overcome the same scalar bias in every beam.
4. **Continuous investigation** — ends in exactly three ways: a new
   position arrives, every move is **proven**, or the search is **settled**
   (stagnant at the top of the width ladder on a board too large to
   enumerate) — never by an arbitrary timer:
   * **bigger-group priority**: moves whose group is *larger* than the best-
     scoring move's group but whose score has not yet matched it
      ("hopefuls") get first claim on locked passes and playout samples.
      Exact work stays score-first (and therefore size-first on equal scores)
      so a worse large group cannot monopolize its single retained frontier.
      Rationale: the rating is time-based, and equal outcomes through
     bigger groups need fewer clicks — when the player sees a `0 ★` on a
     2-group, the engine actively investigates whether the big group
     clears too (ties already rank bigger groups first);
   * alternating passes: odd passes are **root-locked** — the whole beam
     explores one subtree, with that root's private width escalating
     2048 → 4096 → 8192 → 16384 and its own attempt-seed stream (hopefuls
     first, then the unproven top 5). Even passes search globally with an
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
   * the **exact-proof ladder** (Section 6): full speed once
     `remaining ≤ 56`, and four chunks (half the full quantum) per cycle up to
     `remaining ≤ 88`. It first tries a 2 M-node incumbent-driven branch and
     bound; if that exhausts, it falls back to the persistent exact-value
     memo. Value retries retain both the DFS frontier and completed entries.
     Per-attempt budgets escalate ×4 up to the WASM-safe i32 limit, while
     total progress remains unbounded. A finished proof marks the row ✓.
   Terminal states: **`proven ✓`** — all moves proven, nothing can change,
   compute stops. **`settled`** — 24 completed, unchanged *global*
   width-16384 passes on a board above the proving gate, after the private
   max-width audit described above; locked and submaximal passes do not
   consume that budget. The engine stops honestly instead of cycling. Below
   the gate it never settles:
   proofs always land eventually. Scores are maintained as monotone minima,
   so the top list only ever gets more reliable with time; any player move
   restarts analysis on the new position (stale results discarded by id).

### Interactivity

The worker runs search in ~10 ms WASM slices (`beamStep(16000)`) and yields
through a `MessageChannel` macrotask between slices, so a new `analyze`
message preempts within milliseconds. Results are posted at most every
150 ms plus once per completed stage.

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
* each beam node carries its remaining count. With nonnegative evaluation
  weights, `childRemaining` is a cheap evaluation lower bound; once the heap
  is full, children that cannot enter it or improve a terminal root score are
  rejected before board copy/removal/evaluation.

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
* transposition table: 2^20 entries in four-way buckets, keyed by Zobrist
  hash (replacement can cause re-expansion but never an invalid prune);
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
  target was already proven by the value solver, so a second proof is waste.

### Value solver (`vsBegin` / `vsStep` / `vsBuildLine`)

The B&B solvers prune by bound, which makes their transposition entries
context-dependent — fine for one proof, wasteful for many. The **value
solver** instead computes context-free minimax values with memoization. A
frame normally evaluates every child, but finalizes early when a resolved
child reaches that board's admissible lower bound: no remaining child can do
better, so the stored value is still exact. Values and a best move are stored
in a persistent, four-way 2^21-entry memo (`VTT`). Entries are shared

* across root moves and budget escalations,
* across later analysis positions in the same worker — playing a move turns
  the new board into a previously searched descendant,
* with a retained DFS frontier on budget exhaustion, so a retry continues
  the unfinished branch rather than walking down to it again.

The policy move stored with each value lets `vsBuildLine` reconstruct an
optimal line in roughly one lookup per move. Table replacement is detected;
`exactChildSeek` is the safe fallback. The live ladder tries a 2 M-node B&B
first because a good constructive incumbent often makes it orders of
magnitude cheaper than full values, then uses VTT only after that attempt
exhausts.

Once one sibling has exact value `m`, another child whose sound lower bound
is already `≥ m` is skipped before board copy. A stronger post-materialization
check supplies a second cutoff. Skipped children are never memoized as exact;
the parent remains exact because they cannot improve its resolved minimum.
Root separator bounds propagate monotonically. Recomputing the geometric
fixed point at every node reduced nodes but increased time, so it is refreshed
only once when a path first enters the final eight cells.

The gates: full-speed proving at `remaining ≤ 56`, a half-quantum background
run (four chunks per cycle) up to `remaining ≤ 88`. For the heuristic beams above
that, a global seen-set is deliberately NOT used: stochastic passes revisit
states *on purpose* with different noise and beam context — blocking
revisits would break diversification, and no memory could come close to
covering the ~10^60 opening space anyway. Below the gate, enumeration wins;
above it, diversification does — and when even max-width diversification
stops producing changes, the engine settles instead of cycling (Section 4).

Verified against exhaustive JS brute force on hundreds of small boards in
the test suite — root optima, per-child B&B proofs and per-child value
solves (plus a wasm-vs-wasm cross-check of the two solvers on 32-cell
boards), including line replayability throughout.

## 7. WebGPU playout accelerator

`gpu.js` runs the hard-tabu member of the WASM playout portfolio identically,
one thread per playout and one dispatch row per candidate move (≤ 72 children ×
512–1024 playouts per batch):

* WGSL kernel = line-by-line twin of `playoutRun()` in `asm/engine.ts`:
  same xorshift128 RNG (32-bit only — WGSL has no u64), same ascending-cell
  enumeration, same tabu rule (dominant color, ties to the lower id), same
  collapse. Boards travel packed 4 cells/u32; each thread reports
  `atomicMin(finalRemaining << 24 | seedIndex)` per child — 4 bytes per
  candidate, no per-thread readback.
* **Trust nothing:** the winning seed is replayed on the CPU core
  (`playoutVerify`) and adopted only if the final matches exactly. At
  startup a 64-seed self-test must reproduce bit-exactly; any mismatch at
  any point disables the GPU path permanently for the session (status shows
  `CPU (GPU failed)`). GPU results can therefore make the engine faster but
  never wrong.
* Because a playout's whole move line is determined by its seed, the GPU
  only ever needs to return 32 bits per candidate — the CPU reconstructs the
  line from the seed when it improves a score.
* A batch is submitted before its corresponding CPU beam. WASM expands the
  beam and runs the soft-policy supplement while the device computes, then
  drains the one in-flight readback before another submission. On the
  development machine, controlled beam+GPU pairs took 24–41% less combined
  wall time than sequential execution. The browser is asked for its
  high-performance adapter (the browser retains the final choice). A stale
  position releases the CPU immediately while its already-submitted batch
  finishes; the next position skips GPU submission until the shared buffers
  are free.
* WGSL gotchas encountered: `move` and `target` are reserved words; comments
  inside the JS template literal must not contain backticks.

Verified live in headless Chrome (status `CPU+GPU`, self-test passing).
When WebGPU is unavailable (Firefox without flag, file://, old drivers) the
engine silently runs CPU-only — same results, fewer playouts per second.

## 8. Worker protocol

```
main → worker   {type:"analyze", id, board}      // Uint8Array(144), col-major, cell = col*12+row
worker → main   {type:"ready", gpu}              // "on" | "off" | "failed"
                {type:"result", id, remaining, moves, stats}
                {type:"error", message}
```

`moves` is the full sorted list (best first, ties to larger groups):
`{k, cell, x, y, color(1-5), size, score, exact, cells:[[x,y]…], line:[cell…]}`
where `k` is the WASM enumeration index expected by `playoutRoot`/
`exactBeginChild`/`childToIO`. `stats`:
`{nodes, depth, width, elapsed, nps, gpu, settled, state}` — `state` is
`"analyzing"` while running, `"proven"` when every move is proven optimal,
`"settled"` when the search stopped on stagnation (both terminal states also
set `settled: true`). The UI ignores
any result whose `id` differs from the current position id; ids increase on
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
* **List** `#engineList` (rendered by `engine-ui.js`): up to 5 rows —
  hollow *rank swatch* in the rank color, filled square in the *block color*
  of the group to click, the score (`0 ★` = clears), `×size`, and ✓ when
  proven. Hovering a row emphasizes that group on the board and dims the
  other outlines; **clicking a row plays that move** through the normal game
  flow (including the first-click game start), indistinguishable from a
  board click for the recording. Rows are only rebuilt when their content
  changes, so a click can never land on a row that was just swapped out by
  a telemetry update. The status line beneath is five fixed-width columns
  that never wrap: state (`analyzing…` / `proven ✓` / `settled`),
  `w<width> d<depth>`, nodes, nodes/s, and the compute backend.
* **Board outlines**: each listed group's boundary is stroked in its rank
  color (`RANK_COLORS` in `engine-ui.js` — white, orange, magenta, silver,
  bronze; chosen to clash with neither the five play colors nor the replay
  highlight). The outline path runs through the 2 px gaps between blocks —
  geometry twin of `drawField()`; if the board metrics in `click.js` ever
  change, update `FIELD_PITCH`/`EDGE_*` in `engine-ui.js` too.
* The engine analyzes whatever the board *shows*: the start position before
  the first click (plan the opening!), the live position during play, each
  step during autoplay/rewind — `click.js` notifies `EngineUI` at every
  mutation point and `EngineUI` dedups by board content.

## 10. Build, test, develop

```
npm ci                    # reproducible AssemblyScript + browser tools
npm run build:engine      # asm/engine.ts → src/scripts/engine/engine.wasm
npm run test:engine       # build + full Node suite (rules, search, exact, bench)
npm run bench:engine      # fixed beam-throughput and exact-proof corpus
npm run tune:engine       # evaluation weight grid search
npm run serve             # http://localhost:8123 (any static server works)
node tools/engine.e2e.mjs [--shot]   # headless end-to-end against the served game
```

The compiled `engine.wasm` (~14 KB) is committed, so *playing* needs no
toolchain — only engine development does. The game itself remains
dependency-free at runtime.

Current reference numbers (this machine, single core, 2026-07-12):
~1.9–2.0 M considered children/s in the fixed width-512 beam corpus, versus
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

## 11. Limitations and future directions

* **Exact tables use 64-bit Zobrist identity**: a hash match is treated as a
  board match. The collision probability is negligible for game analysis but
  not mathematically zero; formal proof certificates would require a second
  independent fingerprint or full-board verification on TT hits.
* **Beam cross-move reuse is line-level**: the warm-start cache carries best
  lines and proofs across positions, while the beam frontier is rebuilt.
  Exact VTT values do persist across positions. True beam pondering
  (searching the expected child while the player thinks) is the next step up.
* **Single-threaded WASM**: SharedArrayBuffer + N worker beams (different
  noise seeds) would scale nearly linearly, at the cost of COOP/COEP
  headers.
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
* **GPU scope remains narrow**: playouts now overlap CPU beams, but beam and
  exact expansion themselves remain single-threaded WASM. Layer-parallel GPU
  expansion is possible, though divergent flood fills make it a research
  project.
* The in-app "Run tests…" dialog runs synchronous tests only; engine tests
  live in Node (`npm run test:engine`) to keep the dialog untouched.
* UI ideas: preview a row's whole line move-by-move on long-press; a
  strength limiter; an "auto-pilot" that plays the top suggestion.
