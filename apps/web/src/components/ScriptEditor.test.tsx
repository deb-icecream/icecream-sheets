// @vitest-environment jsdom
/**
 * ScriptEditor render smoke tests (Extensions > Apps Script).
 * Verifies the dialog opens, scripts can be created, and the translate
 * tab migrates VBA with an untranslated-lines report.
 */
import { describe, expect, it, afterEach } from 'vitest';
import { createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { EngineHost } from '@icecream-sheets/engine';
import ScriptEditor from './ScriptEditor';

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
  window.localStorage.clear();
});

function buttonByText(el: HTMLElement, text: string): HTMLButtonElement {
  const btn = [...el.querySelectorAll('button')].find((b) => b.textContent?.trim() === text);
  if (!btn) throw new Error(`button not found: ${text}`);
  return btn as HTMLButtonElement;
}

describe('ScriptEditor', () => {
  it('opens with an empty library and creates a TypeScript script', () => {
    const el = setup(h(ScriptEditor, { host: new EngineHost(), onClose: () => {} }));
    expect(el.textContent).toContain('Apps Script');
    expect(el.textContent).toContain('No scripts yet');
    act(() => {
      buttonByText(el, '+ TS').click();
    });
    expect(el.textContent).toContain('Script 1');
    expect(el.textContent).toContain('Declared permissions');
    // The starter template declares one permission.
    expect(el.textContent).toContain('cell.write');
  });

  it('translate tab migrates VBA and reports untranslated lines', () => {
    const el = setup(h(ScriptEditor, { host: new EngineHost(), onClose: () => {} }));
    act(() => {
      buttonByText(el, 'Translate VBA / Apps Script').click();
    });
    const textarea = el.querySelector('textarea[aria-label="Script source code"]') as HTMLTextAreaElement;
    expect(textarea).toBeTruthy();
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!;
      setter.call(textarea, 'Sub Fix()\n  Range("A1").Value = 42\nEnd Sub');
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    });
    act(() => {
      buttonByText(el, 'Translate').click();
    });
    // The translated TypeScript appears with the migrated main().
    expect(el.textContent).toContain('export function main');
    expect(el.textContent).toContain('setCell');
  });

  it('close button calls onClose', () => {
    let closed = false;
    const el = setup(h(ScriptEditor, { host: new EngineHost(), onClose: () => void (closed = true) }));
    // A11yDialog renders the close control (aria-labelled); the old explicit
    // "Close" button was folded into the shared dialog shell.
    const closeBtn = el.querySelector('button[aria-label="Close dialog"]') as HTMLButtonElement;
    expect(closeBtn).toBeTruthy();
    act(() => {
      closeBtn.click();
    });
    expect(closed).toBe(true);
  });

  it('uses the shared A11yDialog shell: role=dialog, aria-modal, labelled title, Escape closes', () => {
    let closed = false;
    const el = setup(h(ScriptEditor, { host: new EngineHost(), onClose: () => void (closed = true) }));
    const dialog = el.querySelector('[role="dialog"]') as HTMLElement;
    expect(dialog).toBeTruthy();
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    const labelledby = dialog.getAttribute('aria-labelledby');
    expect(labelledby).toBeTruthy();
    expect(document.getElementById(labelledby!)?.textContent).toContain('Apps Script');
    // Escape-to-close comes from A11yDialog.
    act(() => {
      dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(closed).toBe(true);
  });
});
