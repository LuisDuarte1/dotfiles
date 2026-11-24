import assert from "node:assert/strict";
import test from "node:test";
import { AUTH_RETRY_LIMIT, authRetriesAfter, isAuthError } from "./auth.ts";

const INVALID_TOKEN =
  '401 {"error":"invalid_token","error_description":"Missing or invalid access token","request_id":"5032994"}';
const UNAUTHORIZED = "401 Unauthorized";
const DENIED = '403 {"success":false,"error":{"message":"Access denied by policy"}}';
const OVERLOADED = '529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}';

test("both 401 shapes from the logs are auth errors", () => {
  assert.equal(isAuthError(INVALID_TOKEN), true);
  assert.equal(isAuthError(UNAUTHORIZED), true);
});

test("a 401 behind a provider prefix or a bare colon is an auth error", () => {
  assert.equal(isAuthError('OpenAI API error (401): {"error":{"message":"Invalid token"}}'), true);
  assert.equal(isAuthError('401: {"error":"invalid_token"}'), true);
});

test("a policy denial stays non-retryable", () => {
  assert.equal(isAuthError(DENIED), false);
  assert.equal(authRetriesAfter(DENIED, 0), 0);
});

test("a 401 outside the status position is not an auth error", () => {
  assert.equal(isAuthError("503 Service unavailable (request id req_401f3c)"), false);
  assert.equal(isAuthError('400 {"error":"prompt is too long: 4012 tokens > 4000 maximum"}'), false);
  assert.equal(isAuthError("4010 Unknown"), false);
  assert.equal(isAuthError("npm error 401 Unauthorized"), false);
  assert.equal(isAuthError("Request timed out."), false);
});

test("three auth retries in a row are allowed and the fourth ends the chain", () => {
  let count = 0;
  for (let n = 1; n <= AUTH_RETRY_LIMIT; n++) {
    count = authRetriesAfter(UNAUTHORIZED, count)!;
    assert.equal(count, n);
  }
  assert.equal(AUTH_RETRY_LIMIT, 3);
  assert.equal(authRetriesAfter(INVALID_TOKEN, count), undefined);
});

test("other transient errors between auth errors do not reset the count", () => {
  assert.equal(authRetriesAfter(OVERLOADED, 2), 2);
  assert.equal(authRetriesAfter(UNAUTHORIZED, 2), 3);
  assert.equal(authRetriesAfter(UNAUTHORIZED, 3), undefined);
});
