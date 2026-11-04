/**
 * No-code app builder: versioned app spec (design-docs/no-code-app-builder.md §2).
 *
 * An app is a versioned, serializable spec: data bindings naming tables by
 * stable object id, views, actions, navigation and display options. The spec
 * lives in the service metadata store (metadataStore.ts), never in workbook
 * bytes. Versioning lets the format grow (e.g. new view types in v2) without
 * breaking existing apps.
 *
 * This module is pure and headless: no DOM, no engine imports. The runtime
 * reads/writes through the typed computational view via a host-supplied port
 * (see actions.ts).
 */

/** Current app-spec version. Bump when the format changes incompatibly. */
export const APP_SPEC_VERSION = 1;

/** Column types derived from the typed view (no-code-app-builder.md §3). */
export type ColumnType = 'text' | 'numeric' | 'date' | 'boolean' | 'imageUrl' | 'reference';

export const COLUMN_TYPES: readonly ColumnType[] = [
  'text',
  'numeric',
  'date',
  'boolean',
  'imageUrl',
  'reference',
];

/** A bound column with its inferred type. */
export interface ColumnSpec {
  name: string;
  type: ColumnType;
  /**
   * For reference columns: stable id of the related table, so the runtime
   * can build a linked detail view into it (no-code-app-builder.md §3).
   */
  referenceTableId?: string;
  /** Hide this column from all views by default. */
  hidden?: boolean;
}

/**
 * Range binding. v1 binds a sheet rectangle; `tableId` names the table by
 * its stable object id in the permission tree (permission-model.md §1) so
 * authorize() can resolve inheritance when the full model lands.
 */
export interface RangeBinding {
  sheet: string;
  startRow: number;
  startCol: number;
  endRow: number;
  endCol: number;
  /** First row of the range holds column headers. Defaults to true. */
  headerRow?: boolean;
  /** Stable object id of the bound table (permission tree node). */
  tableId?: string;
}

export type DataSourceKind = 'range';

export interface DataSource {
  kind: DataSourceKind;
  binding: RangeBinding;
  /**
   * Column types inferred from the typed view at generation time. Views name
   * columns from here; the runtime re-derives types from live data when the
   * binding changes shape.
   */
  columns?: ColumnSpec[];
}

/** v1 view kinds (no-code-app-builder.md §4). Calendar/map/dashboard are v2. */
export type ViewKind = 'table' | 'detail' | 'form' | 'cards';

export const VIEW_KINDS: readonly ViewKind[] = ['table', 'detail', 'form', 'cards'];

export type FilterOp = 'eq' | 'ne' | 'gt' | 'gte' | 'lt' | 'lte' | 'contains';

export const FILTER_OPS: readonly FilterOp[] = ['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'contains'];

/** A filtered slice of the bound table (v1: a single predicate). */
export interface SliceFilter {
  column: string;
  op: FilterOp;
  value: string | number | boolean | null;
}

export type FormMode = 'add' | 'edit' | 'both';

export interface ViewSpec {
  id: string;
  kind: ViewKind;
  title: string;
  /** Columns shown, in order. Defaults to all non-hidden columns. */
  columns?: string[];
  /** Optional filtered slice of the bound table. */
  filter?: SliceFilter;
  /** Form views: which modes the form supports. Defaults to 'both'. */
  formMode?: FormMode;
  /** Cards view: column rendered as the card title. */
  titleColumn?: string;
  /** Cards view: column rendered as the card subtitle. */
  subtitleColumn?: string;
}

/** v1 action kinds (no-code-app-builder.md §5). Custom actions are v2. */
export type ActionKind = 'addRow' | 'editRow' | 'deleteRow' | 'navigate';

export const ACTION_KINDS: readonly ActionKind[] = ['addRow', 'editRow', 'deleteRow', 'navigate'];

export interface ActionSpec {
  id: string;
  kind: ActionKind;
  label: string;
  /** For navigate actions: the target view id. */
  targetViewId?: string;
  /**
   * deleteRow always requires confirmation: the runtime refuses to run it
   * until the caller passes confirmed=true (the UI confirms first).
   */
  requiresConfirm: boolean;
}

export interface NavigationSpec {
  initialViewId: string;
  /** Explicit view order for the nav bar; defaults to views[] order. */
  viewOrder?: string[];
}

export interface AppSpecOptions {
  theme?: 'light' | 'dark';
}

export interface AppSpec {
  id: string;
  version: number;
  name: string;
  /**
   * W4: gateway file this app is bound to, when it was built (or
   * migrated on open) while that file was open in gateway mode. The
   * server-side built-app store keys records by owner + this file id,
   * so the app follows the user to any browser for THAT file. Absent
   * on local/desktop specs and on pre-W4 localStorage records — those
   * records carry no file binding at all.
   */
  fileId?: string;
  dataSource: DataSource;
  views: ViewSpec[];
  actions: ActionSpec[];
  navigation: NavigationSpec;
  options?: AppSpecOptions;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export interface ValidatedSpec {
  ok: true;
  spec: AppSpec;
}

export interface InvalidSpec {
  ok: false;
  errors: string[];
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function nonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0;
}

/**
 * Validate an unknown value as an AppSpec. Returns the migrated spec on
 * success, or a list of human-readable errors. Never throws.
 */
export function validateAppSpec(raw: unknown): ValidatedSpec | InvalidSpec {
  const errors: string[] = [];
  if (!isRecord(raw)) {
    return { ok: false, errors: ['app spec must be an object'] };
  }
  if (raw['version'] !== APP_SPEC_VERSION) {
    errors.push(
      `unsupported app spec version ${String(raw['version'])} (expected ${APP_SPEC_VERSION}); migrate first with migrateAppSpec`,
    );
  }
  if (!nonEmptyString(raw['id'])) errors.push('id is required');
  if (!nonEmptyString(raw['name'])) errors.push('name is required');

  // Data source.
  const ds = raw['dataSource'];
  let columns: ColumnSpec[] = [];
  if (!isRecord(ds)) {
    errors.push('dataSource is required');
  } else {
    if (ds['kind'] !== 'range') errors.push(`dataSource.kind must be "range" (got ${String(ds['kind'])})`);
    const b = ds['binding'];
    if (!isRecord(b)) {
      errors.push('dataSource.binding is required');
    } else {
      if (!nonEmptyString(b['sheet'])) errors.push('dataSource.binding.sheet is required');
      for (const k of ['startRow', 'startCol', 'endRow', 'endCol'] as const) {
        const v = b[k];
        if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) {
          errors.push(`dataSource.binding.${k} must be a non-negative integer`);
        }
      }
      if (
        typeof b['startRow'] === 'number' &&
        typeof b['endRow'] === 'number' &&
        b['endRow'] < b['startRow']
      ) {
        errors.push('dataSource.binding.endRow must be >= startRow');
      }
      if (
        typeof b['startCol'] === 'number' &&
        typeof b['endCol'] === 'number' &&
        b['endCol'] < b['startCol']
      ) {
        errors.push('dataSource.binding.endCol must be >= startCol');
      }
      if (b['headerRow'] !== undefined && typeof b['headerRow'] !== 'boolean') {
        errors.push('dataSource.binding.headerRow must be a boolean');
      }
    }
  }
  // Column specs live on the data source (they describe the bound table).
  // v1 generation always writes them; hand-written specs may omit them.
  if (ds && isRecord(ds) && ds['columns'] !== undefined) {
    if (!Array.isArray(ds['columns'])) {
      errors.push('dataSource.columns must be an array');
    } else {
      const names = new Set<string>();
      (ds['columns'] as unknown[]).forEach((c: unknown, i: number) => {
        if (!isRecord(c) || !nonEmptyString(c['name'])) {
          errors.push(`dataSource.columns[${i}].name is required`);
          return;
        }
        if (names.has(c['name'] as string)) errors.push(`dataSource.columns[${i}].name is duplicated: ${c['name']}`);
        names.add(c['name'] as string);
        if (!COLUMN_TYPES.includes(c['type'] as ColumnType)) {
          errors.push(`dataSource.columns[${i}].type must be one of ${COLUMN_TYPES.join(', ')}`);
        }
        if (c['type'] === 'reference' && !nonEmptyString(c['referenceTableId'])) {
          errors.push(`dataSource.columns[${i}]: reference columns need referenceTableId`);
        }
      });
      columns = (ds['columns'] as ColumnSpec[]).filter(
        (c) => isRecord(c) && nonEmptyString((c as ColumnSpec).name),
      );
    }
  }
  const columnNames = new Set(columns.map((c) => c.name));

  // Views.
  const views = raw['views'];
  const viewIds = new Set<string>();
  if (!Array.isArray(views) || views.length === 0) {
    errors.push('views must be a non-empty array');
  } else {
    views.forEach((v: unknown, i: number) => {
      const where = `views[${i}]`;
      if (!isRecord(v)) {
        errors.push(`${where} must be an object`);
        return;
      }
      if (!nonEmptyString(v['id'])) errors.push(`${where}.id is required`);
      else if (viewIds.has(v['id'] as string)) errors.push(`${where}.id is duplicated: ${v['id']}`);
      else viewIds.add(v['id'] as string);
      if (!VIEW_KINDS.includes(v['kind'] as ViewKind)) {
        errors.push(`${where}.kind must be one of ${VIEW_KINDS.join(', ')}`);
      }
      if (!nonEmptyString(v['title'])) errors.push(`${where}.title is required`);
      if (v['columns'] !== undefined) {
        if (!Array.isArray(v['columns']) || v['columns'].some((c) => typeof c !== 'string')) {
          errors.push(`${where}.columns must be an array of strings`);
        } else if (columnNames.size > 0) {
          for (const c of v['columns'] as string[]) {
            if (!columnNames.has(c)) errors.push(`${where}.columns references unknown column "${c}"`);
          }
        }
      }
      if (v['filter'] !== undefined) {
        const f = v['filter'];
        if (!isRecord(f) || typeof f['column'] !== 'string' || !FILTER_OPS.includes(f['op'] as FilterOp)) {
          errors.push(`${where}.filter must be { column, op, value } with op in ${FILTER_OPS.join(', ')}`);
        } else if (columnNames.size > 0 && !columnNames.has(f['column'] as string)) {
          errors.push(`${where}.filter references unknown column "${f['column']}"`);
        }
      }
      if (v['kind'] === 'form' && v['formMode'] !== undefined && !['add', 'edit', 'both'].includes(v['formMode'] as string)) {
        errors.push(`${where}.formMode must be add, edit or both`);
      }
    });
  }

  // Actions.
  const actions = raw['actions'];
  const actionIds = new Set<string>();
  if (!Array.isArray(actions)) {
    errors.push('actions must be an array');
  } else {
    actions.forEach((a: unknown, i: number) => {
      const where = `actions[${i}]`;
      if (!isRecord(a)) {
        errors.push(`${where} must be an object`);
        return;
      }
      if (!nonEmptyString(a['id'])) errors.push(`${where}.id is required`);
      else if (actionIds.has(a['id'] as string)) errors.push(`${where}.id is duplicated: ${a['id']}`);
      else actionIds.add(a['id'] as string);
      if (!ACTION_KINDS.includes(a['kind'] as ActionKind)) {
        errors.push(`${where}.kind must be one of ${ACTION_KINDS.join(', ')}`);
      }
      if (!nonEmptyString(a['label'])) errors.push(`${where}.label is required`);
      if (a['kind'] === 'navigate') {
        if (!nonEmptyString(a['targetViewId'])) errors.push(`${where}.targetViewId is required for navigate actions`);
        else if (!viewIds.has(a['targetViewId'] as string)) {
          errors.push(`${where}.targetViewId references unknown view "${a['targetViewId']}"`);
        }
      }
      if (typeof a['requiresConfirm'] !== 'boolean') errors.push(`${where}.requiresConfirm must be a boolean`);
      if (a['kind'] === 'deleteRow' && a['requiresConfirm'] !== true) {
        errors.push(`${where}: deleteRow actions must set requiresConfirm=true`);
      }
    });
  }

  // Navigation.
  const nav = raw['navigation'];
  if (!isRecord(nav)) {
    errors.push('navigation is required');
  } else {
    if (!nonEmptyString(nav['initialViewId'])) errors.push('navigation.initialViewId is required');
    else if (!viewIds.has(nav['initialViewId'] as string)) {
      errors.push(`navigation.initialViewId references unknown view "${nav['initialViewId']}"`);
    }
    if (nav['viewOrder'] !== undefined) {
      if (!Array.isArray(nav['viewOrder']) || nav['viewOrder'].some((v) => typeof v !== 'string')) {
        errors.push('navigation.viewOrder must be an array of strings');
      } else {
        for (const v of nav['viewOrder'] as string[]) {
          if (!viewIds.has(v)) errors.push(`navigation.viewOrder references unknown view "${v}"`);
        }
      }
    }
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, spec: raw as unknown as AppSpec };
}

// ---------------------------------------------------------------------------
// Migration
// ---------------------------------------------------------------------------

let idSeq = 1;

/** Generate a fresh app id (stable once persisted). */
export function newAppId(): string {
  idSeq += 1;
  return `app_${Date.now().toString(36)}_${idSeq.toString(36)}`;
}

function asColumnSpec(c: unknown): ColumnSpec | null {
  if (!isRecord(c) || !nonEmptyString(c['name'])) return null;
  const type = COLUMN_TYPES.includes(c['type'] as ColumnType) ? (c['type'] as ColumnType) : 'text';
  const out: ColumnSpec = { name: c['name'] as string, type };
  if (nonEmptyString(c['referenceTableId'])) out.referenceTableId = c['referenceTableId'] as string;
  if (c['hidden'] === true) out.hidden = true;
  return out;
}

/**
 * Migrate an older (or partial) spec to the current version. Fills defaults
 * for missing optional fields. Throws on values that cannot be salvaged.
 *
 * v0 -> v1: pre-release drafts had no version field; views lacked ids and
 * the binding had no headerRow/tableId. Everything else carries over.
 */
export function migrateAppSpec(raw: unknown): AppSpec {
  if (!isRecord(raw)) throw new Error('migrateAppSpec: spec must be an object');
  const version = raw['version'];
  if (version !== undefined && version !== 0 && version !== APP_SPEC_VERSION) {
    throw new Error(`migrateAppSpec: cannot migrate version ${String(version)}`);
  }
  const ds = isRecord(raw['dataSource']) ? raw['dataSource'] : {};
  const b = isRecord(ds['binding']) ? (ds['binding'] as Record<string, unknown>) : {};
  const num = (v: unknown, fallback: number): number =>
    typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : fallback;

  const viewsIn = Array.isArray(raw['views']) ? raw['views'] : [];
  const views: ViewSpec[] = viewsIn
    .filter(isRecord)
    .map((v, i) => {
      const kind = VIEW_KINDS.includes(v['kind'] as ViewKind) ? (v['kind'] as ViewKind) : 'table';
      const view: ViewSpec = {
        id: nonEmptyString(v['id']) ? (v['id'] as string) : `view_${i + 1}`,
        kind,
        title: nonEmptyString(v['title']) ? (v['title'] as string) : `${kind[0].toUpperCase()}${kind.slice(1)}`,
      };
      if (Array.isArray(v['columns'])) view.columns = (v['columns'] as unknown[]).filter((c) => typeof c === 'string') as string[];
      if (isRecord(v['filter'])) view.filter = v['filter'] as unknown as SliceFilter;
      if (v['formMode'] === 'add' || v['formMode'] === 'edit' || v['formMode'] === 'both') view.formMode = v['formMode'];
      if (nonEmptyString(v['titleColumn'])) view.titleColumn = v['titleColumn'] as string;
      if (nonEmptyString(v['subtitleColumn'])) view.subtitleColumn = v['subtitleColumn'] as string;
      return view;
    });

  const actionsIn = Array.isArray(raw['actions']) ? raw['actions'] : [];
  const actions: ActionSpec[] = actionsIn.filter(isRecord).map((a, i) => {
    const kind = ACTION_KINDS.includes(a['kind'] as ActionKind) ? (a['kind'] as ActionKind) : 'navigate';
    const action: ActionSpec = {
      id: nonEmptyString(a['id']) ? (a['id'] as string) : `action_${i + 1}`,
      kind,
      label: nonEmptyString(a['label']) ? (a['label'] as string) : kind,
      requiresConfirm: kind === 'deleteRow' ? true : a['requiresConfirm'] === true,
    };
    if (nonEmptyString(a['targetViewId'])) action.targetViewId = a['targetViewId'] as string;
    return action;
  });

  const navIn = isRecord(raw['navigation']) ? raw['navigation'] : {};
  const navigation: NavigationSpec = {
    initialViewId:
      nonEmptyString(navIn['initialViewId']) && views.some((v) => v.id === navIn['initialViewId'])
        ? (navIn['initialViewId'] as string)
        : (views[0]?.id ?? 'view_1'),
  };
  if (Array.isArray(navIn['viewOrder'])) {
    navigation.viewOrder = (navIn['viewOrder'] as unknown[]).filter((v) => typeof v === 'string') as string[];
  }

  const columns = Array.isArray((ds as Record<string, unknown>)['columns'])
    ? ((ds as Record<string, unknown>)['columns'] as unknown[]).map(asColumnSpec).filter((c): c is ColumnSpec => c !== null)
    : [];

  const spec: AppSpec = {
    id: nonEmptyString(raw['id']) ? (raw['id'] as string) : newAppId(),
    version: APP_SPEC_VERSION,
    name: nonEmptyString(raw['name']) ? (raw['name'] as string) : 'Untitled app',
    dataSource: {
      kind: 'range',
      binding: {
        sheet: nonEmptyString(b['sheet']) ? (b['sheet'] as string) : 'Sheet1',
        startRow: num(b['startRow'], 0),
        startCol: num(b['startCol'], 0),
        endRow: Math.max(num(b['endRow'], 0), num(b['startRow'], 0)),
        endCol: Math.max(num(b['endCol'], 0), num(b['startCol'], 0)),
        headerRow: b['headerRow'] !== false,
      },
      ...(columns.length > 0 ? { columns } : {}),
    },
    views,
    actions,
    navigation,
  };
  if (nonEmptyString(b['tableId'])) spec.dataSource.binding.tableId = b['tableId'] as string;
  if (isRecord(raw['options'])) spec.options = raw['options'] as AppSpecOptions;
  // W4: preserve the gateway file binding across migration.
  if (nonEmptyString(raw['fileId'])) spec.fileId = raw['fileId'] as string;
  return spec;
}

/** Column specs carried on the data source (describe the bound table). */
export function specColumns(spec: AppSpec): ColumnSpec[] {
  return spec.dataSource.columns ?? [];
}

// ---------------------------------------------------------------------------
// Generation from a table (no-code-app-builder.md §3)
// ---------------------------------------------------------------------------

/**
 * Build a working app spec from a table's columns. Default views are derived
 * from column types: every column shows in the table view, a reference column
 * additionally becomes a linked detail view into the related table, and the
 * cards view titles itself from the first text column.
 */
export function generateAppSpec(
  name: string,
  binding: RangeBinding,
  columns: ColumnSpec[],
  opts?: { id?: string },
): AppSpec {
  const visible = columns.filter((c) => !c.hidden);
  const columnNames = visible.map((c) => c.name);

  const tableView: ViewSpec = { id: 'view_table', kind: 'table', title: 'Table', columns: columnNames };
  const detailView: ViewSpec = { id: 'view_detail', kind: 'detail', title: 'Detail', columns: columnNames };
  const formView: ViewSpec = {
    id: 'view_form',
    kind: 'form',
    title: 'Add / Edit',
    columns: columnNames,
    formMode: 'both',
  };
  const firstText = visible.find((c) => c.type === 'text');
  const cardsView: ViewSpec = {
    id: 'view_cards',
    kind: 'cards',
    title: 'Cards',
    columns: columnNames,
    ...(firstText ? { titleColumn: firstText.name } : {}),
    ...(visible.find((c) => c !== firstText && (c.type === 'text' || c.type === 'numeric'))
      ? { subtitleColumn: (visible.find((c) => c !== firstText && (c.type === 'text' || c.type === 'numeric')) as ColumnSpec).name }
      : {}),
  };
  const views: ViewSpec[] = [tableView, detailView, formView, cardsView];

  // Reference columns become linked detail views into the related table
  // (no-code-app-builder.md §3). The linked view binds the same sheet range
  // shape but names the related table's stable id; the host resolves it.
  for (const col of visible.filter((c) => c.type === 'reference' && c.referenceTableId)) {
    views.push({
      id: `view_ref_${sanitizeId(col.name)}`,
      kind: 'detail',
      title: `${col.name} details`,
      filter: { column: col.name, op: 'eq', value: '' },
    });
  }

  const actions: ActionSpec[] = [
    { id: 'action_add', kind: 'addRow', label: 'Add row', requiresConfirm: false },
    { id: 'action_edit', kind: 'editRow', label: 'Edit row', requiresConfirm: false },
    { id: 'action_delete', kind: 'deleteRow', label: 'Delete row', requiresConfirm: true },
  ];
  for (const v of views) {
    if (v.id === tableView.id) continue;
    actions.push({
      id: `action_goto_${v.id}`,
      kind: 'navigate',
      label: `Go to ${v.title}`,
      targetViewId: v.id,
      requiresConfirm: false,
    });
  }

  const spec: AppSpec = {
    id: opts?.id ?? newAppId(),
    version: APP_SPEC_VERSION,
    name,
    dataSource: { kind: 'range', binding: { headerRow: true, ...binding }, columns },
    views,
    actions,
    navigation: { initialViewId: tableView.id, viewOrder: views.map((v) => v.id) },
  };
  const validated = validateAppSpec(spec);
  if (!validated.ok) {
    throw new Error(`generateAppSpec produced an invalid spec: ${validated.errors.join('; ')}`);
  }
  return validated.spec;
}

function sanitizeId(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || 'col';
}
