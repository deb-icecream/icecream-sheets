/**
 * #146: an agent turn reports only a sheet name observed in the current
 * workbook's sheet list; an unobserved (fallback) name reports null so
 * the service falls back to the workbook's first sheet (#135).
 */
import { describe, expect, it } from 'vitest';
import { agentSheetFor } from './agentSheet';

describe('agentSheetFor', () => {
  it('returns null when no sheet list has been observed yet (the #146 open window)', () => {
    expect(agentSheetFor('Sheet1', [])).toBeNull();
  });

  it('returns null when the derived sheet is not in the observed list (stale fallback)', () => {
    expect(agentSheetFor('Sheet1', ['FMTs', 'Cover'])).toBeNull();
  });

  it('returns the observed active sheet', () => {
    expect(agentSheetFor('FMTs', ['FMTs', 'Cover', 'Income'])).toBe('FMTs');
  });

  it('returns null for a singleton Sheet1 list: ambiguous with engine hydration, and the service resolves it to Sheet1 identically', () => {
    expect(agentSheetFor('Sheet1', ['Sheet1'])).toBeNull();
  });

  it('still reports a non-Sheet1 singleton (hydration blank is always Sheet1, never this)', () => {
    expect(agentSheetFor('FMTs', ['FMTs'])).toBe('FMTs');
  });

  it('still reports Sheet1 when it is a later observed sheet, not the first', () => {
    expect(agentSheetFor('Sheet1', ['Data', 'Sheet1'])).toBe('Sheet1');
  });

  it('still reports Sheet1 when it is the first of several observed sheets', () => {
    expect(agentSheetFor('Sheet1', ['Sheet1', 'Data'])).toBe('Sheet1');
  });
});
