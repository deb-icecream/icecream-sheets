/**
 * App gallery operations: duplicate (rebind) + share (app + data
 * snapshot, recipient-owned copies).
 *
 * The gallery (chat surface list + Workspace "Apps" section) works on
 * the SAME persistent artifact store as generation — entries are only
 * ever specs the chat actually generated. This module is the headless
 * core the surfaces share:
 *
 * - duplicateArtifact: a copy of a generated app rebound to a
 *   different sheet/range. The copy reads/writes ONLY the new binding
 *   (its bridge calls carry the new binding), so an edit in the copy
 *   can never land in the original sheet.
 * - Share (user amendment 2026-10-21): sharing an app shares the app
 *   WITH its data — a materialized snapshot of the bound sheet travels
 *   with the app (createAppSharePackage). The recipient materializes
 *   their OWN bound copies (materializeRecipientCopy); the owner's
 *   originals are never exposed to recipient edits. Credentials never
 *   travel: a snapshot is cell data only, and validateAppSharePackage
 *   rejects credential-shaped keys anywhere in the package.
 *
 * Pure and headless: no DOM, no engine imports.
 */
import {
  ARTIFACT_SPEC_VERSION,
  newArtifactId,
  validateArtifactSpec,
  type ArtifactBinding,
  type ArtifactSpec,
} from './spec.js';

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

// ---------------------------------------------------------------------------
// Duplicate / rebind
// ---------------------------------------------------------------------------

export interface RebindOptions {
  /** Name for the copy. Default: `<original name> copy`. */
  name?: string;
  /** Principal stamped on the copy. Default: the original's. */
  principal?: string;
  now?: () => number;
}

/**
 * Generated apps carry their binding INSIDE the source: the template
 * generator's first line is `var BINDING = {…};` (generator.ts
 * bindingPrelude) and the app reads/writes through that global.
 * Rebinding a copy therefore means rewriting the embedded prelude to
 * the new binding — changing only spec.binding would leave the copy
 * talking to the ORIGINAL sheet (proven in browser validation: a
 * duplicated app displayed and edited its original sheet). Sources
 * without the generator prelude are returned unchanged.
 */
const EMBEDDED_BINDING_RE = /^var BINDING = (\{[^;]*\});/;

export function withEmbeddedBinding(source: string, binding: ArtifactBinding): string {
  if (!EMBEDDED_BINDING_RE.test(source)) return source;
  const embedded = {
    sheet: binding.sheet,
    startRow: binding.startRow,
    startCol: binding.startCol,
    endRow: binding.endRow,
    endCol: binding.endCol,
    columns: binding.columns.map((c) => ({ name: c.name, type: c.type, index: c.index })),
  };
  return source.replace(EMBEDDED_BINDING_RE, `var BINDING = ${JSON.stringify(embedded)};`);
}

/**
 * Create a NEW artifact spec: same app (source, template, prompt) as
 * `spec`, bound to `binding` instead. Fresh id, fresh timestamps.
 * Throws when the result would not validate — a copy is a real
 * artifact or it is not created at all.
 */
export function duplicateArtifact(
  spec: ArtifactSpec,
  binding: ArtifactBinding,
  opts: RebindOptions = {},
): ArtifactSpec {
  const now = (opts.now ?? Date.now)();
  const copy: ArtifactSpec = {
    id: newArtifactId(),
    version: ARTIFACT_SPEC_VERSION,
    kind: spec.kind,
    name: opts.name ?? `${spec.name} copy`,
    prompt: spec.prompt,
    template: spec.template,
    source: withEmbeddedBinding(spec.source, binding),
    binding: {
      sheet: binding.sheet,
      startRow: binding.startRow,
      startCol: binding.startCol,
      endRow: binding.endRow,
      endCol: binding.endCol,
      hasHeaderRow: binding.hasHeaderRow,
      columns: binding.columns.map((c) => ({ ...c })),
    },
    principal: opts.principal ?? spec.principal,
    createdAt: now,
    updatedAt: now,
  };
  const validated = validateArtifactSpec(copy);
  if (!validated.ok) {
    throw new Error(`duplicate artifact failed validation: ${validated.errors.join('; ')}`);
  }
  return validated.spec;
}

// ---------------------------------------------------------------------------
// Share: the app WITH its data (user amendment, 2026-10-21)
// ---------------------------------------------------------------------------

/**
 * A materialized data snapshot: the bound sheet's cell matrix, read
 * through MCP at share time. This is the ONLY form in which data
 * travels. For connector-backed sources (SQL / REST API) the snapshot
 * is the materialized spreadsheet data — a connection string or vault
 * credential has no representation here and can never ride along
 * (validateAppSharePackage rejects credential-shaped keys anywhere in
 * the package, defense in depth).
 */
export interface ArtifactDataSnapshot {
  /** Sheet name the snapshot was taken from (the recipient's copy keeps it). */
  sheet: string;
  /** Cell matrix, header row first when the binding has one. */
  cells: unknown[][];
}

/**
 * What a share consists of: the generated app plus a snapshot of its
 * bound data. The recipient receives their OWN copies of both, bound
 * together (see materializeRecipientCopy); the owner's originals are
 * never exposed to recipient edits.
 */
export interface AppSharePackage {
  v: 2;
  app: ArtifactSpec;
  snapshot: ArtifactDataSnapshot;
  /** Data size, for the sharer-facing notice: data rows (excl. header) and columns. */
  rowCount: number;
  colCount: number;
}

/**
 * Build the share package for an artifact from the cell matrix of its
 * bound sheet (the caller reads it through MCP — get_results on the
 * bound sheet). Throws when the artifact is invalid or the matrix is
 * empty: there is no share without the app AND its data.
 */
export function createAppSharePackage(spec: ArtifactSpec, cells: unknown[][]): AppSharePackage {
  const validated = validateArtifactSpec(spec);
  if (!validated.ok) {
    throw new Error(`cannot share an invalid artifact: ${validated.errors.join('; ')}`);
  }
  if (!Array.isArray(cells) || cells.length === 0) {
    throw new Error('cannot share: the bound sheet has no data to snapshot');
  }
  const colCount = cells.reduce((m, r) => Math.max(m, Array.isArray(r) ? r.length : 0), 0);
  const rowCount = spec.binding.hasHeaderRow ? Math.max(0, cells.length - 1) : cells.length;
  const pkg: AppSharePackage = {
    v: 2,
    app: validated.spec,
    snapshot: { sheet: spec.binding.sheet, cells },
    rowCount,
    colCount,
  };
  const check = validateAppSharePackage(pkg);
  if (!check.ok) throw new Error(`share package failed validation: ${check.errors.join('; ')}`);
  return pkg;
}

const CREDENTIAL_KEY = /connection|string|password|passwd|secret|token|credential|vault|api[-_]?key|auth/i;

/** Deep key scan: a share package must never carry credential material. */
function scanForCredentialKeys(value: unknown, path: string, errors: string[]): void {
  if (Array.isArray(value)) {
    value.forEach((v, i) => scanForCredentialKeys(v, `${path}[${i}]`, errors));
    return;
  }
  if (typeof value === 'object' && value !== null) {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (CREDENTIAL_KEY.test(k)) {
        errors.push(`credential-shaped key "${k}" at ${path} must never travel in a share`);
      }
      scanForCredentialKeys(v, `${path}.${k}`, errors);
    }
  }
}

export interface SharePackageValidation {
  ok: boolean;
  errors: string[];
}

/** Structural validation for a received share package. Never throws. */
export function validateAppSharePackage(raw: unknown): SharePackageValidation {
  const errors: string[] = [];
  if (!isRecord(raw)) return { ok: false, errors: ['share package must be an object'] };
  if (raw['v'] !== 2) errors.push(`unsupported share package version ${String(raw['v'])} (expected 2)`);
  const appCheck = validateArtifactSpec(raw['app']);
  if (!appCheck.ok) errors.push(...appCheck.errors.map((e) => `app: ${e}`));
  const snap = raw['snapshot'];
  if (!isRecord(snap)) {
    errors.push('snapshot is required');
  } else {
    if (typeof snap['sheet'] !== 'string' || !(snap['sheet'] as string).trim()) {
      errors.push('snapshot.sheet is required');
    }
    if (!Array.isArray(snap['cells']) || (snap['cells'] as unknown[]).length === 0) {
      errors.push('snapshot.cells must be a non-empty matrix');
    } else if ((snap['cells'] as unknown[]).some((r) => !Array.isArray(r))) {
      errors.push('snapshot.cells rows must be arrays');
    }
    if (appCheck.ok && typeof snap['sheet'] === 'string' && snap['sheet'] !== appCheck.spec.binding.sheet) {
      errors.push('snapshot.sheet must match the app binding sheet');
    }
  }
  if (typeof raw['rowCount'] !== 'number' || (raw['rowCount'] as number) < 0) {
    errors.push('rowCount must be a non-negative number');
  }
  if (typeof raw['colCount'] !== 'number' || (raw['colCount'] as number) < 0) {
    errors.push('colCount must be a non-negative number');
  }
  scanForCredentialKeys(raw, 'package', errors);
  return { ok: errors.length === 0, errors };
}

export interface RecipientCopy {
  /** The recipient's own app artifact (fresh id, recipient principal). */
  artifact: ArtifactSpec;
  /** The recipient's own data copy, bound to the artifact. */
  snapshot: ArtifactDataSnapshot;
}

/**
 * Materialize the recipient's copies from a share package: a fresh
 * artifact (new id — the owner's artifact is untouched and unreachable
 * from it) plus the data snapshot, bound together by construction: the
 * artifact's binding sheet IS the snapshot's sheet, and the binding
 * range covers the snapshot matrix, so the app copy reads/writes the
 * data copy and nothing else.
 */
export function materializeRecipientCopy(
  pkg: AppSharePackage,
  opts: { principal: string; now?: () => number },
): RecipientCopy {
  const check = validateAppSharePackage(pkg);
  if (!check.ok) {
    throw new Error(`cannot materialize an invalid share package: ${check.errors.join('; ')}`);
  }
  const now = (opts.now ?? Date.now)();
  const rows = pkg.snapshot.cells.length;
  const cols = pkg.snapshot.cells.reduce((m, r) => Math.max(m, r.length), 0);
  const recipientBinding: ArtifactBinding = {
    ...pkg.app.binding,
    sheet: pkg.snapshot.sheet,
    startRow: 0,
    startCol: 0,
    endRow: Math.max(0, rows - 1),
    endCol: Math.max(0, cols - 1),
    columns: pkg.app.binding.columns.map((c) => ({ ...c })),
  };
  const artifact: ArtifactSpec = {
    ...pkg.app,
    id: newArtifactId(),
    // The app's embedded BINDING prelude must point at the recipient's
    // data copy too (same sheet name, snapshot-covering range).
    source: withEmbeddedBinding(pkg.app.source, recipientBinding),
    binding: recipientBinding,
    principal: opts.principal,
    createdAt: now,
    updatedAt: now,
  };
  const validated = validateArtifactSpec(artifact);
  if (!validated.ok) {
    throw new Error(`recipient artifact failed validation: ${validated.errors.join('; ')}`);
  }
  return {
    artifact: validated.spec,
    snapshot: { sheet: pkg.snapshot.sheet, cells: pkg.snapshot.cells },
  };
}
