// @vitest-environment jsdom
/**
 * A11yDialog behavior tests (design-docs/accessibility.md §2.3, §5.1).
 *
 * - role="dialog", aria-modal="true", aria-labelledby -> title
 * - Focus trap: Tab cycles inside, Shift+Tab wraps
 * - Escape closes
 * - Focus returns to the opener on unmount
 */
import { describe, expect, it, vi, afterEach } from 'vitest';
import { createElement as h, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import A11yDialog, { focusableIn } from './A11yDialog';

let container: HTMLDivElement | null = null;
let root: ReturnType<typeof createRoot> | null = null;

function setup(ui: React.ReactElement) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(ui);
  });
  return container;
}

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  container?.remove();
  container = null;
  root = null;
  document.body.innerHTML = '';
});

function dialogEl(): HTMLElement {
  const el = document.querySelector('[role="dialog"]');
  if (!el) throw new Error('no dialog found');
  return el as HTMLElement;
}

describe('A11yDialog semantics', () => {
  it('renders role=dialog with aria-modal and a labelledby title', () => {
    setup(h(A11yDialog, { title: 'Go To', onClose: () => {} }, h('button', null, 'OK')));
    const d = dialogEl();
    expect(d.getAttribute('aria-modal')).toBe('true');
    const labelledby = d.getAttribute('aria-labelledby');
    expect(labelledby).toBeTruthy();
    const title = document.getElementById(labelledby!);
    expect(title?.textContent).toContain('Go To');
  });

  it('moves initial focus inside the dialog', () => {
    setup(h(A11yDialog, { title: 'T', onClose: () => {} }, h('button', { id: 'inner' }, 'OK')));
    // The dialog's own close button is first in DOM order.
    expect(dialogEl().contains(document.activeElement)).toBe(true);
    expect((document.activeElement as HTMLElement)?.classList.contains('dialog-close')).toBe(true);
  });

  it('traps Tab inside the dialog', () => {
    const onClose = vi.fn();
    setup(
      h(
        'div',
        null,
        h('button', { id: 'outside' }, 'outside'),
        h(
          A11yDialog,
          { title: 'T', onClose },
          h('button', { id: 'a' }, 'A'),
          h('button', { id: 'b' }, 'B'),
        ),
      ),
    );
    const d = dialogEl();
    // Focus the last button, then Tab -> should wrap to the first focusable
    // (the dialog's own close button is first in DOM order).
    const btns = focusableIn(d);
    expect(btns.length).toBeGreaterThanOrEqual(2);
    (btns[btns.length - 1] as HTMLElement).focus();
    act(() => {
      d.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
    });
    expect(d.contains(document.activeElement)).toBe(true);
    expect(document.activeElement).toBe(btns[0]);
  });

  it('Shift+Tab on the first control wraps to the last', () => {
    setup(
      h(
        A11yDialog,
        { title: 'T', onClose: () => {} },
        h('button', { id: 'a' }, 'A'),
        h('button', { id: 'b' }, 'B'),
      ),
    );
    const d = dialogEl();
    const btns = focusableIn(d);
    (btns[0] as HTMLElement).focus();
    act(() => {
      d.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true }),
      );
    });
    expect(document.activeElement).toBe(btns[btns.length - 1]);
  });

  it('Escape closes the dialog', () => {
    const onClose = vi.fn();
    setup(h(A11yDialog, { title: 'T', onClose }, h('button', null, 'OK')));
    act(() => {
      dialogEl().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('Escape does nothing when disableEscape', () => {
    const onClose = vi.fn();
    setup(h(A11yDialog, { title: 'T', onClose, disableEscape: true }, h('button', null, 'OK')));
    act(() => {
      dialogEl().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(onClose).not.toHaveBeenCalled();
  });

  it('returns focus to the opener on unmount', () => {
    function Wrapper() {
      const [open, setOpen] = useState(false);
      return h(
        'div',
        null,
        h('button', { id: 'opener', onClick: () => setOpen(true) }, 'open'),
        open ? h(A11yDialog, { title: 'T', onClose: () => setOpen(false) }, h('button', null, 'OK')) : null,
      );
    }
    setup(h(Wrapper, null));
    const opener = document.getElementById('opener')!;
    opener.focus();
    act(() => {
      opener.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(dialogEl()).toBeTruthy();
    // Close via the dialog's own close button.
    const closeBtn = dialogEl().querySelector('.dialog-close') as HTMLElement;
    act(() => {
      closeBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it('overlay click closes unless disableOverlayClose', () => {
    const onClose = vi.fn();
    setup(
      h(A11yDialog, { title: 'T', onClose, 'data-testid': 'dlg' }, h('button', null, 'OK')),
    );
    const overlay = document.querySelector('[data-testid="dlg-overlay"]') as HTMLElement;
    act(() => {
      overlay.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
