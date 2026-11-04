/**
 * Tests for per-user settings (platform-shell.md §4): defaults, round-trip
 * persistence, and graceful degradation without storage.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS, loadSettings, saveSettings } from './settings';

function stubLocalStorage() {
  const store = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  });
}

beforeEach(() => {
  vi.unstubAllGlobals();
  stubLocalStorage();
});

describe('settings', () => {
  it('returns defaults when nothing is stored', () => {
    expect(loadSettings()).toEqual(DEFAULT_SETTINGS);
  });

  it('round-trips through the profile store', () => {
    saveSettings({ ...DEFAULT_SETTINGS, theme: 'dark', formulaLanguage: 'frFR', calculationMode: 'manual' });
    const loaded = loadSettings();
    expect(loaded.theme).toBe('dark');
    expect(loaded.formulaLanguage).toBe('frFR');
    expect(loaded.calculationMode).toBe('manual');
  });

  it('falls back to defaults on corrupt or version-mismatched data', () => {
    localStorage.setItem('icecream.settings.v1', 'not json{');
    expect(loadSettings()).toEqual(DEFAULT_SETTINGS);
    localStorage.setItem('icecream.settings.v1', JSON.stringify({ version: 99, theme: 'dark' }));
    expect(loadSettings()).toEqual(DEFAULT_SETTINGS);
  });

  it('does not throw when storage is unavailable', () => {
    vi.unstubAllGlobals();
    expect(loadSettings()).toEqual(DEFAULT_SETTINGS);
    expect(() => saveSettings(DEFAULT_SETTINGS)).not.toThrow();
  });
});
