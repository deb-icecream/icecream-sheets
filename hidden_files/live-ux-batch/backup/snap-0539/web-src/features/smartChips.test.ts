/**
 * Tests for smart chips (features/smartChips.ts): dataset lookups,
 * card props, chip syntax parsing, and kind helpers.
 */
import { describe, expect, it } from 'vitest';
import {
  resolvePerson,
  resolveFile,
  resolveCalendarEvent,
  resolveFinance,
  resolveRating,
  resolveSmartChip,
  parseChipFormula,
  chipEmoji,
  chipKindLabel,
  chipOptions,
  isSmartChipKind,
  smartChipCellKey,
  personNames,
  fileNames,
  eventTitles,
  financeNames,
} from './smartChips';

describe('datasets', () => {
  it('has 8 people', () => {
    expect(personNames()).toHaveLength(8);
    expect(personNames()).toContain('Ada Lovelace');
  });
  it('has 6 files', () => {
    expect(fileNames()).toHaveLength(6);
    expect(fileNames()).toContain('budget-2026.xlsx');
  });
  it('has 6 calendar events', () => {
    expect(eventTitles()).toHaveLength(6);
    expect(eventTitles()).toContain('Sprint Planning');
  });
  it('has 5 finance metrics', () => {
    expect(financeNames()).toHaveLength(5);
    expect(financeNames()).toContain('Revenue (Q3)');
  });
});

describe('resolvers', () => {
  it('resolvePerson returns a card-ready chip', () => {
    const v = resolvePerson('Ada Lovelace');
    expect(v).not.toBeNull();
    expect(v!.kind).toBe('person');
    expect(v!.emoji).toBe('🧑');
    expect(v!.display).toBe('Ada Lovelace');
    const labels = v!.fields.map((f) => f.label);
    expect(labels).toEqual(['Name', 'Email', 'Title', 'Department']);
    expect(v!.fields.find((f) => f.label === 'Email')!.value).toBe('ada@example.com');
  });

  it('resolvePerson is case-insensitive and trims', () => {
    expect(resolvePerson('  ada lovelace ')).not.toBeNull();
  });

  it('resolvePerson returns null for unknown names', () => {
    expect(resolvePerson('Nobody Here')).toBeNull();
  });

  it('resolveFile returns type/size/modified fields', () => {
    const v = resolveFile('budget-2026.xlsx');
    expect(v!.kind).toBe('file');
    expect(v!.fields.find((f) => f.label === 'Size')!.value).toBe('812 KB');
  });

  it('resolveCalendarEvent returns when/attendees fields', () => {
    const v = resolveCalendarEvent('Sprint Planning');
    expect(v!.kind).toBe('calendar');
    expect(v!.emoji).toBe('📅');
    expect(v!.fields.find((f) => f.label === 'Attendees')!.value).toBe('Ada, Grace, Alan');
  });

  it('resolveFinance returns value/currency/change fields', () => {
    const v = resolveFinance('ARR');
    expect(v!.kind).toBe('finance');
    expect(v!.fields.find((f) => f.label === 'Value')!.value).toBe('5,140,000 USD');
  });

  it('resolveRating builds 1–5 star chips, rejects out-of-range', () => {
    const v = resolveRating(4);
    expect(v!.kind).toBe('rating');
    expect(v!.display).toBe('★★★★☆');
    expect(v!.fields.find((f) => f.label === 'Percent')!.value).toBe('80%');
    expect(resolveRating('3')).not.toBeNull();
    expect(resolveRating(0)).toBeNull();
    expect(resolveRating(6)).toBeNull();
    expect(resolveRating(2.5)).toBeNull();
    expect(resolveRating('abc')).toBeNull();
  });

  it('resolveSmartChip dispatches on kind', () => {
    expect(resolveSmartChip('person', 'Grace Hopper')!.kind).toBe('person');
    expect(resolveSmartChip('file', 'api-spec.yaml')!.kind).toBe('file');
    expect(resolveSmartChip('calendar', 'Hack Day')!.kind).toBe('calendar');
    expect(resolveSmartChip('finance', 'ARR')!.kind).toBe('finance');
    expect(resolveSmartChip('rating', '5')!.kind).toBe('rating');
    expect(resolveSmartChip('person', 'Nobody')).toBeNull();
  });
});

describe('helpers', () => {
  it('chipEmoji / chipKindLabel cover every kind', () => {
    for (const k of ['person', 'file', 'calendar', 'finance', 'rating'] as const) {
      expect(chipEmoji(k).length).toBeGreaterThan(0);
      expect(chipKindLabel(k).length).toBeGreaterThan(0);
    }
    expect(chipEmoji('person')).toBe('🧑');
    expect(chipEmoji('rating')).toBe('⭐');
  });

  it('isSmartChipKind validates', () => {
    expect(isSmartChipKind('person')).toBe(true);
    expect(isSmartChipKind('stock')).toBe(false);
  });

  it('chipOptions lists insertable keys per kind', () => {
    expect(chipOptions('person')).toHaveLength(8);
    expect(chipOptions('rating')).toEqual(['1', '2', '3', '4', '5']);
  });

  it('smartChipCellKey mirrors the data-type key format', () => {
    expect(smartChipCellKey('Sheet1', 2, 3)).toBe('Sheet1:2:3');
  });
});

describe('parseChipFormula', () => {
  it('parses =CHIP("person","Ada Lovelace")', () => {
    expect(parseChipFormula('=CHIP("person","Ada Lovelace")')).toEqual({
      kind: 'person',
      key: 'Ada Lovelace',
    });
  });

  it('is case-insensitive and tolerates spacing', () => {
    expect(parseChipFormula('=chip( "file" , "budget-2026.xlsx" )')).toEqual({
      kind: 'file',
      key: 'budget-2026.xlsx',
    });
  });

  it('parses numeric keys for ratings', () => {
    expect(parseChipFormula('=CHIP("rating",4)')).toEqual({ kind: 'rating', key: '4' });
  });

  it('rejects unknown kinds and non-chip text', () => {
    expect(parseChipFormula('=CHIP("stock","AAPL")')).toBeNull();
    expect(parseChipFormula('=SUM(A1:A2)')).toBeNull();
    expect(parseChipFormula('Ada Lovelace')).toBeNull();
  });
});
