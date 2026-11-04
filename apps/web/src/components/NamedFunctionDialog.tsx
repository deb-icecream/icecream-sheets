/**
 * Named Function dialog: define, edit, version, and delete named functions.
 *
 * Backed by the service-layer NamedFunctionRegistry (design-docs §6–§7):
 * typed signatures checked at definition time, versioned definitions with
 * append-only history and rollback, manage-right gating. The browser runs
 * static checks only; Python/statement bodies need the service runtime and
 * bind as stubs (calls evaluate to #VALUE! with an explanation).
 */
import { useState } from 'react';
import type {
  NamedFunctionRegistry,
  NamedFunctionDef,
  NamedFunctionLanguage,
  NamedFunctionSignature,
  NamedValueType,
} from '@icecream-sheets/service';
import A11yDialog from './A11yDialog';

interface NamedFunctionDialogProps {
  registry: NamedFunctionRegistry;
  principal: string;
  onClose: () => void;
  onChanged: () => void;
}

const LANGUAGES: NamedFunctionLanguage[] = ['javascript', 'typescript', 'python'];
const VALUE_TYPES: NamedValueType[] = ['number', 'string', 'boolean', 'any'];

function sigText(sig: NamedFunctionSignature): string {
  const params = sig.params.map((p) => `${p.name}: ${p.type}`).join(', ');
  return `(${params}) => ${sig.returns}`;
}

export function NamedFunctionDialog({
  registry,
  principal,
  onClose,
  onChanged,
}: NamedFunctionDialogProps) {
  const [defs, setDefs] = useState<NamedFunctionDef[]>(() => registry.list());
  const [nameText, setNameText] = useState('');
  const [language, setLanguage] = useState<NamedFunctionLanguage>('javascript');
  const [source, setSource] = useState('');
  const [paramText, setParamText] = useState(''); // "x: number, y: string"
  const [returns, setReturnType] = useState<NamedValueType>('any');
  const [error, setError] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [historyId, setHistoryId] = useState<string | null>(null);

  const refresh = () => {
    setDefs(registry.list());
    onChanged();
  };

  const parseSignature = (): NamedFunctionSignature | null => {
    const params: Array<{ name: string; type: NamedValueType }> = [];
    const raw = paramText.trim();
    if (raw) {
      for (const part of raw.split(',')) {
        const [n, t] = part.split(':').map((s) => s.trim());
        if (!n) {
          setError(`Bad parameter "${part}": use "name: type".`);
          return null;
        }
        const type = (t || 'any') as NamedValueType;
        if (!VALUE_TYPES.includes(type)) {
          setError(`Bad type "${t}": use ${VALUE_TYPES.join(', ')}.`);
          return null;
        }
        params.push({ name: n, type });
      }
    }
    return { params, returns };
  };

  const handleDefine = async () => {
    const name = nameText.trim();
    if (!name) {
      setError('Enter a function name.');
      return;
    }
    if (!source.trim()) {
      setError('Enter the function source.');
      return;
    }
    const signature = parseSignature();
    if (!signature) return;
    try {
      await registry.define({ name, language, source: source.trim(), signature, principal });
      setError('');
      setNameText('');
      setSource('');
      setParamText('');
      refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const handleUpdate = async (def: NamedFunctionDef) => {
    if (!source.trim()) {
      setError('Enter the new source.');
      return;
    }
    const signature = parseSignature();
    if (!signature) return;
    try {
      await registry.update(def.id, { language, source: source.trim(), signature, principal });
      setError('');
      setEditingId(null);
      setSource('');
      refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const handleDelete = async (id: string) => {
    try {
      await registry.delete(id, principal);
      setError('');
      refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const handleRollback = async (def: NamedFunctionDef, version: number) => {
    try {
      await registry.rollback(def.id, version, principal, 'Rollback from UI');
      setError('');
      setHistoryId(null);
      refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const startEdit = (def: NamedFunctionDef) => {
    setEditingId(def.id);
    setLanguage(def.language);
    setSource(def.source);
    setParamText(def.signature.params.map((p) => `${p.name}: ${p.type}`).join(', '));
    setReturnType(def.signature.returns);
    setError('');
  };

  const historyDef = historyId ? defs.find((d) => d.id === historyId) : undefined;

  return (
    <A11yDialog title={<>Named Functions</>} onClose={onClose}>
      {defs.length === 0 ? (
        <div className="dialog-hint">No named functions yet.</div>
      ) : (
        <table className="name-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Language</th>
              <th>Signature</th>
              <th>Ver</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {defs.map((d) => (
              <tr key={d.id}>
                <td>{d.name}</td>
                <td>{d.language}</td>
                <td style={{ fontFamily: 'monospace', fontSize: 12 }}>{sigText(d.signature)}</td>
                <td>v{d.version}</td>
                <td style={{ whiteSpace: 'nowrap' }}>
                  <button onClick={() => startEdit(d)}>Edit</button>{' '}
                  <button onClick={() => setHistoryId(d.id)}>History</button>{' '}
                  <button onClick={() => handleDelete(d.id)}>Delete</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {historyDef && (
        <div style={{ marginTop: 12 }}>
          <div className="dialog-title">Version history: {historyDef.name}</div>
          <table className="name-table">
            <thead>
              <tr><th>Ver</th><th>When</th><th>By</th><th>Note</th><th></th></tr>
            </thead>
            <tbody>
              {historyDef.versions.map((v) => (
                <tr key={v.version}>
                  <td>v{v.version}{v.version === historyDef.version ? ' (current)' : ''}</td>
                  <td>{new Date(v.updatedAt).toLocaleString()}</td>
                  <td>{v.updatedBy}</td>
                  <td>{v.note ?? ''}</td>
                  <td>
                    {v.version !== historyDef.version && (
                      <button onClick={() => handleRollback(historyDef, v.version)}>
                        Roll back
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="dialog-actions">
            <button onClick={() => setHistoryId(null)}>Close history</button>
          </div>
        </div>
      )}

      <div className="dialog-title" style={{ marginTop: 12 }}>
        {editingId ? 'Edit Function (new version)' : 'Define Function'}
      </div>
      <label className="dialog-row">
        <span>Name:</span>
        <input
          value={nameText}
          onChange={(e) => setNameText(e.target.value)}
          placeholder="e.g. Double"
          disabled={editingId !== null}
        />
      </label>
      <label className="dialog-row">
        <span>Language:</span>
        <select value={language} onChange={(e) => setLanguage(e.target.value as NamedFunctionLanguage)}>
          {LANGUAGES.map((l) => (
            <option key={l} value={l}>{l}</option>
          ))}
        </select>
      </label>
      <label className="dialog-row">
        <span>Params:</span>
        <input
          value={paramText}
          onChange={(e) => setParamText(e.target.value)}
          placeholder="e.g. x: number, y: string"
        />
      </label>
      <label className="dialog-row">
        <span>Returns:</span>
        <select value={returns} onChange={(e) => setReturnType(e.target.value as NamedValueType)}>
          {VALUE_TYPES.map((t) => (
            <option key={t} value={t}>{t}</option>
          ))}
        </select>
      </label>
      <label className="dialog-row" style={{ alignItems: 'flex-start' }}>
        <span>Source:</span>
        <textarea
          value={source}
          onChange={(e) => setSource(e.target.value)}
          placeholder={language === 'javascript' ? 'LAMBDA(x, x*2)' : language === 'python' ? 'return x * 2' : '(x) => x * 2'}
          rows={4}
          style={{ width: 320, fontFamily: 'monospace' }}
        />
      </label>
      <div className="dialog-hint">
        Formulas call the current version; old versions are kept for audit and
        rollback. Python and statement bodies need the service runtime — in
        this browser they bind as stubs (calls evaluate to #VALUE!).
      </div>
      {error && <div className="dialog-error">{error}</div>}
      <div className="dialog-actions">
        {editingId ? (
          <>
            <button onClick={() => {
              const def = defs.find((d) => d.id === editingId);
              if (def) handleUpdate(def);
            }}>Save new version</button>
            <button onClick={() => { setEditingId(null); setSource(''); setError(''); }}>Cancel</button>
          </>
        ) : (
          <button onClick={handleDefine}>Define Function</button>
        )}
        <button onClick={onClose}>Close</button>
      </div>
    </A11yDialog>
  );
}
