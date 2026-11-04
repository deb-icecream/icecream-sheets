/**
 * Data-cleaning skill pack.
 *
 * Spreadsheet data-cleaning workflows as MCP tools: dedupe,
 * text normalization, type coercion, missing-value handling, and
 * column split/merge. Every tool reads a sheet's used range as a
 * table (header row + data rows) through the authorized engine view,
 * transforms it, and writes the result back as a table — to a target
 * sheet when one is named, otherwise over the source sheet. Original
 * data is never touched until the transformed table is complete.
 */
import { z } from 'zod';
import type { SkillPack } from './types.js';
import {
  columnIndex,
  columnIndexes,
  readTable,
  writeTable,
  type TableData,
} from './grid.js';

const sheetArg = z.string().min(1);
const targetArg = z
  .string()
  .min(1)
  .optional()
  .describe('Sheet to write the result to. Defaults to overwriting the source sheet.');

function isMissing(v: unknown): boolean {
  return v === null || v === undefined || (typeof v === 'string' && v.trim() === '');
}

/** Stable key for row comparison: JSON of the selected cells (missing → empty). */
function rowKey(row: unknown[], cols: number[]): string {
  return JSON.stringify(cols.map((c) => (isMissing(row[c]) ? null : row[c])));
}

/** Parse a human-formatted number: $1,234.56 / (1,234) / 12% / 1.2e3. Null when unparseable. */
export function parseNumber(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v !== 'string') return null;
  let s = v.trim();
  if (s === '') return null;
  let negative = false;
  if (/^\(.*\)$/.test(s)) {
    negative = true;
    s = s.slice(1, -1).trim();
  }
  let percent = false;
  if (s.endsWith('%')) {
    percent = true;
    s = s.slice(0, -1).trim();
  }
  s = s.replace(/[$€£¥,\s]/g, '');
  if (s.startsWith('+')) s = s.slice(1);
  if (s === '' || s === '-' || s === '.') return null;
  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  const signed = negative ? -n : n;
  return percent ? signed / 100 : signed;
}

/** Normalize a date-ish value to an ISO yyyy-mm-dd string. Null when unparseable. */
export function parseDateIso(v: unknown): string | null {
  if (v instanceof Date && !Number.isNaN(v.getTime())) {
    return v.toISOString().slice(0, 10);
  }
  if (typeof v !== 'string') return null;
  const s = v.trim();
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (iso) {
    const d = new Date(`${iso[1]}-${iso[2]}-${iso[3]}T00:00:00Z`);
    return Number.isNaN(d.getTime()) ? null : `${iso[1]}-${iso[2]}-${iso[3]}`;
  }
  const us = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s);
  if (us) {
    const month = Number(us[1]);
    const day = Number(us[2]);
    if (month < 1 || month > 12 || day < 1 || day > 31) return null;
    return `${us[3]}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  }
  return null;
}

function titleCase(s: string): string {
  return s.replace(/\w\S*/g, (w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase());
}

export const dataCleaningPack: SkillPack = {
  id: 'data-cleaning',
  name: 'Data Cleaning',
  version: '1.0.0',
  description:
    'Clean messy sheet data through MCP tools: remove duplicate rows, normalize text, coerce column types, fill or drop missing values, and split or merge columns.',
  tools: [
    'clean_dedupe_rows',
    'clean_normalize_text',
    'clean_coerce_types',
    'clean_fill_missing',
    'clean_split_column',
    'clean_merge_columns',
  ],
  prompts: [
    {
      name: 'dedupe-and-tidy-orders',
      title: 'Dedupe and tidy an orders sheet',
      text: 'Clean the "Orders" sheet: first remove duplicate rows with clean_dedupe_rows, then trim and title-case the text columns with clean_normalize_text, and report how many duplicates were removed and how many cells changed.',
    },
    {
      name: 'make-columns-numeric',
      title: 'Make pasted columns numeric',
      text: 'The "Import" sheet was pasted from a web page, so amounts like $1,234.56 are stored as text. Use clean_coerce_types to convert the amount and quantity columns to numbers, fill any missing amounts with the column median via clean_fill_missing, then verify the total with a SUM formula.',
    },
  ],
  register(ctx) {
    const P = ctx.principalSchema;

    ctx.tool(
      'clean_dedupe_rows',
      'Remove duplicate rows from a sheet. Duplicates are rows whose values match on the key columns (all columns when none are named). Keeps the first occurrence (or the last, with keep="last"). Writes the deduped table to the target sheet (default: the source sheet) and reports how many rows were removed.',
      {
        sheet: sheetArg,
        columns: z.array(z.string().min(1)).max(50).optional(),
        keep: z.enum(['first', 'last']).optional(),
        targetSheet: targetArg,
        principal: P,
      },
      async (args: {
        sheet: string;
        columns?: string[];
        keep?: 'first' | 'last';
        targetSheet?: string;
        principal?: string;
      }) => {
        try {
          const auth = ctx.authOf(args);
          const table = await readTable(ctx.engine, args.sheet, auth);
          const cols = args.columns?.length
            ? columnIndexes(table, args.columns)
            : table.headers.map((_, i) => i);
          const keepLast = args.keep === 'last';
          const seen = new Map<string, number>();
          const kept: unknown[][] = [];
          const ordered = keepLast ? [...table.rows].reverse() : table.rows;
          for (const row of ordered) {
            const key = rowKey(row, cols);
            if (!seen.has(key)) {
              seen.set(key, 1);
              kept.push(row);
            }
          }
          const result = keepLast ? kept.reverse() : kept;
          const target = args.targetSheet ?? args.sheet;
          await writeTable(ctx.engine, target, table.headers, result, auth);
          return ctx.ok({
            sheet: args.sheet,
            targetSheet: target,
            rowsIn: table.rows.length,
            rowsOut: result.length,
            removed: table.rows.length - result.length,
            keyColumns: cols.map((c) => table.headers[c]),
          });
        } catch (e) {
          return ctx.error(e instanceof Error ? e.message : String(e));
        }
      },
    );

    ctx.tool(
      'clean_normalize_text',
      'Normalize text cells in a sheet: trim leading/trailing whitespace, collapse runs of internal whitespace to one space, and optionally change case (lower | upper | title). Applies to the named columns, or to every column containing text when none are named. Writes the result to the target sheet (default: the source sheet) and reports how many cells changed.',
      {
        sheet: sheetArg,
        columns: z.array(z.string().min(1)).max(50).optional(),
        case: z.enum(['none', 'lower', 'upper', 'title']).optional(),
        targetSheet: targetArg,
        principal: P,
      },
      async (args: {
        sheet: string;
        columns?: string[];
        case?: 'none' | 'lower' | 'upper' | 'title';
        targetSheet?: string;
        principal?: string;
      }) => {
        try {
          const auth = ctx.authOf(args);
          const table = await readTable(ctx.engine, args.sheet, auth);
          const mode = args.case ?? 'none';
          const cols = args.columns?.length
            ? columnIndexes(table, args.columns)
            : table.headers.map((_, i) => i);
          let changed = 0;
          const rows = table.rows.map((row) => {
            const out = [...row];
            for (const c of cols) {
              const v = out[c];
              if (typeof v !== 'string') continue;
              let next = v.trim().replace(/\s+/g, ' ');
              if (mode === 'lower') next = next.toLowerCase();
              else if (mode === 'upper') next = next.toUpperCase();
              else if (mode === 'title') next = titleCase(next);
              if (next !== v) {
                out[c] = next;
                changed++;
              }
            }
            return out;
          });
          const target = args.targetSheet ?? args.sheet;
          await writeTable(ctx.engine, target, table.headers, rows, auth);
          return ctx.ok({
            sheet: args.sheet,
            targetSheet: target,
            cellsChanged: changed,
            columns: cols.map((c) => table.headers[c]),
            case: mode,
          });
        } catch (e) {
          return ctx.error(e instanceof Error ? e.message : String(e));
        }
      },
    );

    ctx.tool(
      'clean_coerce_types',
      'Coerce columns to real types so formulas can compute over them. type "number" parses human formats ($1,234.56, (500), 12%, 1.2e3) into numbers; "date" normalizes ISO and MM/DD/YYYY dates to ISO yyyy-mm-dd text; "text" stringifies values. Unparseable cells are left unchanged and reported per column with examples. Writes to the target sheet (default: the source sheet).',
      {
        sheet: sheetArg,
        conversions: z
          .array(
            z.object({
              column: z.string().min(1),
              type: z.enum(['number', 'date', 'text']),
            }),
          )
          .min(1)
          .max(50),
        targetSheet: targetArg,
        principal: P,
      },
      async (args: {
        sheet: string;
        conversions: { column: string; type: 'number' | 'date' | 'text' }[];
        targetSheet?: string;
        principal?: string;
      }) => {
        try {
          const auth = ctx.authOf(args);
          const table = await readTable(ctx.engine, args.sheet, auth);
          const rows = table.rows.map((row) => [...row]);
          const report: Record<string, unknown>[] = [];
          for (const conv of args.conversions) {
            const c = columnIndex(table, conv.column);
            let converted = 0;
            let alreadyOk = 0;
            let failedCount = 0;
            const failedExamples: unknown[] = [];
            const noteFailure = (v: unknown) => {
              failedCount++;
              if (failedExamples.length < 5) failedExamples.push(v);
            };
            for (const row of rows) {
              const v = row[c];
              if (isMissing(v)) continue;
              if (conv.type === 'number') {
                if (typeof v === 'number') {
                  alreadyOk++;
                  continue;
                }
                const n = parseNumber(v);
                if (n === null) noteFailure(v);
                else {
                  row[c] = n;
                  converted++;
                }
              } else if (conv.type === 'date') {
                const iso = parseDateIso(v);
                if (iso === null) noteFailure(v);
                else if (iso === v) alreadyOk++;
                else {
                  row[c] = iso;
                  converted++;
                }
              } else {
                const s = String(v);
                if (s === v) alreadyOk++;
                else {
                  row[c] = s;
                  converted++;
                }
              }
            }
            report.push({
              column: table.headers[c],
              type: conv.type,
              converted,
              alreadyOk,
              failedCount,
              failedExamples,
            });
          }
          const target = args.targetSheet ?? args.sheet;
          await writeTable(ctx.engine, target, table.headers, rows, auth);
          return ctx.ok({ sheet: args.sheet, targetSheet: target, conversions: report });
        } catch (e) {
          return ctx.error(e instanceof Error ? e.message : String(e));
        }
      },
    );

    ctx.tool(
      'clean_fill_missing',
      'Handle missing (empty) values in one column. Strategies: "constant" fills with the given value; "mean" / "median" / "mode" fill with the column statistic (mean/median require numeric values); "forward" carries the last non-missing value down; "drop-row" removes rows missing that column. Writes to the target sheet (default: the source sheet) and reports how many cells were filled or rows dropped.',
      {
        sheet: sheetArg,
        column: z.string().min(1),
        strategy: z.enum(['constant', 'mean', 'median', 'mode', 'forward', 'drop-row']),
        value: z.union([z.string(), z.number(), z.boolean()]).optional(),
        targetSheet: targetArg,
        principal: P,
      },
      async (args: {
        sheet: string;
        column: string;
        strategy: 'constant' | 'mean' | 'median' | 'mode' | 'forward' | 'drop-row';
        value?: string | number | boolean;
        targetSheet?: string;
        principal?: string;
      }) => {
        try {
          const auth = ctx.authOf(args);
          const table = await readTable(ctx.engine, args.sheet, auth);
          const c = columnIndex(table, args.column);
          let filled = 0;
          let dropped = 0;
          let fillValue: unknown;
          const present = table.rows.map((r) => r[c]).filter((v) => !isMissing(v));
          if (args.strategy === 'mean' || args.strategy === 'median') {
            const nums = present.map(parseNumber).filter((n): n is number => n !== null);
            if (nums.length === 0) {
              return ctx.error(
                `column "${args.column}" has no numeric values to compute a ${args.strategy} from`,
              );
            }
            if (args.strategy === 'mean') {
              fillValue = nums.reduce((a, b) => a + b, 0) / nums.length;
            } else {
              const sorted = [...nums].sort((a, b) => a - b);
              const mid = Math.floor(sorted.length / 2);
              fillValue =
                sorted.length % 2 === 1
                  ? sorted[mid]
                  : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
            }
          } else if (args.strategy === 'mode') {
            if (present.length === 0) {
              return ctx.error(`column "${args.column}" has no values to compute a mode from`);
            }
            const counts = new Map<string, { value: unknown; count: number }>();
            for (const v of present) {
              const key = JSON.stringify(v);
              const entry = counts.get(key) ?? { value: v, count: 0 };
              entry.count++;
              counts.set(key, entry);
            }
            fillValue = [...counts.values()].sort((a, b) => b.count - a.count)[0]?.value;
          } else if (args.strategy === 'constant') {
            if (args.value === undefined) {
              return ctx.error('strategy "constant" requires a "value" to fill with');
            }
            fillValue = args.value;
          }
          let rows: unknown[][];
          if (args.strategy === 'drop-row') {
            rows = table.rows.filter((row) => {
              if (isMissing(row[c])) {
                dropped++;
                return false;
              }
              return true;
            });
          } else if (args.strategy === 'forward') {
            let last: unknown;
            let haveLast = false;
            rows = table.rows.map((row) => {
              const out = [...row];
              if (isMissing(out[c])) {
                if (haveLast) {
                  out[c] = last;
                  filled++;
                }
              } else {
                last = out[c];
                haveLast = true;
              }
              return out;
            });
          } else {
            rows = table.rows.map((row) => {
              const out = [...row];
              if (isMissing(out[c])) {
                out[c] = fillValue;
                filled++;
              }
              return out;
            });
          }
          const target = args.targetSheet ?? args.sheet;
          await writeTable(ctx.engine, target, table.headers, rows, auth);
          return ctx.ok({
            sheet: args.sheet,
            targetSheet: target,
            column: table.headers[c],
            strategy: args.strategy,
            filled,
            dropped,
            ...(fillValue !== undefined ? { fillValue } : {}),
            rowsOut: rows.length,
          });
        } catch (e) {
          return ctx.error(e instanceof Error ? e.message : String(e));
        }
      },
    );

    ctx.tool(
      'clean_split_column',
      'Split a text column into several columns on a delimiter (e.g. "Last, First" on ","). The new columns replace the source column in place; parts beyond the widest row are dropped, and when a row has more parts than the widest expected they are joined back with the delimiter into the last column. New column names default to "<column> 1", "<column> 2", ... Writes to the target sheet (default: the source sheet).',
      {
        sheet: sheetArg,
        column: z.string().min(1),
        delimiter: z.string().min(1).max(10).optional(),
        newColumns: z.array(z.string().min(1)).max(20).optional(),
        targetSheet: targetArg,
        principal: P,
      },
      async (args: {
        sheet: string;
        column: string;
        delimiter?: string;
        newColumns?: string[];
        targetSheet?: string;
        principal?: string;
      }) => {
        try {
          const auth = ctx.authOf(args);
          const table = await readTable(ctx.engine, args.sheet, auth);
          const c = columnIndex(table, args.column);
          const delim = args.delimiter ?? ',';
          const splitRows = table.rows.map((row) => {
            const v = row[c];
            if (typeof v !== 'string') return [v];
            return v.split(delim).map((p) => p.trim());
          });
          const width = Math.max(1, ...splitRows.map((parts) => parts.length));
          const names =
            args.newColumns && args.newColumns.length > 0
              ? args.newColumns
              : Array.from({ length: width }, (_, i) => `${table.headers[c]} ${i + 1}`);
          if (names.length < width) {
            return ctx.error(
              `splitting produces ${width} columns but only ${names.length} names were given — pass more newColumns or fewer`,
            );
          }
          const headers = [
            ...table.headers.slice(0, c),
            ...names.slice(0, width),
            ...table.headers.slice(c + 1),
          ];
          const rows = table.rows.map((row, i) => {
            const parts = splitRows[i] ?? [];
            const cells: unknown[] = [];
            for (let k = 0; k < width; k++) {
              if (k === width - 1 && parts.length > width) {
                cells.push(parts.slice(width - 1).join(delim));
              } else {
                cells.push(k < parts.length ? parts[k] : null);
              }
            }
            return [...row.slice(0, c), ...cells, ...row.slice(c + 1)];
          });
          const target = args.targetSheet ?? args.sheet;
          await writeTable(ctx.engine, target, headers, rows, auth);
          return ctx.ok({
            sheet: args.sheet,
            targetSheet: target,
            column: table.headers[c],
            producedColumns: names.slice(0, width),
            rows: rows.length,
          });
        } catch (e) {
          return ctx.error(e instanceof Error ? e.message : String(e));
        }
      },
    );

    ctx.tool(
      'clean_merge_columns',
      'Merge two or more columns into one new column, joining values with a separator (missing values contribute an empty part). The merged column is appended at the right; source columns are kept unless dropSource is true. Writes to the target sheet (default: the source sheet).',
      {
        sheet: sheetArg,
        columns: z.array(z.string().min(1)).min(2).max(20),
        newColumn: z.string().min(1),
        separator: z.string().max(10).optional(),
        dropSource: z.boolean().optional(),
        targetSheet: targetArg,
        principal: P,
      },
      async (args: {
        sheet: string;
        columns: string[];
        newColumn: string;
        separator?: string;
        dropSource?: boolean;
        targetSheet?: string;
        principal?: string;
      }) => {
        try {
          const auth = ctx.authOf(args);
          const table: TableData = await readTable(ctx.engine, args.sheet, auth);
          const cols = columnIndexes(table, args.columns);
          if (table.headers.some((h) => h.toLowerCase() === args.newColumn.toLowerCase())) {
            return ctx.error(`a column named "${args.newColumn}" already exists`);
          }
          const sep = args.separator ?? ' ';
          const drop = new Set(args.dropSource ? cols : []);
          const keepIdx = table.headers.map((_, i) => i).filter((i) => !drop.has(i));
          const headers = [...keepIdx.map((i) => table.headers[i] as string), args.newColumn];
          const rows = table.rows.map((row) => {
            const merged = cols
              .map((c) => (isMissing(row[c]) ? '' : String(row[c])))
              .join(sep);
            return [...keepIdx.map((i) => row[i]), merged];
          });
          const target = args.targetSheet ?? args.sheet;
          await writeTable(ctx.engine, target, headers, rows, auth);
          return ctx.ok({
            sheet: args.sheet,
            targetSheet: target,
            mergedFrom: cols.map((c) => table.headers[c]),
            newColumn: args.newColumn,
            rows: rows.length,
          });
        } catch (e) {
          return ctx.error(e instanceof Error ? e.message : String(e));
        }
      },
    );

    for (const p of dataCleaningPack.prompts) {
      ctx.prompt(`${dataCleaningPack.id}.${p.name}`, p.title, p.text);
    }
  },
};
