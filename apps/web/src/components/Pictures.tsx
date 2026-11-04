/**
 * Floating picture overlays for the Insert tab.
 *
 * Pictures are inserted from the device via a file picker, rendered as
 * absolutely-positioned <img> elements over the grid, and are draggable
 * and resizable. They persist with the workbook through adapter metadata
 * (key `icecream.pictures`, carried in XLSX custom properties by the
 * xlsx-adapter), per design-docs/print-and-page-layout.md §2: page setup
 * and drawing metadata persist as adapter metadata, never in cell data.
 */
import { useRef, useState } from 'react';

export interface Picture {
  id: number;
  x: number;
  y: number;
  w: number;
  h: number;
  /** Data URL (downscaled on insert to bound file size). */
  dataUrl: string;
  /** Original file name, for accessibility / export. */
  name: string;
  /**
   * Owning sheet name for sheet-scoped overlays (imported SmartArt).
   * Undefined = visible on every sheet (user-inserted pictures).
   */
  sheet?: string;
}

/** Metadata key used to persist pictures with the workbook. */
export const PICTURES_METADATA_KEY = 'icecream.pictures';

/** Max dimension (px) for inserted pictures; larger images are downscaled. */
export const MAX_PICTURE_DIM = 1024;

export function picturesToMetadata(pictures: Picture[]): unknown[] {
  return pictures.map((p) => ({
    id: p.id,
    x: p.x,
    y: p.y,
    w: p.w,
    h: p.h,
    dataUrl: p.dataUrl,
    name: p.name,
    ...(p.sheet !== undefined ? { sheet: p.sheet } : {}),
  }));
}

/** Restore pictures from adapter metadata; drops corrupt entries. */
export function picturesFromMetadata(meta: unknown): Picture[] {
  if (!Array.isArray(meta)) return [];
  const out: Picture[] = [];
  for (const item of meta) {
    if (typeof item !== 'object' || item === null) continue;
    const r = item as Record<string, unknown>;
    if (
      typeof r.id !== 'number' ||
      typeof r.x !== 'number' ||
      typeof r.y !== 'number' ||
      typeof r.w !== 'number' ||
      typeof r.h !== 'number' ||
      typeof r.dataUrl !== 'string' ||
      !r.dataUrl.startsWith('data:image/')
    ) {
      continue;
    }
    out.push({
      id: r.id,
      x: r.x,
      y: r.y,
      w: Math.max(8, r.w),
      h: Math.max(8, r.h),
      dataUrl: r.dataUrl,
      name: typeof r.name === 'string' ? r.name : 'picture',
      ...(typeof r.sheet === 'string' && r.sheet ? { sheet: r.sheet } : {}),
    });
  }
  return out;
}

/**
 * Read an image File, downscaling to MAX_PICTURE_DIM so workbooks stay
 * small. Resolves with a data URL. Rejects on unreadable files.
 */
export function fileToPictureDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!file.type.startsWith('image/')) {
      reject(new Error(`Not an image: ${file.type || 'unknown type'}`));
      return;
    }
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      try {
        const scale = Math.min(1, MAX_PICTURE_DIM / Math.max(img.width, img.height));
        const w = Math.max(1, Math.round(img.width * scale));
        const h = Math.max(1, Math.round(img.height * scale));
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        if (!ctx) throw new Error('Canvas 2D unavailable');
        ctx.drawImage(img, 0, 0, w, h);
        URL.revokeObjectURL(url);
        // Keep PNG for PNG sources (transparency), JPEG otherwise.
        const mime = file.type === 'image/png' ? 'image/png' : 'image/jpeg';
        resolve(canvas.toDataURL(mime, 0.85));
      } catch (e) {
        URL.revokeObjectURL(url);
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error(`Could not decode image: ${file.name}`));
    };
    img.src = url;
  });
}

interface PictureOverlayProps {
  picture: Picture;
  onClose: () => void;
  onMove: (x: number, y: number) => void;
  onResize: (w: number, h: number) => void;
}

/** Absolutely positioned image; drag to move, drag the corner handle to resize. */
export function PictureOverlay({ picture, onClose, onMove, onResize }: PictureOverlayProps) {
  const drag = useRef<{ x: number; y: number } | null>(null);
  const resizing = useRef<{ w: number; h: number; x: number; y: number } | null>(null);
  const [selected, setSelected] = useState(false);
  const w = Math.max(picture.w, 8);
  const h = Math.max(picture.h, 8);

  return (
    <div
      style={{
        position: 'absolute',
        left: picture.x,
        top: picture.y,
        width: w,
        height: h,
        cursor: 'move',
        // Pictures sit above charts (30) so a newly inserted SmartArt
        // picture stays visible when it overlaps a chart (#127).
        zIndex: 40,
        outline: selected ? '2px solid #2b579a' : 'none',
        outlineOffset: 2,
        pointerEvents: 'auto',
      }}
      onMouseDown={(e) => {
        if ((e.target as HTMLElement).dataset.handle === 'resize') return;
        drag.current = { x: e.clientX, y: e.clientY };
        setSelected(true);
      }}
      onMouseMove={(e) => {
        if (drag.current) {
          onMove(e.clientX - drag.current.x, e.clientY - drag.current.y);
          drag.current = { x: e.clientX, y: e.clientY };
        } else if (resizing.current) {
          const r = resizing.current;
          onResize(
            Math.max(16, r.w + (e.clientX - r.x)),
            Math.max(16, r.h + (e.clientY - r.y)),
          );
        }
      }}
      onMouseUp={() => {
        drag.current = null;
        resizing.current = null;
      }}
      onMouseLeave={() => {
        drag.current = null;
        resizing.current = null;
      }}
      onClick={(e) => e.stopPropagation()}
    >
      <img
        src={picture.dataUrl}
        alt={picture.name}
        draggable={false}
        style={{ display: 'block', width: '100%', height: '100%', userSelect: 'none' }}
      />
      {selected && (
        <>
          <button
            aria-label="Remove picture"
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
          <div
            data-handle="resize"
            onMouseDown={(e) => {
              e.stopPropagation();
              resizing.current = { w, h, x: e.clientX, y: e.clientY };
            }}
            style={{
              position: 'absolute',
              right: -7,
              bottom: -7,
              width: 14,
              height: 14,
              background: '#2b579a',
              border: '2px solid #fff',
              borderRadius: 3,
              cursor: 'nwse-resize',
            }}
          />
        </>
      )}
    </div>
  );
}
