/**
 * A11yDialog — the single dialog primitive for the app
 * (design-docs/accessibility.md §2.3).
 *
 * Guarantees for every dialog that uses it:
 * - role="dialog", aria-modal="true", aria-labelledby -> visible title
 * - Focus trap: Tab / Shift+Tab cycle inside the dialog
 * - Escape closes (unless disabled)
 * - Focus returns to the element that opened the dialog
 * - Initial focus: first focusable control, else the dialog itself
 *
 * Usage:
 *   <A11yDialog title="Go To" onClose={onClose}>
 *     ...dialog body...
 *   </A11yDialog>
 */
import { useEffect, useId, useRef } from 'react';

interface A11yDialogProps {
  /** Visible title (rendered in the title bar). Accepts dynamic content. */
  title: React.ReactNode;
  /**
   * Close handler. When omitted the dialog is non-dismissible (no close
   * button, Escape and overlay clicks are ignored) — use for blocking
   * gates like the gateway login.
   */
  onClose?: () => void;
  children?: React.ReactNode;
  /** Disable the Escape-to-close behavior. Default false. */
  disableEscape?: boolean;
  /** Disable closing when the overlay backdrop is clicked. Default false. */
  disableOverlayClose?: boolean;
  /** Extra className for the dialog box. */
  className?: string;
  /** Width of the dialog box. Number = px; string = any CSS width (e.g. "min(1100px, 96vw)"). Default 420. */
  width?: number | string;
  /** Test id hook. */
  'data-testid'?: string;
}

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), ' +
  'textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** All focusable descendants of root, in tab order, excluding hidden ones. */
export function focusableIn(root: HTMLElement): HTMLElement[] {
  // Note: jsdom has no layout engine, so visibility is determined from
  // explicit hiding signals only (hidden attribute, aria-hidden, inline
  // display:none / visibility:hidden). In real browsers this is slightly
  // permissive toward zero-size elements, which is harmless for a trap.
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => {
    if (el.hasAttribute('hidden')) return false;
    if (el.getAttribute('aria-hidden') === 'true') return false;
    const style = el.getAttribute('style') ?? '';
    if (/display\s*:\s*none/i.test(style) || /visibility\s*:\s*hidden/i.test(style)) return false;
    return true;
  });
}

export default function A11yDialog({
  title,
  onClose,
  children,
  disableEscape = false,
  disableOverlayClose = false,
  className,
  width = 420,
  'data-testid': testId,
}: A11yDialogProps) {
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const openerRef = useRef<Element | null>(null);

  // Remember the opener and move focus inside on mount; restore on unmount.
  useEffect(() => {
    openerRef.current = document.activeElement;
    const dialog = dialogRef.current;
    if (dialog) {
      const first = focusableIn(dialog)[0];
      (first ?? dialog).focus();
    }
    return () => {
      const opener = openerRef.current;
      if (opener instanceof HTMLElement) opener.focus();
    };
  }, []);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape' && !disableEscape && onClose) {
      e.stopPropagation();
      onClose();
      return;
    }
    if (e.key !== 'Tab') return;
    const dialog = dialogRef.current;
    if (!dialog) return;
    const items = focusableIn(dialog);
    if (items.length === 0) {
      e.preventDefault();
      return;
    }
    const first = items[0];
    const last = items[items.length - 1];
    const active = document.activeElement;
    if (e.shiftKey && (active === first || !dialog.contains(active))) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && active === last) {
      e.preventDefault();
      first.focus();
    }
  };

  return (
    <div
      className="dialog-overlay"
      onClick={disableOverlayClose || !onClose ? undefined : onClose}
      data-testid={testId ? `${testId}-overlay` : undefined}
    >
      <div
        ref={dialogRef}
        className={className ? `dialog ${className}` : 'dialog'}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={handleKeyDown}
        data-testid={testId}
        style={{ width }}
      >
        <div className="dialog-titlebar">
          <div className="dialog-title" id={titleId}>
            {title}
          </div>
          {onClose && (
            <button
              type="button"
              className="dialog-close"
              aria-label={`Close ${typeof title === 'string' ? title : 'dialog'}`}
              onClick={onClose}
            >
              ×
            </button>
          )}
        </div>
        {children}
      </div>
    </div>
  );
}
