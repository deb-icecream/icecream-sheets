// @vitest-environment jsdom
/**
 * AppBuilder template picker (design-docs/no-code-app-builder.md §7).
 *
 * The product-owned sample templates must be reachable from the builder UI:
 * picking a template copies its spec and retargets the range binding at the
 * chosen sheet, then creates a valid app.
 */
import { describe, expect, it, afterEach, vi } from 'vitest';
import { createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { EngineHost } from '@icecream-sheets/engine';
import { validateAppSpec, type AppSpec } from '@icecream-sheets/service';
import { AppBuilderDialog } from './AppBuilder';

let container: HTMLDivElement | null = null;
let root: ReturnType<typeof createRoot> | null = null;

function mount(ui: React.ReactElement): HTMLElement {
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

function clickText(el: HTMLElement, text: string): void {
  const btn = [...el.querySelectorAll('button')].find((b) =>
    (b.textContent ?? '').includes(text),
  );
  expect(btn, `button containing "${text}"`).toBeDefined();
  act(() => {
    btn!.click();
  });
}

function openDialog(onCreate: (spec: AppSpec) => void): HTMLElement {
  const host = new EngineHost();
  return mount(
    h(AppBuilderDialog, {
      host,
      sheets: ['Sheet1'],
      initialSheet: 'Sheet1',
      onClose: () => {},
      onCreate,
    }),
  );
}

describe('AppBuilder template picker', () => {
  it('lists the shipped templates in step 0', () => {
    const el = openDialog(() => {});
    const text = el.textContent ?? '';
    for (const name of ['Expense Tracker', 'Project Dashboard', 'Inventory Manager', 'Contact Directory']) {
      expect(text).toContain(name);
    }
  });

  it('creates the expense-tracker app from the template with the binding retargeted', () => {
    const onCreate = vi.fn();
    const el = openDialog(onCreate);
    clickText(el, 'Expense Tracker');
    // Template mode replaces the wizard steps.
    expect(el.textContent).toContain('Starting from the Expense Tracker template');
    clickText(el, 'Create app from template');
    expect(onCreate).toHaveBeenCalledTimes(1);
    const spec = onCreate.mock.calls[0]![0] as AppSpec;
    expect(spec.id).toBe('app-expense-tracker');
    expect(spec.name).toBe('Expense Tracker');
    // The template suggests the "Expenses" sheet, which does not exist here,
    // so the binding is retargeted at the chosen sheet.
    expect(spec.dataSource.binding.sheet).toBe('Sheet1');
    expect(spec.views.length).toBeGreaterThan(0);
    expect(validateAppSpec(spec).ok).toBe(true);
  });

  it('the created template app validates against the app spec format', () => {
    const onCreate = vi.fn();
    const el = openDialog(onCreate);
    clickText(el, 'Inventory Manager');
    clickText(el, 'Create app from template');
    const spec = onCreate.mock.calls[0]![0] as AppSpec;
    expect(spec.id).toBe('app-inventory-manager');
    expect(spec.dataSource.binding.sheet).toBe('Sheet1');
    const v = validateAppSpec(spec);
    expect(v.ok).toBe(true);
  });

  it('going back clears the template and restores the wizard', () => {
    const el = openDialog(() => {});
    clickText(el, 'Contact Directory');
    expect(el.textContent).toContain('Starting from the Contact Directory template');
    clickText(el, 'Back to the builder wizard');
    // The template gallery is visible again (wizard step 0).
    expect(el.textContent).toContain('Start from a template');
  });
});
