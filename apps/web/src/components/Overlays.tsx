/**
 * Floating overlays for the Insert tab: shapes, text boxes.
 * x/y are pixels relative to the grid container. Pure presentational;
 * the parent owns the overlay list and persists positions.
 *
 * Shapes render from the service-layer gallery
 * (@icecream-sheets/service shapes.ts): 100+ autoshapes across Excel's 7
 * categories, each an inner-SVG definition on a 0–100 viewBox.
 */
import { useRef, useState } from 'react';
import { SHAPE_DEFS, shapeDefById } from '@icecream-sheets/service';

/** Shape kind is a gallery shape id (see SHAPE_DEFS in the service). */
export type ShapeKind = string;

export interface Shape {
  id: number;
  kind: ShapeKind;
  x: number;
  y: number;
  w: number;
  h: number;
  /** Border/stroke color. */
  color: string;
  /** Fill color; 'none' for outline-only. */
  fillColor: string;
}

/** Flat gallery list (id + label); the ribbon shows the categorized gallery. */
export const SHAPE_KINDS: { id: ShapeKind; label: string }[] = SHAPE_DEFS.map((d) => ({
  id: d.id,
  label: d.name,
}));

interface ShapeOverlayProps {
  shape: Shape;
  onClose: () => void;
  onMove: (dx: number, dy: number) => void;
  onColors: (fillColor: string, borderColor: string) => void;
}

/** Absolutely positioned SVG shape; drag to move, click to select colors. */
export function ShapeOverlay({ shape, onClose, onMove, onColors }: ShapeOverlayProps) {
  const last = useRef<{ x: number; y: number } | null>(null);
  const [selected, setSelected] = useState(false);
  const w = Math.max(shape.w, 4);
  const h = Math.max(shape.h, 4);
  const def = shapeDefById(shape.kind) ?? shapeDefById('rect');
  const fill = shape.fillColor === 'none' ? 'none' : shape.fillColor;

  return (
    <div
      style={{
        position: 'absolute',
        left: shape.x,
        top: shape.y,
        width: w,
        height: h,
        cursor: 'move',
        zIndex: 20,
      }}
      onMouseDown={(e) => {
        last.current = { x: e.clientX, y: e.clientY };
      }}
      onMouseMove={(e) => {
        if (last.current) {
          onMove(e.clientX - last.current.x, e.clientY - last.current.y);
          last.current = { x: e.clientX, y: e.clientY };
        }
      }}
      onMouseUp={() => {
        last.current = null;
      }}
      onMouseLeave={() => {
        last.current = null;
      }}
      onClick={() => setSelected((s) => !s)}
    >
      <svg width={w} height={h} viewBox="0 0 100 100" preserveAspectRatio="none" style={{ display: 'block', overflow: 'visible' }}>
        <g
          fill={def?.lineOnly ? 'none' : fill}
          stroke={shape.color}
          strokeWidth={3}
          strokeLinejoin="round"
          vectorEffect="non-scaling-stroke"
          dangerouslySetInnerHTML={{ __html: def?.svg ?? '' }}
        />
      </svg>
      {selected && (
        <div
          onClick={(e) => e.stopPropagation()}
          onMouseDown={(e) => e.stopPropagation()}
          style={{
            position: 'absolute',
            top: -34,
            left: 0,
            display: 'flex',
            gap: 6,
            alignItems: 'center',
            background: '#fff',
            border: '1px solid #ccc',
            borderRadius: 4,
            padding: '2px 6px',
            fontSize: 11,
            whiteSpace: 'nowrap',
            zIndex: 21,
          }}
        >
          <label title="Fill color">
            Fill{' '}
            <input
              type="color"
              value={shape.fillColor === 'none' ? '#ffffff' : shape.fillColor}
              onChange={(e) => onColors(e.target.value, shape.color)}
              style={{ width: 24, height: 18, padding: 0, border: 'none', verticalAlign: 'middle' }}
            />
          </label>
          <label title="Border color">
            Border{' '}
            <input
              type="color"
              value={shape.color}
              onChange={(e) => onColors(shape.fillColor, e.target.value)}
              style={{ width: 24, height: 18, padding: 0, border: 'none', verticalAlign: 'middle' }}
            />
          </label>
          <button
            onClick={() => onColors('none', shape.color)}
            title="No fill"
            style={{ fontSize: 11, padding: '0 4px', cursor: 'pointer' }}
          >
            No fill
          </button>
        </div>
      )}
      <button
        aria-label="Remove shape"
        onClick={(e) => {
          e.stopPropagation();
          onClose();
        }}
        style={{
          position: 'absolute',
          top: -10,
          right: -10,
          width: 20,
          height: 20,
          borderRadius: '50%',
          border: '1px solid #999',
          background: '#fff',
          cursor: 'pointer',
          fontSize: 12,
          lineHeight: 1,
          padding: 0,
        }}
      >
        ×
      </button>
    </div>
  );
}

export interface TextBox {
  id: number;
  x: number;
  y: number;
  w: number;
  h: number;
  text: string;
  /** Owning sheet for boxes restored from a file; undefined = every sheet (legacy session boxes). */
  sheet?: string;
}

/** Metadata key used to persist text boxes with the workbook. */
export const TEXTBOXES_METADATA_KEY = 'icecream.textboxes';

export function textBoxesToMetadata(boxes: TextBox[]): unknown[] {
  return boxes.map((b) => ({
    id: b.id,
    x: b.x,
    y: b.y,
    w: b.w,
    h: b.h,
    text: b.text,
    ...(b.sheet !== undefined ? { sheet: b.sheet } : {}),
  }));
}

/** Restore text boxes from adapter metadata; drops corrupt entries. */
export function textBoxesFromMetadata(meta: unknown): TextBox[] {
  if (!Array.isArray(meta)) return [];
  const out: TextBox[] = [];
  for (const item of meta) {
    if (typeof item !== 'object' || item === null) continue;
    const r = item as Record<string, unknown>;
    if (
      typeof r.id !== 'number' ||
      typeof r.x !== 'number' ||
      typeof r.y !== 'number' ||
      typeof r.w !== 'number' ||
      typeof r.h !== 'number' ||
      typeof r.text !== 'string'
    ) {
      continue;
    }
    out.push({
      id: r.id,
      x: r.x,
      y: r.y,
      w: Math.max(8, r.w),
      h: Math.max(8, r.h),
      text: r.text,
      ...(typeof r.sheet === 'string' && r.sheet ? { sheet: r.sheet } : {}),
    });
  }
  return out;
}

interface TextBoxOverlayProps {
  box: TextBox;
  onChange: (text: string) => void;
  onClose: () => void;
}

/** Absolutely positioned editable text box. */
export function TextBoxOverlay({ box, onChange, onClose }: TextBoxOverlayProps) {
  return (
    <div
      style={{
        position: 'absolute',
        left: box.x,
        top: box.y,
        width: Math.max(box.w, 40),
        height: Math.max(box.h, 24),
        zIndex: 20,
        border: '1px dashed #888',
        background: 'rgba(255,255,255,0.9)',
      }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') onClose();
      }}
    >
      <textarea
        value={box.text}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Type text…"
        style={{
          width: '100%',
          height: '100%',
          border: 'none',
          outline: 'none',
          resize: 'none',
          background: 'transparent',
          font: 'inherit',
          padding: 4,
          boxSizing: 'border-box',
        }}
      />
      <button
        aria-label="Remove text box"
        onClick={onClose}
        style={{
          position: 'absolute',
          top: -10,
          right: -10,
          width: 20,
          height: 20,
          borderRadius: '50%',
          border: '1px solid #999',
          background: '#fff',
          cursor: 'pointer',
          fontSize: 12,
          lineHeight: 1,
          padding: 0,
        }}
      >
        ×
      </button>
    </div>
  );
}
