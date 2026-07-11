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
cd src
python -m http.server 8000    # or: npx serve
```

then open http://localhost:8000/.

Game links
----------

A finished game (position, moves and timings) serializes into a shareable URL — use the link button to export and the import button to load one. All three historical formats are still readable:

* **v1** — plain decimal `?position=...&moves=...&times=...` (2014)
* **v2** — base-71 packed, Huffman-coded deltas, lossy log-scale times (2015)
* **v3** — like v2, packed with a URL-safe base-64 alphabet (2021, current)

New links are always written as v3. Old Click2014 links keep working.

Examples & self tests
---------------------

Tick the discrete `examples & tests` checkbox in the bottom-left corner of the status bar to reveal the panel with three replayable example games and *Run tests...*, which runs 30,000+ serialization round-trip checks in a dialog.

License
-------

MIT, Copyright 2014-2026 Hrvoje Abraham
