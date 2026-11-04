import { describe, it } from 'vitest';
import { EngineWorkbook } from '../src/index.js';

const formulas: [string, unknown][] = [
  // D2 ACCRINTM
  ['=ACCRINTM(DATE(2008,4,1),DATE(2008,6,15),0.1,1000,3)', 20.54794521],
  ['=ACCRINTM(DATE(2008,4,1),DATE(2008,6,15),0.1,1000,0)', (1000 * 0.1 * 74) / 360],
  ['=ACCRINTM(DATE(2008,4,1),DATE(2008,6,15),0.1,1000,2)', (1000 * 0.1 * 75) / 360],
  ['=ACCRINTM(DATE(2008,4,1),DATE(2008,6,15),0.1,1000,1)', (1000 * 0.1 * 75) / 365],
  ['=ACCRINTM(DATE(2008,4,1),DATE(2008,6,15),0.1,1000,4)', (1000 * 0.1 * 74) / 360],
  // D3 COUPDAYS
  ['=COUPDAYS(DATE(2011,1,25),DATE(2011,11,15),2,1)', 181],
  ['=COUPDAYS(DATE(2011,1,25),DATE(2011,11,15),2,0)', 180],
  ['=COUPDAYS(DATE(2011,1,25),DATE(2011,11,15),2,3)', 181],
  ['=COUPDAYS(DATE(2011,1,25),DATE(2011,11,15),1,1)', 365],
  ['=COUPDAYS(DATE(2011,1,25),DATE(2011,11,15),4,1)', 92],
  // D23 PRICEDISC
  ['=PRICEDISC(DATE(2008,2,16),DATE(2008,3,1),0.0525,100,2)', 100 - 0.0525 * 100 * (14 / 360)],
  ['=PRICEDISC(DATE(2008,2,15),DATE(2008,5,15),0.05,100,3)', 100 * (1 - 0.05 * (90 / 365))],
  ['=PRICEDISC(DATE(2008,2,16),DATE(2008,3,1),0.0525,100,0)', 100 - 0.0525 * 100 * (15 / 360)],
  // D24 YIELDDISC
  ['=YIELDDISC(DATE(2008,2,16),DATE(2008,3,1),99.795,100,2)', ((100 - 99.795) / 99.795) * (360 / 14)],
  ['=YIELDDISC(DATE(2008,2,16),DATE(2008,3,1),99.795,100,3)', ((100 - 99.795) / 99.795) * (365 / 14)],
  ['=YIELDDISC(DATE(2008,2,16),DATE(2008,3,1),99.795,100,0)', ((100 - 99.795) / 99.795) * (360 / 15)],
  // D22 PERCENTOF
  ['=PERCENTOF({10,20},{10,20,30})', 0.5],
  ['=PERCENTOF(15,60)', 0.25],
  // D11 LINEST
  ['=INDEX(LINEST({2,4,5,7},{1,2,3,4}),1,1)', 1.6],
  ['=INDEX(LINEST({2,4,5,7},{1,2,3,4}),1,2)', 0.5],
  ['=INDEX(LINEST({2,4,5,7},{1,2,3,4},TRUE,TRUE),3,1)', 0.9846153846153847],
  ['=INDEX(LINEST({2,4,5,7},{1,2,3,4},TRUE,TRUE),2,1)', 0.16071428571428573], // sqrt(0.09/…)? placeholder checked below via print
  ['=INDEX(LINEST({2,4,5,7},{1,2,3,4},FALSE),1,2)', 0],
  // D12 LOGEST
  ['=INDEX(LOGEST({2,4,8,16},{1,2,3,4}),1,1)', 2],
  ['=INDEX(LOGEST({2,4,8,16},{1,2,3,4}),1,2)', 1],
];

describe('probe ext7 defects', () => {
  it('prints values', () => {
    const wb = new EngineWorkbook({ S: formulas.map(([f]) => [f]) });
    formulas.forEach(([f, exp], i) => {
      const v = wb.getValue({ sheet: 'S', row: i, col: 0 });
      console.log(f, '=>', JSON.stringify(v), 'expected ~', exp);
    });
    // BAHTTEXT strings
    const texts = [
      '=BAHTTEXT(1)', '=BAHTTEXT(1234)', '=BAHTTEXT(5.5)', '=BAHTTEXT(345.25)',
      '=BAHTTEXT(50)', '=BAHTTEXT(1789)', '=BAHTTEXT(21)', '=BAHTTEXT(11)',
      '=BAHTTEXT(101)', '=BAHTTEXT(0)', '=BAHTTEXT(0.5)', '=BAHTTEXT(0.01)',
      '=BAHTTEXT(-1)', '=BAHTTEXT(1000000)', '=BAHTTEXT(1000001)', '=BAHTTEXT(12.65)',
      '=BAHTTEXT(100)', '=BAHTTEXT(2000000)', '=BAHTTEXT(31)', '=BAHTTEXT(1000011)',
      '=BAHTTEXT(1234567.89)', '=BAHTTEXT(10.11)',
    ];
    const wb2 = new EngineWorkbook({ S: texts.map((f) => [f]) });
    texts.forEach((f, i) => {
      console.log(f, '=>', JSON.stringify(wb2.getValue({ sheet: 'S', row: i, col: 0 })));
    });
    // Spill check: LINEST placed at B2 should spill right/down
    const wb3 = new EngineWorkbook({
      S: [
        [null, null, null],
        [null, '=LINEST({2,4,5,7},{1,2,3,4},TRUE,TRUE)', null],
        [null, null, null],
        [null, null, null],
        [null, null, null],
        [null, null, null],
      ],
    });
    for (let r = 1; r <= 5; r++) {
      const row: unknown[] = [];
      for (let c = 1; c <= 2; c++) row.push(wb3.getValue({ sheet: 'S', row: r, col: c }));
      console.log('spill row', r, JSON.stringify(row));
    }
  });
});
