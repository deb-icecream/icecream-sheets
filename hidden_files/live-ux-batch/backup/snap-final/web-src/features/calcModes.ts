/**
 * Calculation modes (Formulas > Calculation).
 *
 * Excel has three modes: Automatic, "Automatic Except for Data Tables",
 * and Manual. The engine core only models 'automatic' | 'manual' (engine
 * core stays unchanged per policy), so this module is the UI-facing state
 * machine:
 * - toEngineMode() maps the extended mode onto the engine's two modes.
 * - shouldAutoRecalc() decides, for each change trigger, whether the App
 *   should call recalculate() immediately. In "except data tables" mode,
 *   data-table recomputations do NOT trigger an automatic recalc.
 * - calculateSheet() recalculates on demand for the current sheet. The
 *   engine exposes only workbook-level recalculate(), so this is honestly
 *   reported as workbook scope in its result — no fake scoping.
 */
import type { CalculationMode } from '@icecream-sheets/engine';

export type ExtendedCalculationMode = CalculationMode | 'autoExceptDataTables';

export const CALC_MODE_LABELS: Record<ExtendedCalculationMode, string> = {
  automatic: 'Automatic',
  autoExceptDataTables: 'Automatic Except for Data Tables',
  manual: 'Manual',
};

export const EXTENDED_CALC_MODES: ExtendedCalculationMode[] = [
  'automatic',
  'autoExceptDataTables',
  'manual',
];

/** Map onto the engine's two modes (engine core unchanged). */
export function toEngineMode(mode: ExtendedCalculationMode): CalculationMode {
  return mode === 'manual' ? 'manual' : 'automatic';
}

export type CalcTrigger = 'cellEdit' | 'dataTable' | 'structural';

/**
 * Should the App recalculate immediately for this trigger under this mode?
 * - automatic: always
 * - autoExceptDataTables: everything except data-table recomputation
 * - manual: never (only on explicit Calculate Now / Calculate Sheet)
 */
export function shouldAutoRecalc(mode: ExtendedCalculationMode, trigger: CalcTrigger): boolean {
  if (mode === 'manual') return false;
  if (mode === 'autoExceptDataTables' && trigger === 'dataTable') return false;
  return true;
}

export interface CalculateSheetResult {
  ok: boolean;
  /** The engine only exposes workbook-level recalculate(). */
  scope: 'workbook';
  note: string;
}

/** Minimal host surface needed (EngineHost.execute matches this shape). */
export interface RecalcHost {
  execute: (command: { cmd: 'recalculate' }) => { ok: boolean; error?: string };
}

/**
 * Calculate Sheet: recalculate now, scoped to the current sheet in the UI
 * (the engine recalculates the workbook; reported honestly in `scope`).
 */
export function calculateSheet(host: RecalcHost, _sheet: string): CalculateSheetResult {
  const res = host.execute({ cmd: 'recalculate' });
  if (!res.ok) {
    return { ok: false, scope: 'workbook', note: `Recalculation failed: ${res.error ?? 'unknown error'}` };
  }
  return {
    ok: true,
    scope: 'workbook',
    note: 'The engine exposes workbook-level recalculation only; the whole workbook was recalculated.',
  };
}

/** Calculate Now: same engine call, explicit user intent. */
export function calculateNow(host: RecalcHost): CalculateSheetResult {
  return calculateSheet(host, '');
}
