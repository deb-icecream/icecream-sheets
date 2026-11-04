/** @icecream-sheets/xlsb-adapter — Excel Binary Workbook (.xlsb, BIFF12) storage adapter. */
export { XlsbAdapter, XlsbFormulaError } from './adapter.js';
export { compileFormula, decompileFormula } from './ptg.js';
export {
  buildSst,
  buildStyles,
  buildWorkbook,
  buildWorksheet,
  parseSst,
  parseStyles,
  parseWorkbook,
  parseWorksheet,
  type CachedValue,
  type WsCell,
  type WsCellValue,
  type WsDim,
  type XlsbStyles,
} from './records.js';
