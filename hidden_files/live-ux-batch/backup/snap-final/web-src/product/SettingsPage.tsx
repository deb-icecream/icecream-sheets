/**
 * Workspace Settings PAGE (hidden_files/workspace-redesign/BRIEF.md).
 *
 * A dedicated page in the Workspace shell — NOT a panel inside the
 * file list (the pre-redesign SettingsPanel presentation is gone).
 * The gear icon in the Workspace header navigates here; a Back
 * affordance returns to the file list. Semantics are exactly the
 * workspace-settings brief's, unchanged:
 *
 *  - User settings: display name (editable; default = the name the
 *    sign-in provider supplied; this name is what co-authoring
 *    presence shows) and email (READ-ONLY and DISABLED — visibly
 *    greyed, not focusable — because identity is owned by the Google
 *    account; the gateway also rejects email changes outright).
 *  - App settings — labeled Icecream Office, because the record's
 *    `office` scope is suite-wide (Sheets today; Presentations and
 *    Documents later share it): theme Light / Dark / System.
 *
 *  Privacy: "Delete my profile and data" — ONE in-app confirmation
 *  dialog (this component's own modal; never window.confirm/alert),
 *  then one action: server-side deletion → Firebase account deletion
 *  attempt → sign out to the landing page.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ProductApi } from './productApi';
import {
  applyThemeChoice,
  defaultSettingsView,
  resolvedThemeNow,
  setSessionSettings,
  type ThemeChoice,
  type UserSettingsView,
} from './userSettings';
import { loadSettings, saveSettings } from '../settings';

export type FirebaseDeleteOutcome = 'deleted' | 'failed' | 'not-applicable';

export interface SettingsPageProps {
  api: ProductApi;
  /** Sign-in provider profile: the display-name default + email. */
  profileEmail: string | null;
  profileName: string | null;
  /**
   * The Firebase leg of account deletion (owned by the app shell,
   * which owns the auth service). Resolves with the outcome; never
   * throws.
   */
  onFirebaseDelete: () => Promise<FirebaseDeleteOutcome>;
  /** Finish: sign out and land on the public landing page. */
  onSignedOut: () => void;
  /** Back to the Workspace file list. */
  onBack: () => void;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

const THEME_OPTIONS: Array<{ value: ThemeChoice; label: string; hint: string }> = [
  { value: 'light', label: 'Light', hint: 'Always use the light theme.' },
  { value: 'dark', label: 'Dark', hint: 'Always use the dark theme.' },
  { value: 'system', label: 'System', hint: 'Follow your device’s light/dark setting.' },
];

export function SettingsPage({
  api,
  profileEmail,
  profileName,
  onFirebaseDelete,
  onSignedOut,
  onBack,
}: SettingsPageProps) {
  const [view, setView] = useState<UserSettingsView | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [nameInput, setNameInput] = useState('');
  const [savingName, setSavingName] = useState(false);
  const [nameSaved, setNameSaved] = useState(false);
  const [savingTheme, setSavingTheme] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [firebaseFailed, setFirebaseFailed] = useState(false);
  const cancelRef = useRef<HTMLButtonElement | null>(null);

  const load = useCallback(async () => {
    try {
      const v = await api.getSettings();
      setView(v);
      setSessionSettings(v);
      setNameInput(v.displayName ?? '');
      setLoadError(null);
    } catch (err) {
      setLoadError(errorMessage(err));
      setView(defaultSettingsView());
    }
  }, [api]);

  useEffect(() => {
    void load();
  }, [load]);

  // Focus the dialog's safe action when it opens (keyboard users land
  // on Cancel, never on the destructive button).
  useEffect(() => {
    if (confirmOpen) cancelRef.current?.focus();
  }, [confirmOpen]);

  const googleName = view?.googleName ?? profileName;
  const email = view?.email ?? profileEmail;
  const effectiveName = view?.displayName ?? googleName ?? null;

  const handleSaveName = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!view) return;
    setSavingName(true);
    setNameSaved(false);
    setActionError(null);
    try {
      const next = await api.updateSettings({ displayName: nameInput });
      setView(next);
      // The session module is the presence name source: the new name
      // rides the next presence posts (live sessions pick it up on
      // the heartbeat; new joins use it from the start).
      setSessionSettings(next);
      setNameSaved(true);
    } catch (err) {
      setActionError(errorMessage(err));
    } finally {
      setSavingName(false);
    }
  };

  const handleTheme = async (theme: ThemeChoice) => {
    if (!view || theme === view.theme) return;
    setSavingTheme(true);
    setActionError(null);
    // Apply immediately for responsiveness; the save below is the
    // durable copy. On failure the reload restores the server's view.
    applyThemeChoice(theme);
    try {
      const next = await api.updateSettings({ theme });
      setView(next);
      setSessionSettings(next);
      applyThemeChoice(next.theme);
      // Mirror into the local profile (boot cache + the spreadsheet's
      // own settings state) so no surface can resurrect a stale theme
      // after a refresh (#38).
      saveSettings({ ...loadSettings(), theme: next.theme });
    } catch (err) {
      setActionError(errorMessage(err));
      void load();
    } finally {
      setSavingTheme(false);
    }
  };

  const handleConfirmDelete = async () => {
    setDeleting(true);
    setActionError(null);
    try {
      // 1) Server-side deletion (throws → nothing else runs; the user
      //    stays signed in with data intact).
      await api.deleteAccount();
    } catch (err) {
      setDeleting(false);
      setConfirmOpen(false);
      setActionError(`Could not delete your data: ${errorMessage(err)}`);
      return;
    }
    // Our data is gone. Clear the local settings copy + theme back to
    // the default before signing out.
    setSessionSettings(null);
    // 2) Firebase sign-in account attempt (same confirmed flow).
    let outcome: FirebaseDeleteOutcome;
    try {
      outcome = await onFirebaseDelete();
    } catch {
      outcome = 'failed';
    }
    setDeleting(false);
    if (outcome === 'failed') {
      // Honest result state: our data IS deleted; only the sign-in
      // account remains. One Continue completes the sign-out.
      setFirebaseFailed(true);
      return;
    }
    // 3) Sign out → landing page, logged out.
    onSignedOut();
  };

  return (
    <div className="ics-settings-page">
      <div className="ics-settings-page-head">
        <button type="button" className="ics-back-btn" onClick={onBack}>
          <span aria-hidden="true">←</span> Back to workspace
        </button>
        <h1 className="ics-settings-page-title" id="ics-settings-title">
          Settings
        </h1>
      </div>

      {loadError && (
        <div className="ics-alert" role="alert">
          Couldn&rsquo;t load your settings: {loadError}{' '}
          <button type="button" className="ics-btn ics-btn-small" onClick={() => void load()}>
            Try again
          </button>
        </div>
      )}
      {actionError && (
        <div className="ics-alert" role="alert">
          {actionError}
        </div>
      )}
      {firebaseFailed && (
        <div className="ics-alert" role="alert">
          Your Icecream Office profile, settings, files and shares have been deleted. Your
          sign-in account itself could not be deleted — it needs a fresh sign-in to confirm
          it&rsquo;s you — so you can remove it from your sign-in provider&rsquo;s account
          settings instead. If you sign in here again you&rsquo;ll start with a fresh, empty
          account.{' '}
          <button type="button" className="ics-btn ics-btn-small" onClick={onSignedOut}>
            Continue to sign out
          </button>
        </div>
      )}

      <div className="ics-settings-stack">
        <fieldset className="ics-settings-card">
          <legend className="ics-settings-card-title">User settings</legend>

          <form onSubmit={(event) => void handleSaveName(event)}>
            <label className="ics-settings-label" htmlFor="ics-settings-name">
              Display name
            </label>
            <div className="ics-settings-name-row">
              <input
                id="ics-settings-name"
                className="ics-input"
                type="text"
                value={nameInput}
                placeholder={googleName ?? 'Your name'}
                maxLength={120}
                onChange={(event) => {
                  setNameInput(event.target.value);
                  setNameSaved(false);
                }}
              />
              <button type="submit" className="ics-btn" disabled={savingName || !view}>
                {savingName ? 'Saving…' : 'Save name'}
              </button>
            </div>
            <p className="ics-settings-note">
              This is the name other people see when you work on a file together.
              {googleName
                ? ` Left blank, your sign-in name (${googleName}) is used.`
                : ' Left blank, your sign-in name is used.'}
              {effectiveName ? ` Currently shown as: ${effectiveName}.` : ''}
              {nameSaved ? ' Saved.' : ''}
            </p>
          </form>

          <div>
            <label className="ics-settings-label" htmlFor="ics-settings-email">
              Email
            </label>
            <input
              id="ics-settings-email"
              className="ics-input ics-input-disabled"
              type="email"
              value={email ?? ''}
              placeholder="—"
              readOnly
              disabled
              aria-readonly="true"
            />
            <p className="ics-settings-note">
              Your email comes from your Google account and can&rsquo;t be changed here.
            </p>
          </div>

          <div className="ics-settings-danger">
            <h3 className="ics-settings-danger-title">Privacy</h3>
            <p className="ics-settings-note">
              Delete your profile and all of your data stored with Icecream Office — your
              settings, files and shares. This cannot be undone.
            </p>
            <button
              type="button"
              className="ics-btn ics-btn-danger"
              onClick={() => setConfirmOpen(true)}
            >
              Delete my profile and data
            </button>
          </div>
        </fieldset>

        <fieldset className="ics-settings-card">
          <legend className="ics-settings-card-title">App settings — Icecream Office</legend>
          <p className="ics-settings-note">
            These settings apply to every Icecream Office app (Sheets today; Presentations and
            Documents will share them).
          </p>
          <span className="ics-settings-label" id="ics-theme-label">
            Theme
          </span>
          <div role="radiogroup" aria-labelledby="ics-theme-label" className="ics-theme-options">
            {THEME_OPTIONS.map((opt) => (
              <label key={opt.value} className="ics-theme-option">
                <input
                  type="radio"
                  name="ics-office-theme"
                  value={opt.value}
                  checked={view?.theme === opt.value}
                  disabled={savingTheme || !view}
                  onChange={() => void handleTheme(opt.value)}
                />
                <span>
                  <strong>{opt.label}</strong>
                  <span className="ics-settings-note"> — {opt.hint}</span>
                </span>
              </label>
            ))}
          </div>
          <p className="ics-settings-note">
            Currently showing: {resolvedThemeNow() === 'dark' ? 'Dark' : 'Light'}.
          </p>
        </fieldset>
      </div>

      {confirmOpen && (
        <div className="ics-dialog-backdrop">
          <div
            className="ics-dialog"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="ics-delete-title"
            aria-describedby="ics-delete-desc"
          >
            <h2 className="ics-dialog-title" id="ics-delete-title">
              Delete your profile and data?
            </h2>
            <p id="ics-delete-desc">
              This permanently deletes your Icecream Office profile, your settings, every file
              in your workspace (including uploaded files), and every app share you created.
              We&rsquo;ll also delete your sign-in account as part of this action — you may be
              asked to sign in once more to confirm it&rsquo;s you. This cannot be undone.
            </p>
            <div className="ics-dialog-actions">
              <button
                type="button"
                className="ics-btn"
                ref={cancelRef}
                disabled={deleting}
                onClick={() => setConfirmOpen(false)}
              >
                Cancel
              </button>
              <button
                type="button"
                className="ics-btn ics-btn-danger"
                disabled={deleting}
                onClick={() => void handleConfirmDelete()}
              >
                {deleting ? 'Deleting…' : 'Yes, delete my profile and data'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
