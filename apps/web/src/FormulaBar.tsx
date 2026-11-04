import { memo, useEffect, useId, useMemo, useRef, useState } from 'react';
import { parseA1RangeRef, type EngineHost } from '@icecream-sheets/engine';
import { autocompleteFormula, rangeColumnsFromGrid } from '@icecream-sheets/service';
import { a1Short, cellRef, formatDisplay } from './engine';
import type { Selection } from './App';
import AutocompleteDropdown, { type DropdownItem } from './components/AutocompleteDropdown';

interface FormulaBarProps {
  host: EngineHost;
  sheet: string;
  sel: Selection;
  onCommit: (row: number, col: number, text: string) => void;
  /**
   * When set (bumped nonce), seeds the draft with the given text — used by
   * the ribbon's function gallery to drop a skeleton into the bar.
   */
  insertRequest?: { text: string; nonce: number } | null;
  /** Engine tick: refreshes the bar on recalc / language switch. */
  version?: number;
  /**
   * Name-box navigation (sweep finding F-8): fired when the user types
   * a cell or range reference into the address box and presses Enter.
   * The App moves the selection (switching sheet when the ref names an
   * existing one); an unparseable entry never reaches this callback.
   */
  onNavigate?: (target: {
    sheet: string;
    startRow: number;
    startCol: number;
    endRow: number;
    endCol: number;
  }) => void;
}

/** Cell budget for the autocomplete column-inference sample (see below). */
export const AUTOCOMPLETE_SAMPLE_MAX_CELLS = 131_072;

/** Ensure displayed formula text carries a leading '='. */
function displayFormula(formula: string): string {
  return formula.startsWith('=') ? formula : `=${formula}`;
}

/**
 * Hosts whose reads settle asynchronously expose this (issue #43) — the
 * same structural surface features/undo.ts detects. The local
 * in-process host does not: its sync view already carries formulas.
 */
interface AsyncReadableHost {
  readCellAsync(ref: {
    sheet: string;
    row: number;
    col: number;
  }): Promise<{ formula?: string }>;
}

function asyncReader(host: EngineHost): AsyncReadableHost | null {
  const candidate = host as EngineHost & Partial<AsyncReadableHost>;
  return typeof candidate.readCellAsync === 'function' ? (candidate as AsyncReadableHost) : null;
}

function FormulaBar({ host, sheet, sel, onCommit, insertRequest, version, onNavigate }: FormulaBarProps) {
  const [draft, setDraft] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  // Stable id for the address element so the input can reference it via
  // aria-describedby: screen readers announce the active cell address when
  // the formula bar takes focus (design-docs/accessibility.md §2.2).
  const addressId = useId();

  // Sync the bar whenever the selection, sheet, workbook, or engine tick
  // changes (the tick covers recalculation and formula-language switches,
  // which re-localize cell.formula).
  useEffect(() => {
    const ref = cellRef(sheet, sel.row, sel.col);
    const cell = host.getView().readCell(ref);
    const seeded = cell.formula !== undefined ? displayFormula(cell.formula) : formatDisplay(cell.value);
    setDraft(seeded);
    // Issue #43: on the async hosts the sync view can hold a cell's
    // VALUE without its formula (bulk/stream fills are values-first),
    // and the bar then shows the computed value for a formula cell —
    // the desktop-local defect. When the sync read carries no formula,
    // resolve the cell through the host's authoritative async read and
    // swap the formula in — but only if the user hasn't started typing
    // over the seeded text meanwhile, and never after the selection
    // moved on (the cleanup cancels stale resolutions).
    if (cell.formula !== undefined) return;
    const reader = asyncReader(host);
    if (!reader) return;
    let live = true;
    reader
      .readCellAsync(ref)
      .then((got) => {
        if (!live || !got?.formula) return;
        const formulaText = displayFormula(got.formula);
        setDraft((cur) => (cur === seeded ? formulaText : cur));
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [host, sheet, sel, version]);

  // Seed the draft when the ribbon inserts a function skeleton.
  useEffect(() => {
    if (insertRequest) {
      setDraft(insertRequest.text);
      inputRef.current?.focus();
      // Place the caret inside the parentheses, e.g. =SUM(|).
      const pos = Math.max(0, insertRequest.text.length - 1);
      inputRef.current?.setSelectionRange(pos, pos);
    }
  }, [insertRequest]);

  const commit = () => {
    onCommit(sel.row, sel.col, draft);
  };

  // ---- Name box (sweep F-8): the address field is a real input ----
  // While the user edits it, addrDraft holds their text; at all other
  // times the box shows the live selection address and follows it
  // (mouse clicks, keyboard navigation, sheet switches). Enter parses
  // the draft as a cell/range reference ("C7", "B2:D5", "Sheet2!A1")
  // and navigates; Escape/blur discards. Invalid input has NO side
  // effects: clearing the draft restores the current address display.
  const [addrDraft, setAddrDraft] = useState<string | null>(null);
  const addrRef = useRef<HTMLInputElement>(null);
  const addrDisplay = a1Short(sel.row, sel.col);

  const commitAddress = () => {
    if (addrDraft === null) return;
    const target = parseA1RangeRef(addrDraft, sheet);
    setAddrDraft(null);
    if (target && onNavigate) {
      onNavigate(target);
      addrRef.current?.blur();
    }
  };

  const revert = () => {
    const cell = host.getView().readCell(cellRef(sheet, sel.row, sel.col));
    setDraft(cell.formula !== undefined ? displayFormula(cell.formula) : formatDisplay(cell.value));
  };

  // ---- Formula autocomplete (deterministic-inference.md §5) ----
  const [acIndex, setAcIndex] = useState(0);
  const caretRef = useRef(0);

  const columns = useMemo(() => {
    try {
      const view = host.getView();
      const used = view.usedRange(sheet);
      if (!used) return [];
      // W16 (P99): autocomplete column inference needs headers + a data
      // sample, NOT the whole used range. Reading all 150,003 rows of a
      // P99 sheet through the view queued a 1.8M-cell engine read
      // (~25 s, engine main thread) plus a 1.8M-cell mapping in this
      // memo — re-run on every engine tick — which starved stream
      // ingest and pegged the renderer after first paint. Cap the
      // sample at AUTOCOMPLETE_SAMPLE_MAX_CELLS cells from the top of
      // the used range (full column width, rows capped); sheets smaller
      // than the cap are read in full, exactly as before.
      const width = used.endCol - used.startCol + 1;
      const sampleRows = Math.max(1, Math.floor(AUTOCOMPLETE_SAMPLE_MAX_CELLS / Math.max(1, width)));
      const endRow = Math.min(used.endRow, used.startRow + sampleRows - 1);
      const grid = view
        .readRange({ sheet, startRow: used.startRow, startCol: used.startCol, endRow, endCol: used.endCol })
        .map((row) =>
          row.map((c) => {
            const v = c.value;
            const denied = v.kind === 'error' && v.code === '#PERM!';
            const raw = v.kind === 'error' || v.kind === 'image' ? null : (v as { value: unknown }).value;
            const scalar =
              typeof raw === 'number' || typeof raw === 'string' || typeof raw === 'boolean' ? raw : null;
            return { value: denied ? null : scalar, denied };
          }),
        );
      return rangeColumnsFromGrid(grid, used.startRow, used.startCol);
    } catch {
      return [];
    }
  }, [host, sheet, version]);

  const acItems: DropdownItem[] = useMemo(() => {
    if (!draft.startsWith('=')) return [];
    const result = autocompleteFormula(draft, caretRef.current, columns);
    if (!result) return [];
    const items: DropdownItem[] = [];
    for (const f of result.functions) {
      items.push({ value: f.name, label: f.name, hint: f.signature || f.category });
    }
    for (const r of result.ranges) {
      items.push({ value: r.ref, label: r.ref, hint: r.label });
    }
    return items;
  }, [draft, columns]);

  const acOpen = acItems.length > 0 && acIndex >= 0;
  useEffect(() => setAcIndex(0), [acItems]);

  const applyCompletion = (value: string) => {
    // Replace the partial token under the caret with the picked completion.
    const caret = caretRef.current;
    const before = draft.slice(0, caret);
    const after = draft.slice(caret);
    const m = before.match(/^(.*?)([A-Za-z_][A-Za-z0-9_.]*)$/s);
    const next = m ? `${m[1]}${value}${after}` : `${before}${value}${after}`;
    setDraft(next);
    setAcIndex(-1);
    // Restore caret after the inserted text.
    requestAnimationFrame(() => {
      const pos = (m ? m[1].length : before.length) + value.length;
      inputRef.current?.setSelectionRange(pos, pos);
      inputRef.current?.focus();
    });
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    caretRef.current = e.currentTarget.selectionStart ?? draft.length;
    if (acOpen) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setAcIndex((i) => (i + 1) % acItems.length);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setAcIndex((i) => (i - 1 + acItems.length) % acItems.length);
        return;
      }
      if (e.key === 'Tab' || e.key === 'Enter') {
        const item = acItems[acIndex];
        if (item) {
          e.preventDefault();
          applyCompletion(item.value);
          return;
        }
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setAcIndex(-1);
        return;
      }
    }
    if (e.key === 'Enter') commit();
    else if (e.key === 'Escape') revert();
  };

  return (
    <div className="formula-bar">
      <input
        ref={addrRef}
        className="formula-address"
        id={addressId}
        value={addrDraft ?? addrDisplay}
        onFocus={(e) => {
          setAddrDraft(addrDisplay);
          e.target.select();
        }}
        onChange={(e) => setAddrDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            commitAddress();
          } else if (e.key === 'Escape') {
            e.preventDefault();
            setAddrDraft(null);
            addrRef.current?.blur();
          }
        }}
        onBlur={() => setAddrDraft(null)}
        aria-label="Name box: type a cell reference and press Enter to go there"
        spellCheck={false}
        autoComplete="off"
      />
      <span className="formula-input-wrap">
        <input
          ref={inputRef}
          className="formula-input"
          value={draft}
          onChange={(e) => {
            caretRef.current = e.target.selectionStart ?? e.target.value.length;
            setDraft(e.target.value);
          }}
          onKeyDown={handleKeyDown}
          onClick={(e) => {
            caretRef.current = e.currentTarget.selectionStart ?? draft.length;
          }}
          aria-label="Formula bar"
          aria-describedby={addressId}
          aria-expanded={acOpen}
          aria-controls={acOpen ? 'formula-ac-listbox' : undefined}
        />
        {acOpen && (
          <AutocompleteDropdown
            idPrefix="formula-ac"
            items={acItems}
            activeIndex={acIndex}
            onPick={(item) => applyCompletion(item.value)}
            onHover={setAcIndex}
          />
        )}
      </span>
    </div>
  );
}

/**
 * Memoized (#77 phase 2): the bar re-renders only when one of its props
 * actually changes — the selection (whose formula/ref it must display),
 * the sheet, the engine tick, or a function-insert request. App hands it
 * stable identities for everything else (host state, commitCell useCallback,
 * handleNameBoxNavigate useCallback, insertRequest state).
 */
export default memo(FormulaBar);
