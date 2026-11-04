/**
 * Inference proposal panel (design-docs/deterministic-inference.md §3).
 *
 * Every inference output is a proposal: description, proposed change, and
 * preview. The user accepts, rejects, or modifies. Nothing is applied
 * without confirmation. Bulk proposals support per-item accept/reject.
 *
 * Props:
 * - proposals: the proposals to show (formula suggestions, cleanup batches)
 * - onAccept(proposal, indices?) / onReject(proposal) / onModify(proposal, newText)
 *   Modify is offered for single-edit proposals (formula text or value text).
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { a1Cell, selectProposalEdits, type Proposal } from '@icecream-sheets/service';

interface InferencePanelProps {
  title: string;
  proposals: Proposal[];
  onAccept: (proposal: Proposal, indices?: number[]) => void;
  onReject: (proposalId: string) => void;
  onModify: (proposal: Proposal, newText: string) => void;
  onClose: () => void;
}

function confidenceLabel(c: number): string {
  if (c >= 0.9) return 'High';
  if (c >= 0.7) return 'Medium';
  return 'Low';
}

function ProposalCard({
  proposal,
  onAccept,
  onReject,
  onModify,
}: {
  proposal: Proposal;
  onAccept: (p: Proposal, indices?: number[]) => void;
  onReject: (id: string) => void;
  onModify: (p: Proposal, newText: string) => void;
}) {
  const [selected, setSelected] = useState<Set<number>>(() => new Set(proposal.edits.map((_, i) => i)));
  const [modifying, setModifying] = useState(false);
  const [modifyText, setModifyText] = useState('');
  const [expanded, setExpanded] = useState(false);

  const singleEdit = proposal.edits.length === 1 ? proposal.edits[0] : null;
  const modifiable =
    singleEdit && (singleEdit.kind === 'setFormula' || singleEdit.kind === 'setValue');

  const previewRows = useMemo(() => {
    const rows = expanded ? proposal.preview : proposal.preview.slice(0, 5);
    return rows;
  }, [proposal.preview, expanded]);

  const toggleItem = (i: number) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });
  };

  const acceptLabel = proposal.bulk
    ? `Apply selected (${selected.size}/${proposal.edits.length})`
    : 'Accept';

  return (
    <div className="inference-card" data-proposal-id={proposal.id}>
      <div className="inference-card-head">
        <div>
          <div className="inference-card-title">{proposal.title}</div>
          <div className="inference-card-meta">
            confidence: {confidenceLabel(proposal.confidence)} ·{' '}
            {proposal.reversible ? 'reversible via Undo' : 'cannot be undone with Undo'} ·{' '}
            {proposal.edits.length} change{proposal.edits.length === 1 ? '' : 's'}
          </div>
        </div>
        <button
          type="button"
          className="inference-card-close"
          onClick={() => onReject(proposal.id)}
          aria-label={`Dismiss ${proposal.title}`}
          title="Reject (dismiss)"
        >
          ✕
        </button>
      </div>
      <p className="inference-card-desc">{proposal.description}</p>

      <table className="inference-preview">
        <thead>
          <tr>
            {proposal.bulk && <th aria-label="select">✓</th>}
            <th>Cell</th>
            <th>Before</th>
            <th>After</th>
          </tr>
        </thead>
        <tbody>
          {previewRows.map((p, i) => {
            const editIdx = proposal.edits.findIndex(
              (e) => e.at.sheet === p.at.sheet && e.at.row === p.at.row && e.at.col === p.at.col,
            );
            return (
              <tr key={i} className={editIdx >= 0 && !selected.has(editIdx) ? 'inference-deselected' : ''}>
                {proposal.bulk && (
                  <td>
                    <input
                      type="checkbox"
                      checked={editIdx >= 0 && selected.has(editIdx)}
                      onChange={() => editIdx >= 0 && toggleItem(editIdx)}
                      aria-label={`Include change at ${a1Cell(p.at)}`}
                    />
                  </td>
                )}
                <td className="inference-cell-ref">{a1Cell(p.at)}</td>
                <td className="inference-before">{p.before}</td>
                <td className="inference-after">{p.after}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {proposal.previewTotal > 5 && !expanded && (
        <button type="button" className="inference-link" onClick={() => setExpanded(true)}>
          Show all {proposal.previewTotal} changes…
        </button>
      )}

      {modifying ? (
        <div className="inference-modify">
          <input
            className="inference-modify-input"
            value={modifyText}
            onChange={(e) => setModifyText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                onModify(proposal, modifyText);
                setModifying(false);
              } else if (e.key === 'Escape') setModifying(false);
            }}
            aria-label="Modified value"
            autoFocus
          />
          <button type="button" onClick={() => { onModify(proposal, modifyText); setModifying(false); }}>
            Apply modified
          </button>
          <button type="button" onClick={() => setModifying(false)}>Cancel</button>
        </div>
      ) : (
        <div className="inference-actions">
          <button
            type="button"
            className="inference-accept"
            disabled={proposal.bulk && selected.size === 0}
            onClick={() =>
              onAccept(proposal, proposal.bulk ? [...selected].sort((a, b) => a - b) : undefined)
            }
          >
            {acceptLabel}
          </button>
          <button type="button" className="inference-reject" onClick={() => onReject(proposal.id)}>
            Reject
          </button>
          {modifiable && singleEdit && (
            <button
              type="button"
              className="inference-modify-btn"
              onClick={() => {
                setModifyText(singleEdit.kind === 'setFormula' ? singleEdit.formula : singleEdit.text);
                setModifying(true);
              }}
            >
              Modify…
            </button>
          )}
        </div>
      )}
    </div>
  );
}

export default function InferencePanel({
  title,
  proposals,
  onAccept,
  onReject,
  onModify,
  onClose,
}: InferencePanelProps) {
  // Non-modal panel (design-docs/accessibility.md §2.3): no focus trap, but
  // move focus into the panel on open and return it on close.
  const panelRef = useRef<HTMLDivElement>(null);
  const openerRef = useRef<Element | null>(null);
  useEffect(() => {
    openerRef.current = document.activeElement;
    panelRef.current?.focus();
    return () => {
      const opener = openerRef.current;
      if (opener instanceof HTMLElement) opener.focus();
    };
  }, []);
  return (
    <div ref={panelRef} className="inference-panel" role="dialog" aria-label={title} tabIndex={-1}>
      <div className="inference-panel-head">
        <h2>{title}</h2>
        <button type="button" onClick={onClose} aria-label="Close panel">✕</button>
      </div>
      <p className="inference-panel-note">
        Suggestions only — nothing is applied until you accept it. Cell changes are reversible via Undo;
        row deletions are not.
      </p>
      {proposals.length === 0 ? (
        <p className="inference-empty">No suggestions found for this sheet.</p>
      ) : (
        <div className="inference-list">
          {proposals.map((p) => (
            <ProposalCard key={p.id} proposal={p} onAccept={onAccept} onReject={onReject} onModify={onModify} />
          ))}
        </div>
      )}
    </div>
  );
}

/** Re-export for tests that exercise selection logic headlessly. */
export { selectProposalEdits };
