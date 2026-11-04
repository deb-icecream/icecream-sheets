import { memo } from 'react';
import type { CalculationMode, Presence, SupportedLocale } from '@icecream-sheets/engine';
import { SUPPORTED_LOCALES } from '@icecream-sheets/engine';
import { participantDisplayName } from './services/presenceNames';

interface StatusBarProps {
  protocolVersion: number;
  calcMode: CalculationMode;
  address: string;
  lastError: string | null;
  /** Active formula language (track 22). Optional until App wires locale state. */
  formulaLang?: SupportedLocale;
  onFormulaLangChange?: (locale: SupportedLocale) => void;
  /**
   * Live collaborators (track 10); empty when collaboration is local-only.
   * Entries may carry the display name + self marker the collab bridge
   * stamps (#8 residual) — the roster renders names, never principals.
   */
  collaborators?: Array<Presence & { name?: string; isSelf?: boolean }>;
  /** The active sheet is protected (track 19). */
  isProtected?: boolean;
  /** Auto-save state for the visible save indicator. */
  saveState?: 'saved' | 'saving' | 'dirty' | 'error';
  /** The workbook is read-only (no save target): save is disabled. */
  readOnly?: boolean;
  /**
   * Cycle 10 save gating: false while the workbook is still loading.
   * While false the save segment renders DISABLED "Loading…" with the
   * reason — mutation (save, autosave, export) is gated at 100% load.
   */
  workbookLoaded?: boolean;
  /**
   * Streaming-open progress (Phase 4): percent of the workbook the load
   * stream has processed (sheets/cells processed over total cells),
   * driven by the server stream. Renders "Loading… 45%" while loading;
   * at 100% the segment flips to the normal ready state at the SAME
   * moment workbookLoaded flips (one transition, no mismatch).
   */
  loadProgressPct?: number | null;
  /**
   * Data load complete but the engine build (calc) still running: the
   * segment shows "Calculating…" — distinctly, never a stuck percentage.
   */
  loadCalculating?: boolean;
  /**
   * Idle-rule disconnected state (deployment-architecture.md §Idle
   * rule): the engine session was released after the idle timeout and
   * the workbook evicted; editing is blocked (same gate family as
   * workbookLoaded) until a checksum-verified reconnect. Renders a
   * "Disconnected — idle" segment with a Reconnect affordance.
   */
  sessionDisconnected?: boolean;
  /**
   * Transport offline (design doc §7): the collab channel dropped and
   * is reconnecting. Unlike sessionDisconnected this does NOT gate
   * editing — the client keeps working against its mirror and queues
   * ops durably. Issue #100: reconnection is AUTOMATIC (§9 — a
   * refresh is a rejoin event, never a manual recovery), so this
   * segment is informational only and carries NO action button:
   * while unbound it reads "Reconnecting…" and clears on its own
   * when the transport re-lands on the registry owner.
   */
  offline?: boolean;
  /** Why reconnect is blocked (e.g. checksum mismatch), when known. */
  sessionError?: string | null;
  /** Reconnect affordance handler (rehydrate + verify server-side). */
  onReconnect?: () => void;
}

const SAVE_LABEL: Record<NonNullable<StatusBarProps['saveState']>, string> = {
  saved: 'Saved',
  saving: 'Saving…',
  dirty: 'Unsaved changes',
  error: 'Save failed',
};

function StatusBar({
  protocolVersion,
  calcMode,
  address,
  lastError,
  formulaLang = 'enUS',
  onFormulaLangChange,
  collaborators = [],
  isProtected,
  saveState = 'saved',
  readOnly = false,
  workbookLoaded = true,
  loadProgressPct = null,
  loadCalculating = false,
  sessionDisconnected = false,
  offline = false,
  sessionError = null,
  onReconnect,
}: StatusBarProps) {
  const loadingLabel = !workbookLoaded
    ? loadCalculating
      ? '🧮 Calculating…'
      : typeof loadProgressPct === 'number'
        ? `⏳ Loading… ${Math.max(0, Math.min(100, Math.round(loadProgressPct)))}%`
        : '⏳ Loading…'
    : null;
  return (
    <div className="status-bar" role="contentinfo" aria-label="Status bar">
      <span className="status-item">Protocol v{protocolVersion}</span>
      <span className="status-item">Calc: {calcMode}</span>
      <span className="status-item">Cell: {address}</span>
      {isProtected && (
        <span className="status-item" title="The active sheet is protected">
          🔒 Protected
        </span>
      )}
      {readOnly && (
        <span className="status-item" title="This workbook is read-only: it has no save target">
          🔒 Read-only
        </span>
      )}
      {sessionDisconnected && (
        <span
          className="status-item session-disconnected"
          role="alert"
          title={
            sessionError ??
            'Idle timeout: the session was checkpointed and released from the engine. Reconnect to rehydrate it (checksum-verified).'
          }
        >
          ⚠ Disconnected — idle
          {onReconnect && (
            <button type="button" className="session-reconnect" onClick={onReconnect}>
              Reconnect
            </button>
          )}
        </span>
      )}
      {offline && !sessionDisconnected && (
        <span
          className="status-item session-offline"
          title="Connection lost. You can keep editing — changes are queued on this device and sync automatically when the connection returns. Reconnection is automatic; no action is needed."
        >
          ⚠ Offline — reconnecting…
        </span>
      )}
      <span
        className="status-item"
        // Cycle 10 save gating: while the workbook is still loading the
        // save segment shows DISABLED "Loading…" with the reason —
        // save, autosave and export are all blocked until 100% load.
        title={
          !workbookLoaded
            ? loadCalculating
              ? 'Workbook data is loaded — calculation is still running; save is disabled until it completes'
              : 'Workbook is still loading — save is disabled until the load completes'
            : saveState === 'saved'
              ? 'All changes are saved'
              : saveState === 'saving'
                ? 'Saving…'
                : saveState === 'dirty'
                  ? 'You have unsaved changes — they will auto-save'
                  : 'The last save failed'
        }
        aria-live="polite"
      >
        {loadingLabel}
        {workbookLoaded && saveState === 'saved' && '✓ '}
        {workbookLoaded && saveState === 'dirty' && '● '}
        {workbookLoaded && SAVE_LABEL[saveState]}
      </span>
      <label className="status-item" title="Formula language: function names are parsed and displayed in this locale">
        Formula:
        <select
          aria-label="Formula language"
          value={formulaLang}
          onChange={(e) => onFormulaLangChange?.(e.target.value as SupportedLocale)}
          style={{ marginLeft: 4 }}
        >
          {SUPPORTED_LOCALES.map((l) => (
            <option key={l.id} value={l.id}>
              {l.label}
            </option>
          ))}
        </select>
      </label>
      <span className="status-item" title="Active collaborators">
        {collaborators.length === 0 ? (
          '👤 You'
        ) : (
          collaborators.map((p) => {
            // #8 residual: the roster shows the person's NAME (the same
            // participantDisplayName chain the grid markers use); self
            // is listed as name + "(You)". A raw principal/UID must
            // never render — not as the label, not in the tooltip.
            const label = `${participantDisplayName(p)}${p.isSelf ? ' (You)' : ''}`;
            return (
              <span key={p.principal} title={`${label} — ${p.sheet}`} style={{ marginRight: 6 }}>
                <span
                  style={{
                    display: 'inline-block',
                    width: 10,
                    height: 10,
                    borderRadius: '50%',
                    background: p.color,
                    marginRight: 3,
                    verticalAlign: 'baseline',
                  }}
                />
                {label}
              </span>
            );
          })
        )}
      </span>
      {lastError ? (
        <span className="status-item status-error" title={lastError} role="alert">
          {lastError}
        </span>
      ) : (
        <span className="status-item status-ok">Ready</span>
      )}
    </div>
  );
}

/**
 * Memoized (#77 phase 2): every prop is a primitive except the
 * collaborators roster, which App now hands over content-stabilized —
 * so the bar re-renders only when something it displays changes (above
 * all the Cell: address on selection changes), not on unrelated App
 * renders.
 */
export default memo(StatusBar);
