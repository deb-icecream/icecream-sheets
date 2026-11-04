/**
 * What-If Analysis dialogs — Goal Seek, Scenario Manager, Data Table
 * (Data tab, track 7).
 */
import { useState } from 'react';
import type { ScenarioSet } from '@icecream-sheets/engine';
import A11yDialog from './A11yDialog';

// ---------------------------------------------------------------------------
// Goal Seek
// ---------------------------------------------------------------------------

interface GoalSeekDialogProps {
  defaultCell: string;
  onClose: () => void;
  onSeek: (targetCell: string, targetValue: number, changingCell: string) => void;
}

export function GoalSeekDialog({ defaultCell, onClose, onSeek }: GoalSeekDialogProps) {
  const [targetCell, setTargetCell] = useState(defaultCell);
  const [targetValue, setTargetValue] = useState('0');
  const [changingCell, setChangingCell] = useState(defaultCell);

  const submit = (): void => {
    const v = Number(targetValue);
    if (!targetCell.trim() || !changingCell.trim() || !Number.isFinite(v)) return;
    onSeek(targetCell.trim().toUpperCase(), v, changingCell.trim().toUpperCase());
    onClose();
  };

  return (
    <A11yDialog title={<>Goal Seek</>} onClose={onClose}>
        <label className="dialog-row">
          <span>Set cell:</span>
          <input value={targetCell} onChange={(e) => setTargetCell(e.target.value)} placeholder="C1" />
        </label>
        <label className="dialog-row">
          <span>To value:</span>
          <input value={targetValue} onChange={(e) => setTargetValue(e.target.value)} placeholder="100" />
        </label>
        <label className="dialog-row">
          <span>By changing cell:</span>
          <input value={changingCell} onChange={(e) => setChangingCell(e.target.value)} placeholder="A1" />
        </label>
        <div className="dialog-actions">
          <button onClick={submit}>OK</button>
          <button onClick={onClose}>Cancel</button>
        </div>
      </A11yDialog>
  );
}

// ---------------------------------------------------------------------------
// Scenario Manager
// ---------------------------------------------------------------------------

interface ScenarioManagerDialogProps {
  scenarioSet: ScenarioSet;
  onClose: () => void;
  onAdd: (name: string, changingCells: string, comment: string) => void;
  onDelete: (name: string) => void;
  onShow: (name: string) => void;
  onSummary: () => void;
}

export function ScenarioManagerDialog({
  scenarioSet,
  onClose,
  onAdd,
  onDelete,
  onShow,
  onSummary,
}: ScenarioManagerDialogProps) {
  const [name, setName] = useState('');
  const [changingCells, setChangingCells] = useState('');
  const [comment, setComment] = useState('');
  const [selected, setSelected] = useState<string | null>(scenarioSet.scenarios[0]?.name ?? null);

  const submitAdd = (): void => {
    if (!name.trim() || !changingCells.trim()) return;
    onAdd(name.trim(), changingCells.trim(), comment.trim());
    setName('');
    setChangingCells('');
    setComment('');
  };

  return (
    <A11yDialog title={<>Scenario Manager</>} onClose={onClose} className="dialog-wide">
        <div className="dialog-section">
          <span>Scenarios:</span>
          {scenarioSet.scenarios.length === 0 && <div className="dialog-hint">No scenarios yet.</div>}
          {scenarioSet.scenarios.map((s) => (
            <label className="dialog-row" key={s.name}>
              <input
                type="radio"
                name="scenario"
                checked={selected === s.name}
                onChange={() => setSelected(s.name)}
              />
              <span>
                {s.name} <span className="dialog-hint">({s.changingCells.join(', ')})</span>
              </span>
            </label>
          ))}
        </div>
        <div className="dialog-actions">
          <button onClick={() => selected && onShow(selected)} disabled={!selected}>
            Show
          </button>
          <button onClick={() => selected && onDelete(selected)} disabled={!selected}>
            Delete
          </button>
          <button onClick={onSummary} disabled={scenarioSet.scenarios.length === 0}>
            Summary
          </button>
        </div>
        <div className="dialog-section">
          <div className="dialog-title">Add scenario</div>
          <label className="dialog-row">
            <span>Name:</span>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Best case" />
          </label>
          <label className="dialog-row">
            <span>Changing cells:</span>
            <input
              value={changingCells}
              onChange={(e) => setChangingCells(e.target.value)}
              placeholder="A1, B1"
            />
          </label>
          <label className="dialog-row">
            <span>Comment:</span>
            <input value={comment} onChange={(e) => setComment(e.target.value)} placeholder="optional" />
          </label>
          <div className="dialog-actions">
            <button onClick={submitAdd} disabled={!name.trim() || !changingCells.trim()}>
              Add
            </button>
          </div>
          <div className="dialog-hint">Current cell values are captured as the scenario values.</div>
        </div>
        <div className="dialog-actions">
          <button onClick={onClose}>Close</button>
        </div>
      </A11yDialog>
  );
}

// ---------------------------------------------------------------------------
// Data Table
// ---------------------------------------------------------------------------

export type DataTableKind = 'one-var' | 'two-var';

interface DataTableDialogProps {
  onClose: () => void;
  onCreate: (kind: DataTableKind, inputCell: string, rowInputCell: string, colInputCell: string) => void;
}

export function DataTableDialog({ onClose, onCreate }: DataTableDialogProps) {
  const [kind, setKind] = useState<DataTableKind>('one-var');
  const [inputCell, setInputCell] = useState('');
  const [rowInputCell, setRowInputCell] = useState('');
  const [colInputCell, setColInputCell] = useState('');

  const submit = (): void => {
    if (kind === 'one-var' && !inputCell.trim()) return;
    if (kind === 'two-var' && (!rowInputCell.trim() || !colInputCell.trim())) return;
    onCreate(kind, inputCell.trim().toUpperCase(), rowInputCell.trim().toUpperCase(), colInputCell.trim().toUpperCase());
    onClose();
  };

  return (
    <A11yDialog title={<>Data Table</>} onClose={onClose}>
        <div className="dialog-row" role="radiogroup" aria-label="Table kind">
          <label>
            <input type="radio" name="dt-kind" checked={kind === 'one-var'} onChange={() => setKind('one-var')} />
            One-variable
          </label>
          <label>
            <input type="radio" name="dt-kind" checked={kind === 'two-var'} onChange={() => setKind('two-var')} />
            Two-variable
          </label>
        </div>
        {kind === 'one-var' ? (
          <label className="dialog-row">
            <span>Column input cell:</span>
            <input value={inputCell} onChange={(e) => setInputCell(e.target.value)} placeholder="A1" />
          </label>
        ) : (
          <>
            <label className="dialog-row">
              <span>Row input cell:</span>
              <input value={rowInputCell} onChange={(e) => setRowInputCell(e.target.value)} placeholder="A1" />
            </label>
            <label className="dialog-row">
              <span>Column input cell:</span>
              <input value={colInputCell} onChange={(e) => setColInputCell(e.target.value)} placeholder="B1" />
            </label>
          </>
        )}
        <div className="dialog-hint">
          Select the value column (one-variable) or value matrix (two-variable) first — the table
          fills from the formulas in the selected row.
        </div>
        <div className="dialog-actions">
          <button onClick={submit}>OK</button>
          <button onClick={onClose}>Cancel</button>
        </div>
      </A11yDialog>
  );
}
