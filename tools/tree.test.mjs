/**
 * Click2026 — fast position-tree replay-route checks.
 *
 * Usage: node tools/tree.test.mjs
 */

import assert from "node:assert/strict";
import { Game } from "../src/scripts/game.js";
import { Serializer } from "../src/scripts/serial.js";
import { layoutTree } from "../src/scripts/tree-ui.js";

// Solid, differently colored columns provide several independent legal root
// moves and deterministic continuations after any one column collapses away.
const position = Array.from({ length: 12 }, (_, x) => Array(12).fill(x % 5 + 1));
const leaf = (move) => ({ move, score: null, children: [] });
const tree = {
    move: null,
    score: null,
    children: [
        { move: [0, 0], score: null, children: [leaf([0, 0])] },
        { move: [1, 0], score: null, children: [leaf([0, 0])] },
    ],
};

const game = new Game("?" + Serializer.serializeGameTree(position, tree, [0, 500]));
const [main, variant] = game.getRoot().children;
const mainLeaf = main.children[0];
const variantLeaf = variant.children[0];

assert.deepEqual(game.getReplayNodes(), [main, mainLeaf], "replay defaults to the structural main line");
assert.equal(game.isReplayOnMainLine(), true);

const originalLink = game.getString();
assert.equal(game.selectReplayNode(variant), true);
assert.deepEqual(game.getReplayNodes(), [variant, variantLeaf], "a target includes its first-child tail");
assert.equal(game.isReplayOnMainLine(), false);
assert.equal(game.getString(), originalLink, "replay selection must not alter serialization");

game.replay();
assert.equal(game.rewindToMove(game.getMoves().length), true);
assert.equal(game.getFocus(), variantLeaf, "forward navigation follows the selected replay route");

game.focusNode(mainLeaf);
assert.equal(game.isFocusOnReplayLine(), false);
assert.deepEqual(game.getNextMoveGroup(), [], "an inspected off-route node has no replay successor");
assert.equal(game.playNextMove(), false);

const foreign = new Game().getRoot();
assert.equal(game.selectReplayNode(foreign), false, "nodes from another game are rejected");

// A genuinely new sibling becomes the replay route without disturbing child 0.
game.rewindToMove(0);
assert.equal(game.playMove([2, 0]), true);
const newVariant = game.getFocus();
assert.equal(game.getRoot().children[0], main);
assert.equal(game.getReplayTarget(), newVariant);
assert.deepEqual(game.getReplayNodes(), [newVariant]);
assert.equal(game.isReplayOnMainLine(), false);

assert.equal(game.playMove([0, 0]), true);
assert.equal(game.getReplayTarget(), game.getFocus(), "new continuation extends the selected replay route");
assert.deepEqual(game.getReplayNodes(), [newVariant, game.getFocus()]);

// Replay state is visual/navigation-only; the layout remains structural: the
// variants break in right after the position they branch from, each on its own
// indented row, and the interrupted line resumes below them on a fresh row that
// begins with the rivaled move — no move stays behind on another line's row.
const placed = layoutTree(game.getRoot());
const rootPlace = placed.get(game.getRoot());
assert.ok(placed.get(variant).row > rootPlace.row, "variant starts a new row");
assert.ok(placed.get(variant).x > rootPlace.x, "variant row is indented");
assert.ok(placed.get(newVariant).x > rootPlace.x, "new variant row is indented");
assert.ok(placed.get(main).row > placed.get(newVariant).row, "main move starts its own row below the variants");
assert.equal(placed.get(main).x, rootPlace.x, "resumed main line returns to its indent");
assert.equal(placed.get(mainLeaf).row, placed.get(main).row, "main line flows on its resumed row");

// variant chains are numbered chronologically by creation, on their first node only
assert.equal(placed.get(main).variant, 0, "the main line is unnumbered");
assert.equal(placed.get(variant).variant, 1, "loaded variant is number 1");
assert.equal(placed.get(newVariant).variant, 2, "the variant created next is number 2");
assert.equal(placed.get(variantLeaf).variant, 0, "only the chain's first node carries the number");

// chronological numbering: a variant created later at an earlier position gets the
// higher number although it sits higher in the tree
game.focusNode(main);
assert.equal(game.playMove([1, 0]), true);
const laterDeep = game.getFocus();
game.focusNode(game.getRoot());
assert.equal(game.playMove([3, 0]), true);
const laterRoot = game.getFocus();
assert.equal(laterDeep.variantNum, 3, "third created variant is number 3");
assert.equal(laterRoot.variantNum, 4, "fourth created variant is number 4");

const chronoPlaced = layoutTree(game.getRoot());
assert.ok(chronoPlaced.get(laterRoot).row < chronoPlaced.get(laterDeep).row,
    "the later-created variant sits higher in the layout");
assert.equal(chronoPlaced.get(laterRoot).variant, 4, "the layout exposes the chronological number");
assert.equal(chronoPlaced.get(laterDeep).variant, 3);

// the creation order is serialized (v6) and survives the link round-trip, where
// the tree order [laterDeep, variant, newVariant, laterRoot] differs from it
const chronoLink = game.getString();
assert.ok(chronoLink.startsWith("v=6&"), "games with variants serialize as v6");
const reloaded = new Game("?" + chronoLink);
assert.equal(reloaded.getRoot().children[0].children[1].variantNum, 3, "creation order survives the round-trip");
assert.equal(reloaded.getRoot().children[1].variantNum, 1);
assert.equal(reloaded.getRoot().children[2].variantNum, 2);
assert.equal(reloaded.getRoot().children[3].variantNum, 4);
assert.equal(reloaded.getString(), chronoLink, "reloaded game re-serializes identically");

// pre-v6 links carry no creation order — their variants number in tree order
// (frozen v5 fixture: root children [main line, variant, variant], one nested leaf each)
const v5Link = "?v=5&g=LrsY3soMj1JnD4O8tdnDj1gmFGTruqKvqcGsmQbYVDq53q33G5pJWH4KKHSs0pjGspQ";
const legacy = new Game(v5Link);
assert.equal(legacy.getRoot().children.length, 3, "v5 fixture still decodes");
assert.equal(legacy.getRoot().children[1].variantNum, 1, "v5 variants fall back to tree order");
assert.equal(legacy.getRoot().children[2].variantNum, 2);
assert.equal(legacy.getRoot().children[2].score, 7, "v5 scores still decode");

// a node whose position has no legal move left is flagged as the game's end
assert.equal(mainLeaf.over, false, "solid columns still hold legal moves");
const monoPosition = Array.from({ length: 12 }, () => Array(12).fill(1));
const monoGame = new Game("?" + Serializer.serializeGameTree(monoPosition,
    { move: null, score: null, children: [leaf([0, 0])] }, []));
assert.equal(monoGame.getRoot().over, false, "the start position has a legal move");
assert.equal(monoGame.getRoot().children[0].over, true, "clearing the board ends the game");

console.log("Tree replay model tests passed.");
