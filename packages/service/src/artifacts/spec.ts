/**
 * AI-generated app artifacts: versioned spec for chat-generated React apps.
 *
 * Per the user's AI-GENERATED APP PATTERN spec (2026-10-18): the chat
 * generates a FRONTEND-ONLY React app from spreadsheet data. The app runs
 * EMBEDDED inside Icecream Sheets as a view/panel (inside/side of the chat,
 * side-by-side with the spreadsheet, with a fullscreen-expand option) — it
 * is NOT a standalone deployable web app; there is no export/deploy path.
 *
 * The app reads AND writes ONLY via MCP tools (the iframe posts
 * {tool, args} to the host; the host executes them through the real MCP
 * client and posts results back — see bridge.ts). No direct data hydration.
 *
 * Every generated app is a persistent CHAT ARTIFACT: the source + metadata
 * live in the service metadata store (see createArtifactStore in
 * metadataStore.ts), versioned so the format can grow without breaking
 * saved apps. Artifacts survive across sessions and are re-openable from
 * the chat.
 *
 * This module is pure and headless: no DOM, no engine imports.
 */

/** Current artifact-spec version. Bump when the format changes incompatibly. */
export const ARTIFACT_SPEC_VERSION = 1;

/** v1 artifact kinds. Only embedded React apps exist; there is no other kind. */
export type ArtifactKind = 'react-app';

export const ARTIFACT_KINDS: readonly ArtifactKind[] = ['react-app'];

/** Templates the built-in generator can produce (generator.ts). */
export type ArtifactTemplate = 'data-table' | 'chart-dashboard' | 'data-entry-form' | 'custom';

export const ARTIFACT_TEMPLATES: readonly ArtifactTemplate[] = [
  'data-table',
  'chart-dashboard',
  'data-entry-form',
  'custom',
];

export type ArtifactColumnType = 'text' | 'numeric' | 'date' | 'boolean';

export const ARTIFACT_COLUMN_TYPES: readonly ArtifactColumnType[] = [
  'text',
  'numeric',
  'date',
  'boolean',
];

/** Column of the sheet range the app is bound to (from the data schema). */
export interface ArtifactColumn {
  name: string;
  type: ArtifactColumnType;
  /** 0-based column offset within the bound range. */
  index: number;
}

/** The sheet range the generated app reads/writes through MCP tools. */
export interface ArtifactBinding {
  sheet: string;
  startRow: number;
  startCol: number;
  endRow: number;
  endCol: number;
  /** First row of the range holds column headers. */
  hasHeaderRow: boolean;
  columns: ArtifactColumn[];
}

/**
 * Versioned, serializable chat artifact. Stored in the service metadata
 * store (never in workbook bytes, never in client component state).
 */
export interface ArtifactSpec {
  id: string;
  version: number;
  kind: ArtifactKind;
  name: string;
  /** The user prompt that produced this app (provenance). */
  prompt: string;
  /** Which template produced the source ('custom' for LLM-generated). */
  template: ArtifactTemplate;
  /**
   * React component source: JSX (or plain JavaScript with h() calls)
   * defining `function App()` with NO parameters. The host renderer
   * transforms JSX with Babel on demand, then compiles the source with
   * React, h, useState, useEffect, useRef, the `mcp` bridge object and
   * the spec BINDING in scope — never destructure from React, never
   * declare App parameters (see artifacts/llm.ts buildPrompt and the
   * host-context renderer in apps/web).
   */
  source: string;
  binding: ArtifactBinding;
  /** Creator identity (ai-agent.md §3: the agent acts as the user). */
  principal: string;
  createdAt: number;
  updatedAt: number;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export interface ValidatedArtifactSpec {
  ok: true;
  spec: ArtifactSpec;
}

export interface InvalidArtifactSpec {
  ok: false;
  errors: string[];
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function nonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0;
}

function nonNegInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0;
}

/**
 * Validate an unknown value as an ArtifactSpec. Returns the spec on
 * success, or a list of human-readable errors. Never throws.
 */
export function validateArtifactSpec(raw: unknown): ValidatedArtifactSpec | InvalidArtifactSpec {
  const errors: string[] = [];
  if (!isRecord(raw)) return { ok: false, errors: ['artifact spec must be an object'] };
  if (raw['version'] !== ARTIFACT_SPEC_VERSION) {
    errors.push(
      `unsupported artifact spec version ${String(raw['version'])} (expected ${ARTIFACT_SPEC_VERSION}); migrate first with migrateArtifactSpec`,
    );
  }
  if (!nonEmptyString(raw['id'])) errors.push('id is required');
  if (!ARTIFACT_KINDS.includes(raw['kind'] as ArtifactKind)) {
    errors.push(`kind must be one of ${ARTIFACT_KINDS.join(', ')}`);
  }
  if (!nonEmptyString(raw['name'])) errors.push('name is required');
  if (typeof raw['prompt'] !== 'string') errors.push('prompt must be a string');
  if (!ARTIFACT_TEMPLATES.includes(raw['template'] as ArtifactTemplate)) {
    errors.push(`template must be one of ${ARTIFACT_TEMPLATES.join(', ')}`);
  }
  if (!nonEmptyString(raw['source'])) errors.push('source is required');
  else if (!/function\s+App\s*\(/.test(raw['source'] as string)) {
    errors.push('source must define function App()');
  }
  if (!nonEmptyString(raw['principal'])) errors.push('principal is required');

  const b = raw['binding'];
  if (!isRecord(b)) {
    errors.push('binding is required');
  } else {
    if (!nonEmptyString(b['sheet'])) errors.push('binding.sheet is required');
    for (const k of ['startRow', 'startCol', 'endRow', 'endCol'] as const) {
      if (!nonNegInt(b[k])) errors.push(`binding.${k} must be a non-negative integer`);
    }
    if (nonNegInt(b['startRow']) && nonNegInt(b['endRow']) && (b['endRow'] as number) < (b['startRow'] as number)) {
      errors.push('binding.endRow must be >= startRow');
    }
    if (nonNegInt(b['startCol']) && nonNegInt(b['endCol']) && (b['endCol'] as number) < (b['startCol'] as number)) {
      errors.push('binding.endCol must be >= startCol');
    }
    if (typeof b['hasHeaderRow'] !== 'boolean') errors.push('binding.hasHeaderRow must be a boolean');
    if (!Array.isArray(b['columns'])) {
      errors.push('binding.columns must be an array');
    } else {
      const names = new Set<string>();
      (b['columns'] as unknown[]).forEach((c: unknown, i: number) => {
        const where = `binding.columns[${i}]`;
        if (!isRecord(c) || !nonEmptyString(c['name'])) {
          errors.push(`${where}.name is required`);
          return;
        }
        if (names.has(c['name'] as string)) errors.push(`${where}.name is duplicated`);
        names.add(c['name'] as string);
        if (!ARTIFACT_COLUMN_TYPES.includes(c['type'] as ArtifactColumnType)) {
          errors.push(`${where}.type must be one of ${ARTIFACT_COLUMN_TYPES.join(', ')}`);
        }
        if (!nonNegInt(c['index'])) errors.push(`${where}.index must be a non-negative integer`);
      });
    }
  }

  for (const k of ['createdAt', 'updatedAt'] as const) {
    const v = raw[k];
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) {
      errors.push(`${k} must be a non-negative timestamp`);
    }
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, spec: raw as unknown as ArtifactSpec };
}

// ---------------------------------------------------------------------------
// Migration
// ---------------------------------------------------------------------------

let idSeq = 1;

/** Generate a fresh artifact id (stable once persisted). */
export function newArtifactId(): string {
  idSeq += 1;
  return `artifact_${Date.now().toString(36)}_${idSeq.toString(36)}`;
}

// ---------------------------------------------------------------------------
// Store serialization (service metadata store)
// ---------------------------------------------------------------------------

export interface StoredArtifacts {
  version: number;
  artifacts: ArtifactSpec[];
}

/** Serialize artifact specs for the metadata store. */
export function serializeArtifacts(artifacts: ArtifactSpec[]): string {
  const stored: StoredArtifacts = { version: ARTIFACT_SPEC_VERSION, artifacts };
  return JSON.stringify(stored);
}

/**
 * Deserialize artifact specs, migrating older versions forward.
 * Returns an empty list (not an exception) for corrupt payloads; skips
 * entries that fail validation after migration.
 */
export function deserializeArtifacts(json: string): ArtifactSpec[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return [];
  }
  if (typeof parsed !== 'object' || parsed === null) return [];
  const stored = parsed as Partial<StoredArtifacts>;
  if (!Array.isArray(stored.artifacts)) return [];
  const out: ArtifactSpec[] = [];
  for (const a of stored.artifacts) {
    if (typeof a !== 'object' || a === null) continue;
    try {
      const migrated = migrateArtifactSpec(a);
      if (validateArtifactSpec(migrated).ok) out.push(migrated);
    } catch {
      // Skip unsalvageable entries; the store must never fail to load.
    }
  }
  return out;
}

function asColumn(c: unknown, index: number): ArtifactColumn {
  const r = isRecord(c) ? c : {};
  return {
    name: nonEmptyString(r['name']) ? (r['name'] as string) : `Column ${index + 1}`,
    type: ARTIFACT_COLUMN_TYPES.includes(r['type'] as ArtifactColumnType)
      ? (r['type'] as ArtifactColumnType)
      : 'text',
    index: nonNegInt(r['index']) ? (r['index'] as number) : index,
  };
}

/**
 * Migrate an older (or partial) spec to the current version. Throws on
 * values that cannot be salvaged.
 *
 * v0 -> v1: pre-release drafts had no version field and no template /
 * principal; the binding carried no column list. Defaults fill in.
 */
export function migrateArtifactSpec(raw: unknown): ArtifactSpec {
  if (!isRecord(raw)) throw new Error('migrateArtifactSpec: spec must be an object');
  const version = raw['version'];
  if (version !== undefined && version !== 0 && version !== ARTIFACT_SPEC_VERSION) {
    throw new Error(`migrateArtifactSpec: cannot migrate version ${String(version)}`);
  }
  const b = isRecord(raw['binding']) ? raw['binding'] : {};
  const num = (v: unknown, fallback: number): number => (nonNegInt(v) ? v : fallback);
  const now = Date.now();
  const columns = Array.isArray(b['columns'])
    ? (b['columns'] as unknown[]).map((c, i) => asColumn(c, i))
    : [];
  const spec: ArtifactSpec = {
    id: nonEmptyString(raw['id']) ? (raw['id'] as string) : newArtifactId(),
    version: ARTIFACT_SPEC_VERSION,
    kind: 'react-app',
    name: nonEmptyString(raw['name']) ? (raw['name'] as string) : 'Untitled app',
    prompt: typeof raw['prompt'] === 'string' ? (raw['prompt'] as string) : '',
    template: ARTIFACT_TEMPLATES.includes(raw['template'] as ArtifactTemplate)
      ? (raw['template'] as ArtifactTemplate)
      : 'custom',
    source: typeof raw['source'] === 'string' ? (raw['source'] as string) : '',
    binding: {
      sheet: nonEmptyString(b['sheet']) ? (b['sheet'] as string) : 'Sheet1',
      startRow: num(b['startRow'], 0),
      startCol: num(b['startCol'], 0),
      endRow: Math.max(num(b['endRow'], 0), num(b['startRow'], 0)),
      endCol: Math.max(num(b['endCol'], 0), num(b['startCol'], 0)),
      hasHeaderRow: b['hasHeaderRow'] !== false,
      columns,
    },
    principal: nonEmptyString(raw['principal']) ? (raw['principal'] as string) : 'unknown',
    createdAt: typeof raw['createdAt'] === 'number' && raw['createdAt'] >= 0 ? (raw['createdAt'] as number) : now,
    updatedAt: typeof raw['updatedAt'] === 'number' && raw['updatedAt'] >= 0 ? (raw['updatedAt'] as number) : now,
  };
  return spec;
}
