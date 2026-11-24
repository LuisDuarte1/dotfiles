// A rejected login does not heal with time, so backing off buys nothing: these retries only let a
// `scheduled` listener hold the request until the user logs in again, and a few are enough.
export const AUTH_RETRY_LIMIT = 3;

// The status leads an SDK message ("401 Unauthorized", "401: body") or follows a provider prefix
// ("API error (401): body"); request ids and token counts elsewhere in the text hold digits too.
const AUTH_STATUS_PATTERN = /^401\b|\(401\):/;

export function isAuthError(errorMessage: string): boolean {
  return AUTH_STATUS_PATTERN.test(errorMessage);
}

// Other transient errors in between leave the count alone, so a gateway alternating 503 and 401
// cannot stretch the chain; undefined means this error is past the cap and must end it.
export function authRetriesAfter(errorMessage: string, authRetries: number): number | undefined {
  if (!isAuthError(errorMessage)) return authRetries;
  return authRetries < AUTH_RETRY_LIMIT ? authRetries + 1 : undefined;
}
