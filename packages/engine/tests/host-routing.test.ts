/**
 * EngineHost routing delegations (Cycle 10 Phase 3): the web/desktop
 * hosts route edits through the pure routeRecalc policy WITHOUT reaching
 * past the protocol — these delegate to the workbook seam.
 */
import { describe, expect, it } from 'vitest';
import { EngineHost } from '../src/protocol.js';
import { EngineWorkbook } from '../src/workbook.js';

describe('EngineHost hybrid routing delegations', () => {
  it('exposes thresholds, cell count and mirror mode from the workbook', () => {
    const host = new EngineHost(new EngineWorkbook({ Sheet1: [[1, '=A1+1']] }));
    expect(host.totalCellCount()).toBe(2);
    expect(host.mirrorMode()).toBe('mirror');
    expect(host.hybridRecalcConfig().mtCellCountThreshold).toBe(5000);
  });

  it('routeEditRecalc routes a tiny edit local', () => {
    const host = new EngineHost(new EngineWorkbook({ Sheet1: [[1, '=A1+1']] }));
    const d = host.routeEditRecalc({ sheet: 'Sheet1', row: 0, col: 0 });
    expect(d.route).toBe('local');
    expect(d.reason).toBe('tiny-set-local');
  });

  it('routeEditRecalc fails safe to no-mirror on a flag-ON workbook', () => {
    const host = new EngineHost(
      new EngineWorkbook(
        { Sheet1: Array.from({ length: 60 }, (_, i) => [i, `=A${i + 1}+1`]) },
        { hybridRecalc: { mtCellCountThreshold: 50 } },
      ),
    );
    expect(host.mirrorMode()).toBe('no-mirror');
    const d = host.routeEditRecalc({ sheet: 'Sheet1', row: 0, col: 0 });
    expect(d.route).toBe('server');
    expect(d.reason).toBe('no-mirror');
  });

  it('measureCalcChain delegates to the graph seam (single chain here)', () => {
    const host = new EngineHost(new EngineWorkbook({ Sheet1: [[1, '=A1+1', '=B1+1']] }));
    const m = host.measureCalcChain({ sheet: 'Sheet1', row: 0, col: 0 });
    expect(m.shape).toBe('single-chain');
    expect(m.chainLength).toBe(2);
  });
});
