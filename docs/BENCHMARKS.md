# Engine Benchmarks

Standardized proof-cost benchmark suite. Run after any notable engine change
to confirm it is an improvement (or at least not a regression) on the
critical positions that drove engine development. New cases are appended as
they are discovered — never edit or remove existing ones, so results stay
comparable across the whole history.

## Protocol

1. Serve the repo root (e.g. `python -m http.server 8123` from the repo
   root — the URLs below assume port 8123).
2. Open the case URL. The game loads; skip directly to the listed move.
3. Let the engine run until **all moves are proven**.
4. Record the total node evaluations (B = billions) in the results log.

Notes:

* Metric is **node evaluations to prove all moves** — lower is better.
* Record results on otherwise idle hardware; note the machine if it differs
  from the baseline machine.
* Node counts are not perfectly deterministic (worker pool scheduling), so
  run a case twice if the first result looks surprising.

## Regression criteria (defaults, adjust with experience)

* **Regression**: any single case worsens by more than ~10%, or the
  geometric mean across all cases worsens by more than ~5%.
* **Improvement**: geometric mean improves with no case worsening beyond
  noise.
* A change that greatly improves some cases but clearly regresses another
  needs an explicit judgment call — document it next to the result.

## Cases

### Case 1 — move 16. DA

Skip directly to move **16. DA**, prove all moves.

`http://localhost:8123/src/index.html?v=5&g=HiWNJZ0UbRWrNHXeM_9Nk1GCPcnQSAdk3UCB4y2AJViaFwTjNCr1Q05l30lgA6DhcBzUSA3D-t2S2kwAyuqfxN7QEjf3aK6ys9QD`

Baseline: **14.6B** node evals.

### Case 2 — move 12. KG

Skip directly to move **12. KG**, prove all moves.

`http://localhost:8123/src/index.html?v=5&g=BggvYmg7ufo_KzYV68DUMrhPb9fhFnlKi4yhr4kI5fcxijgmKvlF1Nbc7hTZip4HR6Z96ni5scAaI3PRs44y-McBXg022Aq`

Baseline: **31.3B** node evals.

### Case 3 — move 22. EA

Skip directly to move **22. EA**, prove all moves.

`http://localhost:8123/?v=5&g=BanJkAhMlxgvWGHOJNM7B0JS-20PRwJU6AfudCmzcF3cYlDaHIhRydZ8xoRe7e3Hxd2HzIMOEa_X26eg_wQQA5waAY4ZYkm_Oa-pX8KVh3Xa73NcBt2VpwT9tkxjGcluEc34dyGau_uyeWIs6ESM-bdaaxMfG3CKk8PUIEmUrQawuUVtAd8Xp98UWFLIIJuKpFkoL6sMzQGB_h0mSn9`

Baseline: **20.2B** node evals.

### Case 4 — move 21. HB

Skip directly to move **21. HB**, prove all moves.

`http://localhost:8123/src/index.html?v=5&g=BVuawm6QANl15saOTJCVlpE4Zs1AuneUovSM4gfWxIvrYUVyjCkUECAtA10okFa0q0zOMfXjCAs96xrX_Z2g8v-Roo9WWfAO-FlcmyTf63YaI_9dF0LATkCA-Wrur9RVULmQRGMgv0watCs8PSF_ondkg7GXiiuAFSxL6F5nTX_IpVcCtNnwRf0qJm_syxiG1`

Baseline: **247B** node evals.

## Results log

One row per benchmark run. Append newest at the bottom.

| Date       | Commit    | Change under test        | Case 1 | Case 2 | Case 3 | Case 4 | Verdict  |
|------------|-----------|--------------------------|-------:|-------:|-------:|-------:|----------|
| 2026-07-16 | `bbe6921` | baseline                 |  14.6B |  31.3B |  20.2B |   247B | baseline |

## Category: initial run (100 random initial positions)

Distribution check complementing the individual critical cases above: prove
all moves of 100 random **full-board initial positions** and compare the
sorted node-count distribution by quarters.

Run with the automated harness (self-serves the repo, drives headless
Chrome, records exact counts):

```
node tools/engine.initial.bench.mjs --count=100
```

* Corpus is fixed and reproducible: board *N* (N = 1..100) fills the 12×12
  board uniformly with colors 1–5 using `mulberry32(1000 + N)` — see
  `boardDigits()` in the harness. Do not change the corpus; add a new
  category (different `--seed-base`) instead.
* Metric per position: node evaluations until **proven ✓** (all moves
  proven). Results are sorted ascending; each quarter reports its min–max
  node range. Positions ending `settled`/`stopped`/timeout instead of
  proven are listed separately and are themselves a regression signal
  (baseline: 100/100 proven).
* Compare quarter ranges, median, and total; the slowest quarter (Q4) is
  the most sensitive regression indicator (proof tails).
* Per-seed baseline counts: `docs/initial-run-baseline-bbe6921.jsonl`
  (enables paired per-position comparison, stronger than quarter ranges).

### Results log — initial run

| Date       | Commit    | Change under test | Q1 (1–25)     | Q2 (26–50)    | Q3 (51–75)     | Q4 (76–100)   | Median | Total  | Proven  | Verdict  |
|------------|-----------|-------------------|---------------|---------------|----------------|---------------|-------:|-------:|--------:|----------|
| 2026-07-16 | `bbe6921` | baseline          | 12.6M – 36.0M | 36.0M – 74.9M | 77.8M – 120.4M | 126.2M – 1.27B |  77.8M | 11.61B | 100/100 | baseline |
