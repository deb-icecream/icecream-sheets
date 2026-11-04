/**
 * Formula resolution audit v2: compares engine results against Excel's cached
 * values from the raw OOXML, classifying each engine error as:
 *   - genuine: Excel also cached an error at that cell
 *   - BUG: Excel cached a real value but our engine errors (or value differs)
 *   - unverifiable: no cached value present (e.g. recovered shared formulas)
 *
 * Run: ONLY=file1.xlsx npx vitest run tests/audit-v2-smoke.test.ts
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'vitest';
import { unzipSync } from 'fflate';
import { XlsxAdapter } from '../src/index.js';
import { EngineWorkbook } from '@icecream-sheets/engine';

const ENT: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };
function decodeEntities(s: string): string {
  return s.replace(/&(lt|gt|amp|quot|apos|#(\d+)|#x([0-9a-fA-F]+));/g, (m, name, dec, hex) => {
    if (dec) return String.fromCodePoint(parseInt(dec, 10));
    if (hex) return String.fromCodePoint(parseInt(hex, 16));
    return ENT[name] ?? m;
  });
}

interface CachedCell {
  formula: string | null; // raw formula text (pre-rewrite)
  fAttrs: string;
  t: string | null; // cell type attr
  v: string | null; // cached value text
}

function parseSheetXml(xml: string): Map<string, CachedCell> {
  const cells = new Map<string, CachedCell>();
  const cellRe = /<c\s+r="([^"]+)"([^>]*)>([\s\S]*?)<\/c>/g;
  let m: RegExpExecArray | null;
  while ((m = cellRe.exec(xml)) !== null) {
    const [, ref, attrs, inner] = m;
    const tM = /t="([^"]*)"/.exec(attrs);
    const fM = /<f(\s[^>]*)?>([\s\S]*?)<\/f>/.exec(inner);
    const vM = /<v>([\s\S]*?)<\/v>/.exec(inner);
    cells.set(ref, {
      formula: fM ? decodeEntities(fM[2]) : null,
      fAttrs: fM ? fM[1] ?? '' : '',
      t: tM ? tM[1] : null,
      v: vM ? vM[1] : null,
    });
  }
  return cells;
}

function parseSharedStrings(xml: string): string[] {
  const out: string[] = [];
  const siRe = /<si>([\s\S]*?)<\/si>/g;
  let m: RegExpExecArray | null;
  while ((m = siRe.exec(xml)) !== null) {
    const tRe = /<t(\s[^>]*)?>([\s\S]*?)<\/t>/g;
    let text = '';
    let tm: RegExpExecArray | null;
    while ((tm = tRe.exec(m[1])) !== null) text += decodeEntities(tm[2]);
    out.push(text);
  }
  return out;
}

function colName(c: number): string {
  let s = '';
  let n = c;
  do {
    s = String.fromCharCode(65 + (n % 26)) + s;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return s;
}

interface FileResult {
  file: string;
  loadErr: string | null;
  formulaCount: number;
  engineErrors: number;
  genuine: number;
  codeMismatch: number; // both errored but different codes
  bugs: number; // engine error, Excel cached value
  valueMismatch: number; // engine value != cached value
  resolved: number; // engine value, Excel cached error
  unverifiable: number; // engine error, no cached value
  literalErrorCells: number; // non-formula error literals
  throws: number;
  bugDetails: any[];
  mismatchDetails: any[];
}

export function auditFiles(files: string[], dir: string): FileResult[] {
  const adapter = new XlsxAdapter();
  const results: FileResult[] = [];
  for (const file of files) {
    const res: FileResult = {
      file, loadErr: null, formulaCount: 0, engineErrors: 0, genuine: 0,
      codeMismatch: 0, bugs: 0, valueMismatch: 0, resolved: 0, unverifiable: 0,
      literalErrorCells: 0, throws: 0, bugDetails: [], mismatchDetails: [],
    };
    try {
      const bytes = new Uint8Array(readFileSync(join(dir, file)));
      // --- raw XML cached values ---
      const unzipped = unzipSync(bytes.slice());
      const parts: Record<string, string> = {};
      const dec = new TextDecoder();
      for (const [p, d] of Object.entries(unzipped)) parts[p] = p;
      const wbXml = dec.decode(unzipped['xl/workbook.xml'] as Uint8Array);
      const relsXml = dec.decode(unzipped['xl/_rels/workbook.xml.rels'] as Uint8Array);
      const relTarget = new Map<string, string>();
      const relRe = /<Relationship\b[^>]*>/g;
      let rm: RegExpExecArray | null;
      while ((rm = relRe.exec(relsXml)) !== null) {
        const id = /Id="([^"]+)"/.exec(rm[0])?.[1];
        const target = /Target="([^"]+)"/.exec(rm[0])?.[1];
        if (id && target) relTarget.set(id, target);
      }
      const sheetPart = new Map<string, string>(); // sheet name -> part path
      const sheetRe = /<sheet\b[^>]*>/g;
      let sm: RegExpExecArray | null;
      while ((sm = sheetRe.exec(wbXml)) !== null) {
        const nameRaw = /name="([^"]+)"/.exec(sm[0])?.[1];
        const name = nameRaw ? decodeEntities(nameRaw) : undefined;
        const rid = /r:id="([^"]+)"/.exec(sm[0])?.[1];
        if (name && rid && relTarget.has(rid)) sheetPart.set(name, 'xl/' + relTarget.get(rid));
      }
      let sharedStrings: string[] = [];
      if (unzipped['xl/sharedStrings.xml']) {
        sharedStrings = parseSharedStrings(dec.decode(unzipped['xl/sharedStrings.xml'] as Uint8Array));
      }
      const cachedBySheet = new Map<string, Map<string, CachedCell>>();
      for (const [name, path] of sheetPart) {
        const raw = unzipped[path];
        if (raw) cachedBySheet.set(name, parseSheetXml(dec.decode(raw as Uint8Array)));
      }
      // --- engine evaluation ---
      const data = adapter.read(bytes);
      const initial: Record<string, any[][]> = {};
      for (const sheet of data.sheets) initial[sheet.name] = sheet.rows.map((r: any[]) => [...r]);
      const wb = new EngineWorkbook(initial, { definedNames: (data as any).definedNames });
      const ERROR_LITERALS = new Set(['#DIV/0!', '#N/A', '#NAME?', '#NULL!', '#NUM!', '#REF!', '#VALUE!']);
      for (const sheet of data.sheets) {
        const cached = cachedBySheet.get(sheet.name);
        const rows = sheet.rows as any[][];
        for (let r = 0; r < rows.length; r++) {
          const row = rows[r];
          for (let c = 0; c < row.length; c++) {
            const cell = row[c];
            const ref = `${colName(c)}${r + 1}`;
            const isFormula = typeof cell === 'string' && cell.startsWith('=');
            if (!isFormula) {
              if (typeof cell === 'string' && ERROR_LITERALS.has(cell)) res.literalErrorCells++;
              continue;
            }
            res.formulaCount++;
            const cc = cached?.get(ref);
            let ours: any;
            try {
              ours = (wb as any).getValue({ sheet: sheet.name, row: r, col: c });
            } catch (e: any) {
              res.throws++;
              continue;
            }
            const cachedIsError = cc?.t === 'e' && cc.v != null;
            const cachedHasValue = cc?.v != null && cc.v !== '';
            if (ours && ours.kind === 'error') {
              res.engineErrors++;
              const detail = {
                file, sheet: sheet.name, ref, code: ours.code,
                formula: String(cell).slice(0, 400),
                cached: cc ? { t: cc.t, v: cc.v } : null,
              };
              if (cachedIsError) {
                res.genuine++;
                if (ours.code !== cc!.v) { res.codeMismatch++; }
              } else if (cachedHasValue) {
                res.bugs++;
                res.bugDetails.push(detail);
              } else {
                res.unverifiable++;
                res.bugDetails.push({ ...detail, note: 'UNVERIFIABLE-no-cached-value' });
              }
            } else if (cachedIsError) {
              res.resolved++;
            } else if (cachedHasValue && cc) {
              // compare values
              let cachedVal: any;
              if (cc.t === 's') cachedVal = sharedStrings[parseInt(cc.v!, 10)];
              else if (cc.t === 'b') cachedVal = cc.v === '1';
              else if (cc.t === 'str' || cc.t === 'inlineStr') cachedVal = cc.v;
              else if (cc.v != null) cachedVal = parseFloat(cc.v);
              const ov = ours && typeof ours.value !== 'undefined' ? ours.value : null;
              let match = false;
              if (typeof cachedVal === 'number' && typeof ov === 'number') {
                match = Math.abs(cachedVal - ov) <= 1e-9 * Math.max(1, Math.abs(cachedVal), Math.abs(ov));
              } else if (typeof cachedVal === 'string' && typeof ov === 'string') {
                match = cachedVal === ov;
              } else if (typeof cachedVal === 'boolean' && typeof ov === 'boolean') {
                match = cachedVal === ov;
              } else if (cachedVal === '' && ov === null) {
                match = true;
              } else if (typeof cachedVal === 'number' && typeof ov === 'string' && ov.trim() !== '') {
                // engine returned text where Excel cached number — suspicious
                match = false;
              }
              if (!match) {
                res.valueMismatch++;
                res.mismatchDetails.push({
                  file, sheet: sheet.name, ref,
                  formula: String(cell).slice(0, 400),
                  ours: ours ? { kind: ours.kind, value: ours.kind === 'error' ? ours.code : ov } : null,
                  cached: { t: cc.t, v: cachedVal },
                });
              }
            }
          }
        }
      }
    } catch (e: any) {
      res.loadErr = String(e?.message ?? e).slice(0, 300);
    }
    results.push(res);
  }
  return results;
}

describe('formula audit v2 (smoke)', () => {
  it('audits a few files', () => {
    const dir = join(dirname(fileURLToPath(import.meta.url)), '../../../test-data/real-world');
    const files = (process.env.ONLY ? process.env.ONLY.split(',') : readdirSync(dir).filter((f) => f.endsWith('.xlsx')).sort().slice(0, 5));
    const results = auditFiles(files, dir);
    writeFileSync('/tmp/audit-v2-smoke.json', JSON.stringify(results, null, 1));
    for (const r of results) {
      console.log(`${r.file}: formulas=${r.formulaCount} err=${r.engineErrors} genuine=${r.genuine} bugs=${r.bugs} valMismatch=${r.valueMismatch} resolved=${r.resolved} unverifiable=${r.unverifiable} throws=${r.throws} loadErr=${r.loadErr ?? ''}`);
    }
    for (const r of results) {
      for (const b of r.bugDetails) console.log('BUG>', JSON.stringify(b));
      for (const m of r.mismatchDetails.slice(0, 10)) console.log('MISMATCH>', JSON.stringify(m));
    }
  }, 600000);
});
