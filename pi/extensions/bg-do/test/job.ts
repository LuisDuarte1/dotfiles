import type { JobInfo } from "../frames.ts";

export const job = (over: Partial<JobInfo> = {}): JobInfo => ({
	id: "bg-1",
	cmd: "make",
	pid: 100,
	group: true,
	started: 1000,
	ended: null,
	running: true,
	returncode: null,
	log: "/nonexistent.log",
	notify: [],
	...over,
});
