/**
 * AppChart — the one chart component generated apps may use.
 *
 * A lightweight, dependency-free SVG bar chart. It renders bars from
 * the data it is GIVEN as a prop — it reads no sheet, calls no tool,
 * and reaches no host state — so it adds no data access and no new
 * code-execution surface to the app sandbox: it is one more React
 * component in the narrow API, in the same trust posture as `h`.
 *
 * Props:
 *   data: [{ label, value }, ...] — labels are category names
 *     (e.g. years as strings), values are the numbers to plot.
 *     Non-finite values are dropped; negative values plot as zero
 *     height (a bar chart of mixed-sign measures is out of scope).
 *   title: optional chart title, rendered above the bars and used as
 *     the accessible name.
 *
 * Failure mode is visible, never blank: empty data (or data with no
 * finite value) renders "No data to chart" text. Bars carry <title>
 * elements and value labels, so the plotted figures are checkable
 * against the sheet without hovering.
 */
import * as React from 'react';

export interface AppChartDataPoint {
  label: string;
  value: number;
}

export interface AppChartProps {
  data: AppChartDataPoint[];
  title?: string;
}

const BAR_FILL = '#0e7c6b';
const CHART_WIDTH = 600;
const CHART_HEIGHT = 280;
const TOP_PAD = 28;
const BOTTOM_PAD = 30;
const PLOT_HEIGHT = CHART_HEIGHT - TOP_PAD - BOTTOM_PAD;

/** Display formatting: integers with thousands separators, otherwise
 * up to two decimals (trailing zeros trimmed by toLocaleString). */
export function formatChartValue(value: number): string {
  return value.toLocaleString('en-US', { maximumFractionDigits: 2 });
}

export function AppChart({ data, title }: AppChartProps): React.ReactElement {
  const points = (Array.isArray(data) ? data : [])
    .filter(
      (p): p is AppChartDataPoint =>
        !!p && typeof p.label === 'string' && Number.isFinite(p.value),
    )
    .map((p) => ({ label: p.label, value: Math.max(0, p.value) }));

  if (points.length === 0) {
    return React.createElement(
      'div',
      { className: 'p-3 text-sm text-base-content', role: 'img', 'aria-label': title ?? 'Bar chart' },
      title
        ? React.createElement('div', { className: 'mb-2 font-semibold' }, title)
        : null,
      'No data to chart',
    );
  }

  const max = Math.max(...points.map((p) => p.value), 0);
  const slot = CHART_WIDTH / points.length;
  const barWidth = Math.max(8, Math.floor(slot * 0.6));
  const bars = points.map((p, i) => {
    const height = max > 0 ? (p.value / max) * PLOT_HEIGHT : 0;
    const x = slot * i + (slot - barWidth) / 2;
    const y = TOP_PAD + (PLOT_HEIGHT - height);
    return React.createElement(
      'g',
      { key: i },
      React.createElement(
        'rect',
        {
          x,
          y,
          width: barWidth,
          height,
          fill: BAR_FILL,
          rx: 2,
          'data-label': p.label,
          'data-value': p.value,
        },
        React.createElement('title', null, `${p.label}: ${formatChartValue(p.value)}`),
      ),
      React.createElement(
        'text',
        {
          x: x + barWidth / 2,
          y: Math.max(12, y - 4),
          textAnchor: 'middle',
          fontSize: 11,
          fill: 'currentColor',
        },
        formatChartValue(p.value),
      ),
      React.createElement(
        'text',
        {
          x: x + barWidth / 2,
          y: CHART_HEIGHT - 8,
          textAnchor: 'middle',
          fontSize: 11,
          fill: 'currentColor',
        },
        p.label,
      ),
    );
  });

  return React.createElement(
    'div',
    { className: 'w-full', role: 'img', 'aria-label': title ?? 'Bar chart' },
    title
      ? React.createElement('div', { className: 'mb-2 font-semibold' }, title)
      : null,
    React.createElement(
      'svg',
      {
        viewBox: `0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`,
        width: '100%',
        'aria-hidden': true,
      },
      bars,
    ),
  );
}

export default AppChart;
