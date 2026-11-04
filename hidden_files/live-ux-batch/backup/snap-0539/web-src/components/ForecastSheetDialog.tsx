/**
 * Forecast Sheet dialog (Data > Forecast > Forecast Sheet).
 *
 * Builds a forecast worksheet using the ENGINE's FORECAST.ETS family
 * (ETS(AAA) Holt-Winters in packages/engine/src/extended-functions8.ts).
 * The dialog reads the timeline + values from the current sheet's used
 * range (first two columns), extends the timeline by N periods, creates
 * a new sheet with Timeline | Actuals | Forecast | Lower | Upper columns,
 * writes =FORECAST.ETS(...) / =FORECAST.ETS.CONFINT(...) formulas, reads
 * the computed values back, and reports the summary. An optional
 * onOpenChart callback lets the parent open the existing Chart dialog
 * over the forecast table.
 */
import { useState } from 'react';
import type { EngineHost } from '@icecream-sheets/engine';
import { typedValueText } from '../features/typedText';
import A11yDialog from './A11yDialog';
import {
  buildForecastSheetSpec,
  forecastSheetName,
} from '../features/forecast';

interface ForecastSheetDialogProps {
  host: EngineHost;
  sheet: string;
  /** Existing sheet names (for a unique forecast sheet name). */
  sheetNames: string[];
  onClose: () => void;
  onSheetCreated: (name: string) => void;
  /** Open a chart over the forecast table (parent wires ChartDialog). */
  onOpenChart?: (sheet: string, categoryRange: string, valueRanges: string[]) => void;
}

export default function ForecastSheetDialog({
  host,
  sheet,
  sheetNames,
  onClose,
  onSheetCreated,
  onOpenChart,
}: ForecastSheetDialogProps) {
  const [periods, setPeriods] = useState(6);
  const [confidence, setConfidence] = useState(95);
  const [seasonality, setSeasonality] = useState(0);
  const [error, setError] = useState('');
  const [done, setDone] = useState('');
  const [createdSheet, setCreatedSheet] = useState('');
  const [createdRows, setCreatedRows] = useState(0);

  const readHistory = (): { timeline: (string | number)[]; values: number[] } => {
    const used = host.getView().usedRange(sheet);
    if (!used || used.endRow < 2) throw new Error('Need at least 3 rows of timeline + values (columns A:B).');
    const view = host.getView();
    const timeline: (string | number)[] = [];
    const values: number[] = [];
    for (let r = used.startRow; r <= used.endRow; r++) {
      const t = typedValueText(view.readCell({ sheet, row: r, col: used.startCol }).value).trim();
      const vRaw = typedValueText(view.readCell({ sheet, row: r, col: used.startCol + 1 }).value).trim();
      if (t === '' && vRaw === '') continue;
      const v = Number(vRaw);
      if (Number.isNaN(v)) throw new Error(`Row ${r + 1}: value "${vRaw}" is not numeric.`);
      timeline.push(t);
      values.push(v);
    }
    return { timeline, values };
  };

  const create = (): void => {
    setError('');
    setDone('');
    try {
      const { timeline, values } = readHistory();
      const name = forecastSheetName(sheet, sheetNames);
      const spec = buildForecastSheetSpec(
        { timeline, values, periods, confidence: confidence / 100, seasonality },
        name,
      );
      const add = host.execute({ cmd: 'addSheet', name });
      if (!add.ok) throw new Error(add.error ?? 'Could not create sheet.');
      const headers = ['Timeline', 'Actuals', 'Forecast', 'Lower Bound', 'Upper Bound'];
      headers.forEach((h, c) => host.execute({ cmd: 'setCell', ref: { sheet: name, row: 0, col: c }, value: h }));
      spec.timeline.forEach((t, i) => {
        host.execute({ cmd: 'setCell', ref: { sheet: name, row: i + 1, col: 0 }, value: String(t) });
      });
      spec.actuals.forEach((v, i) => {
        if (v !== '') host.execute({ cmd: 'setCell', ref: { sheet: name, row: i + 1, col: 1 }, value: v });
      });
      spec.formulas.forEach((f, i) => {
        const row = timeline.length + 1 + i;
        host.execute({ cmd: 'setFormula', ref: { sheet: name, row, col: 2 }, formula: f.forecast });
        host.execute({ cmd: 'setFormula', ref: { sheet: name, row, col: 3 }, formula: f.lower });
        host.execute({ cmd: 'setFormula', ref: { sheet: name, row, col: 4 }, formula: f.upper });
      });
      host.execute({ cmd: 'recalculate' });
      // Verify the engine computed values (no error cells).
      const view = host.getView();
      let computed = 0;
      let errors = 0;
      for (let i = 0; i < spec.formulas.length; i++) {
        const row = timeline.length + 1 + i;
        const v = view.readCell({ sheet: name, row, col: 2 }).value;
        if (v.kind === 'error') errors++;
        else computed++;
      }
      setCreatedSheet(name);
      setCreatedRows(1 + spec.timeline.length);
      onSheetCreated(name);
      setDone(
        errors > 0
          ? `Created "${name}" but ${errors} forecast cell(s) returned errors — check the timeline is sorted and numeric.`
          : `Created "${name}": ${timeline.length} history points + ${periods} forecast periods at ${confidence}% confidence.`,
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Forecast failed.');
    }
  };

  const openChart = (): void => {
    if (!createdSheet || !onOpenChart || createdRows === 0) return;
    onOpenChart(
      createdSheet,
      `${createdSheet}!A1:A${createdRows}`,
      [`${createdSheet}!B1:B${createdRows}`, `${createdSheet}!C1:C${createdRows}`, `${createdSheet}!D1:D${createdRows}`, `${createdSheet}!E1:E${createdRows}`],
    );
  };

  return (
    <A11yDialog title={<>Create Forecast Sheet</>} width={460} onClose={onClose}>
        <p style={{ fontSize: 13, color: '#555', marginTop: 0 }}>
          Reads the timeline (column A) and values (column B) of <strong>{sheet}</strong> and
          forecasts with the engine's ETS (FORECAST.ETS) model.
        </p>
        <div className="dialog-row" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 10 }}>
          <label>
            Forecast periods<br />
            <input type="number" min={1} max={1000} value={periods} onChange={(e) => setPeriods(Math.max(1, Number(e.target.value) || 1))} aria-label="Forecast periods" />
          </label>
          <label>
            Confidence interval (%)<br />
            <input type="number" min={1} max={99} value={confidence} onChange={(e) => setConfidence(Math.min(99, Math.max(1, Number(e.target.value) || 95)))} aria-label="Confidence percent" />
          </label>
          <label>
            Seasonality<br />
            <select value={seasonality} onChange={(e) => setSeasonality(Number(e.target.value))} aria-label="Seasonality">
              <option value={0}>Automatic</option>
              <option value={1}>None</option>
              <option value={4}>Quarterly (4)</option>
              <option value={12}>Monthly (12)</option>
            </select>
          </label>
        </div>
        {error && <div style={{ color: 'red', fontSize: 13 }}>{error}</div>}
        {done && <div style={{ color: '#1a7f37', fontSize: 13 }}>{done}</div>}
        <div className="dialog-actions">
          {createdSheet && onOpenChart && <button onClick={openChart}>Chart the forecast…</button>}
          <button onClick={create}>Create</button>
          <button onClick={onClose}>Close</button>
        </div>
      </A11yDialog>
  );
}
