/**
 * Headless tests for the web UI's engine helpers (no React rendering).
 * Run with: npm test --workspace @icecream-sheets/web
 */
import { describe, expect, it } from 'vitest';
import {
  a1Short,
  colLabel,
  formatDisplay,
  parseEdit,
} from './engine';
import { err, image, scalar } from '@icecream-sheets/engine';

describe('formatDisplay', () => {
  it('renders numbers as-is', () => {
    expect(formatDisplay(scalar(42))).toBe('42');
    expect(formatDisplay(scalar(3.14))).toBe('3.14');
    expect(formatDisplay(scalar(-0.5))).toBe('-0.5');
  });

  it('renders numbers with Excel General precision (~10 significant digits)', () => {
    // Raw float noise is not what Excel shows.
    expect(formatDisplay(scalar(2082088.1744066))).toBe('2082088.174');
    expect(formatDisplay(scalar(0.1 + 0.2))).toBe('0.3');
    expect(formatDisplay(scalar(12345678901234))).toBe('1.23457E+13');
  });

  it('renders strings verbatim', () => {
    expect(formatDisplay(scalar('hello'))).toBe('hello');
    expect(formatDisplay(scalar(''))).toBe('');
  });

  it('renders booleans Excel-style', () => {
    expect(formatDisplay(scalar(true))).toBe('TRUE');
    expect(formatDisplay(scalar(false))).toBe('FALSE');
  });

  it('renders null as empty string', () => {
    expect(formatDisplay(scalar(null))).toBe('');
  });

  it('renders errors as their code', () => {
    expect(formatDisplay(err('#DIV/0!'))).toBe('#DIV/0!');
    expect(formatDisplay(err('#NAME?', 'unknown fn'))).toBe('#NAME?');
    expect(formatDisplay(err('#REF!'))).toBe('#REF!');
  });

  it('renders in-cell images as their alt text', () => {
    expect(formatDisplay(image('https://example.com/a.png', 'A picture'))).toBe('A picture');
    expect(formatDisplay(image('https://example.com/a.png'))).toBe('');
  });
});

describe('parseEdit', () => {
  it('treats leading = as a formula', () => {
    expect(parseEdit('=SUM(A1:A2)')).toEqual({ kind: 'formula', formula: '=SUM(A1:A2)' });
    expect(parseEdit('=5')).toEqual({ kind: 'formula', formula: '=5' });
  });

  it('coerces numeric text to numbers', () => {
    expect(parseEdit('42')).toEqual({ kind: 'value', value: 42 });
    expect(parseEdit('3.14')).toEqual({ kind: 'value', value: 3.14 });
    expect(parseEdit('-2e3')).toEqual({ kind: 'value', value: -2000 });
    expect(parseEdit('  7  ')).toEqual({ kind: 'value', value: 7 });
  });

  it('keeps non-numeric text as strings', () => {
    expect(parseEdit('hello')).toEqual({ kind: 'value', value: 'hello' });
    expect(parseEdit('1a')).toEqual({ kind: 'value', value: '1a' });
    expect(parseEdit('= not really')).toEqual({ kind: 'formula', formula: '= not really' });
  });

  it('coerces true/false (case-insensitive) to booleans', () => {
    expect(parseEdit('true')).toEqual({ kind: 'value', value: true });
    expect(parseEdit('FALSE')).toEqual({ kind: 'value', value: false });
  });

  it('maps empty input to null (clears the cell)', () => {
    expect(parseEdit('')).toEqual({ kind: 'value', value: null });
    expect(parseEdit('   ')).toEqual({ kind: 'value', value: null });
  });
});

describe('addressing helpers', () => {
  it('labels columns A..Z', () => {
    expect(colLabel(0)).toBe('A');
    expect(colLabel(25)).toBe('Z');
  });

  it('builds short A1 addresses', () => {
    expect(a1Short(0, 0)).toBe('A1');
    expect(a1Short(9, 1)).toBe('B10');
    expect(a1Short(99, 25)).toBe('Z100');
  });
});

describe('IMAGE end-to-end through EngineWorkbook', () => {
  it('evaluates =IMAGE to a typed image value via the value cache', async () => {
    const { EngineWorkbook } = await import('@icecream-sheets/engine');
    const wb = new EngineWorkbook();
    wb.setFormula({ sheet: 'Sheet1', row: 0, col: 0 }, '=IMAGE("https://example.com/a.png", "Alt", 3, 120, 80)');
    expect(wb.getValue({ sheet: 'Sheet1', row: 0, col: 0 })).toEqual(
      image('https://example.com/a.png', 'Alt', 3, 120, 80),
    );
  });
});
