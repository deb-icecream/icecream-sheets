/**
 * Tests for the automation sandbox: JS vm isolation + live API bridge,
 * Python action-collecting model, timeouts, and authorization enforcement
 * through the bridge (a denied policy must surface as a script error, not
 * a bypass).
 */
import { describe, expect, it } from 'vitest';
import { Authorizer, EngineHost } from '@icecream-sheets/engine';
import { AutomationApi } from '../src/index.js';
import {
  BRIDGE_METHODS,
  createBridgeHandler,
  runJavaScriptAutomation,
  runPythonAutomation,
} from '../src/automation/node.js';

function bridged(principal = 'user', host?: EngineHost) {
  const api = new AutomationApi(host ?? new EngineHost(), { principal });
  return { api, handler: createBridgeHandler(api) };
}

describe('JavaScript sandbox', () => {
  it('runs code with a live api bridge and frozen event', () => {
    const { api, handler } = bridged();
    const res = runJavaScriptAutomation(
      `api.setCell({sheet:"Sheet1",row:0,col:0}, 21);
       api.getCell({sheet:"Sheet1",row:0,col:0}).value * 2;`,
      { handler, event: { type: 'edit', refs: [] } },
    );
    expect('value' in res && res.value).toBe(42);
    expect(api.getCell({ sheet: 'Sheet1', row: 0, col: 0 })).toEqual({
      kind: 'number',
      value: 21,
    });
  });

  it('event object is frozen and JSON-serialized', () => {
    const { handler } = bridged();
    const res = runJavaScriptAutomation(`event.refs.length + ":" + event.type;`, {
      handler,
      event: { type: 'edit', refs: [{ sheet: 'Sheet1', row: 1, col: 2 }] },
    });
    expect('value' in res && res.value).toBe('1:edit');
  });

  it('has no I/O: process, require, fetch are undefined', () => {
    const { handler } = bridged();
    const res = runJavaScriptAutomation(
      `[typeof process, typeof require, typeof fetch, typeof console].join(",");`,
      { handler },
    );
    expect('value' in res && res.value).toBe('undefined,undefined,undefined,undefined');
  });

  it('times out infinite loops', () => {
    const { handler } = bridged();
    const res = runJavaScriptAutomation(`while (true) {}`, { handler, timeoutMs: 200 });
    expect('error' in res).toBe(true);
  });

  it('bridge surfaces authorization denials as script errors (no bypass)', () => {
    const authorizer = new Authorizer((action) => action !== 'cell.write');
    const host = new EngineHost(undefined, authorizer);
    const { handler } = bridged('automation:evil', host);
    const res = runJavaScriptAutomation(
      `let code = "none";
       try { api.setCell({sheet:"Sheet1",row:0,col:0}, 1); }
       catch (e) { code = e.code; }
       code;`,
      { handler },
    );
    expect('value' in res && res.value).toBe('denied');
    expect(host.readCell({ sheet: 'Sheet1', row: 0, col: 0 })).toEqual({
      kind: 'null',
      value: null,
    });
  });

  it('bridge rejects unknown methods', () => {
    const { handler } = bridged();
    const res = runJavaScriptAutomation(
      `let msg = "";
       try { api.dropTable("x"); } catch (e) { msg = e.message; }
       msg;`,
      { handler },
    );
    expect('value' in res && (res.value as string)).toMatch(/unknown api method/);
  });

  it('only JSON crosses the boundary; bad payloads fail cleanly', () => {
    const { handler } = bridged();
    expect(JSON.parse(handler('notify', '["hi"]')).ok).toBe(true);
    // {} is not a valid message: validation fails with code 'invalid'.
    const bad = JSON.parse(handler('notify', '[{}]'));
    expect(bad.ok).toBe(false);
    expect(bad.code).toBe('invalid');
    // Not JSON at all: the bridge rejects it.
    expect(JSON.parse(handler('setCell', 'not json')).ok).toBe(false);
  });

  it('exposes exactly the documented method set', () => {
    expect([...BRIDGE_METHODS].sort()).toEqual(
      [
        'getCell', 'setCell', 'getFormula', 'setFormula', 'getRange', 'setRange',
        'clearRange', 'listSheets', 'addSheet', 'getSheetInfo',
        'setCalculationMode', 'recalculate', 'notify',
      ].sort(),
    );
  });
});

describe('Python sandbox', () => {
  it('collects actions and replays them through the API', () => {
    const { api, handler } = bridged();
    const res = runPythonAutomation(
      [
        'actions = [',
        '  {"method": "setCell", "args": [{"sheet": "Sheet1", "row": 1, "col": 1}, "hi"]},',
        '  {"method": "notify", "args": ["from python"]},',
        ']',
      ].join('\n'),
      { handler, event: { type: 'timer' } },
    );
    expect('error' in res).toBe(false);
    const value = (res as { value: unknown }).value as Array<{ method: string; ok: boolean }>;
    expect(value).toHaveLength(2);
    expect(value.every((r) => r.ok)).toBe(true);
    expect(api.getCell({ sheet: 'Sheet1', row: 1, col: 1 })).toEqual({
      kind: 'string',
      value: 'hi',
    });
    expect(api.getNotifications()).toEqual(['from python']);
  });

  it('reports per-action authorization failures without bypass', () => {
    const authorizer = new Authorizer((action) => action !== 'cell.write');
    const host = new EngineHost(undefined, authorizer);
    const { handler } = bridged('automation:evil', host);
    const res = runPythonAutomation(`actions = [{"method": "setCell", "args": [{"sheet": "Sheet1", "row": 0, "col": 0}, 1]}]`, {
      handler,
    });
    const value = (res as { value: unknown }).value as Array<{
      ok: boolean;
      code?: string;
    }>;
    expect(value[0]!.ok).toBe(false);
    expect(value[0]!.code).toBe('denied');
  });

  it('requires the actions variable', () => {
    const { handler } = bridged();
    const res = runPythonAutomation(`x = 1`, { handler });
    expect('error' in res && (res as { error: string }).error).toMatch(/actions/);
  });

  it('blocks dangerous imports', () => {
    const { handler } = bridged();
    const res = runPythonAutomation(`import os\nactions = []`, { handler });
    expect('error' in res && (res as { error: string }).error).toMatch(/not allowed/);
  });

  it('times out runaway scripts', () => {
    const { handler } = bridged();
    const res = runPythonAutomation(`while True:\n    pass`, { handler, timeoutMs: 500 });
    expect('error' in res && (res as { error: string }).error).toMatch(/timed out/);
  });
});
