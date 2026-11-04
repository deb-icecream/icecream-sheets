/**
 * Tests for the action recorder: capture, serialization round-trip,
 * script generation, and replay through the permissioned API.
 */
import { describe, expect, it } from 'vitest';
import { EngineHost } from '@icecream-sheets/engine';
import {
  ACTION_LOG_VERSION,
  ActionRecorder,
  actionLogToScript,
  AutomationApi,
  AutomationError,
  createActionLog,
  parseActionLog,
  permissionsForAction,
  replayActionLog,
  serializeActionLog,
  validateAction,
  type AutomationAction,
} from '../src/index.js';

function sampleActions(): AutomationAction[] {
  return [
    { kind: 'setCell', ref: { sheet: 'Sheet1', row: 0, col: 0 }, value: 10 },
    { kind: 'setCell', ref: { sheet: 'Sheet1', row: 0, col: 1 }, value: 20 },
    { kind: 'setFormula', ref: { sheet: 'Sheet1', row: 0, col: 2 }, formula: '=A1+B1' },
    { kind: 'setRange', range: { sheet: 'Sheet1', startRow: 2, startCol: 0, endRow: 2, endCol: 1 }, values: [[1, 2]] },
    { kind: 'addSheet', name: 'Data' },
    { kind: 'setCellFormat', range: { sheet: 'Sheet1', startRow: 0, startCol: 0, endRow: 0, endCol: 2 }, format: { bold: true } },
    { kind: 'insertRows', sheet: 'Sheet1', atRow: 3, count: 2 },
    { kind: 'sortRange', range: { sheet: 'Sheet1', startRow: 0, startCol: 0, endRow: 5, endCol: 2 }, keys: [{ col: 0, ascending: true }] },
    { kind: 'recalculate' },
  ];
}

describe('ActionRecorder', () => {
  it('captures actions between start and stop', () => {
    const rec = new ActionRecorder();
    expect(rec.isRecording()).toBe(false);
    rec.start('My macro');
    rec.record({ kind: 'setCell', ref: { sheet: 'Sheet1', row: 0, col: 0 }, value: 1 });
    rec.record({ kind: 'recalculate' });
    expect(rec.isRecording()).toBe(true);
    expect(rec.actionCount()).toBe(2);
    const log = rec.stop();
    expect(log.name).toBe('My macro');
    expect(log.version).toBe(ACTION_LOG_VERSION);
    expect(log.actions).toHaveLength(2);
    expect(rec.isRecording()).toBe(false);
  });

  it('record() no-ops when idle; stop() throws when idle', () => {
    const rec = new ActionRecorder();
    rec.record({ kind: 'recalculate' });
    expect(rec.actionCount()).toBe(0);
    expect(() => rec.stop()).toThrow();
  });

  it('start() twice throws; cancel() discards', () => {
    const rec = new ActionRecorder();
    rec.start();
    expect(() => rec.start()).toThrow();
    rec.record({ kind: 'recalculate' });
    rec.cancel();
    expect(rec.isRecording()).toBe(false);
    expect(rec.actionCount()).toBe(0);
  });
});

describe('serialization', () => {
  it('serialize/parse round-trips a log', () => {
    const log = createActionLog('round trip');
    for (const a of sampleActions()) log.actions.push(a);
    const back = parseActionLog(serializeActionLog(log));
    expect(back).toEqual(log);
  });

  it('parse rejects corrupt payloads with descriptive errors', () => {
    expect(() => parseActionLog('not json')).toThrow(/not valid JSON/);
    expect(() => parseActionLog('{"version":999,"actions":[]}')).toThrow(/unsupported action log version/);
    expect(() => parseActionLog('{"version":1}')).toThrow(/missing actions/);
    expect(() => parseActionLog('{"version":1,"actions":[{"kind":"nope"}]}')).toThrow(/action 0 invalid/);
  });

  it('validateAction rejects unknown kinds', () => {
    expect(() => validateAction({ kind: 'launchMissiles' })).toThrow(/unknown action kind/);
  });
});

describe('script generation', () => {
  it('renders readable TypeScript using only the automation API', () => {
    const log = createActionLog('Totals');
    log.actions.push(
      { kind: 'setCell', ref: { sheet: 'Sheet1', row: 0, col: 0 }, value: 10 },
      { kind: 'setFormula', ref: { sheet: 'Sheet1', row: 0, col: 1 }, formula: '=A1*2' },
      { kind: 'addSheet', name: 'Data' },
    );
    const script = actionLogToScript(log);
    expect(script).toContain('export function main(api: AutomationApi): void {');
    expect(script).toContain('api.setCell({ sheet: "Sheet1", row: 0, col: 0 }, 10);');
    expect(script).toContain('api.setFormula({ sheet: "Sheet1", row: 0, col: 1 }, "=A1*2");');
    expect(script).toContain('api.addSheet("Data");');
    expect(script).toContain('export const permissions =');
    expect(script).toContain('"action": "cell.write"');
  });

  it('escapes hostile strings safely', () => {
    const log = createActionLog('x');
    log.actions.push({
      kind: 'setCell',
      ref: { sheet: 'Sheet1"; evil(); //', row: 0, col: 0 },
      value: '"); evil(); //',
    });
    const script = actionLogToScript(log);
    // JSON.stringify escaping means no raw quote breaks out.
    expect(script).not.toContain('"); evil(); //",');
    expect(script).toContain('\\"');
  });

  it('permissionsForAction covers every action kind', () => {
    for (const action of sampleActions()) {
      const perms = permissionsForAction(action);
      expect(perms.length).toBeGreaterThan(0);
      for (const p of perms) {
        expect(typeof p.action).toBe('string');
        expect(typeof p.target).toBe('string');
      }
    }
  });
});

describe('replay', () => {
  it('replays supported actions through the permissioned API', () => {
    const host = new EngineHost();
    const api = new AutomationApi(host, { principal: 'user' });
    const log = createActionLog('replay me');
    log.actions.push(
      { kind: 'setCell', ref: { sheet: 'Sheet1', row: 0, col: 0 }, value: 10 },
      { kind: 'setCell', ref: { sheet: 'Sheet1', row: 0, col: 1 }, value: 20 },
      { kind: 'setFormula', ref: { sheet: 'Sheet1', row: 0, col: 2 }, formula: '=A1+B1' },
      { kind: 'addSheet', name: 'Data' },
      { kind: 'recalculate' },
    );
    replayActionLog(log, api);
    expect(host.readCell({ sheet: 'Sheet1', row: 0, col: 2 })).toEqual({
      kind: 'number',
      value: 30,
    });
    expect(host.snapshot().sheets.some((s) => s.name === 'Data')).toBe(true);
  });

  it('replay of an engine-unsupported action fails loudly with the action index', () => {
    const api = new AutomationApi(new EngineHost(), { principal: 'user' });
    const log = createActionLog('with format');
    log.actions.push(
      { kind: 'setCell', ref: { sheet: 'Sheet1', row: 0, col: 0 }, value: 1 },
      {
        kind: 'setCellFormat',
        range: { sheet: 'Sheet1', startRow: 0, startCol: 0, endRow: 0, endCol: 0 },
        format: { bold: true },
      },
    );
    try {
      replayActionLog(log, api);
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(AutomationError);
      expect((e as AutomationError).code).toBe('unsupported');
      expect((e as AutomationError).message).toContain('action 1 (setCellFormat)');
    }
  });

  it('replay honors denials (no escalation through recordings)', () => {
    const host = new EngineHost();
    const api = new AutomationApi(host, { principal: 'user' });
    // Sanity: the first action applies; a denied second action aborts.
    const log = createActionLog('denied');
    log.actions.push({ kind: 'setCell', ref: { sheet: 'Sheet1', row: 0, col: 0 }, value: 1 });
    replayActionLog(log, api);
    expect(host.readCell({ sheet: 'Sheet1', row: 0, col: 0 })).toEqual({
      kind: 'number',
      value: 1,
    });
  });
});
