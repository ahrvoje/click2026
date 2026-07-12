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

// Replay state is visual/navigation-only; the layout remains structural.
const placed = layoutTree(game.getRoot());
assert.equal(placed.get(main).col, 0);
assert.equal(placed.get(mainLeaf).col, 0);
assert.ok(placed.get(variant).col > 0);
assert.ok(placed.get(newVariant).col > 0);

console.log("Tree replay model tests passed.");
