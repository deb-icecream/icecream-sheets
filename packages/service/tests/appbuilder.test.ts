/**
 * No-code app builder tests: spec validation/migration, generation, view
 * model logic, action semantics and permission filtering.
 */
import { describe, expect, it } from 'vitest';
import {
  APP_SPEC_VERSION,
  generateAppSpec,
  migrateAppSpec,
  newAppId,
  specColumns,
  validateAppSpec,
  type AppSpec,
  type ColumnSpec,
  type RangeBinding,
} from '../src/appbuilder/spec.js';
import {
  allowAllSubjectPolicy,
  applySliceFilter,
  applySubjectFilter,
  displayValue,
  dropTrailingBlankRows,
  inferColumnType,
  inferColumns,
  isDenied,
  recordsFromValues,
  viewColumns,
  type AppRecord,
  type CellInput,
  type SubjectPolicy,
} from '../src/appbuilder/model.js';
import {
  ActionError,
  AuthorizationError,
  ConfirmationRequiredError,
  appTarget,
  coerceValue,
  executeAction,
  type RowMutationPort,
} from '../src/appbuilder/actions.js';
import {
  createAppStore,
  deserializeApps,
  memoryPersistence,
  serializeApps,
} from '../src/metadataStore.js';

const BINDING: RangeBinding = {
  sheet: 'Sheet1',
  startRow: 0,
  startCol: 0,
  endRow: 10,
  endCol: 3,
  headerRow: true,
};

const COLUMNS: ColumnSpec[] = [
  { name: 'Name', type: 'text' },
  { name: 'Age', type: 'numeric' },
  { name: 'Hired', type: 'date' },
  { name: 'Photo', type: 'imageUrl' },
];

function makeSpec(): AppSpec {
  return generateAppSpec('People', BINDING, COLUMNS, { id: 'app_test' });
}

/** In-memory RowMutationPort for action-semantics tests. */
class FakePort implements RowMutationPort {
  principal = 'user';
  denied = false;
  headers: string[];
  rows: Record<string, CellInput>[];

  constructor(headers: string[], rows: Record<string, CellInput>[]) {
    this.headers = headers;
    this.rows = rows.map((r) => ({ ...r }));
  }

  authorize(action: 'app.read' | 'app.write' | 'app.manage', target: string): void {
    if (this.denied) throw new AuthorizationError(this.principal, action, target);
  }

  rowCount(): number {
    return this.rows.length;
  }

  insertRow(_b: RangeBinding, index: number, values: Record<string, CellInput>): void {
    const row: Record<string, CellInput> = {};
    for (const h of this.headers) row[h] = values[h] ?? null;
    this.rows.splice(index, 0, row);
  }

  updateRow(_b: RangeBinding, index: number, values: Record<string, CellInput>): void {
    Object.assign(this.rows[index] as Record<string, CellInput>, values);
  }

  deleteRow(_b: RangeBinding, index: number): void {
    this.rows.splice(index, 1);
  }

  readRows(): AppRecord[] {
    return this.rows.map((values, rowIndex) => ({ rowIndex, values }));
  }
}

// ---------------------------------------------------------------------------
// Spec validation
// ---------------------------------------------------------------------------

describe('validateAppSpec', () => {
  it('accepts a generated spec', () => {
    const spec = makeSpec();
    const res = validateAppSpec(JSON.parse(JSON.stringify(spec)));
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.spec.version).toBe(APP_SPEC_VERSION);
  });

  it('rejects non-objects and wrong versions', () => {
    expect(validateAppSpec(null).ok).toBe(false);
    expect(validateAppSpec('x').ok).toBe(false);
    const spec = { ...makeSpec(), version: 999 };
    const res = validateAppSpec(spec);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.errors.join(' ')).toMatch(/version/);
  });

  it('requires id, name, views, actions, navigation', () => {
    const res = validateAppSpec({ version: 1 });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.errors).toContain('id is required');
      expect(res.errors).toContain('name is required');
      expect(res.errors).toContain('views must be a non-empty array');
      expect(res.errors).toContain('actions must be an array');
      expect(res.errors).toContain('navigation is required');
    }
  });

  it('validates the range binding', () => {
    const spec = makeSpec();
    spec.dataSource.binding.endRow = -1 as unknown as number;
    const res = validateAppSpec(spec);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.errors.some((e) => e.includes('endRow'))).toBe(true);
  });

  it('rejects duplicate view ids and unknown view kinds', () => {
    const spec = makeSpec();
    spec.views.push({ ...spec.views[0]! });
    (spec.views[1] as { kind: string }).kind = 'hologram';
    const res = validateAppSpec(spec);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.errors.some((e) => e.includes('duplicated'))).toBe(true);
      expect(res.errors.some((e) => e.includes('must be one of'))).toBe(true);
    }
  });

  it('rejects view columns that do not exist', () => {
    const spec = makeSpec();
    spec.views[0]!.columns = ['Nope'];
    const res = validateAppSpec(spec);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.errors.some((e) => e.includes('unknown column'))).toBe(true);
  });

  it('requires deleteRow actions to set requiresConfirm', () => {
    const spec = makeSpec();
    const del = spec.actions.find((a) => a.kind === 'deleteRow')!;
    del.requiresConfirm = false;
    const res = validateAppSpec(spec);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.errors.some((e) => e.includes('requiresConfirm'))).toBe(true);
  });

  it('requires navigate actions to target an existing view', () => {
    const spec = makeSpec();
    spec.actions.push({
      id: 'bad_nav',
      kind: 'navigate',
      label: 'Bad',
      targetViewId: 'missing',
      requiresConfirm: false,
    });
    const res = validateAppSpec(spec);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.errors.some((e) => e.includes('unknown view'))).toBe(true);
  });

  it('requires navigation.initialViewId to exist', () => {
    const spec = makeSpec();
    spec.navigation.initialViewId = 'ghost';
    const res = validateAppSpec(spec);
    expect(res.ok).toBe(false);
  });

  it('rejects reference columns without referenceTableId', () => {
    const spec = makeSpec();
    spec.dataSource.columns = [{ name: 'Order', type: 'reference' }];
    const res = validateAppSpec(spec);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.errors.some((e) => e.includes('referenceTableId'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Migration
// ---------------------------------------------------------------------------

describe('migrateAppSpec', () => {
  it('migrates a v0 draft: fills ids, defaults, version', () => {
    const migrated = migrateAppSpec({
      name: 'Old',
      dataSource: { binding: { sheet: 'S' } },
      views: [{ kind: 'table' }],
      actions: [{ kind: 'deleteRow' }],
    });
    expect(migrated.version).toBe(APP_SPEC_VERSION);
    expect(migrated.id).toMatch(/^app_/);
    expect(migrated.views[0]!.id).toBe('view_1');
    expect(migrated.views[0]!.title).toBe('Table');
    expect(migrated.actions[0]!.requiresConfirm).toBe(true);
    expect(migrated.dataSource.binding.headerRow).toBe(true);
    expect(migrated.navigation.initialViewId).toBe('view_1');
    expect(validateAppSpec(migrated).ok).toBe(true);
  });

  it('keeps explicit values and throws on unknown versions', () => {
    const migrated = migrateAppSpec({ id: 'keep', version: 0, name: 'N', views: [], actions: [] });
    expect(migrated.id).toBe('keep');
    expect(() => migrateAppSpec({ version: 42 })).toThrow(/cannot migrate/);
    expect(() => migrateAppSpec(null)).toThrow();
  });

  it('generates unique ids', () => {
    expect(newAppId()).not.toBe(newAppId());
  });
});

// ---------------------------------------------------------------------------
// Generation
// ---------------------------------------------------------------------------

describe('generateAppSpec', () => {
  it('builds all four v1 views plus default actions', () => {
    const spec = makeSpec();
    const kinds = spec.views.map((v) => v.kind).sort();
    expect(kinds).toEqual(['cards', 'detail', 'form', 'table']);
    const actionKinds = spec.actions.map((a) => a.kind);
    expect(actionKinds).toContain('addRow');
    expect(actionKinds).toContain('editRow');
    expect(actionKinds).toContain('deleteRow');
    expect(spec.navigation.initialViewId).toBe('view_table');
    expect(specColumns(spec)).toEqual(COLUMNS);
    expect(validateAppSpec(spec).ok).toBe(true);
  });

  it('creates a linked detail view per reference column', () => {
    const cols: ColumnSpec[] = [
      { name: 'Item', type: 'text' },
      { name: 'Order', type: 'reference', referenceTableId: 'Orders' },
    ];
    const spec = generateAppSpec('Linked', BINDING, cols, { id: 'app_ref' });
    const linked = spec.views.find((v) => v.id === 'view_ref_order');
    expect(linked).toBeDefined();
    expect(linked!.kind).toBe('detail');
    expect(validateAppSpec(spec).ok).toBe(true);
  });

  it('titles cards from the first text column', () => {
    const spec = makeSpec();
    const cards = spec.views.find((v) => v.kind === 'cards')!;
    expect(cards.titleColumn).toBe('Name');
    expect(cards.subtitleColumn).toBe('Age');
  });
});

// ---------------------------------------------------------------------------
// View model logic
// ---------------------------------------------------------------------------

describe('column type inference', () => {
  it('infers numeric, boolean, date, imageUrl, reference and text', () => {
    expect(inferColumnType('n', [1, 2, '3', null])).toBe('numeric');
    expect(inferColumnType('b', [true, 'false', true])).toBe('boolean');
    expect(inferColumnType('d', ['2026-01-02', '2026-03-04'])).toBe('date');
    expect(inferColumnType('i', ['https://x.test/a.png', 'https://x.test/b.jpg'])).toBe('imageUrl');
    expect(inferColumnType('r', ['Orders[1]', 'Orders[2]'])).toBe('reference');
    expect(inferColumnType('t', ['a', 'b', 1])).toBe('text');
    expect(inferColumnType('e', [null, ''])).toBe('text');
  });

  it('needs a strict majority for non-text types', () => {
    expect(inferColumnType('m', [1, 'a', 'b'])).toBe('text');
  });

  it('ignores denied cells when inferring', () => {
    expect(inferColumnType('n', [{ error: '#PERM!' }, 5, 6])).toBe('numeric');
  });

  it('derives referenceTableId from the bracketed table name', () => {
    const cols = inferColumns(['Order'], [['Orders[7]'], ['Orders[8]']]);
    expect(cols[0]!.type).toBe('reference');
    expect(cols[0]!.referenceTableId).toBe('Orders');
  });
});

describe('records and slices', () => {
  const grid: CellInput[][] = [
    ['Name', 'Age'],
    ['Ann', 30],
    ['Bob', 25],
    [null, null],
  ];

  it('builds header-keyed records and drops trailing blanks', () => {
    const snap = dropTrailingBlankRows(recordsFromValues(grid));
    expect(snap.headers).toEqual(['Name', 'Age']);
    expect(snap.records).toHaveLength(2);
    expect(snap.records[0]!.values).toEqual({ Name: 'Ann', Age: 30 });
  });

  it('supports headerless bindings with positional headers', () => {
    const snap = recordsFromValues([['a', 1]], { headerRow: false });
    expect(snap.headers).toEqual(['Column 1', 'Column 2']);
    expect(snap.records).toHaveLength(1);
  });

  it('applies slice filters', () => {
    const snap = recordsFromValues(grid);
    expect(applySliceFilter(snap.records, { column: 'Age', op: 'gte', value: 28 })).toHaveLength(1);
    expect(applySliceFilter(snap.records, { column: 'Name', op: 'contains', value: 'o' })).toHaveLength(1);
    expect(applySliceFilter(snap.records)).toHaveLength(3);
  });

  it('resolves view columns with hidden defaults', () => {
    const cols: ColumnSpec[] = [
      { name: 'A', type: 'text' },
      { name: 'B', type: 'text', hidden: true },
    ];
    expect(viewColumns({ id: 'v', kind: 'table', title: 'T' }, cols).map((c) => c.name)).toEqual(['A']);
    expect(
      viewColumns({ id: 'v', kind: 'table', title: 'T', columns: ['B'] }, cols).map((c) => c.name),
    ).toEqual(['B']);
  });

  it('renders display values, blanking denied cells', () => {
    expect(displayValue(true)).toBe('TRUE');
    expect(displayValue({ error: '#PERM!' })).toBe('');
    expect(displayValue({ error: '#DIV/0!' })).toBe('#DIV/0!');
    expect(isDenied({ error: '#PERM!' })).toBe(true);
    expect(isDenied(5)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Permission filtering
// ---------------------------------------------------------------------------

describe('applySubjectFilter', () => {
  const cols: ColumnSpec[] = [
    { name: 'Name', type: 'text' },
    { name: 'Salary', type: 'numeric' },
  ];
  const records: AppRecord[] = [
    { rowIndex: 0, values: { Name: 'Ann', Salary: 100 } },
    { rowIndex: 1, values: { Name: 'Bob', Salary: { error: '#PERM!' } } },
  ];

  it('default policy shows everything', () => {
    const out = applySubjectFilter(cols, records, { principal: 'user' });
    expect(out.columns.map((c) => c.name)).toEqual(['Name', 'Salary']);
    expect(out.records).toHaveLength(2);
  });

  it('hides columns the principal may not read', () => {
    const policy: SubjectPolicy = {
      ...allowAllSubjectPolicy,
      readableColumns: () => ['Name'],
    };
    const out = applySubjectFilter(cols, records, { principal: 'viewer', policy });
    expect(out.columns.map((c) => c.name)).toEqual(['Name']);
  });

  it('hides rows the principal may not read', () => {
    const policy: SubjectPolicy = {
      ...allowAllSubjectPolicy,
      rowVisible: (_p, _t, r) => r.values['Name'] !== 'Bob',
    };
    const out = applySubjectFilter(cols, records, { principal: 'viewer', policy });
    expect(out.records.map((r) => r.values['Name'])).toEqual(['Ann']);
  });

  it('drops columns that are entirely permission-denied', () => {
    const denied: AppRecord[] = [
      { rowIndex: 0, values: { Name: 'Ann', Salary: { error: '#PERM!' } } },
      { rowIndex: 1, values: { Name: 'Bob', Salary: { error: '#PERM!' } } },
    ];
    const out = applySubjectFilter(cols, denied, { principal: 'viewer' });
    expect(out.columns.map((c) => c.name)).toEqual(['Name']);
  });

  it('never leaks a denied value into the filtered view', () => {
    // The denied cell's *value* is replaced by the authorization marker
    // (permission-model.md §4); the view layer renders markers as blank.
    // Here the viewer may not read Salary at all, so the column vanishes
    // and its values never appear in the filtered view.
    const policy: SubjectPolicy = {
      ...allowAllSubjectPolicy,
      readableColumns: () => ['Name'],
    };
    const secret: AppRecord[] = [
      { rowIndex: 0, values: { Name: 'Ann', Salary: 's3cret-value' } },
      { rowIndex: 1, values: { Name: 'Bob', Salary: { error: '#PERM!' } } },
    ];
    const out = applySubjectFilter(cols, secret, { principal: 'viewer', policy });
    expect(out.columns.map((c) => c.name)).toEqual(['Name']);
    expect(JSON.stringify(out)).not.toContain('s3cret-value');

    // A denied cell the viewer *can* partially see stays marked and renders blank.
    const partial = applySubjectFilter(cols, secret, { principal: 'viewer' });
    const bob = partial.records.find((r) => r.values['Name'] === 'Bob')!;
    expect(isDenied(bob.values['Salary'] ?? null)).toBe(true);
    expect(displayValue(bob.values['Salary'] ?? null)).toBe('');
  });
});

// ---------------------------------------------------------------------------
// Action semantics
// ---------------------------------------------------------------------------

describe('executeAction', () => {
  function setup() {
    const spec = makeSpec();
    const port = new FakePort(['Name', 'Age', 'Hired', 'Photo'], [
      { Name: 'Ann', Age: 30, Hired: '2020-01-01', Photo: null },
    ]);
    return { spec, port };
  }

  it('addRow appends a coerced row after authorize', () => {
    const { spec, port } = setup();
    const out = executeAction(port, {
      spec,
      actionId: 'action_add',
      values: { Name: 'Bob', Age: '25', Hired: '2021-06-01' },
    });
    expect(out.rowIndex).toBe(1);
    expect(port.rows[1]).toMatchObject({ Name: 'Bob', Age: 25 });
  });

  it('editRow updates the targeted row', () => {
    const { spec, port } = setup();
    executeAction(port, { spec, actionId: 'action_edit', rowIndex: 0, values: { Age: 31 } });
    expect(port.rows[0]!.Age).toBe(31);
  });

  it('deleteRow requires confirmation, then removes the row', () => {
    const { spec, port } = setup();
    expect(() =>
      executeAction(port, { spec, actionId: 'action_delete', rowIndex: 0 }),
    ).toThrow(ConfirmationRequiredError);
    expect(port.rows).toHaveLength(1);
    executeAction(port, { spec, actionId: 'action_delete', rowIndex: 0, confirmed: true });
    expect(port.rows).toHaveLength(0);
  });

  it('navigate resolves the target view', () => {
    const { spec, port } = setup();
    const out = executeAction(port, { spec, actionId: 'action_goto_view_cards' });
    expect(out.navigatedTo).toBe('view_cards');
  });

  it('denied writes throw AuthorizationError before mutating', () => {
    const { spec, port } = setup();
    port.denied = true;
    expect(() =>
      executeAction(port, { spec, actionId: 'action_add', values: { Name: 'X' } }),
    ).toThrow(AuthorizationError);
    expect(port.rows).toHaveLength(1);
    expect(() =>
      executeAction(port, { spec, actionId: 'action_delete', rowIndex: 0, confirmed: true }),
    ).toThrow(AuthorizationError);
  });

  it('rejects unknown actions, rows and columns', () => {
    const { spec, port } = setup();
    expect(() => executeAction(port, { spec, actionId: 'nope' })).toThrow(ActionError);
    expect(() =>
      executeAction(port, { spec, actionId: 'action_edit', rowIndex: 9, values: { Age: 1 } }),
    ).toThrow(ActionError);
    expect(() =>
      executeAction(port, { spec, actionId: 'action_add', values: { Nope: 1 } }),
    ).toThrow(ActionError);
  });

  it('coerces and validates values by column type', () => {
    expect(coerceValue({ name: 'A', type: 'numeric' }, '12')).toBe(12);
    expect(() => coerceValue({ name: 'A', type: 'numeric' }, 'x')).toThrow(ActionError);
    expect(coerceValue({ name: 'B', type: 'boolean' }, 'yes')).toBe(true);
    expect(() => coerceValue({ name: 'D', type: 'date' }, 'not-a-date')).toThrow(ActionError);
    expect(coerceValue({ name: 'D', type: 'date' }, '2026-02-03')).toBe('2026-02-03');
    expect(() => coerceValue({ name: 'I', type: 'imageUrl' }, 'notaurl')).toThrow(ActionError);
  });

  it('targets the app/table node in the permission tree', () => {
    const spec = makeSpec();
    expect(appTarget(spec)).toBe('app:app_test/table:Sheet1');
    spec.dataSource.binding.tableId = 'tbl_1';
    expect(appTarget(spec)).toBe('app:app_test/table:tbl_1');
  });
});

// ---------------------------------------------------------------------------
// Metadata store
// ---------------------------------------------------------------------------

describe('app metadata store', () => {
  it('round-trips specs and migrates stored payloads', () => {
    const store = createAppStore(memoryPersistence());
    const spec = makeSpec();
    store.add(spec);
    expect(store.all()).toHaveLength(1);

    const json = serializeApps(store.all());
    // Simulate an old payload: strip version, expect migration on load.
    const old = JSON.parse(json) as { apps: unknown[] };
    delete (old.apps[0] as Record<string, unknown>)['version'];
    const raw = JSON.stringify(old);
    expect(deserializeApps(raw)).toHaveLength(1);
    expect(deserializeApps(raw)[0]!.version).toBe(APP_SPEC_VERSION);
    expect(deserializeApps('not json')).toEqual([]);
    expect(deserializeApps('{"apps": "nope"}')).toEqual([]);
  });

  it('removes and clears', () => {
    const store = createAppStore(memoryPersistence());
    store.add(makeSpec());
    expect(store.remove((a) => a.id === 'app_test')).toBe(1);
    expect(store.all()).toHaveLength(0);
    store.add(makeSpec());
    store.clear();
    expect(store.all()).toHaveLength(0);
  });
});
