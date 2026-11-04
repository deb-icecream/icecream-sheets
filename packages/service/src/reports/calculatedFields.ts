/**
 * Calculated fields for native reports
 * (design-docs/native-reports-and-dashboards.md §3).
 *
 * "Calculated fields use the formula language." A CalculatedField is
 * { name, expression } on a ReportBinding; the expression is evaluated in
 * the ENGINE's formula language over the report's bound row — e.g.
 * `=[Revenue]-[Cost]` or `=[Qty]*[Price]*0.9`. There is no new expression
 * language: evaluation reuses the real engine formula evaluator
 * (EngineHost + EngineWorkbook) against a scratch sheet that holds the
 * row's bound values.
 *
 * How it works: CalculatedFieldEvaluator owns one scratch workbook. For
 * each row it writes the bound field values into scratch row 1 (one column
 * per field, plus reserved columns for the calculated fields themselves so
 * calculated fields can chain: later fields may reference earlier ones),
 * rewrites `[FieldName]` tokens to A1 addresses, puts the rewritten formula
 * in a scratch cell, and reads back the computed TypedValue. Formula
 * errors surface as proper error values ({ ok: false, error: '#DIV/0!' }),
 * never as thrown exceptions.
 *
 * SERVICE-LAYER component: pure and headless. The engine import is the
 * same one automation/api.ts already makes (EngineHost/EngineWorkbook are
 * constructed in the web app today), so this module stays browser-safe.
 */

import {
  EngineHost,
  EngineWorkbook,
  isError,
  type CellInput,
} from '@icecream-sheets/engine';
import type { PivotRecord } from '../pivot.js';

/**
 * A report-level calculated field (v1; report-level calculated TABLES are
 * v2-excluded per the design doc §9). Lives on ReportBinding.
 */
export interface CalculatedField {
  /** Field name — usable everywhere a column-bound field is. */
  name: string;
  /**
   * Formula-language expression over the bound row. Field references use
   * [Brackets], e.g. `=[Revenue]-[Cost]`. A leading '=' is optional.
   */
  expression: string;
}

/** Trim and ensure the leading '=' the formula language expects. */
export function normalizeCalculatedExpression(expression: string): string {
  const t = expression.trim();
  return t.startsWith('=') ? t : `=${t}`;
}

/**
 * Extract [Field] references from an expression, in order of first
 * appearance. Bracket contents are trimmed; empty brackets are ignored.
 */
export function extractFieldReferences(expression: string): string[] {
  const refs: string[] = [];
  const seen = new Set<string>();
  const re = /\[([^\[\]]+)\]/g;
  let m: RegExpMatchArray | null;
  while ((m = re.exec(expression)) !== null) {
    const name = m[1]!.trim();
    if (name.length > 0 && !seen.has(name)) {
      seen.add(name);
      refs.push(name);
    }
  }
  return refs;
}

/**
 * Validate one calculated field. `columnFields` are the binding's real
 * columns; `knownNames` additionally includes the sibling calculated-field
 * names (chaining is allowed: later fields may reference earlier ones).
 * Returns error strings; empty = valid.
 */
export function validateCalculatedField(
  field: unknown,
  columnFields: string[],
  knownNames: Set<string>,
): string[] {
  const errors: string[] = [];
  if (typeof field !== 'object' || field === null) return ['calculated field must be an object'];
  const f = field as Partial<CalculatedField>;
  if (typeof f.name !== 'string' || f.name.trim() === '') {
    errors.push('calculated field name must be a non-empty string');
  } else if (columnFields.includes(f.name)) {
    errors.push(`calculated field "${f.name}" collides with a binding column field`);
  } else if (knownNames.has(f.name)) {
    errors.push(`duplicate calculated field name "${f.name}"`);
  }
  if (typeof f.expression !== 'string' || f.expression.trim() === '') {
    errors.push(`calculated field "${String(f.name)}": expression must be a non-empty string`);
  } else if (typeof f.name === 'string' && f.name.trim() !== '') {
    const allowed = new Set([...columnFields, ...knownNames]);
    for (const ref of extractFieldReferences(f.expression)) {
      if (!allowed.has(ref)) {
        errors.push(`calculated field "${f.name}": unknown field reference "[${ref}]"`);
      }
    }
  }
  return errors;
}

/** Result of evaluating one calculated field over one row. */
export type CalculatedValue =
  | { ok: true; value: string | number | boolean | null }
  | { ok: false; error: string };

/** 0-based scratch sheet layout. */
const SCRATCH_SHEET = 'Sheet1';
const SCRATCH_ROW = 0;

function colToA1(col: number): string {
  let n = col + 1;
  let s = '';
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return `${s}${SCRATCH_ROW + 1}`;
}

function toCellInput(v: unknown): CellInput {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string') {
    // A bound data value that starts with '=' is literal text, not a
    // formula: use the Excel apostrophe-prefix escape (the engine strips it
    // back to a literal string).
    return v.startsWith('=') && v.length > 1 ? `'${v}` : v;
  }
  return String(v);
}

/**
 * Evaluates calculated-field expressions in the engine's formula language
 * against bound rows. One scratch workbook is reused across rows; call
 * evaluateRow() per record.
 */
export class CalculatedFieldEvaluator {
  private readonly host: EngineHost;
  /** Column per field name: bound columns first, then calculated fields in order. */
  private colByField = new Map<string, number>();

  constructor() {
    this.host = new EngineHost(new EngineWorkbook());
  }

  /**
   * Evaluate every calculated field over one row's bindings.
   * `columnFields` are the binding's real columns; calculated fields are
   * evaluated in declaration order and may reference earlier calculated
   * fields (chaining). Returns the value per calculated field name.
   */
  evaluateRow(
    columnFields: string[],
    calculatedFields: CalculatedField[],
    bindings: Record<string, unknown>,
  ): Record<string, CalculatedValue> {
    const names = calculatedFields.map((f) => f.name);
    this.colByField = new Map<string, number>();
    [...columnFields, ...names].forEach((f, i) => {
      if (!this.colByField.has(f)) this.colByField.set(f, i);
    });
    const totalCols = this.colByField.size;

    // Write the bound row's values into the scratch row.
    for (const f of columnFields) {
      const col = this.colByField.get(f);
      if (col === undefined) continue;
      this.host.execute({
        cmd: 'setCell',
        ref: { sheet: SCRATCH_SHEET, row: SCRATCH_ROW, col },
        value: toCellInput(bindings[f]),
      });
    }

    const out: Record<string, CalculatedValue> = {};
    const liveBindings: Record<string, unknown> = { ...bindings };
    for (const cf of calculatedFields) {
      const value = this.evaluateOne(cf.expression, liveBindings);
      out[cf.name] = value;
      // Make the result visible to later (chained) calculated fields, both
      // in the live bindings and in the scratch sheet.
      const col = this.colByField.get(cf.name);
      const materialized: string | number | boolean | null = value.ok ? value.value : value.error;
      liveBindings[cf.name] = materialized;
      if (col !== undefined) {
        this.host.execute({
          cmd: 'setCell',
          ref: { sheet: SCRATCH_SHEET, row: SCRATCH_ROW, col },
          value: toCellInput(materialized),
        });
      }
    }
    return out;
  }

  /** Evaluate a single expression against bindings (no chaining). */
  evaluate(expression: string, bindings: Record<string, unknown>): CalculatedValue {
    const fields = Object.keys(bindings);
    this.colByField = new Map(fields.map((f, i) => [f, i]));
    for (const [f, col] of this.colByField) {
      this.host.execute({
        cmd: 'setCell',
        ref: { sheet: SCRATCH_SHEET, row: SCRATCH_ROW, col },
        value: toCellInput(bindings[f]),
      });
    }
    return this.evaluateOne(expression, bindings);
  }

  private evaluateOne(expression: string, bindings: Record<string, unknown>): CalculatedValue {
    if (typeof expression !== 'string' || expression.trim() === '') {
      return { ok: false, error: 'expression must be a non-empty string' };
    }
    const refs = extractFieldReferences(expression);
    for (const ref of refs) {
      if (!this.colByField.has(ref)) {
        return { ok: false, error: `unknown field "[${ref}]"` };
      }
    }
    const rewritten = expression.replace(/\[([^\[\]]+)\]/g, (_m, name: string) => {
      const col = this.colByField.get(name.trim());
      return col === undefined ? _m : colToA1(col);
    });
    const formulaCell = { sheet: SCRATCH_SHEET, row: SCRATCH_ROW, col: this.colByField.size };
    const res = this.host.execute({
      cmd: 'setFormula',
      ref: formulaCell,
      formula: normalizeCalculatedExpression(rewritten),
    });
    if (!res.ok) return { ok: false, error: res.error };
    let tv;
    try {
      tv = this.host.readCell(formulaCell);
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
    if (isError(tv)) return { ok: false, error: tv.code };
    if (tv.kind === 'image') return { ok: true, value: null };
    return { ok: true, value: tv.value };
  }
}

/**
 * Materialize a binding's calculated fields into records: returns NEW
 * records with each calculated field computed per row. Error values surface
 * as their Excel error codes (e.g. '#DIV/0!') — proper error values, not
 * crashes and not silent nulls.
 *
 * The materialized records can feed everything that reads column-bound
 * fields unchanged: table columns, computeKpi, createPivot (and therefore
 * pivot-bound chart series), slicers and filters.
 */
export function materializeCalculatedFields(
  records: PivotRecord[],
  binding: { fields: string[]; calculatedFields: CalculatedField[] },
  evaluator: CalculatedFieldEvaluator = new CalculatedFieldEvaluator(),
): PivotRecord[] {
  if (!Array.isArray(binding.calculatedFields) || binding.calculatedFields.length === 0) {
    return records.map((r) => ({ ...r }));
  }
  return records.map((record) => {
    const out: PivotRecord = { ...record };
    const values = evaluator.evaluateRow(binding.fields, binding.calculatedFields, record);
    for (const cf of binding.calculatedFields) {
      const v = values[cf.name];
      out[cf.name] = v === undefined ? null : v.ok ? v.value : v.error;
    }
    return out;
  });
}
