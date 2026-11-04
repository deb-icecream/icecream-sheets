/**
 * Import-cycle safety: engineForward.ts is imported FIRST here (before
 * ../engine). engineForward -> ../engine -> ./desktopAgent must evaluate
 * without a cycle crash (the handler used to live in desktopAgent.ts,
 * which IS imported by ../engine — that placement crashed at module load).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
// NOTE: this import must stay first in the file.
import { registerEngineForwardHandler } from './engineForward';
import { getHost } from '../engine';
import { isDesktop } from './desktopAgent';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('engineForward import safety', () => {
  it('modules evaluate in any import order', () => {
    expect(isDesktop()).toBe(false); // no window.icecreamDesktop in vitest
    expect(typeof registerEngineForwardHandler).toBe('function');
    const host = getHost();
    expect(host.protocolVersion).toBeGreaterThan(0);
    // Not on desktop: registration is a no-op returning an unsubscribe fn.
    const off = registerEngineForwardHandler();
    expect(typeof off).toBe('function');
    off();
  });

  it('forwards ops to the current host (per-call getHost)', async () => {
    // Simulate the preload bridge.
    let handler: ((payload: never) => Promise<unknown>) | null = null;
    const published: unknown[] = [];
    vi.stubGlobal('window', {
      icecreamDesktop: {
        engineForward: {
          onRequest: (cb: (payload: never) => Promise<unknown>) => {
            handler = cb;
            return () => {
              handler = null;
            };
          },
          publishEvent: (event: unknown) => {
            published.push(event);
          },
        },
      },
    });
    try {
      const off = registerEngineForwardHandler();
      expect(handler).not.toBeNull();
      const host = getHost();
      host.execute({
        cmd: 'setCell',
        ref: { sheet: 'Sheet1', row: 0, col: 0 },
        value: 7,
      });
      const res = (await handler!({
        op: 'readCell',
        ref: { sheet: 'Sheet1', row: 0, col: 0 },
      } as never)) as { kind: string; value: unknown };
      expect(res).toMatchObject({ kind: 'number', value: 7 });
      // Engine events are pushed to the (simulated) main process.
      host.execute({
        cmd: 'setCell',
        ref: { sheet: 'Sheet1', row: 0, col: 1 },
        value: 8,
      });
      expect(published.length).toBeGreaterThan(0);
      off();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
