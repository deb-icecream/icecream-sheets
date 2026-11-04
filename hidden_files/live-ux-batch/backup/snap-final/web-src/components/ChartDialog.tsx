/**
 * Chart dialog: pick a chart kind, bind a data range, configure title / axes /
 * legend / data labels, with a live preview. Creates a ChartSpec for the
 * service metadata store.
 */
import { useMemo, useState } from 'react';
import ChartCanvas from './ChartCanvas';
import { TreemapSvg, SunburstSvg, ContourSvg, SurfaceSvg } from './Charts';
import {
  CHART_GROUPS,
  TRENDLINE_TYPES,
  a1RangeString,
  addTrendlinesToConfig,
  buildChartConfig,
  extractSeries,
  kindLabel,
  makeChartSpec,
  parseA1Range,
  type CellReader,
  type ChartKind,
  type ChartRange,
  type ChartSpec,
  type LegendPosition,
  type TrendlineSpec,
  type TrendlineType,
} from '@icecream-sheets/service';
import A11yDialog from './A11yDialog';

interface ChartDialogProps {
  sheet: string;
  initialKind: ChartKind;
  initialRange: ChartRange;
  read: CellReader;
  /** When editing, the existing spec (id + geometry preserved). */
  editing?: ChartSpec | null;
  onCreate: (spec: ChartSpec) => void;
  onClose: () => void;
}

const LEGENDS: { id: LegendPosition; label: string }[] = [
  { id: 'top', label: 'Top' },
  { id: 'bottom', label: 'Bottom' },
  { id: 'left', label: 'Left' },
  { id: 'right', label: 'Right' },
  { id: 'none', label: 'None' },
];

export default function ChartDialog({
  sheet,
  initialKind,
  initialRange,
  read,
  editing,
  onCreate,
  onClose,
}: ChartDialogProps) {
  const [kind, setKind] = useState<ChartKind>(editing?.kind ?? initialKind);
  const [rangeText, setRangeText] = useState(a1RangeString(editing?.range ?? initialRange));
  const [title, setTitle] = useState(editing?.title ?? kindLabel(editing?.kind ?? initialKind));
  const [xAxisTitle, setXAxisTitle] = useState(editing?.xAxisTitle ?? '');
  const [yAxisTitle, setYAxisTitle] = useState(editing?.yAxisTitle ?? '');
  const [legend, setLegend] = useState<LegendPosition>(editing?.legend ?? 'bottom');
  const [dataLabels, setDataLabels] = useState(editing?.dataLabels ?? false);
  // Trendlines (Excel: Format Trendline) — linear/exponential/logarithmic/
  // polynomial/moving-average overlays per series.
  const [trendlines, setTrendlines] = useState<TrendlineSpec[]>(editing?.trendlines ?? []);

  const parsedRange = useMemo(() => parseA1Range(rangeText, sheet), [rangeText, sheet]);
  const rangeError = rangeText.trim() !== '' && parsedRange === null;

  const preview = useMemo(() => {
    if (!parsedRange) return null;
    const draft = makeChartSpec({
      kind,
      range: parsedRange,
      title,
      xAxisTitle,
      yAxisTitle,
      legend,
      dataLabels,
      trendlines,
    });
    const series = extractSeries(read, parsedRange);
    const first = series.datasets[0];
    try {
      const built = buildChartConfig(draft, series);
      addTrendlinesToConfig(built, series, draft);
      return {
        draft,
        built,
        series,
        svgLabels: series.labels,
        svgValues: (first?.data ?? []).map((v) => (typeof v === 'number' ? v : 0)),
        buildError: null as string | null,
      };
    } catch (e) {
      return {
        draft,
        built: null,
        series,
        svgLabels: series.labels,
        svgValues: [] as number[],
        buildError: e instanceof Error ? e.message : String(e),
      };
    }
  }, [parsedRange, kind, title, xAxisTitle, yAxisTitle, legend, dataLabels, trendlines, read]);

  const handleKindChange = (k: ChartKind) => {
    setKind(k);
    if (!editing) setTitle(kindLabel(k));
  };

  const handleCreate = () => {
    if (!parsedRange || !preview) return;
    onCreate(
      makeChartSpec({
        ...(editing ? { id: editing.id, x: editing.x, y: editing.y, w: editing.w, h: editing.h } : {}),
        kind,
        range: parsedRange,
        title: title.trim() === '' ? kindLabel(kind) : title,
        xAxisTitle,
        yAxisTitle,
        legend,
        dataLabels,
        trendlines,
        ...(editing?.pivot ? { pivot: editing.pivot } : {}),
      }),
    );
  };

  return (
    <A11yDialog title={<>{editing ? 'Edit chart' : 'Insert chart'}</>} width={860} onClose={onClose}>
        <div style={{ display: 'flex', gap: 16 }}>
          <div style={{ flex: '0 0 300px', display: 'flex', flexDirection: 'column', gap: 10 }}>
            <label>
              Chart type
              <select
                value={kind}
                onChange={(e) => handleKindChange(e.target.value as ChartKind)}
                style={{ width: '100%', marginTop: 4 }}
              >
                {CHART_GROUPS.map((g) => (
                  <optgroup key={g.id} label={g.label}>
                    {g.kinds.map((k) => (
                      <option key={k.id} value={k.id}>
                        {k.label}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </select>
            </label>
            <label>
              Data range
              <div style={{ display: 'flex', gap: 6, marginTop: 4 }}>
                <input
                  value={rangeText}
                  onChange={(e) => setRangeText(e.target.value)}
                  placeholder="A1:D10"
                  style={{ flex: 1 }}
                  aria-label="Data range in A1 notation"
                />
                <button
                  type="button"
                  onClick={() => setRangeText(a1RangeString(initialRange))}
                  title="Use the current selection"
                >
                  Selection
                </button>
              </div>
              {rangeError && <div style={{ color: '#b00', fontSize: 12 }}>Enter a range like A1:D10.</div>}
            </label>
            <label>
              Chart title
              <input value={title} onChange={(e) => setTitle(e.target.value)} style={{ width: '100%', marginTop: 4 }} />
            </label>
            <div style={{ display: 'flex', gap: 8 }}>
              <label style={{ flex: 1 }}>
                X axis title
                <input value={xAxisTitle} onChange={(e) => setXAxisTitle(e.target.value)} style={{ width: '100%', marginTop: 4 }} />
              </label>
              <label style={{ flex: 1 }}>
                Y axis title
                <input value={yAxisTitle} onChange={(e) => setYAxisTitle(e.target.value)} style={{ width: '100%', marginTop: 4 }} />
              </label>
            </div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <label>
                Legend
                <select value={legend} onChange={(e) => setLegend(e.target.value as LegendPosition)} style={{ marginLeft: 6 }}>
                  {LEGENDS.map((l) => (
                    <option key={l.id} value={l.id}>
                      {l.label}
                    </option>
                  ))}
                </select>
              </label>
              <label style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                <input type="checkbox" checked={dataLabels} onChange={(e) => setDataLabels(e.target.checked)} />
                Data labels
              </label>
            </div>
            <div>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <span style={{ fontSize: 13, fontWeight: 600 }}>Trendlines</span>
                <button
                  type="button"
                  onClick={() =>
                    setTrendlines((prev) => [
                      ...prev,
                      { type: 'linear' as TrendlineType, seriesIndex: 0 },
                    ])
                  }
                  title="Add a trendline overlay"
                  style={{ fontSize: 12 }}
                >
                  + Add
                </button>
              </div>
              {trendlines.length === 0 && (
                <div style={{ fontSize: 12, color: '#888', marginTop: 4 }}>
                  None — add a linear, exponential, logarithmic, polynomial, power or moving-average
                  trendline.
                </div>
              )}
              {trendlines.map((tl, i) => (
                <div key={i} style={{ marginTop: 6 }}>
                <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                  <select
                    value={tl.type}
                    onChange={(e) =>
                      setTrendlines((prev) =>
                        prev.map((t, j) => (j === i ? { ...t, type: e.target.value as TrendlineType } : t)),
                      )
                    }
                    aria-label={`Trendline ${i + 1} type`}
                    style={{ fontSize: 12 }}
                  >
                    {TRENDLINE_TYPES.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.label}
                      </option>
                    ))}
                  </select>
                  {tl.type === 'movingAverage' && (
                    <label style={{ fontSize: 12 }}>
                      Period
                      <input
                        type="number"
                        min={2}
                        max={50}
                        value={tl.period ?? 2}
                        onChange={(e) =>
                          setTrendlines((prev) =>
                            prev.map((t, j) => (j === i ? { ...t, period: Number(e.target.value) } : t)),
                          )
                        }
                        style={{ width: 48, marginLeft: 4 }}
                      />
                    </label>
                  )}
                  {tl.type === 'polynomial' && (
                    <label style={{ fontSize: 12 }}>
                      Order
                      <input
                        type="number"
                        min={2}
                        max={6}
                        value={tl.order ?? 2}
                        onChange={(e) =>
                          setTrendlines((prev) =>
                            prev.map((t, j) => (j === i ? { ...t, order: Number(e.target.value) } : t)),
                          )
                        }
                        style={{ width: 44, marginLeft: 4 }}
                      />
                    </label>
                  )}
                  <label style={{ fontSize: 12 }} title="Dataset index the trendline fits">
                    Series
                    <input
                      type="number"
                      min={0}
                      value={tl.seriesIndex ?? 0}
                      onChange={(e) =>
                        setTrendlines((prev) =>
                          prev.map((t, j) => (j === i ? { ...t, seriesIndex: Number(e.target.value) } : t)),
                        )
                      }
                      style={{ width: 40, marginLeft: 4 }}
                    />
                  </label>
                  <button
                    type="button"
                    onClick={() => setTrendlines((prev) => prev.filter((_, j) => j !== i))}
                    aria-label={`Remove trendline ${i + 1}`}
                    style={{ fontSize: 12 }}
                  >
                    ✕
                  </button>
                </div>
                <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginTop: 4, flexWrap: 'wrap' }}>
                  <label style={{ fontSize: 12 }} title="Show the fitted equation in the legend (Excel: Display Equation on chart)">
                    <input
                      type="checkbox"
                      checked={!!tl.displayEquation}
                      onChange={(e) =>
                        setTrendlines((prev) =>
                          prev.map((t, j) => (j === i ? { ...t, displayEquation: e.target.checked || undefined } : t)),
                        )
                      }
                    />{' '}
                    Equation
                  </label>
                  <label style={{ fontSize: 12 }} title="Show R-squared in the legend (Excel: Display R-squared value on chart)">
                    <input
                      type="checkbox"
                      checked={!!tl.displayRSquared}
                      onChange={(e) =>
                        setTrendlines((prev) =>
                          prev.map((t, j) => (j === i ? { ...t, displayRSquared: e.target.checked || undefined } : t)),
                        )
                      }
                    />{' '}
                    R²
                  </label>
                  <label style={{ fontSize: 12 }} title="Forecast forward N periods (Excel: Forecast > Forward)">
                    Fwd
                    <input
                      type="number"
                      min={0}
                      max={100}
                      value={tl.forward ?? 0}
                      onChange={(e) =>
                        setTrendlines((prev) =>
                          prev.map((t, j) => (j === i ? { ...t, forward: Math.max(0, Number(e.target.value)) || undefined } : t)),
                        )
                      }
                      style={{ width: 44, marginLeft: 4 }}
                    />
                  </label>
                  <label style={{ fontSize: 12 }} title="Forecast backward N periods (Excel: Forecast > Backward)">
                    Bwd
                    <input
                      type="number"
                      min={0}
                      max={100}
                      value={tl.backward ?? 0}
                      onChange={(e) =>
                        setTrendlines((prev) =>
                          prev.map((t, j) => (j === i ? { ...t, backward: Math.max(0, Number(e.target.value)) || undefined } : t)),
                        )
                      }
                      style={{ width: 44, marginLeft: 4 }}
                    />
                  </label>
                  {tl.type !== 'movingAverage' && (
                    <label style={{ fontSize: 12 }} title="Custom y-intercept; blank = fit normally (Excel: Set Intercept)">
                      Intercept
                      <input
                        type="number"
                        value={tl.intercept ?? ''}
                        placeholder="auto"
                        onChange={(e) =>
                          setTrendlines((prev) =>
                            prev.map((t, j) =>
                              (j === i
                                ? { ...t, intercept: e.target.value === '' ? undefined : Number(e.target.value) }
                                : t),
                            )
                          )
                        }
                        style={{ width: 64, marginLeft: 4 }}
                      />
                    </label>
                  )}
                </div>
                </div>
              ))}
            </div>
          </div>
          <div style={{ flex: 1, minHeight: 320, border: '1px solid #ddd', padding: 8, background: '#fff' }}>
            {preview ? (
              preview.buildError ? (
                <div style={{ color: '#a00', fontSize: 13, textAlign: 'center', paddingTop: 120 }}>
                  {preview.buildError}
                </div>
              ) : preview.built!.svg === 'treemap' ? (
                <TreemapSvg labels={preview.svgLabels} values={preview.svgValues} width={440} height={300} title={preview.draft.title} />
              ) : preview.built!.svg === 'sunburst' ? (
                <SunburstSvg labels={preview.svgLabels} values={preview.svgValues} width={440} height={300} title={preview.draft.title} />
              ) : preview.built!.svg === 'contour' ? (
                <ContourSvg
                  series={preview.series}
                  width={440}
                  height={300}
                  title={preview.draft.title}
                  wireframe={preview.draft.kind === 'contour-wireframe'}
                />
              ) : preview.built!.svg === 'surface' ? (
                <SurfaceSvg
                  series={preview.series}
                  width={440}
                  height={300}
                  title={preview.draft.title}
                  wireframe={preview.draft.kind === 'surface-3d-wireframe'}
                />
              ) : preview.built!.detail ? (
                <div style={{ display: 'flex', gap: 8 }}>
                  <ChartCanvas config={preview.built!.config} width={280} height={300} title={preview.draft.title} />
                  <div>
                    <div style={{ fontSize: 11, color: '#555', marginBottom: 4 }}>{preview.built!.detail.title}</div>
                    <ChartCanvas config={preview.built!.detail.config} width={140} height={280} title={preview.built!.detail.title} />
                  </div>
                </div>
              ) : (
                <ChartCanvas config={preview.built!.config} width={440} height={300} title={preview.draft.title} />
              )
            ) : (
              <div style={{ color: '#888', textAlign: 'center', paddingTop: 120 }}>
                {rangeError ? 'Fix the range to preview.' : 'No data in range.'}
              </div>
            )}
          </div>
        </div>
        <div className="dialog-actions">
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button type="button" onClick={handleCreate} disabled={!preview} className="primary">
            {editing ? 'Save' : 'Insert chart'}
          </button>
        </div>
      </A11yDialog>
  );
}
