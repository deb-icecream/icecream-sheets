/**
 * Small presentational primitives for the ribbon: groups and buttons.
 * All behavior lives in the parent Ribbon; these only render.
 */
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { ReactNode } from 'react';

/** A labeled group of buttons with a divider, Excel-style. */
export function RibbonGroup({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="ribbon-group">
      <div className="ribbon-group-buttons">{children}</div>
      <div className="ribbon-group-label">{label}</div>
    </div>
  );
}

interface RibbonButtonProps {
  label: string;
  title?: string;
  onClick?: () => void;
  disabled?: boolean;
  /** Highlighted state (toggles, active modes). */
  active?: boolean;
  size?: 'large' | 'small';
  /** Optional SVG icon, rendered above the label (large) or left of it (small). */
  icon?: ReactNode;
}

/** A ribbon button. Disabled buttons carry a `title` explaining why. */
export function RibbonButton({
  label,
  title,
  onClick,
  disabled,
  active,
  size = 'small',
  icon,
}: RibbonButtonProps) {
  const cls = [
    'ribbon-btn',
    size,
    active ? 'active' : '',
    disabled ? 'disabled' : '',
    icon ? 'with-icon' : '',
  ]
    .filter(Boolean)
    .join(' ');
  return (
    <button
      type="button"
      className={cls}
      title={title ?? label}
      onClick={onClick}
      disabled={disabled}
    >
      {icon ? (
        <span className="ribbon-btn-icon" aria-hidden="true">
          {icon}
        </span>
      ) : null}
      <span className="ribbon-btn-label">{label}</span>
    </button>
  );
}

interface RibbonSelectProps {
  label: string;
  value: string;
  options: readonly string[];
  onChange: (value: string) => void;
  title?: string;
  width?: number;
}

/** A dropdown select styled for the ribbon (font name, size, number format). */
export function RibbonSelect({ label, value, options, onChange, title, width }: RibbonSelectProps) {
  return (
    <label className="ribbon-select" title={title ?? label}>
      <span className="ribbon-select-caption">{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        style={width ? { width } : undefined}
        aria-label={label}
      >
        {options.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
    </label>
  );
}

interface RibbonMenuProps {
  label: string;
  title?: string;
  active?: boolean;
  disabled?: boolean;
  /** Optional SVG icon rendered left of the label. */
  icon?: ReactNode;
  children: ReactNode;
}

/**
 * A button that opens a small popup menu (color palettes, border options,
 * cell styles). Closes on outside click / Escape / selection.
 *
 * The popup is PORTALED to document.body with position:fixed (issue #24):
 * the ribbon panel clips its overflow (it must never show a scrollbar), and
 * any overflow-clipping ancestor in the containing-block chain would slice
 * the popup at the panel's bottom edge. Anchored to the button's rect;
 * closes if anything scrolls or the window resizes (the anchor moves).
 */
export function RibbonMenu({ label, title, active, disabled, icon, children }: RibbonMenuProps) {
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState<{ top: number; left: number } | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const popupRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (ref.current && !ref.current.contains(t) && popupRef.current && !popupRef.current.contains(t)) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    const onMove = () => setOpen(false);
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    window.addEventListener('resize', onMove);
    window.addEventListener('scroll', onMove, true);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', onMove);
      window.removeEventListener('scroll', onMove, true);
    };
  }, [open ]);

  return (
    <div className="ribbon-menu" ref={ref}>
      <button
        type="button"
        className={['ribbon-btn', 'small', active ? 'active' : '', disabled ? 'disabled' : '', icon ? 'with-icon' : '']
          .filter(Boolean)
          .join(' ')}
        title={title ?? label}
        disabled={disabled}
        onClick={(e) => {
          if (!open) {
            const r = e.currentTarget.getBoundingClientRect();
            setAnchor({ top: r.bottom + 4, left: r.left });
          }
          setOpen((o) => !o);
        }}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        {icon ? (
          <span className="ribbon-btn-icon" aria-hidden="true">
            {icon}
          </span>
        ) : null}
        <span className="ribbon-btn-label">{label} ▾</span>
      </button>
      {open &&
        anchor &&
        createPortal(
          <div
            className="ribbon-menu-popup ribbon-popup-fixed"
            role="menu"
            ref={popupRef}
            style={{ top: anchor.top, left: anchor.left }}
            onClick={() => setOpen(false)}
          >
            {children}
          </div>,
          document.body,
        )}
    </div>
  );
}

/** One clickable row inside a RibbonMenu popup. */
export function RibbonMenuItem({
  label,
  title,
  onClick,
  preview,
  disabled,
}: {
  label: string;
  title?: string;
  onClick: () => void;
  /** Optional inline style preview (e.g. a style swatch). */
  preview?: ReactNode;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      className={['ribbon-menu-item', disabled ? 'disabled' : ''].filter(Boolean).join(' ')}
      title={title ?? label}
      onClick={disabled ? undefined : onClick}
      disabled={disabled}
      role="menuitem"
    >
      {preview}
      <span>{label}</span>
    </button>
  );
}

/**
 * A hover-opened submenu inside a RibbonMenu popup. Unlike RibbonMenu it does
 * NOT close the parent popup when interacting — clicks inside stop propagation.
 */
export function RibbonSubmenu({ label, title, children }: { label: string; title?: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div
      className="ribbon-submenu"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onClick={(e) => e.stopPropagation()}
    >
      <button type="button" className="ribbon-menu-item ribbon-submenu-label" title={title ?? label} role="menuitem" aria-haspopup="menu">
        <span>{label}</span>
        <span className="ribbon-submenu-arrow">▸</span>
      </button>
      {open && <div className="ribbon-submenu-popup" role="menu">{children}</div>}
    </div>
  );
}

/** A grid of color swatches for the color-picker menus. */
export function ColorSwatches({ colors, onPick }: { colors: readonly string[]; onPick: (c: string) => void }) {
  return (
    <div className="ribbon-swatches" role="menu">
      {colors.map((c) => (
        <button
          key={c}
          type="button"
          className="ribbon-swatch"
          style={{ backgroundColor: c }}
          title={c}
          onClick={() => onPick(c)}
          role="menuitem"
          aria-label={`Color ${c}`}
        />
      ))}
    </div>
  );
}
