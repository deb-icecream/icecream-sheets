/**
 * Ruler (View > Show > Ruler) for Page Layout view.
 *
 * Horizontal and vertical rulers in inches, scaled by the current zoom.
 * The parent shows this only in Page Layout view, above/left of the
 * page area; margin zones are shaded so the printable area is visible.
 */
import { useMemo } from 'react';

interface RulerProps {
  orientation: 'horizontal' | 'vertical';
  /** Length in px (already zoom-scaled). */
  lengthPx: number;
  /** Zoom percent. */
  zoom: number;
  /** Margin in px (already zoom-scaled) — shaded on both ends. */
  marginPx: number;
}

const PX_PER_IN = 96;

export default function Ruler({ orientation, lengthPx, zoom, marginPx }: RulerProps) {
  const ticks = useMemo(() => {
    const scale = (zoom / 100) * PX_PER_IN;
    const out: { pos: number; label: string; major: boolean }[] = [];
    // Minor ticks every 1/8 inch, labels every inch.
    const step = scale / 8;
    for (let pos = 0; pos <= lengthPx; pos += step) {
      const inches = pos / scale;
      const isInch = Math.abs(inches - Math.round(inches)) < 1e-6;
      out.push({ pos, label: isInch ? String(Math.round(inches)) : '', major: isInch });
    }
    return out;
  }, [lengthPx, zoom]);

  const horizontal = orientation === 'horizontal';
  const size = 20;

  return (
    <div
      aria-hidden
      style={{
        position: 'relative',
        width: horizontal ? lengthPx : size,
        height: horizontal ? size : lengthPx,
        background: '#f8f9fa',
        border: '1px solid var(--line-soft)',
        overflow: 'hidden',
        flexShrink: 0,
      }}
    >
      {/* margin shading */}
      <div
        style={
          horizontal
            ? { position: 'absolute', left: 0, top: 0, bottom: 0, width: marginPx, background: 'rgba(0,0,0,0.06)' }
            : { position: 'absolute', top: 0, left: 0, right: 0, height: marginPx, background: 'rgba(0,0,0,0.06)' }
        }
      />
      <div
        style={
          horizontal
            ? { position: 'absolute', right: 0, top: 0, bottom: 0, width: marginPx, background: 'rgba(0,0,0,0.06)' }
            : { position: 'absolute', bottom: 0, left: 0, right: 0, height: marginPx, background: 'rgba(0,0,0,0.06)' }
        }
      />
      {ticks.map((t, i) =>
        t.major ? (
          <div
            key={i}
            style={
              horizontal
                ? { position: 'absolute', left: t.pos, top: 8, fontSize: 9, color: '#666', transform: 'translateX(2px)' }
                : { position: 'absolute', top: t.pos, left: 2, fontSize: 9, color: '#666', transform: 'translateY(-50%)' }
            }
          >
            {t.label}
          </div>
        ) : null,
      )}
      {ticks.map((t, i) => (
        <div
          key={`t${i}`}
          style={
            horizontal
              ? {
                  position: 'absolute', left: t.pos, bottom: 0,
                  width: 1, height: t.major ? 10 : 5, background: '#999',
                }
              : {
                  position: 'absolute', top: t.pos, right: 0,
                  height: 1, width: t.major ? 10 : 5, background: '#999',
                }
          }
        />
      ))}
    </div>
  );
}
