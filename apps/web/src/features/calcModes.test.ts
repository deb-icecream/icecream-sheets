import { describe, expect, it } from 'vitest';
import {
  CALC_MODE_LABELS,
  EXTENDED_CALC_MODES,
  calculateNow,
  calculateSheet,
  shouldAutoRecalc,
  toEngineMode,
} from './calcModes';

describe('extended calculation modes', () => {
  it('lists all three modes with labels', () => {
    expect(EXTENDED_CALC_MODES).toEqual(['automatic', 'autoExceptDataTables', 'manual']);
    expect(CALC_MODE_LABELS.autoExceptDataTables).toBe('Automatic Except for Data Tables');
  });

  it('maps onto the engine modes without changing the engine', () => {
    expect(toEngineMode('automatic')).toBe('automatic');
    expect(toEngineMode('autoExceptDataTables')).toBe('automatic');
    expect(toEngineMode('manual')).toBe('manual');
  });
});

describe('shouldAutoRecalc', () => {
  it('automatic recalculates on every trigger', () => {
    expect(shouldAutoRecalc('automatic', 'cellEdit')).toBe(true);
    expect(shouldAutoRecalc('automatic', 'dataTable')).toBe(true);
    expect(shouldAutoRecalc('automatic', 'structural')).toBe(true);
  });

  it('except-data-tables skips only data-table triggers', () => {
    expect(shouldAutoRecalc('autoExceptDataTables', 'cellEdit')).toBe(true);
    expect(shouldAutoRecalc('autoExceptDataTables', 'structural')).toBe(true);
    expect(shouldAutoRecalc('autoExceptDataTables', 'dataTable')).toBe(false);
  });

  it('manual never recalculates automatically', () => {
    expect(shouldAutoRecalc('manual', 'cellEdit')).toBe(false);
    expect(shouldAutoRecalc('manual', 'dataTable')).toBe(false);
    expect(shouldAutoRecalc('manual', 'structural')).toBe(false);
  });
});

describe('calculateSheet', () => {
  it('recalculates through the host and reports workbook scope honestly', () => {
    let called = 0;
    const host = { execute: () => { called++; return { ok: true }; } };
    const res = calculateSheet(host, 'Sheet1');
    expect(called).toBe(1);
    expect(res.ok).toBe(true);
    expect(res.scope).toBe('workbook');
    expect(res.note).toContain('workbook-level');
  });

  it('reports host failures', () => {
    const host = { execute: () => ({ ok: false, error: 'denied' }) };
    const res = calculateNow(host);
    expect(res.ok).toBe(false);
    expect(res.note).toContain('denied');
  });
});
