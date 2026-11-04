/**
 * Gallery core (artifacts/gallery.ts): duplicate/rebind and the
 * app+data share model (user amendment 2026-10-21).
 *
 * Invariants under test:
 * - A duplicate is a valid new artifact bound ONLY to its target.
 * - A share package is the app WITH a materialized snapshot of its
 *   bound sheet (name + row/col counts for the sharer notice).
 * - Credentials never travel: validation rejects credential-shaped
 *   keys anywhere in a package (a connector's connection string or
 *   vault material has no legitimate place in one).
 * - The recipient materializes their OWN copies: fresh artifact id,
 *   recipient principal, binding covering exactly the snapshot — the
 *   owner's artifact id appears nowhere in the recipient's copy.
 */
import { describe, expect, it } from 'vitest';
import {
  createAppSharePackage,
  duplicateArtifact,
  materializeRecipientCopy,
  validateAppSharePackage,
  validateArtifactSpec,
  type AppSharePackage,
  type ArtifactBinding,
  type ArtifactSpec,
} from '../src/artifacts/index.js';

const SOURCE = [
  'function App() {',
  '  return h("div", null, "scores");',
  '}',
].join('\n');

function spec(overrides: Partial<ArtifactSpec> = {}): ArtifactSpec {
  const base: ArtifactSpec = {
    id: 'artifact_original',
    version: 1,
    kind: 'react-app',
    name: 'Score viewer',
    prompt: 'show me the scores, sortable',
    template: 'data-table',
    source: SOURCE,
    binding: {
      sheet: 'Scores',
      startRow: 0,
      startCol: 0,
      endRow: 3,
      endCol: 1,
      hasHeaderRow: true,
      columns: [
        { name: 'Player', type: 'text', index: 0 },
        { name: 'Points', type: 'numeric', index: 1 },
      ],
    },
    principal: 'web-user',
    createdAt: 1000,
    updatedAt: 2000,
  };
  return { ...base, ...overrides };
}

const CELLS: unknown[][] = [
  ['Player', 'Points'],
  ['Ada', 30],
  ['Grace', 25],
  ['Linus', 20],
];

const TARGET: ArtifactBinding = {
  sheet: 'MyScores',
  startRow: 0,
  startCol: 0,
  endRow: 5,
  endCol: 2,
  hasHeaderRow: true,
  columns: [
    { name: 'Player', type: 'text', index: 0 },
    { name: 'Points', type: 'numeric', index: 1 },
    { name: 'Round', type: 'numeric', index: 2 },
  ],
};

describe('duplicateArtifact', () => {
  it('creates a valid new artifact bound to the target, original untouched', () => {
    const original = spec();
    const copy = duplicateArtifact(original, TARGET, { now: () => 5000 });
    expect(copy.id).not.toBe(original.id);
    expect(copy.name).toBe('Score viewer copy');
    expect(copy.source).toBe(original.source);
    expect(copy.prompt).toBe(original.prompt);
    expect(copy.binding).toEqual(TARGET);
    expect(copy.createdAt).toBe(5000);
    expect(validateArtifactSpec(copy).ok).toBe(true);
    expect(original.binding.sheet).toBe('Scores');
    expect(original.binding.columns).toHaveLength(2);
  });

  it('deep-copies the binding (mutating the copy cannot reach the original)', () => {
    const original = spec();
    const copy = duplicateArtifact(original, TARGET);
    copy.binding.columns[0].name = 'MUTATED';
    expect(original.binding.columns[0].name).toBe('Player');
  });

  it('throws instead of persisting an invalid copy', () => {
    const bad = { ...TARGET, sheet: '' };
    expect(() => duplicateArtifact(spec(), bad)).toThrow(/validation/);
  });

  it('rewrites the embedded BINDING prelude so the copy talks to the NEW sheet', () => {
    // Template-generated sources open with the generator's prelude —
    // the app reads/writes through it, NOT through spec.binding.
    const templated = spec({
      source:
        'var BINDING = {"sheet":"Scores","startRow":0,"startCol":0,"endRow":3,"endCol":1,' +
        '"columns":[{"name":"Player","type":"text","index":0},{"name":"Points","type":"numeric","index":1}]};\n' +
        SOURCE,
    });
    const copy = duplicateArtifact(templated, TARGET);
    const m = /^var BINDING = (\{[^;]*\});/.exec(copy.source);
    expect(m).not.toBeNull();
    const embedded = JSON.parse(m![1]) as { sheet: string; endCol: number; columns: unknown[] };
    expect(embedded.sheet).toBe('MyScores');
    expect(embedded.endCol).toBe(2);
    expect(embedded.columns).toHaveLength(3);
    expect(copy.source).not.toContain('"sheet":"Scores"');
    // The original's source is untouched.
    expect(templated.source).toContain('"sheet":"Scores"');
  });

  it('leaves a source without the generator prelude unchanged', () => {
    const plain = spec();
    const copy = duplicateArtifact(plain, TARGET);
    expect(copy.source).toBe(plain.source);
  });
});

describe('createAppSharePackage', () => {
  it('packages the app WITH its data snapshot and counts for the notice', () => {
    const pkg = createAppSharePackage(spec(), CELLS);
    expect(pkg.v).toBe(2);
    expect(pkg.app.id).toBe('artifact_original');
    expect(pkg.snapshot.sheet).toBe('Scores');
    expect(pkg.snapshot.cells).toEqual(CELLS);
    expect(pkg.rowCount).toBe(3); // data rows, header excluded
    expect(pkg.colCount).toBe(2);
    expect(validateAppSharePackage(pkg).ok).toBe(true);
  });

  it('refuses to share an app whose sheet has no data', () => {
    expect(() => createAppSharePackage(spec(), [])).toThrow(/no data/);
  });

  it('the package shape has no place for credentials', () => {
    const pkg = createAppSharePackage(spec(), CELLS);
    expect(Object.keys(pkg).sort()).toEqual(['app', 'colCount', 'rowCount', 'snapshot', 'v'].sort());
    expect(Object.keys(pkg.snapshot).sort()).toEqual(['cells', 'sheet'].sort());
  });
});

describe('validateAppSharePackage — credentials never travel', () => {
  function pkg(): AppSharePackage {
    return createAppSharePackage(spec(), CELLS);
  }

  it('rejects a package smuggling a connection string', () => {
    const evil = JSON.parse(JSON.stringify(pkg())) as Record<string, unknown>;
    (evil['snapshot'] as Record<string, unknown>)['connectionString'] = 'postgres://u:p@h/db';
    const check = validateAppSharePackage(evil);
    expect(check.ok).toBe(false);
    expect(check.errors.join(' ')).toMatch(/credential/);
  });

  it('rejects credential keys nested anywhere (vault material in app)', () => {
    const evil = JSON.parse(JSON.stringify(pkg())) as Record<string, unknown>;
    ((evil['app'] as Record<string, unknown>)['binding'] as Record<string, unknown>)['vaultSecret'] = 'x';
    expect(validateAppSharePackage(evil).ok).toBe(false);
  });

  it('rejects a snapshot whose sheet does not match the app binding', () => {
    const bad = pkg();
    bad.snapshot = { sheet: 'OtherSheet', cells: CELLS };
    const check = validateAppSharePackage(bad);
    expect(check.ok).toBe(false);
    expect(check.errors.join(' ')).toMatch(/must match/);
  });

  it('rejects malformed packages without throwing', () => {
    expect(validateAppSharePackage(null).ok).toBe(false);
    expect(validateAppSharePackage({}).ok).toBe(false);
    expect(validateAppSharePackage({ v: 1 }).ok).toBe(false);
  });
});

describe('materializeRecipientCopy', () => {
  it('gives the recipient their own bound copies; the owner id appears nowhere', () => {
    const pkg = createAppSharePackage(spec(), CELLS);
    const copy = materializeRecipientCopy(pkg, { principal: 'user:bob', now: () => 9000 });
    expect(copy.artifact.id).not.toBe('artifact_original');
    expect(copy.artifact.principal).toBe('user:bob');
    expect(copy.artifact.name).toBe('Score viewer');
    // Bound together: artifact binding sheet/range == the data copy.
    expect(copy.artifact.binding.sheet).toBe('Scores');
    expect(copy.artifact.binding.endRow).toBe(3);
    expect(copy.artifact.binding.endCol).toBe(1);
    expect(copy.snapshot).toEqual({ sheet: 'Scores', cells: CELLS });
    expect(validateArtifactSpec(copy.artifact).ok).toBe(true);
    expect(JSON.stringify(copy.artifact)).not.toContain('artifact_original');
  });

  it('refuses an invalid package', () => {
    const bad = createAppSharePackage(spec(), CELLS);
    bad.snapshot = { sheet: 'Elsewhere', cells: CELLS };
    expect(() => materializeRecipientCopy(bad, { principal: 'user:bob' })).toThrow(/invalid share package/);
  });
});
