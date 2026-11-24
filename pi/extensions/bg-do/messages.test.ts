import assert from "node:assert/strict";
import test from "node:test";
import { ENGINE_INTERRUPT, errorText } from "./messages.ts";

test("an interrupt from the timer names the timeout", () => {
	const text = errorText({ err: `${ENGINE_INTERRUPT}\n`, cause: "timeout", timeoutS: 120 });
	assert.match(text, /hit the 120s bg_do timeout/);
	assert.match(text, /still running/);
});

test("an interrupt from the user's abort is not called a timeout", () => {
	const text = errorText({ err: ENGINE_INTERRUPT, cause: "user", timeoutS: 120 });
	assert.equal(text, "Interrupted by the user, not a timeout. Background jobs are still running.");
});

test("any other error passes through unchanged, whatever the cause", () => {
	const err = "Traceback (most recent call last):\nKeyError: 'bg-9'\n";
	assert.equal(errorText({ err, cause: "user", timeoutS: 120 }), err);
	assert.equal(errorText({ err, timeoutS: 120 }), err);
});
