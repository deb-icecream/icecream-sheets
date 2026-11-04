/**
 * Tests: ETL-backed report bindings (design-docs/native-reports-and-dashboards.md §6).
 *
 * - `migrateBinding` preserves a valid etlRecipeId and drops empty/invalid ones.
 * - `validateReportSpec` rejects a malformed etlRecipeId.
 * - `collectEtlRecipeIds` dedupes and preserves first-use order.
 * - `refreshReportEtlBindings` runs each distinct recipe once through the
 *   injected port, keeps going after a rejection, and reports skips when no
 *   port is supplied.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  collectEtlRecipeIds,
  makeReportSpec,
  migrateBinding,
  refreshReportEtlBindings,
  validateReportSpec,
  type EtlRefreshPort,
  type ReportBinding,
  type ReportSpec,
  type RunRecord,
} from '../src/index.js';

function baseBinding(over: Partial<ReportBinding> = {}): ReportBinding {
  return {
    id: 'b1',
    name: 'Sales',
    sheet: 'Sheet1',
    startRow: 0,
    startCol: 0,
    endRow: 5,
    endCol: 3,
    headerRow: 0,
    fields: ['Region', 'Quarter', 'Sales', 'Units'],
    ...over,
  };
}

function specWith(bindings: ReportBinding[]): ReportSpec {
  return makeReportSpec({ name: 'R', bindings, visuals: [] });
}

function runRecord(recipeId: string, status: RunRecord['status'] = 'succeeded'): RunRecord {
  return {
    id: 'run_1',
    recipeId,
    recipeName: recipeId,
    startedAt: new Date(0).toISOString(),
    finishedAt: new Date(0).toISOString(),
    status,
    steps: [],
    rowsLoaded: 10,
    quarantined: [],
  };
}

describe('migrateBinding etlRecipeId', () => {
  it('preserves a valid recipe id (trimmed)', () => {
    const b = migrateBinding({ ...baseBinding(), etlRecipeId: '  recipe-9 ' });
    expect(b.etlRecipeId).toBe('recipe-9');
  });

  it('drops empty, blank, and non-string values', () => {
    expect(migrateBinding({ ...baseBinding(), etlRecipeId: '' }).etlRecipeId).toBeUndefined();
    expect(migrateBinding({ ...baseBinding(), etlRecipeId: '   ' }).etlRecipeId).toBeUndefined();
    expect(
      migrateBinding({ ...baseBinding(), etlRecipeId: 42 as unknown as string }).etlRecipeId,
    ).toBeUndefined();
  });

  it('leaves plain bindings untouched (key absent)', () => {
    const b = migrateBinding(baseBinding());
    expect('etlRecipeId' in b).toBe(false);
  });
});

describe('validateReportSpec etlRecipeId', () => {
  it('accepts a valid recipe id and an absent one', () => {
    expect(validateReportSpec(specWith([baseBinding({ etlRecipeId: 'r1' })]))).toEqual([]);
    expect(validateReportSpec(specWith([baseBinding()]))).toEqual([]);
  });

  it('rejects a non-string or blank recipe id', () => {
    const bad = specWith([baseBinding()]);
    (bad.bindings[0] as { etlRecipeId?: unknown }).etlRecipeId = 7;
    expect(validateReportSpec(bad).join(' ')).toContain('etlRecipeId');
    const blank = specWith([baseBinding()]);
    blank.bindings[0].etlRecipeId = '  ';
    expect(validateReportSpec(blank).join(' ')).toContain('etlRecipeId');
  });
});

describe('collectEtlRecipeIds', () => {
  it('returns distinct ids in first-use order, ignoring plain bindings', () => {
    const spec = specWith([
      baseBinding({ id: 'a', etlRecipeId: 'r1' }),
      baseBinding({ id: 'b' }),
      baseBinding({ id: 'c', etlRecipeId: 'r2' }),
      baseBinding({ id: 'd', etlRecipeId: 'r1' }),
    ]);
    expect(collectEtlRecipeIds(spec)).toEqual(['r1', 'r2']);
  });

  it('returns [] when no binding is ETL-backed', () => {
    expect(collectEtlRecipeIds(specWith([baseBinding()]))).toEqual([]);
  });
});

describe('refreshReportEtlBindings', () => {
  it('runs each distinct recipe once, in binding order', async () => {
    const spec = specWith([
      baseBinding({ id: 'a', etlRecipeId: 'r1' }),
      baseBinding({ id: 'b', etlRecipeId: 'r2' }),
      baseBinding({ id: 'c', etlRecipeId: 'r1' }),
    ]);
    const seen: string[] = [];
    const port: EtlRefreshPort = {
      runEtlRecipe: vi.fn(async (id: string) => {
        seen.push(id);
        return runRecord(id);
      }),
    };
    const summary = await refreshReportEtlBindings(spec, port);
    expect(seen).toEqual(['r1', 'r2']);
    expect(port.runEtlRecipe).toHaveBeenCalledTimes(2);
    expect(summary.completed.map((c) => c.recipeId)).toEqual(['r1', 'r2']);
    expect(summary.thrown).toEqual([]);
    expect(summary.skipped).toEqual([]);
  });

  it('keeps going after one recipe rejects and reports it', async () => {
    const spec = specWith([
      baseBinding({ id: 'a', etlRecipeId: 'r1' }),
      baseBinding({ id: 'b', etlRecipeId: 'r2' }),
    ]);
    const port: EtlRefreshPort = {
      runEtlRecipe: async (id: string) => {
        if (id === 'r1') throw new Error('recipe not found');
        return runRecord(id);
      },
    };
    const summary = await refreshReportEtlBindings(spec, port);
    expect(summary.completed.map((c) => c.recipeId)).toEqual(['r2']);
    expect(summary.thrown).toEqual([{ recipeId: 'r1', error: 'recipe not found' }]);
  });

  it('records non-succeeded run statuses in completed (runner resolved)', async () => {
    const spec = specWith([baseBinding({ etlRecipeId: 'r1' })]);
    const summary = await refreshReportEtlBindings(spec, {
      runEtlRecipe: async (id) => ({ ...runRecord(id, 'failed'), error: 'load blew up' }),
    });
    expect(summary.completed).toHaveLength(1);
    expect(summary.completed[0].run.status).toBe('failed');
    expect(summary.thrown).toEqual([]);
  });

  it('skips everything when no port is supplied', async () => {
    const spec = specWith([
      baseBinding({ id: 'a', etlRecipeId: 'r1' }),
      baseBinding({ id: 'b', etlRecipeId: 'r2' }),
    ]);
    const summary = await refreshReportEtlBindings(spec, undefined);
    expect(summary).toEqual({ completed: [], thrown: [], skipped: ['r1', 'r2'] });
  });

  it('is a no-op for reports without ETL-backed bindings', async () => {
    const port: EtlRefreshPort = { runEtlRecipe: vi.fn(async (id) => runRecord(id)) };
    const summary = await refreshReportEtlBindings(specWith([baseBinding()]), port);
    expect(summary).toEqual({ completed: [], thrown: [], skipped: [] });
    expect(port.runEtlRecipe).not.toHaveBeenCalled();
  });
});
