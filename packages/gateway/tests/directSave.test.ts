/**
 * Direct streaming save (gateway): Excel save sequence guarantees +
 * save/download separation.
 *
 * 1. RECALC-FIRST REGRESSION: a deep chain (500 links) edited at its
 *    head and IMMEDIATELY downloaded must carry the post-recalc cached
 *    value in its LAST cell — never the stale pre-edit value. The
 *    assertion reads the cached <v> out of the saved sheet XML (the
 *    surface a stale save would actually corrupt; re-loading the file
 *    would recompute from formulas and mask it).
 * 2. TEMP → VERIFY → ATOMIC REPLACE under a FORCED MID-WRITE FAILURE
 *    (ICECREAM_SAVE_FAULT_INJECT='midwrite', read by the shared
 *    serializer at call time, so toggling process.env mid-test works
 *    against the in-process service): a failed library-save must leave
 *    the previously stored file BYTE-IDENTICAL and loadable, a failed
 *    /download must be an error (never a partial file streamed as
 *    success), and the engine must stay responsive throughout.
 * 3. SAVE/DOWNLOAD SEPARATION: /download (xlsx, workbook scope) is a
 *    SAVE — it commits into the library store and returns JSON
 *    metadata only ({ ok, entryId, revision, bytes, mode, … }); the
 *    bytes are fetched afterwards from GET /storage/:entryId with a
 *    gateway-signed URL (POST /api/storage/sign), directly from the
 *    engine service. /library-save is signal-only too and reports the
 *    pinned `revision` it serialized.
 * 4. OPS DURING A SAVE: an /execute issued while a save is in flight
 *    lands at a LATER revision than the save's pinned revision, is
 *    absent from the saved file, and is present in the live model.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unzipSync } from 'fflate';
import { XlsxAdapter } from '@icecream-sheets/xlsx-adapter';
import { createEngineListener } from '../src/services/engineSvc.js';
import { createGateway } from '../src/gateway.js';
import { httpJson, startServer, stop, type Started } from './helpers.js';

const ALICE = { 'x-principal': 'user:alice' };
const decoder = new TextDecoder();

interface DownloadMeta {
  ok: boolean;
  entryId: string;
  revision: number;
  bytes: number;
  mode: string;
  serializeMs: number;
  totalMs: number;
}

function smallWorkbookBytes(): Uint8Array {
  return new XlsxAdapter().write({
    sheets: [
      { name: 'Data', rows: [[1, 2], ['=A1+B1', 'x']] },
      { name: 'Other', rows: [['keep', 42]] },
    ],
    metadata: {},
    definedNames: [{ name: 'Cost', ref: 'Data!$A$1' }],
  });
}

function chainWorkbookBytes(links: number): Uint8Array {
  const rows: unknown[][] = [[1]];
  for (let i = 1; i <= links; i++) rows.push([`=A${i}+1`]);
  return new XlsxAdapter().write({
    sheets: [{ name: 'Chain', rows: rows as never }],
    metadata: {},
  });
}

describe('direct save: Excel save sequence + separation', () => {
  let svc: Started | null = null;
  let gw: Started | null = null;
  const tmpdirs: string[] = [];
  afterEach(async () => {
    delete process.env.ICECREAM_SAVE_FAULT_INJECT;
    if (svc) await stop(svc);
    svc = null;
    if (gw) await stop(gw);
    gw = null;
    for (const d of tmpdirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  function post(path: string, body: unknown) {
    return httpJson('POST', `${svc!.url}${path}`, { headers: ALICE, body });
  }

  /** POST/GET /download on the engine service → its JSON metadata. */
  async function downloadMeta(
    init?: { method?: string; body?: unknown },
    headers: Record<string, string> = ALICE,
  ): Promise<{ res: Response; meta: DownloadMeta }> {
    const res = await fetch(`${svc!.url}/download`, {
      method: init?.method ?? 'GET',
      headers:
        init?.body !== undefined
          ? { 'content-type': 'application/json', ...headers }
          : headers,
      body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
    const meta = (await res.json()) as DownloadMeta;
    expect(meta.ok).toBe(true);
    expect(meta.entryId).toMatch(/^autosave_[A-Za-z0-9._-]+$/);
    return { res, meta };
  }

  /** Fetch a committed store entry's bytes via the engine's library route. */
  async function entryBytes(entryId: string, headers: Record<string, string> = ALICE): Promise<Uint8Array> {
    const r = await fetch(`${svc!.url}/library/${entryId}`, { headers });
    expect(r.status).toBe(200);
    return new Uint8Array(await r.arrayBuffer());
  }

  it('download returns metadata only (mode visible); bytes live in the committed entry', async () => {
    svc = await startServer(createEngineListener());
    const bytes = smallWorkbookBytes();
    await post('/load', { format: 'xlsx', data: Buffer.from(bytes).toString('base64') });
    const { meta } = await downloadMeta();
    expect(meta.mode).toBe('verbatim');
    expect(meta.bytes).toBeGreaterThan(0);
    expect(typeof meta.revision).toBe('number');
    const back = new XlsxAdapter().read(await entryBytes(meta.entryId));
    expect(back.sheets.find((s) => s.name === 'Other')!.rows[0]).toEqual(['keep', 42]);
  }, 30_000);

  it('recalc-first: deep chain (500 links) edited then immediately downloaded carries post-recalc values', async () => {
    const LINKS = 500;
    svc = await startServer(createEngineListener());
    const bytes = chainWorkbookBytes(LINKS);
    const load = await post('/load', { format: 'xlsx', data: Buffer.from(bytes).toString('base64') });
    expect(load.status).toBe(200);
    // Edit the chain head, then IMMEDIATELY download — no settle delay.
    const ex = await post('/execute', {
      cmd: { cmd: 'setCell', ref: { sheet: 'Chain', row: 0, col: 0 }, value: 100 },
    });
    expect(ex.status).toBe(200);
    const { meta } = await downloadMeta();
    const outBytes = await entryBytes(meta.entryId);
    // The formula survives parse-back…
    const back = new XlsxAdapter().read(outBytes);
    expect(back.sheets.find((s) => s.name === 'Chain')!.rows[LINKS]).toEqual([`=A${LINKS}+1`]);
    // …and the CACHED value of the last chain cell (A501) is the
    // post-recalc 100 + 500 = 600, not the stale pre-edit 1 + 500 = 501.
    const parts = unzipSync(outBytes.slice()) as Record<string, Uint8Array>;
    const sheetPart = Object.keys(parts).find((k) => /xl\/worksheets\/sheet\d+\.xml$/.test(k))!;
    const xml = decoder.decode(parts[sheetPart]!);
    const cell = new RegExp(`<c r="A${LINKS + 1}"[^>]*>([\\s\\S]*?)</c>`).exec(xml);
    expect(cell, 'last chain cell present in saved sheet XML').not.toBeNull();
    const v = /<v>([^<]+)<\/v>/.exec(cell![1]!);
    expect(v, 'last chain cell carries a cached value').not.toBeNull();
    expect(Number(v![1])).toBe(600);
  }, 60_000);

  it('forced mid-write failure: stored library file stays byte-identical, download errors, engine survives', async () => {
    const libDir = mkdtempSync(join(tmpdir(), 'icecream-direct-lib-'));
    tmpdirs.push(libDir);
    svc = await startServer(createEngineListener({ libraryDir: libDir }));
    const bytes = smallWorkbookBytes();
    await post('/load', { format: 'xlsx', data: Buffer.from(bytes).toString('base64') });

    const fetchLibrary = async (): Promise<Uint8Array> => {
      const r = await fetch(`${svc!.url}/library/faultwb`, { headers: ALICE });
      expect(r.status).toBe(200);
      return new Uint8Array(await r.arrayBuffer());
    };
    const hash = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');

    // Baseline save (no fault): succeeds, stores, and reports the
    // pinned revision it serialized (signal-only save contract).
    const save1 = await post('/library-save', { id: 'faultwb', name: 'fault.xlsx' });
    expect(save1.status).toBe(200);
    expect(typeof (save1.json as { revision: unknown }).revision).toBe('number');
    // Metadata only: the response carries no workbook bytes.
    expect(JSON.stringify(save1.json).length).toBeLessThan(2000);
    const stored1 = await fetchLibrary();
    const hash1 = hash(stored1);
    expect(new XlsxAdapter().read(stored1).sheets.map((s) => s.name)).toEqual(['Data', 'Other']);

    // Edit so the faulted re-save must REGENERATE a sheet (the shared
    // serializer's midwrite fault fires on the first regenerated part
    // it feeds to the zip — a fully-verbatim save has no mid-write
    // generation point to fault at).
    const edit = await post('/execute', {
      cmd: { cmd: 'setCell', ref: { sheet: 'Data', row: 0, col: 0 }, value: 99 },
    });
    expect(edit.status).toBe(200);

    // Fault ON: the shared serializer throws mid-write.
    process.env.ICECREAM_SAVE_FAULT_INJECT = 'midwrite';
    try {
      const save2 = await post('/library-save', { id: 'faultwb', name: 'fault.xlsx' });
      expect(save2.status).toBe(500);
      // The pre-existing library file was NOT touched before the
      // (never-reached) atomic replace: byte-identical, still parses.
      const stored2 = await fetchLibrary();
      expect(hash(stored2)).toBe(hash1);
      expect(Buffer.from(stored2)).toEqual(Buffer.from(stored1));
      expect(new XlsxAdapter().read(stored2).sheets.map((s) => s.name)).toEqual(['Data', 'Other']);
      // A /download under the fault is an ERROR — nothing is committed
      // and no partial file is ever presented as a success.
      const dl = await fetch(`${svc!.url}/download`, { headers: ALICE });
      expect(dl.status).toBe(500);
      expect(await dl.text()).toMatch(/download serialization failed/);
    } finally {
      delete process.env.ICECREAM_SAVE_FAULT_INJECT;
    }

    // Fault OFF: saves succeed again and the engine is fully usable.
    const save3 = await post('/library-save', { id: 'faultwb', name: 'fault.xlsx' });
    expect(save3.status).toBe(200);
    const health = await httpJson('GET', `${svc!.url}/health`);
    expect(health.status).toBe(200);
    const ex = await post('/execute', {
      cmd: { cmd: 'setCell', ref: { sheet: 'Data', row: 0, col: 0 }, value: 7 },
    });
    expect(ex.status).toBe(200);
    const rd = await post('/read', { kind: 'cell', ref: { sheet: 'Data', row: 0, col: 0 } });
    expect((rd.json as { value: { value: number } }).value.value).toBe(7);
  }, 30_000);

  it('ops during a save (Addendum 4 pin): cross-sheet edit is stashed out of the frozen bulk; live model advances; workbook dirty again', async () => {
    const libDir = mkdtempSync(join(tmpdir(), 'icecream-direct-ops-'));
    tmpdirs.push(libDir);
    svc = await startServer(createEngineListener({ libraryDir: libDir }));
    // Sheet1!A1 = 10; Sheet3!A1 = '=Sheet1!A1*2' (cross-sheet
    // dependent, cached 20). Filler sheets (40k cells) make the save's
    // pinned read phase measurably long; the read yields between
    // sheets, so the edit genuinely processes mid-save and the host's
    // copy-on-write stash is what keeps the bulk consistent.
    const filler = (): number[][] => {
      const rows: number[][] = [];
      for (let r = 0; r < 100; r++) {
        const row: number[] = [];
        for (let c = 0; c < 100; c++) row.push(r * 100 + c);
        rows.push(row);
      }
      return rows;
    };
    const bytes = new XlsxAdapter().write({
      sheets: [
        { name: 'Sheet1', rows: [[10]] },
        { name: 'Filler1', rows: filler() },
        { name: 'Filler2', rows: filler() },
        { name: 'Filler3', rows: filler() },
        { name: 'Filler4', rows: filler() },
        { name: 'Sheet3', rows: [['=Sheet1!A1*2']] },
      ],
      metadata: {},
    });
    const load = await post('/load', { format: 'xlsx', data: Buffer.from(bytes).toString('base64') });
    expect(load.status).toBe(200);
    // Pre-save edit ON Sheet3 (an unrelated cell): puts Sheet3 in the
    // changed set so the save REGENERATES it from the pinned bulk —
    // its A1 cached value then comes from the engine (20), not from
    // the SheetJS-written source part (which carries no computed
    // cache for the formula).
    const pre = await post('/execute', {
      cmd: { cmd: 'setCell', ref: { sheet: 'Sheet3', row: 0, col: 1 }, value: 5 },
    });
    expect(pre.status).toBe(200);

    // Start the save, then — while its read phase is in flight —
    // issue the CROSS-SHEET edit (Sheet1 cell; dependent on Sheet3).
    const savePromise = fetch(`${svc!.url}/download`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...ALICE },
      body: JSON.stringify({ format: 'xlsx' }),
    });
    await new Promise((r) => setTimeout(r, 25));
    const exPromise = post('/execute', {
      cmd: { cmd: 'setCell', ref: { sheet: 'Sheet1', row: 0, col: 0 }, value: 99 },
      ackChecksum: true,
    });
    const [saveRes, ex] = await Promise.all([savePromise, exPromise]);
    // BOTH complete ok (the edit was stashed-applied or queued, never lost).
    expect(saveRes.status).toBe(200);
    expect(ex.status).toBe(200);
    const meta = (await saveRes.json()) as DownloadMeta;
    const exRevision = (ex.json as { ack: { revision: number } }).ack.revision;
    // The edit landed at a LATER revision than the save's pinned cut.
    expect(exRevision).toBeGreaterThan(meta.revision);

    // The saved file is internally consistent AT THE PIN: Sheet1
    // holds the OLD input/value (10) and Sheet3's dependent holds the
    // OLD cached value (20) matching it — not the new input with a
    // stale value, nor the new value (198).
    const outBytes = await entryBytes(meta.entryId);
    const back = new XlsxAdapter().read(outBytes);
    expect(back.sheets.find((s) => s.name === 'Sheet1')!.rows[0]![0]).toBe(10);
    expect(back.sheets.find((s) => s.name === 'Sheet3')!.rows[0]![0]).toBe('=Sheet1!A1*2');
    const parts = unzipSync(outBytes.slice()) as Record<string, Uint8Array>;
    const sheet3Xml = Object.values(parts)
      .map((p) => decoder.decode(p))
      .find((xml) => xml.includes('Sheet1!A1'));
    expect(sheet3Xml, 'Sheet3 part carries the cross-sheet formula').toBeTruthy();
    expect(sheet3Xml).toContain('<v>20</v>');
    expect(sheet3Xml).not.toContain('<v>198</v>');

    // The live model holds the edit afterwards, fully recalculated.
    const rd1 = await post('/read', { kind: 'cell', ref: { sheet: 'Sheet1', row: 0, col: 0 } });
    expect((rd1.json as { value: { value: unknown } }).value.value).toBe(99);
    const rd3 = await post('/read', { kind: 'cell', ref: { sheet: 'Sheet3', row: 0, col: 0 } });
    expect((rd3.json as { value: { value: unknown } }).value.value).toBe(198);

    // And the workbook is DIRTY again: live revision has moved past
    // the revision the stored copy holds.
    const status = await httpJson('GET', `${svc!.url}/session/status`, { headers: ALICE });
    const st = status.json as { revision: number; storageRevision: number };
    expect(st.storageRevision).toBe(meta.revision);
    expect(st.revision).toBeGreaterThan(st.storageRevision);
  }, 120_000);

  it('autosave (Addendum 3): continuous editing during checkpointing loses nothing; intermediate batch is a valid cut; caught-up save skips serialization', async () => {
    const libDir = mkdtempSync(join(tmpdir(), 'icecream-autosave-'));
    tmpdirs.push(libDir);
    svc = await startServer(
      createEngineListener({
        libraryDir: libDir,
        deployEnv: { ...process.env, AUTOSAVE_CHECKPOINT_SETTLE_MS: '200' },
      }),
    );
    const bigRows: number[][] = [];
    for (let r = 0; r < 250; r++) {
      const row: number[] = [];
      for (let c = 0; c < 200; c++) row.push(r * 200 + c);
      bigRows.push(row);
    }
    const dataRows: number[][] = Array.from({ length: 10 }, () => Array(10).fill(0) as number[]);
    const bytes = new XlsxAdapter().write({
      sheets: [
        { name: 'Big', rows: bigRows },
        { name: 'Data', rows: dataRows },
      ],
      metadata: {},
    });
    const load = await post('/load', { format: 'xlsx', data: Buffer.from(bytes).toString('base64') });
    expect(load.status).toBe(200);
    const sessionId = (load.json as { sessionId: string }).sessionId;
    const autosaveId = `autosave_${sessionId}`;

    const statusOf = async (): Promise<{ revision: number; storageRevision: number }> => {
      const st = await httpJson('GET', `${svc!.url}/session/status`, { headers: ALICE });
      return st.json as { revision: number; storageRevision: number };
    };
    const waitFor = async (cond: () => Promise<boolean>, label: string): Promise<void> => {
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline) {
        if (await cond()) return;
        await new Promise((r) => setTimeout(r, 100));
      }
      throw new Error(`timed out waiting for: ${label}`);
    };

    // Batch 1: one edit; the settle scheduler checkpoints it.
    await post('/execute', { cmd: { cmd: 'setCell', ref: { sheet: 'Data', row: 0, col: 0 }, value: 111 } });
    await waitFor(async () => (await statusOf()).storageRevision >= 1, 'first autosave checkpoint');
    // The INTERMEDIATE committed batch: a complete valid workbook at
    // its revision cut — A1 holds the batch-1 value; B1 (edited only
    // later) still holds its pre-cut value.
    const intermediate = new XlsxAdapter().read(await entryBytes(autosaveId));
    expect(intermediate.sheets.find((s) => s.name === 'Data')!.rows[0]![0]).toBe(111);
    expect(intermediate.sheets.find((s) => s.name === 'Data')!.rows[0]![1]).toBe(0);

    // Continuous editing: 20 rounds of paired edits, spaced so
    // several land while checkpoints of the 50k-cell workbook run.
    for (let i = 0; i < 20; i++) {
      await post('/execute', {
        cmd: { cmd: 'setCell', ref: { sheet: 'Data', row: 0, col: 0 }, value: 200 + i },
      });
      await post('/execute', {
        cmd: { cmd: 'setCell', ref: { sheet: 'Data', row: 0, col: 1 }, value: 500 + i },
      });
      await new Promise((r) => setTimeout(r, 30));
    }

    // Addendum 6.1: the SERVER scheduler alone must catch storage up
    // — no save call at all. From here on only READS happen (status
    // polls, the background-tab equivalent: the client goes silent
    // and the stored copy still converges to the live revision).
    await waitFor(async () => {
      const s = await statusOf();
      return s.storageRevision === s.revision;
    }, 'scheduler-only catch-up to the live revision');
    const st = await statusOf();
    expect(st.storageRevision).toBe(st.revision);

    // Final stored file: EVERY edit's final value, exactly (no lost
    // op, no double-applied op).
    const finalBack = new XlsxAdapter().read(await entryBytes(autosaveId));
    expect(finalBack.sheets.find((s) => s.name === 'Data')!.rows[0]![0]).toBe(219);
    expect(finalBack.sheets.find((s) => s.name === 'Data')!.rows[0]![1]).toBe(519);

    // Save click with nothing pending: NO serialization happens.
    const again = await post('/library-save', {});
    expect(again.status).toBe(200);
    const aj = again.json as { skipped: boolean; flushedOps: number; caughtUp: boolean };
    expect(aj.skipped).toBe(true);
    expect(aj.flushedOps).toBe(0);
    expect(aj.caughtUp).toBe(true);
  }, 180_000);

  it('autosave ownership + no-op rule + extras sync (Addendum 6)', async () => {
    const libDir = mkdtempSync(join(tmpdir(), 'icecream-autosave6-'));
    tmpdirs.push(libDir);
    svc = await startServer(
      createEngineListener({
        libraryDir: libDir,
        deployEnv: { ...process.env, AUTOSAVE_CHECKPOINT_SETTLE_MS: '200' },
      }),
    );
    const bytes = new XlsxAdapter().write({
      sheets: [{ name: 'Data', rows: [[1, 2], [3, 4]] }],
      metadata: {},
    });
    const load = await post('/load', { format: 'xlsx', data: Buffer.from(bytes).toString('base64') });
    expect(load.status).toBe(200);
    const sessionId = (load.json as { sessionId: string }).sessionId;
    const autosaveId = `autosave_${sessionId}`;
    const saveStatus = async () =>
      (await httpJson('GET', `${svc!.url}/session-save-status`, { headers: ALICE })).json as {
        liveRevision: number;
        storageRevision: number;
        extrasDirty: boolean;
        autosaveStats: { flushes: number; noopSkips: number; forcedFlushes: number };
      };
    const waitFor = async (cond: () => Promise<boolean>, label: string): Promise<void> => {
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline) {
        if (await cond()) return;
        await new Promise((r) => setTimeout(r, 100));
      }
      throw new Error(`timed out waiting for: ${label}`);
    };
    const storedFile = () => {
      const names = readdirSync(libDir).filter((n) => n.endsWith('.xlsx'));
      expect(names.length).toBe(1);
      const p = join(libDir, names[0]!);
      return { bytes: readFileSync(p), mtimeMs: statSync(p).mtimeMs };
    };

    // Force save #1: creates the stored copy (a real flush).
    const fs1 = await post('/library-save', {});
    expect(fs1.status).toBe(200);
    const before = await saveStatus();
    expect(before.storageRevision).toBe(before.liveRevision);
    expect(before.autosaveStats.flushes).toBe(1);
    expect(before.autosaveStats.forcedFlushes).toBe(1);
    const snap1 = storedFile();

    // STRICT NO-OP: force save with nothing pending + idle settle
    // windows — zero writes: stored bytes AND mtime unchanged,
    // flushes unchanged, noopSkips incremented.
    const skip = await post('/library-save', {});
    expect(skip.status).toBe(200);
    expect((skip.json as { skipped: boolean }).skipped).toBe(true);
    await new Promise((r) => setTimeout(r, 650));
    const afterSkip = await saveStatus();
    expect(afterSkip.autosaveStats.flushes).toBe(before.autosaveStats.flushes);
    expect(afterSkip.autosaveStats.noopSkips).toBeGreaterThan(before.autosaveStats.noopSkips);
    const snap2 = storedFile();
    expect(snap2.bytes.equals(snap1.bytes)).toBe(true);
    expect(snap2.mtimeMs).toBe(snap1.mtimeMs);

    // One edit → exactly ONE flush over several settle periods.
    const flushesBeforeEdit = afterSkip.autosaveStats.flushes;
    const ex = await post('/execute', {
      cmd: { cmd: 'setCell', ref: { sheet: 'Data', row: 0, col: 0 }, value: 42 },
      ackChecksum: true,
    });
    expect(ex.status).toBe(200);
    // The /execute ack carries the live-vs-stored pair (Addendum 6.2).
    const ackJson = ex.json as { liveRevision: number; storageRevision: number };
    expect(ackJson.liveRevision).toBe(1);
    expect(ackJson.storageRevision).toBe(0);
    await waitFor(async () => (await saveStatus()).storageRevision === 1, 'single edit flushed');
    await new Promise((r) => setTimeout(r, 650));
    const afterEdit = await saveStatus();
    expect(afterEdit.autosaveStats.flushes).toBe(flushesBeforeEdit + 1);

    // EXTRAS CONTINUOUS SYNC: a style-only push (no cell ops, no save
    // call) is flushed by the server scheduler into the stored file.
    const push = await post('/session-extras', {
      sheetStyles: { Data: { '0:0': { bold: true, numberFormatCode: '0.00%' } } },
    });
    expect(push.status).toBe(200);
    expect((push.json as { extrasDirty: boolean }).extrasDirty).toBe(true);
    await waitFor(async () => !(await saveStatus()).extrasDirty, 'extras flushed by scheduler');
    const withStyle = new XlsxAdapter().read(await entryBytes(autosaveId));
    expect(withStyle.sheets[0]!.styles?.['0:0']?.bold).toBe(true);
    expect(withStyle.sheets[0]!.styles?.['0:0']?.numberFormatCode).toBe('0.00%');
    // ...and the cell edit survived the extras flush.
    expect(withStyle.sheets[0]!.rows[0]![0]).toBe(42);

    // Identical extras resend: does NOT dirty, does NOT flush.
    const flushesBeforeResend = (await saveStatus()).autosaveStats.flushes;
    const resend = await post('/session-extras', {
      sheetStyles: { Data: { '0:0': { bold: true, numberFormatCode: '0.00%' } } },
    });
    expect(resend.status).toBe(200);
    expect((resend.json as { extrasDirty: boolean }).extrasDirty).toBe(false);
    await new Promise((r) => setTimeout(r, 500));
    expect((await saveStatus()).autosaveStats.flushes).toBe(flushesBeforeResend);
  }, 120_000);

  it('session-extras accepts media-sized extras (File-2 D1 follow-up)', async () => {
    const libDir = mkdtempSync(join(tmpdir(), 'icecream-extras-media-'));
    tmpdirs.push(libDir);
    svc = await startServer(createEngineListener({ libraryDir: libDir }));
    const bytes = new XlsxAdapter().write({
      sheets: [{ name: 'Data', rows: [[1]] }],
      metadata: {},
    });
    const load = await post('/load', { format: 'xlsx', data: Buffer.from(bytes).toString('base64') });
    expect(load.status).toBe(200);
    // A media-bearing workbook's extras carry its imported pictures as
    // base64 data URLs in `icecream.pictures` — File-2's 23 pictures
    // total ~1.3 MiB, over the 1 MiB default body cap this route used
    // to fall back to (the pushes were rejected; extras never synced).
    const bigDataUrl = `data:image/png;base64,${'A'.repeat(1_300_000)}`;
    const push = await post('/session-extras', {
      extraMetadata: {
        'icecream.pictures': [
          { id: 1, x: 0, y: 0, w: 100, h: 100, dataUrl: bigDataUrl, name: 'big', sheet: 'Data' },
        ],
      },
    });
    expect(push.status).toBe(200);
    expect((push.json as { extrasDirty: boolean }).extrasDirty).toBe(true);
  }, 120_000);

  it('batch materialization + structural barrier + journal≠file (Addendum 5)', async () => {
    const libDir = mkdtempSync(join(tmpdir(), 'icecream-batch-'));
    tmpdirs.push(libDir);
    svc = await startServer(createEngineListener({ libraryDir: libDir }));
    const dataRows: number[][] = Array.from({ length: 5 }, () => Array(5).fill(0) as number[]);
    const bytes = new XlsxAdapter().write({
      sheets: [{ name: 'Data', rows: dataRows }],
      metadata: {},
    });
    const load = await post('/load', { format: 'xlsx', data: Buffer.from(bytes).toString('base64') });
    expect(load.status).toBe(200);
    const sessionId = (load.json as { sessionId: string }).sessionId;
    const autosaveId = `autosave_${sessionId}`;
    const set = (row: number, col: number, value: unknown) =>
      post('/execute', { cmd: { cmd: 'setCell', ref: { sheet: 'Data', row, col }, value } });

    // One batch: X (A1) edited by 3 ops, Y (B1) by 1 op, one sheet.
    await set(0, 0, 1);
    await set(0, 0, 2);
    await set(0, 0, 3);
    await set(0, 1, 7);
    const flush = await post('/library-save', {});
    expect(flush.status).toBe(200);
    const fj = flush.json as { changedSheets: string[]; flushedOps: number };
    // The batch's 4 ops were all flushed…
    expect(fj.flushedOps).toBe(4);
    // …and the sheet was regenerated ONCE for the whole batch.
    expect(fj.changedSheets).toEqual(['Data']);
    // Materialization: final value per cell, written once — the
    // intermediate values 1 and 2 never reach the file.
    let back = new XlsxAdapter().read(await entryBytes(autosaveId));
    expect(back.sheets[0]!.rows[0]![0]).toBe(3);
    expect(back.sheets[0]!.rows[0]![1]).toBe(7);

    // STRUCTURAL BARRIER: a pending cell edit, then a structural op.
    // The barrier flushes the edit's batch (pre-structural layout)
    // BEFORE the insert applies.
    await set(0, 0, 10);
    const ins = await post('/execute', { cmd: { cmd: 'insertRows', sheet: 'Data', row: 0, count: 1 } });
    expect(ins.status).toBe(200);
    // Immediately after: the stored copy is the BARRIER commit —
    // pre-insert layout, A1=10, B1=7 (the insert belongs to the NEXT
    // batch and is not in storage yet).
    back = new XlsxAdapter().read(await entryBytes(autosaveId));
    expect(back.sheets[0]!.rows[0]![0]).toBe(10);
    expect(back.sheets[0]!.rows[0]![1]).toBe(7);
    // Live model: the insert applied on top of the flushed batch.
    const rdA2 = await post('/read', { kind: 'cell', ref: { sheet: 'Data', row: 1, col: 0 } });
    expect((rdA2.json as { value: { value: unknown } }).value.value).toBe(10);

    // JOURNAL ≠ FILE: flush the structural batch, then release +
    // rehydrate — the journal/snapshot replay must reproduce the
    // identical final state (rehydrate hard-verifies the full-state
    // checksum; a mismatch is a 409, never a silent unlock).
    const flush2 = await post('/library-save', {});
    expect(flush2.status).toBe(200);
    back = new XlsxAdapter().read(await entryBytes(autosaveId));
    expect(back.sheets[0]!.rows[1]![0]).toBe(10);
    expect(back.sheets[0]!.rows[0]![0]).toBeNull();

    const rel = await post('/session/release', { sessionId });
    expect(rel.status).toBe(200);
    const re = await post('/session/rehydrate', { sessionId });
    expect(re.status).toBe(200);
    expect((re.json as { checksumVerified: boolean }).checksumVerified).toBe(true);
    const rdAfter = await post('/read', { kind: 'cell', ref: { sheet: 'Data', row: 1, col: 0 } });
    expect((rdAfter.json as { value: { value: unknown } }).value.value).toBe(10);
  }, 120_000);

  it('storage separation e2e: gateway signs, engine serves the committed bytes directly', async () => {
    const SECRET = 'test-storage-signing-secret';
    const libDir = mkdtempSync(join(tmpdir(), 'icecream-direct-storage-'));
    tmpdirs.push(libDir);
    svc = await startServer(
      createEngineListener({
        libraryDir: libDir,
        deployEnv: { ...process.env, ENGINE_ACCESS_SECRET: SECRET },
      }),
    );
    gw = await startServer(
      createGateway({
        devLoginEnabled: true,
        authSecret: 'gw-test-secret',
        routes: { '/api/engine': svc.url },
        rateLimit: { points: 1000, perSeconds: 60 },
        storageSign: { secret: SECRET, publicUrl: svc.url },
      }),
    );
    const login = await httpJson('POST', `${gw.url}/auth/login`, { body: { userId: 'alice' } });
    expect(login.status).toBe(200);
    const jwt = (login.json as { token: string }).token;
    const AUTH = { authorization: `Bearer ${jwt}` };

    const bytes = smallWorkbookBytes();
    const load = await httpJson('POST', `${gw.url}/api/engine/load`, {
      headers: AUTH,
      body: { format: 'xlsx', data: Buffer.from(bytes).toString('base64') },
    });
    expect(load.status).toBe(200);

    // 1) Download through the gateway: SAVE first — JSON metadata only.
    const dl = await httpJson('POST', `${gw.url}/api/engine/download`, {
      headers: AUTH,
      body: { format: 'xlsx', filename: 'report.xlsx' },
    });
    expect(dl.status).toBe(200);
    const meta = dl.json as DownloadMeta;
    expect(meta.ok).toBe(true);
    expect(meta.entryId).toMatch(/^autosave_/);
    expect(meta.mode).toBe('verbatim');

    // 2) Sign: the gateway returns a DIRECT engine URL (its own origin
    //    is the engine's, not the gateway's) with a ~120 s expiry.
    const sign = await httpJson('POST', `${gw.url}/api/storage/sign`, {
      headers: AUTH,
      body: { entryId: meta.entryId },
    });
    expect(sign.status).toBe(200);
    const { url, expiresAt } = sign.json as { url: string; expiresAt: number };
    expect(url.startsWith(`${svc.url}/storage/${meta.entryId}?st=`)).toBe(true);
    expect(expiresAt).toBeGreaterThan(Date.now() + 90_000);
    expect(expiresAt).toBeLessThan(Date.now() + 150_000);

    // 3) Fetch the bytes DIRECTLY from the engine — no auth header,
    //    the storage token alone authorizes.
    const fileRes = await fetch(url);
    expect(fileRes.status).toBe(200);
    expect(fileRes.headers.get('content-type')).toContain('spreadsheetml.sheet');
    expect(fileRes.headers.get('content-disposition')).toContain('report.xlsx');
    const back = new XlsxAdapter().read(new Uint8Array(await fileRes.arrayBuffer()));
    expect(back.sheets.find((s) => s.name === 'Other')!.rows[0]).toEqual(['keep', 42]);

    // 4) Token failures are 401: tampered token, missing token, and a
    //    valid token replayed against a different entry.
    const tampered = await fetch(`${url}x`);
    expect(tampered.status).toBe(401);
    const noToken = await fetch(`${svc.url}/storage/${meta.entryId}`);
    expect(noToken.status).toBe(401);
    const other = await httpJson('POST', `${gw.url}/api/storage/sign`, {
      headers: AUTH,
      body: { entryId: 'dl_other_entry' },
    });
    const otherUrl = (other.json as { url: string }).url;
    const replayed = await fetch(otherUrl.replace('dl_other_entry', meta.entryId));
    expect(replayed.status).toBe(401);

    // 5) No signing secret configured → sign fails closed with 501,
    //    while /download still returns its metadata.
    const gw2 = await startServer(
      createGateway({
        devLoginEnabled: true,
        authSecret: 'gw-test-secret',
        routes: { '/api/engine': svc.url },
        rateLimit: { points: 1000, perSeconds: 60 },
      }),
    );
    try {
      const sign2 = await httpJson('POST', `${gw2.url}/api/storage/sign`, {
        headers: AUTH,
        body: { entryId: meta.entryId },
      });
      expect(sign2.status).toBe(501);
      const dl2 = await httpJson('POST', `${gw2.url}/api/engine/download`, {
        headers: AUTH,
        body: { format: 'xlsx' },
      });
      expect(dl2.status).toBe(200);
      expect((dl2.json as DownloadMeta).ok).toBe(true);
    } finally {
      await stop(gw2);
    }
  }, 60_000);
});
