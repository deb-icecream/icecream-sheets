/**
 * Extensions > Triggers (design-docs/automation-lane.md §3; build
 * contract: hidden_files/triggers/REPORT.md "HTTP contract").
 *
 * Lists the open workbook's triggers (name, event, scope, enabled,
 * last fired, last run outcome, grant state), creates new ones with
 * per-event sandbox templates and a declared-permissions editor, and
 * drives enable/disable, delete, and the §1 permission grant flow.
 *
 * Mirrors ScriptEditor's dialog patterns: the shared A11yDialog shell
 * (role=dialog, aria-modal, labelled title, Escape to close, focus
 * trap), the same button styles, and plain-language state text. The
 * event select offers ONLY the events the current transport's list
 * result reports as fireable — a topology that cannot fire an event
 * never offers it. With no transport (no hosted session) the dialog
 * says so honestly instead of showing fake data.
 */
import { useCallback, useEffect, useId, useState } from 'react';
import type {
  DeclaredPermission,
  TriggerEvent,
  TriggerLanguage,
  TriggerSpecInit,
  TriggerStatus,
  TriggerTransport,
} from '../features/triggers';
import {
  TRIGGER_EVENT_LABELS,
  defaultTriggerPermissions,
  parseTriggerRange,
  rangeToA1,
  triggerTemplate,
} from '../features/triggers';
import A11yDialog from './A11yDialog';

interface TriggersDialogProps {
  /** Null when neither a desktop bridge nor a gateway session exists. */
  transport: TriggerTransport | null;
  onClose: () => void;
}

const btn: React.CSSProperties = {
  padding: '6px 12px',
  border: '1px solid #c8c8c8',
  borderRadius: 4,
  background: '#fff',
  cursor: 'pointer',
  fontSize: 13,
};

const primaryBtn: React.CSSProperties = {
  ...btn,
  background: '#2b579a',
  borderColor: '#2b579a',
  color: '#fff',
  fontWeight: 600,
};

const fieldLabel: React.CSSProperties = { display: 'block', fontSize: 12, fontWeight: 600, marginBottom: 4 };
const fieldInput: React.CSSProperties = {
  width: '100%',
  boxSizing: 'border-box',
  padding: '6px 8px',
  fontSize: 13,
  border: '1px solid #c8c8c8',
  borderRadius: 4,
};

function plainError(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function scopeText(t: TriggerStatus): string {
  if (t.range) return rangeToA1(t.range);
  if (t.sheet) return t.sheet;
  return 'Whole workbook';
}

function lastRunText(t: TriggerStatus): string {
  if (!t.lastRun) return 'Has not run yet';
  if (t.lastRun.ok) return `Last run succeeded (${t.lastRun.durationMs} ms)`;
  return `Last run failed: ${t.lastRun.error ?? 'unknown error'}`;
}

export default function TriggersDialog({ transport, onClose }: TriggersDialogProps) {
  const formId = useId().replace(/[^a-zA-Z0-9]/g, '');
  const [events, setEvents] = useState<string[]>([]);
  const [triggers, setTriggers] = useState<TriggerStatus[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  // Create-form state.
  const [name, setName] = useState('');
  const [event, setEvent] = useState<string>('');
  const [language, setLanguage] = useState<TriggerLanguage>('javascript');
  const [sheet, setSheet] = useState('');
  const [rangeText, setRangeText] = useState('');
  const [intervalSec, setIntervalSec] = useState('60');
  const [atTime, setAtTime] = useState('');
  const [script, setScript] = useState('');
  const [permissions, setPermissions] = useState<DeclaredPermission[]>(() => defaultTriggerPermissions());

  const refresh = useCallback(async () => {
    if (!transport) return;
    setLoading(true);
    try {
      const res = await transport.list();
      setEvents(res.events);
      setTriggers(res.triggers);
      setError(null);
    } catch (e) {
      setError(`Could not load triggers: ${plainError(e)}`);
    } finally {
      setLoading(false);
    }
  }, [transport]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Seed the create form from the capability list: default the event to
  // the first fireable one and prefill its template (until the user has
  // typed a script of their own).
  useEffect(() => {
    if (!event && events.length > 0) {
      const first = events[0]!;
      setEvent(first);
      setScript((s) => s || triggerTemplate(first, language));
    }
  }, [events, event, language]);

  const onEventChange = useCallback(
    (next: string) => {
      setEvent(next);
      setScript(triggerTemplate(next, language));
    },
    [language],
  );

  const onLanguageChange = useCallback(
    (next: TriggerLanguage) => {
      setLanguage(next);
      if (event) setScript(triggerTemplate(event, next));
    },
    [event],
  );

  const runRowAction = useCallback(
    async (id: string, action: () => Promise<void>, failure: string) => {
      if (!transport) return;
      setBusyId(id);
      try {
        await action();
        await refresh();
      } catch (e) {
        setError(`${failure}: ${plainError(e)}`);
      } finally {
        setBusyId(null);
      }
    },
    [transport, refresh],
  );

  const onCreate = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      if (!transport || creating) return;
      if (!name.trim()) {
        setError('Give the trigger a name first.');
        return;
      }
      if (!event) {
        setError('This session cannot fire any trigger events, so there is nothing to create yet.');
        return;
      }
      if (!script.trim()) {
        setError('The trigger script is empty — write a script or pick an event to load its template.');
        return;
      }
      const spec: TriggerSpecInit = {
        name: name.trim(),
        event: event as TriggerEvent,
        language,
        script,
        permissions: permissions.filter((p) => p.action.trim() && p.target.trim()),
      };
      const sheetName = sheet.trim();
      const rangeInput = rangeText.trim();
      if (rangeInput) {
        const range = parseTriggerRange(rangeInput, sheetName || undefined);
        if (!range) {
          setError(`"${rangeInput}" is not a range I can read — use A1 style, like A1:B2 or Sheet1!A1:B2.`);
          return;
        }
        spec.range = range;
        spec.sheet = range.sheet;
      } else if (sheetName) {
        spec.sheet = sheetName;
      }
      if (event === 'onInterval') {
        const seconds = Number(intervalSec);
        if (!Number.isFinite(seconds) || seconds < 1) {
          setError('Interval triggers need an interval of at least 1 second.');
          return;
        }
        spec.intervalMs = Math.round(seconds * 1000);
      }
      if (event === 'onAtTime') {
        const when = atTime ? new Date(atTime) : null;
        if (!when || Number.isNaN(when.getTime())) {
          setError('Pick the date and time this trigger should fire.');
          return;
        }
        spec.atTimeIso = when.toISOString();
      }
      setCreating(true);
      try {
        await transport.create(spec);
        setName('');
        setRangeText('');
        setSheet('');
        await refresh();
      } catch (err) {
        setError(`Could not create the trigger: ${plainError(err)}`);
      } finally {
        setCreating(false);
      }
    },
    [transport, creating, name, event, language, script, permissions, sheet, rangeText, intervalSec, atTime, refresh],
  );

  return (
    <A11yDialog
      title={
        <>
          Triggers
          <span className="scripteditor-subtitle">
            Automation lane — triggers run through the permissioned automation API
          </span>
        </>
      }
      onClose={onClose}
      width="min(900px, 96vw)"
      className="triggers-dialog"
      data-testid="triggers-dialog"
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12, padding: 12, overflowY: 'auto', minHeight: 0 }}>
        {!transport ? (
          <p style={{ fontSize: 13, color: '#444' }} data-testid="triggers-no-transport">
            Triggers need a hosted session. Open a workbook through the hosted app (or the desktop
            app) and this list will show the triggers that run when its cells change, when it
            opens, and on a schedule. Nothing is stored in this browser tab, so there is nothing
            to show here yet.
          </p>
        ) : (
          <>
            {error && (
              <div
                role="alert"
                style={{ fontSize: 13, color: '#7f1d1d', background: '#fef2f2', border: '1px solid #f0c36d', borderRadius: 4, padding: 8 }}
              >
                {error}
              </div>
            )}

            {/* Existing triggers */}
            <section aria-label="Existing triggers">
              <h3 style={{ fontSize: 13, margin: '0 0 6px' }}>This workbook&rsquo;s triggers</h3>
              {loading && triggers.length === 0 ? (
                <p style={{ fontSize: 13, color: '#777' }}>Loading triggers…</p>
              ) : triggers.length === 0 ? (
                <p style={{ fontSize: 13, color: '#777' }}>
                  No triggers yet. Create one below — for example, mark a cell whenever this
                  workbook is edited.
                </p>
              ) : (
                <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {triggers.map((t) => (
                    <li
                      key={t.id}
                      data-testid={`trigger-row-${t.id}`}
                      style={{ border: '1px solid #e5e5e5', borderRadius: 4, padding: '8px 10px' }}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <strong style={{ fontSize: 13 }}>{t.name}</strong>
                        <span style={{ fontSize: 12, color: '#666' }}>
                          {TRIGGER_EVENT_LABELS[t.event] ?? t.event} · {scopeText(t)}
                        </span>
                        <div style={{ flex: 1 }} />
                        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
                          <input
                            type="checkbox"
                            role="switch"
                            aria-label={`Enable ${t.name}`}
                            checked={t.enabled}
                            disabled={busyId === t.id}
                            onChange={(ev) =>
                              void runRowAction(
                                t.id,
                                () => transport.setEnabled(t.id, ev.target.checked),
                                ev.target.checked ? 'Could not enable the trigger' : 'Could not disable the trigger',
                              )
                            }
                          />
                          {t.enabled ? 'On' : 'Off'}
                        </label>
                        <button
                          type="button"
                          style={{ ...btn, padding: '2px 8px', fontSize: 12 }}
                          aria-label={`Delete ${t.name}`}
                          disabled={busyId === t.id}
                          onClick={() =>
                            void runRowAction(t.id, () => transport.remove(t.id), 'Could not delete the trigger')
                          }
                        >
                          Delete
                        </button>
                      </div>
                      <div style={{ fontSize: 12, color: '#666', marginTop: 4 }}>
                        Last fired: {t.lastFiredAt ? new Date(t.lastFiredAt).toLocaleString() : 'Never'} ·{' '}
                        {lastRunText(t)}
                      </div>
                      {t.granted ? (
                        <div style={{ fontSize: 12, color: '#666', marginTop: 2 }}>Permissions granted</div>
                      ) : (
                        <div style={{ fontSize: 12, marginTop: 4 }}>
                          <span style={{ color: '#b45309' }}>
                            Its permissions haven&rsquo;t been granted yet, so it can&rsquo;t run yet.
                          </span>{' '}
                          <button
                            type="button"
                            style={{ ...btn, padding: '2px 8px', fontSize: 12 }}
                            aria-label={`Grant permissions for ${t.name}`}
                            disabled={busyId === t.id}
                            onClick={() =>
                              void runRowAction(t.id, () => transport.grant(t.id), 'Could not grant permissions')
                            }
                          >
                            Grant permissions
                          </button>
                          {t.permissions.length > 0 && (
                            <span style={{ color: '#666' }}>
                              {' '}
                              Needs: {t.permissions.map((p) => `${p.action} on ${p.target}`).join(', ')}
                            </span>
                          )}
                        </div>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </section>

            {/* Create form */}
            <section aria-label="Create a trigger" style={{ borderTop: '1px solid #e5e5e5', paddingTop: 12 }}>
              <h3 style={{ fontSize: 13, margin: '0 0 8px' }}>Create a trigger</h3>
              {events.length === 0 && !loading ? (
                <p style={{ fontSize: 13, color: '#777' }}>
                  This session can&rsquo;t fire any trigger events, so new triggers can&rsquo;t be
                  created here.
                </p>
              ) : (
                <form onSubmit={onCreate} style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                  <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                    <div style={{ flex: '2 1 200px' }}>
                      <label style={fieldLabel} htmlFor={`${formId}-name`}>
                        Name
                      </label>
                      <input
                        id={`${formId}-name`}
                        style={fieldInput}
                        value={name}
                        onChange={(e) => setName(e.target.value)}
                        placeholder="Mark edits"
                      />
                    </div>
                    <div style={{ flex: '1 1 160px' }}>
                      <label style={fieldLabel} htmlFor={`${formId}-event`}>
                        Event
                      </label>
                      <select
                        id={`${formId}-event`}
                        style={fieldInput}
                        value={event}
                        onChange={(e) => onEventChange(e.target.value)}
                      >
                        {events.map((ev) => (
                          <option key={ev} value={ev}>
                            {TRIGGER_EVENT_LABELS[ev] ?? ev}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div style={{ flex: '1 1 120px' }}>
                      <label style={fieldLabel} htmlFor={`${formId}-language`}>
                        Language
                      </label>
                      <select
                        id={`${formId}-language`}
                        style={fieldInput}
                        value={language}
                        onChange={(e) => onLanguageChange(e.target.value as TriggerLanguage)}
                      >
                        <option value="javascript">JavaScript</option>
                        <option value="python">Python</option>
                      </select>
                    </div>
                  </div>

                  <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                    <div style={{ flex: '1 1 160px' }}>
                      <label style={fieldLabel} htmlFor={`${formId}-sheet`}>
                        Sheet name (optional)
                      </label>
                      <input
                        id={`${formId}-sheet`}
                        style={fieldInput}
                        value={sheet}
                        onChange={(e) => setSheet(e.target.value)}
                        placeholder="Sheet1"
                      />
                    </div>
                    <div style={{ flex: '1 1 160px' }}>
                      <label style={fieldLabel} htmlFor={`${formId}-range`}>
                        Range (optional, A1 style)
                      </label>
                      <input
                        id={`${formId}-range`}
                        style={fieldInput}
                        value={rangeText}
                        onChange={(e) => setRangeText(e.target.value)}
                        placeholder="A1:B2"
                      />
                    </div>
                    {event === 'onInterval' && (
                      <div style={{ flex: '1 1 160px' }}>
                        <label style={fieldLabel} htmlFor={`${formId}-interval`}>
                          Interval (seconds)
                        </label>
                        <input
                          id={`${formId}-interval`}
                          style={fieldInput}
                          type="number"
                          min={1}
                          step={1}
                          value={intervalSec}
                          onChange={(e) => setIntervalSec(e.target.value)}
                        />
                      </div>
                    )}
                    {event === 'onAtTime' && (
                      <div style={{ flex: '1 1 200px' }}>
                        <label style={fieldLabel} htmlFor={`${formId}-attime`}>
                          Fire at
                        </label>
                        <input
                          id={`${formId}-attime`}
                          style={fieldInput}
                          type="datetime-local"
                          value={atTime}
                          onChange={(e) => setAtTime(e.target.value)}
                        />
                      </div>
                    )}
                  </div>

                  <div>
                    <label style={fieldLabel} htmlFor={`${formId}-script`}>
                      Script
                    </label>
                    <textarea
                      id={`${formId}-script`}
                      aria-label="Trigger script"
                      style={{
                        ...fieldInput,
                        font: '12px/1.5 ui-monospace, Menlo, Consolas, monospace',
                        minHeight: 120,
                        resize: 'vertical',
                      }}
                      value={script}
                      onChange={(e) => setScript(e.target.value)}
                      spellCheck={false}
                    />
                  </div>

                  <fieldset style={{ border: '1px solid #e5e5e5', borderRadius: 4, padding: 8 }}>
                    <legend style={{ fontSize: 12, fontWeight: 600, padding: '0 4px' }}>
                      Declared permissions
                    </legend>
                    {permissions.map((p, i) => (
                      <div key={i} style={{ display: 'flex', gap: 6, marginBottom: 6, flexWrap: 'wrap' }}>
                        <input
                          style={{ ...fieldInput, flex: '1 1 120px', width: 'auto' }}
                          aria-label={`Permission ${i + 1} action`}
                          value={p.action}
                          onChange={(e) =>
                            setPermissions(permissions.map((q, j) => (j === i ? { ...q, action: e.target.value } : q)))
                          }
                          placeholder="cell.write"
                        />
                        <input
                          style={{ ...fieldInput, flex: '1 1 120px', width: 'auto' }}
                          aria-label={`Permission ${i + 1} target`}
                          value={p.target}
                          onChange={(e) =>
                            setPermissions(permissions.map((q, j) => (j === i ? { ...q, target: e.target.value } : q)))
                          }
                          placeholder="Sheet1!10,0"
                        />
                        <input
                          style={{ ...fieldInput, flex: '2 1 160px', width: 'auto' }}
                          aria-label={`Permission ${i + 1} reason`}
                          value={p.reason ?? ''}
                          onChange={(e) =>
                            setPermissions(permissions.map((q, j) => (j === i ? { ...q, reason: e.target.value } : q)))
                          }
                          placeholder="Why it needs this"
                        />
                        <button
                          type="button"
                          style={{ ...btn, padding: '2px 8px', fontSize: 12 }}
                          aria-label={`Remove permission ${i + 1}`}
                          onClick={() => setPermissions(permissions.filter((_, j) => j !== i))}
                        >
                          Remove
                        </button>
                      </div>
                    ))}
                    <button
                      type="button"
                      style={{ ...btn, padding: '2px 8px', fontSize: 12 }}
                      onClick={() =>
                        setPermissions([...permissions, { action: 'cell.write', target: 'Sheet1!10,0', reason: '' }])
                      }
                    >
                      Add permission
                    </button>
                  </fieldset>

                  <div>
                    <button type="submit" style={primaryBtn} disabled={creating || !event}>
                      {creating ? 'Creating…' : 'Create trigger'}
                    </button>
                  </div>
                </form>
              )}
            </section>
          </>
        )}
      </div>
    </A11yDialog>
  );
}
