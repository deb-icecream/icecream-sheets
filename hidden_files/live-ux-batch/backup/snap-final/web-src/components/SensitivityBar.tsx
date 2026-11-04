/**
 * Sensitivity bar: workbook-header indicator showing the current
 * sensitivity label with color coding, plus a dropdown to change it
 * (changes are audit-logged by the SensitivityStore).
 *
 * Colors: public = green, internal = amber, confidential = red.
 */
import type { SensitivityLabel } from '@icecream-sheets/service';

interface SensitivityBarProps {
  label: SensitivityLabel;
  onChange: (label: SensitivityLabel) => void;
}

const LABEL_STYLE: Record<SensitivityLabel, { bg: string; fg: string; border: string; icon: string }> = {
  public: { bg: '#dcfce7', fg: '#166534', border: '#86efac', icon: '🟢' },
  internal: { bg: '#fef3c7', fg: '#92400e', border: '#fcd34d', icon: '🟡' },
  confidential: { bg: '#fee2e2', fg: '#991b1b', border: '#fca5a5', icon: '🔴' },
};

const LABELS: SensitivityLabel[] = ['public', 'internal', 'confidential'];

export function SensitivityBar({ label, onChange }: SensitivityBarProps) {
  const s = LABEL_STYLE[label];
  return (
    <span
      className="sensitivity-bar"
      role="group"
      aria-label={`Workbook sensitivity: ${label}`}
      title={`Sensitivity: ${label}${label === 'confidential' ? ' — downloads and sharing are restricted to owners' : ''}`}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        background: s.bg,
        color: s.fg,
        border: `1px solid ${s.border}`,
        borderRadius: 12,
        padding: '2px 8px',
        fontSize: 12,
        fontWeight: 600,
      }}
    >
      <span aria-hidden="true">{s.icon}</span>
      <select
        value={label}
        onChange={(e) => onChange(e.target.value as SensitivityLabel)}
        aria-label="Change sensitivity label"
        title="Change the workbook's sensitivity label"
        style={{
          background: 'transparent',
          border: 'none',
          color: 'inherit',
          font: 'inherit',
          cursor: 'pointer',
          textTransform: 'capitalize',
        }}
      >
        {LABELS.map((l) => (
          <option key={l} value={l}>
            {l}
          </option>
        ))}
      </select>
    </span>
  );
}
