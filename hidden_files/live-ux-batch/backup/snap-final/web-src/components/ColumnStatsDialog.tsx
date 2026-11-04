/**
 * Column Statistics dialog (Data > Column Statistics).
 *
 * Shows the descriptive profile computed by the service-layer profiler
 * (packages/service/src/profiling.ts): counts, unique/null counts,
 * data-type distribution, numeric aggregates (min/max/mean/median/stddev)
 * and most-common values. Read-only; pure presentational.
 */
import type { ColumnProfile } from '@icecream-sheets/service';
import A11yDialog from './A11yDialog';

export interface ColumnStatsDialogProps {
  title: string;
  profiles: ColumnProfile[];
  onClose: () => void;
}

function fmt(n: number | null, digits = 4): string {
  if (n === null || !Number.isFinite(n)) return '—';
  const r = Number(n.toFixed(digits));
  return String(r);
}

function StatRow({ label, value }: { label: string; value: string }) {
  return (
    <tr>
      <td style={{ padding: '3px 10px 3px 0', color: '#64748b', whiteSpace: 'nowrap' }}>{label}</td>
      <td style={{ padding: '3px 0', fontVariantNumeric: 'tabular-nums', fontWeight: 600 }}>{value}</td>
    </tr>
  );
}

function ColumnProfileView({ profile }: { profile: ColumnProfile }) {
  const t = profile.typeCounts;
  const hasNumeric = profile.min !== null;
  return (
    <div style={{ marginBottom: 16 }}>
      <h4 style={{ margin: '0 0 6px', fontSize: 13 }}>{profile.name}</h4>
      <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap' }}>
        <table style={{ fontSize: 12, borderCollapse: 'collapse' }}>
          <tbody>
            <StatRow label="Count" value={String(profile.count)} />
            <StatRow label="Unique" value={String(profile.uniqueCount)} />
            <StatRow label="Blanks" value={String(profile.blankCount)} />
          </tbody>
        </table>
        <table style={{ fontSize: 12, borderCollapse: 'collapse' }}>
          <tbody>
            <StatRow label="Numbers" value={String(t.number)} />
            <StatRow label="Text" value={String(t.text)} />
            <StatRow label="Booleans" value={String(t.boolean)} />
            <StatRow label="Dates" value={String(t.date)} />
            <StatRow label="Errors" value={String(t.error)} />
          </tbody>
        </table>
        {hasNumeric && (
          <table style={{ fontSize: 12, borderCollapse: 'collapse' }}>
            <tbody>
              <StatRow label="Min" value={fmt(profile.min)} />
              <StatRow label="Max" value={fmt(profile.max)} />
              <StatRow label="Mean" value={fmt(profile.mean)} />
              <StatRow label="Median" value={fmt(profile.median)} />
              <StatRow label="Std dev (sample)" value={fmt(profile.stddev)} />
            </tbody>
          </table>
        )}
      </div>
      {profile.mostCommon.length > 0 && (
        <div style={{ marginTop: 6, fontSize: 12 }}>
          <div style={{ color: '#64748b', marginBottom: 2 }}>Most common</div>
          {profile.mostCommon.map((c) => (
            <span
              key={c.value}
              title={`${c.count} occurrence${c.count === 1 ? '' : 's'}`}
              style={{
                display: 'inline-block',
                margin: '0 6px 4px 0',
                padding: '2px 8px',
                background: '#f1f5f9',
                borderRadius: 10,
                fontVariantNumeric: 'tabular-nums',
              }}
            >
              {c.value} <span style={{ color: '#64748b' }}>×{c.count}</span>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

export default function ColumnStatsDialog({ title, profiles, onClose }: ColumnStatsDialogProps) {
  return (
    <A11yDialog title={<>Column Statistics — {title}</>} width={560} onClose={onClose}>
      {profiles.length === 0 && <p style={{ fontSize: 12, color: '#64748b' }}>No values to profile.</p>}
      {profiles.map((p) => (
        <ColumnProfileView key={p.name} profile={p} />
      ))}
      <div className="dialog-actions">
        <button onClick={onClose}>Close</button>
      </div>
    </A11yDialog>
  );
}
