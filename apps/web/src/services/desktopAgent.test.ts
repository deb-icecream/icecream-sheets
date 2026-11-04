/**
 * Desktop auth bridge tests (issue #89).
 *
 * The main process publishes auth transitions on 'auth:changed' with
 * its DesktopAuthState snapshot shape — { phase, principal, error } —
 * while subscribers consume { loggedIn, principal } (the shape the
 * auth:status IPC returns). onDesktopAuthChanged must normalize at the
 * ingestion point: before the fix, the App read `loggedIn` off the
 * phase-shaped payload, got `undefined` forever, and the post-login
 * live transition to the Workspace never fired (only a manual Reload,
 * which re-asks via auth:status, recovered it).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { normalizeDesktopAuthSnapshot, onDesktopAuthChanged } from './desktopAgent';

type WireSnapshot = { phase?: string; principal: string | null; error?: string | null };

function installBridge() {
  let listener: ((snap: WireSnapshot) => void) | null = null;
  const bridge = {
    auth: {
      status: vi.fn(async () => ({ loggedIn: false, principal: null })),
      openLoginWindow: vi.fn(async () => undefined),
      onAuthChanged: (cb: (snap: WireSnapshot) => void) => {
        listener = cb as (snap: WireSnapshot) => void;
        return () => {
          listener = null;
        };
      },
    },
    svc: { call: vi.fn(async () => null) },
    mcp: { url: vi.fn(async () => '') },
  };
  vi.stubGlobal('window', { icecreamDesktop: bridge });
  return {
    emit: (snap: WireSnapshot) => listener?.(snap),
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('normalizeDesktopAuthSnapshot', () => {
  it('maps the wire phase shape (what main actually sends)', () => {
    expect(normalizeDesktopAuthSnapshot({ phase: 'logged-in', principal: 'a@b.c', error: null })).toEqual({
      loggedIn: true,
      principal: 'a@b.c',
    });
    expect(normalizeDesktopAuthSnapshot({ phase: 'logging-in', principal: null, error: null })).toEqual({
      loggedIn: false,
      principal: null,
    });
    expect(normalizeDesktopAuthSnapshot({ phase: 'logged-out', principal: null, error: null })).toEqual({
      loggedIn: false,
      principal: null,
    });
  });

  it('passes through the status shape when a publisher sends it', () => {
    expect(normalizeDesktopAuthSnapshot({ loggedIn: true, principal: 'a@b.c' })).toEqual({
      loggedIn: true,
      principal: 'a@b.c',
    });
    expect(normalizeDesktopAuthSnapshot({ loggedIn: false, principal: null })).toEqual({
      loggedIn: false,
      principal: null,
    });
  });
});

describe('onDesktopAuthChanged', () => {
  it('delivers loggedIn=true when the shell completes a sign-in (issue #89)', () => {
    const { emit } = installBridge();
    const seen: Array<{ loggedIn: boolean; principal: string | null }> = [];
    const unsub = onDesktopAuthChanged((s) => seen.push(s));
    // The exact payload DesktopAuthState.snapshot() produces on
    // completeLogin — phase-shaped, no loggedIn field.
    emit({ phase: 'logged-in', principal: 'debajyoti@example.com', error: null });
    expect(seen).toEqual([{ loggedIn: true, principal: 'debajyoti@example.com' }]);
    // And the reverse transition on sign-out.
    emit({ phase: 'logged-out', principal: null, error: null });
    expect(seen[1]).toEqual({ loggedIn: false, principal: null });
    unsub();
  });
});

describe('desktopSyncExtras serverHosted passthrough (#103)', () => {
  it('forwards the serverHosted flag to the bridge, and omits it when unknown', async () => {
    const { desktopSyncExtras } = await import('./desktopAgent');
    const syncSessionExtras = vi.fn(async () => ({ extrasDirty: false }));
    vi.stubGlobal('window', { icecreamDesktop: { file: { syncSessionExtras } } });
    const extras = { extraMetadata: {}, definedNames: {}, sheetDims: {}, sheetStyles: {} };
    try {
      await desktopSyncExtras(extras, true);
      expect(syncSessionExtras).toHaveBeenCalledWith(extras, true);
      await desktopSyncExtras(extras);
      expect(syncSessionExtras).toHaveBeenLastCalledWith(extras, undefined);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
