/**
 * Issue #117: map a join failure to plain user language. The raw
 * gateway error (file UUIDs, JSON bodies) must NEVER reach user-visible
 * copy — it goes to the console only. This returns the sentence shown
 * in the blocking error state under the file's name.
 *
 * Honesty rule (owner, 2026-10-24): the "already open" sentence is
 * correct ONLY when a session is genuinely still live AND the open
 * cannot join it. On the current gateway open path no 409 means that:
 * a live session JOINS (200); busy instances are retried server-side;
 * a full pool is a 503; the only 409s are a fatal engine-claim
 * failure (e.g. a dead session's rehydrate checksum mismatch, code
 * ENGINE_CLAIM_FAILED) and a lost registry-claim race (code
 * CLAIM_LOST). So "already open" is gated behind the explicit
 * SESSION_LIVE_CONFLICT code — which the gateway emits for no path
 * today — and NEVER behind a message-text regex. The old regex
 * (/409|claim|already owns|different file/) lied for every 409 the
 * open path can produce.
 *
 * The code is read from the gatewayClient error's structured
 * `gatewayBody.code` when present, else from the `code` field in the
 * message's JSON body prefix; message-substring fallbacks cover
 * non-gatewayClient error paths (e.g. engine-direct errors).
 */
export const ALREADY_OPEN_MESSAGE =
  'This file is already open in another session. Close it there, or wait a moment for that session to end, then try again.';

export const RESTORE_FAILED_MESSAGE =
  "This file's saved session could not be restored. Your file is safe — try again.";

export const CLAIM_LOST_MESSAGE =
  'Another open just claimed this file first. Try again to join it.';

export const CAPACITY_MESSAGE = 'All engine slots are busy right now. Try again in a moment.';

export const ACCESS_MESSAGE =
  'You may not have access to this file, or your sign-in has expired. Sign in again, then try again.';

export const NOT_FOUND_MESSAGE =
  'This file could not be found. It may have been deleted, or the link may be incomplete.';

export const GENERIC_MESSAGE =
  'Something went wrong while opening this file. Check your connection, then try again.';

function errorCode(e: unknown): string | null {
  const body = (e as { gatewayBody?: unknown } | null)?.gatewayBody;
  if (body && typeof body === 'object') {
    const code = (body as { code?: unknown }).code;
    if (typeof code === 'string' && code.length > 0) return code;
  }
  const raw = e instanceof Error ? e.message : String(e);
  const m = /"code"\s*:\s*"([A-Z_]+)"/.exec(raw);
  return m ? m[1] : null;
}

export function joinFailureMessage(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e);
  const code = errorCode(e);
  // The ONLY path to the already-open sentence: an explicit
  // genuine-live-conflict code from the gateway.
  if (code === 'SESSION_LIVE_CONFLICT') return ALREADY_OPEN_MESSAGE;
  if (code === 'ENGINE_CLAIM_FAILED' || /engine claim failed/i.test(raw)) {
    return RESTORE_FAILED_MESSAGE;
  }
  if (code === 'CLAIM_LOST' || /ownership claim lost/i.test(raw)) {
    return CLAIM_LOST_MESSAGE;
  }
  if (/no free engine instance/i.test(raw)) return CAPACITY_MESSAGE;
  if (/401|403|unauthor|forbidden|sign-in|sign in/i.test(raw)) return ACCESS_MESSAGE;
  if (/404|not found/i.test(raw)) return NOT_FOUND_MESSAGE;
  return GENERIC_MESSAGE;
}
