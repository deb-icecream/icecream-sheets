/**
 * Zoom dialog (View > Zoom > Zoom…).
 *
 * Preset magnifications plus a custom 25–400% input/slider. The parent
 * owns the zoom state and applies it to the grid; "Zoom to Selection"
 * is a separate ribbon command that calls zoomToFit()
 * (features/workbookViews.ts) with the measured selection size.
 */
import { useState } from 'react';
import { clampZoom, MAX_ZOOM, MIN_ZOOM, ZOOM_PRESETS } from '../features/workbookViews';
import A11yDialog from './A11yDialog';

interface ZoomDialogProps {
  zoom: number;
  onClose: () => void;
  onZoomChange: (zoom: number) => void;
}

export default function ZoomDialog({ zoom, onClose, onZoomChange }: ZoomDialogProps) {
  const [custom, setCustom] = useState(zoom);
  const [useCustom, setUseCustom] = useState(!ZOOM_PRESETS.includes(zoom));

  const apply = (): void => {
    onZoomChange(clampZoom(useCustom ? custom : zoom));
    onClose();
  };

  return (
    <A11yDialog title={<>Zoom</>} width={360} onClose={onClose}>
        <div className="dialog-row" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 8 }}>
          <div style={{ fontSize: 13 }}>
            <strong>Magnification</strong>
            {ZOOM_PRESETS.map((z) => (
              <label key={z} style={{ display: 'block', marginTop: 4 }}>
                <input
                  type="radio"
                  name="zoom-preset"
                  checked={!useCustom && zoom === z}
                  onChange={() => { setUseCustom(false); onZoomChange(z); }}
                /> {z}%
              </label>
            ))}
            <label style={{ display: 'block', marginTop: 4 }}>
              <input type="radio" name="zoom-preset" checked={useCustom} onChange={() => setUseCustom(true)} /> Custom:
            </label>
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', paddingLeft: 20 }}>
            <input
              type="range"
              min={MIN_ZOOM}
              max={MAX_ZOOM}
              value={clampZoom(custom)}
              onChange={(e) => { setCustom(Number(e.target.value)); setUseCustom(true); }}
              aria-label="Custom zoom"
              style={{ flex: 1 }}
            />
            <input
              type="number"
              min={MIN_ZOOM}
              max={MAX_ZOOM}
              value={clampZoom(custom)}
              onChange={(e) => { setCustom(Number(e.target.value) || MIN_ZOOM); setUseCustom(true); }}
              aria-label="Custom zoom percent"
              style={{ width: 70 }}
            />
            <span>%</span>
          </div>
          <div style={{ fontSize: 12, color: '#666' }}>Range {MIN_ZOOM}% – {MAX_ZOOM}%.</div>
        </div>
        <div className="dialog-actions">
          <button onClick={apply}>OK</button>
          <button onClick={onClose}>Cancel</button>
        </div>
      </A11yDialog>
  );
}
