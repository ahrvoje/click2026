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
  **NP-complete** even for 2 colors and 5 columns (Biedl et al., 2002).
  Exhaustive search of a 144-cell, 5-color start is hopeless: branching is
  20–35 near the start and the state space is astronomically large. An
  engine must therefore be *heuristic and anytime* — but it can still be
  **exact on small endgames** (Section 6) and *honest* everywhere: every
  score it reports is backed by a concrete line it actually found
  (see "Score semantics" below).
* A color reduced to exactly **one cell** can never be removed (counts never
  grow), so it is a permanent +1 on the final result. This is both the core
  of the evaluation and an admissible lower bound for the exact solver.

## 2. Strategy and tactics (what the engine — and a human — should do)

1. **Preserve the glue.** The most frequent color forms the connectivity
   backbone. Removing it early splinters the board into color islands.
   Playing the *other* colors first lets gravity merge the dominant color
   into one huge group that is removed late, often clearing whole regions.
   The engine's playout policy ("tabu color") encodes exactly this: random
   playouts never click the dominant color while any alternative exists.
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
means the exact solver *proved* the score optimal. Scores only ever improve
(decrease) while the engine keeps thinking, exactly like a chess engine
deepening.

## 4. Search pipeline (per position)

Implemented in `worker.js::analyze()`; every stage refines the same per-root
result table inside the WASM module and posts a snapshot to the UI:

0. **Warm start** (`seedFromMemory` → `seedLine`/`seedExactByCell`): the
   worker keeps an LRU cache (64 positions) of every move list it has
   posted. A new analysis is seeded with the cached lines of its own
   position plus the *suffixes* of the previous position's lines — after the
   player plays move `m`, the rest of `m`'s line is by construction a line
   of the new position. Every seed is replay-validated inside WASM before
   being merged (wrong guesses are rejected, never trusted), and cached
   proof flags are restored when the seeded score matches. Consequence:
   playing a suggested `0 ★` move can never make the engine "lose" the
   clearing line, and revisiting a position (rewind) restores everything
   it ever knew about it instantly.
1. **Greedy baselines** (`setBoard`): for each legal move, a
   largest-group-first rollout. Instant (~15 ms for 144 cells), guarantees
   every root has a real score before anything else is shown.
2. **CPU playout round**: 32 tabu-color random playouts per root
   (`playoutRoot`). Cheap variance reduction before the beams start.
3. **Iterative-widening beam search**: deterministic passes with widths
   8 → 32 → 128 → 512 → 2048. Each pass expands layer by layer (layer *d* =
   boards after *d* moves), keeps the best `width` children per layer by
   evaluation (replace-max heap), dedups transpositions inside a layer via
   64-bit Zobrist hashes, and reports every terminal reached. Root moves are
   *all* kept in layer 1 regardless of width, so every move keeps improving.
   A pass over a full board costs roughly `width × 60 layers × 25 children`
   evaluations; at the measured ~1.8 M evals/s the width-512 pass takes
   ~120 ms, width-2048 ~0.5 s.
4. **Continuous investigation** — ends in exactly three ways: a new
   position arrives, every move is **proven**, or the search is **settled**
   (stagnant at the top of the width ladder on a board too large to
   enumerate) — never by an arbitrary timer:
   * **bigger-group priority**: moves whose group is *larger* than the best-
     scoring move's group but whose score has not yet matched it
     ("hopefuls") get first claim on locked passes, playout samples and
     proofs. Rationale: the rating is time-based, and equal outcomes through
     bigger groups need fewer clicks — when the player sees a `0 ★` on a
     2-group, the engine actively investigates whether the big group
     clears too (ties already rank bigger groups first);
   * alternating passes: odd passes are **root-locked** — the whole beam
     (width 2048) explores the subtree of a single candidate (hopefuls
     first, then the unproven top 5); even passes search globally.
     Deterministic per-board evaluation noise seeded by the pass number
     makes every pass explore a different corridor;
   * **stagnation escalates width**: global passes start at 512 and climb
     512 → 1024 → … → 16384 as passes go by without any score or proof
     changing (any change resets the ladder). Wider beams are genuinely
     deeper searches, so stagnation buys exploration instead of repetition;
   * every 2nd pass a playout round biased to the displayed moves and the
     hopefuls (GPU batch of 1024/root when available, else CPU 48 playouts
     for the prioritized moves, 8 for the rest);
   * the **exact-proof ladder** (Section 6): full speed once
     `remaining ≤ 56`, and a background trickle (one chunk per cycle) up to
     `remaining ≤ 88` — the memo keeps every explored state either way, so
     this is monotone, never-repeated work. Budgets start at 8 M expansions
     and escalate ×4 without a cap; a retry resumes at the old frontier.
     A finished proof marks the row ✓ (and often improves its score via a
     bound-directed line seek).
   Terminal states: **`proven ✓`** — all moves proven, nothing can change,
   compute stops. **`settled`** — nothing improved for 24 consecutive
   passes *at maximum width* on a board above the proving gate; the engine
   stops honestly instead of cycling. Below the gate it never settles:
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
      + W_DEAD   · #{colors with exactly 1 cell left}     // stuck forever
      + W_SINGLE · #{size-1 components of live colors}    // probable leftovers
      + W_FRAG   · Σ_colors max(0, components − 1)        // fragmentation
      + W_FROZEN · #{cells of frozen colors}              // hopeless-color mass
      (+ deterministic noise in stochastic passes)
```

Lower is better. `remaining` rewards progress, the penalties encode
Section 2. A **frozen** color has ≥ 2 cells but no playable pair anywhere on
the board — only a lucky gravity merge can save those cells, so each one is
a probable leftover (`W_FROZEN 0.5`, tuned: 48/60 clears vs 46/60 without).
Note the asymmetry with the exact solver: frozen cells are *usually* lost
but not provably (columns can still close and merge them), so this feature
may only bias the heuristic search — the exact solver's lower bound uses
dead colors only, which is admissible. The same scan also yields the
Zobrist hash and terminality for free.

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

## 6. Exact solver

Budgeted branch & bound DFS (`exactBegin`/`exactStep`/`exactMerge`):

* upper bound: best line already known from the beams (start value);
* lower bound (admissible): number of colors with exactly one cell —
  subtrees whose bound reaches the incumbent are cut;
* transposition table: 2^20-entry visited set keyed by Zobrist hash
  (a fully explored board never re-explores; sound for minimization because
  the incumbent only decreases);
* explicit stack, budget-limited and resumable in chunks, so it never
  blocks the worker loop; budgets escalate ×4 per retry without a cap.

Entry points sharing the machinery:

* `exactBegin` — B&B solve of the analysis root (used by the tests as
  ground truth against brute force);
* `exactBeginChild(k)` / `exactMergeChild(k)` — B&B solve of the position
  *after* root move `k`, seeded with that move's best-known line as the
  upper bound;
* `exactChildSeek(k, budget, target)` — like the child solve but with a
  *known* target value: everything that cannot reach `target` is pruned,
  which makes recovering the optimal line after a value solve cheap.

### Value solver (`vsBegin` / `vsStep`) — the anti-cycling memo

The B&B solvers prune by bound, which makes their transposition entries
context-dependent — fine for one proof, wasteful for many. The **value
solver** instead runs a *full enumeration with memoization*: no alpha
pruning, every reached board's exact value is stored in a persistent
2^21-entry memo (`VTT`). Because entries are context-free they are shared

* across the root moves of one position (sibling subtrees overlap almost
  entirely — proving all ~20 endgame moves costs little more than one),
* across budget escalations (a retry replays memo hits and continues at the
  old frontier — work is never repeated),

which is precisely the "record of positions already analysed" that stops
the engine from cycling over a small board. The worker's ladder drives it
value-first: `vsBegin(k)` → proven value → flag directly when the known
line already achieves it, else `exactChildSeek` recovers the optimal line
(keeping every displayed score replayable).

The gates: full-speed proving at `remaining ≤ 56`, a background trickle
(one chunk per cycle) up to `remaining ≤ 88`. For the heuristic beams above
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

`gpu.js` runs the *identical* tabu-color playout as the WASM core, one
thread per playout, one dispatch row per candidate move (≤ 72 children ×
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
npm install               # once: AssemblyScript + puppeteer-core (dev only)
npm run build:engine      # asm/engine.ts → src/scripts/engine/engine.wasm
npm run test:engine       # build + full Node suite (rules, search, exact, bench)
npm run tune:engine       # evaluation weight grid search
npm run serve             # http://localhost:8123 (any static server works)
node tools/engine.e2e.mjs [--shot]   # headless end-to-end against the served game
```

The compiled `engine.wasm` (~8 KB) is committed, so *playing* needs no
toolchain — only engine development does. The game itself remains
dependency-free at runtime.

Current reference numbers (this machine, single core, 2026-07-11):
~1.8 M child evaluations/s in the beam; width-512 pass over a full board in
~120 ms; full widening schedule ~180 ms/board; 55/60 random boards cleared
with mean 0.20 remaining under the short validation schedule (the live
engine searches much deeper); example boards 1 and 3 solved to 0 within
~0.4 M nodes.

## 11. Limitations and future directions

* **Cross-move reuse is line-level, not tree-level**: the warm-start cache
  carries best lines and proofs across positions, but the beam's explored
  frontier is rebuilt. True pondering (searching the expected child while
  the player thinks) is the next step up.
* **Single-threaded WASM**: SharedArrayBuffer + N worker beams (different
  noise seeds) would scale nearly linearly, at the cost of COOP/COEP
  headers.
* **Exact lower bound is weak** (dead colors only — the sound subset of the
  hopeless-node ideas): a connectivity-aware bound (colors whose components
  can never touch under *any* gravity future) would let the solver reach
  40+ cells, but proving "can never touch" soundly is the hard part —
  unsound shortcuts would corrupt the ✓ flags. The heuristic side already
  uses the unsound-but-useful version (frozen colors, Section 5).
* **Beam eval is local**: no notion of "which color to farm" beyond
  fragmentation penalties; a color-plan feature (dominant-color
  connectivity potential) is the most promising strength gain.
* **GPU underused**: only playouts run there. Layer-parallel beam expansion
  is possible but the divergent flood fills make it a research project.
* The in-app "Run tests…" dialog runs synchronous tests only; engine tests
  live in Node (`npm run test:engine`) to keep the dialog untouched.
* UI ideas: preview a row's whole line move-by-move on long-press; a
  strength limiter; an "auto-pilot" that plays the top suggestion.
