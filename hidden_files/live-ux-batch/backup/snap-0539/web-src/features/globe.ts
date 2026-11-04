/**
 * 3D Maps (track 17 `three-d-maps`): orthographic globe projection math.
 * Pure functions — the SVG renderer lives in components/Globe3D.tsx.
 */

export interface LatLong {
  lat: number;
  long: number;
  label?: string;
  value?: number;
}

export interface ProjectedPoint {
  x: number; // -1..1
  y: number; // -1..1
  visible: boolean;
  label?: string;
  value?: number;
}

const DEG = Math.PI / 180;

/**
 * Project a lat/long onto a unit globe with the given rotation.
 * rotation = [lambda0, phi0] in degrees (center longitude/latitude).
 */
export function project(lat: number, long: number, rotLong: number, rotLat: number): ProjectedPoint {
  const lam = long * DEG;
  const phi = lat * DEG;
  const lam0 = rotLong * DEG;
  const phi0 = rotLat * DEG;
  const cosPhi = Math.cos(phi);
  const x = cosPhi * Math.sin(lam - lam0);
  const y =
    Math.cos(phi0) * Math.sin(phi) -
    Math.sin(phi0) * cosPhi * Math.cos(lam - lam0);
  const z =
    Math.sin(phi0) * Math.sin(phi) +
    Math.cos(phi0) * cosPhi * Math.cos(lam - lam0);
  return { x, y: -y, visible: z > 0 };
}

export function projectPoints(
  points: LatLong[],
  rotLong: number,
  rotLat: number,
): ProjectedPoint[] {
  return points.map((p) => ({
    ...project(p.lat, p.long, rotLong, rotLat),
    label: p.label,
    value: p.value,
  }));
}

/** Graticule lines (every `step` degrees) as projected polylines for the globe outline. */
export function graticule(
  rotLong: number,
  rotLat: number,
  step = 20,
): { x1: number; y1: number; x2: number; y2: number; visible: boolean }[] {
  const segs: { x1: number; y1: number; x2: number; y2: number; visible: boolean }[] = [];
  const push = (a: ProjectedPoint, b: ProjectedPoint): void => {
    segs.push({ x1: a.x, y1: a.y, x2: b.x, y2: b.y, visible: a.visible && b.visible });
  };
  // Meridians
  for (let lon = -180; lon < 180; lon += step) {
    let prev: ProjectedPoint | null = null;
    for (let lat = -90; lat <= 90; lat += 5) {
      const p = project(lat, lon, rotLong, rotLat);
      if (prev) push(prev, p);
      prev = p;
    }
  }
  // Parallels
  for (let lat = -80; lat <= 80; lat += step) {
    let prev: ProjectedPoint | null = null;
    for (let lon = -180; lon <= 180; lon += 5) {
      const p = project(lat, lon, rotLong, rotLat);
      if (prev) push(prev, p);
      prev = p;
    }
  }
  return segs;
}

/** Parse lat/long pairs from grid rows given column indexes. */
export function pointsFromRows(
  headers: string[],
  rows: string[][],
  latCol: number,
  longCol: number,
  labelCol?: number,
  valueCol?: number,
): LatLong[] {
  void headers;
  const out: LatLong[] = [];
  for (const r of rows) {
    const lat = Number(r[latCol]);
    const long = Number(r[longCol]);
    if (Number.isNaN(lat) || Number.isNaN(long)) continue;
    if (lat < -90 || lat > 90 || long < -180 || long > 180) continue;
    const v = valueCol !== undefined ? Number(r[valueCol]) : undefined;
    out.push({
      lat,
      long,
      label: labelCol !== undefined ? r[labelCol] : undefined,
      value: v !== undefined && !Number.isNaN(v) ? v : undefined,
    });
  }
  return out;
}
