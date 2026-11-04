/**
 * Service metadata store.
 *
 * Per design-docs/native-reports-and-dashboards.md §2: report/chart/pivot
 * specs are versioned, serializable, and "the spec lives in the service
 * metadata store" — not in the engine, not in the workbook file, not in
 * client component state.
 *
 * This module is storage-agnostic: the caller injects a Persistence adapter
 * (localStorage on web, in-memory or file on the server). Pure
 * serialize/deserialize/migrate functions are unit-testable.
 */

import { CHART_SPEC_VERSION, migrateChart, type ChartSpec } from './chartModel.js';
import {
  ARTIFACT_SPEC_VERSION,
  deserializeArtifacts,
  serializeArtifacts,
  type ArtifactSpec,
  type StoredArtifacts,
} from './artifacts/spec.js';
import { PIVOT_SPEC_VERSION, type PivotSpec } from './pivot.js';
import { APP_SPEC_VERSION, migrateAppSpec, validateAppSpec, type AppSpec } from './appbuilder/spec.js';
import {
  deserializeReports,
  serializeReports,
  type ReportSpec,
} from './reports/spec.js';
import {
  CONNECTOR_SPEC_VERSION,
  deserializeBindings,
  serializeBindings,
  type SourceBinding,
} from './connectors/spec.js';
import {
  AsyncMetadataStore,
  type AsyncPersistence,
} from './secureStore.js';

/** Persistence adapter injected by the host (web localStorage, server memory, etc.). */
export interface Persistence {
  load(key: string): string | null;
  save(key: string, value: string): void;
  clear(key: string): void;
}

/** In-memory persistence for servers/tests. */
export function memoryPersistence(): Persistence {
  const map = new Map<string, string>();
  return {
    load: (k) => map.get(k) ?? null,
    save: (k, v) => void map.set(k, v),
    clear: (k) => void map.delete(k),
  };
}

/**
 * Generic versioned spec store. Owns serialization, migration and
 * persistence for one spec kind under one storage key.
 */
export class MetadataStore<T> {
  private cache: T[] | null = null;

  constructor(
    private readonly key: string,
    private readonly persistence: Persistence,
    private readonly serialize: (items: T[]) => string,
    private readonly deserialize: (json: string) => T[],
  ) {}

  /** Read all specs (cached after first load). */
  all(): T[] {
    if (this.cache === null) {
      const raw = this.persistence.load(this.key);
      this.cache = raw === null ? [] : this.deserialize(raw);
    }
    return [...this.cache];
  }

  /** Replace all specs and persist. */
  saveAll(items: T[]): void {
    this.cache = [...items];
    this.persistence.save(this.key, this.serialize(items));
  }

  /** Add one spec and persist. */
  add(item: T): void {
    this.saveAll([...this.all(), item]);
  }

  /** Remove specs matching a predicate and persist. Returns removed count. */
  remove(predicate: (item: T) => boolean): number {
    const kept = this.all().filter((i) => !predicate(i));
    const removed = this.all().length - kept.length;
    this.saveAll(kept);
    return removed;
  }

  /** Drop everything (cache + persisted). */
  clear(): void {
    this.cache = [];
    this.persistence.clear(this.key);
  }

  /** Force re-read from persistence on next all(). */
  invalidate(): void {
    this.cache = null;
  }
}

// ---------------------------------------------------------------------------
// Chart specs
// ---------------------------------------------------------------------------

export interface StoredCharts {
  version: number;
  charts: ChartSpec[];
}

/** Serialize chart specs for the metadata store. */
export function serializeCharts(charts: ChartSpec[]): string {
  const stored: StoredCharts = { version: CHART_SPEC_VERSION, charts };
  return JSON.stringify(stored);
}

/**
 * Deserialize chart specs, migrating older versions forward.
 * Returns an empty list (not an exception) for corrupt payloads.
 */
export function deserializeCharts(json: string): ChartSpec[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return [];
  }
  if (typeof parsed !== 'object' || parsed === null) return [];
  const stored = parsed as Partial<StoredCharts>;
  if (!Array.isArray(stored.charts)) return [];
  return stored.charts
    .filter((c) => typeof c === 'object' && c !== null)
    .map((c) => migrateChart(c as Partial<ChartSpec>));
}

/** Create a chart-spec metadata store bound to a persistence adapter. */
export function createChartStore(persistence: Persistence): MetadataStore<ChartSpec> {
  return new MetadataStore<ChartSpec>(
    'icecream-sheets.charts.v1',
    persistence,
    serializeCharts,
    deserializeCharts,
  );
}

// ---------------------------------------------------------------------------
// Pivot specs
// ---------------------------------------------------------------------------

export interface StoredPivots {
  version: number;
  pivots: PivotSpec[];
}

/** Serialize pivot specs for the metadata store. */
export function serializePivots(pivots: PivotSpec[]): string {
  const stored: StoredPivots = { version: PIVOT_SPEC_VERSION, pivots };
  return JSON.stringify(stored);
}

/** Deserialize pivot specs. Returns [] for corrupt payloads. */
export function deserializePivots(json: string): PivotSpec[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return [];
  }
  if (typeof parsed !== 'object' || parsed === null) return [];
  const stored = parsed as Partial<StoredPivots>;
  if (!Array.isArray(stored.pivots)) return [];
  return stored.pivots.filter(
    (p): p is PivotSpec =>
      typeof p === 'object' &&
      p !== null &&
      Array.isArray((p as PivotSpec).rows) &&
      Array.isArray((p as PivotSpec).values),
  );
}

/** Create a pivot-spec metadata store bound to a persistence adapter. */
export function createPivotStore(persistence: Persistence): MetadataStore<PivotSpec> {
  return new MetadataStore<PivotSpec>(
    'icecream-sheets.pivots.v1',
    persistence,
    serializePivots,
    deserializePivots,
  );
}

// ---------------------------------------------------------------------------
// Report specs
// ---------------------------------------------------------------------------

/** Create a report-spec metadata store bound to a persistence adapter. */
export function createReportStore(persistence: Persistence): MetadataStore<ReportSpec> {
  return new MetadataStore<ReportSpec>(
    'icecream-sheets.reports.v1',
    persistence,
    serializeReports,
    deserializeReports,
  );
}
/** Async variant of createReportStore (durable-store migration). */
export function createAsyncReportStore(
  persistence: AsyncPersistence,
): AsyncMetadataStore<ReportSpec> {
  return new AsyncMetadataStore<ReportSpec>(
    'icecream-sheets.reports.v1',
    persistence,
    serializeReports,
    deserializeReports,
  );
}

export type { StoredReports } from './reports/spec.js';

// ---------------------------------------------------------------------------
// App specs (no-code app builder, design-docs/no-code-app-builder.md §2)
// ---------------------------------------------------------------------------

export interface StoredApps {
  version: number;
  apps: AppSpec[];
}

/** Serialize app specs for the metadata store. */
export function serializeApps(apps: AppSpec[]): string {
  const stored: StoredApps = { version: APP_SPEC_VERSION, apps };
  return JSON.stringify(stored);
}

/**
 * Deserialize app specs, migrating older versions forward.
 * Returns an empty list (not an exception) for corrupt payloads; skips
 * entries that fail validation after migration.
 */
export function deserializeApps(json: string): AppSpec[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return [];
  }
  if (typeof parsed !== 'object' || parsed === null) return [];
  const stored = parsed as Partial<StoredApps>;
  if (!Array.isArray(stored.apps)) return [];
  const out: AppSpec[] = [];
  for (const a of stored.apps) {
    if (typeof a !== 'object' || a === null) continue;
    try {
      const migrated = migrateAppSpec(a);
      if (validateAppSpec(migrated).ok) out.push(migrated);
    } catch {
      // Skip unsalvageable entries; the store must never fail to load.
    }
  }
  return out;
}

/** Create an app-spec metadata store bound to a persistence adapter. */
export function createAppStore(persistence: Persistence): MetadataStore<AppSpec> {
  return new MetadataStore<AppSpec>(
    'icecream-sheets.apps.v1',
    persistence,
    serializeApps,
    deserializeApps,
  );
}
/** Async variant of createAppStore (durable-store migration). */
export function createAsyncAppStore(persistence: AsyncPersistence): AsyncMetadataStore<AppSpec> {
  return new AsyncMetadataStore<AppSpec>(
    'icecream-sheets.apps.v1',
    persistence,
    serializeApps,
    deserializeApps,
  );
}

// ---------------------------------------------------------------------------
// Connected data-source bindings
// ---------------------------------------------------------------------------

/**
 * Source bindings: which sheet is fed by which connector spec, plus the last
 * refresh time and materialized dimensions (needed for atomic refresh swap).
 * Per the core architecture the spreadsheet is a view over any data source;
 * bindings live in the service metadata store — not in the engine, not in
 * client component state.
 */
export function createDataSourceStore(
  persistence: Persistence,
): MetadataStore<SourceBinding> {
  return new MetadataStore<SourceBinding>(
    `icecream-sheets.data-sources.v${CONNECTOR_SPEC_VERSION}`,
    persistence,
    serializeBindings,
    deserializeBindings,
  );
}
/** Async variant of createDataSourceStore (durable-store migration). */
export function createAsyncDataSourceStore(
  persistence: AsyncPersistence,
): AsyncMetadataStore<SourceBinding> {
  return new AsyncMetadataStore<SourceBinding>(
    `icecream-sheets.data-sources.v${CONNECTOR_SPEC_VERSION}`,
    persistence,
    serializeBindings,
    deserializeBindings,
  );
}

export type { SourceBinding } from './connectors/spec.js';

// ---------------------------------------------------------------------------
// Chat artifacts (AI-generated embedded React apps)
// ---------------------------------------------------------------------------

/**
 * Chat artifacts: generated React app source + metadata, versioned, in the
 * service metadata store. Per the AI-GENERATED APP PATTERN spec the apps
 * run embedded inside Icecream Sheets (never standalone) and survive
 * across sessions, re-openable from the chat.
 */
export function createArtifactStore(persistence: Persistence): MetadataStore<ArtifactSpec> {
  return new MetadataStore<ArtifactSpec>(
    `icecream-sheets.artifacts.v${ARTIFACT_SPEC_VERSION}`,
    persistence,
    serializeArtifacts,
    deserializeArtifacts,
  );
}

export type { ArtifactSpec, StoredArtifacts } from './artifacts/spec.js';
export { serializeArtifacts, deserializeArtifacts } from './artifacts/spec.js';
