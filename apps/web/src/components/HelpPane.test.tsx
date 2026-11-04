// @vitest-environment jsdom
/**
 * HelpPane section tests: the new surfaces (Function List, Privacy
 * Policy, Terms) render real content, and initialSection opens on
 * the requested section.
 */
import { describe, expect, it, afterEach } from 'vitest';
import { createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import HelpPane from './HelpPane';

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
});

function tab(el: HTMLElement, label: string): HTMLElement {
  const btn = [...el.querySelectorAll('button')].find((b) => b.textContent === label);
  if (!btn) throw new Error(`tab not found: ${label}`);
  return btn as HTMLElement;
}

describe('HelpPane new surfaces', () => {
  it('opens on the requested initialSection', () => {
    const el = setup(h(HelpPane, { onClose: () => {}, initialSection: 'privacy' }));
    expect(el.textContent).toContain('Privacy Policy');
    expect(el.textContent).toContain('Your data stays yours');
  });

  it('renders the terms section', () => {
    const el = setup(h(HelpPane, { onClose: () => {}, initialSection: 'terms' }));
    expect(el.textContent).toContain('Terms of Use');
    expect(el.textContent).toContain('Acceptable use');
  });

  it('renders a searchable function list', () => {
    const el = setup(h(HelpPane, { onClose: () => {}, initialSection: 'functions' }));
    expect(el.textContent).toContain('Function list');
    expect(el.textContent).toContain('SUM');
    expect(el.textContent).toContain('XLOOKUP');
    // Search filters the list.
    const input = el.querySelector('input[aria-label="Search functions"]') as HTMLInputElement;
    act(() => {
      input.focus();
    });
    // Simulate typing via native setter + input event.
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
    setter.call(input, 'XLOOKUP');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    expect(el.textContent).toContain('XLOOKUP');
  });

  it('switches sections via the tab bar', () => {
    const el = setup(h(HelpPane, { onClose: () => {} }));
    act(() => {
      tab(el, 'Privacy Policy').click();
    });
    expect(el.textContent).toContain('Your data stays yours');
    act(() => {
      tab(el, 'Terms').click();
    });
    expect(el.textContent).toContain('Terms of Use');
    act(() => {
      tab(el, 'Function List').click();
    });
    expect(el.textContent).toContain('Function list');
  });
});
