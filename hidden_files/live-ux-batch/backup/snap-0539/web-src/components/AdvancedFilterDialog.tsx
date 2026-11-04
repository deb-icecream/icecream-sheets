/**
 * Advanced Filter dialog (Data > Sort & Filter > Advanced…).
 *
 * Wraps features/advancedFilter.ts: the user picks the list range
 * (defaults to the sheet's used range), a criteria range (field names
 * in the first row, AND within a row, OR across rows), unique-records
 * filtering, and either in-place filtering or copy-to a destination.
 * The applied spec is reported via onApplied so the parent can offer
 * ribbon "Reapply" (applyAdvancedFilterToHost with the stored spec).
 */
import { useState } from 'react';
import type { EngineHost } from '@icecream-sheets/engine';
import A11yDialog from './A11yDialog';
import {
  applyAdvancedFilterToHost,
  type AdvancedFilterOutcome,
  type AdvancedFilterSpec,
} from '../features/advancedFilter';

interface AdvancedFilterDialogProps {
  host: EngineHost;
  sheet: string;
  /** Suggested list range (A1); defaults to the used range. */
  initialListRange?: string;
  onClose: () => void;
  /** Called with the applied spec so the parent can Reapply later. */
  onApplied: (spec: AdvancedFilterSpec, outcome: AdvancedFilterOutcome) => void;
}

function colLetter(i: number): string {
  let n = i;
  let s = '';
  do { s = String.fromCharCode(65 + (n % 26)) + s; n = Math.floor(n / 26) - 1; } while (n >= 0);
  return s;
}

export default function AdvancedFilterDialog({
  host,
  sheet,
  initialListRange,
  onClose,
  onApplied,
}: AdvancedFilterDialogProps) {
  const used = host.getView().usedRange(sheet);
  const defaultList = initialListRange
    ?? (used ? `${sheet}!${colLetter(used.startCol)}${used.startRow + 1}:${colLetter(used.endCol)}${used.endRow + 1}` : `${sheet}!A1:A1`);
  const [listRange, setListRange] = useState(defaultList);
  const [criteriaRange, setCriteriaRange] = useState('');
  const [uniqueOnly, setUniqueOnly] = useState(false);
  const [copyToEnabled, setCopyToEnabled] = useState(false);
  const [copyTo, setCopyTo] = useState('');
  const [error, setError] = useState('');
  const [done, setDone] = useState('');

  const apply = (): void => {
    setError('');
    setDone('');
    try {
      const spec: AdvancedFilterSpec = {
        listRange: listRange.includes('!') ? listRange : `${sheet}!${listRange}`,
        criteriaRange: criteriaRange.includes('!') ? criteriaRange : `${sheet}!${criteriaRange}`,
        uniqueOnly,
        copyTo: copyToEnabled && copyTo.trim()
          ? (copyTo.includes('!') ? copyTo : `${sheet}!${copyTo}`)
          : undefined,
      };
      if (!criteriaRange.trim()) {
        setError('Enter a criteria range (field names in its first row).');
        return;
      }
      const outcome = applyAdvancedFilterToHost(host, spec);
      onApplied(spec, outcome);
      setDone(`Matched ${outcome.matchedRows} of ${outcome.sourceRows} rows${spec.copyTo ? ` — copied to ${spec.copyTo}` : ' (list rewritten in place)'}.`);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Filter failed.');
    }
  };

  return (
    <A11yDialog title={<>Advanced Filter</>} width={480} onClose={onClose}>
        <div className="dialog-row" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 10 }}>
          <label>
            List range<br />
            <input value={listRange} onChange={(e) => setListRange(e.target.value)} style={{ width: '100%' }} aria-label="List range" spellCheck={false} />
          </label>
          <label>
            Criteria range <span style={{ color: '#666', fontSize: 12 }}>(field names in first row; AND within a row, OR across rows)</span><br />
            <input value={criteriaRange} onChange={(e) => setCriteriaRange(e.target.value)} style={{ width: '100%' }} aria-label="Criteria range" placeholder="e.g. Sheet1!F1:G3" spellCheck={false} />
          </label>
          <label>
            <input type="checkbox" checked={uniqueOnly} onChange={(e) => setUniqueOnly(e.target.checked)} /> Unique records only
          </label>
          <div>
            <label>
              <input type="radio" name="af-action" checked={!copyToEnabled} onChange={() => setCopyToEnabled(false)} /> Filter the list, in-place
            </label>{' '}
            <label>
              <input type="radio" name="af-action" checked={copyToEnabled} onChange={() => setCopyToEnabled(true)} /> Copy to another location
            </label>
            {copyToEnabled && (
              <input value={copyTo} onChange={(e) => setCopyTo(e.target.value)} style={{ width: '100%', marginTop: 6 }} aria-label="Copy to" placeholder="e.g. Sheet1!I1" spellCheck={false} />
            )}
          </div>
          <div style={{ fontSize: 12, color: '#666' }}>
            Criteria support comparisons (&gt;, &lt;, &gt;=, &lt;=, &lt;&gt;, =), wildcards (*, ?) and numeric comparison.
          </div>
        </div>
        {error && <div style={{ color: 'red', fontSize: 13 }}>{error}</div>}
        {done && <div style={{ color: '#1a7f37', fontSize: 13 }}>{done}</div>}
        <div className="dialog-actions">
          <button onClick={apply}>OK</button>
          <button onClick={onClose}>Close</button>
        </div>
      </A11yDialog>
  );
}
