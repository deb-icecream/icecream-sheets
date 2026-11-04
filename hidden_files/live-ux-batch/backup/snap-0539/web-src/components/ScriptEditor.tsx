/**
 * Extensions > Apps Script editor (design-docs/automation-lane.md).
 *
 * - Script library: create/rename/delete scripts (TypeScript/JavaScript),
 *   persisted to localStorage via features/scripts.ts.
 * - Code editor with line numbers and lightweight syntax highlighting.
 * - Translate tab: migrate VBA or Apps Script with translateVba /
 *   translateAppsScript; untranslated lines are reported, never dropped.
 * - Run: scripts declare PERMISSIONS; the user grants them once and the
 *   grant is recorded on the script (automation-lane.md §1). Execution
 *   goes through runUserScript with principal `automation:script:<id>`,
 *   so every host call re-authorizes through the permissioned
 *   AutomationApi.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { EngineHost } from '@icecream-sheets/engine';
import {
  AutomationApi,
  runUserScript,
  translateAppsScript,
  translateVba,
  type DeclaredPermission,
  type TranslationResult,
} from '@icecream-sheets/service';
import {
  createScript,
  extractDeclaredPermissions,
  grantScript,
  loadScripts,
  recordRun,
  revokeGrant,
  saveScripts,
  scriptTemplate,
  type ScriptLanguage,
  type UserScript,
} from '../features/scripts';
import A11yDialog from './A11yDialog';

interface ScriptEditorProps {
  host: EngineHost;
  onClose: () => void;
}

/* ------------------------------------------------------------------ */
/* Tiny syntax highlighter (keywords / strings / comments / numbers). */
/* ------------------------------------------------------------------ */

const KEYWORDS = new Set(
  'async await break case catch class const continue debugger default delete do else enum export extends false finally for from function if implements import in instanceof interface let new null of private protected public readonly return static super switch this throw true try typeof var void while with yield'.split(
    ' ',
  ),
);

function highlightLine(line: string, key: number): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  let i = 0;
  let n = 0;
  const push = (text: string, cls?: string) => {
    out.push(
      <span key={`${key}-${n++}`} className={cls}>
        {text}
      </span>,
    );
  };
  while (i < line.length) {
    const c = line[i]!;
    // Line comment.
    if (c === '/' && line[i + 1] === '/') {
      push(line.slice(i), 'tok-com');
      break;
    }
    // String.
    if (c === '"' || c === "'" || c === '`') {
      let j = i + 1;
      while (j < line.length && line[j] !== c) {
        if (line[j] === '\\') j++;
        j++;
      }
      j++;
      push(line.slice(i, j), 'tok-str');
      i = j;
      continue;
    }
    // Number.
    if (/[0-9]/.test(c) && (i === 0 || /[^0-9A-Za-z_$.]/.test(line[i - 1]!))) {
      let j = i + 1;
      while (j < line.length && /[0-9A-Za-z_.]/.test(line[j]!)) j++;
      push(line.slice(i, j), 'tok-num');
      i = j;
      continue;
    }
    // Word.
    if (/[A-Za-z_$]/.test(c)) {
      let j = i + 1;
      while (j < line.length && /[0-9A-Za-z_$]/.test(line[j]!)) j++;
      const word = line.slice(i, j);
      push(word, KEYWORDS.has(word) ? 'tok-kw' : undefined);
      i = j;
      continue;
    }
    push(c);
    i++;
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Editor with line numbers (textarea over a highlighted <pre>).       */
/* ------------------------------------------------------------------ */

function CodeEditor({
  value,
  onChange,
  fontSize = 13,
}: {
  value: string;
  onChange: (v: string) => void;
  fontSize?: number;
}) {
  const preRef = useRef<HTMLPreElement>(null);
  const gutterRef = useRef<HTMLDivElement>(null);
  const lines = useMemo(() => value.split('\n'), [value]);

  const syncScroll = useCallback((e: React.UIEvent<HTMLTextAreaElement>) => {
    const t = e.currentTarget;
    if (preRef.current) {
      preRef.current.scrollTop = t.scrollTop;
      preRef.current.scrollLeft = t.scrollLeft;
    }
    if (gutterRef.current) gutterRef.current.scrollTop = t.scrollTop;
  }, []);

  const font = `${fontSize}px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace`;
  return (
    <div style={{ display: 'flex', flex: 1, minHeight: 0, border: '1px solid #d4d4d4', borderRadius: 4, overflow: 'hidden', background: '#fff' }}>
      <div
        ref={gutterRef}
        aria-hidden
        style={{
          overflow: 'hidden',
          padding: '8px 6px 8px 10px',
          textAlign: 'right',
          color: '#9a9a9a',
          background: '#f7f7f7',
          borderRight: '1px solid #e5e5e5',
          font,
          userSelect: 'none',
          minWidth: 44,
        }}
      >
        {lines.map((_, i) => (
          <div key={i}>{i + 1}</div>
        ))}
      </div>
      <div style={{ position: 'relative', flex: 1, minWidth: 0 }}>
        <pre
          ref={preRef}
          aria-hidden
          style={{
            position: 'absolute',
            inset: 0,
            margin: 0,
            padding: 8,
            overflow: 'hidden',
            font,
            whiteSpace: 'pre',
            pointerEvents: 'none',
          }}
        >
          {lines.map((ln, i) => (
            <div key={i}>
              {highlightLine(ln, i)}
              {'\u200b'}
            </div>
          ))}
          <style>{`.tok-kw{color:#0000ff}.tok-str{color:#a31515}.tok-com{color:#008000}.tok-num{color:#098658}`}</style>
        </pre>
        <textarea
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onScroll={syncScroll}
          spellCheck={false}
          wrap="off"
          aria-label="Script source code"
          style={{
            position: 'absolute',
            inset: 0,
            padding: 8,
            font,
            whiteSpace: 'pre',
            overflow: 'auto',
            background: 'transparent',
            color: 'transparent',
            caretColor: '#000',
            border: 'none',
            outline: 'none',
            resize: 'none',
          }}
        />
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Main editor dialog.                                                 */
/* ------------------------------------------------------------------ */

type RightTab = 'editor' | 'translate';

interface ConsoleEntry {
  kind: 'log' | 'result' | 'error' | 'info';
  text: string;
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

export default function ScriptEditor({ host, onClose }: ScriptEditorProps) {
  const [scripts, setScripts] = useState<UserScript[]>(() => loadScripts());
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [rightTab, setRightTab] = useState<RightTab>('editor');
  const [draft, setDraft] = useState('');
  const [dirty, setDirty] = useState(false);
  const [consoleOut, setConsoleOut] = useState<ConsoleEntry[]>([]);
  const [running, setRunning] = useState(false);
  const [grantRequest, setGrantRequest] = useState<DeclaredPermission[] | null>(null);
  const [translateLang, setTranslateLang] = useState<'vba' | 'apps-script'>('vba');
  const [translateInput, setTranslateInput] = useState('');
  const [translation, setTranslation] = useState<TranslationResult | null>(null);

  const selected = useMemo(
    () => scripts.find((s) => s.id === selectedId) ?? null,
    [scripts, selectedId],
  );

  // Select the first script on load.
  useEffect(() => {
    if (!selectedId && scripts.length > 0) {
      const first = scripts[0]!;
      setSelectedId(first.id);
      setDraft(first.source);
    }
  }, [scripts, selectedId]);

  const persist = useCallback((next: UserScript[]) => {
    setScripts(next);
    saveScripts(next);
  }, []);

  const selectScript = useCallback(
    (s: UserScript) => {
      setSelectedId(s.id);
      setDraft(s.source);
      setDirty(false);
      setConsoleOut([]);
      setGrantRequest(null);
    },
    [],
  );

  const newScript = useCallback(
    (language: ScriptLanguage) => {
      const s = createScript(`Script ${scripts.length + 1}`, language);
      const next = [...scripts, s];
      persist(next);
      selectScript(s);
      setRightTab('editor');
    },
    [scripts, persist, selectScript],
  );

  const deleteScript = useCallback(
    (id: string) => {
      const next = scripts.filter((s) => s.id !== id);
      persist(next);
      if (selectedId === id) {
        const first = next[0] ?? null;
        setSelectedId(first?.id ?? null);
        setDraft(first?.source ?? '');
        setDirty(false);
        setConsoleOut([]);
      }
    },
    [scripts, persist, selectedId],
  );

  const renameScript = useCallback(
    (id: string, name: string) => {
      const next = scripts.map((s) =>
        s.id === id ? { ...s, name: name.trim() || s.name, updatedAt: new Date().toISOString() } : s,
      );
      persist(next);
    },
    [scripts, persist],
  );

  /** The script object as it will be after saving the current draft. */
  const buildSavedScript = (script: UserScript, source: string): UserScript => {
    const perms = extractDeclaredPermissions(source);
    const changed =
      perms.length !== script.permissions.length ||
      perms.some(
        (p, i) => p.action !== script.permissions[i]?.action || p.target !== script.permissions[i]?.target,
      );
    return {
      ...script,
      source,
      permissions: perms,
      // Declared permissions changed — the old grant no longer applies
      // (automation-lane.md §1: the grant is per declaration).
      ...(changed ? revokeGrant(script) : {}),
      updatedAt: new Date().toISOString(),
    };
  };

  const saveDraft = useCallback(() => {
    if (!selected) return;
    const updated = buildSavedScript(selected, draft);
    persist(scripts.map((s) => (s.id === selected.id ? updated : s)));
    setDirty(false);
  }, [scripts, persist, selected, draft]);

  const log = useCallback((kind: ConsoleEntry['kind'], text: string) => {
    setConsoleOut((prev) => [...prev, { kind, text }]);
  }, []);

  const doRun = useCallback(
    async (script: UserScript) => {
      setRunning(true);
      setConsoleOut([]);
      log('info', `Running "${script.name}" as automation:script:${script.id} …`);
      const principal = `automation:script:${script.id}`;
      const api = new AutomationApi(host, { principal });
      try {
        api.grantPermissions(principal, script.permissions, 'user');
      } catch (e) {
        log('error', `Grant failed: ${e instanceof Error ? e.message : String(e)}`);
        setRunning(false);
        return;
      }
      const result = await runUserScript(api, script.source, { name: script.name, timeoutMs: 10_000 });
      if (result.ok) {
        log('result', `Completed: ${JSON.stringify(result.value)}`);
        for (const entry of result.logs) {
          log('log', entry.map((v) => String(v)).join(' '));
        }
        if (result.notifications.length > 0) {
          log('info', `Notifications: ${result.notifications.join('; ')}`);
        }
      } else {
        log('error', result.error);
        for (const entry of result.logs) {
          log('log', entry.map((v) => String(v)).join(' '));
        }
      }
      const next = scripts.map((s) => (s.id === script.id ? recordRun(s, result.ok) : s));
      persist(next);
      setRunning(false);
    },
    [host, scripts, persist, log],
  );

  const onRun = useCallback(() => {
    if (!selected || running) return;
    // Save first so the grant check and the run both see the CURRENT
    // declared permissions, not the stale saved ones.
    const script = dirty ? buildSavedScript(selected, draft) : selected;
    if (dirty) {
      persist(scripts.map((s) => (s.id === selected.id ? script : s)));
      setDirty(false);
    }
    if (!script.granted) {
      // First run or permissions changed: show the grant dialog.
      setGrantRequest(script.permissions);
      return;
    }
    void doRun(script);
  }, [selected, running, dirty, draft, scripts, persist, doRun]);

  const confirmGrant = useCallback(() => {
    if (!selected || !grantRequest) return;
    const next = scripts.map((s) => (s.id === selected.id ? grantScript(s, grantRequest) : s));
    persist(next);
    setGrantRequest(null);
    const granted = next.find((s) => s.id === selected.id)!;
    void doRun(granted);
  }, [selected, grantRequest, scripts, persist, doRun]);

  const onTranslate = useCallback(() => {
    setTranslation(null);
    try {
      const result =
        translateLang === 'vba' ? translateVba(translateInput) : translateAppsScript(translateInput);
      setTranslation(result);
    } catch (e) {
      log('error', `Translation failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }, [translateLang, translateInput, log]);

  const saveTranslation = useCallback(() => {
    if (!translation) return;
    const s = createScript(`Migrated ${translation.sourceLanguage}`, 'typescript');
    s.source = translation.code;
    s.permissions = translation.permissions;
    const next = [...scripts, s];
    persist(next);
    selectScript({ ...s });
    setRightTab('editor');
    setTranslation(null);
    setTranslateInput('');
  }, [translation, scripts, persist, selectScript]);

  const declared = useMemo(() => extractDeclaredPermissions(draft), [draft]);

  return (
    <>
      <A11yDialog
        title={
          <>
            Apps Script
            <span className="scripteditor-subtitle">
              Automation lane — scripts run through the permissioned automation API
            </span>
          </>
        }
        onClose={onClose}
        width="min(1100px, 96vw)"
        className="scripteditor-dialog"
        data-testid="script-editor"
      >
        <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
          {/* Script library sidebar */}
          <div style={{ width: 220, borderRight: '1px solid #e5e5e5', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
            <div style={{ padding: 8, display: 'flex', gap: 6 }}>
              <button style={{ ...btn, flex: 1 }} onClick={() => newScript('typescript')} title="New TypeScript script">
                + TS
              </button>
              <button style={{ ...btn, flex: 1 }} onClick={() => newScript('javascript')} title="New JavaScript script">
                + JS
              </button>
            </div>
            <div style={{ flex: 1, overflowY: 'auto' }}>
              {scripts.map((s) => (
                <div
                  key={s.id}
                  onClick={() => selectScript(s)}
                  style={{
                    padding: '8px 10px',
                    cursor: 'pointer',
                    background: s.id === selectedId ? '#e8f0fe' : 'transparent',
                    borderLeft: s.id === selectedId ? '3px solid #2b579a' : '3px solid transparent',
                  }}
                >
                  <div style={{ fontSize: 13, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {s.name}
                  </div>
                  <div style={{ fontSize: 11, color: '#777' }}>
                    {s.language === 'typescript' ? 'TypeScript' : 'JavaScript'}
                    {s.granted ? ' · granted' : ''}
                    {s.lastRunAt ? (s.lastRunOk ? ' · ✓ ran' : ' · ✗ failed') : ''}
                  </div>
                  <div style={{ marginTop: 4, display: 'flex', gap: 4 }}>
                    <button
                      style={{ ...btn, padding: '2px 6px', fontSize: 11 }}
                      onClick={(e) => {
                        e.stopPropagation();
                        const name = window.prompt('Rename script', s.name);
                        if (name !== null) renameScript(s.id, name);
                      }}
                    >
                      Rename
                    </button>
                    <button
                      style={{ ...btn, padding: '2px 6px', fontSize: 11 }}
                      onClick={(e) => {
                        e.stopPropagation();
                        if (window.confirm(`Delete "${s.name}"?`)) deleteScript(s.id);
                      }}
                    >
                      Delete
                    </button>
                  </div>
                </div>
              ))}
              {scripts.length === 0 && (
                <div style={{ padding: 16, color: '#777', fontSize: 13 }}>
                  No scripts yet. Create one with + TS / + JS, or migrate VBA/Apps Script on the Translate tab.
                </div>
              )}
            </div>
          </div>

          {/* Main panel */}
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
            {/* Tabs */}
            <div style={{ display: 'flex', gap: 4, padding: '8px 12px 0' }}>
              {(
                [
                  ['editor', 'Editor'],
                  ['translate', 'Translate VBA / Apps Script'],
                ] as [RightTab, string][]
              ).map(([id, label]) => (
                <button
                  key={id}
                  onClick={() => setRightTab(id)}
                  style={{
                    ...btn,
                    borderBottomLeftRadius: 0,
                    borderBottomRightRadius: 0,
                    borderBottom: rightTab === id ? '1px solid #fff' : undefined,
                    background: rightTab === id ? '#fff' : '#f0f0f0',
                    fontWeight: rightTab === id ? 600 : 400,
                  }}
                >
                  {label}
                </button>
              ))}
            </div>

            {rightTab === 'editor' && (
              <div style={{ flex: 1, display: 'flex', flexDirection: 'column', padding: 12, gap: 8, minHeight: 0 }}>
                {!selected ? (
                  <div style={{ color: '#777', fontSize: 13 }}>Select or create a script.</div>
                ) : (
                  <>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <strong style={{ fontSize: 14 }}>{selected.name}</strong>
                      {dirty && <span style={{ fontSize: 12, color: '#b45309' }}>● unsaved</span>}
                      <span style={{ fontSize: 12, color: '#666' }}>
                        {selected.granted
                          ? `Permissions granted ${selected.grantedAt ? new Date(selected.grantedAt).toLocaleString() : ''}`
                          : 'Permissions not granted'}
                      </span>
                      <div style={{ flex: 1 }} />
                      <button style={btn} onClick={saveDraft} disabled={!dirty}>
                        Save
                      </button>
                      <button style={btn} onClick={() => selected && setDraft(scriptTemplate(selected.language))} title="Reset to the starter template">
                        Reset
                      </button>
                      <button style={primaryBtn} onClick={onRun} disabled={running}>
                        {running ? 'Running…' : '▶ Run'}
                      </button>
                    </div>
                    <CodeEditor
                      value={draft}
                      onChange={(v) => {
                        setDraft(v);
                        setDirty(true);
                      }}
                    />
                    {/* Declared permissions */}
                    <div style={{ fontSize: 12 }}>
                      <strong>Declared permissions</strong>{' '}
                      <span style={{ color: '#666' }}>(from PERMISSIONS in the source — granted once by you)</span>
                      {declared.length === 0 ? (
                        <div style={{ color: '#777', marginTop: 4 }}>None declared.</div>
                      ) : (
                        <ul style={{ margin: '4px 0', paddingLeft: 18 }}>
                          {declared.map((p, i) => (
                            <li key={i}>
                              <code>{p.action}</code> on <code>{p.target}</code>
                              {p.reason ? ` — ${p.reason}` : ''}
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                    {/* Console */}
                    <div style={{ height: 130, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
                      <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 4 }}>Console</div>
                      <div
                        style={{
                          flex: 1,
                          overflowY: 'auto',
                          background: '#1e1e1e',
                          color: '#d4d4d4',
                          borderRadius: 4,
                          padding: 8,
                          font: '12px/1.5 ui-monospace, Menlo, Consolas, monospace',
                          whiteSpace: 'pre-wrap',
                        }}
                        aria-live="polite"
                      >
                        {consoleOut.length === 0 && <span style={{ color: '#888' }}>Run output appears here.</span>}
                        {consoleOut.map((e, i) => (
                          <div
                            key={i}
                            style={{
                              color: e.kind === 'error' ? '#f48771' : e.kind === 'result' ? '#4ec9b0' : e.kind === 'info' ? '#9cdcfe' : '#d4d4d4',
                            }}
                          >
                            {e.text}
                          </div>
                        ))}
                      </div>
                    </div>
                  </>
                )}
              </div>
            )}

            {rightTab === 'translate' && (
              <div style={{ flex: 1, display: 'flex', flexDirection: 'column', padding: 12, gap: 8, minHeight: 0 }}>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <label style={{ fontSize: 13 }}>
                    Source language:{' '}
                    <select value={translateLang} onChange={(e) => setTranslateLang(e.target.value as 'vba' | 'apps-script')} style={{ fontSize: 13 }}>
                      <option value="vba">VBA</option>
                      <option value="apps-script">Google Apps Script</option>
                    </select>
                  </label>
                  <button style={primaryBtn} onClick={onTranslate} disabled={!translateInput.trim()}>
                    Translate
                  </button>
                  {translation && (
                    <button style={btn} onClick={saveTranslation}>
                      Save as new script
                    </button>
                  )}
                </div>
                <div style={{ flex: 1, display: 'flex', gap: 8, minHeight: 0 }}>
                  <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
                    <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 4 }}>Source ({translateLang === 'vba' ? 'VBA' : 'Apps Script'})</div>
                    <CodeEditor value={translateInput} onChange={setTranslateInput} />
                  </div>
                  <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
                    <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 4 }}>Translated TypeScript</div>
                    {translation ? (
                      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0, gap: 8 }}>
                        <CodeEditor value={translation.code} onChange={() => {}} />
                        {translation.untranslated.length > 0 && (
                          <div style={{ fontSize: 12, maxHeight: 120, overflowY: 'auto', border: '1px solid #f0c36d', background: '#fef7e0', borderRadius: 4, padding: 8 }}>
                            <strong>Not translated ({translation.untranslated.length} lines):</strong>
                            <ul style={{ margin: '4px 0', paddingLeft: 18 }}>
                              {translation.untranslated.map((u, i) => (
                                <li key={i}>
                                  line {u.line}: <code>{u.text}</code> — {u.reason}
                                </li>
                              ))}
                            </ul>
                          </div>
                        )}
                        {translation.notes.length > 0 && (
                          <div style={{ fontSize: 12, color: '#555' }}>
                            <strong>Notes:</strong> {translation.notes.join(' ')}
                          </div>
                        )}
                        {translation.permissions.length > 0 && (
                          <div style={{ fontSize: 12 }}>
                            <strong>Declares permissions:</strong>{' '}
                            {translation.permissions.map((p) => `${p.action} on ${p.target}`).join(', ')}
                          </div>
                        )}
                      </div>
                    ) : (
                      <div style={{ color: '#777', fontSize: 13 }}>Paste VBA or Apps Script source and click Translate.</div>
                    )}
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>

      </A11yDialog>

      {/* Permission grant dialog */}
      {grantRequest && selected && (
        <A11yDialog
          title="Grant permissions?"
          onClose={() => setGrantRequest(null)}
          width={440}
          data-testid="grant-permissions"
        >
          <p style={{ fontSize: 13, color: '#444' }}>
            <strong>{selected.name}</strong> declares these permissions. Grants are recorded and
            apply to this script only (principal <code>automation:script:{selected.id}</code>).
          </p>
          {grantRequest.length === 0 ? (
            <p style={{ fontSize: 13 }}>No permissions declared — the script runs with no grants.</p>
          ) : (
            <ul style={{ fontSize: 13, paddingLeft: 18 }}>
              {grantRequest.map((p, i) => (
                <li key={i}>
                  <code>{p.action}</code> on <code>{p.target}</code>
                  {p.reason ? ` — ${p.reason}` : ''}
                </li>
              ))}
            </ul>
          )}
          <div className="dialog-actions">
            <button style={btn} onClick={() => setGrantRequest(null)}>
              Deny
            </button>
            <button style={primaryBtn} onClick={confirmGrant}>
              Grant and run
            </button>
          </div>
        </A11yDialog>
      )}
    </>
  );
}
