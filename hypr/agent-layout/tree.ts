import type { Rect } from "./types.ts";

export type Layout = "h" | "v" | "tab";

export interface Leaf {
	kind: "leaf";
	item: number;
	ratio: number;
}

export interface Group {
	kind: "group";
	layout: Layout;
	children: Node[];
	ratio: number;
}

export type Node = Leaf | Group;

export interface Item {
	id: number;
	rect: Rect;
	hidden?: boolean;
}

const TOLERANCE = 2;

function sameRect(a: Rect, b: Rect): boolean {
	return (
		Math.abs(a.x - b.x) <= TOLERANCE &&
		Math.abs(a.y - b.y) <= TOLERANCE &&
		Math.abs(a.w - b.w) <= TOLERANCE &&
		Math.abs(a.h - b.h) <= TOLERANCE
	);
}

function span(items: Item[], axis: "x" | "y"): [number, number] {
	const size = axis === "x" ? "w" : "h";
	return [Math.min(...items.map((i) => i.rect[axis])), Math.max(...items.map((i) => i.rect[axis] + i.rect[size]))];
}

// Splits items into bands separated by a clear line along the axis; one band means no cut.
// Any cut inside a band would also cut the whole set, so callers never re-cut on that axis.
export function bands(items: Item[], axis: "x" | "y"): Item[][] {
	const size = axis === "x" ? "w" : "h";
	const sorted = [...items].sort((a, b) => a.rect[axis] - b.rect[axis] || a.id - b.id);
	const out: Item[][] = [];
	let end = Number.NEGATIVE_INFINITY;
	for (const item of sorted) {
		if (out.length === 0 || item.rect[axis] >= end - TOLERANCE) out.push([item]);
		else out[out.length - 1].push(item);
		end = Math.max(end, item.rect[axis] + item.rect[size]);
	}
	return out;
}

function withRatios(layout: Exclude<Layout, "tab">, parts: Item[][], build: (part: Item[]) => Node): Group {
	const axis = layout === "h" ? "x" : "y";
	const extents = parts.map((part) => {
		const [start, end] = span(part, axis);
		return end - start;
	});
	const total = extents.reduce((a, b) => a + b, 0) || 1;
	const children = parts.map((part, i) => ({ ...build(part), ratio: extents[i] / total }));
	return { kind: "group", layout, children, ratio: 1 };
}

// Rebuilds a hy3-style split tree from the window rectangles of one workspace. `rootLayout`
// breaks the grid tie (cut columns or rows first), which hy3 renders identically either way.
export function inferTree(items: Item[], rootLayout: Exclude<Layout, "tab"> = "h"): Node | undefined {
	if (items.length === 0) return undefined;

	const build = (part: Item[], prefer: Exclude<Layout, "tab">): Node => {
		if (part.length === 1) return { kind: "leaf", item: part[0].id, ratio: 1 };
		if (part.every((item) => sameRect(item.rect, part[0].rect))) {
			const ordered = [...part].sort((a, b) => Number(Boolean(b.hidden)) - Number(Boolean(a.hidden)) || a.id - b.id);
			const children: Node[] = ordered.map((item) => ({ kind: "leaf", item: item.id, ratio: 1 }));
			return { kind: "group", layout: "tab", children, ratio: 1 };
		}
		const columns = bands(part, "x");
		const rows = bands(part, "y");
		const order: Exclude<Layout, "tab">[] = prefer === "h" ? ["h", "v"] : ["v", "h"];
		for (const layout of order) {
			const parts = layout === "h" ? columns : rows;
			if (parts.length > 1) return withRatios(layout, parts, (p) => build(p, layout === "h" ? "v" : "h"));
		}
		const fallback = [...part].sort((a, b) => a.rect.x - b.rect.x || a.rect.y - b.rect.y || a.id - b.id);
		return withRatios(prefer, fallback.map((item) => [item]), (p) => build(p, prefer));
	};

	return build(items, rootLayout);
}

export function firstLeaf(node: Node): number {
	return node.kind === "leaf" ? node.item : firstLeaf(node.children[0]);
}

export function leaves(node: Node): number[] {
	return node.kind === "leaf" ? [node.item] : node.children.flatMap(leaves);
}

export function describeTree(node: Node, names: (item: number) => string = String): string {
	if (node.kind === "leaf") return names(node.item);
	return `${node.layout}[${node.children.map((c) => describeTree(c, names)).join(", ")}]`;
}

export function isEvenlySplit(node: Node, tolerance = 0.02): boolean {
	if (node.kind === "leaf") return true;
	if (node.layout !== "tab") {
		const even = 1 / node.children.length;
		if (node.children.some((c) => Math.abs(c.ratio - even) > tolerance)) return false;
	}
	return node.children.every((c) => isEvenlySplit(c, tolerance));
}

export interface LayoutMetrics {
	gap: number;
	tabBar: number;
}

export function targetRects(node: Node, box: Rect, metrics: LayoutMetrics, out = new Map<number, Rect>()): Map<number, Rect> {
	if (node.kind === "leaf") {
		out.set(node.item, box);
		return out;
	}
	if (node.layout === "tab") {
		const inner = { x: box.x, y: box.y + metrics.tabBar, w: box.w, h: box.h - metrics.tabBar };
		for (const child of node.children) targetRects(child, inner, metrics, out);
		return out;
	}
	const horizontal = node.layout === "h";
	const extent = horizontal ? box.w : box.h;
	const available = extent - metrics.gap * (node.children.length - 1);
	const total = node.children.reduce((sum, c) => sum + c.ratio, 0) || 1;
	let offset = horizontal ? box.x : box.y;
	for (const child of node.children) {
		const size = Math.round((available * child.ratio) / total);
		const sub = horizontal ? { x: offset, y: box.y, w: size, h: box.h } : { x: box.x, y: offset, w: box.w, h: size };
		targetRects(child, sub, metrics, out);
		offset += size + metrics.gap;
	}
	return out;
}

export function boundingBox(rects: Rect[]): Rect {
	const x = Math.min(...rects.map((r) => r.x));
	const y = Math.min(...rects.map((r) => r.y));
	const right = Math.max(...rects.map((r) => r.x + r.w));
	const bottom = Math.max(...rects.map((r) => r.y + r.h));
	return { x, y, w: right - x, h: bottom - y };
}
