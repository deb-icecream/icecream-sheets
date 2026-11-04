/**
 * Solver dialog — Excel Solver parity (Data tab, track 7).
 * Collects the SolverSpec; the parent runs `solve()` with an evaluator
 * implemented over the typed view and applies the result through authorize().
 */
import { useState } from 'react';
import type {
  SolverConstraint,
  SolverConstraintOp,
  SolverObjective,
  SolverSpec,
} from '@icecream-sheets/engine';
import A11yDialog from './A11yDialog';

interface SolverDialogProps {
  /** A1 of the currently selected cell (default objective/variable). */
  defaultCell: string;
  onClose: () => void;
  onSolve: (spec: SolverSpec) => void;
}

const OPS: SolverConstraintOp[] = ['<=', '>=', '=', 'int', 'bin'];

export default function SolverDialog({ defaultCell, onClose, onSolve }: SolverDialogProps) {
  const [objectiveCell, setObjectiveCell] = useState(defaultCell);
  const [objective, setObjective] = useState<SolverObjective>('max');
  const [targetValue, setTargetValue] = useState('0');
  const [variableCells, setVariableCells] = useState(defaultCell);
  const [constraints, setConstraints] = useState<SolverConstraint[]>([]);

  const addConstraint = (): void =>
    setConstraints((cs) => [...cs, { cell: defaultCell, op: '<=', rhs: 0 }]);

  const updateConstraint = (i: number, patch: Partial<SolverConstraint>): void =>
    setConstraints((cs) => cs.map((c, j) => (j === i ? { ...c, ...patch } : c)));

  const removeConstraint = (i: number): void =>
    setConstraints((cs) => cs.filter((_, j) => j !== i));

  const submit = (): void => {
    const vars = variableCells
      .split(/[,;\s]+/)
      .map((s) => s.trim().toUpperCase())
      .filter(Boolean);
    if (vars.length === 0) return;
    onSolve({
      version: 1,
      objectiveCell: objectiveCell.trim().toUpperCase() || defaultCell,
      objective,
      targetValue: objective === 'value' ? Number(targetValue) || 0 : undefined,
      variableCells: vars,
      constraints: constraints.map((c) => ({
        cell: c.cell.trim().toUpperCase(),
        op: c.op,
        rhs: Number(c.rhs) || 0,
      })),
    });
    onClose();
  };

  return (
    <A11yDialog title={<>Solver</>} onClose={onClose}>
        <label className="dialog-row">
          <span>Set objective:</span>
          <input value={objectiveCell} onChange={(e) => setObjectiveCell(e.target.value)} placeholder="C1" />
        </label>
        <div className="dialog-row" role="radiogroup" aria-label="Objective">
          {(['max', 'min', 'value'] as const).map((o) => (
            <label key={o}>
              <input type="radio" name="solver-obj" checked={objective === o} onChange={() => setObjective(o)} />
              {o === 'max' ? 'Max' : o === 'min' ? 'Min' : 'Value of'}
            </label>
          ))}
          {objective === 'value' && (
            <input
              value={targetValue}
              onChange={(e) => setTargetValue(e.target.value)}
              placeholder="target"
              aria-label="Target value"
            />
          )}
        </div>
        <label className="dialog-row">
          <span>By changing cells:</span>
          <input
            value={variableCells}
            onChange={(e) => setVariableCells(e.target.value)}
            placeholder="A1, B1"
            title="Comma or space separated A1 references"
          />
        </label>
        <div className="dialog-section">
          <div className="dialog-row">
            <span>Subject to constraints:</span>
            <button onClick={addConstraint}>Add</button>
          </div>
          {constraints.map((c, i) => (
            <div className="dialog-row" key={i}>
              <input
                value={c.cell}
                onChange={(e) => updateConstraint(i, { cell: e.target.value })}
                placeholder="D1"
                aria-label="Constraint cell"
              />
              <select value={c.op} onChange={(e) => updateConstraint(i, { op: e.target.value as SolverConstraintOp })}>
                {OPS.map((op) => (
                  <option key={op} value={op}>
                    {op}
                  </option>
                ))}
              </select>
              {c.op !== 'int' && c.op !== 'bin' && (
                <input
                  value={String(c.rhs)}
                  onChange={(e) => updateConstraint(i, { rhs: Number(e.target.value) || 0 })}
                  placeholder="value"
                  aria-label="Constraint value"
                />
              )}
              <button onClick={() => removeConstraint(i)} aria-label="Remove constraint">
                ×
              </button>
            </div>
          ))}
          {constraints.length === 0 && <div className="dialog-hint">No constraints.</div>}
        </div>
        <div className="dialog-actions">
          <button onClick={submit} disabled={variableCells.trim() === ''}>
            Solve
          </button>
          <button onClick={onClose}>Cancel</button>
        </div>
      </A11yDialog>
  );
}
