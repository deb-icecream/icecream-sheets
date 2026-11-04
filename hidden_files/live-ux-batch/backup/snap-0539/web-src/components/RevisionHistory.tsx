/**
 * Revision history dialog (track 10): the CollabSession's change log —
 * every op applied through the OT pipeline, with principal + timestamp.
 */
import type { ChangeRecord } from '@icecream-sheets/engine';
import A11yDialog from './A11yDialog';

function describeOp(r: ChangeRecord): string {
  const p = r.op.params;
  switch (r.op.type) {
    case 'cell.set': {
      const v = p['value'];
      const shown = typeof v === 'string' && v.length > 24 ? `${v.slice(0, 24)}…` : String(v);
      return `Set ${p['sheet']}!${colLabel(p['col'] as number)}${(p['row'] as number) + 1} = ${shown}`;
    }
    case 'cell.clear':
      return `Cleared ${p['sheet']}!${colLabel(p['col'] as number)}${(p['row'] as number) + 1}`;
    case 'rows.insert':
      return `Inserted ${p['count']} row(s) at ${p['sheet']}!${(p['at'] as number) + 1}`;
    case 'rows.delete':
      return `Deleted ${p['count']} row(s) at ${p['sheet']}!${(p['at'] as number) + 1}`;
    case 'cols.insert':
      return `Inserted ${p['count']} column(s) at ${p['sheet']}!${colLabel(p['at'] as number)}`;
    case 'cols.delete':
      return `Deleted ${p['count']} column(s) at ${p['sheet']}!${colLabel(p['at'] as number)}`;
    case 'sheet.add':
      return `Added sheet "${p['name']}"`;
    case 'sheet.delete':
      return `Deleted sheet "${p['name']}"`;
    case 'sheet.rename':
      return `Renamed sheet "${p['from']}" → "${p['to']}"`;
    default:
      return r.op.type;
  }
}

function colLabel(col: number): string {
  let label = '';
  let n = col;
  do {
    label = String.fromCharCode(65 + (n % 26)) + label;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return label;
}

interface RevisionHistoryProps {
  changes: ChangeRecord[];
  onClose: () => void;
}

export default function RevisionHistoryDialog({ changes, onClose }: RevisionHistoryProps) {
  const rows = [...changes].reverse();
  return (
    <A11yDialog title={<>Revision history ({changes.length} change{changes.length === 1 ? '' : 's'})</>} width={520} onClose={onClose}>
        <div style={{ maxHeight: 360, overflowY: 'auto', margin: '8px 0' }}>
          {rows.length === 0 ? (
            <p style={{ color: 'var(--text-dim)' }}>No changes yet — edits you make flow through the collaboration session and appear here.</p>
          ) : (
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr style={{ textAlign: 'left', borderBottom: '1px solid var(--line-soft)' }}>
                  <th style={{ padding: '4px 8px' }}>Rev</th>
                  <th style={{ padding: '4px 8px' }}>Change</th>
                  <th style={{ padding: '4px 8px' }}>By</th>
                  <th style={{ padding: '4px 8px' }}>At</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.revision} style={{ borderBottom: '1px solid var(--line-soft)' }}>
                    <td style={{ padding: '4px 8px' }}>{r.revision}</td>
                    <td style={{ padding: '4px 8px' }}>{describeOp(r)}</td>
                    <td style={{ padding: '4px 8px' }}>{r.principal}</td>
                    <td style={{ padding: '4px 8px' }} title={r.at}>
                      {new Date(r.at).toLocaleTimeString()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
        <p style={{ fontSize: 12, color: 'var(--text-dim)' }}>
          Real-time multi-client sync is v2; this log is the live local integration — every edit above went through the OT pipeline.
        </p>
        <div className="dialog-actions">
          <button onClick={onClose}>Close</button>
        </div>
      </A11yDialog>
  );
}
