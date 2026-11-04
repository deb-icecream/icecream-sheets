/**
 * 3D Maps (track 17): orthographic SVG globe overlay + setup dialog.
 * Plots lat/long points from a selected range; drag to rotate.
 */
import { useMemo, useRef, useState } from 'react';
import {
  projectPoints,
  graticule,
  pointsFromRows,
  type LatLong,
} from '../features/globe';
import A11yDialog from './A11yDialog';

interface GlobeOverlayProps {
  points: LatLong[];
  size: number;
  onClose: () => void;
  onMove: (dx: number, dy: number) => void;
  /**
   * True when any plotted point came from the bundled offline coordinate
   * table (network unavailable). Renders an explicit offline badge so the
   * map is never a silent wrong answer.
   */
  offline?: boolean;
}

export function GlobeOverlay({ points, size, onClose, onMove, offline }: GlobeOverlayProps) {
  const [rot, setRot] = useState<[number, number]>([-30, 20]);
  const [auto, setAuto] = useState(false);
  const drag = useRef<{ x: number; y: number; r: [number, number] } | null>(null);
  const timer = useRef<number | null>(null);

  const projected = useMemo(
    () => projectPoints(points, rot[0], rot[1]),
    [points, rot],
  );
  const grat = useMemo(() => graticule(rot[0], rot[1], 20), [rot]);

  const R = size / 2 - 8;
  const cx = size / 2;
  const cy = size / 2;
  const toPx = (x: number, y: number): [number, number] => [cx + x * R, cy + y * R];
  const maxVal = Math.max(0, ...points.map((p) => p.value ?? 0));

  const toggleAuto = (): void => {
    if (timer.current) {
      window.clearInterval(timer.current);
      timer.current = null;
      setAuto(false);
    } else {
      timer.current = window.setInterval(() => {
        setRot((r) => [(r[0] + 4) % 360, r[1]]);
      }, 120);
      setAuto(true);
    }
  };

  return (
    <div
      role="img"
      aria-label={`3D globe map with ${points.length} plotted points`}
      style={{
        position: 'absolute', zIndex: 20, background: '#0b1d33', borderRadius: 8,
        padding: 8, cursor: 'move', pointerEvents: 'auto', color: '#fff',
      }}
      onMouseDown={(e) => {
        drag.current = { x: e.clientX, y: e.clientY, r: rot };
      }}
      onMouseMove={(e) => {
        const d = drag.current;
        if (d) setRot([d.r[0] + (e.clientX - d.x) * 0.5, Math.max(-80, Math.min(80, d.r[1] - (e.clientY - d.y) * 0.5))]);
      }}
      onMouseUp={() => { drag.current = null; }}
      onMouseLeave={() => { drag.current = null; }}
    >
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        <circle cx={cx} cy={cy} r={R} fill="#12325c" stroke="#3b82f6" strokeWidth={2} />
        {grat.map((s, i) => {
          if (!s.visible) return null;
          const [x1, y1] = toPx(s.x1, s.y1);
          const [x2, y2] = toPx(s.x2, s.y2);
          return <line key={i} x1={x1} y1={y1} x2={x2} y2={y2} stroke="#2b4d7d" strokeWidth={0.7} />;
        })}
        {projected.map((p, i) => {
          if (!p.visible) return null;
          const [x, y] = toPx(p.x, p.y);
          const r = p.value !== undefined && maxVal > 0 ? 3 + (p.value / maxVal) * 7 : 4;
          return (
            <g key={i}>
              <circle cx={x} cy={y} r={r} fill="#f59e0b" stroke="#fff" strokeWidth={1}>
                {p.label && <title>{p.label}{p.value !== undefined ? `: ${p.value}` : ''}</title>}
              </circle>
              {p.label && (
                <text x={x + r + 2} y={y + 3} fill="#fff" fontSize={10}>{p.label}</text>
              )}
            </g>
          );
        })}
      </svg>
      <div style={{ display: 'flex', gap: 8, justifyContent: 'center', marginTop: 4 }}>
        <button onClick={toggleAuto} style={{ fontSize: 12 }} aria-pressed={auto}>
          {auto ? '⏸ Stop rotation' : '▶ Auto-rotate'}
        </button>
        <button
          onClick={(e) => { e.stopPropagation(); if (timer.current) window.clearInterval(timer.current); onClose(); }}
          style={{ fontSize: 12 }}
          aria-label="Remove 3D map"
        >
          × Remove
        </button>
      </div>
      {offline && (
        <div role="note" aria-label="Offline coordinates notice" style={{ fontSize: 11, color: '#fbbf24', textAlign: 'center', marginTop: 2 }}>
          ⚠ Offline — plotted from the bundled coordinate table
        </div>
      )}
      <div style={{ fontSize: 11, color: '#9db4d0', textAlign: 'center', marginTop: 2 }}>
        Drag to rotate · {points.length} points
      </div>
    </div>
  );
}

export interface PlacesGeocodeProgress {
  done: number;
  total: number;
}

export interface PlacesGeocodeOutcome {
  plotted: number;
  total: number;
  unknown: string[];
  offline: boolean;
  providerName: string;
}

interface GlobeSetupDialogProps {
  headers: string[];
  onClose: () => void;
  onCreate: (latCol: number, longCol: number, labelCol?: number, valueCol?: number) => void;
  onCreateFromPlaces: (
    nameCol: number,
    valueCol: number | undefined,
    onProgress: (p: PlacesGeocodeProgress) => void,
  ) => Promise<PlacesGeocodeOutcome>;
}

/**
 * Pick lat/long (/label/value) columns, then create the globe from the used
 * range — or pick a column of place names and geocode them (OpenStreetMap
 * Nominatim when online; the bundled sample table with an explicit offline
 * notice when not).
 */
export function GlobeSetupDialog({ headers, onClose, onCreate, onCreateFromPlaces }: GlobeSetupDialogProps) {
  const guess = (names: string[]): number => {
    const i = headers.findIndex((h) => names.some((n) => h.toLowerCase().includes(n)));
    return i >= 0 ? i : 0;
  };
  const [mode, setMode] = useState<'coords' | 'places'>('coords');
  const [latCol, setLatCol] = useState(() => guess(['lat']));
  const [longCol, setLongCol] = useState(() => guess(['lon', 'long', 'lng']));
  const [labelCol, setLabelCol] = useState<number | ''>('');
  const [valueCol, setValueCol] = useState<number | ''>('');
  const [nameCol, setNameCol] = useState(() => guess(['city', 'place', 'location', 'name', 'country']));
  const [phase, setPhase] = useState<'idle' | 'working' | 'done'>('idle');
  const [progress, setProgress] = useState<PlacesGeocodeProgress>({ done: 0, total: 0 });
  const [outcome, setOutcome] = useState<PlacesGeocodeOutcome | null>(null);

  const handleGeocode = (): void => {
    setPhase('working');
    setOutcome(null);
    setProgress({ done: 0, total: 0 });
    void onCreateFromPlaces(nameCol, valueCol === '' ? undefined : valueCol, setProgress)
      .then((o) => {
        setOutcome(o);
        setPhase('done');
      })
      .catch(() => {
        setOutcome({ plotted: 0, total: 0, unknown: [], offline: false, providerName: '' });
        setPhase('done');
      });
  };

  const colSelect = (
    label: string,
    value: number | '',
    set: React.Dispatch<React.SetStateAction<number>> | ((v: number | '') => void),
    allowEmpty: boolean,
  ): JSX.Element => (
    <label style={{ display: 'block', marginBottom: 8, fontSize: 13 }}>
      {label}{' '}
      <select
        value={value === '' ? '' : String(value)}
        onChange={(e) => {
          const v = e.target.value === '' ? '' : Number(e.target.value);
          if (allowEmpty) {
            (set as (v: number | '') => void)(v);
          } else if (v !== '') {
            (set as React.Dispatch<React.SetStateAction<number>>)(v);
          }
        }}
        aria-label={label}
      >
        {allowEmpty && <option value="">— none —</option>}
        {headers.map((h, i) => <option key={i} value={i}>{h || `Column ${i + 1}`}</option>)}
      </select>
    </label>
  );

  return (
    <A11yDialog title={<>3D Maps</>} width={400} onClose={onClose}>
        <fieldset style={{ border: '1px solid #ccc', borderRadius: 4, marginBottom: 10, fontSize: 13 }}>
          <legend>Data source</legend>
          <label style={{ display: 'block', marginBottom: 4 }}>
            <input
              type="radio"
              name="globe-mode"
              checked={mode === 'coords'}
              onChange={() => setMode('coords')}
            />{' '}
            Latitude / longitude columns
          </label>
          <label style={{ display: 'block' }}>
            <input
              type="radio"
              name="globe-mode"
              checked={mode === 'places'}
              onChange={() => setMode('places')}
            />{' '}
            Place names (geocoded)
          </label>
        </fieldset>
        {mode === 'coords' ? (
          <>
            <p style={{ fontSize: 13, color: '#555' }}>
              Select the columns holding latitude and longitude. The globe plots every
              valid row from the used range.
            </p>
            {colSelect('Latitude column', latCol, setLatCol, false)}
            {colSelect('Longitude column', longCol, setLongCol, false)}
            {colSelect('Label column (optional)', labelCol, setLabelCol, true)}
            {colSelect('Size-by column (optional)', valueCol, setValueCol, true)}
            <div className="dialog-actions">
              <button
                onClick={() => {
                  onCreate(latCol, longCol, labelCol === '' ? undefined : labelCol, valueCol === '' ? undefined : valueCol);
                  onClose();
                }}
              >
                Create map
              </button>
              <button onClick={onClose}>Cancel</button>
            </div>
          </>
        ) : (
          <>
            <p style={{ fontSize: 13, color: '#555' }}>
              Select the column holding place names (cities, addresses). Names are
              geocoded via OpenStreetMap Nominatim; when you are offline a bundled
              table of major cities is used instead and the map says so.
            </p>
            {colSelect('Place-name column', nameCol, setNameCol, false)}
            {colSelect('Size-by column (optional)', valueCol, setValueCol, true)}
            {phase === 'working' && (
              <p role="status" style={{ fontSize: 13 }}>
                Geocoding {progress.done} of {progress.total}…
              </p>
            )}
            {phase === 'done' && outcome && (
              <div role="status" style={{ fontSize: 13, background: '#f3f6fb', borderRadius: 4, padding: 8, marginBottom: 8 }}>
                {outcome.plotted > 0 ? (
                  <p style={{ margin: '0 0 4px' }}>✓ Plotted {outcome.plotted} of {outcome.total} places on the globe.</p>
                ) : (
                  <p style={{ margin: '0 0 4px' }}>No places could be plotted — check the place names.</p>
                )}
                <p style={{ margin: '0 0 4px', color: '#555' }}>Geocoded via {outcome.providerName || '—'}.</p>
                {outcome.offline && (
                  <p style={{ margin: '0 0 4px', color: '#92600a' }}>
                    ⚠ Offline: coordinates came from the bundled table of major cities.
                  </p>
                )}
                {outcome.unknown.length > 0 && (
                  <p style={{ margin: 0, color: '#555' }}>
                    Could not resolve: {outcome.unknown.slice(0, 8).join(', ')}
                    {outcome.unknown.length > 8 ? ` (+${outcome.unknown.length - 8} more)` : ''}.
                  </p>
                )}
              </div>
            )}
            <div className="dialog-actions">
              {phase !== 'working' && (
                <button onClick={handleGeocode}>
                  {phase === 'done' ? 'Geocode again' : 'Geocode & create map'}
                </button>
              )}
              <button onClick={onClose}>{phase === 'done' ? 'Close' : 'Cancel'}</button>
            </div>
          </>
        )}
      </A11yDialog>
  );
}

export { pointsFromRows };
