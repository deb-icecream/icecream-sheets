import { describe, expect, it } from 'vitest';
import {
  computeOneVarTable,
  computeTwoVarTable,
  goalSeek,
  solve,
  type SolverEvaluator,
  type SolverSpec,
} from '../src/index.js';

/** Evaluator over a plain JS model: objective = -(x-3)^2 - (y-2)^2 (max at (3,2)). */
function quadModel(): { spec: SolverSpec; evaluate: SolverEvaluator; initial: Record<string, number> } {
  const spec: SolverSpec = {
    version: 1,
    objectiveCell: 'C1',
    objective: 'max',
    variableCells: ['A1', 'B1'],
    constraints: [],
  };
  const evaluate: SolverEvaluator = (vars) => {
    const x = vars['A1'] ?? 0;
    const y = vars['B1'] ?? 0;
    return { objective: -((x - 3) ** 2 + (y - 2) ** 2), constraintValues: [] };
  };
  return { spec, evaluate, initial: { A1: 0, B1: 0 } };
}

describe('solve', () => {
  it('maximizes a concave quadratic', () => {
    const { spec, evaluate, initial } = quadModel();
    const r = solve(spec, initial, evaluate);
    expect(r.converged).toBe(true);
    expect(r.values['A1']).toBeCloseTo(3, 3);
    expect(r.values['B1']).toBeCloseTo(2, 3);
    expect(r.objectiveValue).toBeCloseTo(0, 4);
  });

  it('minimizes a convex quadratic', () => {
    const spec: SolverSpec = {
      version: 1,
      objectiveCell: 'C1',
      objective: 'min',
      variableCells: ['A1'],
      constraints: [],
    };
    const r = solve(spec, { A1: 10 }, (vars) => {
      const x = vars['A1'] ?? 0;
      return { objective: (x - 5) ** 2, constraintValues: [] };
    });
    expect(r.values['A1']).toBeCloseTo(5, 3);
  });

  it('respects <= constraints via penalty', () => {
    // max x s.t. x <= 4, x >= 0 -> x = 4
    const spec: SolverSpec = {
      version: 1,
      objectiveCell: 'C1',
      objective: 'max',
      variableCells: ['A1'],
      constraints: [
        { cell: 'D1', op: '<=', rhs: 4 },
        { cell: 'A1', op: '>=', rhs: 0 },
      ],
    };
    const r = solve(
      spec,
      { A1: 0 },
      (vars) => {
        const x = vars['A1'] ?? 0;
        return { objective: x, constraintValues: [x, x] };
      },
      { penalty: 1e6 },
    );
    expect(r.values['A1']).toBeCloseTo(4, 1);
    expect(r.maxViolation).toBeLessThan(0.05);
  });

  it('respects >= constraints', () => {
    // min x s.t. x >= 7 -> x = 7
    const spec: SolverSpec = {
      version: 1,
      objectiveCell: 'C1',
      objective: 'min',
      variableCells: ['A1'],
      constraints: [{ cell: 'D1', op: '>=', rhs: 7 }],
    };
    const r = solve(
      spec,
      { A1: 0 },
      (vars) => {
        const x = vars['A1'] ?? 0;
        return { objective: x, constraintValues: [x] };
      },
      { penalty: 1e6 },
    );
    expect(r.values['A1']).toBeCloseTo(7, 1);
  });

  it('solves a bounded linear program at the corner', () => {
    // max 2x+y s.t. x+y<=10, x>=0, y>=0 -> (10, 0), objective 20
    const spec: SolverSpec = {
      version: 1,
      objectiveCell: 'C1',
      objective: 'max',
      variableCells: ['A1', 'B1'],
      constraints: [
        { cell: 'D1', op: '<=', rhs: 10 },
        { cell: 'A1', op: '>=', rhs: 0 },
        { cell: 'B1', op: '>=', rhs: 0 },
      ],
    };
    const r = solve(
      spec,
      { A1: 5, B1: 3 },
      (vars) => {
        const x = vars['A1'] ?? 0;
        const y = vars['B1'] ?? 0;
        return { objective: 2 * x + y, constraintValues: [x + y, x, y] };
      },
      { penalty: 1e6 },
    );
    expect(r.values['A1']).toBeCloseTo(10, 0);
    expect(r.values['B1']).toBeCloseTo(0, 0);
    expect(r.objectiveValue).toBeCloseTo(20, 0);
    expect(r.maxViolation).toBeLessThan(0.01);
  });

  it('solves for a target value', () => {
    const spec: SolverSpec = {
      version: 1,
      objectiveCell: 'C1',
      objective: 'value',
      targetValue: 42,
      variableCells: ['A1'],
      constraints: [],
    };
    const r = solve(spec, { A1: 0 }, (vars) => {
      const x = vars['A1'] ?? 0;
      return { objective: x * 2, constraintValues: [] };
    });
    expect(r.values['A1']).toBeCloseTo(21, 2);
  });

  it('handles integer constraints', () => {
    const spec: SolverSpec = {
      version: 1,
      objectiveCell: 'C1',
      objective: 'max',
      variableCells: ['A1'],
      constraints: [
        { cell: 'A1', op: 'int', rhs: 0 },
        { cell: 'D1', op: '<=', rhs: 4.7 },
      ],
    };
    const r = solve(
      spec,
      { A1: 0 },
      (vars) => {
        const x = vars['A1'] ?? 0;
        return { objective: x, constraintValues: [x, x] };
      },
      { penalty: 1e6 },
    );
    expect(Number.isInteger(r.values['A1']!)).toBe(true);
    expect(r.values['A1']).toBeLessThanOrEqual(4);
  });

  it('handles binary constraints', () => {
    const spec: SolverSpec = {
      version: 1,
      objectiveCell: 'C1',
      objective: 'max',
      variableCells: ['A1', 'B1'],
      constraints: [
        { cell: 'A1', op: 'bin', rhs: 0 },
        { cell: 'B1', op: 'bin', rhs: 0 },
      ],
    };
    const r = solve(spec, { A1: 0.2, B1: 0.8 }, (vars) => {
      const x = vars['A1'] ?? 0;
      const y = vars['B1'] ?? 0;
      return { objective: 3 * x + 5 * y, constraintValues: [] };
    });
    expect([0, 1]).toContain(r.values['A1']);
    expect([0, 1]).toContain(r.values['B1']);
  });

  it('reports non-convergence gracefully on a pathological objective', () => {
    const spec: SolverSpec = {
      version: 1,
      objectiveCell: 'C1',
      objective: 'max',
      variableCells: ['A1'],
      constraints: [],
    };
    const r = solve(
      spec,
      { A1: 0 },
      () => ({ objective: NaN, constraintValues: [] }),
      { maxIterations: 5 },
    );
    expect(r.converged).toBe(false);
    expect(r.message).toContain('without full convergence');
  });
});

describe('goalSeek', () => {
  it('finds x with f(x) = target (linear)', () => {
    const r = goalSeek((x) => 2 * x + 1, 11, 0);
    expect(r.converged).toBe(true);
    expect(r.value).toBeCloseTo(5, 6);
  });

  it('solves a quadratic (positive root)', () => {
    const r = goalSeek((x) => x * x, 16, 1);
    expect(r.converged).toBe(true);
    expect(r.value).toBeCloseTo(4, 5);
  });

  it('returns immediately when the guess already works', () => {
    const r = goalSeek((x) => x * 3, 9, 3);
    expect(r.converged).toBe(true);
    expect(r.iterations).toBe(0);
  });

  it('fails gracefully when the function errors', () => {
    const r = goalSeek(() => NaN, 5, 0, { maxIterations: 10 });
    expect(r.converged).toBe(false);
  });
});

describe('data tables', () => {
  it('computes a one-variable table', () => {
    const rows = computeOneVarTable(
      { inputCell: 'A1', formulaCells: ['B1', 'C1'], values: [1, 2, 3] },
      (inputs) => {
        const x = inputs['A1'] ?? 0;
        return { B1: x * 2, C1: x * x };
      },
    );
    expect(rows).toEqual([
      [1, 2, 1],
      [2, 4, 4],
      [3, 6, 9],
    ]);
  });

  it('one-variable table tolerates evaluator errors', () => {
    const rows = computeOneVarTable(
      { inputCell: 'A1', formulaCells: ['B1'], values: [1, 2] },
      () => {
        throw new Error('boom');
      },
    );
    expect(rows[0]![1]).toBeNaN();
  });

  it('computes a two-variable table', () => {
    const tables = computeTwoVarTable(
      {
        rowInputCell: 'A1',
        colInputCell: 'B1',
        formulaCells: ['C1'],
        rowValues: [10, 20],
        colValues: [1, 2],
      },
      (inputs) => ({ C1: (inputs['A1'] ?? 0) + (inputs['B1'] ?? 0) }),
    );
    expect(tables).toHaveLength(1);
    const t = tables[0]!;
    expect(t[0]).toEqual([NaN, 10, 20]); // header
    expect(t[1]).toEqual([1, 11, 21]);
    expect(t[2]).toEqual([2, 12, 22]);
  });
});
