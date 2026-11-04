import { describe, it, expect } from 'vitest';
import { rewriteOffsetLiterals } from '../src/offset.js';

describe('rewriteOffsetLiterals', () => {
  const getCell = (row: number, col: number): unknown => {
    // E9 (row 8, col 4) = 1, E10 (row 9, col 4) = 2
    if (row === 8 && col === 4) return 1;
    if (row === 9 && col === 4) return 2;
    return null;
  };

  it('rewrites OFFSET with cell-ref rows arg to literal', () => {
    expect(rewriteOffsetLiterals('=OFFSET(N43,$E$9,0)', getCell)).toBe('=OFFSET(N43,1,0)');
  });

  it('rewrites both args when both are cell refs', () => {
    expect(rewriteOffsetLiterals('=OFFSET(A1,$E$9,$E$10)', getCell)).toBe('=OFFSET(A1,1,2)');
  });

  it('leaves OFFSET with literal args unchanged', () => {
    expect(rewriteOffsetLiterals('=OFFSET(A1,1,0)', getCell)).toBe('=OFFSET(A1,1,0)');
  });

  it('leaves OFFSET unchanged when ref cell is not a numeric literal', () => {
    expect(rewriteOffsetLiterals('=OFFSET(A1,$Z$99,0)', getCell)).toBe('=OFFSET(A1,$Z$99,0)');
  });

  it('leaves non-OFFSET formulas unchanged', () => {
    expect(rewriteOffsetLiterals('=SUM(A1:A10)', getCell)).toBe('=SUM(A1:A10)');
  });
});
