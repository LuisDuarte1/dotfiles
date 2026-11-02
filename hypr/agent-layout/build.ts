import { firstLeaf, type Layout, type Node } from "./tree.ts";

export type BuildOp =
	| { op: "spawn"; item: number; anchor: number | null }
	| { op: "group"; target: number; layout: Layout; mode: "make" | "change" };

// hy3 opens a window right after the focused node, and make_group wraps the focused node,
// so each group is built by wrapping its first window, then spawning siblings after it.
export function planBuild(tree: Node, workspaceEmpty: boolean): BuildOp[] {
	const ops: BuildOp[] = [];
	const first = firstLeaf(tree);
	ops.push({ op: "spawn", item: first, anchor: null });
	if (tree.kind === "leaf") return ops;

	ops.push({ op: "group", target: first, layout: tree.layout, mode: workspaceEmpty ? "change" : "make" });
	const fill = (group: Node, rep: number) => {
		if (group.kind === "leaf") return;
		const reps = [rep];
		let anchor = rep;
		for (const child of group.children.slice(1)) {
			const item = firstLeaf(child);
			ops.push({ op: "spawn", item, anchor });
			reps.push(item);
			anchor = item;
		}
		group.children.forEach((child, i) => {
			if (child.kind === "leaf") return;
			ops.push({ op: "group", target: reps[i], layout: child.layout, mode: "make" });
			fill(child, reps[i]);
		});
	};
	fill(tree, first);
	return ops;
}
