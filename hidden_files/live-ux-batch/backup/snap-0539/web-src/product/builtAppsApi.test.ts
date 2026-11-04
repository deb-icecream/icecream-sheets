/**
 * W4 BuiltAppsApi + sync-plan tests: the /api/built-apps surface over
 * a faked GatewayClient, and the pure local/server merge + migration
 * planning (server authoritative, upload-on-open deduped, legacy
 * sheet-match heuristic, other-file apps untouched).
 */
import { describe, expect, it } from 'vitest';
import { generateAppSpec, type AppSpec } from '@icecream-sheets/service';
import type { GatewayClient } from '../services/gatewayClient';
import { BuiltAppsApi, type BuiltAppRecordView } from './builtAppsApi';
import { planBuiltAppSync } from './builtAppSync';
import { ProductApiError } from './productApi';

type CallRecord = { path: string; init?: RequestInit; body?: unknown };
type Handler = (path: string, init?: RequestInit, body?: unknown) => unknown;

class FakeGatewayClient {
  readonly calls: CallRecord[] = [];
  constructor(private readonly handler: Handler) {}
  async call<T>(path: string, init?: RequestInit, body?: unknown): Promise<T> {
    this.calls.push({ path, init, body });
    return this.handler(path, init, body) as T;
  }
}

function makeApi(handler: Handler) {
  const fake = new FakeGatewayClient(handler);
  return { api: new BuiltAppsApi(fake as unknown as GatewayClient), fake };
}

function makeSpec(id: string, opts: { name?: string; sheet?: string; fileId?: string } = {}): AppSpec {
  const spec = generateAppSpec(
    opts.name ?? 'Sales App',
    { sheet: opts.sheet ?? 'Sales', startRow: 0, startCol: 0, endRow: 12, endCol: 2, headerRow: true },
    [
      { name: 'Month', type: 'text' },
      { name: 'Region', type: 'text' },
      { name: 'Revenue', type: 'numeric' },
    ],
    { id },
  );
  return opts.fileId ? { ...spec, fileId: opts.fileId } : spec;
}

function view(spec: AppSpec): BuiltAppRecordView {
  return { appId: spec.id, fileId: spec.fileId ?? 'file-A', spec, createdAt: 1, updatedAt: 2 };
}

describe('BuiltAppsApi', () => {
  it('listApps unwraps specs and encodes the file id', async () => {
    const spec = makeSpec('app_1', { fileId: 'file-A' });
    const { api, fake } = makeApi(() => ({ ok: true, apps: [view(spec)] }));
    expect(await api.listApps('file-A')).toEqual([spec]);
    expect(fake.calls[0]!.path).toBe('/api/built-apps?fileId=file-A');
    expect(fake.calls[0]!.init?.method).toBe('GET');
  });

  it('createApp / updateApp / deleteApp hit the right routes', async () => {
    const spec = makeSpec('app_1', { fileId: 'file-A' });
    const { api, fake } = makeApi(() => ({ ok: true, app: view(spec) }));
    expect(await api.createApp('file-A', spec)).toEqual(spec);
    expect(fake.calls[0]!.path).toBe('/api/built-apps');
    expect((fake.calls[0]!.body as { fileId: string }).fileId).toBe('file-A');
    expect(await api.updateApp('file-A', spec)).toEqual(spec);
    expect(fake.calls[1]!.path).toBe('/api/built-apps/app_1');
    expect(fake.calls[1]!.init?.method).toBe('PUT');
    await api.deleteApp('file-A', 'app_1');
    expect(fake.calls[2]!.path).toBe('/api/built-apps/app_1?fileId=file-A');
    expect(fake.calls[2]!.init?.method).toBe('DELETE');
  });

  it('normalizes gateway errors to ProductApiError with the server message', async () => {
    const { api } = makeApi(() => {
      throw new Error('gateway 400: {"error":"invalid app spec: name is required","code":"INVALID_APP_SPEC"}');
    });
    await expect(api.listApps('file-A')).rejects.toMatchObject({
      status: 400,
      code: 'INVALID_APP_SPEC',
      message: 'invalid app spec: name is required',
    });
    await expect(api.listApps('file-A')).rejects.toBeInstanceOf(ProductApiError);
  });
});

describe('planBuiltAppSync', () => {
  it('fresh profile: server apps merge into an empty local list, nothing uploads', () => {
    const server = [makeSpec('app_1', { fileId: 'file-A' })];
    const plan = planBuiltAppSync({ local: [], server, fileId: 'file-A', sheetNames: ['Sales'] });
    expect(plan.uploads).toEqual([]);
    expect(plan.merged.map((a) => a.id)).toEqual(['app_1']);
  });

  it('server version wins for same-id apps; local-only stamped apps upload', () => {
    const localOld = makeSpec('app_1', { name: 'Old Name', fileId: 'file-A' });
    const localOnly = makeSpec('app_2', { fileId: 'file-A' });
    const serverNew = makeSpec('app_1', { name: 'Server Name', fileId: 'file-A' });
    const plan = planBuiltAppSync({
      local: [localOld, localOnly],
      server: [serverNew],
      fileId: 'file-A',
      sheetNames: ['Sales'],
    });
    expect(plan.uploads.map((a) => a.id)).toEqual(['app_2']);
    expect(plan.merged.find((a) => a.id === 'app_1')!.name).toBe('Server Name');
    expect(plan.merged.map((a) => a.id).sort()).toEqual(['app_1', 'app_2']);
  });

  it('legacy unbound apps upload only when their sheet is in the open workbook, stamped', () => {
    const legacy = makeSpec('app_old');
    const legacyOtherSheet = makeSpec('app_other', { sheet: 'Inventory' });
    const plan = planBuiltAppSync({
      local: [legacy, legacyOtherSheet],
      server: [],
      fileId: 'file-A',
      sheetNames: ['Sales', 'Sheet1'],
    });
    expect(plan.uploads).toHaveLength(1);
    expect(plan.uploads[0]!.id).toBe('app_old');
    expect(plan.uploads[0]!.fileId).toBe('file-A');
  });

  it('apps bound to another file are neither uploaded nor removed', () => {
    const other = makeSpec('app_x', { fileId: 'file-B' });
    const plan = planBuiltAppSync({ local: [other], server: [], fileId: 'file-A', sheetNames: ['Sales'] });
    expect(plan.uploads).toEqual([]);
    expect(plan.merged.map((a) => a.id)).toEqual(['app_x']);
  });

  it('already-server apps are deduped out of uploads', () => {
    const spec = makeSpec('app_1', { fileId: 'file-A' });
    const plan = planBuiltAppSync({ local: [spec], server: [spec], fileId: 'file-A', sheetNames: ['Sales'] });
    expect(plan.uploads).toEqual([]);
    expect(plan.merged).toHaveLength(1);
  });
});
