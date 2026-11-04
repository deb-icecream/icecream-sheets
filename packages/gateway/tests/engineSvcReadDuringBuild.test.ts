/**
 * Read-during-build (W20 — Cycle 10 closure, W18 gate Blocker 2).
 *
 * Defect: during a /load/stream open, the client learns the new file's
 * sheet names from the `meta` chunk and immediately issues /read
 * requests — but the engine build has not run yet, so state.host still
 * holds the PREVIOUS (or blank boot) workbook. Reads for a sheet that
 * only exists in the new file threw `Unknown sheet` → 500 (fast,
 * 81–120 per large open); reads for a name present in both files
 * silently served the old file's values.
 *
 * Contract pinned here (engineSvc build gate):
 *  - a read issued while a load build is in flight PENDS and is then
 *    served from the NEW workbook, with correct values;
 *  - a read after a FAILED build surfaces the build's error (and so
 *    does a read that was waiting when the build failed);
 *  - with no build in flight, read behavior is unchanged (including
 *    the honest `Unknown sheet` error for a sheet that does not exist
 *    — status revised 500 → 404 by the Item H fix: an absent sheet is
 *    a client addressing error, not a server fault; see the Item H
 *    tests at the bottom of this file).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { XlsxAdapter } from '@icecream-sheets/xlsx-adapter';
import type { TypedValue } from '@icecream-sheets/engine';
import { createEngineListener } from '../src/services/engineSvc.js';
import { httpJson, startServer, stop, type Started } from './helpers.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const GEOCODE = join(HERE, '..', '..', '..', 'test-data', 'cycle6-fixtures', 'geocode.xlsx');

const ALICE = { 'x-principal': 'user:alice' };

describe('engine service — read during build (W20)', () => {
  let svc: Started | null = null;

  afterEach(async () => {
    if (svc) await stop(svc);
    svc = null;
  });

  function post(path: string, body: unknown) {
    return httpJson('POST', `${svc!.url}${path}`, { headers: ALICE, body });
  }

  function geocodeBase64(): string {
    return Buffer.from(new Uint8Array(readFileSync(GEOCODE))).toString('base64');
  }

  it(
    'reads issued after the /load/stream meta chunk pend and resolve with the NEW workbook values',
    async () => {
      svc = await startServer(createEngineListener());
      // Seed a DECOY workbook whose sheet name overlaps nothing in the
      // fixture — pre-fix, reads for 'Cities' 500'd against this host.
      const decoy = new XlsxAdapter().write({
        sheets: [{ name: 'Decoy', rows: [['stale']] }],
        metadata: {},
      });
      const decoyLoad = await post('/load', {
        format: 'xlsx',
        data: Buffer.from(decoy).toString('base64'),
      });
      expect(decoyLoad.status).toBe(200);

      const res = await fetch(`${svc!.url}/load/stream`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...ALICE },
        body: JSON.stringify({ format: 'xlsx', data: geocodeBase64() }),
      });
      expect(res.status).toBe(200);
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      let metaSeen = false;
      let builtSeen = false;
      let readPromises: Array<Promise<{ status: number; json: unknown }>> = [];
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let idx: number;
        while ((idx = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, idx);
          buf = buf.slice(idx + 1);
          if (!line.trim()) continue;
          const chunk = JSON.parse(line) as { type: string; sheets?: string[] };
          if (chunk.type === 'meta' && !metaSeen) {
            metaSeen = true;
            expect(chunk.sheets).toEqual(['Cities']);
            // The real client's exact move: it has sheet names, the
            // engine has NOT built yet — fire reads NOW, mid-window.
            readPromises = [
              post('/read', { kind: 'cell', ref: { sheet: 'Cities', row: 0, col: 0 } }),
              post('/read', {
                kind: 'range',
                range: { sheet: 'Cities', startRow: 0, startCol: 0, endRow: 0, endCol: 3 },
              }),
              post('/read', { kind: 'cell', ref: { sheet: 'Cities', row: 34163, col: 0 } }),
            ];
          }
          if (chunk.type === 'built') builtSeen = true;
        }
      }
      expect(metaSeen).toBe(true);
      expect(builtSeen).toBe(true);
      expect(readPromises.length).toBe(3);
      const [cell, range, deep] = await Promise.all(readPromises);
      // NOT 500, and the values are the new file's — 'name' is the
      // geocode header cell; the decoy workbook has no 'Cities' sheet.
      expect(cell!.status).toBe(200);
      expect((cell!.json as { value: TypedValue }).value).toEqual({ kind: 'string', value: 'name' });
      expect(range!.status).toBe(200);
      const values = (range!.json as { values: TypedValue[][] }).values;
      expect(values[0]!.map((v) => v.value)).toEqual(['name', 'country', 'subcountry', 'geonameid']);
      expect(deep!.status).toBe(200);
      expect((deep!.json as { value: TypedValue }).value.kind).toBe('string');
    },
    120_000,
  );

  it(
    'a read issued during a classic /load also pends and resolves with correct values',
    async () => {
      svc = await startServer(createEngineListener());
      const loadPromise = post('/load', { format: 'xlsx', data: geocodeBase64() });
      // Fire mid-load (parse+build of this fixture takes seconds; the
      // gate is open long before this read is processed).
      await new Promise((r) => setTimeout(r, 400));
      const readPromise = post('/read', { kind: 'cell', ref: { sheet: 'Cities', row: 0, col: 1 } });
      const [load, read] = await Promise.all([loadPromise, readPromise]);
      expect(load.status).toBe(200);
      expect(read.status).toBe(200);
      expect((read.json as { value: TypedValue }).value).toEqual({ kind: 'string', value: 'country' });
    },
    120_000,
  );

  it(
    'a failed build surfaces its error to reads — during, after, and until the next successful load',
    async () => {
      svc = await startServer(createEngineListener());
      const bad = Buffer.from('not a zip').toString('base64');
      // Classic /load failure: 400 to the loader…
      const load = await post('/load', { format: 'xlsx', data: bad });
      expect(load.status).toBe(400);
      // …and the build's error to a subsequent read (never a stale or
      // blank-workbook answer dressed up as success).
      const after = await post('/read', { kind: 'cell', ref: { sheet: 'Data', row: 0, col: 0 } });
      expect(after.status).toBe(500);
      expect(JSON.stringify(after.json)).toContain('failed to parse xlsx');
      // A successful load clears the failure: reads serve the new file.
      const good = new XlsxAdapter().write({
        sheets: [{ name: 'Data', rows: [[7]] }],
        metadata: {},
      });
      const okLoad = await post('/load', {
        format: 'xlsx',
        data: Buffer.from(good).toString('base64'),
      });
      expect(okLoad.status).toBe(200);
      const rd = await post('/read', { kind: 'cell', ref: { sheet: 'Data', row: 0, col: 0 } });
      expect(rd.status).toBe(200);
      expect((rd.json as { value: TypedValue }).value).toEqual({ kind: 'number', value: 7 });
      // /reset also clears it.
      const bad2 = await post('/load', { format: 'xlsx', data: bad });
      expect(bad2.status).toBe(400);
      await post('/reset', {});
      const blank = await post('/read', { kind: 'cell', ref: { sheet: 'Sheet1', row: 0, col: 0 } });
      expect(blank.status).toBe(200);
    },
    60_000,
  );

  it(
    'a read waiting on a /load/stream whose parse fails is released with the build error, not left hanging',
    async () => {
      svc = await startServer(createEngineListener());
      const bad = Buffer.from('not a zip').toString('base64');
      const streamPromise = fetch(`${svc!.url}/load/stream`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...ALICE },
        body: JSON.stringify({ format: 'xlsx', data: bad }),
      }).then(async (r) => ({ status: r.status, text: await r.text() }));
      const readPromise = post('/read', { kind: 'cell', ref: { sheet: 'Data', row: 0, col: 0 } });
      const [stream, read] = await Promise.all([streamPromise, readPromise]);
      // The stream reports its own error chunk (existing contract)…
      expect(stream.text).toContain('error');
      expect(stream.text).toContain('failed to parse xlsx');
      // …and the waiting read resolves (does not hang) with that error.
      expect(read.status).toBe(500);
      expect(JSON.stringify(read.json)).toContain('failed to parse xlsx');
    },
    60_000,
  );

  it(
    'Item H: reads for the SUPERSEDED workbook that pend on the build get 409 superseded, not 500 Unknown sheet',
    async () => {
      svc = await startServer(createEngineListener());
      // Previous workbook on screen: a sheet named 'Sheet1' (the boot /
      // previous file's sheet the client's grid is still rendering).
      const prev = new XlsxAdapter().write({
        sheets: [{ name: 'Sheet1', rows: [['old']] }],
        metadata: {},
      });
      const prevLoad = await post('/load', {
        format: 'xlsx',
        data: Buffer.from(prev).toString('base64'),
      });
      expect(prevLoad.status).toBe(200);

      const res = await fetch(`${svc!.url}/load/stream`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...ALICE },
        body: JSON.stringify({ format: 'xlsx', data: geocodeBase64() }),
      });
      expect(res.status).toBe(200);
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      let metaSeen = false;
      let readPromises: Array<Promise<{ status: number; json: unknown }>> = [];
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let idx: number;
        while ((idx = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, idx);
          buf = buf.slice(idx + 1);
          if (!line.trim()) continue;
          const chunk = JSON.parse(line) as { type: string; sheets?: string[] };
          if (chunk.type === 'meta' && !metaSeen) {
            metaSeen = true;
            // The audit's exact four: the previous workbook's viewport
            // range + single-cell range, issued twice (two consumers)
            // while the build is in flight — plus one read that DOES
            // belong to the new workbook as a control.
            readPromises = [
              post('/read', {
                kind: 'range',
                range: { sheet: 'Sheet1', startRow: 0, startCol: 0, endRow: 33, endCol: 21 },
              }),
              post('/read', {
                kind: 'range',
                range: { sheet: 'Sheet1', startRow: 0, startCol: 0, endRow: 0, endCol: 0 },
              }),
              post('/read', { kind: 'cell', ref: { sheet: 'Sheet1', row: 0, col: 0 } }),
              post('/read', {
                kind: 'range',
                range: { sheet: 'Sheet1', startRow: 0, startCol: 0, endRow: 33, endCol: 21 },
              }),
              post('/read', { kind: 'cell', ref: { sheet: 'Cities', row: 0, col: 0 } }),
            ];
          }
        }
      }
      expect(metaSeen).toBe(true);
      const [vp1, single, cell, vp2, control] = await Promise.all(readPromises);
      // All four superseded reads: 409, named as superseded — never the
      // 500 `Unknown sheet: Sheet1` the audit captured.
      for (const r of [vp1, single, cell, vp2]) {
        expect(r!.status).toBe(409);
        expect(JSON.stringify(r!.json)).toContain('superseded by a workbook load');
        expect(JSON.stringify(r!.json)).toContain('Sheet1');
      }
      // The control read addressed to the NEW workbook still pends and
      // serves the new values (W20 contract intact).
      expect(control!.status).toBe(200);
      expect((control!.json as { value: TypedValue }).value).toEqual({ kind: 'string', value: 'name' });
      // AFTER the build, the same Sheet1 read no longer pends: it gets
      // the general unknown-sheet answer — 404 with the engine's
      // `Unknown sheet` text, still never a 500 (Item H: an absent
      // sheet is a client addressing error, not a server fault; the
      // browser repro showed superseded reads landing in the build's
      // socket-queue window, after the gate had already cleared, so
      // the 404 must cover that window too).
      const after = await post('/read', { kind: 'cell', ref: { sheet: 'Sheet1', row: 0, col: 0 } });
      expect(after.status).toBe(404);
      expect(JSON.stringify(after.json)).toContain('Unknown sheet: Sheet1');
    },
    120_000,
  );

  it('Item H: a 500 from the request handler is logged (the error path was silent)', async () => {
    svc = await startServer(createEngineListener());
    const logs: string[] = [];
    const orig = console.log;
    console.log = (...args: unknown[]) => {
      logs.push(args.map(String).join(' '));
    };
    try {
      // A genuine 500: the sticky failed-build error surfaces to reads
      // through the outer catch (unknown-sheet reads are a 404 now and
      // never reach it).
      const bad = Buffer.from('not a zip').toString('base64');
      const load = await post('/load', { format: 'xlsx', data: bad });
      expect(load.status).toBe(400);
      const rd = await post('/read', { kind: 'cell', ref: { sheet: 'Data', row: 0, col: 0 } });
      expect(rd.status).toBe(500);
    } finally {
      console.log = orig;
    }
    expect(
      logs.some((l) => l.includes('[engine] request failed POST /read') && l.includes('failed to parse xlsx')),
    ).toBe(true);
  });

  it('no build in flight: read behavior is unchanged', async () => {
    svc = await startServer(createEngineListener());
    await post('/execute', { cmd: { cmd: 'setCell', ref: { sheet: 'Sheet1', row: 0, col: 0 }, value: 42 } });
    const rd = await post('/read', { kind: 'cell', ref: { sheet: 'Sheet1', row: 0, col: 0 } });
    expect(rd.status).toBe(200);
    expect((rd.json as { value: TypedValue }).value).toEqual({ kind: 'number', value: 42 });
    // A genuinely unknown sheet still gets the honest engine error
    // text — but as a 404, not a 500 (Item H contract: an absent sheet
    // is a client addressing error, never a server fault; this line
    // previously pinned 500 and was revised with the Item H fix).
    const nope = await post('/read', { kind: 'cell', ref: { sheet: 'Nope', row: 0, col: 0 } });
    expect(nope.status).toBe(404);
    expect(JSON.stringify(nope.json)).toContain('Unknown sheet: Nope');
  });
});
