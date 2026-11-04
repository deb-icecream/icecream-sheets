import { describe, expect, it } from 'vitest';
import {
  formatRichValueScalar,
  inferRichValueKind,
  isRichValueDisplayInput,
  normalizeRichValueFieldName,
  richValueDetailLines,
  richValueField,
  richValueFields,
  richValueLabel,
  richValueCellKey,
  type RichValueDisplayInput,
} from './richValues';

const STOCK: RichValueDisplayInput = {
  typeName: '_Stock',
  fallback: 'MSFT',
  fields: [
    { key: '_Self', type: 's', value: 'MSFT', rawText: 'MSFT' },
    { key: 'Name', type: 's', value: 'Microsoft Corporation', rawText: 'Microsoft Corporation' },
    { key: 'Price', type: 'd', value: 428.15, rawText: '428.15' },
    { key: 'Change', type: 'd', value: -2.31, rawText: '-2.31' },
    { key: 'Is Active', type: 'b', value: true, rawText: '1' },
  ],
};

describe('richValues display helper', () => {
  it('labels a rich value from display, else fallback, else the first field', () => {
    expect(richValueLabel(STOCK)).toBe('MSFT');
    expect(richValueLabel({ fields: STOCK.fields })).toBe('MSFT');
    expect(richValueLabel({ fields: [], fallback: 'London' })).toBe('London');
    expect(richValueLabel({ fields: [] })).toBe('');
    expect(richValueLabel({ ...STOCK, display: 'Microsoft' })).toBe('Microsoft');
  });

  it('looks fields up case- and separator-insensitively, like the engine', () => {
    expect(richValueField(STOCK, 'Price')).toBe(428.15);
    expect(richValueField(STOCK, 'price')).toBe(428.15);
    expect(richValueField(STOCK, 'PRICE')).toBe(428.15);
    expect(richValueField(STOCK, 'is_active')).toBe(true);
    expect(richValueField(STOCK, 'IsActive')).toBe(true);
    expect(richValueField(STOCK, 'Nope')).toBeNull();
  });

  it('formats scalars Excel-style and renders detail lines in order', () => {
    expect(formatRichValueScalar(true)).toBe('TRUE');
    expect(formatRichValueScalar(false)).toBe('FALSE');
    expect(formatRichValueScalar(428.15)).toBe('428.15');
    expect(richValueFields(STOCK)[2]).toEqual({ label: 'Price', value: '428.15' });
    expect(richValueDetailLines(STOCK)).toEqual([
      '_Self: MSFT',
      'Name: Microsoft Corporation',
      'Price: 428.15',
      'Change: -2.31',
      'Is Active: TRUE',
    ]);
  });

  it('infers stock/geography kinds and rejects anything else', () => {
    expect(inferRichValueKind('_Stock')).toBe('stock');
    expect(inferRichValueKind('STOCK')).toBe('stock');
    expect(inferRichValueKind('_Geography')).toBe('geography');
    expect(inferRichValueKind('geography')).toBe('geography');
    expect(inferRichValueKind('XLRICHVALUE')).toBeNull();
    expect(inferRichValueKind(undefined)).toBeNull();
    expect(normalizeRichValueFieldName('Market Cap')).toBe('marketcap');
  });

  it('maps A1 refs to grid keys (multi-letter columns, 0-based)', () => {
    expect(richValueCellKey('Data', 'A1')).toBe('Data:0:0');
    expect(richValueCellKey('Data', 'AA10')).toBe('Data:9:26');
    expect(richValueCellKey('Data', 'XFD1048576')).toBe('Data:1048575:16383');
    expect(richValueCellKey('Data', 'A0')).toBeNull();
    expect(richValueCellKey('Data', 'not-a-ref')).toBeNull();
    expect(richValueCellKey('Data', '')).toBeNull();
  });

  it('guards unknown values', () => {
    expect(isRichValueDisplayInput(STOCK)).toBe(true);
    expect(isRichValueDisplayInput({ fields: 'nope' })).toBe(false);
    expect(isRichValueDisplayInput(null)).toBe(false);
  });
});
