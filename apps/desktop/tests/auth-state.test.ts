/**
 * Desktop auth state machine tests (Cycle 9: desktop login).
 *
 * logged-out → logging-in → logged-in → logged-out, with explicit failure
 * handling (popup blocked, network failure, missing config, cancelled).
 */
import { describe, expect, it, vi } from 'vitest';
import { DesktopAuthState } from '../src/auth-state.js';

describe('DesktopAuthState', () => {
  it('starts logged-out with no principal', () => {
    const s = new DesktopAuthState();
    expect(s.snapshot()).toEqual({ phase: 'logged-out', principal: null, error: null });
  });

  it('restores the logged-in phase from a persisted session', () => {
    const s = new DesktopAuthState({ loggedIn: true, principal: 'user:alice' });
    expect(s.snapshot().phase).toBe('logged-in');
    expect(s.snapshot().principal).toBe('user:alice');
  });

  it('walks the full happy path: logged-out → logging-in → logged-in → logged-out', () => {
    const s = new DesktopAuthState();
    const seen: string[] = [];
    s.onChange((snap) => seen.push(snap.phase));

    s.beginLogin();
    expect(s.snapshot().phase).toBe('logging-in');

    s.completeLogin('user:alice@example.com');
    expect(s.snapshot()).toEqual({
      phase: 'logged-in',
      principal: 'user:alice@example.com',
      error: null,
    });

    s.logout();
    expect(s.snapshot()).toEqual({ phase: 'logged-out', principal: null, error: null });
    expect(seen).toEqual(['logging-in', 'logged-in', 'logged-out']);
  });

  it('records the failure reason on failLogin (popup blocked / network / config / cancel)', () => {
    for (const reason of [
      'The Google sign-in popup was blocked. Allow popups for this window and try again.',
      'sign-in failed: could not reach the gateway at http://localhost:8100 (network failure): fetch failed',
      'Firebase Auth is not configured. Set the ICECREAM_FIREBASE_CONFIG environment variable (JSON)',
      'Sign-in was cancelled before completing.',
    ]) {
      const s = new DesktopAuthState();
      s.beginLogin();
      s.failLogin(reason);
      const snap = s.snapshot();
      expect(snap.phase).toBe('logged-out');
      expect(snap.error).toBe(reason);
      expect(snap.principal).toBeNull();
    }
  });

  it('clears a previous error when a new login begins', () => {
    const s = new DesktopAuthState();
    s.beginLogin();
    s.failLogin('boom');
    expect(s.snapshot().error).toBe('boom');
    s.beginLogin();
    expect(s.snapshot().error).toBeNull();
    expect(s.snapshot().phase).toBe('logging-in');
  });

  it('failLogin is a no-op when nothing is in flight — never knocks out a live session', () => {
    const s = new DesktopAuthState();
    s.beginLogin();
    s.completeLogin('user:alice');
    // A late popup-close event arriving after success must not log out.
    s.failLogin('Sign-in was cancelled before completing.');
    expect(s.snapshot().phase).toBe('logged-in');
    expect(s.snapshot().principal).toBe('user:alice');
  });

  it('rejects illegal transitions loudly', () => {
    const s = new DesktopAuthState();
    expect(() => s.completeLogin('user:x')).toThrow(/no login in flight/);
    s.beginLogin();
    expect(() => s.beginLogin()).toThrow(/already in progress/);
    s.completeLogin('user:x');
    expect(() => s.beginLogin()).toThrow(/already logged in/);
  });

  it('beginOrJoinLogin begins from logged-out exactly like beginLogin (#83)', () => {
    const s = new DesktopAuthState();
    s.beginLogin();
    s.failLogin('boom');
    const seen: string[] = [];
    s.onChange((snap) => seen.push(snap.phase));
    s.beginOrJoinLogin();
    expect(s.snapshot()).toEqual({ phase: 'logging-in', principal: null, error: null });
    expect(seen).toEqual(['logging-in']);
  });

  it('beginOrJoinLogin JOINS an in-flight login — no throw, no duplicate transition (#83)', () => {
    const s = new DesktopAuthState();
    const seen: string[] = [];
    s.onChange((snap) => seen.push(snap.phase));
    s.beginLogin(); // the window flow's owner (openLoginWindow) marks it
    expect(() => s.beginOrJoinLogin()).not.toThrow();
    expect(s.snapshot().phase).toBe('logging-in');
    // Joining is not a transition: subscribers saw the begin exactly once.
    expect(seen).toEqual(['logging-in']);
    // …and the joined flow still completes normally.
    s.completeLogin('user:alice');
    expect(s.snapshot().phase).toBe('logged-in');
  });

  it('beginOrJoinLogin still refuses to start over a live session', () => {
    const s = new DesktopAuthState({ loggedIn: true, principal: 'user:alice' });
    expect(() => s.beginOrJoinLogin()).toThrow(/already logged in/);
    expect(s.snapshot().phase).toBe('logged-in');
  });

  it('logout from logging-in drops back to logged-out', () => {
    const s = new DesktopAuthState();
    s.beginLogin();
    s.logout();
    expect(s.snapshot().phase).toBe('logged-out');
  });

  it('unsubscribe stops notifications; a throwing listener does not break the machine', () => {
    const s = new DesktopAuthState();
    const good = vi.fn();
    const unsub = s.onChange(good);
    s.onChange(() => {
      throw new Error('listener bug');
    });
    s.beginLogin();
    expect(good).toHaveBeenCalledTimes(1);
    unsub();
    s.completeLogin('user:x');
    expect(good).toHaveBeenCalledTimes(1);
    expect(s.snapshot().phase).toBe('logged-in');
  });
});
