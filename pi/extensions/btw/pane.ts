import { spawn } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import type { BtwInfo } from "./guard.ts";
import { appendMarker, describePlan, planPromotion, readRequest, runPromotion } from "./promote.ts";

export interface PaneSpec {
	env: Record<string, string>;
	sandbox: string[];
	question: string;
	pi: string[];
	piFlags: string[];
	sessionFile: string;
	info: BtwInfo;
	rel: string;
	title: string;
	hasGstuff: boolean;
}

function runChild(argv: string[], env: Record<string, string>, cwd?: string): Promise<number> {
	return new Promise((resolve) => {
		const child = spawn(argv[0], argv.slice(1), { env, cwd, stdio: "inherit" });
		child.on("error", (error) => {
			console.error(`[btw] ${error.message}`);
			resolve(127);
		});
		child.on("exit", (code, signal) => resolve(code ?? (signal ? 128 : 1)));
	});
}

async function ask(prompt: string): Promise<string> {
	process.stdin.setRawMode?.(false);
	const rl = createInterface({ input: process.stdin, output: process.stdout });
	try {
		return (await rl.question(prompt)).trim();
	} finally {
		rl.close();
	}
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

// This runs outside the sandbox, so the y/N keypress below is the trust boundary for leaving it:
// the sandboxed agent can forge the request file but can't reach this terminal's input.
async function promote(spec: PaneSpec, slug: string): Promise<boolean> {
	try {
		const title = spec.question || spec.title;
		const plan = await planPromotion({ info: spec.info, slug, title, hasGstuff: spec.hasGstuff, env: spec.env });
		console.log("\n[btw] Promote this side session to a real worktree:\n");
		for (const line of describePlan(plan)) console.log(`  ${line}`);
		if (!/^y(es)?$/i.test(await ask("\nProceed? [y/N] "))) {
			console.log("[btw] Not promoted; back to the sandboxed side session.");
			return false;
		}
		const promotion = await runPromotion(plan, spec.env);
		appendMarker(spec.sessionFile, { ...spec.info, head: plan.head, promoted: promotion });
		const stack = promotion.stack ? `, gstuff stack ${promotion.stack}` : "";
		console.log(`[btw] Promoted to ${promotion.worktree} (${promotion.branch}${stack}).`);
		if (promotion.note) console.log(`[btw] ${promotion.note}`);
		const cwd = path.join(promotion.worktree, spec.rel);
		const code = await runChild([...spec.pi, "--fork", spec.sessionFile, ...spec.piFlags], spec.env, existsSync(cwd) ? cwd : promotion.worktree);
		if (code !== 0) await ask(`\n[btw] pi exited with status ${code}; press Enter to close `);
		return true;
	} catch (error) {
		console.error(`\n[btw] Promotion failed: ${message(error)}`);
		await ask("Press Enter to return to the sandboxed side session ");
		return false;
	}
}

export async function main(specFile: string): Promise<void> {
	const spec = JSON.parse(readFileSync(specFile, "utf8")) as PaneSpec;
	rmSync(specFile, { force: true });
	process.on("SIGINT", () => {}); // pi owns Ctrl+C; the runner must outlive it
	for (let first = true; ; first = false) {
		const argv = first && spec.question ? [...spec.sandbox, "--", spec.question] : spec.sandbox;
		const code = await runChild(argv, spec.env);
		const request = readRequest(spec.info.root);
		if (!request) {
			if (code !== 0) await ask(`\n[btw] pi exited with status ${code}; press Enter to close `);
			return;
		}
		if (await promote(spec, request.slug)) return;
	}
}

if (import.meta.main) await main(process.argv[2]);
