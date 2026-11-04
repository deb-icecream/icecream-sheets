/**
 * Flash Fill proposal dialog — deterministic inference (track 16,
 * design-docs/deterministic-inference.md).
 *
 * Shows the synthesized pattern, the equivalent formula for inspection, and
 * a preview of proposed values. Nothing is applied until the user clicks
 * "Fill" — per the design, proposals are inspectable and reversible.
 */
import type { FlashFillProposal } from '@icecream-sheets/engine';
import A11yDialog from './A11yDialog';

interface FlashFillDialogProps {
  proposal: FlashFillProposal;
  /** A1 of the source column's first filled cell, for formula display. */
  sourceRef: string;
  previewRows: { input: string; output: string }[];
  onClose: () => void;
  onApply: () => void;
  onApplyAsFormulas: () => void;
}

export default function FlashFillDialog({
  proposal,
  sourceRef,
  previewRows,
  onClose,
  onApply,
  onApplyAsFormulas,
}: FlashFillDialogProps) {
  const formula = proposal.formulaTemplate.replaceAll('{input}', sourceRef).replaceAll('{inputA}', sourceRef);

  return (
    <A11yDialog title={<>Flash Fill — proposal</>} onClose={onClose}>
        <div className="dialog-row">
          <span>Pattern detected:</span>
          <strong>{proposal.description}</strong>
        </div>
        <div className="dialog-row">
          <span>Equivalent formula:</span>
          <code>{formula}</code>
        </div>
        <div className="dialog-section">
          <span>Preview:</span>
          <table className="dialog-preview-table">
            <thead>
              <tr>
                <th>Source</th>
                <th>Proposed</th>
              </tr>
            </thead>
            <tbody>
              {previewRows.slice(0, 8).map((r, i) => (
                <tr key={i}>
                  <td>{r.input}</td>
                  <td>{r.output}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {previewRows.length > 8 && (
            <div className="dialog-hint">…and {previewRows.length - 8} more rows.</div>
          )}
        </div>
        <div className="dialog-actions">
          <button onClick={onApply} title="Fill with the proposed values">
            Fill values
          </button>
          <button onClick={onApplyAsFormulas} title="Fill with formulas instead of static values">
            Fill as formulas
          </button>
          <button onClick={onClose}>Cancel</button>
        </div>
      </A11yDialog>
  );
}
