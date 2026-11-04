/**
 * F-9 regression: the viewer-role gate on EVERY mutating engine route.
 *
 * The 2026-10-22 security pass found that only /charts, /execute and /ops
 * refused `role === 'viewer'`; a viewer share token could call /load
 * (replace the live workbook under its editors), /session/release
 * (evict the session — F-8), /library-save, /reset, the protection
 * routes and more. Every mutating route now applies the identical
 * guard. These tests pin, per route: a signed viewer token gets
 * 403 { ok:false, rejected:true, reason:'viewer-role' } and NO state
 * changes; an editor token is not refused by the gate.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { XlsxAdapter } from '@icecream-sheets/xlsx-adapter';
import { createEngineListener } from '../src/services/engineSvc.js';
import { issueEngineAccessToken } from '../src/deploy/engineAccess.js';
import { MemoryFileRegistry } from '../src/deploy/fileRegistry.js';
import { MemorySessionStores } from '../src/deploy/sessionStore.js';
import { httpJson, startServer, stop, type Started } from './helpers.js';

const SECRET = 'viewer-gates-test-secret';

function tinyXlsxBase64(marker = 10): string {
  const bytes = new XlsxAdapter().write({
    sheets: [{ name: 'Sheet1', rows: [[marker, 20], [null, '=A1+B1']] }],
    metadata: {},
  } as never);
  return Buffer.from(bytes).toString('base64');
}

function tokenFor(principal: string, sid: string, fid: string, role: 'editor' | 'viewer'): string {
  return issueEngineAccessToken({
    secret: SECRET,
    principal,
    sessionId: sid,
    tier: 'standard',
    fid,
    role,
  }).token;
}

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

const VIEWER_REFUSAL = { ok: false, rejected: true, reason: 'viewer-role' };

describe('F-9: viewer-role gate on every mutating engine route', () => {
  let svc: Started | null = null;

  afterEach(async () => {
    if (svc) await stop(svc);
    svc = null;
  });

  async function setup() {
    svc = await startServer(
      createEngineListener({
        sessionStores: new MemorySessionStores(),
        fileRegistry: new MemoryFileRegistry(),
        deployEnv: {
          ENGINE_ACCESS_MODE: 'signed',
          ENGINE_ACCESS_SECRET: SECRET,
          AUTOSAVE_CHECKPOINT_SETTLE_MS: '0',
        } as NodeJS.ProcessEnv,
      }),
    );
    const fid = 'file-viewer-gates';
    const sid = 'sess-viewer-gates';
    const editor = tokenFor('user:alice', sid, fid, 'editor');
    const viewer = tokenFor('user:carol', sid, fid, 'viewer');
    const claim = await httpJson('POST', `${svc.url}/session/claim`, {
      headers: bearer(editor),
      body: { fileId: fid, sessionId: sid },
    });
    expect(claim.status).toBe(200);
    const load = await httpJson('POST', `${svc.url}/load`, {
      headers: bearer(editor),
      body: { format: 'xlsx', data: tinyXlsxBase64(), sessionId: sid },
    });
    expect(load.status).toBe(200);
    return { fid, sid, editor, viewer };
  }

  function post(token: string, path: string, body: unknown) {
    return httpJson('POST', `${svc!.url}${path}`, { headers: bearer(token), body });
  }

  it('viewer is refused on every newly gated mutating route, with no side effects', async () => {
    const { editor, viewer } = await setup();

    const attempts: Array<[string, unknown]> = [
      ['/session-bind-library', { id: 'lib-1', name: 'Hijacked' }],
      ['/session-extras', { extras: {} }],
      ['/language', { locale: 'de-DE' }],
      ['/library-save', { id: 'lib-1', name: 'Hijacked' }],
      ['/protection/hide', { sheet: 'Sheet1', ranges: ['A1'] }],
      ['/protection/protect', { sheet: 'Sheet1', lockedRanges: ['A1:B2'] }],
      ['/reset', {}],
      // A VALID release body — so the refusal is the role, not the shape.
      ['/session/release', { sessionId: 'sess-viewer-gates' }],
    ];
    for (const [path, body] of attempts) {
      const res = await post(viewer, path, body);
      expect(res.status, `viewer POST ${path}`).toBe(403);
      expect(res.json, `viewer POST ${path}`).toMatchObject(VIEWER_REFUSAL);
    }

    // The /load family: a viewer token must never replace the workbook.
    for (const [path, body] of [
      ['/load', { format: 'xlsx', data: tinyXlsxBase64(999), sessionId: 'sess-viewer-gates' }],
      [
        '/load/storage-ref',
        { storageRef: 'gs://bucket/evil.xlsx', sessionId: 'sess-viewer-gates' },
      ],
      ['/load/stream', { format: 'xlsx', data: tinyXlsxBase64(999), sessionId: 'sess-viewer-gates' }],
    ] as Array<[string, unknown]>) {
      const res = await post(viewer, path, body);
      expect(res.status, `viewer POST ${path}`).toBe(403);
      expect(res.json, `viewer POST ${path}`).toMatchObject(VIEWER_REFUSAL);
    }

    // No side effects: the session survived the viewer's release/reset
    // attempts and the workbook still holds the editor's content.
    const status = await httpJson('GET', `${svc!.url}/session/status`, {
      headers: bearer(editor),
    });
    expect((status.json as { status: string }).status).toBe('active');
    const read = await post(editor, '/read', {
      kind: 'cell',
      ref: { sheet: 'Sheet1', row: 0, col: 0 },
    });
    expect(read.status).toBe(200);
    expect((read.json as { value: { value: number } }).value.value).toBe(10);
  });

  it('viewer keeps the read surface (reads are not gated)', async () => {
    const { viewer } = await setup();
    for (const path of ['/session/status', '/sheets']) {
      const res = await httpJson('GET', `${svc!.url}${path}`, { headers: bearer(viewer) });
      expect(res.status, `viewer GET ${path}`).toBe(200);
    }
    // /read is POST-shaped but a pure read — it stays open to viewers.
    const read = await post(viewer, '/read', {
      kind: 'cell',
      ref: { sheet: 'Sheet1', row: 0, col: 0 },
    });
    expect(read.status).toBe(200);
    expect((read.json as { value: { value: number } }).value.value).toBe(10);
  });

  it('editor is not refused by the gate on the same routes', async () => {
    const { editor, sid } = await setup();

    const language = await post(editor, '/language', { locale: 'frFR' });
    expect(language.status).toBe(200);

    const extras = await post(editor, '/session-extras', { extras: {} });
    expect(extras.status).toBe(200);

    const save = await post(editor, '/library-save', { id: 'lib-1', name: 'Saved' });
    expect(save.status).toBe(200);

    // Bind requires an existing library entry — created by the save above.
    const bind = await post(editor, '/session-bind-library', { id: 'lib-1', name: 'Saved' });
    expect(bind.status).toBe(200);

    const protect = await post(editor, '/protection/protect', {
      sheet: 'Sheet1',
      lockedRanges: ['A1:B2'],
    });
    expect(protect.status).toBe(200);

    const hide = await post(editor, '/protection/hide', { sheet: 'Sheet1', ranges: ['A1'] });
    expect(hide.status).toBe(200);

    // /load/storage-ref as editor: NOT a viewer-role refusal (it fails
    // later, on the storage fetch — no bucket exists in this harness).
    const storageRef = await post(editor, '/load/storage-ref', {
      storageRef: 'gs://bucket/none.xlsx',
      sessionId: sid,
    });
    expect(storageRef.json).not.toMatchObject(VIEWER_REFUSAL);

    const reload = await post(editor, '/load', {
      format: 'xlsx',
      data: tinyXlsxBase64(),
      sessionId: sid,
    });
    expect(reload.status).toBe(200);

    const release = await post(editor, '/session/release', { sessionId: sid });
    expect(release.status).toBe(200);
  });
});
