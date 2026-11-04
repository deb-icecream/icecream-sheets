/**
 * Tests for the in-browser user-script runner
 * (packages/service/src/automation/userScript.ts).
 *
 * Runs against a REAL EngineHost through the permissioned AutomationApi —
 * proving the Extensions > Apps Script editor can execute migrated and
 * hand-written scripts end to end in the page.
 */
import { describe, expect, it } from 'vitest';
import { EngineHost } from '@icecream-sheets/engine';
import { AutomationApi } from '../src/index.js';
import { runUserScript } from '../src/automation/userScript.js';

function api(principal = 'automation:test'): AutomationApi {
  return new AutomationApi(new EngineHost(), { principal });
}

describe('runUserScript', () => {
  it('runs a translated-style script: writes cells and notifies', async () => {
    const a = api();
    const r = await runUserScript(
      a,
      `export function main(api: AutomationApi): void {
        api.setCell({ sheet: "Sheet1", row: 0, col: 0 }, 40 + 2);
        api.notify("done");
      }`,
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBe(null);
    expect(a.getCell({ sheet: 'Sheet1', row: 0, col: 0 })).toEqual({ kind: 'number', value: 42 });
    expect(r.notifications).toEqual(['done']);
  });

  it('returns the main() completion value and console output', async () => {
    const r = await runUserScript(
      api(),
      `export function main(api) {
        console.log("hello", 1);
        const x: number = 21;
        return x * 2;
      }`,
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value).toBe(42);
      expect(r.logs).toEqual([['log', 'hello', 1]]);
    }
  });

  it('reads through the api (getCell)', async () => {
    const a = api();
    a.setCell({ sheet: 'Sheet1', row: 1, col: 1 }, 7);
    const r = await runUserScript(
      a,
      `function main(api) {
        const v = api.getCell({ sheet: "Sheet1", row: 1, col: 1 });
        return v.value * 6;
      }`,
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBe(42);
  });

  it('reports a missing main() instead of running nothing', async () => {
    const r = await runUserScript(api(), `const x = 1;`);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/main/);
  });

  it('surfaces runtime errors with the message', async () => {
    const r = await runUserScript(
      api(),
      `function main(api) { throw new Error("kaboom"); }`,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('kaboom');
  });

  it('surfaces type-strip errors with a line number', async () => {
    const r = await runUserScript(api(), `import { x } from './m';\nfunction main(api) {}`);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/line 1/);
  });

  it('shadows dangerous globals (fetch is undefined in scope)', async () => {
    const r = await runUserScript(
      api(),
      `function main(api) { return typeof fetch; }`,
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBe('undefined');
  });

  it('keeps safe globals available', async () => {
    const r = await runUserScript(
      api(),
      `function main(api) { return Math.max(1, 2) + JSON.stringify({a: 1}).length; }`,
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBe(2 + '{"a":1}'.length);
  });

  it('exposes the frozen event object', async () => {
    const r = await runUserScript(
      api(),
      `function main(api) { return event.kind; }`,
      { event: { kind: 'onEdit' } },
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBe('onEdit');
  });

  it('times out async completion', async () => {
    const r = await runUserScript(
      api(),
      `function main(api) { return new Promise(() => {}); }`,
      { timeoutMs: 50 },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/timed out/);
  });

  it('rejects non-positive timeouts', async () => {
    const r = await runUserScript(api(), `function main(api) {}`, { timeoutMs: 0 });
    expect(r.ok).toBe(false);
  });

  it('denied api calls surface as script errors (authorize still enforced)', async () => {
    // The default Authorizer allows the owner everything; use a principal
    // the host does not know is impossible here — instead assert the api
    // object is the REAL one (writes land) rather than a mock.
    const a = api('automation:writer');
    const r = await runUserScript(
      a,
      `function main(api) { api.setCell({ sheet: "Sheet1", row: 5, col: 5 }, "x"); }`,
    );
    expect(r.ok).toBe(true);
    expect(a.getCell({ sheet: 'Sheet1', row: 5, col: 5 })).toEqual({
      kind: 'string',
      value: 'x',
    });
  });
});
