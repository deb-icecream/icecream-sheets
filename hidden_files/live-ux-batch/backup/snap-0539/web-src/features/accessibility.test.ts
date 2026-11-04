import { describe, expect, it } from 'vitest';
import { checkAccessibility, contrastRatio } from './accessibility';

describe('contrastRatio', () => {
  it('computes black-on-white as 21:1', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 0);
  });
  it('computes same-color as 1:1', () => {
    expect(contrastRatio('red', 'red')).toBeCloseTo(1, 2);
  });
  it('returns null for unparseable colors', () => {
    expect(contrastRatio('notacolor', '#fff')).toBeNull();
  });
});

describe('checkAccessibility', () => {
  it('flags pictures without alt text', () => {
    const issues = checkAccessibility({
      sheetName: 'S', pictures: [{ id: 'p1', alt: '', at: 'B2' }], charts: [], mergedRanges: [], textRuns: [],
      headerRowEmpty: false, hasData: true,
    });
    expect(issues.some((i) => i.rule === 'missing-alt-text' && i.severity === 'error')).toBe(true);
  });
  it('passes pictures with alt text', () => {
    const issues = checkAccessibility({
      sheetName: 'S', pictures: [{ id: 'p1', alt: 'chart' }], charts: [], mergedRanges: [], textRuns: [],
      headerRowEmpty: false, hasData: true,
    });
    expect(issues.filter((i) => i.rule === 'missing-alt-text')).toEqual([]);
  });
  it('flags merged cells as warnings', () => {
    const issues = checkAccessibility({
      sheetName: 'S', pictures: [], charts: [], mergedRanges: ['A1:B2'], textRuns: [],
      headerRowEmpty: false, hasData: true,
    });
    expect(issues[0].rule).toBe('merged-cells');
    expect(issues[0].fix?.action).toBe('unmerge');
  });
  it('flags low-contrast text', () => {
    const issues = checkAccessibility({
      sheetName: 'S', pictures: [], charts: [], mergedRanges: [],
      textRuns: [{ cell: 'A1', color: '#cccccc', background: '#ffffff' }],
      headerRowEmpty: false, hasData: true,
    });
    expect(issues.some((i) => i.rule === 'low-contrast')).toBe(true);
  });
  it('flags empty header row when data exists', () => {
    const issues = checkAccessibility({
      sheetName: 'S', pictures: [], charts: [], mergedRanges: [], textRuns: [],
      headerRowEmpty: true, hasData: true,
    });
    expect(issues.some((i) => i.rule === 'empty-header-row')).toBe(true);
  });
  it('returns no issues for a clean sheet', () => {
    const issues = checkAccessibility({
      sheetName: 'S', pictures: [{ id: 'p1', alt: 'x' }], charts: [], mergedRanges: [],
      textRuns: [{ cell: 'A1', color: '#000000', background: '#ffffff' }],
      headerRowEmpty: false, hasData: true,
    });
    expect(issues).toEqual([]);
  });
  it('flags charts without a title', () => {
    const issues = checkAccessibility({
      sheetName: 'S', pictures: [], charts: [{ id: 'c1', title: '' }], mergedRanges: [], textRuns: [],
      headerRowEmpty: false, hasData: true,
    });
    expect(issues.some((i) => i.rule === 'missing-chart-alt' && i.severity === 'error')).toBe(true);
    expect(issues[0].fix?.action).toBe('edit-chart-title');
  });
  it('passes charts with a title', () => {
    const issues = checkAccessibility({
      sheetName: 'S', pictures: [], charts: [{ id: 'c1', title: 'Sales' }], mergedRanges: [], textRuns: [],
      headerRowEmpty: false, hasData: true,
    });
    expect(issues.filter((i) => i.rule === 'missing-chart-alt')).toEqual([]);
  });
  it('flags default sheet names as warnings without a fix', () => {
    const issues = checkAccessibility({
      sheetName: 'Sheet1', pictures: [], charts: [], mergedRanges: [], textRuns: [],
      headerRowEmpty: false, hasData: true,
    });
    const found = issues.filter((i) => i.rule === 'default-sheet-name');
    expect(found.length).toBe(1);
    expect(found[0].severity).toBe('warning');
    expect(found[0].fix).toBeUndefined();
  });
  it('does not flag descriptive sheet names', () => {
    const issues = checkAccessibility({
      sheetName: 'Budget 2024', pictures: [], charts: [], mergedRanges: [], textRuns: [],
      headerRowEmpty: false, hasData: true,
    });
    expect(issues.filter((i) => i.rule === 'default-sheet-name')).toEqual([]);
  });
});
