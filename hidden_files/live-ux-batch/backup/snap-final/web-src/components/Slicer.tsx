/**
 * Slicer panel (track 14): floating categorical filter control, the
 * companion to timelines. Pure presentational component — state helpers
 * (toggleSlicerValue / clearSlicer / slicerPasses) live in
 * features/slicers.ts.
 */
import { useState } from 'react';
import type { SlicerSpec } from '../features/slicers';

export interface SlicerPivotInfo {
  id: number;
  title: string;
}

interface SlicerPanelProps {
  spec: SlicerSpec;
  /** All distinct values for the bound column. */
  values: string[];
  /** Pivot tables available for binding. */
  pivots: SlicerPivotInfo[];
  onToggle: (value: string) => void;
  onClear: () => void;
  onRemove: () => void;
  onTogglePivotBinding: (pivotId: number, bind: boolean) => void;
}

export function SlicerPanel({ spec, values, pivots, onToggle, onClear, onRemove, onTogglePivotBinding }: SlicerPanelProps) {
  const allSelected = spec.selected.length === 0;
  const [showBinding, setShowBinding] = useState(false);
  return (
    <div
      className="slicer-panel"
      style={{
        position: 'absolute',
        left: spec.x,
        top: spec.y,
        width: spec.w,
        background: '#fff',
        border: '1px solid #cbd5e1',
        borderRadius: 6,
        boxShadow: '0 2px 8px rgba(0,0,0,0.12)',
        padding: 10,
        fontSize: 12,
        zIndex: 40,
        maxHeight: 260,
        display: 'flex',
        flexDirection: 'column',
        pointerEvents: 'auto',
      }}
      role="group"
      aria-label={`Slicer on ${spec.field}`}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
        <strong>🔽 {spec.field}</strong>
        <span>
          <button
            onClick={() => setShowBinding((v) => !v)}
            title="Bind this slicer to pivot tables"
            aria-expanded={showBinding}
            style={{ border: 'none', background: 'none', cursor: 'pointer', color: '#1d4ed8', fontSize: 11, marginRight: 6 }}
          >
            {spec.pivotIds.length > 0 ? `🔗${spec.pivotIds.length}` : '🔗'}
          </button>
          {!allSelected && (
            <button
              onClick={onClear}
              title="Clear filter (select all)"
              style={{ border: 'none', background: 'none', cursor: 'pointer', color: '#1d4ed8', fontSize: 11, marginRight: 6 }}
            >
              Clear
            </button>
          )}
          <button onClick={onRemove} aria-label={`Remove slicer on ${spec.field}`} style={{ border: 'none', background: 'none', cursor: 'pointer' }}>×</button>
        </span>
      </div>
      {showBinding && (
        <div style={{ marginBottom: 6, padding: 6, background: '#f8fafc', borderRadius: 4, fontSize: 11 }}>
          <div style={{ fontWeight: 600, marginBottom: 4 }}>Connected PivotTables</div>
          {pivots.length === 0 && <div style={{ color: '#94a3b8' }}>No pivot tables yet — insert one first.</div>}
          {pivots.map((p) => {
            const bound = spec.pivotIds.includes(p.id);
            return (
              <label key={p.id} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '2px 0', cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={bound}
                  onChange={(e) => onTogglePivotBinding(p.id, e.target.checked)}
                />
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.title}</span>
              </label>
            );
          })}
          <div style={{ color: '#64748b', marginTop: 4 }}>
            Bound pivots filter to the slicer selection automatically.
          </div>
        </div>
      )}
      <div style={{ overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 3 }}>
        {values.map((v) => {
          const on = allSelected || spec.selected.includes(v);
          return (
            <button
              key={v}
              onClick={() => onToggle(v)}
              aria-pressed={on}
              title={v}
              style={{
                textAlign: 'left',
                padding: '4px 8px',
                fontSize: 12,
                borderRadius: 4,
                border: '1px solid #cbd5e1',
                background: on ? '#dbeafe' : '#fff',
                cursor: 'pointer',
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
              }}
            >
              {on ? '☑' : '☐'} {v}
            </button>
          );
        })}
        {values.length === 0 && <span style={{ color: '#94a3b8' }}>No values</span>}
      </div>
    </div>
  );
}
