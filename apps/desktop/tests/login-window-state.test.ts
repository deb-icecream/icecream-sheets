/**
 * Login-window closed-handler resolution tests (#102: the retry race).
 *
 * Electron fires 'closed' asynchronously after close() returns, so a
 * retry can create a new window/server/flow before the old window's
 * handler runs. The resolution must clear ONLY refs the closed window
 * still owns, and must fail the login ONLY when its attempt is fully
 * intact — a replaced anything means a newer attempt owns the phase.
 */
import { describe, expect, it } from 'vitest';
import { resolveLoginWindowClosed } from '../src/login-window-state.js';

const win1 = { id: 'win1' };
const win2 = { id: 'win2' };
const srv1 = { id: 'srv1' };
const srv2 = { id: 'srv2' };
const flow1 = { id: 'flow1' };
const flow2 = { id: 'flow2' };

describe('resolveLoginWindowClosed', () => {
  it('abandon (no retry): clears everything, closes server, cancels flow, fails login', () => {
    const r = resolveLoginWindowClosed(
      { win: win1, srv: srv1, flow: flow1 },
      { win: win1, srv: srv1, flow: flow1 },
    );
    expect(r.next).toEqual({ win: null, srv: null, flow: null });
    expect(r.closeServer).toBe(true);
    expect(r.cancelFlow).toBe(true);
    expect(r.failLogin).toBe(true);
  });

  it('retry replaced everything before the old handler ran: touches NOTHING of the new attempt', () => {
    const r = resolveLoginWindowClosed(
      { win: win2, srv: srv2, flow: flow2 },
      { win: win1, srv: srv1, flow: flow1 },
    );
    expect(r.next).toEqual({ win: win2, srv: srv2, flow: flow2 });
    expect(r.closeServer).toBe(false);
    expect(r.cancelFlow).toBe(false);
    expect(r.failLogin).toBe(false);
  });

  it('success path (refs already cleared by closeLoginWindow): no-op', () => {
    const r = resolveLoginWindowClosed(
      { win: null, srv: null, flow: null },
      { win: win1, srv: srv1, flow: flow1 },
    );
    expect(r.next).toEqual({ win: null, srv: null, flow: null });
    expect(r.closeServer).toBe(false);
    expect(r.cancelFlow).toBe(false);
    expect(r.failLogin).toBe(false);
  });

  it('partial replacement (new server, old window/flow): clears only the still-owned refs, never fails the new login', () => {
    const r = resolveLoginWindowClosed(
      { win: win1, srv: srv2, flow: flow1 },
      { win: win1, srv: srv1, flow: flow1 },
    );
    expect(r.next).toEqual({ win: null, srv: srv2, flow: null });
    expect(r.closeServer).toBe(false);
    expect(r.cancelFlow).toBe(true);
    expect(r.failLogin).toBe(false);
  });
});
