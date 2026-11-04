/**
 * AuditOverlays: Formula Auditing visuals.
 * - AuditArrowsOverlay: SVG tracer arrows for precedents/dependents over the grid
 * - ErrorCheckingDialog: step through error cells with navigation
 * - EvaluateFormulaDialog: step-through formula evaluation with real
 *   intermediate results (via the parent's engine-backed evaluator)
 * - WatchWindow: floating panel of watched cells with live values
 */
import { useState } from 'react';
import {
  nextEvalStep,
  type AuditArrow,
  type AuditError,
  type EvalStep,
} from '../features/auditing';
import type { CellRef } from '@icecream-sheets/engine';

// ---------------------------------------------------------------------------
// Tracer arrows
// ---------------------------------------------------------------------------

export interface AuditArrowsOverlayProps {
  arrows: AuditArrow[];
  /** Pixel x of the left edge of column `col`. */
  cellX: (col: number) => number;
  /** Pixel y of the top edge of row `row`. */
  cellY: (row: number) => number;
  cellW: number;
  cellH: number;
  width: number;
  height: number;
  onClear: () => void;
}

function cellCenter(x: (i: number) => number, i: number, size: number): number {
  return x(i) + size / 2;
}

export function AuditArrowsOverlay({ arrows, cellX, cellY, cellW, cellH, width, height, onClear }: AuditArrowsOverlayProps) {
  if (arrows.length === 0) return null;
  return (
    <div style={{ position: 'absolute', left: 0, top: 0, width, height, pointerEvents: 'none', zIndex: 28 }}>
      <svg width={width} height={height} style={{ display: 'block', overflow: 'visible' }}>
        <defs>
          <marker id="audit-arrow-blue" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto">
            <polygon points="0 0, 8 4, 0 8" fill="#1a73e8" />
          </marker>
          <marker id="audit-arrow-red" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto">
            <polygon points="0 0, 8 4, 0 8" fill="#d93025" />
          </marker>
        </defs>
        {arrows.map((a, i) => {
          const x1 = cellCenter(cellX, a.from.col, cellW);
          const y1 = cellCenter(cellY, a.from.row, cellH);
          const x2 = cellCenter(cellX, a.to.col, cellW);
          const y2 = cellCenter(cellY, a.to.row, cellH);
          const color = a.kind === 'precedent' ? '#1a73e8' : '#d93025';
          return (
            <g key={i}>
              <circle cx={x1} cy={y1} r={3} fill={color} />
              <line
                x1={x1}
                y1={y1}
                x2={x2}
                y2={y2}
                stroke={color}
                strokeWidth={1.5}
                markerEnd={`url(#audit-arrow-${a.kind === 'precedent' ? 'blue' : 'red'})`}
              />
            </g>
          );
        })}
      </svg>
      <button
        onClick={onClear}
        style={{ position: 'absolute', top: 4, right: 4, pointerEvents: 'auto', fontSize: 11, cursor: 'pointer' }}
        title="Remove all tracer arrows"
      >
        Remove Arrows ✕
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Error Checking
// ---------------------------------------------------------------------------

export interface ErrorCheckingDialogProps {
  errors: AuditError[];
  onGoTo: (ref: CellRef) => void;
  onClose: () => void;
}

function colLabel(c: number): string {
  let n = c + 1;
  let s = '';
  while (n > 0) {
    const m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

export function ErrorCheckingDialog({ errors, onGoTo, onClose }: ErrorCheckingDialogProps) {
  const [index, setIndex] = useState(0);
  const current = errors[index];
  return (
    <div
      className="dialog-backdrop"
      onClick={onClose}
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', zIndex: 100, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
    >
      <div
        className="dialog"
        onClick={(e) => e.stopPropagation()}
        style={{ background: '#fff', borderRadius: 8, width: 'min(440px, 94vw)' }}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 14px', borderBottom: '1px solid #ddd' }}>
          <strong>Error Checking</strong>
          <button onClick={onClose}>Close</button>
        </div>
        <div style={{ padding: 14, fontSize: 13 }}>
          {errors.length === 0 ? (
            <p style={{ color: '#2e7d32' }}>No errors found in the used range.</p>
          ) : (
            current && (
              <>
                <p>
                  Error {index + 1} of {errors.length}:{' '}
                  <strong style={{ fontFamily: 'monospace' }}>
                    {current.ref.sheet}!{colLabel(current.ref.col)}{current.ref.row + 1}
                  </strong>{' '}
                  = <span style={{ fontFamily: 'monospace', color: '#b00020' }}>{current.valueText}</span>
                </p>
                {current.formula && (
                  <p style={{ fontFamily: 'monospace', background: '#f5f5f5', padding: 8, borderRadius: 4 }}>
                    {current.formula}
                  </p>
                )}
                <div style={{ display: 'flex', gap: 8 }}>
                  <button onClick={() => setIndex((i) => (i - 1 + errors.length) % errors.length)} title="Previous error">← Previous</button>
                  <button onClick={() => setIndex((i) => (i + 1) % errors.length)} title="Next error">Next →</button>
                  <button onClick={() => onGoTo(current.ref)} title="Select this cell in the grid">Go to cell</button>
                </div>
              </>
            )
          )}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Evaluate Formula
// ---------------------------------------------------------------------------

export interface EvaluateFormulaDialogProps {
  /** The formula being evaluated, e.g. "=SUM(A1:A3)*2". */
  formula: string;
  cellLabel: string;
  /**
   * Evaluate one expression string against the engine and return its
   * display text. The App implements this (e.g. via a scratch evaluation
   * through the host); every step shown is a real computed value.
   */
  onEvaluateExpression: (expr: string) => string;
  onClose: () => void;
}

export function EvaluateFormulaDialog({ formula, cellLabel, onEvaluateExpression, onClose }: EvaluateFormulaDialogProps) {
  const [current, setCurrent] = useState(formula);
  const [steps, setSteps] = useState<EvalStep[]>([]);
  const [done, setDone] = useState(false);
  const [result, setResult] = useState('');

  const step = () => {
    if (done || steps.length > 200) return;
    const r = nextEvalStep(current, onEvaluateExpression);
    if (r.done) {
      setDone(true);
      setResult(r.result);
    } else {
      setSteps((s) => [...s, r.step]);
      setCurrent(r.next);
    }
  };

  const restart = () => {
    setCurrent(formula);
    setSteps([]);
    setDone(false);
    setResult('');
  };

  return (
    <div
      className="dialog-backdrop"
      onClick={onClose}
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', zIndex: 100, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
    >
      <div
        className="dialog"
        onClick={(e) => e.stopPropagation()}
        style={{ background: '#fff', borderRadius: 8, width: 'min(520px, 94vw)', maxHeight: '90vh', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 14px', borderBottom: '1px solid #ddd' }}>
          <strong>Evaluate Formula — {cellLabel}</strong>
          <button onClick={onClose}>Close</button>
        </div>
        <div style={{ padding: 14, fontSize: 13, overflowY: 'auto' }}>
          <p style={{ marginTop: 0, color: '#666' }}>Reference: <span style={{ fontFamily: 'monospace' }}>{formula}</span></p>
          <div
            style={{ fontFamily: 'monospace', background: '#f5f5f5', padding: 10, borderRadius: 4, minHeight: 40, wordBreak: 'break-all' }}
            aria-live="polite"
          >
            {done ? <strong>{result}</strong> : current}
          </div>
          {steps.length > 0 && (
            <ol style={{ marginTop: 10, paddingLeft: 20 }}>
              {steps.map((s, i) => (
                <li key={i} style={{ fontFamily: 'monospace', marginBottom: 2 }}>
                  {s.expression} → <strong>{s.result}</strong>
                </li>
              ))}
            </ol>
          )}
          {done && <p style={{ color: '#2e7d32' }}>Evaluation complete.</p>}
        </div>
        <div style={{ padding: '10px 14px', borderTop: '1px solid #ddd', display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button onClick={restart} title="Restart evaluation">Restart</button>
          <button onClick={step} disabled={done} title="Evaluate the next innermost subexpression">Evaluate</button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Watch Window
// ---------------------------------------------------------------------------

export interface WatchWindowProps {
  watches: CellRef[];
  /** Live display text for a cell; the parent re-renders on engine ticks. */
  readValue: (ref: CellRef) => string;
  readFormula: (ref: CellRef) => string;
  onRemove: (ref: CellRef) => void;
  onAddCurrent: () => void;
  onClose: () => void;
}

export function WatchWindow({ watches, readValue, readFormula, onRemove, onAddCurrent, onClose }: WatchWindowProps) {
  return (
    <div
      style={{
        position: 'fixed',
        right: 16,
        bottom: 48,
        width: 380,
        maxHeight: 300,
        background: '#fff',
        border: '1px solid #ccc',
        borderRadius: 8,
        boxShadow: '0 4px 16px rgba(0,0,0,0.2)',
        zIndex: 90,
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        fontSize: 12,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 12px', borderBottom: '1px solid #ddd' }}>
        <strong>Watch Window</strong>
        <div style={{ display: 'flex', gap: 6 }}>
          <button onClick={onAddCurrent} title="Watch the currently selected cell">+ Add</button>
          <button onClick={onClose}>✕</button>
        </div>
      </div>
      <div style={{ overflowY: 'auto' }}>
        {watches.length === 0 && <p style={{ padding: '8px 12px', color: '#666' }}>No watched cells. Select a cell and press + Add.</p>}
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{ textAlign: 'left', color: '#666' }}>
              <th style={{ padding: '4px 8px' }}>Cell</th>
              <th style={{ padding: '4px 8px' }}>Value</th>
              <th style={{ padding: '4px 8px' }}>Formula</th>
              <th style={{ padding: '4px 8px' }}></th>
            </tr>
          </thead>
          <tbody>
            {watches.map((w, i) => (
              <tr key={`${w.sheet}!${w.row},${w.col}`} style={{ borderTop: '1px solid #eee' }}>
                <td style={{ padding: '4px 8px', fontFamily: 'monospace' }}>
                  {w.sheet}!{colLabel(w.col)}{w.row + 1}
                </td>
                <td style={{ padding: '4px 8px', fontFamily: 'monospace' }}>{readValue(w)}</td>
                <td style={{ padding: '4px 8px', fontFamily: 'monospace', color: '#666', maxWidth: 140, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {readFormula(w)}
                </td>
                <td style={{ padding: '4px 8px' }}>
                  <button onClick={() => onRemove(watches[i])} title="Stop watching" style={{ cursor: 'pointer' }}>✕</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
