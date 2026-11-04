/**
 * Go To… / Go To Special… dialog (Home > Editing > Find & Select).
 *
 * Two modes in one dialog, like Excel:
 * - Go To: A1 reference input + named-range list; Enter jumps the grid.
 * - Go To Special: Constants / Formulas / Blanks / Current Region —
 *   evaluated against the live sheet through the accessor props.
 *
 * Also hosts the Select Objects toggle, which switches the overlay layer
 * into object-selection mode (shapes/pictures instead of cells).
 */
import { useState } from 'react';
import { a1Short, colLabel } from '../engine';
import A11yDialog from './A11yDialog';
import {
  currentRegion,
  findSpecialCells,
  parseGoToTarget,
  type GoToAccess,
  type GoToSpecialKind,
  type UsedBounds,
} from '../features/goto';
import type { NamedRangeStore, NamedRangeDef } from '@icecream-sheets/service';

export interface GoToDialogProps {
  sheet: string;
  store: NamedRangeStore;
  /** 'goto' or 'special' initial mode (Excel opens Special from its own menu item). */
  initialMode: 'goto' | 'special';
  /** Live cell accessor for the active sheet. */
  access: GoToAccess;
  /** The active cell (anchor for Current Region). */
  anchor: { row: number; col: number };
  /** Focus a single cell (sheet, row, col). */
  onGoToCell: (sheet: string, row: number, col: number) => void;
  /** Select a rectangular range (used by Current Region). */
  onGoToRange: (sheet: string, range: UsedBounds) => void;
  /** Object-selection mode for shapes/pictures. */
  objectMode: boolean;
  onToggleObjects: () => void;
  onError: (msg: string) => void;
  onClose: () => void;
}

const SPECIAL_KINDS: { id: GoToSpecialKind; label: string; hint: string }[] = [
  { id: 'constants', label: 'Constants', hint: 'Cells with typed values (not formulas)' },
  { id: 'formulas', label: 'Formulas', hint: 'Cells containing formulas' },
  { id: 'blanks', label: 'Blanks', hint: 'Empty cells inside the used range' },
];

function rangeLabel(r: UsedBounds): string {
  const tl = a1Short(r.startRow, r.startCol);
  const br = a1Short(r.endRow, r.endCol);
  return tl === br ? tl : `${tl}:${br}`;
}

export function GoToDialog({
  sheet,
  store,
  initialMode,
  access,
  anchor,
  onGoToCell,
  onGoToRange,
  objectMode,
  onToggleObjects,
  onError,
  onClose,
}: GoToDialogProps) {
  const [mode, setMode] = useState<'goto' | 'special'>(initialMode);
  const [refText, setRefText] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const namedRanges: NamedRangeDef[] = store.list();
  // Dangling (#REF!) names have no cells to navigate to.
  const gotoRanges = namedRanges.filter(
    (d): d is NamedRangeDef & { ref: NonNullable<NamedRangeDef['ref']> } => d.ref !== null,
  );

  const goToRef = () => {
    const target = parseGoToTarget(refText, namedRanges);
    if (!target) {
      onError(`Cannot go to "${refText}": not a valid reference or defined name.`);
      return;
    }
    if (
      target.startRow === target.endRow &&
      target.startCol === target.endCol
    ) {
      onGoToCell(sheet, target.startRow, target.startCol);
    } else {
      onGoToRange(sheet, target);
    }
    onClose();
  };

  const goToSpecial = (kind: GoToSpecialKind) => {
    const found = findSpecialCells(access, kind);
    if (found.length === 0) {
      setMessage(`No ${kind} found on ${sheet}.`);
      return;
    }
    const first = found[0];
    onGoToCell(sheet, first.row, first.col);
    setMessage(`${found.length} ${kind} found — jumped to ${a1Short(first.row, first.col)}.`);
  };

  return (
    <A11yDialog title={<>{mode === 'goto' ? 'Go To' : 'Go To Special'}</>} onClose={onClose}>

        <div className="dialog-row" role="tablist" aria-label="Go to mode">
          <button type="button" onClick={() => setMode('goto')} disabled={mode === 'goto'}>
            Go To
          </button>
          <button type="button" onClick={() => setMode('special')} disabled={mode === 'special'} style={{ marginLeft: 8 }}>
            Special…
          </button>
        </div>

        {mode === 'goto' ? (
          <>
            <label className="dialog-row">
              <span>Reference:</span>
              <input
                autoFocus
                value={refText}
                onChange={(e) => setRefText(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && goToRef()}
                placeholder="A1 or A1:C10"
                style={{ marginLeft: 8, minWidth: 160 }}
              />
            </label>
            {gotoRanges.length > 0 && (
              <div className="dialog-row" style={{ flexDirection: 'column', alignItems: 'stretch' }}>
                <span style={{ marginBottom: 4 }}>Defined names:</span>
                <div style={{ border: '1px solid #ccc', maxHeight: 140, overflowY: 'auto' }}>
                  {gotoRanges.map((n) => (
                    <button
                      key={n.id}
                      type="button"
                      onClick={() => {
                        onGoToRange(n.ref.sheet, {
                          startRow: n.ref.startRow,
                          startCol: n.ref.startCol,
                          endRow: n.ref.endRow,
                          endCol: n.ref.endCol,
                        });
                        onClose();
                      }}
                      style={{
                        display: 'block',
                        width: '100%',
                        textAlign: 'left',
                        border: 'none',
                        background: 'none',
                        padding: '4px 8px',
                        cursor: 'pointer',
                      }}
                      title={n.ref ? `${n.ref.sheet}!${rangeLabel(n.ref)}` : n.name}
                    >
                      {n.name} {n.ref && <span style={{ color: '#888' }}>({colLabel(n.ref.startCol)}{n.ref.startRow + 1})</span>}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </>
        ) : (
          <>
            <div className="dialog-hint">Select cells by type on {sheet}.</div>
            {SPECIAL_KINDS.map((k) => (
              <div key={k.id} className="dialog-row">
                <button type="button" onClick={() => goToSpecial(k.id)} style={{ minWidth: 110 }}>
                  {k.label}
                </button>
                <span style={{ marginLeft: 8, color: '#666', fontSize: 12 }}>{k.hint}</span>
              </div>
            ))}
            <CurrentRegionRow sheet={sheet} access={access} anchor={anchor} onGoToRange={onGoToRange} onClose={onClose} />
          </>
        )}

        {message && <div className="dialog-hint">{message}</div>}

        <label className="dialog-row" style={{ cursor: 'pointer', borderTop: '1px solid #eee', paddingTop: 8 }}>
          <input
            type="checkbox"
            checked={objectMode}
            onChange={onToggleObjects}
            style={{ marginRight: 8 }}
          />
          Select Objects (click shapes and pictures instead of cells)
        </label>

        <div className="dialog-actions">
          {mode === 'goto' && <button onClick={goToRef}>Go To</button>}
          <button onClick={onClose}>Close</button>
        </div>
      </A11yDialog>
  );
}

function CurrentRegionRow({
  sheet,
  access,
  anchor,
  onGoToRange,
  onClose,
}: {
  sheet: string;
  access: GoToAccess;
  anchor: { row: number; col: number };
  onGoToRange: (sheet: string, range: UsedBounds) => void;
  onClose: () => void;
}) {
  return (
    <div className="dialog-row">
      <button
        type="button"
        style={{ minWidth: 110 }}
        title="Select the contiguous block of data around the active cell"
        onClick={() => {
          const region = currentRegion(access, anchor.row, anchor.col);
          onGoToRange(sheet, region);
          onClose();
        }}
      >
        Current Region
      </button>
      <span style={{ marginLeft: 8, color: '#666', fontSize: 12 }}>
        The contiguous data block around the active cell
      </span>
    </div>
  );
}

export type { UsedBounds };
