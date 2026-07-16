Click2026
=========

A simple clicking puzzle game implemented in HTML5 during one summer afternoon of 2014 (as *Click2014*), and modernized in 2026. I enjoy playing it for years, so I decided it's about time to port it to web.

The rules are simple. Just keep clicking same-colored groups until you have no choices & moves left. The ultimate goal is to clean up the board. Good luck!

<p align="center">
  <img src="resources/Click2014_Example_v2.png?raw=true" alt="Click2026 example"/>
</p>

Running
-------

The game is zero-dependency static HTML/CSS/JS, but it uses ES modules, so it must be served over HTTP rather than opened from the filesystem. Any static server will do, e.g.:

```
npm run serve
# or: python -m http.server 8000 --directory .
```

Then open http://localhost:8123/ for the npm command (or
http://localhost:8000/ for the Python command). Serve the repository root:
its `index.html` redirects to `src/index.html` while preserving shared-link
query parameters and hashes. The same relative redirect works when GitHub
Pages publishes the repository from `/`.

Game links
----------

A finished game (position, moves and timings) serializes into a shareable URL — use the link button to export and the import button to load one. All historical formats are still readable:

* **v1** — plain decimal `?position=...&moves=...&times=...` (2014)
* **v2** — base-71 packed, Huffman-coded deltas, lossy log-scale times (2015)
* **v3** — like v2, packed with a URL-safe base-64 alphabet (2021; both deployed dialects decode)
* **v4** — single `?v=4&g=...` param: one rANS entropy-coded stream — moves stored as
  the rank of the clicked group among the legal groups sorted by distance from the
  previous click (the decoder replays the game to rebuild them), timings log-quantized
  with error diffusion (2026)
* **v5** — v4 extended with the whole **position tree**: variant branches and the best
  engine score recorded per node travel inside the same entropy-coded stream (2026)
* **v6** — v5 extended with the **chronological creation order** of the variant lines,
  Lehmer-coded in log2(n!) bits after the tree (2026, current)

New links are written as v4 (~12% shorter than v3, per-move times ~4× more precise), or as
v6 once the game holds variants or engine data. In both formats the **total game time is
exact to the millisecond**, decoded games re-serialize to the byte-identical link, and the
entropy-coder end state doubles as an integrity check. Old Click2014 links keep working.

Position tree & official time
-----------------------------

Every move is recorded in the position tree shown right of the board, laid out like modern
chess notation: moves flow left to right and wrap into rows, and each alternative try breaks
in on its own row, indented one step per variant depth, before the interrupted line resumes
on a fresh row of its own — every move sits on a row of the line it belongs to. Variants are
numbered chronologically by creation in front of their indentation (the order is part of the
v6 link), so any move is identified at a glance (m10 is move 10 of the main line, 3m41 is
move 41 of variant 3). Each node shows the move number,
the color played, the A–L column/row of the clicked block (a group is represented by its
lowest-leftmost block) and the best engine score seen for that position. A dark bar right
of a node marks a finished game — no legal move is left there. Clicking a node reloads its position; playing a move that is already in the tree
just moves the focus, anything new amends the tree. The red-tinted nodes mark the selected
replay route. It starts on the main line; double-click any node to route replay through it,
or play a new branch to select that branch automatically. The mouse wheel — over the board or
over the moves panel — and the rewind controls step along this route; the panel scrolls itself
to keep the shown move visible. The panel keeps a fixed width — deep trees wrap and scroll
vertically.

The bottom-left **settings** button controls the move navigator and engine list.
The moves slider sits below the board, defaults to visible on mobile devices,
and can be shown or hidden explicitly. Engine suggestions can display the top
five moves, the top five plus the first positive-score move, or every ranked
legal move.

The game clock is strict about what counts: it runs only while a fresh game is played purely
on the board, and the moment any other control is used (buttons, wheel, engine or tree
clicks) it stops for good — the times recorded up to then remain the official result.
Official per-move times exist only for the main line; variants show a dash and autoplay at a
neutral fixed cadence instead.

Examples & self tests
---------------------

Tick the discrete `examples & tests` checkbox in the bottom-left corner of the status bar to reveal the panel with three replayable example games and *Run tests...*, which runs 32,000+ serialization round-trip checks in a dialog, including 2,000 full v4 game round-trips, 500 v6 position-tree round-trips and legacy v2/v3 link decoding.

License
-------

MIT, Copyright 2014-2026 Hrvoje Abraham
