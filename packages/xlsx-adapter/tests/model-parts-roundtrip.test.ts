/**
 * Data-model part round-trip (#114 save constraint): saving a file that
 * carries a data model must carry its model parts through untouched, or
 * Excel loses the model on round-trip. bxl3way carries xl/connections.xml
 * and xl/model/item.data; both must survive load -> save byte-identical,
 * along with the workbook relationships that reference them.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { unzipSync } from 'fflate';
import { XlsxAdapter } from '../src/index.js';

const dir = join(dirname(fileURLToPath(import.meta.url)), '../../../test-data/real-world');
const FILE = join(dir, 'beyond-excel-bxl3way.xlsx');

function partNames(bytes: Uint8Array): string[] {
  return Object.keys(unzipSync(bytes.slice()));
}

describe('data-model part round-trip (#114)', () => {
  it('carries connections.xml and model/item.data through load -> save byte-identical', () => {
    const adapter = new XlsxAdapter();
    const original = new Uint8Array(readFileSync(FILE));
    const origParts = unzipSync(original.slice());
    const data = adapter.read(original);
    const saved = adapter.write(data, original);
    const savedParts = unzipSync(saved.slice());
    for (const path of ['xl/connections.xml', 'xl/model/item.data']) {
      expect(savedParts[path], `${path} survives the round-trip`).toBeDefined();
      expect(
        Buffer.from(savedParts[path]!).equals(Buffer.from(origParts[path]!)),
        `${path} is byte-identical`,
      ).toBe(true);
    }
    // The workbook relationships referencing those parts survive too.
    const rels = new TextDecoder().decode(savedParts['xl/_rels/workbook.xml.rels']!);
    expect(rels).toContain('Target="connections.xml"');
    expect(rels).toContain('Target="model/item.data"');
  });

  it('leaves files without model parts unchanged (no spurious parts added)', () => {
    const adapter = new XlsxAdapter();
    const data = adapter.read(
      new Uint8Array(readFileSync(join(dir, 'xlsxwriter-chart_doughnut01.xlsx'))),
    );
    const saved = adapter.write(data);
    const names = partNames(saved);
    expect(names).not.toContain('xl/connections.xml');
    expect(names).not.toContain('xl/model/item.data');
  });
});
