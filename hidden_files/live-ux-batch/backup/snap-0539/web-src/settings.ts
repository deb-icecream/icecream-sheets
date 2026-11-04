/**
 * Per-user settings (design-docs/platform-shell.md §4).
 *
 * Settings are per-user preferences in the user profile — NEVER in workbook
 * bytes. A workbook opened by another user never carries the owner's
 * preferences with it. In local mode the profile lives in localStorage
 * under a versioned key; the gateway-backed metadata profile is the same
 * shape (a service metadata store can adopt this type directly).
 */
import type { CalculationMode, SupportedLocale } from '@icecream-sheets/engine';
import { applyThemeChoice } from './product/userSettings';

export type ThemeChoice = 'light' | 'dark' | 'system';

export interface UserSettings {
  version: 1;
  theme: ThemeChoice;
  /** Formula language — wires to localization (engine setFormulaLanguage). */
  formulaLanguage: SupportedLocale;
  calculationMode: CalculationMode;
  /**
   * Multithreading / mirror cell-count threshold (Cycle 10, user's final
   * rule — ONE FLAG, TWO CONSEQUENCES). Workbook cell count above this →
   * no local mirror (every edit routes to the server) + server-side
   * multithreaded recalc; at or below → full local mirror + local routing
   * rules, server single-thread. Default 5000 (P75-scale starting point,
   * tuned from Phase 4 measurements). The env override
   * ICECREAM_MT_CELL_COUNT_THRESHOLD stays canonical (wins over this
   * field when set).
   */
  mtCellCountThreshold: number;
  defaultZoom: number;
  showGridlines: boolean;
  showFormulaBar: boolean;
  /**
   * Display locale for number/date/currency rendering (e.g. 'en-US', 'de-DE').
   * User-level preference, never stored in workbook bytes. Rich types
   * (currency symbol, decimal/thousands separators, date order) read this.
   */
  locale: string;
}

export const DEFAULT_SETTINGS: UserSettings = {
  version: 1,
  theme: 'light',
  formulaLanguage: 'enUS',
  calculationMode: 'automatic',
  mtCellCountThreshold: 5000,
  defaultZoom: 1,
  showGridlines: true,
  showFormulaBar: true,
  locale: 'en-US',
};

const STORAGE_KEY = 'icecream.settings.v1';

export function loadSettings(): UserSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    const parsed = JSON.parse(raw) as Partial<UserSettings>;
    if (parsed.version !== 1) return { ...DEFAULT_SETTINGS };
    const merged = { ...DEFAULT_SETTINGS, ...parsed, version: 1 } as UserSettings;
    // A corrupt threshold in the profile must never break the auto-flag.
    if (!Number.isFinite(merged.mtCellCountThreshold) || merged.mtCellCountThreshold < 1) {
      merged.mtCellCountThreshold = DEFAULT_SETTINGS.mtCellCountThreshold;
    } else {
      merged.mtCellCountThreshold = Math.floor(merged.mtCellCountThreshold);
    }
    return merged;
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(settings: UserSettings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...settings, version: 1 }));
  } catch {
    // Private browsing etc.: the choice just won't persist.
  }
}

/**
 * Apply the theme choice to the document — through the ONE theme engine
 * (product/userSettings): <html data-theme> always carries the RESOLVED
 * theme and the module's current choice stays in step, so the DOM, the
 * canvas grid (which reads resolvedThemeNow) and every subscriber agree.
 * This module previously painted the attribute itself and DELETED it for
 * light — a second writer with different semantics, which let the sheet
 * view and the shell disagree about the theme (#38).
 */
export function applyTheme(theme: ThemeChoice): void {
  applyThemeChoice(theme);
}

/**
 * The theme stored in the local profile, or null when no profile has
 * been stored yet. Boot uses it to paint the last-known choice before
 * first paint (the gateway shell mirrors the authoritative server choice
 * into the profile whenever it lands — see App.tsx), so a refresh never
 * flashes the 'system' default at a user with a saved choice (#38).
 */
export function storedProfileTheme(): ThemeChoice | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<UserSettings>;
    return parsed.theme === 'dark' || parsed.theme === 'light' || parsed.theme === 'system'
      ? parsed.theme
      : null;
  } catch {
    return null;
  }
}
