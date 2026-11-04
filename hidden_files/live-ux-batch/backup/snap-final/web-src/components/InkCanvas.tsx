/**
 * InkCanvas: freehand ink overlay for the Draw tab.
 *
 * Renders a transparent <canvas> absolutely positioned over the grid.
 * Pointer events draw pen/highlighter strokes, erase strokes, snap ruler
 * lines, or lasso-select strokes for moving. The parent owns the stroke
 * list (and persists it via features/ink metadata helpers); this component
 * is presentational + interaction handling.
 *
 * Ink conversion (Ink to Shape / Ink to Text / Ink to Math) is triggered by
 * the ribbon through the `convertRequest` prop; results come back through
 * the on*Recognized callbacks so the parent can create shape overlays or
 * insert text into the formula bar / selection.
 */
import React, { useEffect, useRef, useState } from 'react';
import {
  recognizeInkMath,
  recognizeInkShape,
  recognizeInkText,
  strokeHitTest,
  strokeBoundingBox,
  strokesInLasso,
  type InkPoint,
  type InkStroke,
  type InkStrokeTool,
} from '../features/ink';

export type InkTool = 'pen' | 'highlighter' | 'eraser' | 'ruler' | 'lasso' | 'none';

export interface ConvertRequest {
  kind: 'shape' | 'text' | 'math';
  nonce: number;
}

export interface RecognizedShapeOverlay {
  kind: 'rect' | 'oval' | 'line' | 'triangle';
  x: number;
  y: number;
  w: number;
  h: number;
  color: string;
}

export interface InkCanvasProps {
  strokes: InkStroke[];
  tool: InkTool;
  color: string;
  width: number;
  pixelWidth: number;
  pixelHeight: number;
  onStrokesChange: (strokes: InkStroke[]) => void;
  selectedIds?: number[];
  onSelectionChange?: (ids: number[]) => void;
  /** Ribbon-driven conversion request; the component consumes it once. */
  convertRequest: ConvertRequest | null;
  onShapeRecognized: (shape: RecognizedShapeOverlay) => void;
  onTextRecognized: (text: string) => void;
  onMathRecognized: (expression: string) => void;
  onConvertDone: () => void;
  onUnrecognized?: (kind: 'shape' | 'text' | 'math') => void;
}

let strokeIdCounter = 1;
function nextStrokeId(): number {
  return Date.now() * 1000 + (strokeIdCounter++ % 1000);
}

function drawStroke(ctx: CanvasRenderingContext2D, s: InkStroke): void {
  if (s.points.length === 0) return;
  ctx.save();
  ctx.strokeStyle = s.color;
  ctx.lineWidth = s.width;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  if (s.tool === 'highlighter') ctx.globalAlpha = 0.35;
  ctx.beginPath();
  ctx.moveTo(s.points[0].x, s.points[0].y);
  for (let i = 1; i < s.points.length; i++) ctx.lineTo(s.points[i].x, s.points[i].y);
  ctx.stroke();
  ctx.restore();
}

export default function InkCanvas(props: InkCanvasProps) {
  const {
    strokes,
    tool,
    color,
    width,
    pixelWidth,
    pixelHeight,
    onStrokesChange,
    selectedIds = [],
    onSelectionChange,
    convertRequest,
    onShapeRecognized,
    onTextRecognized,
    onMathRecognized,
    onConvertDone,
    onUnrecognized,
  } = props;
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [tick, setTick] = useState(0);
  const repaint = () => setTick((t) => t + 1);
  const drawing = useRef<{ id: number; points: InkPoint[] } | null>(null);
  const lassoPath = useRef<InkPoint[]>([]);
  const dragMove = useRef<{ startX: number; startY: number; orig: Map<number, InkPoint[]> } | null>(null);
  const propsRef = useRef(props);
  propsRef.current = props;

  // Repaint on every stroke/tool/selection change.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.max(1, Math.round(pixelWidth * dpr));
    canvas.height = Math.max(1, Math.round(pixelHeight * dpr));
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, pixelWidth, pixelHeight);

    const selected = new Set(selectedIds);
    for (const s of strokes) {
      drawStroke(ctx, s);
      if (selected.has(s.id)) {
        const b = strokeBoundingBox(s);
        ctx.save();
        ctx.strokeStyle = '#0b57d0';
        ctx.setLineDash([5, 4]);
        ctx.lineWidth = 1.5;
        ctx.strokeRect(b.x - 4, b.y - 4, b.w + 8, b.h + 8);
        ctx.restore();
      }
    }
    // Live in-progress stroke.
    if (drawing.current && drawing.current.points.length > 0) {
      const live: InkStroke = {
        id: -1,
        tool: tool === 'highlighter' ? 'highlighter' : 'pen',
        color,
        width,
        points: drawing.current.points,
        createdAt: 0,
      };
      drawStroke(ctx, live);
    }
    if (lassoPath.current.length > 1) {
      ctx.save();
      ctx.strokeStyle = '#0b57d0';
      ctx.setLineDash([6, 4]);
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(lassoPath.current[0].x, lassoPath.current[0].y);
      for (const p of lassoPath.current) ctx.lineTo(p.x, p.y);
      ctx.closePath();
      ctx.stroke();
      ctx.restore();
    }
  }, [strokes, tool, color, width, pixelWidth, pixelHeight, selectedIds, tick]);

  // Consume conversion requests from the ribbon.
  const handledNonce = useRef(0);
  useEffect(() => {
    if (!convertRequest || convertRequest.nonce === handledNonce.current) return;
    handledNonce.current = convertRequest.nonce;
    const p = propsRef.current;
    const selIds = p.selectedIds ?? [];
    const targets =
      selIds.length > 0 ? p.strokes.filter((s) => selIds.includes(s.id)) : p.strokes;
    if (convertRequest.kind === 'shape') {
      const src = targets[targets.length - 1] ?? p.strokes[p.strokes.length - 1];
      const rec = src ? recognizeInkShape(src) : null;
      if (rec) {
        const kind = rec.kind === 'circle' ? 'oval' : rec.kind === 'line' ? 'line' : rec.kind === 'triangle' ? 'triangle' : 'rect';
        p.onShapeRecognized({ kind, x: rec.x, y: rec.y, w: rec.w, h: rec.h, color: src.color });
      } else {
        p.onUnrecognized?.('shape');
      }
    } else if (convertRequest.kind === 'text') {
      const { text } = recognizeInkText(targets);
      if (text) p.onTextRecognized(text);
      else p.onUnrecognized?.('text');
    } else {
      const { expression } = recognizeInkMath(targets);
      if (expression) p.onMathRecognized(expression);
      else p.onUnrecognized?.('math');
    }
    p.onConvertDone();
  }, [convertRequest]);

  const pos = (e: React.PointerEvent): InkPoint => {
    const rect = canvasRef.current?.getBoundingClientRect();
    return { x: e.clientX - (rect?.left ?? 0), y: e.clientY - (rect?.top ?? 0) };
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (tool === 'none') return;
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    const p = pos(e);
    if (tool === 'pen' || tool === 'highlighter') {
      drawing.current = { id: nextStrokeId(), points: [p] };
    } else if (tool === 'ruler') {
      drawing.current = { id: nextStrokeId(), points: [p, p] };
    } else if (tool === 'eraser') {
      drawing.current = { id: -2, points: [p] }; // eraser path marker
      eraseAt(p);
    } else if (tool === 'lasso') {
      // If the press starts inside the current selection, drag-move it.
      const sel = strokes.filter((s) => selectedIds.includes(s.id));
      const inside = sel.some((s) => {
        const b = strokeBoundingBox(s);
        return p.x >= b.x - 4 && p.x <= b.x + b.w + 4 && p.y >= b.y - 4 && p.y <= b.y + b.h + 4;
      });
      if (inside && sel.length > 0) {
        const orig = new Map<number, InkPoint[]>();
        for (const s of sel) orig.set(s.id, s.points.map((q) => ({ ...q })));
        dragMove.current = { startX: p.x, startY: p.y, orig };
      } else {
        lassoPath.current = [p];
      }
    }
  };

  const eraseAt = (p: InkPoint) => {
    const remaining = strokes.filter((s) => !strokeHitTest(s, p.x, p.y));
    if (remaining.length !== strokes.length) {
      onStrokesChange(remaining);
      const removed = new Set(strokes.filter((s) => !remaining.includes(s)).map((s) => s.id));
      onSelectionChange?.(selectedIds.filter((id) => !removed.has(id)));
    }
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (tool === 'none') return;
    const p = pos(e);
    if (tool === 'eraser' && drawing.current) {
      eraseAt(p);
      return;
    }
    if (tool === 'lasso') {
      if (dragMove.current) {
        const dx = p.x - dragMove.current.startX;
        const dy = p.y - dragMove.current.startY;
        onStrokesChange(
          strokes.map((s) => {
            const orig = dragMove.current?.orig.get(s.id);
            if (!orig) return s;
            return { ...s, points: orig.map((q) => ({ x: q.x + dx, y: q.y + dy })) };
          }),
        );
        return;
      }
      if (lassoPath.current.length > 0) {
        lassoPath.current = [...lassoPath.current, p];
        repaint();
      }
      return;
    }
    if (drawing.current && drawing.current.id > 0) {
      if (tool === 'ruler') {
        const start = drawing.current.points[0];
        drawing.current.points = [start, p];
      } else {
        drawing.current.points = [...drawing.current.points, p];
      }
      // Repaint live: simplest is to bump via a state-free redraw.
      const canvas = canvasRef.current;
      if (canvas) {
        const dpr = window.devicePixelRatio || 1;
        const ctx = canvas.getContext('2d');
        if (ctx) {
          ctx.save();
          ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
          ctx.clearRect(0, 0, pixelWidth, pixelHeight);
          ctx.restore();
          // Full repaint happens on next render; draw the live stroke now.
          const c2 = canvas.getContext('2d');
          if (c2) {
            c2.save();
            c2.setTransform(dpr, 0, 0, dpr, 0, 0);
            for (const s of strokes) drawStroke(c2, s);
            drawStroke(c2, {
              id: -1,
              tool: tool === 'highlighter' ? 'highlighter' : 'pen',
              color,
              width,
              points: drawing.current.points,
              createdAt: 0,
            });
            c2.restore();
          }
        }
      }
    }
  };

  const onPointerUp = () => {
    if (tool === 'lasso' && lassoPath.current.length > 2 && !dragMove.current) {
      const ids = strokesInLasso(strokes, lassoPath.current);
      onSelectionChange?.(ids);
    }
    lassoPath.current = [];
    dragMove.current = null;
    if (drawing.current && drawing.current.id > 0) {
      const pts = drawing.current.points;
      const strokeTool: InkStrokeTool = tool === 'highlighter' ? 'highlighter' : tool === 'ruler' ? 'ruler' : 'pen';
      if (pts.length >= 2 && !(tool === 'ruler' && Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y) < 4)) {
        onStrokesChange([
          ...strokes,
          { id: drawing.current.id, tool: strokeTool, color, width, points: pts, createdAt: Date.now() },
        ]);
      }
    }
    drawing.current = null;
  };

  if (tool === 'none') return null;

  return (
    <canvas
      ref={canvasRef}
      style={{
        position: 'absolute',
        left: 0,
        top: 0,
        width: pixelWidth,
        height: pixelHeight,
        touchAction: 'none',
        cursor: tool === 'eraser' ? 'cell' : 'crosshair',
        zIndex: 30,
        // The grid's overlays layer is pointerEvents:none; the canvas must
        // opt back in or no pointer input ever reaches it.
        pointerEvents: 'auto',
      }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
    />
  );
}

/**
 * InkOverlay: mounts the InkCanvas over the grid's scrollable content.
 *
 * The wrapper fills the overlays layer (position:absolute, inset:0 inside
 * the grid content div, so it scrolls and clips with the cells) and
 * measures it with a ResizeObserver; the canvas is then sized to the full
 * content area so strokes live in grid content coordinates. Renders
 * nothing while no ink tool is active.
 */
export function InkOverlay(props: Omit<InkCanvasProps, 'pixelWidth' | 'pixelHeight'>) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const measure = () => {
      const w = el.clientWidth;
      const h = el.clientHeight;
      setSize((prev) => (prev && prev.w === w && prev.h === h ? prev : { w, h }));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  if (props.tool === 'none') return null;
  return (
    <div
      ref={wrapRef}
      style={{ position: 'absolute', inset: 0, pointerEvents: 'auto', zIndex: 30 }}
    >
      {size !== null && size.w > 0 && size.h > 0 ? (
        <InkCanvas {...props} pixelWidth={size.w} pixelHeight={size.h} />
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Drawing Canvas: a bounded drawing surface inserted as an overlay object.
// ---------------------------------------------------------------------------

export interface DrawingCanvasProps {
  x: number;
  y: number;
  w: number;
  h: number;
  strokes: InkStroke[];
  onStrokesChange: (strokes: InkStroke[]) => void;
  onMove: (dx: number, dy: number) => void;
  onClose: () => void;
}

/**
 * A bounded drawing canvas (Excel's Drawing Canvas): a draggable box that
 * contains its own ink surface with a small pen/eraser toolbar.
 */
export function DrawingCanvas({ x, y, w, h, strokes, onStrokesChange, onMove, onClose }: DrawingCanvasProps) {
  const [tool, setTool] = React.useState<InkTool>('pen');
  const [color, setColor] = React.useState('#1a1a1a');
  const drag = useRef<{ x: number; y: number } | null>(null);

  return (
    <div
      style={{
        position: 'absolute',
        left: x,
        top: y,
        width: Math.max(w, 120),
        height: Math.max(h, 90),
        zIndex: 25,
        border: '1px dashed #888',
        background: 'rgba(255,255,255,0.85)',
      }}
      onMouseDown={(e) => {
        // Drag the whole canvas by its header bar (top 22px).
        const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
        if (e.clientY - rect.top < 22) {
          drag.current = { x: e.clientX, y: e.clientY };
        }
      }}
      onMouseMove={(e) => {
        if (drag.current) {
          onMove(e.clientX - drag.current.x, e.clientY - drag.current.y);
          drag.current = { x: e.clientX, y: e.clientY };
        }
      }}
      onMouseUp={() => {
        drag.current = null;
      }}
      onMouseLeave={() => {
        drag.current = null;
      }}
    >
      <div
        style={{
          height: 22,
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          padding: '0 6px',
          background: '#f0f0f0',
          borderBottom: '1px solid #ccc',
          fontSize: 11,
          cursor: 'move',
          userSelect: 'none',
        }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <span style={{ fontWeight: 600 }}>Drawing Canvas</span>
        <button
          onClick={() => setTool('pen')}
          style={{ fontWeight: tool === 'pen' ? 700 : 400, cursor: 'pointer' }}
          title="Pen"
        >
          Pen
        </button>
        <button
          onClick={() => setTool('highlighter')}
          style={{ fontWeight: tool === 'highlighter' ? 700 : 400, cursor: 'pointer' }}
          title="Highlighter"
        >
          Highlighter
        </button>
        <button
          onClick={() => setTool('eraser')}
          style={{ fontWeight: tool === 'eraser' ? 700 : 400, cursor: 'pointer' }}
          title="Eraser"
        >
          Eraser
        </button>
        <input
          type="color"
          value={color}
          onChange={(e) => setColor(e.target.value)}
          title="Ink color"
          style={{ width: 26, height: 18, padding: 0, border: 'none' }}
        />
        <span style={{ flex: 1 }} />
        <button onClick={onClose} title="Remove drawing canvas" style={{ cursor: 'pointer' }}>
          ×
        </button>
      </div>
      <div style={{ position: 'relative', width: '100%', height: 'calc(100% - 22px)', overflow: 'hidden' }}>
        <InkCanvas
          strokes={strokes}
          tool={tool}
          color={color}
          width={2.5}
          pixelWidth={Math.max(w, 120)}
          pixelHeight={Math.max(h, 90) - 22}
          onStrokesChange={onStrokesChange}
          convertRequest={null}
          onShapeRecognized={() => {}}
          onTextRecognized={() => {}}
          onMathRecognized={() => {}}
          onConvertDone={() => {}}
        />
      </div>
    </div>
  );
}
