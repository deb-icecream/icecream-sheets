/**
 * ArrangeTools: Page Layout > Arrange — Bring Forward / Send Backward,
 * Selection Pane, Align, Rotate for floating overlays.
 *
 * Works over the generic ArrangeItem adapter (features/arrange.ts): the
 * parent maps its pictures/shapes/charts into ArrangeItem[], renders this
 * panel, and maps results back. Multi-select for Align is a checkbox list
 * in the Selection Pane (Excel aligns the current selection).
 */
import { useState } from 'react';
import {
  alignBottom,
  alignCenterH,
  alignLeft,
  alignMiddleV,
  alignRight,
  alignTop,
  bringForward,
  bringToFront,
  distributeHorizontally,
  distributeVertically,
  flipHorizontal,
  flipVertical,
  renameItem,
  rotate270,
  rotate90,
  sendBackward,
  sendToBack,
  toggleHidden,
  type ArrangeItem,
} from '../features/arrange';
import A11yDialog from './A11yDialog';

export interface ArrangePanelProps {
  items: ArrangeItem[];
  /** Currently selected overlay ids (multi-select for Align). */
  selectedIds: (number | string)[];
  onItemsChange: (items: ArrangeItem[]) => void;
  onSelectionChange: (ids: (number | string)[]) => void;
  onClose: () => void;
}

export default function ArrangePanel({ items, selectedIds, onItemsChange, onSelectionChange, onClose }: ArrangePanelProps) {
  const [editingId, setEditingId] = useState<number | string | null>(null);
  const [editName, setEditName] = useState('');
  // Paint order: top of the list = front.
  const ordered = [...items].sort((a, b) => b.z - a.z);
  const single = selectedIds.length === 1 ? selectedIds[0] : null;

  const toggleSelect = (id: number | string) => {
    onSelectionChange(
      selectedIds.includes(id) ? selectedIds.filter((s) => s !== id) : [...selectedIds, id],
    );
  };

  const commitRename = () => {
    if (editingId !== null && editName.trim()) onItemsChange(renameItem(items, editingId, editName.trim()));
    setEditingId(null);
  };

  const btn = (label: string, title: string, onClick: () => void, disabled = false) => (
    <button
      key={label}
      onClick={onClick}
      disabled={disabled}
      title={title}
      style={{ padding: '4px 8px', cursor: disabled ? 'default' : 'pointer', fontSize: 12 }}
    >
      {label}
    </button>
  );

  return (
    <A11yDialog title={<>Arrange</>} width={520} onClose={onClose}>
        <div style={{ padding: 14, overflowY: 'auto', fontSize: 13, display: 'flex', flexDirection: 'column', gap: 14 }}>
          <section>
            <h4 style={{ margin: '0 0 6px' }}>Order</h4>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {btn('Bring Forward', 'Move the selected object one step toward the front', () => single != null && onItemsChange(bringForward(items, single)), single == null)}
              {btn('Bring to Front', 'Move the selected object to the very front', () => single != null && onItemsChange(bringToFront(items, single)), single == null)}
              {btn('Send Backward', 'Move the selected object one step toward the back', () => single != null && onItemsChange(sendBackward(items, single)), single == null)}
              {btn('Send to Back', 'Move the selected object to the very back', () => single != null && onItemsChange(sendToBack(items, single)), single == null)}
            </div>
          </section>
          <section>
            <h4 style={{ margin: '0 0 6px' }}>Align {selectedIds.length > 1 ? `(${selectedIds.length} selected)` : ''}</h4>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {btn('Left', 'Align left edges', () => onItemsChange(alignLeft(items, selectedIds)), selectedIds.length < 2)}
              {btn('Center', 'Align horizontal centers', () => onItemsChange(alignCenterH(items, selectedIds)), selectedIds.length < 2)}
              {btn('Right', 'Align right edges', () => onItemsChange(alignRight(items, selectedIds)), selectedIds.length < 2)}
              {btn('Top', 'Align top edges', () => onItemsChange(alignTop(items, selectedIds)), selectedIds.length < 2)}
              {btn('Middle', 'Align vertical centers', () => onItemsChange(alignMiddleV(items, selectedIds)), selectedIds.length < 2)}
              {btn('Bottom', 'Align bottom edges', () => onItemsChange(alignBottom(items, selectedIds)), selectedIds.length < 2)}
              {btn('Distribute ⟷', 'Space evenly horizontally (3+ objects)', () => onItemsChange(distributeHorizontally(items, selectedIds)), selectedIds.length < 3)}
              {btn('Distribute ↕', 'Space evenly vertically (3+ objects)', () => onItemsChange(distributeVertically(items, selectedIds)), selectedIds.length < 3)}
            </div>
          </section>
          <section>
            <h4 style={{ margin: '0 0 6px' }}>Rotate</h4>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {btn('⟳ 90°', 'Rotate 90° clockwise', () => single != null && onItemsChange(rotate90(items, single)), single == null)}
              {btn('⟲ 90°', 'Rotate 90° counter-clockwise', () => single != null && onItemsChange(rotate270(items, single)), single == null)}
              {btn('Flip ⟷', 'Flip horizontally', () => single != null && onItemsChange(flipHorizontal(items, single)), single == null)}
              {btn('Flip ↕', 'Flip vertically', () => single != null && onItemsChange(flipVertical(items, single)), single == null)}
            </div>
            {single != null && (
              <p style={{ color: '#666', margin: '6px 0 0' }}>
                Rotation is stored on the object (degrees clockwise); the overlay renderer applies it.
              </p>
            )}
          </section>
          <section>
            <h4 style={{ margin: '0 0 6px' }}>Selection Pane</h4>
            {ordered.length === 0 && <p style={{ color: '#666' }}>No objects on this sheet.</p>}
            <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 4 }}>
              {ordered.map((it) => (
                <li
                  key={String(it.id)}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    padding: '4px 8px',
                    border: selectedIds.includes(it.id) ? '1px solid #0b57d0' : '1px solid #ddd',
                    borderRadius: 4,
                    background: it.hidden ? '#f5f5f5' : '#fff',
                    opacity: it.hidden ? 0.6 : 1,
                  }}
                >
                  <input
                    type="checkbox"
                    checked={selectedIds.includes(it.id)}
                    onChange={() => toggleSelect(it.id)}
                    title="Select for Align (multi-select)"
                  />
                  {editingId === it.id ? (
                    <input
                      value={editName}
                      autoFocus
                      onChange={(e) => setEditName(e.target.value)}
                      onBlur={commitRename}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') commitRename();
                        if (e.key === 'Escape') setEditingId(null);
                      }}
                      style={{ flex: 1, fontSize: 12 }}
                    />
                  ) : (
                    <span
                      style={{ flex: 1, cursor: 'text' }}
                      title="Double-click to rename"
                      onDoubleClick={() => {
                        setEditingId(it.id);
                        setEditName(it.name);
                      }}
                    >
                      {it.name}
                    </span>
                  )}
                  <button
                    onClick={() => onItemsChange(toggleHidden(items, it.id))}
                    title={it.hidden ? 'Show' : 'Hide'}
                    style={{ cursor: 'pointer', fontSize: 12, padding: '2px 6px' }}
                  >
                    {it.hidden ? '👁‍🗨' : '👁'}
                  </button>
                  <button
                    onClick={() => onItemsChange(bringForward(items, it.id))}
                    title="Bring forward"
                    style={{ cursor: 'pointer', fontSize: 12, padding: '2px 6px' }}
                  >
                    ▲
                  </button>
                  <button
                    onClick={() => onItemsChange(sendBackward(items, it.id))}
                    title="Send backward"
                    style={{ cursor: 'pointer', fontSize: 12, padding: '2px 6px' }}
                  >
                    ▼
                  </button>
                </li>
              ))}
            </ul>
          </section>
        </div>
        <div style={{ padding: '10px 14px', borderTop: '1px solid #ddd', display: 'flex', justifyContent: 'flex-end' }}>
          <button onClick={onClose}>Done</button>
        </div>
      </A11yDialog>
  );
}
