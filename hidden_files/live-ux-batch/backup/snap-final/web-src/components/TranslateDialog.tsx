/**
 * Translate dialog (Review > Language > Translate).
 *
 * Translation is executed by the ENGINE's TRANSLATE function
 * (packages/engine/src/extended-functions10.ts) so the pluggable
 * TranslatorProvider seam is honored (bundled phrasebook by default;
 * a network provider can be injected via setTranslatorProvider()).
 * The dialog writes =TRANSLATE("text","src","tgt") into a scratch sheet
 * and reads the computed value back through the host. "Insert" hands
 * the result to the parent (onInsert) to write into the active cell.
 */
import { useState } from 'react';
import type { EngineHost } from '@icecream-sheets/engine';
import A11yDialog from './A11yDialog';
import {
  buildTranslateFormula,
  isTranslateError,
  renderTranslateResult,
  TRANSLATE_LANGS,
  TRANSLATE_SCRATCH_SHEET,
} from '../features/translate';

interface TranslateDialogProps {
  host: EngineHost;
  /** Initial text (e.g. the active cell's value). */
  initialText: string;
  onClose: () => void;
  /** Insert the translation into the document (parent writes the cell). */
  onInsert?: (text: string) => void;
}

export default function TranslateDialog({ host, initialText, onClose, onInsert }: TranslateDialogProps) {
  const [text, setText] = useState(initialText);
  const [source, setSource] = useState('auto');
  const [target, setTarget] = useState('es');
  const [result, setResult] = useState('');
  const [error, setError] = useState('');
  const [translating, setTranslating] = useState(false);

  const translate = (): void => {
    setError('');
    setResult('');
    if (!text.trim()) { setError('Enter text to translate.'); return; }
    if (source !== 'auto' && source === target) { setError('Source and target languages are the same.'); return; }
    setTranslating(true);
    try {
      // Scratch sheet for evaluation (created once, reused).
      const add = host.execute({ cmd: 'addSheet', name: TRANSLATE_SCRATCH_SHEET });
      if (!add.ok && !String(add.error ?? '').includes('already')) {
        // addSheet is idempotent-ish in most hosts; continue regardless and
        // let setFormula surface real problems.
      }
      const formula = buildTranslateFormula(text, source === 'auto' ? null : source, target);
      const set = host.execute({
        cmd: 'setFormula',
        ref: { sheet: TRANSLATE_SCRATCH_SHEET, row: 0, col: 0 },
        formula,
      });
      if (!set.ok) throw new Error(set.error ?? 'Could not evaluate translation.');
      host.execute({ cmd: 'recalculate' });
      const value = host.getView().readCell({ sheet: TRANSLATE_SCRATCH_SHEET, row: 0, col: 0 }).value;
      if (isTranslateError(value)) {
        setError(`Translation failed (${renderTranslateResult(value)}). The bundled phrasebook covers common phrases; inject a network provider for full translation.`);
      } else {
        const out = renderTranslateResult(value);
        if (!out) {
          setError('No translation available for this text in the bundled phrasebook. Inject a network provider via setTranslatorProvider() for full translation.');
        } else {
          setResult(out);
        }
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Translation failed.');
    } finally {
      setTranslating(false);
    }
  };

  const swap = (): void => {
    if (source === 'auto') return;
    setSource(target);
    setTarget(source);
    setResult('');
  };

  return (
    <A11yDialog title={<>Translate</>} width={480} onClose={onClose}>
        <div className="dialog-row" style={{ gap: 8, alignItems: 'flex-end' }}>
          <label>From<br />
            <select value={source} onChange={(e) => setSource(e.target.value)} aria-label="Source language">
              <option value="auto">Detect automatically</option>
              {TRANSLATE_LANGS.map((l) => <option key={l.code} value={l.code}>{l.name}</option>)}
            </select>
          </label>
          <button onClick={swap} disabled={source === 'auto'} title="Swap languages" aria-label="Swap languages">⇄</button>
          <label>To<br />
            <select value={target} onChange={(e) => setTarget(e.target.value)} aria-label="Target language">
              {TRANSLATE_LANGS.map((l) => <option key={l.code} value={l.code}>{l.name}</option>)}
            </select>
          </label>
        </div>
        <div className="dialog-row" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 8 }}>
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={3}
            style={{ width: '100%' }}
            aria-label="Text to translate"
            placeholder="Text to translate…"
          />
          <button onClick={translate} disabled={translating} style={{ alignSelf: 'flex-start' }}>
            {translating ? 'Translating…' : 'Translate'}
          </button>
          {result && (
            <div style={{ border: '1px solid var(--line-soft)', borderRadius: 4, padding: 8, background: '#fafafa' }}>
              <div style={{ fontSize: 12, color: '#666' }}>Translation</div>
              <div style={{ fontSize: 15 }}>{result}</div>
            </div>
          )}
        </div>
        {error && <div style={{ color: 'red', fontSize: 13 }}>{error}</div>}
        <div className="dialog-actions">
          {result && onInsert && <button onClick={() => { onInsert(result); onClose(); }}>Insert into cell</button>}
          <button onClick={onClose}>Close</button>
        </div>
      </A11yDialog>
  );
}
