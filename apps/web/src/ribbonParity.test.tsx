/**
 * Smoke tests for the Excel Classic ribbon parity integration (ribbonParity.tsx).
 * The hook itself is integration glue verified by TypeScript (RibbonProps requires
 * every handler); these tests verify the module loads and the feature functions
 * it wires are functional.
 */
import { describe, expect, it } from 'vitest';
import { useRibbonParity } from './ribbonParity';
import { increaseDecimals, decreaseDecimals } from './features/decimals';
import { getRecentFunctions } from './features/recentFunctions';

describe('ribbonParity module', () => {
  it('exports the useRibbonParity hook', () => {
    expect(typeof useRibbonParity).toBe('function');
  });

  it('wires working decimal handlers (decimals feature)', () => {
    const up = increaseDecimals(undefined);
    expect(up.decimals).toBeGreaterThanOrEqual(0);
    const down = decreaseDecimals({ decimals: 3 } as never);
    expect(down.decimals).toBe(2);
  });

  it('wires the recent-functions feature', () => {
    expect(Array.isArray(getRecentFunctions())).toBe(true);
  });
});
