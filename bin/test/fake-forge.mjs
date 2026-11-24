#!/usr/bin/env node
// Stands in for gh and glab so ci-wait can be tested offline: replays the canned
// responses in $FAKE_FORGE_DIR/plan.json per route, repeating the last one.
import fs from "node:fs";
import path from "node:path";

const dir = process.env.FAKE_FORGE_DIR;
const args = process.argv.slice(2);
const endpoint = args.at(-1) ?? "";
const route =
	args[0] === "pr"
		? args[1]
		: /\/merge_requests\/\d+$/.test(endpoint)
			? "mr"
			: /\/merge_requests\?/.test(endpoint)
				? "mrs"
				: (/\/(jobs|bridges)\?/.exec(endpoint)?.[1] ?? "unknown");
fs.appendFileSync(path.join(dir, "calls.jsonl"), `${JSON.stringify({ route, args })}\n`);

const responses = JSON.parse(fs.readFileSync(path.join(dir, "plan.json"), "utf8"))[route];
if (!responses?.length) {
	process.stderr.write(`fake-forge: no response planned for ${route}\n`);
	process.exit(99);
}
const counter = path.join(dir, `${route}.count`);
const seen = fs.existsSync(counter) ? Number(fs.readFileSync(counter, "utf8")) : 0;
fs.writeFileSync(counter, String(seen + 1));
const response = responses[Math.min(seen, responses.length - 1)];

if (response.hang) {
	setInterval(() => {}, 1000);
} else {
	if (response.stderr) process.stderr.write(response.stderr);
	process.stdout.write(response.json === undefined ? (response.stdout ?? "") : JSON.stringify(response.json));
	process.exitCode = response.code ?? 0;
}
