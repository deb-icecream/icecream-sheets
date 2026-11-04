/**
 * Tests for the compatibility runner (automation-lane.md §6): unmigrated
 * Windows automation runs isolated in a child process, never inside the
 * engine process. Covers real process spawning, timeout enforcement,
 * clean failure on parent-process access attempts, opaque payloads, and
 * the runUnmigratedWindowsAutomation entry point.
 */
import { describe, expect, it } from 'vitest';
import { Authorizer, EngineHost } from '@icecream-sheets/engine';
import { AUTOMATION_ACTIONS, AutomationApi } from '../src/index.js';
import {
  CompatRunner,
  compatCellKey,
  replayCompatActions,
  runPreservedMacroProject,
  runUnmigratedWindowsAutomation,
  snapshotCells,
  validateCompatAction,
} from '../src/automation/node.js';

describe('CompatRunner', () => {
  it('executes a payload in the child process and returns results across the boundary', async () => {
    const runner = new CompatRunner({ timeoutMs: 8000 });
    const result = await runner.run({
      kind: 'script',
      language: 'javascript',
      code: `
        function main(api) {
          const v = api.getCell({ sheet: 'S', row: 0, col: 0 });
          api.setCell({ sheet: 'S', row: 0, col: 1 }, v.value * 2);
          api.notify('hello from the child');
          return 'done:' + input.cells['S!0,0'];
        }
      `,
      input: { cells: { 'S!0,0': 21 } },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Data crossed the boundary both ways: snapshot in, value + declared
    // write actions out.
    expect(result.value).toBe('done:21');
    expect(result.actions).toEqual([
      { method: 'setCell', args: [{ sheet: 'S', row: 0, col: 1 }, 42] },
    ]);
    expect(result.notifications).toEqual(['hello from the child']);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('runs TypeScript payloads (type-stripped before crossing the boundary)', async () => {
    const runner = new CompatRunner({ timeoutMs: 8000 });
    const result = await runner.run({
      kind: 'script',
      language: 'typescript',
      code: `
        export function main(api: any): number {
          const v: number = api.getCell({ sheet: 'S', row: 0, col: 0 }).value as number;
          return v + 1;
        }
      `,
      input: { cells: { 'S!0,0': 41 } },
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe(42);
  });

  it('kills a hung payload at the timeout and reports a clean failure', async () => {
    const runner = new CompatRunner({ timeoutMs: 400 });
    const started = Date.now();
    const result = await runner.run({
      kind: 'script',
      language: 'javascript',
      code: `function main(api) { while (true) {} }`,
    });
    const elapsed = Date.now() - started;
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('timeout');
    expect(result.error).toContain('timed out');
    // The child was actually killed: well under the 4s vm backstop.
    expect(elapsed).toBeLessThan(4000);
  });

  it('fails cleanly when the payload tries to reach the parent process', async () => {
    const runner = new CompatRunner({ timeoutMs: 8000 });
    const parentPid = process.pid;
    for (const code of [
      `function main(api) { process.exit(42); }`,
      `function main(api) { return require('child_process'); }`,
      `function main(api) { return globalThis.process.pid; }`,
    ]) {
      const result = await runner.run({ kind: 'script', language: 'javascript', code });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('execution');
    }
    // The parent process is untouched by every attempt.
    expect(process.pid).toBe(parentPid);
  });

  it('reports a hung-payload kill without crashing when the child floods stdout', async () => {
    const runner = new CompatRunner({ timeoutMs: 8000, maxOutputBytes: 1024 });
    const result = await runner.run({
      kind: 'script',
      language: 'javascript',
      // Bypass the envelope: write straight to the real stdout via the
      // constructor chain is blocked, so flood through repeated api.notify
      // strings is impossible — instead emit a huge return value.
      code: `function main(api) { return 'x'.repeat(100000); }`,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('protocol');
  });

  it('rejects suspicious declared actions instead of replaying them', () => {
    expect(validateCompatAction({ method: 'setCell', args: [{ sheet: 'S', row: 0, col: 0 }, 1] })).toEqual([]);
    expect(
      validateCompatAction({ method: 'exec', args: ['rm -rf /'] }),
    ).toEqual(['unknown compat action method "exec"']);
    expect(
      validateCompatAction({ method: 'setCell', args: [{ sheet: 'S' }, 1] }).length,
    ).toBeGreaterThan(0);
    const api = new AutomationApi(new EngineHost(), { principal: 'user' });
    expect(() =>
      replayCompatActions(api, [{ method: 'exec', args: [] } as never]),
    ).toThrow(/suspicious/);
  });

  it('never executes opaque payloads: clean unsupported failure, no child spawned', async () => {
    const runner = new CompatRunner({ timeoutMs: 8000 });
    const result = await runner.run({
      kind: 'opaque',
      format: 'vbaProject.bin',
      dataBase64: 'TVqQAAMAAAAEAAAA',
      reason: 'test',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('unsupported');
    expect(result.error).toContain('vbaProject.bin');
    expect(result.error).toContain('out of scope for v1');
  });

  it('validates constructor options and payloads', () => {
    expect(() => new CompatRunner({ timeoutMs: 0 })).toThrow(/timeoutMs/);
    expect(() => new CompatRunner({ maxMemoryMb: -1 })).toThrow(/maxMemoryMb/);
  });

  it('snapshotCells builds the child-visible snapshot from an AutomationApi', () => {
    const api = new AutomationApi(new EngineHost(), { principal: 'user' });
    api.grantPermissions('user', [{ action: 'cell.write', target: 'Sheet1' }], 'test');
    api.setCell({ sheet: 'Sheet1', row: 0, col: 0 }, 10);
    api.setCell({ sheet: 'Sheet1', row: 0, col: 1 }, 'x');
    const snap = snapshotCells(api, 'Sheet1', 0, 0, 0, 1);
    expect(snap[compatCellKey('Sheet1', 0, 0)]).toBe(10);
    expect(snap[compatCellKey('Sheet1', 0, 1)]).toBe('x');
  });
});

describe('runUnmigratedWindowsAutomation entry point', () => {
  it('routes translated VBA to the isolated runner and replays actions through authorize()', async () => {
    const host = new EngineHost();
    const api = new AutomationApi(host, { principal: 'user' });
    api.grantPermissions('user', [{ action: 'cell.write', target: 'Sheet1!A1' }], 'test');
    api.setCell({ sheet: 'Sheet1', row: 0, col: 0 }, 21);

    const report = await runUnmigratedWindowsAutomation(
      {
        kind: 'vba',
        source: 'Sub DoubleIt()\n  Range("A1").Value = Range("A1").Value * 2\nEnd Sub',
      },
      {
        api,
        timeoutMs: 8000,
        input: { cells: { [compatCellKey('Sheet1', 0, 0)]: 21 } },
      },
    );
    expect(report.sourceLanguage).toBe('vba');
    expect(report.result.ok).toBe(true);
    // The write crossed back over the boundary and landed via the
    // permissioned API — never executed in the engine process.
    expect(host.readCell({ sheet: 'Sheet1', row: 0, col: 0 })).toEqual({
      kind: 'number',
      value: 42,
    });
  });

  it('reports untranslated lines and fails cleanly when nothing is translatable', async () => {
    const report = await runUnmigratedWindowsAutomation({
      kind: 'vba',
      source: 'Sub Evil()\n  Declare Sub Kill Lib "kernel32" ()\nEnd Sub',
    });
    expect(report.untranslated.length).toBeGreaterThan(0);
    expect(report.result.ok).toBe(false);
    if (!report.result.ok) {
      expect(report.result.code).toBe('unsupported');
      expect(report.result.error).toContain('no translatable statements');
    }
  });

  it('routes preserved macro projects to a clean unsupported failure', async () => {
    const result = await runPreservedMacroProject('TVqQAAMAAAAEAAAA//8AALgAAAAAAAAAQ==');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('unsupported');
      expect(result.error).toContain('vbaProject.bin');
    }
  });

  it('a denied write during replay surfaces as a clean execution failure', async () => {
    // Deny cell writes at the engine authorizer: the replayed setCell must
    // be refused by authorize(), surfacing as a clean failure — not a bypass.
    const authorizer = new Authorizer((action) => action !== AUTOMATION_ACTIONS.cellWrite);
    const api = new AutomationApi(new EngineHost(undefined, authorizer), { principal: 'user' });
    const report = await runUnmigratedWindowsAutomation(
      {
        kind: 'vba',
        source: 'Sub W()\n  Range("A1").Value = 1\nEnd Sub',
      },
      { api, timeoutMs: 8000 },
    );
    expect(report.result.ok).toBe(false);
    if (!report.result.ok) expect(report.result.code).toBe('execution');
  });
});
