// @vitest-environment jsdom
/**
 * ReportViewerDialog ETL refresh tests (design-docs/native-reports-and-dashboards.md §6).
 *
 * - Refresh runs each distinct ETL recipe referenced by the spec's bindings
 *   through the host `runEtlBindings` port before recomputing.
 * - A report with no ETL-backed bindings never touches the port.
 * - The updated spec (with the new data timestamp) is delivered via onUpdate.
 */
import { describe, expect, it, vi, afterEach } from 'vitest';
import { createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { ReportViewerDialog, type EtlBindingRefreshResult } from './Reports';
import {
  makeReportSpec,
  type ReportBinding,
  type ReportSpec,
  type RunRecord,
} from '@icecream-sheets/service';

let container: HTMLDivElement | null = null;
let root: ReturnType<typeof createRoot> | null = null;

function setup(ui: React.ReactElement) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(ui);
  });
  return container;
}

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  container?.remove();
  container = null;
  root = null;
  document.body.innerHTML = '';
});

const binding: ReportBinding = {
  id: 'b1',
  name: 'Sales',
  sheet: 'Sheet1',
  startRow: 0,
  startCol: 0,
  endRow: 5,
  endCol: 2,
  headerRow: 0,
  fields: ['Region', 'Sales', 'Units'],
  calculatedFields: [],
  etlRecipeId: 'recipe-1',
};

function specWith(bindings: ReportBinding[]): ReportSpec {
  return makeReportSpec({
    name: 'ETL Report',
    bindings,
    visuals: [
      { id: 'v1', title: 'Sales table', bindingId: bindings[0].id, kind: 'table', fields: ['Region'], maxRows: 10 },
    ],
    refresh: { mode: 'manual', schedule: null },
  });
}

function okRun(recipeId: string): RunRecord {
  return {
    id: 'run_1',
    recipeId,
    recipeName: 'Pipeline 1',
    startedAt: new Date(0).toISOString(),
    finishedAt: new Date(0).toISOString(),
    status: 'succeeded',
    steps: [],
    rowsLoaded: 5,
    quarantined: [],
  };
}

function renderViewer(
  spec: ReportSpec,
  runEtlBindings?: (recipeId: string, bindings: ReportBinding[]) => Promise<EtlBindingRefreshResult>,
) {
  const onUpdate = vi.fn();
  setup(
    h(ReportViewerDialog, {
      spec,
      readBinding: () => [],
      readChartCell: () => ({ text: '', num: null }),
      onUpdate,
      onEdit: () => {},
      onClose: () => {},
      runEtlBindings,
    }),
  );
  return { onUpdate };
}

function refreshButton(): HTMLButtonElement {
  const btn = [...document.querySelectorAll('button')].find((b) =>
    b.textContent?.includes('Refresh'),
  );
  if (!btn) throw new Error('refresh button not found');
  return btn as HTMLButtonElement;
}

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 20));
  });
}

describe('ReportViewerDialog ETL refresh', () => {
  it('runs the ETL pipeline for ETL-backed bindings on refresh', async () => {
    const runEtlBindings = vi.fn(
      async (recipeId: string, bindings: ReportBinding[]): Promise<EtlBindingRefreshResult> => ({
        run: okRun(recipeId),
        bindings,
      }),
    );
    const { onUpdate } = renderViewer(specWith([binding]), runEtlBindings);

    act(() => {
      refreshButton().click();
    });
    await flush();

    expect(runEtlBindings).toHaveBeenCalledTimes(1);
    expect(runEtlBindings.mock.calls[0][0]).toBe('recipe-1');
    expect(runEtlBindings.mock.calls[0][1].map((b: ReportBinding) => b.id)).toEqual(['b1']);
    // The recomputed spec is persisted with a fresh data timestamp.
    expect(onUpdate).toHaveBeenCalledTimes(1);
    const updated = onUpdate.mock.calls[0][0] as ReportSpec;
    expect(typeof updated.dataAsOf).toBe('string');
    expect(updated.dataAsOf).not.toBeNull();
  });

  it('runs each distinct recipe once when several bindings share one', async () => {
    const runEtlBindings = vi.fn(
      async (recipeId: string, bindings: ReportBinding[]): Promise<EtlBindingRefreshResult> => ({
        run: okRun(recipeId),
        bindings,
      }),
    );
    const b2: ReportBinding = { ...binding, id: 'b2', name: 'Sales copy' };
    renderViewer(specWith([binding, b2]), runEtlBindings);

    act(() => {
      refreshButton().click();
    });
    await flush();

    expect(runEtlBindings).toHaveBeenCalledTimes(1);
    expect(runEtlBindings.mock.calls[0][1].map((b: ReportBinding) => b.id)).toEqual(['b1', 'b2']);
  });

  it('never touches the ETL port when no binding is ETL-backed', async () => {
    const runEtlBindings = vi.fn(
      async (recipeId: string, bindings: ReportBinding[]): Promise<EtlBindingRefreshResult> => ({
        run: okRun(recipeId),
        bindings,
      }),
    );
    const plain: ReportBinding = { ...binding, etlRecipeId: undefined };
    const { onUpdate } = renderViewer(specWith([plain]), runEtlBindings);

    act(() => {
      refreshButton().click();
    });
    await flush();

    expect(runEtlBindings).not.toHaveBeenCalled();
    expect(onUpdate).toHaveBeenCalledTimes(1);
  });

  it('still recomputes when the ETL run throws, and reports the problem', async () => {
    const runEtlBindings = vi.fn(async () => {
      throw new Error('recipe not found');
    });
    const { onUpdate } = renderViewer(specWith([binding]), runEtlBindings);

    act(() => {
      refreshButton().click();
    });
    await flush();

    expect(onUpdate).toHaveBeenCalledTimes(1);
    expect(document.body.textContent).toContain('recipe not found');
  });

  it('reads ETL-backed tables as-is when no port is supplied', async () => {
    const { onUpdate } = renderViewer(specWith([binding]), undefined);

    act(() => {
      refreshButton().click();
    });
    await flush();

    expect(onUpdate).toHaveBeenCalledTimes(1);
    expect(document.body.textContent).toContain('cannot run ETL pipelines');
  });
});
