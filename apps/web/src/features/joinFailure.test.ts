import { describe, expect, it } from 'vitest';
import {
  ACCESS_MESSAGE,
  ALREADY_OPEN_MESSAGE,
  CAPACITY_MESSAGE,
  CLAIM_LOST_MESSAGE,
  GENERIC_MESSAGE,
  NOT_FOUND_MESSAGE,
  RESTORE_FAILED_MESSAGE,
  joinFailureMessage,
} from './joinFailure';

function codedError(status: number, code: string, message: string): Error {
  const err = new Error(
    `gateway ${status}: ${JSON.stringify({ ok: false, error: message, code })}`,
  ) as Error & { gatewayBody?: unknown };
  err.gatewayBody = { ok: false, error: message, code };
  return err;
}

describe('joinFailureMessage (#117)', () => {
  it('says already-open ONLY for the explicit live-conflict code', () => {
    expect(
      joinFailureMessage(codedError(409, 'SESSION_LIVE_CONFLICT', 'live conflict')),
    ).toBe(ALREADY_OPEN_MESSAGE);
  });

  it('never says already-open for a bare 409', () => {
    expect(joinFailureMessage(new Error('gateway 409: conflict'))).toBe(GENERIC_MESSAGE);
    expect(joinFailureMessage(new Error('gateway 409: engine already owns a different file'))).toBe(
      GENERIC_MESSAGE,
    );
    expect(joinFailureMessage(new Error('claim failed'))).toBe(GENERIC_MESSAGE);
  });

  it('maps ENGINE_CLAIM_FAILED (dead-session/checksum 409) to the honest restore message', () => {
    expect(
      joinFailureMessage(
        codedError(409, 'ENGINE_CLAIM_FAILED', 'engine claim failed: checksum mismatch'),
      ),
    ).toBe(RESTORE_FAILED_MESSAGE);
    // Message-substring fallback for non-gatewayClient error paths.
    expect(
      joinFailureMessage(new Error('gateway 409: engine claim failed: checksum mismatch')),
    ).toBe(RESTORE_FAILED_MESSAGE);
  });

  it('maps CLAIM_LOST to the honest race message', () => {
    expect(
      joinFailureMessage(
        codedError(409, 'CLAIM_LOST', 'ownership claim lost and no live owner found'),
      ),
    ).toBe(CLAIM_LOST_MESSAGE);
    expect(joinFailureMessage(new Error('ownership claim lost and no live owner found'))).toBe(
      CLAIM_LOST_MESSAGE,
    );
  });

  it('maps the capacity 503 to the capacity message', () => {
    expect(
      joinFailureMessage(new Error('gateway 503: no free engine instance: all 2 busy')),
    ).toBe(CAPACITY_MESSAGE);
  });

  it('keeps the 401/403 and 404 messages', () => {
    expect(joinFailureMessage(new Error('gateway 401: not authenticated'))).toBe(ACCESS_MESSAGE);
    expect(joinFailureMessage(new Error('gateway 403: no access grant for this file'))).toBe(
      ACCESS_MESSAGE,
    );
    expect(joinFailureMessage(new Error('gateway 404: file not found'))).toBe(NOT_FOUND_MESSAGE);
  });

  it('reads the code from the message JSON when gatewayBody is absent', () => {
    const err = new Error(
      'gateway 409: {"ok":false,"error":"engine claim failed: x","code":"ENGINE_CLAIM_FAILED"}',
    );
    expect(joinFailureMessage(err)).toBe(RESTORE_FAILED_MESSAGE);
  });
});
