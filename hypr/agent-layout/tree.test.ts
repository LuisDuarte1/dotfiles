import assert from "node:assert/strict";
import test from "node:test";
import { planBuild } from "./build.ts";
import { bands, describeTree, type Item, inferTree, isEvenlySplit, leaves, targetRects } from "./tree.ts";

const item = (id: number, x: number, y: number, w: number, h: number, hidden = false): Item => ({
	id,
	rect: { x, y, w, h },
	hidden,
});

// Real DP-3 geometry: a 4x2 grid (workspace 2) and a full-height column plus a split
// column (workspace 3), at 1.5 scale with 5px gaps_in and 2px borders.
const grid = [
	item(0, 3862, 52, 619, 676),
	item(1, 3862, 742, 619, 676),
	item(2, 4495, 52, 618, 676),
	item(3, 4495, 742, 618, 676),
	item(4, 5127, 52, 619, 676),
	item(5, 5127, 742, 619, 676),
	item(6, 5760, 52, 618, 676),
	item(7, 5760, 742, 618, 676),
];

test("a grid becomes columns of rows when columns are preferred", () => {
	const tree = inferTree(grid, "h");
	assert.ok(tree);
	assert.equal(describeTree(tree), "h[v[0, 1], v[2, 3], v[4, 5], v[6, 7]]");
	assert.ok(isEvenlySplit(tree));
});

test("a grid becomes rows of columns when rows are preferred", () => {
	const tree = inferTree(grid, "v");
	assert.ok(tree);
	assert.equal(describeTree(tree), "v[h[0, 2, 4, 6], h[1, 3, 5, 7]]");
});

test("a dropped window collapses its column to a single leaf", () => {
	const tree = inferTree(grid.filter((i) => i.id !== 1), "h");
	assert.ok(tree);
	assert.equal(describeTree(tree), "h[0, v[2, 3], v[4, 5], v[6, 7]]");
});

test("full-height column next to a split column", () => {
	const ws3 = [item(0, 3862, 52, 1251, 1366), item(1, 5127, 52, 1251, 676), item(2, 5127, 742, 1251, 676)];
	const tree = inferTree(ws3, "h");
	assert.ok(tree);
	assert.equal(describeTree(tree), "h[0, v[1, 2]]");
	assert.deepEqual(planBuild(tree, true), [
		{ op: "spawn", item: 0, anchor: null },
		{ op: "group", target: 0, layout: "h", mode: "change" },
		{ op: "spawn", item: 1, anchor: 0 },
		{ op: "group", target: 1, layout: "v", mode: "make" },
		{ op: "spawn", item: 2, anchor: 1 },
	]);
});

test("a dropped top-right window leaves two full-height columns", () => {
	const tree = inferTree([item(0, 3862, 52, 1251, 1366), item(2, 5127, 742, 1251, 676)], "h");
	assert.ok(tree);
	assert.equal(describeTree(tree), "h[0, 2]");
});

test("identical rectangles form a tab group with the visible tab last", () => {
	const tabs = [
		item(0, 3862, 79, 1251, 1339, false),
		item(3, 3862, 79, 1251, 1339, true),
		item(1, 5127, 52, 1251, 676),
		item(2, 5127, 742, 1251, 676),
	];
	const tree = inferTree(tabs, "h");
	assert.ok(tree);
	assert.equal(describeTree(tree), "h[tab[3, 0], v[1, 2]]");
});

test("nested tree from the hy3 spike: v[h[A, v[B, C]], D]", () => {
	const spike = [
		item(0, 3862, 52, 802, 601),
		item(1, 4678, 52, 1700, 300),
		item(2, 4678, 366, 1700, 287),
		item(3, 3862, 667, 2516, 751),
	];
	const tree = inferTree(spike, "h");
	assert.ok(tree);
	assert.equal(describeTree(tree), "v[h[0, v[1, 2]], 3]");
	assert.equal(isEvenlySplit(tree), false);
	assert.deepEqual(planBuild(tree, false), [
		{ op: "spawn", item: 0, anchor: null },
		{ op: "group", target: 0, layout: "v", mode: "make" },
		{ op: "spawn", item: 3, anchor: 0 },
		{ op: "group", target: 0, layout: "h", mode: "make" },
		{ op: "spawn", item: 1, anchor: 0 },
		{ op: "group", target: 1, layout: "v", mode: "make" },
		{ op: "spawn", item: 2, anchor: 1 },
	]);
	assert.deepEqual(leaves(tree), [0, 1, 2, 3]);
});

test("ratios follow extents along the split axis", () => {
	const tree = inferTree([item(0, 0, 0, 300, 100), item(1, 314, 0, 600, 100)], "h");
	assert.ok(tree && tree.kind === "group");
	assert.deepEqual(
		tree.children.map((c) => c.ratio.toFixed(3)),
		["0.333", "0.667"],
	);
});

test("bands tolerates a 1px overlap from rounding", () => {
	assert.equal(bands([item(0, 0, 0, 101, 10), item(1, 100, 0, 100, 10)], "x").length, 2);
	assert.equal(bands([item(0, 0, 0, 150, 10), item(1, 100, 0, 100, 10)], "x").length, 1);
});

test("targetRects lays out ratios, gaps and tab bars", () => {
	const tree = inferTree(
		[item(0, 0, 0, 300, 400, true), item(1, 0, 0, 300, 400), item(2, 314, 0, 600, 193), item(3, 314, 207, 600, 193)],
		"h",
	);
	assert.ok(tree);
	const rects = targetRects(tree, { x: 0, y: 0, w: 914, h: 400 }, { gap: 14, tabBar: 27 });
	assert.deepEqual(rects.get(1), { x: 0, y: 27, w: 300, h: 373 });
	assert.deepEqual(rects.get(2), { x: 314, y: 0, w: 600, h: 193 });
	assert.deepEqual(rects.get(3), { x: 314, y: 207, w: 600, h: 193 });
});
