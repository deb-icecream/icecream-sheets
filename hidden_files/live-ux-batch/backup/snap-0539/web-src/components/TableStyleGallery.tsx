/**
 * Format as Table style gallery (Home > Styles > Format as Table).
 *
 * Excel-style dropdown gallery: 24 styles in Light / Medium / Dark groups,
 * each with a live mini preview (header + banded rows). Picking a style
 * hands the TableStyle to the parent, which applies it with
 * tableStyleFormats() through the format store.
 */
import {
  TABLE_STYLES,
  tableStylesByCategory,
  type TableStyle,
  type TableStyleCategory,
} from '../features/tableStyles';
import A11yDialog from './A11yDialog';

export interface TableStyleGalleryProps {
  onClose: () => void;
  onPick: (style: TableStyle) => void;
}

const CATEGORIES: TableStyleCategory[] = ['Light', 'Medium', 'Dark'];

function StylePreview({ style }: { style: TableStyle }) {
  const rows = [0, 1, 2, 3];
  return (
    <div style={{ border: '1px solid #bbb', fontSize: 8, lineHeight: 1.5 }}>
      <div
        style={{
          background: style.headerBg,
          color: style.headerColor,
          fontWeight: 700,
          padding: '2px 6px',
          display: 'flex',
          gap: 8,
        }}
      >
        <span>Col1</span>
        <span>Col2</span>
        <span>Col3</span>
      </div>
      {rows.map((r) => (
        <div
          key={r}
          style={{
            background: r % 2 === 0 ? style.bandBg1 : style.bandBg2,
            color: style.bodyColor,
            padding: '2px 6px',
            display: 'flex',
            gap: 8,
            borderTop: `1px solid ${style.borderColor}`,
          }}
        >
          <span>a</span>
          <span>b</span>
          <span>c</span>
        </div>
      ))}
    </div>
  );
}

export function TableStyleGallery({ onClose, onPick }: TableStyleGalleryProps) {
  return (
    <A11yDialog title={<>Format as Table</>} width={640} onClose={onClose}>
        <div className="dialog-hint">
          Pick a style — the used range gets a header row and banded rows.
        </div>
        {CATEGORIES.map((cat) => (
          <div key={cat} style={{ marginBottom: 12 }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: '#555', margin: '8px 0 4px' }}>
              {cat}
            </div>
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(3, 1fr)',
                gap: 10,
              }}
            >
              {tableStylesByCategory(cat).map((s) => (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => {
                    onPick(s);
                    onClose();
                  }}
                  title={s.name}
                  style={{
                    border: '1px solid #ddd',
                    background: '#fff',
                    padding: 6,
                    cursor: 'pointer',
                    textAlign: 'left',
                  }}
                >
                  <StylePreview style={s} />
                  <div style={{ fontSize: 11, marginTop: 4, color: '#333' }}>{s.name}</div>
                </button>
              ))}
            </div>
          </div>
        ))}
        <div className="dialog-actions">
          <button onClick={onClose}>Cancel</button>
        </div>
      </A11yDialog>
  );
}

export { TABLE_STYLES };
