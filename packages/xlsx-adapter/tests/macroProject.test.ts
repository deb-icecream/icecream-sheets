/**
 * Tests for VBA macro project preservation: a .xlsm's vbaProject.bin is
 * carried through open/save as opaque, non-executable bytes, and a plain
 * .xlsx is unaffected.
 */
import { describe, expect, it } from 'vitest';
import { strToU8, unzipSync, zipSync } from 'fflate';
import { XlsxAdapter } from '../src/index.js';
import {
  MACRO_PROJECT_KEY,
  MACRO_PROJECT_PRESENT_KEY,
  VBA_PROJECT_PATH,
  base64ToU8,
  extractMacroProject,
  injectMacroProject,
  u8ToBase64,
} from '../src/index.js';

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
</Types>`;

const RELS = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`;

const WORKBOOK = `<?xml version="1.0" encoding="UTF-8"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets>
</workbook>`;

const WORKBOOK_RELS = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
</Relationships>`;

const SHEET1 = `<?xml version="1.0" encoding="UTF-8"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <sheetData>
    <row r="1"><c r="A1" t="n"><v>42</v></c></row>
  </sheetData>
</worksheet>`;

/** Deterministic fake VBA project bytes (opaque to us, like the real thing). */
function fakeVbaProject(): Uint8Array {
  const out = new Uint8Array(1024);
  for (let i = 0; i < out.length; i++) out[i] = (i * 31 + 7) % 256;
  return out;
}

function buildXlsm(vbaProject: Uint8Array | null): Uint8Array {
  const files: Record<string, Uint8Array> = {
    '[Content_Types].xml': strToU8(CONTENT_TYPES),
    '_rels/.rels': strToU8(RELS),
    'xl/workbook.xml': strToU8(WORKBOOK),
    'xl/_rels/workbook.xml.rels': strToU8(WORKBOOK_RELS),
    'xl/worksheets/sheet1.xml': strToU8(SHEET1),
  };
  if (vbaProject) files[VBA_PROJECT_PATH] = vbaProject;
  return zipSync(files);
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

describe('macro project preservation', () => {
  it('extractMacroProject finds vbaProject.bin and returns null without one', () => {
    const vba = fakeVbaProject();
    const found = extractMacroProject(buildXlsm(vba));
    expect(found).not.toBeNull();
    expect(bytesEqual(found!, vba)).toBe(true);
    expect(extractMacroProject(buildXlsm(null))).toBeNull();
    expect(extractMacroProject(new Uint8Array([1, 2, 3]))).toBeNull();
  });

  it('base64 helpers round-trip binary bytes', () => {
    const vba = fakeVbaProject();
    expect(bytesEqual(base64ToU8(u8ToBase64(vba)), vba)).toBe(true);
  });

  it('injectMacroProject adds the part, content type and relationship', () => {
    const vba = fakeVbaProject();
    const patched = injectMacroProject(buildXlsm(null), vba);
    const files = unzipSync(patched);
    expect(bytesEqual(files[VBA_PROJECT_PATH]!, vba)).toBe(true);
    const ct = new TextDecoder().decode(files['[Content_Types].xml']!);
    expect(ct).toContain('vbaProject');
    expect(ct).toContain('application/vnd.ms-office.vbaProject');
    const rels = new TextDecoder().decode(files['xl/_rels/workbook.xml.rels']!);
    expect(rels).toContain('vbaProject');
  });

  it('injectMacroProject is idempotent (no duplicate overrides)', () => {
    const vba = fakeVbaProject();
    const once = injectMacroProject(buildXlsm(null), vba);
    const twice = injectMacroProject(once, vba);
    const ct = new TextDecoder().decode(unzipSync(twice)['[Content_Types].xml']!);
    expect(ct.match(/vbaProject/g)!.length).toBe(2); // PartName + ContentType, once each
  });

  it('adapter read stashes the macro project in metadata as an opaque hint', () => {
    const adapter = new XlsxAdapter();
    const vba = fakeVbaProject();
    const data = adapter.read(buildXlsm(vba));
    expect(data.sheets[0]!.rows[0]![0]).toBe(42); // sheet content still parses
    expect(data.metadata[MACRO_PROJECT_PRESENT_KEY]).toBe(true);
    const stored = data.metadata[MACRO_PROJECT_KEY];
    expect(typeof stored).toBe('string');
    expect(bytesEqual(base64ToU8(stored as string), vba)).toBe(true);
  });

  it('adapter write round-trips the macro project byte-for-byte', () => {
    const adapter = new XlsxAdapter();
    const vba = fakeVbaProject();
    const data = adapter.read(buildXlsm(vba));
    const out = adapter.write(data);
    const back = extractMacroProject(out);
    expect(back).not.toBeNull();
    expect(bytesEqual(back!, vba)).toBe(true);
    // And the workbook content survives alongside it.
    const reread = adapter.read(out);
    expect(reread.sheets[0]!.rows[0]![0]).toBe(42);
    expect(reread.metadata[MACRO_PROJECT_PRESENT_KEY]).toBe(true);
  });

  it('plain xlsx files are unaffected (no macro metadata, no vba part)', () => {
    const adapter = new XlsxAdapter();
    const data = adapter.read(buildXlsm(null));
    expect(MACRO_PROJECT_KEY in data.metadata).toBe(false);
    expect(MACRO_PROJECT_PRESENT_KEY in data.metadata).toBe(false);
    const out = adapter.write(data);
    expect(extractMacroProject(out)).toBeNull();
  });
});
