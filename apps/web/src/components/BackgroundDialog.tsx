/**
 * BackgroundDialog: Page Layout > Page Setup > Background.
 *
 * Sets a sheet background — a solid color, a picture (uploaded from the
 * device, stored as a data URL), or none. The parent owns the value and
 * persists it in workbook metadata (`icecream.background.<sheet>`); the
 * grid container renders it behind the cells.
 */
import { useRef } from 'react';
import A11yDialog from './A11yDialog';

export interface SheetBackground {
  color: string | null;
  /** Picture background as a data URL, or null. */
  imageDataUrl: string | null;
}

export const BACKGROUND_METADATA_PREFIX = 'icecream.background.';
export const NO_BACKGROUND: SheetBackground = { color: null, imageDataUrl: null };

export function backgroundMetadataKey(sheet: string): string {
  return `${BACKGROUND_METADATA_PREFIX}${sheet}`;
}

export function backgroundToMetadata(bg: SheetBackground): unknown {
  return JSON.parse(JSON.stringify(bg)) as unknown;
}

export function backgroundFromMetadata(meta: unknown): SheetBackground {
  if (typeof meta !== 'object' || meta === null) return { ...NO_BACKGROUND };
  const r = meta as Record<string, unknown>;
  return {
    color: typeof r.color === 'string' ? r.color : null,
    imageDataUrl: typeof r.imageDataUrl === 'string' ? r.imageDataUrl : null,
  };
}

export interface BackgroundDialogProps {
  sheet: string;
  background: SheetBackground;
  onChange: (bg: SheetBackground) => void;
  onClose: () => void;
}

export default function BackgroundDialog({ sheet, background, onChange, onClose }: BackgroundDialogProps) {
  const fileRef = useRef<HTMLInputElement>(null);

  const pickFile = (file: File) => {
    const reader = new FileReader();
    reader.onload = () => {
      const url = typeof reader.result === 'string' ? reader.result : null;
      if (url) onChange({ ...background, imageDataUrl: url });
    };
    reader.readAsDataURL(file);
  };

  return (
    <A11yDialog title={<>Sheet background — {sheet}</>} width={440} onClose={onClose}>
        <div style={{ padding: 14, fontSize: 13, display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div
            style={{
              height: 110,
              border: '1px solid #ccc',
              borderRadius: 4,
              backgroundColor: background.color ?? '#ffffff',
              backgroundImage: background.imageDataUrl ? `url(${background.imageDataUrl})` : undefined,
              backgroundSize: 'cover',
              backgroundPosition: 'center',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: '#666',
            }}
          >
            {!background.color && !background.imageDataUrl && 'No background'}
          </div>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            Background color{' '}
            <input
              type="color"
              value={background.color ?? '#ffffff'}
              onChange={(e) => onChange({ color: e.target.value, imageDataUrl: null })}
              title="Pick a background color (clears any picture)"
              style={{ width: 40, height: 26, padding: 0, border: '1px solid #999' }}
            />
            {background.color && (
              <button onClick={() => onChange({ ...background, color: null })} title="Remove the background color">
                Clear color
              </button>
            )}
          </label>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <button onClick={() => fileRef.current?.click()} title="Use a picture from your device as the sheet background">
              {background.imageDataUrl ? 'Change picture…' : 'Set picture…'}
            </button>
            {background.imageDataUrl && (
              <button onClick={() => onChange({ ...background, imageDataUrl: null })} title="Remove the background picture">
                Clear picture
              </button>
            )}
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              hidden
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) pickFile(f);
                e.target.value = '';
              }}
            />
          </div>
          <button
            onClick={() => onChange({ ...NO_BACKGROUND })}
            title="Remove all background formatting"
            style={{ alignSelf: 'flex-start' }}
          >
            Remove background
          </button>
          <p style={{ color: '#666', margin: 0 }}>
            The background renders behind the grid cells and is not printed.
          </p>
        </div>
        <div style={{ padding: '10px 14px', borderTop: '1px solid #ddd', display: 'flex', justifyContent: 'flex-end' }}>
          <button onClick={onClose}>Done</button>
        </div>
      </A11yDialog>
  );
}
