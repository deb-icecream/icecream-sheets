/**
 * Right-click context menu for grid, row headers, column headers, and sheet tabs.
 * Supports nested submenus (hover to open) and separators.
 */
import { useEffect, useRef, useState } from 'react';

export interface MenuItem {
  label: string;
  action?: () => void;
  disabled?: boolean;
  title?: string;
  /** Nested submenu items (hover to open). */
  submenu?: MenuItem[];
  /** Render as a separator line instead of a button. */
  separator?: boolean;
}

interface ContextMenuProps {
  x: number;
  y: number;
  items: MenuItem[];
  onClose: () => void;
}

function MenuItems({ items, onClose }: { items: MenuItem[]; onClose: () => void }) {
  const [openSub, setOpenSub] = useState<number | null>(null);
  return (
    <>
      {items.map((item, i) =>
        item.separator ? (
          <div key={i} className="ctx-separator" />
        ) : item.submenu ? (
          <div
            key={i}
            className="ctx-submenu"
            onMouseEnter={() => setOpenSub(i)}
            onMouseLeave={() => setOpenSub(null)}
          >
            <button
              type="button"
              className="ctx-item ctx-submenu-label"
              disabled={item.disabled}
              title={item.title ?? item.label}
            >
              <span>{item.label}</span>
              <span className="ctx-submenu-arrow">▸</span>
            </button>
            {openSub === i && (
              <div className="ctx-submenu-popup" onClick={(e) => e.stopPropagation()}>
                <MenuItems items={item.submenu} onClose={onClose} />
              </div>
            )}
          </div>
        ) : (
          <button
            key={i}
            className="ctx-item"
            disabled={item.disabled}
            title={item.title ?? item.label}
            onClick={() => {
              if (!item.disabled) {
                item.action?.();
                onClose();
              }
            }}
          >
            {item.label}
          </button>
        ),
      )}
    </>
  );
}

export default function ContextMenu({ x, y, items, onClose }: ContextMenuProps) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onClick = () => onClose();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('click', onClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('click', onClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  useEffect(() => {
    ref.current?.focus();
  }, []);

  return (
    <div
      ref={ref}
      className="ctx-menu"
      tabIndex={-1}
      style={{ left: Math.min(x, window.innerWidth - 240), top: Math.min(y, window.innerHeight - items.length * 30 - 16) }}
      onClick={(e) => e.stopPropagation()}
    >
      <MenuItems items={items} onClose={onClose} />
    </div>
  );
}
