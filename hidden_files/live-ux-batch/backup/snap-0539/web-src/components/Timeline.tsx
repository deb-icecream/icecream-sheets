/**
 * Timeline panel (track 14): floating visual date filter.
 *
 * Shows the field name, granularity buttons (days/months/quarters/years),
 * preset ranges (Last 30 days, This quarter, YTD), and a mini date-range
 * brush: two range sliders over the data extent selecting [start, end].
 */
import {
  applyTimelinePreset,
  formatTimelineDate,
  setTimelineGranularity,
  setTimelineRange,
  TIMELINE_GRANULARITIES,
  TIMELINE_PRESETS,
  type TimelineSpec,
} from '../features/timelines';

interface TimelinePanelProps {
  spec: TimelineSpec;
  /** Data extent for the brush; null hides the brush. */
  extent: { min: Date; max: Date } | null;
  onChange: (spec: TimelineSpec) => void;
  onRemove: () => void;
}

const DAY_MS = 86_400_000;

export function TimelinePanel({ spec, extent, onChange, onRemove }: TimelinePanelProps) {
  const presetActive = (id: string): boolean => {
    const s = applyTimelinePreset(spec, id);
    return s.start.getTime() === spec.start.getTime() && s.end.getTime() === spec.end.getTime();
  };

  const brush = extent && extent.max.getTime() > extent.min.getTime() ? (
    <Brush spec={spec} extent={extent} onChange={onChange} />
  ) : null;

  return (
    <div
      className="timeline-panel"
      style={{
        position: 'absolute',
        left: spec.x,
        top: spec.y,
        width: spec.w,
        background: '#fff',
        border: '1px solid #cbd5e1',
        borderRadius: 6,
        boxShadow: '0 2px 8px rgba(0,0,0,0.12)',
        padding: 10,
        fontSize: 12,
        zIndex: 40,
        pointerEvents: 'auto',
      }}
      role="group"
      aria-label={`Timeline filter on ${spec.field}`}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
        <strong>🗓️ {spec.field}</strong>
        <button onClick={onRemove} aria-label={`Remove timeline on ${spec.field}`} style={{ border: 'none', background: 'none', cursor: 'pointer' }}>×</button>
      </div>
      <div style={{ display: 'flex', gap: 4, marginBottom: 6 }} role="group" aria-label="Granularity">
        {TIMELINE_GRANULARITIES.map((g) => (
          <button
            key={g}
            onClick={() => onChange(setTimelineGranularity(spec, g))}
            aria-pressed={spec.granularity === g}
            style={{
              flex: 1,
              padding: '3px 0',
              fontSize: 11,
              borderRadius: 4,
              border: '1px solid #cbd5e1',
              background: spec.granularity === g ? '#1d4ed8' : '#f8fafc',
              color: spec.granularity === g ? '#fff' : '#334155',
              cursor: 'pointer',
            }}
          >
            {g}
          </button>
        ))}
      </div>
      <div style={{ display: 'flex', gap: 4, marginBottom: 6, flexWrap: 'wrap' }} role="group" aria-label="Preset ranges">
        {TIMELINE_PRESETS.map((p) => (
          <button
            key={p.id}
            onClick={() => onChange(applyTimelinePreset(spec, p.id))}
            aria-pressed={presetActive(p.id)}
            title={p.label}
            style={{
              padding: '3px 8px',
              fontSize: 11,
              borderRadius: 10,
              border: '1px solid #cbd5e1',
              background: presetActive(p.id) ? '#dbeafe' : '#fff',
              cursor: 'pointer',
            }}
          >
            {p.label}
          </button>
        ))}
      </div>
      {brush}
      <div style={{ display: 'flex', justifyContent: 'space-between', color: '#475569', fontSize: 11, marginTop: 4 }}>
        <span>{formatTimelineDate(spec.start)}</span>
        <span>→</span>
        <span>{formatTimelineDate(spec.end)}</span>
      </div>
    </div>
  );
}

function Brush({
  spec,
  extent,
  onChange,
}: {
  spec: TimelineSpec;
  extent: { min: Date; max: Date };
  onChange: (s: TimelineSpec) => void;
}) {
  const minDay = Math.floor(extent.min.getTime() / DAY_MS);
  const maxDay = Math.ceil(extent.max.getTime() / DAY_MS);
  const startDay = Math.floor(spec.start.getTime() / DAY_MS);
  const endDay = Math.ceil(spec.end.getTime() / DAY_MS);

  const toDate = (day: number): Date => new Date(day * DAY_MS);

  const sliderStyle: React.CSSProperties = {
    width: '100%',
    pointerEvents: 'auto',
  };

  return (
    <div aria-label="Date range brush">
      <input
        type="range"
        min={minDay}
        max={maxDay}
        value={Math.max(minDay, Math.min(startDay, maxDay))}
        onChange={(e) => onChange(setTimelineRange(spec, toDate(Number(e.target.value)), spec.end))}
        aria-label="Range start"
        style={sliderStyle}
      />
      <input
        type="range"
        min={minDay}
        max={maxDay}
        value={Math.max(minDay, Math.min(endDay, maxDay))}
        onChange={(e) => onChange(setTimelineRange(spec, spec.start, toDate(Number(e.target.value))))}
        aria-label="Range end"
        style={sliderStyle}
      />
    </div>
  );
}
