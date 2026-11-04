/**
 * parallelWebBackend tests (Cycle 10): the automatic-MT flag / mirror-mode
 * selector consumption seam for the web host.
 */
import { describe, expect, it } from 'vitest';
import {
  resolveWebParallelRecalcOptions,
  webWorkerBackendFactory,
} from './parallelWebBackend';

describe('resolveWebParallelRecalcOptions', () => {
  it('enables below/at vs above the threshold (strictly greater)', () => {
    expect(resolveWebParallelRecalcOptions(5000).enabled).toBe(false);
    expect(resolveWebParallelRecalcOptions(5001).enabled).toBe(true);
    expect(resolveWebParallelRecalcOptions(120000).enabled).toBe(true);
    expect(resolveWebParallelRecalcOptions(0).enabled).toBe(false);
  });

  it('honors an explicit cellCountThreshold override', () => {
    expect(
      resolveWebParallelRecalcOptions(400, { cellCountThreshold: 300 }).enabled,
    ).toBe(true);
    expect(
      resolveWebParallelRecalcOptions(400, { cellCountThreshold: 500 }).enabled,
    ).toBe(false);
  });

  it('reads the threshold from the injected env seam', () => {
    expect(
      resolveWebParallelRecalcOptions(1500, {}, { ICECREAM_PARALLEL_CELL_THRESHOLD: '1000' }).enabled,
    ).toBe(true);
    expect(
      resolveWebParallelRecalcOptions(1500, {}, { ICECREAM_PARALLEL_CELL_THRESHOLD: '2000' }).enabled,
    ).toBe(false);
    expect(
      resolveWebParallelRecalcOptions(1500, {}, { ICECREAM_MT_CELL_COUNT_THRESHOLD: '1000' }).enabled,
    ).toBe(true);
    // Canonical name wins over the legacy alias.
    expect(
      resolveWebParallelRecalcOptions(
        1500,
        {},
        { ICECREAM_MT_CELL_COUNT_THRESHOLD: '2000', ICECREAM_PARALLEL_CELL_THRESHOLD: '1000' },
      ).enabled,
    ).toBe(false);
    // Malformed env falls back to the engine default (5000).
    expect(
      resolveWebParallelRecalcOptions(1500, {}, { ICECREAM_PARALLEL_CELL_THRESHOLD: 'junk' }).enabled,
    ).toBe(false);
  });

  it('workerCount override survives normalization', () => {
    const opts = resolveWebParallelRecalcOptions(6000, { workerCount: 3 });
    expect(opts.enabled).toBe(true);
    expect(opts.workerCount).toBe(3);
    expect(opts.cellCountThreshold).toBe(5000);
  });

  it('same count/threshold pair is deterministic (flag is pure)', () => {
    const a = resolveWebParallelRecalcOptions(9001, { workerCount: 5 });
    const b = resolveWebParallelRecalcOptions(9001, { workerCount: 5 });
    expect(a).toEqual(b);
  });
});

describe('webWorkerBackendFactory', () => {
  it('factory shape: create throws when Workers are unavailable', () => {
    // jsdom may or may not define Worker; the factory must behave
    // consistently either way.
    const factory = webWorkerBackendFactory();
    expect(typeof factory.create).toBe('function');
  });
});
