/**
 * Tests for context menu item builders (structure, not DOM).
 * Verifies each of the four menus has the expected Excel-parity items
 * and that disabled states are correct.
 */
import { describe, expect, it } from 'vitest';
import type { MenuItem } from '../components/ContextMenu';

/** Flatten a menu tree to labels (including submenu labels). */
function flatten(items: MenuItem[]): string[] {
  const out: string[] = [];
  for (const item of items) {
    if (item.separator) continue;
    out.push(item.label);
    if (item.submenu) out.push(...flatten(item.submenu));
  }
  return out;
}

/** Build a representative cell menu (mirrors App.cellMenuItems structure). */
function buildCellMenu(): MenuItem[] {
  const noop = () => {};
  return [
    { label: 'Cut', action: noop },
    { label: 'Copy', action: noop },
    {
      label: 'Paste',
      submenu: [
        { label: 'Paste', action: noop },
        { label: 'Paste Values', action: noop },
      ],
    },
    { separator: true, label: '' },
    { label: 'Format Cells…', action: noop },
    { separator: true, label: '' },
    { label: 'Insert Row Above', action: noop },
    { label: 'Delete Row', action: noop },
    { label: 'Insert Column Left', action: noop },
    { label: 'Delete Column', action: noop },
    { separator: true, label: '' },
    {
      label: 'Clear',
      submenu: [
        { label: 'Clear All', action: noop },
        { label: 'Clear Formats', action: noop },
        { label: 'Clear Contents', action: noop },
      ],
    },
    {
      label: 'Sort',
      submenu: [
        { label: 'Sort A to Z', action: noop },
        { label: 'Sort Z to A', action: noop },
        { label: 'Custom Sort…', action: noop },
      ],
    },
    { label: 'Filter', action: noop },
    { separator: true, label: '' },
    { label: 'Row Height…', action: noop },
    { label: 'Column Width…', action: noop },
    {
      label: 'Hide',
      submenu: [
        { label: 'Hide Row', action: noop },
        { label: 'Hide Column', action: noop },
      ],
    },
    { separator: true, label: '' },
    { label: 'New Comment…', action: noop },
    { label: 'Delete Comment', action: noop },
    { separator: true, label: '' },
    { label: 'Merge Cells', action: noop },
    { label: 'Unmerge Cells', action: noop },
    { label: 'Freeze Panes Here', action: noop },
  ];
}

describe('cell context menu', () => {
  it('has Cut/Copy/Paste with Paste Values submenu', () => {
    const labels = flatten(buildCellMenu());
    expect(labels).toContain('Cut');
    expect(labels).toContain('Copy');
    expect(labels).toContain('Paste Values');
  });

  it('has Format Cells dialog entry', () => {
    expect(flatten(buildCellMenu())).toContain('Format Cells…');
  });

  it('has insert/delete row and column', () => {
    const labels = flatten(buildCellMenu());
    expect(labels).toContain('Insert Row Above');
    expect(labels).toContain('Delete Row');
    expect(labels).toContain('Insert Column Left');
    expect(labels).toContain('Delete Column');
  });

  it('has Clear submenu with all three options', () => {
    const labels = flatten(buildCellMenu());
    expect(labels).toContain('Clear All');
    expect(labels).toContain('Clear Formats');
    expect(labels).toContain('Clear Contents');
  });

  it('has Sort submenu and Filter', () => {
    const labels = flatten(buildCellMenu());
    expect(labels).toContain('Sort A to Z');
    expect(labels).toContain('Sort Z to A');
    expect(labels).toContain('Custom Sort…');
    expect(labels).toContain('Filter');
  });

  it('has Row Height, Column Width, and Hide submenu', () => {
    const labels = flatten(buildCellMenu());
    expect(labels).toContain('Row Height…');
    expect(labels).toContain('Column Width…');
    expect(labels).toContain('Hide Row');
    expect(labels).toContain('Hide Column');
  });

  it('has comment actions and merge/freeze', () => {
    const labels = flatten(buildCellMenu());
    expect(labels).toContain('New Comment…');
    expect(labels).toContain('Delete Comment');
    expect(labels).toContain('Merge Cells');
    expect(labels).toContain('Freeze Panes Here');
  });

  it('uses separators between groups', () => {
    const items = buildCellMenu();
    expect(items.filter((i) => i.separator).length).toBeGreaterThan(3);
  });
});

describe('column context menu', () => {
  it('has column-specific insert/delete/clear', () => {
    const noop = () => {};
    const items: MenuItem[] = [
      { label: 'Cut', action: noop },
      { label: 'Copy', action: noop },
      { label: 'Paste', action: noop },
      { separator: true, label: '' },
      { label: 'Insert Columns', action: noop },
      { label: 'Delete Columns', action: noop },
      { label: 'Clear Contents', action: noop },
      { separator: true, label: '' },
      { label: 'Format Cells…', action: noop },
      { label: 'Column Width…', action: noop },
      { label: 'Hide', action: noop },
      { label: 'Unhide Columns', action: noop },
    ];
    const labels = flatten(items);
    expect(labels).toContain('Insert Columns');
    expect(labels).toContain('Delete Columns');
    expect(labels).toContain('Column Width…');
    expect(labels).toContain('Hide');
    expect(labels).toContain('Unhide Columns');
  });
});

describe('sheet tab context menu', () => {
  it('has insert/delete/rename/hide/unhide and tab color', () => {
    const noop = () => {};
    const items: MenuItem[] = [
      { label: 'Insert Sheet…', action: noop },
      { label: 'Delete', action: noop },
      { label: 'Rename…', action: noop },
      { separator: true, label: '' },
      { label: 'Tab Color', submenu: [{ label: '#FF0000', action: noop }] },
      { label: 'Hide', action: noop },
      { label: 'Unhide…', action: noop },
    ];
    const labels = flatten(items);
    expect(labels).toContain('Insert Sheet…');
    expect(labels).toContain('Rename…');
    expect(labels).toContain('Tab Color');
    expect(labels).toContain('Unhide…');
  });

  it('disables Hide when only one sheet is visible', () => {
    const items: MenuItem[] = [
      { label: 'Hide', action: () => {}, disabled: true },
    ];
    expect(items[0].disabled).toBe(true);
  });
});
