/**
 * Workbook Views switcher (View > Workbook Views).
 *
 * Segmented control for Normal / Page Break Preview / Page Layout.
 * View state itself lives in the parent (features/workbookViews.ts);
 * Grid integration: the parent passes `view` (+ computed pageBreaks /
 * pageSetup) into Grid, which renders break lines + page numbers
 * (preview) or paginated pages with margins/header/footer (layout).
 */
import { WORKBOOK_VIEWS, type WorkbookView } from '../features/workbookViews';

interface ViewSwitcherProps {
  view: WorkbookView;
  onChange: (view: WorkbookView) => void;
}

export default function ViewSwitcher({ view, onChange }: ViewSwitcherProps) {
  return (
    <div role="group" aria-label="Workbook views" style={{ display: 'inline-flex', border: '1px solid var(--line-soft)', borderRadius: 6, overflow: 'hidden' }}>
      {WORKBOOK_VIEWS.map((v) => (
        <button
          key={v.id}
          onClick={() => onChange(v.id)}
          aria-pressed={view === v.id}
          title={v.label}
          style={{
            border: 'none',
            borderRadius: 0,
            padding: '4px 10px',
            fontSize: 12,
            background: view === v.id ? '#e8f0fe' : 'transparent',
            fontWeight: view === v.id ? 'bold' : 'normal',
            cursor: 'pointer',
          }}
        >
          {v.id === 'normal' ? '▦' : v.id === 'pageBreakPreview' ? '◫' : '▤'} {v.label}
        </button>
      ))}
    </div>
  );
}
