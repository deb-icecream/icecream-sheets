/**
 * React wrapper around chart.js.
 *
 * Creates the Chart instance once per canvas, then pushes new data/options
 * through chart.update() so charts stay live without remounting. Destroys the
 * instance on unmount. All chart.js registerables are registered once here.
 */
import { useEffect, useRef } from 'react';
import {
  Chart as ChartJS,
  BarController,
  BarElement,
  LineController,
  LineElement,
  PointElement,
  PieController,
  ArcElement,
  ScatterController,
  RadarController,
  RadialLinearScale,
  BubbleController,
  CategoryScale,
  LinearScale,
  LogarithmicScale,
  Title,
  Tooltip,
  Legend,
  Filler,
  type ChartConfiguration,
} from 'chart.js';

let registered = false;
function ensureRegistered(): void {
  if (registered) return;
  ChartJS.register(
    BarController,
    BarElement,
    LineController,
    LineElement,
    PointElement,
    PieController,
    ArcElement,
    ScatterController,
    BubbleController,
    RadarController,
    RadialLinearScale,
    CategoryScale,
    LinearScale,
    LogarithmicScale,
    Title,
    Tooltip,
    Legend,
    Filler,
  );
  registered = true;
}

interface ChartCanvasProps {
  config: ChartConfiguration;
  width: number;
  height: number;
  title?: string;
}

export default function ChartCanvas({ config, width, height, title }: ChartCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const chartRef = useRef<ChartJS | null>(null);
  const configRef = useRef(config);
  configRef.current = config;

  // Create once.
  useEffect(() => {
    ensureRegistered();
    const canvas = canvasRef.current;
    if (!canvas) return;
    const chart = new ChartJS(canvas, configRef.current);
    chartRef.current = chart;
    return () => {
      chart.destroy();
      chartRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Push updates live.
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    chart.data = config.data;
    chart.options = config.options ?? {};
    // Swap inline plugins (data labels / whiskers / funnel). Chart.js v4
    // exposes config.plugins as a getter only (assigning throws and unmounts
    // the app), so write through to the raw config object the getter reads.
    // Descriptors are recomputed from it on every update(), so this applies.
    const raw = (chart.config as unknown as { _config?: { plugins?: unknown[] } })._config;
    if (raw) raw.plugins = [...(config.plugins ?? [])];
    chart.update();
  }, [config]);

  return (
    <canvas
      ref={canvasRef}
      width={width}
      height={height}
      style={{ width, height, display: 'block' }}
      role="img"
      aria-label={title ?? 'Chart'}
    />
  );
}
