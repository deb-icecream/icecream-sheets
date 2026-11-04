/**
 * Check Accessibility pane (Review > Accessibility).
 *
 * Runs features/accessibility.ts over the model the parent assembles
 * (pictures + alt text, merged ranges, text/background colors, header
 * row state) and lists issues grouped by severity. Each issue with a
 * fix descriptor offers a button that delegates to onFix — the parent
 * owns the actual repair (e.g. opening the picture's alt-text editor,
 * unmerging, resetting font color, focusing row 1).
 */
import { useMemo } from 'react';
import {
  checkAccessibility,
  type A11yIssue,
  type A11yModel,
} from '../features/accessibility';

interface AccessibilityCheckerProps {
  model: A11yModel;
  onClose: () => void;
  onFix: (issue: A11yIssue) => void;
}

export default function AccessibilityChecker({ model, onClose, onFix }: AccessibilityCheckerProps) {
  const issues = useMemo(() => checkAccessibility(model), [model]);
  const errors = issues.filter((i) => i.severity === 'error');
  const warnings = issues.filter((i) => i.severity === 'warning');

  const renderIssue = (issue: A11yIssue): React.ReactNode => (
    <li key={issue.id} style={{ padding: '6px 0', borderBottom: '1px solid var(--line-soft)', fontSize: 13 }}>
      <div style={{ display: 'flex', gap: 6, alignItems: 'baseline' }}>
        <span aria-hidden>{issue.severity === 'error' ? '🔴' : '🟡'}</span>
        <span style={{ flex: 1 }}>{issue.message}</span>
      </div>
      {issue.fix && (
        <button style={{ marginTop: 4, fontSize: 12 }} onClick={() => onFix(issue)}>
          {issue.fix.label}
        </button>
      )}
    </li>
  );

  return (
    <div
      role="complementary"
      aria-label="Accessibility checker"
      style={{
        position: 'fixed', right: 0, top: 0, bottom: 0, width: 340,
        background: '#fff', borderLeft: '1px solid var(--line-soft)',
        boxShadow: '-4px 0 12px rgba(0,0,0,0.08)', zIndex: 60,
        display: 'flex', flexDirection: 'column',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', padding: '10px 12px', borderBottom: '1px solid var(--line-soft)' }}>
        <strong style={{ flex: 1 }}>Accessibility Checker</strong>
        <button onClick={onClose} aria-label="Close checker">×</button>
      </div>
      <div style={{ padding: '8px 12px', fontSize: 13, borderBottom: '1px solid var(--line-soft)', color: '#555' }}>
        {issues.length === 0
          ? '✅ No accessibility issues found. Good job!'
          : `${errors.length} error${errors.length === 1 ? '' : 's'}, ${warnings.length} warning${warnings.length === 1 ? '' : 's'}`}
      </div>
      <div style={{ flex: 1, overflow: 'auto', padding: '4px 12px' }}>
        {errors.length > 0 && (
          <>
            <h4 style={{ margin: '8px 0 4px' }}>Errors</h4>
            <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>{errors.map(renderIssue)}</ul>
          </>
        )}
        {warnings.length > 0 && (
          <>
            <h4 style={{ margin: '8px 0 4px' }}>Warnings</h4>
            <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>{warnings.map(renderIssue)}</ul>
          </>
        )}
      </div>
    </div>
  );
}
