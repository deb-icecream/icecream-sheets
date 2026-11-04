// @vitest-environment jsdom
/**
 * userSettings session module (workspace-settings brief): theme
 * resolution (light/dark/system + live OS tracking + default),
 * application via <html data-theme>, and the presence display-name
 * precedence (settings override → provider name → email).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  applyThemeChoice,
  currentThemeChoice,
  defaultSettingsView,
  effectiveDisplayName,
  resolveTheme,
  resolvedThemeNow,
  setSessionProfile,
  setSessionSettings,
  subscribeTheme,
} from './userSettings';

// One controllable matchMedia for the whole file: the theme engine
// attaches its change listener once, to the first query list it sees.
const mediaState = { dark: false };
const mediaListeners = new Set<() => void>();
const mql = {
  get matches() {
    return mediaState.dark;
  },
  media: '(prefers-color-scheme: dark)',
  addEventListener: (_type: string, fn: () => void) => {
    mediaListeners.add(fn);
  },
  removeEventListener: (_type: string, fn: () => void) => {
    mediaListeners.delete(fn);
  },
  addListener: (fn: () => void) => {
    mediaListeners.add(fn);
  },
  removeListener: (fn: () => void) => {
    mediaListeners.delete(fn);
  },
};
vi.stubGlobal('matchMedia', () => mql);

function flipOs(dark: boolean): void {
  mediaState.dark = dark;
  for (const fn of [...mediaListeners]) fn();
}

afterEach(() => {
  applyThemeChoice('system');
  mediaState.dark = false;
  setSessionSettings(null);
  setSessionProfile(null);
});

describe('resolveTheme', () => {
  it('explicit choices ignore the OS; system follows it', () => {
    expect(resolveTheme('light', true)).toBe('light');
    expect(resolveTheme('light', false)).toBe('light');
    expect(resolveTheme('dark', true)).toBe('dark');
    expect(resolveTheme('dark', false)).toBe('dark');
    expect(resolveTheme('system', true)).toBe('dark');
    expect(resolveTheme('system', false)).toBe('light');
  });

  it('the default choice is system', () => {
    expect(defaultSettingsView().theme).toBe('system');
  });
});

describe('theme application', () => {
  it('sets <html data-theme> to the RESOLVED theme', () => {
    mediaState.dark = false;
    applyThemeChoice('dark');
    expect(document.documentElement.dataset['theme']).toBe('dark');
    expect(resolvedThemeNow()).toBe('dark');
    applyThemeChoice('light');
    expect(document.documentElement.dataset['theme']).toBe('light');
    applyThemeChoice('system');
    expect(document.documentElement.dataset['theme']).toBe('light');
    expect(currentThemeChoice()).toBe('system');
  });

  it('system tracks OS flips live; explicit choices are sticky', () => {
    const seen: string[] = [];
    const unsub = subscribeTheme((r) => seen.push(r));
    applyThemeChoice('system');
    flipOs(true);
    expect(document.documentElement.dataset['theme']).toBe('dark');
    flipOs(false);
    expect(document.documentElement.dataset['theme']).toBe('light');
    expect(seen).toEqual(['light', 'dark', 'light']);

    seen.length = 0;
    applyThemeChoice('dark');
    flipOs(true);
    flipOs(false);
    expect(document.documentElement.dataset['theme']).toBe('dark');
    expect(seen).toEqual(['dark']); // only the explicit application painted
    unsub();
  });
});

describe('effectiveDisplayName (presence source)', () => {
  it('settings override wins over the provider name and email', () => {
    setSessionProfile({ displayName: 'Google Name', email: 'g@example.com' });
    setSessionSettings({ ...defaultSettingsView(), hasRecord: true, displayName: 'Ada L.' });
    expect(effectiveDisplayName()).toBe('Ada L.');
  });

  it('falls back to the provider name, then the email, then null', () => {
    setSessionSettings({ ...defaultSettingsView(), hasRecord: true, displayName: null });
    setSessionProfile({ displayName: 'Google Name', email: 'g@example.com' });
    expect(effectiveDisplayName()).toBe('Google Name');
    setSessionProfile({ displayName: null, email: 'g@example.com' });
    // D8 ruling: the email fallback is the email NAME PART (local
    // part), never the raw principal/id chain.
    expect(effectiveDisplayName()).toBe('g');
    setSessionProfile({ displayName: null, email: null });
    expect(effectiveDisplayName()).toBeNull();
    setSessionProfile(null);
    setSessionSettings(null);
    expect(effectiveDisplayName()).toBeNull();
  });

  it('a blank override counts as no override', () => {
    setSessionSettings({ ...defaultSettingsView(), displayName: '   ' });
    setSessionProfile({ displayName: 'Google Name', email: null });
    expect(effectiveDisplayName()).toBe('Google Name');
  });
});
