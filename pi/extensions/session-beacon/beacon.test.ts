import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
	type Beacon,
	beaconDir,
	beaconPath,
	forwardableFlags,
	processStartTime,
	removeBeacon,
	startTimeFromStat,
	writeBeacon,
} from "./beacon.ts";

test("forwardableFlags keeps run-scoped flags and drops session selection, model and messages", () => {
	const argv = [
		"--extension",
		"/home/u/luisd/plugins/luisd-pi.ts",
		"--session",
		"/s/a.jsonl",
		"--mcp-profile",
		"portal",
		"--model",
		"anthropic/claude",
		"--web-search",
		"-c",
		"--",
		"--offline",
	];
	assert.deepEqual(forwardableFlags(argv), ["--mcp-profile", "portal", "--web-search"]);
});

test("forwardableFlags accepts the --flag=value form", () => {
	assert.deepEqual(forwardableFlags(["--mcp-profile=portal,canvas", "-na"]), ["--mcp-profile=portal,canvas", "-na"]);
});

test("startTimeFromStat survives spaces and parens in comm", () => {
	const stat = "1234 (my (weird) proc) S 1 1234 1234 0 -1 4194560 100 0 0 0 1 2 0 0 20 0 1 0 987654 1000 10";
	assert.equal(startTimeFromStat(stat), "987654");
});

test("processStartTime reads the current process", () => {
	assert.match(processStartTime(process.pid) ?? "", /^\d+$/);
	assert.equal(processStartTime(2 ** 31 - 1), undefined);
});

test("beaconDir prefers XDG_RUNTIME_DIR", () => {
	assert.equal(beaconDir({ XDG_RUNTIME_DIR: "/run/user/1000" }, 1000), "/run/user/1000/pi-beacons");
	assert.match(beaconDir({}, 1000), /pi-beacons-1000$/);
});

test("writeBeacon writes atomically and removeBeacon deletes", () => {
	const dir = path.join(mkdtempSync(path.join(tmpdir(), "beacon-")), "nested");
	const beacon: Beacon = {
		version: 1,
		pid: 42,
		startTime: "100",
		cwd: "/w",
		sessionFile: "/s/a.jsonl",
		sessionId: "a",
		sessionName: null,
		flags: [],
		tmuxSession: "pi-abc",
		updatedAt: "2026-01-01T00:00:00.000Z",
	};
	writeBeacon(dir, beacon);
	assert.deepEqual(readdirSync(dir), ["42.json"]);
	assert.deepEqual(JSON.parse(readFileSync(beaconPath(dir, 42), "utf8")), beacon);
	removeBeacon(dir, 42);
	assert.equal(existsSync(beaconPath(dir, 42)), false);
	removeBeacon(dir, 42);
});
