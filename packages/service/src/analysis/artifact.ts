/**
 * Analysis artifacts (design-docs: data-analysis component).
 *
 * "The script is shipped as a tool": every analysis run is persisted as a
 * versioned AnalysisArtifact carrying the exact Python source, the schema
 * snapshot it was generated against, an input hash for drift detection,
 * and the result. Artifacts live in the service metadata store (new store
 * key, same pattern as charts/pivots/reports/apps) and are re-runnable
 * via rerun_analysis — same script + same data = same result.
 */

import { MetadataStore, type Persistence } from '../metadataStore.js';
import { AsyncMetadataStore, type AsyncPersistence } from '../secureStore.js';
import type { AnalysisChartSpec } from './chartspec.js';
import type { AnalysisPlan } from './planner.js';
import type { DataSchema } from './schema.js';

/** Current version of the serialized AnalysisArtifact. Bump on shape change. */
export const ANALYSIS_ARTIFACT_VERSION = 1;

/** Storage key in the service metadata store (new key for this component). */
export const ANALYSIS_STORE_KEY = 'icecream-sheets.analyses.v1';

/** A persisted, versioned, re-runnable analysis run. */
export interface AnalysisArtifact {
  version: number;
  /** Stable id, e.g. "analysis_7". */
  id: string;
  /** The user's original intent text. */
  intent: string;
  plan: AnalysisPlan;
  /** Schema snapshot the script was generated against (auditability). */
  schemaSnapshot: DataSchema;
  /** FNV-1a hash of the JSON input the script ran on (drift detection). */
  inputHash: string;
  /** The exact Python source — the shipped, auditable tool. */
  pythonSource: string;
  /** Generator version stamped in the script header. */
  scriptVersion: number;
  /** The analysis payload (the `analysis` half of the stdout contract). */
  result: Record<string, unknown>;
  chartSpec: AnalysisChartSpec;
  createdAt: string;
  principal?: string;
}

export interface StoredAnalyses {
  version: number;
  analyses: AnalysisArtifact[];
}

/** Deterministic 32-bit FNV-1a hash, hex-encoded. Sync and browser-safe. */
export function hashInput(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/**
 * Normalize a stored schema snapshot. Snapshots persisted before the
 * header contract existed carry no hasHeaderRow; they were ALL produced
 * header-assumed (the pipeline always consumed the first row as names),
 * so defaulting the field to true preserves their original rerun input
 * byte-for-byte. New snapshots always carry the field explicitly.
 */
function migrateSchemaSnapshot(raw: unknown): DataSchema {
  const snap = (typeof raw === 'object' && raw !== null ? raw : {}) as Partial<DataSchema>;
  return {
    sheet: typeof snap.sheet === 'string' ? snap.sheet : '',
    rangeRef: typeof snap.rangeRef === 'string' ? snap.rangeRef : '',
    rowCount: typeof snap.rowCount === 'number' ? snap.rowCount : 0,
    hasHeaderRow: typeof snap.hasHeaderRow === 'boolean' ? snap.hasHeaderRow : true,
    columns: Array.isArray(snap.columns) ? snap.columns : [],
  };
}

/**
 * Migrate a stored artifact forward. Unknown/older versions are dropped
 * (returned null) rather than silently misread; v1 passes through after
 * filling defaults.
 */
export function migrateAnalysis(raw: unknown): AnalysisArtifact | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const a = raw as Partial<AnalysisArtifact>;
  if (typeof a.id !== 'string' || typeof a.pythonSource !== 'string') return null;
  if (typeof a.version !== 'number' || a.version > ANALYSIS_ARTIFACT_VERSION) return null;
  if (a.version < 1) return null;
  return {
    version: ANALYSIS_ARTIFACT_VERSION,
    id: a.id,
    intent: typeof a.intent === 'string' ? a.intent : '',
    plan: (a.plan ?? { intentKind: 'summarize', targetColumns: [], params: {}, summary: '' }) as AnalysisPlan,
    schemaSnapshot: migrateSchemaSnapshot(a.schemaSnapshot),
    inputHash: typeof a.inputHash === 'string' ? a.inputHash : '',
    pythonSource: a.pythonSource,
    scriptVersion: typeof a.scriptVersion === 'number' ? a.scriptVersion : 0,
    result: typeof a.result === 'object' && a.result !== null ? (a.result as Record<string, unknown>) : {},
    chartSpec: a.chartSpec as AnalysisChartSpec,
    createdAt: typeof a.createdAt === 'string' ? a.createdAt : new Date(0).toISOString(),
    principal: typeof a.principal === 'string' ? a.principal : undefined,
  };
}

export function serializeAnalyses(items: AnalysisArtifact[]): string {
  const stored: StoredAnalyses = { version: ANALYSIS_ARTIFACT_VERSION, analyses: items };
  return JSON.stringify(stored);
}

/** Deserialize + migrate; corrupt payloads yield [] (never throw). */
export function deserializeAnalyses(json: string): AnalysisArtifact[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return [];
  }
  if (typeof parsed !== 'object' || parsed === null) return [];
  const stored = parsed as Partial<StoredAnalyses>;
  if (!Array.isArray(stored.analyses)) return [];
  const out: AnalysisArtifact[] = [];
  for (const raw of stored.analyses) {
    const migrated = migrateAnalysis(raw);
    if (migrated) out.push(migrated);
  }
  return out;
}

/** Create the analysis-artifact metadata store bound to a persistence adapter. */
export function createAnalysisStore(persistence: Persistence): MetadataStore<AnalysisArtifact> {
  return new MetadataStore<AnalysisArtifact>(
    ANALYSIS_STORE_KEY,
    persistence,
    serializeAnalyses,
    deserializeAnalyses,
  );
}
/** Async variant of createAnalysisStore (durable-store migration). */
export function createAsyncAnalysisStore(
  persistence: AsyncPersistence,
): AsyncMetadataStore<AnalysisArtifact> {
  return new AsyncMetadataStore<AnalysisArtifact>(
    ANALYSIS_STORE_KEY,
    persistence,
    serializeAnalyses,
    deserializeAnalyses,
  );
}

/** Build an artifact from a completed pipeline run. */
export function makeArtifact(fields: {
  id: string;
  intent: string;
  plan: AnalysisPlan;
  schemaSnapshot: DataSchema;
  inputHash: string;
  pythonSource: string;
  scriptVersion: number;
  result: Record<string, unknown>;
  chartSpec: AnalysisChartSpec;
  principal?: string;
}): AnalysisArtifact {
  return {
    version: ANALYSIS_ARTIFACT_VERSION,
    createdAt: new Date().toISOString(),
    ...fields,
  };
}

/** Compact listing row for list_analyses (never ships the full script). */
export function analysisSummary(a: AnalysisArtifact): {
  id: string;
  intent: string;
  intentKind: string;
  rangeRef: string;
  scriptVersion: number;
  createdAt: string;
} {
  return {
    id: a.id,
    intent: a.intent,
    intentKind: a.plan.intentKind,
    rangeRef: a.schemaSnapshot.rangeRef,
    scriptVersion: a.scriptVersion,
    createdAt: a.createdAt,
  };
}
