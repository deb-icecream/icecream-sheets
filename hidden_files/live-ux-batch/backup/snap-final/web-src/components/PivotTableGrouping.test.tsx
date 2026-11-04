// @vitest-environment jsdom
/**
 * PivotTable grouping UI (packages/service/src/pivot.ts groupings).
 *
 * The engine's date/numeric/custom grouping operators must be reachable
 * from the pivot builder: each Rows/Columns field gets a Group editor, and
 * the created PivotSpec carries the groupings.
 */
import { describe, expect, it, afterEach, vi } from 'vitest';
import { createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import type { PivotSpec } from '@icecream-sheets/service';
import {
  PivotTableBuilderDialog,
  detectPivotGroupKind,
  groupingSummary,
} from './PivotTable';

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

const FIELDS = [
  { name: 'Date', values: ['2024-01-15', '2024-02-20', '2024-03-05'] },
  { name: 'Amount', values: ['10', '25', '40'] },
  { name: 'Region', values: ['East', 'West'] },
];

function openBuilder(onCreate: (spec: PivotSpec) => void): HTMLElement {
  return mount(
    h(PivotTableBuilderDialog, { fields: FIELDS, onClose: () => {}, onCreate }),
  );
}

function setInputValue(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
  act(() => {
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function setSelectValue(select: HTMLSelectElement, value: string): void {
  act(() => {
    select.value = value;
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

/** Click the area button (R/C/V/F) on a field's row in the field list. */
function addFieldToArea(el: HTMLElement, fieldName: string, areaKey: 'R' | 'C' | 'V' | 'F'): void {
  const rows = [...el.querySelectorAll('div')].filter((d) =>
    (d.firstElementChild as HTMLElement | null)?.tagName === 'SPAN' &&
    d.textContent === fieldName + 'RCVF',
  );
  // Fallback: find the field row by its title'd span.
  const row =
    rows[0] ??
    [...el.querySelectorAll('span[title]')].find((s) => s.textContent === fieldName)?.parentElement;
  expect(row, `field row for ${fieldName}`).toBeDefined();
  const btn = [...row!.querySelectorAll('button')].find((b) => b.textContent === areaKey);
  expect(btn, `area button ${areaKey} for ${fieldName}`).toBeDefined();
  act(() => {
    btn!.click();
  });
}

/** Click the "Group…" button on a field chip. */
function openGroupEditor(el: HTMLElement, fieldName: string): void {
  const btn = el.querySelector(`button[aria-label="Group ${fieldName}"]`) as HTMLButtonElement | null;
  expect(btn, `Group button for ${fieldName}`).not.toBeNull();
  act(() => {
    btn!.click();
  });
}

function clickButton(el: HTMLElement, text: string): void {
  const btn = [...el.querySelectorAll('button')].find((b) => (b.textContent ?? '').trim() === text);
  expect(btn, `button "${text}"`).toBeDefined();
  act(() => {
    btn!.click();
  });
}

describe('detectPivotGroupKind', () => {
  it('detects date fields', () => {
    expect(detectPivotGroupKind(['2024-01-01', '2024-12-31'])).toBe('date');
  });

  it('detects numeric fields', () => {
    expect(detectPivotGroupKind(['10', '2.5', '-3'])).toBe('numeric');
  });

  it('falls back to custom for text', () => {
    expect(detectPivotGroupKind(['East', 'West'])).toBe('custom');
    expect(detectPivotGroupKind([])).toBe('custom');
  });
});

describe('groupingSummary', () => {
  it('summarizes each grouping kind', () => {
    expect(groupingSummary({ field: 'D', kind: 'date', unit: 'quarter' })).toBe('📅 quarter');
    expect(groupingSummary({ field: 'A', kind: 'numeric', by: 10 })).toBe('# ±10');
    expect(
      groupingSummary({ field: 'R', kind: 'custom', groups: [{ label: 'X', values: ['a'] }] }),
    ).toBe('🏷 1 group');
  });
});

describe('PivotTable builder grouping UI', () => {
  it('groups a date field by quarter and carries it in the spec', () => {
    const onCreate = vi.fn();
    const el = openBuilder(onCreate);
    addFieldToArea(el, 'Date', 'R');
    addFieldToArea(el, 'Amount', 'V');
    openGroupEditor(el, 'Date');
    const select = el.querySelector('select[aria-label="Date grouping unit"]') as HTMLSelectElement | null;
    expect(select).not.toBeNull();
    setSelectValue(select!, 'quarter');
    clickButton(el, 'Apply grouping');
    // The chip now shows the grouping summary.
    const chip = el.querySelector('button[aria-label="Group Date"]');
    expect(chip?.textContent).toContain('quarter');
    clickButton(el, 'Create PivotTable');
    expect(onCreate).toHaveBeenCalledTimes(1);
    const spec = onCreate.mock.calls[0]![0] as PivotSpec;
    expect(spec.groupings).toEqual([{ field: 'Date', kind: 'date', unit: 'quarter' }]);
  });

  it('bins a numeric field by width', () => {
    const onCreate = vi.fn();
    const el = openBuilder(onCreate);
    addFieldToArea(el, 'Amount', 'R');
    addFieldToArea(el, 'Amount', 'V');
    openGroupEditor(el, 'Amount');
    const width = el.querySelector('input[type="number"]') as HTMLInputElement | null;
    expect(width).not.toBeNull();
    setInputValue(width!, '5');
    clickButton(el, 'Apply grouping');
    clickButton(el, 'Create PivotTable');
    const spec = onCreate.mock.calls[0]![0] as PivotSpec;
    expect(spec.groupings).toEqual([{ field: 'Amount', kind: 'numeric', by: 5 }]);
  });

  it('builds custom value groups', () => {
    const onCreate = vi.fn();
    const el = openBuilder(onCreate);
    addFieldToArea(el, 'Region', 'C');
    addFieldToArea(el, 'Amount', 'V');
    openGroupEditor(el, 'Region');
    const label = el.querySelector('input[aria-label="Group 1 label"]') as HTMLInputElement | null;
    const values = el.querySelector('input[aria-label="Group 1 values"]') as HTMLInputElement | null;
    expect(label).not.toBeNull();
    expect(values).not.toBeNull();
    setInputValue(label!, 'Coast');
    setInputValue(values!, 'East, West');
    clickButton(el, 'Apply grouping');
    clickButton(el, 'Create PivotTable');
    const spec = onCreate.mock.calls[0]![0] as PivotSpec;
    expect(spec.groupings).toEqual([
      { field: 'Region', kind: 'custom', groups: [{ label: 'Coast', values: ['East', 'West'] }] },
    ]);
  });

  it('omits groupings when none are configured', () => {
    const onCreate = vi.fn();
    const el = openBuilder(onCreate);
    addFieldToArea(el, 'Region', 'R');
    addFieldToArea(el, 'Amount', 'V');
    clickButton(el, 'Create PivotTable');
    const spec = onCreate.mock.calls[0]![0] as PivotSpec;
    expect(spec.groupings).toBeUndefined();
  });

  it('clearing a grouping removes it from the spec', () => {
    const onCreate = vi.fn();
    const el = openBuilder(onCreate);
    addFieldToArea(el, 'Date', 'R');
    addFieldToArea(el, 'Amount', 'V');
    openGroupEditor(el, 'Date');
    clickButton(el, 'Apply grouping');
    openGroupEditor(el, 'Date');
    clickButton(el, 'Clear');
    clickButton(el, 'Create PivotTable');
    const spec = onCreate.mock.calls[0]![0] as PivotSpec;
    expect(spec.groupings).toBeUndefined();
  });
});
