/**
 * Unit tests for the Format-as-Table style model.
 */
import { describe, expect, it } from 'vitest';
import {
  rowFormatFor,
  TABLE_STYLES,
  tableStyleById,
  tableStyleFormats,
  tableStylesByCategory,
} from './tableStyles';

describe('TABLE_STYLES', () => {
  it('ships 24 styles across Light/Medium/Dark', () => {
    expect(TABLE_STYLES).toHaveLength(24);
    expect(tableStylesByCategory('Light')).toHaveLength(9);
    expect(tableStylesByCategory('Medium')).toHaveLength(9);
    expect(tableStylesByCategory('Dark')).toHaveLength(6);
  });

  it('has unique ids', () => {
    const ids = TABLE_STYLES.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('uses 6-digit hex colors throughout', () => {
    const hex = /^#[0-9a-fA-F]{6}$/;
    for (const s of TABLE_STYLES) {
      for (const c of [s.headerBg, s.headerColor, s.bandBg1, s.bandBg2, s.bodyColor, s.borderColor]) {
        expect(c, `${s.id} color ${c}`).toMatch(hex);
      }
    }
  });
});

describe('tableStyleById', () => {
  it('finds a style by id', () => {
    expect(tableStyleById('light-blue')?.name).toBe('Table Style Light 1');
  });

  it('returns undefined for unknown ids', () => {
    expect(tableStyleById('nope')).toBeUndefined();
  });
});

describe('rowFormatFor', () => {
  const s = tableStyleById('light-blue')!;

  it('renders the header with header colors and bold', () => {
    const f = rowFormatFor(s, 0, true);
    expect(f.fillColor).toBe(s.headerBg);
    expect(f.fontColor).toBe(s.headerColor);
    expect(f.bold).toBe(true);
  });

  it('alternates body band colors', () => {
    expect(rowFormatFor(s, 0, false).fillColor).toBe(s.bandBg1);
    expect(rowFormatFor(s, 1, false).fillColor).toBe(s.bandBg2);
    expect(rowFormatFor(s, 2, false).fillColor).toBe(s.bandBg1);
  });

  it('draws body grid borders', () => {
    const f = rowFormatFor(s, 0, false);
    expect(f.borders?.top?.color).toBe(s.borderColor);
    expect(f.borders?.bottom?.style).toBe('thin');
  });
});

describe('tableStyleFormats', () => {
  it('marks the header row and bands the body', () => {
    const s = tableStyleById('dark-gray')!;
    const rows = tableStyleFormats(s, 2, 5);
    expect(rows).toHaveLength(4);
    expect(rows[0].row).toBe(2);
    expect(rows[0].format.bold).toBe(true);
    expect(rows[1].format.fillColor).toBe(s.bandBg1);
    expect(rows[2].format.fillColor).toBe(s.bandBg2);
    expect(rows[3].format.fillColor).toBe(s.bandBg1);
  });

  it('returns an empty list when endRow precedes headerRow', () => {
    const s = tableStyleById('dark-gray')!;
    expect(tableStyleFormats(s, 5, 2)).toEqual([]);
  });
});
