/**
 * Move or Copy Sheet… dialog (Home > Cells > Format > Move or Copy Sheet…).
 *
 * Pure UI: reports the user's choice through onMoveCopy. The parent applies
 * it (reorder the sheets array; for a copy, duplicate the sheet's cells —
 * see the wiring spec in the report).
 */
import { useState } from 'react';
import A11yDialog from './A11yDialog';

export interface MoveCopySheetDialogProps {
  /** All sheet names in tab order. */
  sheets: string[];
  /** The sheet the dialog was opened from. */
  currentSheet: string;
  onClose: () => void;
  /**
   * @param from      source sheet name
   * @param toIndex   insert before this index, or null for "(move to end)"
   * @param createCopy true = copy, false = move
   */
  onMoveCopy: (from: string, toIndex: number | null, createCopy: boolean) => void;
}

export function MoveCopySheetDialog({ sheets, currentSheet, onClose, onMoveCopy }: MoveCopySheetDialogProps) {
  const [toIndex, setToIndex] = useState<number | null>(null);
  const [createCopy, setCreateCopy] = useState(false);

  const submit = () => {
    onMoveCopy(currentSheet, toIndex, createCopy);
    onClose();
  };

  return (
    <A11yDialog title={<>Move or Copy</>} onClose={onClose}>
        <div className="dialog-row">
          <span style={{ fontWeight: 600 }}>Move selected sheet</span>
        </div>
        <label className="dialog-row">
          <span>To book:</span>
          <select value="current" disabled title="Only the current workbook is available" style={{ marginLeft: 8 }}>
            <option value="current">(current workbook)</option>
          </select>
        </label>
        <div className="dialog-row" style={{ flexDirection: 'column', alignItems: 'stretch' }}>
          <span style={{ marginBottom: 4 }}>Before sheet:</span>
          <div style={{ border: '1px solid #ccc', maxHeight: 160, overflowY: 'auto' }}>
            {sheets.map((name, i) => (
              <label
                key={name}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  padding: '4px 8px',
                  cursor: 'pointer',
                  background: toIndex === i ? '#e8f0fe' : undefined,
                }}
              >
                <input
                  type="radio"
                  name="move-before"
                  checked={toIndex === i}
                  onChange={() => setToIndex(i)}
                  style={{ marginRight: 8 }}
                />
                {name}
              </label>
            ))}
            <label
              style={{
                display: 'flex',
                alignItems: 'center',
                padding: '4px 8px',
                cursor: 'pointer',
                background: toIndex === null ? '#e8f0fe' : undefined,
              }}
            >
              <input
                type="radio"
                name="move-before"
                checked={toIndex === null}
                onChange={() => setToIndex(null)}
                style={{ marginRight: 8 }}
              />
              (move to end)
            </label>
          </div>
        </div>
        <label className="dialog-row" style={{ cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={createCopy}
            onChange={(e) => setCreateCopy(e.target.checked)}
            style={{ marginRight: 8 }}
          />
          Create a copy
        </label>
        <div className="dialog-actions">
          <button onClick={submit}>{createCopy ? 'Create Copy' : 'Move'}</button>
          <button onClick={onClose}>Cancel</button>
        </div>
      </A11yDialog>
  );
}
