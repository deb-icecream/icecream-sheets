/**
 * Survey-analysis skill pack.
 *
 * Response coding, tabulation, and charting for survey data as MCP
 * tools. Coding canonicalizes free-text/categorical answers into a
 * code column with a codebook; frequencies and cross-tabulations are
 * computed from the authorized sheet data and written back as tables;
 * charting writes the frequency table and creates a native chart over
 * it through the same ChartSink seam as the core create_chart tool
 * (fail-closed when the host wired no sink).
 */
import { z } from 'zod';
import { makeChartSpec, type ChartSpec } from '@icecream-sheets/service';
import type { SkillPack } from './types.js';
import { columnIndex, ensureSheet, readTable, writeTable } from './grid.js';

function isMissing(v: unknown): boolean {
  return v === null || v === undefined || (typeof v === 'string' && v.trim() === '');
}

/** Canonical comparison key for a response value: trimmed, whitespace-collapsed, lowercased. */
export function responseKey(v: unknown): string {
  if (isMissing(v)) return '';
  return String(v).trim().replace(/\s+/g, ' ').toLowerCase();
}

/** Display label for a response value: the trimmed original text. */
function responseLabel(v: unknown): string {
  return typeof v === 'string' ? v.trim().replace(/\s+/g, ' ') : String(v);
}

/** Chart id sequence (mirrors create_chart's counter approach in server.ts). */
let surveyChartSeq = 0;

const CHART_KIND_MAP = {
  column: 'column-clustered',
  bar: 'bar-clustered',
  line: 'line',
  area: 'area',
  pie: 'pie',
  doughnut: 'doughnut',
} as const;

export const surveyAnalysisPack: SkillPack = {
  id: 'survey-analysis',
  name: 'Survey Analysis',
  version: '1.0.0',
  description:
    'Analyze survey responses through MCP tools: code free-text answers into a codebook-backed column, build frequency tables and cross-tabulations, and chart the results as a native sheet chart.',
  tools: [
    'survey_code_responses',
    'survey_frequencies',
    'survey_crosstab',
    'survey_chart_results',
  ],
  prompts: [
    {
      name: 'code-open-text',
      title: 'Code the open-text answers',
      text: 'On the "Responses" sheet, use survey_code_responses on the "How did you hear about us?" column to canonicalize the messy answers into a code column, and show me the codebook with counts.',
    },
    {
      name: 'satisfaction-by-plan',
      title: 'Satisfaction by plan, tabulated and charted',
      text: 'On the "Responses" sheet, cross-tabulate "Plan" by "Satisfaction" with survey_crosstab, build the satisfaction frequency table with survey_frequencies, and chart it with survey_chart_results.',
    },
  ],
  register(ctx) {
    const P = ctx.principalSchema;

    ctx.tool(
      'survey_code_responses',
      'Code a survey response column: canonicalizes each answer (trimmed, case-insensitive matching) and writes the code into a code column. With a "mapping" (answer text -> code), matching answers get the mapped code and unmatched answers are reported; without one, each distinct answer becomes its own code (its canonical label). Returns the codebook: every code with its label and response count.',
      {
        sheet: z.string().min(1),
        column: z.string().min(1),
        mapping: z.record(z.string(), z.string()).optional(),
        codeColumn: z.string().min(1).optional(),
        targetSheet: z.string().min(1).optional(),
        principal: P,
      },
      async (args: {
        sheet: string;
        column: string;
        mapping?: Record<string, string>;
        codeColumn?: string;
        targetSheet?: string;
        principal?: string;
      }) => {
        try {
          const auth = ctx.authOf(args);
          const table = await readTable(ctx.engine, args.sheet, auth);
          const c = columnIndex(table, args.column);
          const codeName = args.codeColumn ?? `${table.headers[c]} Code`;
          if (
            args.targetSheet === undefined &&
            table.headers.some((h) => h.toLowerCase() === codeName.toLowerCase())
          ) {
            return ctx.error(
              `a column named "${codeName}" already exists — pass a different codeColumn or a targetSheet`,
            );
          }
          const mapping = new Map<string, string>();
          if (args.mapping) {
            for (const [k, v] of Object.entries(args.mapping)) {
              mapping.set(responseKey(k), v);
            }
          }
          const codebook = new Map<string, { code: string; label: string; count: number }>();
          const unmapped = new Map<string, number>();
          const codes: (string | null)[] = [];
          let missingCount = 0;
          for (const row of table.rows) {
            const v = row[c];
            if (isMissing(v)) {
              missingCount++;
              codes.push(null);
              continue;
            }
            const key = responseKey(v);
            let code: string | null;
            if (mapping.size > 0) {
              code = mapping.get(key) ?? null;
              if (code === null) {
                unmapped.set(responseLabel(v), (unmapped.get(responseLabel(v)) ?? 0) + 1);
              }
            } else {
              code = responseLabel(v);
            }
            codes.push(code);
            if (code !== null) {
              const entry = codebook.get(code) ?? { code, label: responseLabel(v), count: 0 };
              entry.count++;
              codebook.set(code, entry);
            }
          }
          const headers = [...table.headers, codeName];
          const rows = table.rows.map((row, i) => [...row, codes[i] ?? null]);
          const target = args.targetSheet ?? args.sheet;
          await writeTable(ctx.engine, target, headers, rows, auth);
          return ctx.ok({
            sheet: args.sheet,
            targetSheet: target,
            column: table.headers[c],
            codeColumn: codeName,
            coded: codes.filter((x) => x !== null).length,
            missing: missingCount,
            codebook: [...codebook.values()].sort(
              (a, b) => b.count - a.count || a.code.localeCompare(b.code),
            ),
            ...(unmapped.size > 0
              ? {
                  unmapped: [...unmapped.entries()].map(([label, count]) => ({ label, count })),
                }
              : {}),
          });
        } catch (e) {
          return ctx.error(e instanceof Error ? e.message : String(e));
        }
      },
    );

    ctx.tool(
      'survey_frequencies',
      'Build a frequency table for one response column: count, percent of valid responses, and cumulative percent per distinct answer, written to the target sheet (default "Frequencies") and returned. Missing answers are excluded unless includeMissing is true (they then appear as "(missing)").',
      {
        sheet: z.string().min(1),
        column: z.string().min(1),
        targetSheet: z.string().min(1).optional(),
        sortBy: z.enum(['count', 'label']).optional(),
        includeMissing: z.boolean().optional(),
        principal: P,
      },
      async (args: {
        sheet: string;
        column: string;
        targetSheet?: string;
        sortBy?: 'count' | 'label';
        includeMissing?: boolean;
        principal?: string;
      }) => {
        try {
          const auth = ctx.authOf(args);
          const table = await readTable(ctx.engine, args.sheet, auth);
          const c = columnIndex(table, args.column);
          const counts = new Map<string, { label: string; count: number }>();
          let missing = 0;
          for (const row of table.rows) {
            const v = row[c];
            if (isMissing(v)) {
              missing++;
              continue;
            }
            const key = responseKey(v);
            const entry = counts.get(key) ?? { label: responseLabel(v), count: 0 };
            entry.count++;
            counts.set(key, entry);
          }
          const valid = table.rows.length - missing;
          const denom = args.includeMissing ? table.rows.length : valid;
          if (denom === 0) return ctx.error(`column "${args.column}" has no responses`);
          const entries = [...counts.values()];
          if (args.includeMissing && missing > 0) {
            entries.push({ label: '(missing)', count: missing });
          }
          entries.sort((a, b) =>
            args.sortBy === 'label'
              ? a.label.localeCompare(b.label)
              : b.count - a.count || a.label.localeCompare(b.label),
          );
          let cumulative = 0;
          const rows = entries.map((e) => {
            const pct = e.count / denom;
            cumulative += pct;
            return [e.label, e.count, pct, cumulative];
          });
          const target = args.targetSheet ?? 'Frequencies';
          await writeTable(
            ctx.engine,
            target,
            [table.headers[c] as string, 'Count', 'Percent', 'Cumulative %'],
            rows,
            auth,
          );
          return ctx.ok({
            sheet: args.sheet,
            targetSheet: target,
            column: table.headers[c],
            totalResponses: table.rows.length,
            validResponses: valid,
            missing,
            table: rows.map(([label, count, percent, cumulativePct]) => ({
              label,
              count,
              percent,
              cumulativePct,
            })),
          });
        } catch (e) {
          return ctx.error(e instanceof Error ? e.message : String(e));
        }
      },
    );

    ctx.tool(
      'survey_crosstab',
      'Cross-tabulate two response columns: counts of every row-answer x column-answer combination, with row and column totals and a grand total, written to the target sheet (default "Crosstab") and returned. Rows where either answer is missing are excluded and reported. With values="row-percent" or "column-percent" the sheet cells hold percents instead of counts (the returned matrix always carries counts).',
      {
        sheet: z.string().min(1),
        rowColumn: z.string().min(1),
        columnColumn: z.string().min(1),
        values: z.enum(['count', 'row-percent', 'column-percent']).optional(),
        targetSheet: z.string().min(1).optional(),
        principal: P,
      },
      async (args: {
        sheet: string;
        rowColumn: string;
        columnColumn: string;
        values?: 'count' | 'row-percent' | 'column-percent';
        targetSheet?: string;
        principal?: string;
      }) => {
        try {
          const auth = ctx.authOf(args);
          const table = await readTable(ctx.engine, args.sheet, auth);
          const rc = columnIndex(table, args.rowColumn);
          const cc = columnIndex(table, args.columnColumn);
          const rowLabels = new Map<string, string>();
          const colLabels = new Map<string, string>();
          const cells = new Map<string, number>();
          let excluded = 0;
          for (const row of table.rows) {
            const rv = row[rc];
            const cv = row[cc];
            if (isMissing(rv) || isMissing(cv)) {
              excluded++;
              continue;
            }
            const rk = responseKey(rv);
            const ck = responseKey(cv);
            if (!rowLabels.has(rk)) rowLabels.set(rk, responseLabel(rv));
            if (!colLabels.has(ck)) colLabels.set(ck, responseLabel(cv));
            const key = `${rk} ${ck}`;
            cells.set(key, (cells.get(key) ?? 0) + 1);
          }
          const rowKeys = [...rowLabels.keys()].sort((a, b) =>
            (rowLabels.get(a) as string).localeCompare(rowLabels.get(b) as string),
          );
          const colKeys = [...colLabels.keys()].sort((a, b) =>
            (colLabels.get(a) as string).localeCompare(colLabels.get(b) as string),
          );
          const matrix = rowKeys.map((rk) =>
            colKeys.map((ck) => cells.get(`${rk} ${ck}`) ?? 0),
          );
          const rowTotals = matrix.map((r) => r.reduce((a, b) => a + b, 0));
          const colTotals = colKeys.map((_, j) =>
            matrix.reduce((a, r) => a + (r[j] as number), 0),
          );
          const grandTotal = rowTotals.reduce((a, b) => a + b, 0);
          const mode = args.values ?? 'count';
          const display = matrix.map((r, i) =>
            r.map((count, j) => {
              if (mode === 'count') return count;
              if (mode === 'row-percent') {
                return (rowTotals[i] as number) === 0 ? 0 : count / (rowTotals[i] as number);
              }
              return (colTotals[j] as number) === 0 ? 0 : count / (colTotals[j] as number);
            }),
          );
          const target = args.targetSheet ?? 'Crosstab';
          const headers = [
            table.headers[rc] as string,
            ...colKeys.map((ck) => colLabels.get(ck) as string),
            'Total',
          ];
          const outRows: unknown[][] = display.map((r, i) => [
            rowLabels.get(rowKeys[i] as string) as string,
            ...r,
            mode === 'count' ? (rowTotals[i] as number) : 1,
          ]);
          outRows.push([
            'Total',
            ...colTotals.map((t) => (mode === 'count' ? t : 1)),
            mode === 'count' ? grandTotal : 1,
          ]);
          await writeTable(ctx.engine, target, headers, outRows, auth);
          return ctx.ok({
            sheet: args.sheet,
            targetSheet: target,
            rowColumn: table.headers[rc],
            columnColumn: table.headers[cc],
            rowLabels: rowKeys.map((rk) => rowLabels.get(rk)),
            columnLabels: colKeys.map((ck) => colLabels.get(ck)),
            matrix,
            rowTotals,
            columnTotals: colTotals,
            grandTotal,
            excludedMissing: excluded,
          });
        } catch (e) {
          return ctx.error(e instanceof Error ? e.message : String(e));
        }
      },
    );

    ctx.tool(
      'survey_chart_results',
      'Chart one response column: computes its frequency table, writes it to the target sheet (default "Chart Data"), and creates a NATIVE chart over that table in the workbook through the session chart sink — the same mechanism as create_chart. Fails closed when the session has no chart sink, exactly like create_chart; the frequency table is still written in that case only when a sink exists, so a failure means nothing was written.',
      {
        sheet: z.string().min(1),
        column: z.string().min(1),
        kind: z.enum(['column', 'bar', 'line', 'area', 'pie', 'doughnut']).optional(),
        title: z.string().min(1).max(200).optional(),
        targetSheet: z.string().min(1).optional(),
        principal: P,
      },
      async (args: {
        sheet: string;
        column: string;
        kind?: 'column' | 'bar' | 'line' | 'area' | 'pie' | 'doughnut';
        title?: string;
        targetSheet?: string;
        principal?: string;
      }) => {
        try {
          const auth = ctx.authOf(args);
          const sink = ctx.charts;
          if (!sink) {
            return ctx.error('chart creation is not available in this session');
          }
          const table = await readTable(ctx.engine, args.sheet, auth);
          const c = columnIndex(table, args.column);
          const counts = new Map<string, { label: string; count: number }>();
          for (const row of table.rows) {
            const v = row[c];
            if (isMissing(v)) continue;
            const key = responseKey(v);
            const entry = counts.get(key) ?? { label: responseLabel(v), count: 0 };
            entry.count++;
            counts.set(key, entry);
          }
          const entries = [...counts.values()].sort(
            (a, b) => b.count - a.count || a.label.localeCompare(b.label),
          );
          if (entries.length === 0) {
            return ctx.error(`column "${args.column}" has no responses to chart`);
          }
          const target = args.targetSheet ?? 'Chart Data';
          await ensureSheet(ctx.engine, target, auth);
          await writeTable(
            ctx.engine,
            target,
            [table.headers[c] as string, 'Count'],
            entries.map((e) => [e.label, e.count]),
            auth,
          );
          const seriesRanges: ChartSpec['seriesRanges'] = [
            {
              name: 'Count',
              cat: { sheet: target, startRow: 1, startCol: 0, endRow: entries.length, endCol: 0 },
              val: { sheet: target, startRow: 1, startCol: 1, endRow: entries.length, endCol: 1 },
            },
          ];
          const kind = args.kind ?? 'column';
          const spec = makeChartSpec({
            id: Date.now() * 1000 + surveyChartSeq++,
            kind: CHART_KIND_MAP[kind],
            title: args.title ?? `${table.headers[c]} — responses`,
            range: { sheet: target, startRow: 0, startCol: 0, endRow: entries.length, endCol: 1 },
            seriesRanges,
            anchorCells: { fromCol: 3, fromRow: 0, toCol: 11, toRow: 15 },
            x: 3 * 64,
            y: 0,
            w: 512,
            h: 300,
            nativePart: true,
          });
          const out = await sink.addChart(spec, auth.principal);
          return ctx.ok({
            chartId: out.id,
            revision: out.revision,
            kind: spec.kind,
            title: spec.title,
            dataSheet: target,
            categories: entries.length,
            table: entries.map((e) => ({ label: e.label, count: e.count })),
          });
        } catch (e) {
          return ctx.error(e instanceof Error ? e.message : String(e));
        }
      },
    );

    for (const p of surveyAnalysisPack.prompts) {
      ctx.prompt(`${surveyAnalysisPack.id}.${p.name}`, p.title, p.text);
    }
  },
};
