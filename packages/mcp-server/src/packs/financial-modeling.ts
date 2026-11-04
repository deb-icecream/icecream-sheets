/**
 * Financial-modeling skill pack.
 *
 * Forecasting, valuation, and what-if analysis as MCP tools. The
 * tools build LIVE spreadsheet models: forecast and valuation cells
 * are written as engine formulas (SLOPE/INTERCEPT, NPV, IRR) over the
 * source ranges, so the model recalculates when inputs change — the
 * tool reads back the computed values and returns them. The scenario
 * sweep drives the sheet's own formulas: it varies one input cell,
 * recalculates, and records the output cell for each value, then
 * restores the original input.
 */
import { z } from 'zod';
import type { SkillPack } from './types.js';
import {
  a1,
  a1Range,
  columnIndex,
  ensureSheet,
  readTable,
  setCell,
  setFormula,
  writeTable,
} from './grid.js';

/** Parse an A1 cell reference ("B12") into 0-based {row, col}. Throws on bad input. */
export function parseA1(ref: string): { row: number; col: number } {
  const m = /^([A-Za-z]+)([0-9]+)$/.exec(ref.trim());
  if (!m) throw new Error(`"${ref}" is not an A1 cell reference (expected e.g. "B12")`);
  const letters = (m[1] as string).toUpperCase();
  let col = 0;
  for (const ch of letters) col = col * 26 + (ch.charCodeAt(0) - 64);
  const row = Number(m[2]);
  if (row < 1) throw new Error(`"${ref}" has an invalid row (rows start at 1)`);
  return { row: row - 1, col: col - 1 };
}

export const financialModelingPack: SkillPack = {
  id: 'financial-modeling',
  name: 'Financial Modeling',
  version: '1.0.0',
  description:
    'Build live financial models through MCP tools: trend and growth forecasts written as sheet formulas, NPV/IRR valuation over a cash-flow column, and what-if scenario sweeps that drive the sheet\'s own formulas.',
  tools: ['fin_forecast', 'fin_npv_irr', 'fin_scenario_sweep'],
  prompts: [
    {
      name: 'project-revenue',
      title: 'Project revenue for the next 6 periods',
      text: 'In the "Model" sheet, use fin_forecast to project the Revenue column 6 periods ahead with the linear method, then read back the forecast rows and summarize the trend (slope per period and the final projected value).',
    },
    {
      name: 'value-this-project',
      title: 'Value a project from its cash flows',
      text: 'The "Project" sheet has a CashFlow column and an initial investment of 10000. Use fin_npv_irr at a 10% discount rate to compute NPV and IRR, and tell me whether the project clears a 12% hurdle rate.',
    },
    {
      name: 'stress-test-price',
      title: 'Stress-test the price input',
      text: 'In the "Pricing" sheet the unit price is in B2 and profit is computed in B10. Use fin_scenario_sweep to vary B2 over 8, 9, 10, 11, 12 and show me the profit at each price.',
    },
  ],
  register(ctx) {
    const P = ctx.principalSchema;

    ctx.tool(
      'fin_forecast',
      'Project a numeric column forward and write the forecast as LIVE formulas in the sheet. method "linear": each forecast cell is =INTERCEPT(y,x)+SLOPE(y,x)*x over the source ranges. method "growth": compound growth at the historical CAGR, each forecast cell =previous*(1+CAGR). Forecast rows are appended below the data (the period column is continued by its last step when numeric). Returns the computed forecast values read back from the sheet.',
      {
        sheet: z.string().min(1),
        valueColumn: z.string().min(1),
        periodColumn: z.string().min(1).optional(),
        periods: z.number().int().min(1).max(120),
        method: z.enum(['linear', 'growth']).optional(),
        principal: P,
      },
      async (args: {
        sheet: string;
        valueColumn: string;
        periodColumn?: string;
        periods: number;
        method?: 'linear' | 'growth';
        principal?: string;
      }) => {
        try {
          const auth = ctx.authOf(args);
          const table = await readTable(ctx.engine, args.sheet, auth);
          const vc = columnIndex(table, args.valueColumn);
          const pc = args.periodColumn ? columnIndex(table, args.periodColumn) : -1;
          const values = table.rows.map((r) => r[vc]);
          const nums = values.map((v) => (typeof v === 'number' ? v : null));
          if (nums.some((n) => n === null)) {
            return ctx.error(
              `column "${args.valueColumn}" contains non-numeric values — coerce it first (clean_coerce_types)`,
            );
          }
          const ys = nums as number[];
          if (ys.length < 2) {
            return ctx.error('forecast needs at least 2 data points');
          }
          const method = args.method ?? 'linear';
          const firstDataRow = table.startRow + 1; // 0-based sheet row of first data row
          const lastDataRow = firstDataRow + ys.length - 1;
          const yRange = a1Range(firstDataRow, vc, lastDataRow, vc);
          // x values: the period column when numeric, else 1..n positions.
          const periodVals =
            pc >= 0 ? table.rows.map((r) => r[pc]) : ys.map((_, i) => i + 1);
          const periodNumeric = periodVals.every((v) => typeof v === 'number');
          const xs = periodNumeric
            ? (periodVals as number[])
            : ys.map((_, i) => i + 1);
          const xRange =
            pc >= 0 && periodNumeric ? a1Range(firstDataRow, pc, lastDataRow, pc) : null;
          // Continue the period axis for forecast rows.
          const step =
            xs.length >= 2 ? (xs[xs.length - 1] as number) - (xs[xs.length - 2] as number) : 1;
          const forecastXs = Array.from(
            { length: args.periods },
            (_, i) => (xs[xs.length - 1] as number) + step * (i + 1),
          );

          let cagr: number | null = null;
          if (method === 'growth') {
            const first = ys[0] as number;
            const last = ys[ys.length - 1] as number;
            if (first <= 0 || last <= 0) {
              return ctx.error(
                'growth forecast needs positive first and last values to compute a CAGR',
              );
            }
            cagr = Math.pow(last / first, 1 / (ys.length - 1)) - 1;
          }

          // Least-squares coefficients (also the fallback when there is
          // no period column to reference as the x range).
          const n = ys.length;
          const xMean = xs.reduce((a, b) => a + b, 0) / n;
          const yMean = ys.reduce((a, b) => a + b, 0) / n;
          let sxy = 0;
          let sxx = 0;
          for (let i = 0; i < n; i++) {
            sxy += ((xs[i] as number) - xMean) * ((ys[i] as number) - yMean);
            sxx += ((xs[i] as number) - xMean) ** 2;
          }
          const slope = sxx === 0 ? 0 : sxy / sxx;
          const intercept = yMean - slope * xMean;

          const abs = (range: string) => `$${range.replace(':', ':$')}`;
          const writtenRows: number[] = [];
          for (let i = 0; i < args.periods; i++) {
            const row = lastDataRow + 1 + i;
            writtenRows.push(row);
            if (pc >= 0) {
              const label = periodNumeric
                ? (forecastXs[i] as number)
                : `Forecast ${i + 1}`;
              await setCell(ctx.engine, args.sheet, row, pc, label, auth);
            }
            if (method === 'linear') {
              if (xRange) {
                // Fully live: SLOPE/INTERCEPT over the source ranges,
                // times this row's own period cell.
                const xRef = `$${a1(row, pc).replace(/[0-9]+$/, '')}$${row + 1}`;
                await setFormula(
                  ctx.engine,
                  args.sheet,
                  row,
                  vc,
                  `=INTERCEPT(${abs(yRange)},${abs(xRange)})+SLOPE(${abs(yRange)},${abs(xRange)})*${xRef}`,
                  auth,
                );
              } else {
                // No x range exists: pin the least-squares coefficients
                // as a formula (reported in the result as pinned).
                await setFormula(
                  ctx.engine,
                  args.sheet,
                  row,
                  vc,
                  `=${intercept}+${slope}*${forecastXs[i]}`,
                  auth,
                );
              }
            } else {
              const prevRef = a1(row - 1, vc);
              await setFormula(
                ctx.engine,
                args.sheet,
                row,
                vc,
                `=${prevRef}*(1+${cagr})`,
                auth,
              );
            }
          }
          // Read back the computed forecast values.
          const readBack = await ctx.engine.readRange(
            {
              sheet: args.sheet,
              startRow: writtenRows[0] as number,
              startCol: vc,
              endRow: writtenRows[writtenRows.length - 1] as number,
              endCol: vc,
            },
            auth,
          );
          const forecastValues = ctx
            .toJson(readBack)
            .map((r) => (r as unknown[])[0])
            .map((v) => (typeof v === 'number' ? v : null));
          return ctx.ok({
            sheet: args.sheet,
            valueColumn: args.valueColumn,
            method,
            periods: args.periods,
            ...(method === 'linear' ? { slope, intercept } : {}),
            ...(method === 'linear' && !xRange ? { coefficientsPinned: true } : {}),
            ...(cagr !== null ? { cagr } : {}),
            forecast: forecastXs.map((x, i) => ({ period: x, value: forecastValues[i] })),
            firstForecastRow: (writtenRows[0] as number) + 1,
          });
        } catch (e) {
          return ctx.error(e instanceof Error ? e.message : String(e));
        }
      },
    );

    ctx.tool(
      'fin_npv_irr',
      'Value a cash-flow column: writes a small valuation table with LIVE formulas into the output sheet — NPV as =NPV(rate, flows) minus the initial investment, IRR as =IRR(flows including the initial outlay) — and returns the computed NPV and IRR read back from the sheet. The cash-flow column holds period 1..n flows; initialInvestment is the time-0 outlay (a positive number, default 0).',
      {
        sheet: z.string().min(1),
        cashflowColumn: z.string().min(1),
        rate: z.number().min(-0.99).max(10),
        initialInvestment: z.number().min(0).optional(),
        outputSheet: z.string().min(1).optional(),
        principal: P,
      },
      async (args: {
        sheet: string;
        cashflowColumn: string;
        rate: number;
        initialInvestment?: number;
        outputSheet?: string;
        principal?: string;
      }) => {
        try {
          const auth = ctx.authOf(args);
          const table = await readTable(ctx.engine, args.sheet, auth);
          const cc = columnIndex(table, args.cashflowColumn);
          const flows = table.rows.map((r) => r[cc]);
          if (flows.some((v) => typeof v !== 'number')) {
            return ctx.error(
              `column "${args.cashflowColumn}" contains non-numeric values — coerce it first (clean_coerce_types)`,
            );
          }
          const initial = args.initialInvestment ?? 0;
          const firstDataRow = table.startRow + 1;
          const lastDataRow = firstDataRow + flows.length - 1;
          const flowRange = `'${args.sheet}'!${a1Range(firstDataRow, cc, lastDataRow, cc)}`;
          const out = args.outputSheet ?? 'Valuation';
          await ensureSheet(ctx.engine, out, auth);
          await writeTable(
            ctx.engine,
            out,
            ['Item', 'Value'],
            [
              ['Discount rate', args.rate],
              ['Initial investment', initial],
              ['Periods', flows.length],
              ['NPV', null],
              ['IRR', null],
            ],
            auth,
          );
          // Row indexes (0-based): header 0, rate 1, initial 2, periods 3, NPV 4, IRR 5.
          await setFormula(
            ctx.engine,
            out,
            4,
            1,
            `=NPV(B2,${flowRange})-B3`,
            auth,
          );
          // IRR over the full flow series including the time-0 outlay,
          // staged in a helper column so the formula stays a plain IRR.
          await setCell(ctx.engine, out, 1, 3, -initial, auth);
          for (let i = 0; i < flows.length; i++) {
            await setFormula(
              ctx.engine,
              out,
              2 + i,
              3,
              `='${args.sheet}'!${a1(firstDataRow + i, cc)}`,
              auth,
            );
          }
          await setCell(ctx.engine, out, 0, 3, 'IRR series (t0..tn)', auth);
          const irrRange = a1Range(1, 3, 1 + flows.length, 3);
          await setFormula(ctx.engine, out, 5, 1, `=IRR(${irrRange})`, auth);
          const readBack = await ctx.engine.readRange(
            { sheet: out, startRow: 4, startCol: 1, endRow: 5, endCol: 1 },
            auth,
          );
          const json = ctx.toJson(readBack).map((r) => (r as unknown[])[0]);
          const npv = typeof json[0] === 'number' ? json[0] : null;
          const irr = typeof json[1] === 'number' ? json[1] : null;
          return ctx.ok({
            sheet: args.sheet,
            cashflowColumn: args.cashflowColumn,
            rate: args.rate,
            initialInvestment: initial,
            periods: flows.length,
            npv,
            irr,
            ...(irr === null
              ? { irrNote: 'IRR did not converge (the flow series may lack a sign change)' }
              : {}),
            outputSheet: out,
          });
        } catch (e) {
          return ctx.error(e instanceof Error ? e.message : String(e));
        }
      },
    );

    ctx.tool(
      'fin_scenario_sweep',
      'What-if analysis: vary one input cell over the given values, recalculate, and record one output cell per value — the sheet\'s own formulas do the math. The original input value is restored afterwards. Results are written as a table to the target sheet (default "Scenarios") and returned.',
      {
        sheet: z.string().min(1),
        inputCell: z.string().min(1).max(10),
        values: z.array(z.union([z.number(), z.string(), z.boolean()])).min(1).max(100),
        outputCell: z.string().min(1).max(10),
        targetSheet: z.string().min(1).optional(),
        principal: P,
      },
      async (args: {
        sheet: string;
        inputCell: string;
        values: (number | string | boolean)[];
        outputCell: string;
        targetSheet?: string;
        principal?: string;
      }) => {
        try {
          const auth = ctx.authOf(args);
          const input = parseA1(args.inputCell);
          const output = parseA1(args.outputCell);
          const readOne = async (ref: { row: number; col: number }): Promise<unknown> => {
            const values = await ctx.engine.readRange(
              {
                sheet: args.sheet,
                startRow: ref.row,
                startCol: ref.col,
                endRow: ref.row,
                endCol: ref.col,
              },
              auth,
            );
            return ctx.toJson(values)[0]?.[0] ?? null;
          };
          const original = await readOne(input);
          const results: { input: number | string | boolean; output: unknown }[] = [];
          try {
            for (const value of args.values) {
              await setCell(ctx.engine, args.sheet, input.row, input.col, value, auth);
              const recalc = await ctx.engine.execute({ cmd: 'recalculate', auth });
              if (!recalc.ok) throw new Error(`recalculation failed: ${recalc.error}`);
              results.push({ input: value, output: await readOne(output) });
            }
          } finally {
            // Always restore the model's original input, even on failure.
            await setCell(
              ctx.engine,
              args.sheet,
              input.row,
              input.col,
              typeof original === 'number' || typeof original === 'string' || typeof original === 'boolean'
                ? original
                : null,
              auth,
            );
            await ctx.engine.execute({ cmd: 'recalculate', auth });
          }
          const target = args.targetSheet ?? 'Scenarios';
          await writeTable(
            ctx.engine,
            target,
            [args.inputCell.toUpperCase(), args.outputCell.toUpperCase()],
            results.map((r) => [r.input, typeof r.output === 'object' ? JSON.stringify(r.output) : r.output]),
            auth,
          );
          return ctx.ok({
            sheet: args.sheet,
            inputCell: args.inputCell.toUpperCase(),
            outputCell: args.outputCell.toUpperCase(),
            results,
            restoredOriginal: original,
            targetSheet: target,
          });
        } catch (e) {
          return ctx.error(e instanceof Error ? e.message : String(e));
        }
      },
    );

    for (const p of financialModelingPack.prompts) {
      ctx.prompt(`${financialModelingPack.id}.${p.name}`, p.title, p.text);
    }
  },
};
