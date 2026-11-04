// Cycle 3: Formula resolution audit across test-data/real-world/*.xlsx
// For every formula cell (per XlsxAdapter output): compare engine computed
// value vs Excel cached value (per SheetJS raw read). Classify mismatches.
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const engRequire = createRequire(join(ROOT, 'packages/engine/package.json'));
const xlsxRequire = createRequire(join(ROOT, 'packages/xlsx-adapter/package.json'));
const XLSX = xlsxRequire('xlsx');

// Import engine first: side-effectfully registers ALL function plugins globally.
const engine = await import(join(ROOT, 'packages/engine/dist/index.js'));
const { XlsxAdapter } = await import(join(ROOT, 'packages/xlsx-adapter/dist/index.js'));
const { HyperFormula } = engRequire('hyperformula');

// Full known-function list (HyperFormula built-ins + every engine plugin).
const _probe = HyperFormula.buildFromArray([['x']]);
const KNOWN = new Set(_probe.getRegisteredFunctionNames().map((n) => String(n).toUpperCase()));
_probe.destroy();
for (const extra of ['ICEEVAL', 'ICENAMEDFUNC']) KNOWN.add(extra);
console.error(`known functions: ${KNOWN.size}`);

const BIFF_ERR = { 0: '#NULL!', 7: '#DIV/0!', 15: '#VALUE!', 23: '#REF!', 29: '#N/A', 36: '#NUM!', 42: '#N/A', 43: '#GETTING_DATA' };

// ---- cached value normalization (SheetJS raw cell) ----
function cachedOf(cell) {
  if (!cell) return { kind: 'none' };
  const t = cell.t, v = cell.v;
  if (t === 'e') {
    const code = typeof v === 'number' ? (BIFF_ERR[v] ?? `#ERR${v}`) : (typeof v === 'string' && v ? v : null);
    return code ? { kind: 'error', code } : { kind: 'none' };
  }
  if (t === 'b') return { kind: 'bool', value: !!v };
  if (typeof v === 'number') return Number.isFinite(v) ? { kind: 'num', value: v } : { kind: 'none' };
  if (typeof v === 'string') return { kind: 'str', value: v };
  if (typeof v === 'boolean') return { kind: 'bool', value: v };
  return { kind: 'none' }; // never calculated / no cached value
}

// ---- computed value normalization (engine TypedValue) ----
function computedOf(tv) {
  if (!tv || typeof tv !== 'object') return { kind: 'none' };
  if (tv.kind === 'error') return { kind: 'error', code: tv.code };
  if (tv.kind === 'number') return { kind: 'num', value: tv.value };
  if (tv.kind === 'string') return { kind: 'str', value: tv.value };
  if (tv.kind === 'boolean') return { kind: 'bool', value: tv.value };
  if (tv.kind === 'null') return { kind: 'empty' };
  if (tv.kind === 'image') return { kind: 'str', value: '[image]' };
  return { kind: 'none' };
}

const A1 = (r, c) => {
  let s = '', n = c;
  do { s = String.fromCharCode(65 + (n % 26)) + s; n = Math.floor(n / 26) - 1; } while (n >= 0);
  return s + (r + 1);
};

// Volatile / live-data functions: cached values can never match recomputation.
const SKIP_FN_RE = /\b(NOW|TODAY|RAND|RANDBETWEEN|RANDARRAY|OFFSET|INDIRECT|CELL|INFO|WEBSERVICE|FILTERXML|STOCKHISTORY|GOOGLEFINANCE|RTD)\s*\(/i;
// External workbook reference: [1]Sheet!A1, [Book2.xlsx]Sheet!A1,
// 'C:\p\[f.xlsx]S'!A1 — NOT MDX [Measures] or structured refs [[...]].
const EXT_REF_RE = /\[(\d+[^\]]*|[^\]]*\.xlsx?[^\]]*)\]/i;
const CUBE_RE = /\bCUBE\w*\s*\(/i;
const LITERAL_ERR_RE = /^\s*=?\s*(1\/0|0\/0|#N\/A|#DIV\/0!|#REF!|#VALUE!|#NAME\?|#NUM!|#NULL!|NA\(\))\s*$/i;

function fnTokens(formula) {
  const noStr = formula.replace(/"[^"]*"/g, '""');
  const out = [];
  for (const m of noStr.matchAll(/([A-Za-z_][A-Za-z0-9_.]*)\s*\(/g)) out.push(m[1].toUpperCase());
  return out;
}

function fmtVal(v) {
  if (v.kind === 'error') return v.code;
  if (v.kind === 'num') return String(v.value);
  if (v.kind === 'str') return JSON.stringify(v.value.slice(0, 40));
  if (v.kind === 'bool') return String(v.value);
  if (v.kind === 'empty') return '<empty>';
  return '<none>';
}

function classifyMismatch(c, e, formula, file) {
  // returns { bucket, reason }
  // Exact matches first: never misclassify a matching pair.
  if (c.kind === 'error' && e.kind === 'error' && c.code === e.code) return { bucket: 'match', reason: '' };
  if (c.kind === 'str' && e.kind === 'str' && c.value === e.value) return { bucket: 'match', reason: '' };
  if (c.kind === 'bool' && e.kind === 'bool' && c.value === e.value) return { bucket: 'match', reason: '' };
  let numDiff = null;
  if (c.kind === 'num' && e.kind === 'num') {
    const diff = Math.abs(c.value - e.value);
    const scale = Math.max(Math.abs(c.value), Math.abs(e.value));
    const rel = scale > 0 ? diff / scale : (diff === 0 ? 0 : Infinity);
    if (rel <= 1e-12 || diff === 0) return { bucket: 'match', reason: '' };
    if (rel < 1e-9 || diff < 1e-9) return { bucket: 'precision', reason: `rel diff ${rel.toExponential(2)}` };
    numDiff = { diff, rel };
  }
  if (EXT_REF_RE.test(formula)) return { bucket: 'external', reason: 'external workbook reference' };
  if (CUBE_RE.test(formula)) return { bucket: 'genuine', reason: 'CUBE function, no data model' };
  if (c.kind === 'error' && c.code === '#GETTING_DATA') return { bucket: 'genuine', reason: 'cached #GETTING_DATA (RTD/data pending)' };
  if (/\bRTD\s*\(/i.test(formula)) return { bucket: 'genuine', reason: 'RTD function, no RTD server' };
  if (e.kind === 'error' && e.code === '#NAME?') {
    const toks = fnTokens(formula);
    const unknown = toks.filter((t) => !KNOWN.has(t));
    if (unknown.length > 0) return { bucket: 'genuine', reason: `XLL add-in function: ${unknown[0]}` };
    return { bucket: 'genuine', reason: 'undefined defined name' };
  }
  if (e.kind === 'error' && e.code === '#SPILL!') {
    if (/\bTABLE\s*\(/i.test(formula) || /data-table/i.test(file)) return { bucket: 'genuine', reason: 'data-table formula, legacy per-cell semantics' };
    return { bucket: 'real-bug', reason: `our #SPILL! vs cached ${fmtVal(c)}` };
  }
  if (numDiff) return { bucket: 'real-bug', reason: `wrong value (rel diff ${numDiff.rel.toExponential(2)})` };
  if (c.kind === 'error' && e.kind === 'error') {
    if (LITERAL_ERR_RE.test(formula)) return { bucket: 'real-bug', reason: `literal-error formula: wrong error type (cached ${c.code}, ours ${e.code})` };
    return { bucket: 'real-bug', reason: `wrong error type (cached ${c.code}, ours ${e.code})` };
  }
  if (c.kind === 'error' && e.kind !== 'error') {
    return { bucket: 'real-bug', reason: `missed Excel error ${c.code}` };
  }
  if (e.kind === 'error' && c.kind !== 'error') {
    return { bucket: 'real-bug', reason: `our ${e.code} vs cached ${fmtVal(c)}` };
  }
  // scalar vs scalar, different
  if (c.kind === 'str' && e.kind === 'str') return { bucket: 'real-bug', reason: 'wrong string value' };
  if (c.kind === 'bool' && e.kind === 'bool') return { bucket: 'real-bug', reason: 'wrong boolean value' };
  if ((c.kind === 'empty' || (c.kind === 'str' && c.value === '')) && (e.kind === 'empty' || (e.kind === 'str' && e.value === '')))
    return { bucket: 'match', reason: '' };
  return { bucket: 'real-bug', reason: `type/value mismatch (cached ${fmtVal(c)}, ours ${fmtVal(e)})` };
}

const dir = join(ROOT, 'test-data/real-world');
const onlyFiles = process.argv[2] ? process.argv[2].split(',') : null;
const files = (onlyFiles || readdirSync(dir).filter((f) => f.endsWith('.xlsx'))).sort();
const adapter = new XlsxAdapter();
const results = [];
let totalFormulas = 0;

for (const file of files) {
  const fpath = join(dir, file);
  const rec = { file, formulas: 0, skippedNoCache: 0, skippedVolatile: 0, mismatches: [], loadError: null };
  try {
    const buf = readFileSync(fpath);
    const u8 = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    // Cached values via raw SheetJS read, keyed sheet -> "r:c".
    const rawWb = XLSX.read(buf, { type: 'buffer' });
    const cache = new Map();
    for (const sn of rawWb.SheetNames) {
      const ws = rawWb.Sheets[sn];
      for (const key of Object.keys(ws)) {
        if (key[0] === '!') continue;
        const cell = ws[key];
        if (cell && typeof cell.f === 'string' && cell.f !== '') {
          const { r, c } = XLSX.utils.decode_cell(key);
          cache.set(sn + '\0' + r + ':' + c, cachedOf(cell));
        }
      }
    }
    // Engine view via the adapter (authoritative formula set).
    const data = adapter.read(u8);
    const initial = {};
    const hiddenRows = {};
    for (const sheet of data.sheets) {
      initial[sheet.name] = sheet.rows.map((row) => [...row]);
      if (sheet.hiddenRows) hiddenRows[sheet.name] = sheet.hiddenRows;
    }
    // Imported pivot layouts (icecream.pivots metadata): GETPIVOTDATA's
    // rendered-grid fallback resolves unregistered (e.g. data-model) pivots
    // from their rendered values in the sheet grid.
    let importedPivots = [];
    try {
      const parsed = JSON.parse(data.metadata?.['icecream.pivots'] || '[]');
      if (Array.isArray(parsed)) importedPivots = parsed;
    } catch { /* missing/corrupt metadata: no fallback layouts */ }
    const wb = new engine.EngineWorkbook(initial, { definedNames: data.definedNames, hiddenRows, importedPivots });
    wb.recalculate();
    for (const sheet of data.sheets) {
      const rows = sheet.rows;
      for (let r = 0; r < rows.length; r++) {
        for (let c = 0; c < rows[r].length; c++) {
          const input = rows[r][c];
          if (typeof input !== 'string' || !input.startsWith('=')) continue;
          rec.formulas++;
          totalFormulas++;
          const formula = input;
          if (SKIP_FN_RE.test(formula)) { rec.skippedVolatile++; continue; }
          const key = sheet.name + '\0' + r + ':' + c;
          const cached = cache.get(key) || { kind: 'none' };
          if (cached.kind === 'none') { rec.skippedNoCache++; continue; }
          let computed;
          try {
            computed = computedOf(wb.getValue({ sheet: sheet.name, row: r, col: c }));
          } catch (err) {
            rec.mismatches.push({ sheet: sheet.name, cell: A1(r, c), formula: formula.slice(0, 80), cached: fmtVal(cached), ours: 'THREW: ' + String(err && err.message || err).slice(0, 60), bucket: 'real-bug', reason: 'getValue threw' });
            continue;
          }
          const cls = classifyMismatch(cached, computed, formula, file);
          if (cls.bucket === 'match') continue;
          rec.mismatches.push({
            sheet: sheet.name, cell: A1(r, c), formula: formula.slice(0, 80),
            cached: fmtVal(cached), ours: fmtVal(computed),
            bucket: cls.bucket, reason: cls.reason,
          });
        }
      }
    }
  } catch (err) {
    rec.loadError = String(err && err.message || err).slice(0, 200);
  }
  results.push(rec);
  const mm = rec.mismatches.length;
  console.log(`${rec.file}: formulas=${rec.formulas} noCache=${rec.skippedNoCache} volatile=${rec.skippedVolatile} mismatches=${mm}${rec.loadError ? ' LOAD-ERR: ' + rec.loadError : ''}`);
}

const outPath = join(HERE, onlyFiles ? 'audit-cycle3-smoke.json' : 'audit-cycle3-results.json');
writeFileSync(outPath, JSON.stringify({ totalFormulas, results }, null, 1));
console.log(`\nTOTAL formulas evaluated: ${totalFormulas}`);
const buckets = {};
for (const rec of results) for (const m of rec.mismatches) buckets[m.bucket] = (buckets[m.bucket] || 0) + 1;
console.log('BUCKETS:', JSON.stringify(buckets));
const zeroMm = results.filter((r) => !r.loadError && r.mismatches.length === 0).length;
console.log(`files=${files.length} zeroMismatch=${zeroMm} loadErrors=${results.filter((r) => r.loadError).length}`);
console.log(`results written to ${outPath}`);
