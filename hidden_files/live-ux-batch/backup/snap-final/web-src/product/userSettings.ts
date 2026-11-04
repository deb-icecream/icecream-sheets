/**
 * Workspace settings — client session module
 * (hidden_files/workspace-settings/BRIEF.md).
 *
 * Holds the session's copy of the caller's server-persisted settings
 * (fetched from GET /api/settings at login; the SERVER record is the
 * only durable copy — nothing here is persisted to localStorage) and
 * the theme engine:
 *
 *  - choice: 'light' | 'dark' | 'system' (default 'system'), stored in
 *    the record's Icecream Office scope;
 *  - resolution: 'system' follows the OS/browser preference LIVE (a
 *    matchMedia listener repaints when the OS flips mid-session);
 *  - application: a `data-theme` attribute on <html> carrying the
 *    RESOLVED theme; index.css / product.css hang every color off CSS
 *    variables keyed by that attribute, so the Workspace, the sheet
 *    chrome and the (DOM) grid all repaint from one source.
 *
 * Also the presence display-name source: the settings display name is
 * the single source, the sign-in provider's name is the fallback, then
 * the email (brief: presence shows the settings name).
 */

export type ThemeChoice = 'light' | 'dark' | 'system';
export type ResolvedTheme = 'light' | 'dark';

export const DEFAULT_THEME_CHOICE: ThemeChoice = 'system';

export function isThemeChoice(x: unknown): x is ThemeChoice {
  return x === 'light' || x === 'dark' || x === 'system';
}

/** The settings view the gateway returns (GET/PUT /api/settings). */
export interface UserSettingsView {
  /** False when the server has no record yet (client-side defaults). */
  hasRecord: boolean;
  /** Profile display-name override; null = use the provider name. */
  displayName: string | null;
  /** Provider email (read-only identity), when the token carried it. */
  email: string | null;
  /** Provider (Google) display name, when the token carried it. */
  googleName: string | null;
  /** Icecream Office theme choice. */
  theme: ThemeChoice;
}

export function defaultSettingsView(): UserSettingsView {
  return {
    hasRecord: false,
    displayName: null,
    email: null,
    googleName: null,
    theme: DEFAULT_THEME_CHOICE,
  };
}

// ---------------------------------------------------------------------------
// Theme engine
// ---------------------------------------------------------------------------

let currentChoice: ThemeChoice = DEFAULT_THEME_CHOICE;
let mediaQuery: MediaQueryList | null = null;
let listening = false;
const themeListeners = new Set<(resolved: ResolvedTheme) => void>();

function systemPrefersDark(): boolean {
  try {
    return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia('(prefers-color-scheme: dark)').matches
      : false;
  } catch {
    return false;
  }
}

export function resolveTheme(choice: ThemeChoice, prefersDark: boolean): ResolvedTheme {
  return choice === 'system' ? (prefersDark ? 'dark' : 'light') : choice;
}

export function currentThemeChoice(): ThemeChoice {
  return currentChoice;
}

export function resolvedThemeNow(): ResolvedTheme {
  return resolveTheme(currentChoice, systemPrefersDark());
}

function paint(): void {
  const resolved = resolvedThemeNow();
  try {
    if (typeof document !== 'undefined') {
      document.documentElement.dataset['theme'] = resolved;
    }
  } catch {
    // Non-DOM environment (unit tests): resolution still tracked.
  }
  for (const l of [...themeListeners]) {
    try {
      l(resolved);
    } catch {
      // A listener must never break theme application.
    }
  }
}

function ensureMediaListener(): void {
  if (listening) return;
  try {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = (): void => {
      // Only 'system' tracks the OS; an explicit choice is sticky.
      if (currentChoice === 'system') paint();
    };
    if (typeof mediaQuery.addEventListener === 'function') {
      mediaQuery.addEventListener('change', onChange);
    } else if (typeof mediaQuery.addListener === 'function') {
      mediaQuery.addListener(onChange);
    }
    listening = true;
  } catch {
    // No media support: 'system' resolves once, statically.
  }
}

/** Apply a theme choice now (and keep 'system' tracking the OS live). */
export function applyThemeChoice(choice: ThemeChoice): void {
  currentChoice = choice;
  ensureMediaListener();
  paint();
}

/**
 * Startup default for EVERY host mode (web gateway, web local,
 * desktop): resolve 'system' so <html data-theme> is always set and
 * the CSS tokens have a definite palette before any settings load.
 * The gateway-mode shell re-applies the saved choice once the server
 * record arrives.
 */
export function initTheme(): void {
  applyThemeChoice(currentChoice);
}

export function subscribeTheme(listener: (resolved: ResolvedTheme) => void): () => void {
  themeListeners.add(listener);
  return () => {
    themeListeners.delete(listener);
  };
}

// ---------------------------------------------------------------------------
// Session settings + presence name source
// ---------------------------------------------------------------------------

let sessionSettings: UserSettingsView | null = null;
let sessionProfile: { displayName: string | null; email: string | null } | null = null;

export function setSessionSettings(view: UserSettingsView | null): void {
  sessionSettings = view;
}

export function getSessionSettings(): UserSettingsView | null {
  return sessionSettings;
}

/** The sign-in provider's profile for this session (Firebase user). */
export function setSessionProfile(
  profile: { displayName: string | null; email: string | null } | null,
): void {
  sessionProfile = profile;
}

export function getSessionProfile(): { displayName: string | null; email: string | null } | null {
  return sessionProfile;
}

/**
 * THE presence display name: settings override first, provider name
 * second, the email's name part (local part) last. Null when nothing
 * is known — callers must NOT fall back to the principal: the raw
 * UID/subject never renders as a name (D8 ruling, 2026-10-22);
 * participantDisplayName substitutes a neutral label instead.
 */
export function effectiveDisplayName(): string | null {
  const override = sessionSettings?.displayName;
  if (typeof override === 'string' && override.trim().length > 0) return override;
  const provider = sessionProfile?.displayName;
  if (typeof provider === 'string' && provider.trim().length > 0) return provider;
  const email = sessionProfile?.email;
  if (typeof email === 'string' && email.trim().length > 0) {
    return email.trim().split('@')[0] || null;
  }
  return null;
}
