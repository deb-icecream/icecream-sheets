import { describe, it } from 'vitest';
import { EngineWorkbook } from '../src/index.js';
describe('probe', () => {
  it('args', () => {
    const wb = new EngineWorkbook({ S: [
      ['=LINEST({2,4,5,7})'],
      ['=LINEST({2,4,5,7},{1,2,3,4})'],
      ['=LINEST(A5:A8,B5:B8)'],
      [null],[2],[4],[5],[7],
    ] });
    for (let r = 0; r < 3; r++) console.log('row', r, JSON.stringify(wb.getValue({ sheet: 'S', row: r, col: 0 })));
  });
});
