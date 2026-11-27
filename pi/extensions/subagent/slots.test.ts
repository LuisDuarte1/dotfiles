import assert from "node:assert/strict";
import test from "node:test";
import { Slots } from "./slots.ts";

const tick = () => new Promise((resolve) => setImmediate(resolve));

test("calls past the limit wait for a release, first come first served", async () => {
	const slots = new Slots(2);
	const first = await slots.acquire();
	await slots.acquire();
	assert.equal(slots.full, true);
	const order: string[] = [];
	const third = slots.acquire().then((release) => {
		order.push("third");
		return release;
	});
	const fourth = slots.acquire().then(() => order.push("fourth"));
	await tick();
	assert.deepEqual(order, []);
	first();
	const releaseThird = await third;
	await tick();
	assert.deepEqual(order, ["third"]);
	releaseThird();
	await fourth;
	assert.deepEqual(order, ["third", "fourth"]);
});

test("releasing twice frees only one slot", async () => {
	const slots = new Slots(1);
	const release = await slots.acquire();
	release();
	release();
	await slots.acquire();
	assert.equal(slots.full, true);
});

test("an aborted wait leaves the queue without taking a slot", async () => {
	const slots = new Slots(1);
	const release = await slots.acquire();
	const controller = new AbortController();
	const waiting = slots.acquire(controller.signal);
	controller.abort();
	await assert.rejects(waiting, { name: "AbortError" });
	release();
	assert.equal(slots.full, false);
});
