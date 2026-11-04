/** SCRATCH repro for ITEM A — will be replaced by the real regression test. */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { unzipSync, strFromU8 } from 'fflate';
import { XlsxAdapter } from '../src/index.js';
import { regenerateWorkbookXml, definedNamesEqual } from '../src/streamingSave.js';
import { parseDefinedNames } from '../src/fastSheetParse.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, '..', '..', '..', 'test-data', 'perf-fixtures', 'perf-p75.xlsx');
const bytes = (): Uint8Array => new Uint8Array(readFileSync(FIXTURE));

function wbXmlOf(pkg: Uint8Array): string {
  const files = unzipSync(pkg.slice());
  return strFromU8(files['xl/workbook.xml']!);
}

describe('ITEM A repro', () => {
  it('adapter read keeps _xlcn names verbatim', () => {
    const data = new XlsxAdapter().read(bytes());
    const xlcn = (data.definedNames ?? []).filter((n) => n.name.startsWith('_xlcn.'));
    console.log('read _xlcn:', JSON.stringify(xlcn, null, 1));
    expect(xlcn.length).toBe(9);
  });

  it('streaming regeneration with live (degraded) desired table', () => {
    const data = new XlsxAdapter().read(bytes());
    const srcXml = wbXmlOf(bytes());
    // Simulate the engine live table: HF-serialized parse-error names come
    // back as #ERROR! (verified against engine behavior / audit output).
    const live = (data.definedNames ?? []).map((dn) =>
      dn.name.startsWith('_xlcn.') ? { ...dn, ref: '#ERROR!' } : dn,
    );
    console.log('definedNamesEqual(src, live) =', definedNamesEqual(srcXml, live));
    const out = regenerateWorkbookXml(srcXml, live);
    const parsed = parseDefinedNames(out).filter((n) => n.name.startsWith('_xlcn.'));
    console.log('after regen _xlcn:', JSON.stringify(parsed));
    const raw = out.match(/<definedName[^>]*_xlcn[^>]*>[^<]*<\/definedName>/g);
    console.log('raw elements:', raw);
  });

  it('streaming regeneration with verbatim desired table', () => {
    const data = new XlsxAdapter().read(bytes());
    const srcXml = wbXmlOf(bytes());
    console.log('definedNamesEqual(src, verbatim) =', definedNamesEqual(srcXml, data.definedNames ?? []));
    const out = regenerateWorkbookXml(srcXml, data.definedNames ?? []);
    const parsed = parseDefinedNames(out).filter((n) => n.name.startsWith('_xlcn.'));
    console.log('verbatim regen _xlcn:', JSON.stringify(parsed));
    console.log('raw:', out.match(/<definedName[^>]*_xlcn[^>]*>[^<]*<\/definedName>/g));
  });

  it('classic adapter.write round-trip', () => {
    const adapter = new XlsxAdapter();
    const data = adapter.read(bytes());
    const out = adapter.write(data);
    const parsed = parseDefinedNames(wbXmlOf(out)).filter((n) => n.name.startsWith('_xlcn.'));
    console.log('classic write _xlcn:', JSON.stringify(parsed));
    console.log('raw:', wbXmlOf(out).match(/<definedName[^>]*_xlcn[^>]*>[^<]*<\/definedName>/g));
  });
});
