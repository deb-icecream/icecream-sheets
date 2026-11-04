/**
 * Unit tests for the CF rule dialog helpers (descriptions, list merging).
 */
import { describe, expect, it } from 'vitest';
import {
  describeCFRule,
  describeExtCFRule,
  mergeRuleLists,
} from './CFRuleDialogs';
import { makeCFRule } from '../features/models';
import { makeExtCFRule } from '../features/cfExtended';

const CELL = makeCFRule({
  sheet: 'Sheet1',
  startRow: 0, startCol: 0, endRow: 0, endCol: 0,
  operator: 'between',
  operands: ['1', '10'],
  color: '#ffc7ce',
});

describe('describeCFRule', () => {
  it('describes a between rule', () => {
    expect(describeCFRule(CELL)).toBe('Cell value between 1 and 10');
  });

  it('describes a greater-than rule', () => {
    const r = makeCFRule({ ...CELL, operator: 'gt', operands: ['5'] });
    expect(describeCFRule(r)).toBe('Cell value greater than 5');
  });
});

describe('describeExtCFRule', () => {
  const base = {
    sheet: 'Sheet1',
    startRow: 0, startCol: 0, endRow: 4, endCol: 0,
  };

  it('describes top/bottom/above-average rules', () => {
    expect(describeExtCFRule(makeExtCFRule({ ...base, kind: 'topN', topBottom: 'top', n: 5 }))).toBe('Top 5');
    expect(describeExtCFRule(makeExtCFRule({ ...base, kind: 'topN', topBottom: 'bottom', n: 3 }))).toBe('Bottom 3');
    expect(describeExtCFRule(makeExtCFRule({ ...base, kind: 'topN', aboveAverage: true }))).toBe('Above average');
  });

  it('describes visual rules', () => {
    expect(describeExtCFRule(makeExtCFRule({ ...base, kind: 'dataBar', color: '#638EC6' }))).toContain('Data Bar');
    expect(
      describeExtCFRule(makeExtCFRule({ ...base, kind: 'colorScale', color: '#000000', color2: '#ffffff' })),
    ).toContain('Color Scale');
    expect(describeExtCFRule(makeExtCFRule({ ...base, kind: 'iconSet', iconSet: 'arrows3' }))).toContain('Icon Set');
  });

  it('describes formula rules', () => {
    expect(describeExtCFRule(makeExtCFRule({ ...base, kind: 'formula', formula: '=A1>5' }))).toBe('Formula: =A1>5');
  });
});

describe('mergeRuleLists', () => {
  it('puts cell rules before extended rules with stable keys', () => {
    const ext = makeExtCFRule({
      sheet: 'Sheet1', startRow: 0, startCol: 0, endRow: 0, endCol: 0,
      kind: 'dataBar', color: '#638EC6',
    });
    const items = mergeRuleLists([CELL], [ext]);
    expect(items).toHaveLength(2);
    expect(items[0].isCell).toBe(true);
    expect(items[1].isCell).toBe(false);
    expect(items[0].key).toBe(`cell-${CELL.id}`);
    expect(items[1].key).toBe(`ext-${ext.id}`);
    expect(items[0].range).toBe('$A1');
  });

  it('renders multi-cell ranges', () => {
    const ext = makeExtCFRule({
      sheet: 'Sheet1', startRow: 0, startCol: 0, endRow: 9, endCol: 2,
      kind: 'iconSet', iconSet: 'arrows3',
    });
    const items = mergeRuleLists([], [ext]);
    expect(items[0].range).toBe('$A1:$C10');
  });

  it('returns an empty list for no rules', () => {
    expect(mergeRuleLists([], [])).toEqual([]);
  });
});
