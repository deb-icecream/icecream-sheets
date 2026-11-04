/**
 * Form controls (track 18 `forms-activex`): safe native Button, Checkbox,
 * Dropdown and Listbox rendered as floating overlays, bound to typed-view
 * cell values. Legacy ActiveX is not executed (Windows-only/unsafe) — these
 * are the functional equivalents.
 */
import { useRef } from 'react';

export type FormControlKind = 'button' | 'checkbox' | 'dropdown' | 'listbox';

export interface FormControl {
  id: number;
  kind: FormControlKind;
  label: string;
  x: number;
  y: number;
  w: number;
  h: number;
  /** Bound cell that this control reads/writes, e.g. {row:0,col:0}. */
  boundRow: number;
  boundCol: number;
  /** For dropdown/listbox: the option list. */
  options: string[];
}

export const FORM_CONTROL_KINDS: { id: FormControlKind; label: string }[] = [
  { id: 'button', label: 'Button' },
  { id: 'checkbox', label: 'Checkbox' },
  { id: 'dropdown', label: 'Dropdown' },
  { id: 'listbox', label: 'Listbox' },
];

interface FormControlOverlayProps {
  control: FormControl;
  /** Current value of the bound cell (for checkbox/dropdown/listbox state). */
  boundValue: string;
  onClose: () => void;
  onMove: (dx: number, dy: number) => void;
  /** Write a value into the bound cell. */
  onWrite: (value: string) => void;
  /** Button action: recalculate. */
  onButtonPress: () => void;
}

function useDrag(onMove: (dx: number, dy: number) => void) {
  const last = useRef<{ x: number; y: number } | null>(null);
  return {
    onMouseDown: (e: React.MouseEvent) => {
      if ((e.target as HTMLElement).closest('button,input,select')) return;
      last.current = { x: e.clientX, y: e.clientY };
    },
    onMouseMove: (e: React.MouseEvent) => {
      if (last.current) {
        onMove(e.clientX - last.current.x, e.clientY - last.current.y);
        last.current = { x: e.clientX, y: e.clientY };
      }
    },
    onMouseUp: () => { last.current = null; },
    onMouseLeave: () => { last.current = null; },
  };
}

export function FormControlOverlay({
  control,
  boundValue,
  onClose,
  onMove,
  onWrite,
  onButtonPress,
}: FormControlOverlayProps) {
  const drag = useDrag(onMove);
  const checked = boundValue.toUpperCase() === 'TRUE' || boundValue === '1';

  return (
    <div
      role="group"
      aria-label={`${control.kind} control bound to cell`}
      style={{
        position: 'absolute',
        left: control.x,
        top: control.y,
        minWidth: Math.max(control.w, 80),
        zIndex: 20,
        background: 'rgba(255,255,255,0.95)',
        border: '1px solid #9ca3af',
        borderRadius: 4,
        padding: 6,
        cursor: 'move',
        pointerEvents: 'auto',
      }}
      {...drag}
    >
      {control.kind === 'button' && (
        <button onClick={onButtonPress} style={{ width: '100%' }} aria-label={control.label}>
          {control.label}
        </button>
      )}
      {control.kind === 'checkbox' && (
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', fontSize: 13 }}>
          <input
            type="checkbox"
            checked={checked}
            onChange={(e) => onWrite(e.target.checked ? 'TRUE' : 'FALSE')}
            aria-label={control.label}
          />
          {control.label}
        </label>
      )}
      {control.kind === 'dropdown' && (
        <label style={{ display: 'block', fontSize: 12 }}>
          <span style={{ color: '#666' }}>{control.label}</span>
          <select
            value={control.options.includes(boundValue) ? boundValue : ''}
            onChange={(e) => onWrite(e.target.value)}
            style={{ width: '100%', marginTop: 2 }}
            aria-label={control.label}
          >
            <option value="">— choose —</option>
            {control.options.map((o) => <option key={o} value={o}>{o}</option>)}
          </select>
        </label>
      )}
      {control.kind === 'listbox' && (
        <label style={{ display: 'block', fontSize: 12 }}>
          <span style={{ color: '#666' }}>{control.label}</span>
          <select
            size={Math.min(Math.max(control.options.length, 2), 5)}
            value={control.options.includes(boundValue) ? boundValue : ''}
            onChange={(e) => onWrite(e.target.value)}
            style={{ width: '100%', marginTop: 2 }}
            aria-label={control.label}
          >
            {control.options.map((o) => <option key={o} value={o}>{o}</option>)}
          </select>
        </label>
      )}
      <button
        aria-label={`Remove ${control.kind} control`}
        onClick={(e) => { e.stopPropagation(); onClose(); }}
        style={{
          position: 'absolute', top: -10, right: -10, width: 20, height: 20,
          borderRadius: '50%', border: '1px solid #999', background: '#fff',
          cursor: 'pointer', fontSize: 12, lineHeight: 1, padding: 0,
        }}
      >
        ×
      </button>
    </div>
  );
}
