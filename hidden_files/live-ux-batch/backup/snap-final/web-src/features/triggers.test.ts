/**
 * Tests for the triggers product client (features/triggers.ts):
 * transport selection, gateway request shapes against a stub fetch,
 * A1→RangeRef parsing, and template/permission sanity in the real
 * automation vocabulary.
 */
import { describe, expect, it } from 'vitest';
import {
  DesktopTriggerTransport,
  GatewayTriggerTransport,
  defaultTriggerPermissions,
  parseTriggerRange,
  pickTriggerTransport,
  rangeToA1,
  triggerTemplate,
  type DesktopTriggersBridge,
  type TriggerListResult,
  type TriggerStatus,
} from './triggers';
import type { TriggerSpecInit } from '@icecream-sheets/service';

interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

function stubFetch(responseBody: unknown, status = 200) {
  const calls: RecordedCall[] = [];
  const fetchFn = (async (url: string, init?: RequestInit) => {
    calls.push({
      url,
      method: init?.method ?? 'GET',
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    });
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => responseBody,
      text: async () => JSON.stringify(responseBody),
    } as Response;
  }) as typeof fetch;
  return { calls, fetchFn };
}

const sampleTrigger: TriggerStatus = {
  version: 1,
  id: 'trigger-1',
  name: 'Mark edits',
  event: 'onEdit',
  enabled: true,
  language: 'javascript',
  script: 'api.notify("hi");',
  permissions: [{ action: 'cell.write', target: 'Sheet1!10,0' }],
  createdAt: '2026-10-22T00:00:00.000Z',
  updatedAt: '2026-10-22T00:00:00.000Z',
  granted: false,
  lastRun: null,
};

const listResult: TriggerListResult = {
  events: ['onOpen', 'onEdit', 'onInterval', 'onAtTime'],
  triggers: [sampleTrigger],
};

function stubBridge(): DesktopTriggersBridge & { created: TriggerSpecInit[] } {
  const created: TriggerSpecInit[] = [];
  return {
    created,
    list: async () => listResult,
    create: async (spec) => {
      created.push(spec);
      return { ...sampleTrigger, name: spec.name, event: spec.event };
    },
    remove: async () => undefined,
    setEnabled: async () => undefined,
    grant: async () => undefined,
  };
}

const gatewayClient = { baseUrl: 'http://gw.test/', getToken: () => 'jwt-123' };

describe('pickTriggerTransport', () => {
  it('prefers the desktop bridge when present', () => {
    const t = pickTriggerTransport({ desktopBridge: stubBridge(), gatewayClient, fileId: 'file-1' });
    expect(t).toBeInstanceOf(DesktopTriggerTransport);
  });

  it('uses the gateway when a file id + gateway client exist', () => {
    const t = pickTriggerTransport({ desktopBridge: null, gatewayClient, fileId: 'file-1' });
    expect(t).toBeInstanceOf(GatewayTriggerTransport);
  });

  it('returns null without a hosted session (no fake data)', () => {
    expect(pickTriggerTransport({ desktopBridge: null, gatewayClient, fileId: null })).toBeNull();
    expect(pickTriggerTransport({ desktopBridge: null, gatewayClient: null, fileId: 'file-1' })).toBeNull();
  });
});

describe('GatewayTriggerTransport', () => {
  function transport(fetchFn: typeof fetch) {
    return new GatewayTriggerTransport({
      baseUrl: 'http://gw.test/',
      getToken: () => 'jwt-123',
      fileId: 'file 1',
      fetchFn,
    });
  }

  it('list: GET /api/automation/triggers?fileId= with the JWT, strips the envelope', async () => {
    const { calls, fetchFn } = stubFetch({ ok: true, ...listResult });
    const res = await transport(fetchFn).list();
    expect(res).toEqual(listResult);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe('GET');
    expect(calls[0]!.url).toBe('http://gw.test/api/automation/triggers?fileId=file%201');
    expect(calls[0]!.headers['authorization']).toBe('Bearer jwt-123');
  });

  it('create: POST with { fileId, spec } body', async () => {
    const { calls, fetchFn } = stubFetch({ ok: true, trigger: sampleTrigger });
    const spec: TriggerSpecInit = { name: 'Mark edits', event: 'onEdit', script: 'api.notify("x");' };
    const created = await transport(fetchFn).create(spec);
    expect(created.id).toBe('trigger-1');
    expect(calls[0]!.method).toBe('POST');
    expect(calls[0]!.url).toBe('http://gw.test/api/automation/triggers?fileId=file%201');
    expect(calls[0]!.body).toEqual({ fileId: 'file 1', spec });
  });

  it('setEnabled / grant / remove follow the contract paths and bodies', async () => {
    const { calls, fetchFn } = stubFetch({ ok: true });
    const t = transport(fetchFn);
    await t.setEnabled('trigger-1', false);
    await t.grant('trigger-1');
    await t.remove('trigger-1');
    expect(calls[0]).toMatchObject({
      method: 'POST',
      url: 'http://gw.test/api/automation/triggers/trigger-1/enabled?fileId=file%201',
      body: { fileId: 'file 1', enabled: false },
    });
    expect(calls[1]).toMatchObject({
      method: 'POST',
      url: 'http://gw.test/api/automation/triggers/trigger-1/grant?fileId=file%201',
      body: { fileId: 'file 1' },
    });
    expect(calls[2]).toMatchObject({
      method: 'DELETE',
      url: 'http://gw.test/api/automation/triggers/trigger-1?fileId=file%201',
    });
  });

  it('surfaces the server error string verbatim', async () => {
    const { fetchFn } = stubFetch({ ok: false, error: 'not your file' }, 403);
    await expect(transport(fetchFn).list()).rejects.toThrow('not your file');
  });
});

describe('DesktopTriggerTransport', () => {
  it('delegates to the bridge with no fileId anywhere', async () => {
    const bridge = stubBridge();
    const t = new DesktopTriggerTransport(bridge);
    expect(await t.list()).toEqual(listResult);
    const spec: TriggerSpecInit = { name: 'X', event: 'onOpen', script: 'api.notify("x");' };
    await t.create(spec);
    expect(bridge.created).toEqual([spec]);
  });
});

describe('parseTriggerRange (A1 → RangeRef)', () => {
  it('parses a range with the fallback sheet', () => {
    expect(parseTriggerRange('A1:B2', 'Data')).toEqual({
      sheet: 'Data',
      startRow: 0,
      startCol: 0,
      endRow: 1,
      endCol: 1,
    });
  });

  it('parses a single cell and an explicit Sheet! prefix', () => {
    expect(parseTriggerRange('K1')).toEqual({
      sheet: 'Sheet1',
      startRow: 0,
      startCol: 10,
      endRow: 0,
      endCol: 10,
    });
    expect(parseTriggerRange('Sheet2!C3:D4', 'Data')?.sheet).toBe('Sheet2');
  });

  it('normalizes reversed corners and rejects garbage', () => {
    expect(parseTriggerRange('B2:A1', 'S')).toEqual({
      sheet: 'S',
      startRow: 0,
      startCol: 0,
      endRow: 1,
      endCol: 1,
    });
    expect(parseTriggerRange('not a range')).toBeNull();
    expect(parseTriggerRange('')).toBeNull();
  });

  it('rangeToA1 round-trips', () => {
    const r = parseTriggerRange('Sheet1!A1:B2')!;
    expect(rangeToA1(r)).toBe('Sheet1!A1:B2');
    expect(rangeToA1(parseTriggerRange('K1')!)).toBe('Sheet1!K1');
  });
});

describe('templates + default permissions', () => {
  it('templates use the bare sandbox shape (live api, no main())', () => {
    for (const ev of ['onEdit', 'onOpen', 'onInterval', 'onAtTime']) {
      const js = triggerTemplate(ev, 'javascript');
      expect(js).toContain('api.setCell');
      expect(js).toContain('api.notify');
      expect(js).not.toContain('function main');
      const py = triggerTemplate(ev, 'python');
      expect(py).toContain('actions = [');
      expect(py).toContain('"setCell"');
    }
  });

  it('the onEdit template writes a marker cell via api.setCell', () => {
    const js = triggerTemplate('onEdit');
    expect(js).toContain("api.setCell({ sheet: 'Sheet1', row: 0, col: 10 }, 'edited')");
  });

  it('default permissions use the real automation vocabulary', () => {
    const perms = defaultTriggerPermissions();
    expect(perms).toContainEqual({
      action: 'cell.write',
      target: 'Sheet1!10,0',
      reason: 'Write the marker cell when the trigger fires',
    });
    expect(perms.map((p) => p.action)).toContain('ui.notify');
  });
});
