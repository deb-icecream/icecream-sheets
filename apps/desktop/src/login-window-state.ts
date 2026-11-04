/**
 * Login-window closed-handler resolution (#102: the retry race).
 *
 * Electron fires a window's 'closed' event asynchronously after
 * close() returns. A user who closes the sign-in window and retries
 * immediately can therefore create a NEW window/server/flow BEFORE
 * the OLD window's 'closed' handler runs. The old handler used to
 * clear the module refs unconditionally — nuking the new attempt's
 * loopback server and browser flow, and failing a login that belongs
 * to the retry, not to the closed window.
 *
 * This module owns ONLY that decision, so it is unit-testable without
 * booting Electron: given the refs as they stand now and the refs the
 * closed window captured when it was created, decide which refs still
 * belong to the closed window (clear/close/cancel those) and whether
 * the closed window's attempt is still the live one (only then may
 * its handler fail the login — a replaced anything means a newer
 * attempt owns the phase and must survive untouched).
 */

export interface LoginWindowRefs<W, S, F> {
  win: W | null;
  srv: S | null;
  flow: F | null;
}

export interface LoginWindowClosedResolution<W, S, F> {
  /** Refs after clearing exactly the ones the closed window still owns. */
  next: LoginWindowRefs<W, S, F>;
  /** Close the captured server (it still belongs to the closed window). */
  closeServer: boolean;
  /** Cancel the captured browser flow (it still belongs to the closed window). */
  cancelFlow: boolean;
  /**
   * Fail the login (the closed window's attempt is fully intact — its
   * window, server and flow are all still the live ones). False whenever
   * any ref was replaced: a newer attempt owns the phase.
   */
  failLogin: boolean;
}

export function resolveLoginWindowClosed<W, S, F>(
  current: LoginWindowRefs<W, S, F>,
  closed: LoginWindowRefs<W, S, F>,
): LoginWindowClosedResolution<W, S, F> {
  const winCurrent = current.win === closed.win;
  const srvCurrent = current.srv === closed.srv;
  const flowCurrent = current.flow === closed.flow;
  return {
    next: {
      win: winCurrent ? null : current.win,
      srv: srvCurrent ? null : current.srv,
      flow: flowCurrent ? null : current.flow,
    },
    closeServer: srvCurrent && closed.srv !== null,
    cancelFlow: flowCurrent && closed.flow !== null,
    failLogin: winCurrent && srvCurrent && flowCurrent,
  };
}
