import { describe, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { XlsxAdapter } from '../src/index.js';

const dir = join(dirname(fileURLToPath(import.meta.url)), '../../../test-data/real-world');

describe('adapter probe', () => {
  it('dumps ceiling-floor row 4 and beyond-excel CHKs', () => {
    const adapter = new XlsxAdapter();
    const data: any = adapter.read(
      new Uint8Array(readFileSync(join(dir, 'closedxml-xlsx-ceiling-floor.xlsx'))),
    );
    const sh = data.sheets.find((s: any) => s.name === 'Sheet1');
    for (let r = 2; r <= 5; r++) {
      console.log(
        'row' + (r + 1),
        JSON.stringify(sh.rows[r].slice(0, 12)),
      );
    }
    const data2: any = adapter.read(
      new Uint8Array(readFileSync(join(dir, 'beyond-excel-bxl3way.xlsx'))),
    );
    const chks = data2.sheets.find((s: any) => s.name === 'CHKs');
    console.log('CHKs J7:', JSON.stringify(chks.rows[6][9]));
    console.log('CHKs G8:', JSON.stringify(chks.rows[7][6]));
    console.log('definedNames sample:', JSON.stringify(data2.definedNames.slice(0, 5)));
    const data3: any = adapter.read(
      new Uint8Array(
        readFileSync(join(dir, 'closedxml-TryToLoad-FileWithDefaultStyleNameNotInEnglish.xlsx')),
      ),
    );
    console.log('NotEnglish definedNames:', JSON.stringify(data3.definedNames));
    const sh3 = data3.sheets[0];
    console.log('G4:', JSON.stringify(sh3.rows[3][6]));
  });
});
