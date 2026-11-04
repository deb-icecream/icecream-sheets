/**
 * Generic autocomplete dropdown for the grid cell editor and formula bar.
 * Keyboard: ArrowUp/Down to move, Enter/Tab to pick, Escape to dismiss.
 * Mouse: click to pick. Purely presentational — the parent computes
 * suggestions and handles selection.
 */
import { useEffect, useRef, useState } from 'react';

export interface DropdownItem {
  /** Text inserted on pick. */
  value: string;
  /** Primary label shown. */
  label: string;
  /** Secondary hint (count, signature, category). */
  hint?: string;
}

interface AutocompleteDropdownProps {
  items: DropdownItem[];
  /** Currently highlighted index; parent owns keyboard nav. */
  activeIndex: number;
  onPick: (item: DropdownItem) => void;
  onHover: (index: number) => void;
  /**
   * Prefix for generated option element ids. The listbox carries
   * aria-activedescendant pointing at the active option's id
   * (design-docs/accessibility.md §2.2).
   */
  idPrefix?: string;
}

export default function AutocompleteDropdown({ items, activeIndex, onPick, onHover, idPrefix = 'ac' }: AutocompleteDropdownProps) {
  const listRef = useRef<HTMLDivElement>(null);
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    // Keep the active item in view.
    const el = listRef.current?.querySelector<HTMLElement>(`[data-idx="${activeIndex}"]`);
    if (el && !scrolled) {
      el.scrollIntoView({ block: 'nearest' });
      setScrolled(true);
    }
  }, [activeIndex, scrolled]);
  useEffect(() => setScrolled(false), [items]);

  if (items.length === 0) return null;
  const activeId = activeIndex >= 0 && activeIndex < items.length ? `${idPrefix}-option-${activeIndex}` : undefined;
  return (
    <div
      ref={listRef}
      className="autocomplete-dropdown"
      id={`${idPrefix}-listbox`}
      role="listbox"
      aria-label="Suggestions"
      aria-activedescendant={activeId}
      onMouseDown={(e) => e.preventDefault() /* keep editor focus */}
    >
      {items.map((item, i) => (
        <div
          key={`${item.value}-${i}`}
          id={`${idPrefix}-option-${i}`}
          data-idx={i}
          role="option"
          aria-selected={i === activeIndex}
          className={`autocomplete-item${i === activeIndex ? ' active' : ''}`}
          onMouseEnter={() => onHover(i)}
          onMouseDown={(e) => {
            e.preventDefault();
            onPick(item);
          }}
        >
          <span className="autocomplete-label">{item.label}</span>
          {item.hint && <span className="autocomplete-hint">{item.hint}</span>}
        </div>
      ))}
    </div>
  );
}
