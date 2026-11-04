/**
 * Cycle 5 from-scratch formula resolution audit.
 * For each test-data/real-world/*.xlsx:
 *   - parse cached values with SheetJS (cell.f / cell.t / cell.v)
 *   - load through XlsxAdapter -> EngineWorkbook, recompute every formula
 *   - compare computed vs cached
 * Run: npx vitest run tests/zz-cycle5-formula-audit.test.ts  (from packages/xlsx-adapter)
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'vitest';
import * as XLSX from 'xlsx';
import { XlsxAdapter } from '../src/index.js';
import { EngineWorkbook } from '@icecream-sheets/engine';

function colName(c: number): string {
  let s = '';
  let n = c;
  do {
    s = String.fromCharCode(65 + (n % 26)) + s;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return s;
}

/** Ordered-int ulp distance between two finite doubles. 0 when ===. */
function ulpDiff(a: number, b: number): number {
  if (a === b) return 0;
  if (!Number.isFinite(a) || !Number.isFinite(b)) return Number.POSITIVE_INFINITY;
  const buf = new DataView(new ArrayBuffer(8));
  const bits = (x: number): bigint => {
    buf.setFloat64(0, x);
    return buf.getBigInt64(0);
  };
  const SIGN = 0x8000000000000000n;
  const ALL = 0xffffffffffffffffn;
  const ord = (x: number): bigint => {
    const b = bits(x);
    return b < 0n ? ~b & ALL : b ^ SIGN;
  };
  const d = ord(a) >= ord(b) ? ord(a) - ord(b) : ord(b) - ord(a);
  return d > BigInt(Number.MAX_SAFE_INTEGER) ? Number.POSITIVE_INFINITY : Number(d);
}

const VOLATILE_RE = /\b(RAND|RANDBETWEEN|NOW|TODAY)\s*\(/i;

interface Mismatch {
  ref: string;
  formula: string;
  cachedT: string;
  cached: string;
  computed: string;
  ulp: number | null;
  cls: string;
}

interface FileResult {
  file: string;
  formulaCount: number;
  cachedCount: number;
  volatileSkipped: number;
  matchCount: number;
  mismatches: Mismatch[];
  loadErr: string | null;
}

function classifyPre(
  formula: string,
  cachedT: string,
  cachedV: unknown,
  cellW: unknown,
  computed: any,
): { verdict: 'match' | 'mismatch' | 'skip-volatile'; ulp: number | null; computedRepr: string } {
  const f = formula.toUpperCase();
  if (VOLATILE_RE.test(f)) return { verdict: 'skip-volatile', ulp: null, computedRepr: '' };
  const cRepr = (v: any): string => {
    if (!v) return 'undefined';
    if (v.kind === 'error') return `ERR:${v.code}`;
    if (v.kind === 'number') return `num:${v.value}`;
    if (v.kind === 'string') return `str:${JSON.stringify(v.value).slice(0, 120)}`;
    if (v.kind === 'boolean') return `bool:${v.value}`;
    if (v.kind === 'null') return 'null';
    if (v.kind === 'image') return 'image';
    return `other:${JSON.stringify(v).slice(0, 80)}`;
  };
  const cv: any = computed;
  if (cachedT === 'n') {
    if (cv?.kind === 'number') {
      const ulp = ulpDiff(cachedV as number, cv.value);
      return { verdict: ulp === 0 ? 'match' : 'mismatch', ulp, computedRepr: cRepr(cv) };
    }
    return { verdict: 'mismatch', ulp: null, computedRepr: cRepr(cv) };
  }
  if (cachedT === 's' || cachedT === 'str') {
    const ok = cv?.kind === 'string' && cv.value === (cachedV as string);
    return { verdict: ok ? 'match' : 'mismatch', ulp: null, computedRepr: cRepr(cv) };
  }
  if (cachedT === 'b') {
    const ok = cv?.kind === 'boolean' && cv.value === (cachedV as boolean);
    return { verdict: ok ? 'match' : 'mismatch', ulp: null, computedRepr: cRepr(cv) };
  }
  if (cachedT === 'e') {
    // SheetJS stores an internal numeric code in cell.v for errors; the
    // real cached error string is in cell.w (and in the raw <v> element).
    const expected = typeof cellW === 'string' && cellW.startsWith('#') ? cellW : String(cachedV);
    const ok = cv?.kind === 'error' && cv.code === expected;
    return { verdict: ok ? 'match' : 'mismatch', ulp: null, computedRepr: cRepr(cv) };
  }
  // t 'z' or anything else: no usable cached value
  return { verdict: 'match', ulp: null, computedRepr: cRepr(cv) };
}

describe('cycle5 formula resolution audit (from scratch)', () => {
  it('compares computed vs cached values for all 97 files', () => {
    const dir = join(dirname(fileURLToPath(import.meta.url)), '../../../test-data/real-world');
    const files = readdirSync(dir).filter((f) => f.endsWith('.xlsx')).sort();
    const adapter = new XlsxAdapter();
    const results: FileResult[] = [];
    const only = process.env.ONLY ? process.env.ONLY.split(',') : null;

    for (const file of files) {
      if (only && !only.includes(file)) continue;
      const res: FileResult = {
        file,
        formulaCount: 0,
        cachedCount: 0,
        volatileSkipped: 0,
        matchCount: 0,
        mismatches: [],
        loadErr: null,
      };
      try {
        const buf = readFileSync(join(dir, file));
        const sj = XLSX.read(buf, { type: 'buffer' });
        const data = adapter.read(new Uint8Array(buf));
        const initial: Record<string, any[][]> = {};
        const hiddenRows: Record<string, number[]> = {};
        for (const sheet of data.sheets) {
          initial[sheet.name] = sheet.rows.map((r: any[]) => [...r]);
          if ((sheet as any).hiddenRows) hiddenRows[sheet.name] = (sheet as any).hiddenRows;
        }
        const wb = new EngineWorkbook(initial, {
          definedNames: (data as any).definedNames,
          hiddenRows,
        });

        for (const sheetName of sj.SheetNames) {
          const ws = sj.Sheets[sheetName];
          if (!ws) continue;
          for (const key of Object.keys(ws)) {
            if (key[0] === '!') continue;
            const cell = ws[key] as any;
            if (!cell || typeof cell.f !== 'string' || cell.f.length === 0) continue;
            res.formulaCount++;
            if (cell.v === undefined || cell.v === null) continue; // no cached value
            res.cachedCount++;
            const { c: col, r: row } = XLSX.utils.decode_cell(key);
            let computed: any = undefined;
            try {
              computed = (wb as any).getValue({ sheet: sheetName, row, col });
            } catch (e: any) {
              computed = { kind: 'error', code: '#ERROR', message: 'getValue threw: ' + String(e?.message ?? e).slice(0, 100) };
            }
            const r = classifyPre(cell.f, cell.t, cell.v, (cell as any).w, computed);
            if (r.verdict === 'skip-volatile') {
              res.volatileSkipped++;
              continue;
            }
            if (r.verdict === 'match') {
              res.matchCount++;
              continue;
            }
            res.mismatches.push({
              ref: `${sheetName}!${colName(col)}${row + 1}`,
              formula: '=' + cell.f.slice(0, 200),
              cachedT: cell.t,
              cached: `${cell.t}:${JSON.stringify(cell.v).slice(0, 120)}`,
              computed: r.computedRepr,
              ulp: r.ulp,
              cls: 'UNCLASSIFIED',
            });
          }
        }
      } catch (e: any) {
        res.loadErr = String(e?.message ?? e).slice(0, 300);
      }
      results.push(res);
    }

    writeFileSync('/tmp/cycle5-audit.json', JSON.stringify(results, null, 1));
    let clean = 0;
    let totalFormulas = 0;
    let totalCached = 0;
    let totalMismatch = 0;
    const lines: string[] = [];
    for (const r of results) {
      totalFormulas += r.formulaCount;
      totalCached += r.cachedCount;
      totalMismatch += r.mismatches.length;
      if (!r.loadErr && r.mismatches.length === 0) clean++;
      else {
        lines.push(
          `${r.file}: formulas=${r.formulaCount} cached=${r.cachedCount} match=${r.matchCount} volatileSkip=${r.volatileSkipped} MISMATCH=${r.mismatches.length}${r.loadErr ? ' LOADERR=' + r.loadErr : ''}`,
        );
      }
    }
    console.log(`FILES=${results.length} CLEAN=${clean} totalFormulas=${totalFormulas} totalCached=${totalCached} totalMismatch=${totalMismatch}`);
    console.log(lines.join('\n'));
    const small = results.flatMap((r) => r.mismatches.filter((m) => m.ulp !== null && m.ulp <= 4).map((m) => `${r.file} ${m.ref} ulp=${m.ulp}`));
    console.log(`ULP<=4 mismatches: ${small.length}`);
  }, 900000);
});
