/**
 * No-code app builder: product-owned sample templates
 * (design-docs/no-code-app-builder.md §7 — "Sample apps ship as
 * product-owned templates written in the same spec format").
 *
 * Each template is a complete, validated AppSpec (spec.ts) bound to a
 * suggested sheet name and column layout. The builder UI / MCP app-builder
 * tools instantiate a template by copying the spec and pointing the range
 * binding at the user's table; column types in the spec guide the initial
 * form inputs and card rendering.
 *
 * Guidance content is product-owned with no external service dependency.
 */
import {
  APP_SPEC_VERSION,
  type ActionSpec,
  type AppSpec,
  type ColumnSpec,
  type ViewSpec,
} from './spec.js';

/** A shipped sample app template. */
export interface AppTemplate {
  /** Stable template id, e.g. 'expense-tracker'. */
  id: string;
  /** Display name shown in the template gallery. */
  name: string;
  /** One-line description for the gallery. */
  description: string;
  /**
   * Suggested sheet name and header row for the bound table. When the
   * builder instantiates the template against an existing table it
   * re-targets the binding; for a fresh sheet it can scaffold these
   * headers.
   */
  suggestedSheet: string;
  suggestedHeaders: string[];
  /** The full app spec in the same format user-built apps use. */
  spec: AppSpec;
}

function standardActions(prefix: string): ActionSpec[] {
  return [
    { id: `${prefix}-add`, kind: 'addRow', label: 'Add', requiresConfirm: false },
    { id: `${prefix}-edit`, kind: 'editRow', label: 'Edit', requiresConfirm: false },
    { id: `${prefix}-delete`, kind: 'deleteRow', label: 'Delete', requiresConfirm: true },
  ];
}

function tableView(id: string, title: string, columns?: string[]): ViewSpec {
  return { id, kind: 'table', title, ...(columns ? { columns } : {}) };
}

function formView(id: string, title: string, columns?: string[]): ViewSpec {
  return { id, kind: 'form', title, formMode: 'both', ...(columns ? { columns } : {}) };
}

function cardsView(
  id: string,
  title: string,
  titleColumn: string,
  subtitleColumn: string,
): ViewSpec {
  return { id, kind: 'cards', title, titleColumn, subtitleColumn };
}

function binding(sheet: string, columns: ColumnSpec[], endCol: number, endRow = 100): AppSpec['dataSource'] {
  return {
    kind: 'range',
    binding: { sheet, startRow: 0, startCol: 0, endRow, endCol, headerRow: true },
    columns,
  };
}

function appSpec(
  id: string,
  name: string,
  dataSource: AppSpec['dataSource'],
  views: ViewSpec[],
  actions: ActionSpec[],
): AppSpec {
  return {
    id,
    version: APP_SPEC_VERSION,
    name,
    dataSource,
    views,
    actions,
    navigation: { initialViewId: views[0]!.id, viewOrder: views.map((v) => v.id) },
  };
}

// ---------------------------------------------------------------------------
// Expense tracker
// ---------------------------------------------------------------------------

const expenseColumns: ColumnSpec[] = [
  { name: 'Date', type: 'date' },
  { name: 'Category', type: 'text' },
  { name: 'Description', type: 'text' },
  { name: 'Amount', type: 'numeric' },
  { name: 'Paid', type: 'boolean' },
];

const expenseTracker: AppTemplate = {
  id: 'expense-tracker',
  name: 'Expense Tracker',
  description: 'Log spending by date and category, review it as cards, and add entries with a typed form.',
  suggestedSheet: 'Expenses',
  suggestedHeaders: ['Date', 'Category', 'Description', 'Amount', 'Paid'],
  spec: appSpec(
    'app-expense-tracker',
    'Expense Tracker',
    binding('Expenses', expenseColumns, 4),
    [
      tableView('expenses-table', 'All Expenses'),
      cardsView('expenses-cards', 'Expenses', 'Description', 'Category'),
      formView('expenses-form', 'Add / Edit Expense'),
    ],
    standardActions('expenses'),
  ),
};

// ---------------------------------------------------------------------------
// Project dashboard
// ---------------------------------------------------------------------------

const projectColumns: ColumnSpec[] = [
  { name: 'Task', type: 'text' },
  { name: 'Owner', type: 'text' },
  { name: 'Status', type: 'text' },
  { name: 'Due Date', type: 'date' },
  { name: 'Priority', type: 'text' },
  { name: 'Progress', type: 'numeric' },
];

const projectDashboard: AppTemplate = {
  id: 'project-dashboard',
  name: 'Project Dashboard',
  description: 'Track tasks by owner, status and due date, with an in-progress slice and card board.',
  suggestedSheet: 'Tasks',
  suggestedHeaders: ['Task', 'Owner', 'Status', 'Due Date', 'Priority', 'Progress'],
  spec: appSpec(
    'app-project-dashboard',
    'Project Dashboard',
    binding('Tasks', projectColumns, 5),
    [
      tableView('tasks-table', 'All Tasks'),
      {
        id: 'tasks-active',
        kind: 'table',
        title: 'In Progress',
        filter: { column: 'Status', op: 'eq', value: 'In Progress' },
      },
      cardsView('tasks-cards', 'Task Board', 'Task', 'Status'),
      formView('tasks-form', 'Add / Edit Task'),
    ],
    standardActions('tasks'),
  ),
};

// ---------------------------------------------------------------------------
// Inventory manager
// ---------------------------------------------------------------------------

const inventoryColumns: ColumnSpec[] = [
  { name: 'SKU', type: 'text' },
  { name: 'Product', type: 'text' },
  { name: 'Category', type: 'text' },
  { name: 'Quantity', type: 'numeric' },
  { name: 'Reorder Level', type: 'numeric' },
  { name: 'Unit Price', type: 'numeric' },
];

const inventoryManager: AppTemplate = {
  id: 'inventory-manager',
  name: 'Inventory Manager',
  description: 'Keep stock levels per SKU, browse products as cards, and restock through the form.',
  suggestedSheet: 'Inventory',
  suggestedHeaders: ['SKU', 'Product', 'Category', 'Quantity', 'Reorder Level', 'Unit Price'],
  spec: appSpec(
    'app-inventory-manager',
    'Inventory Manager',
    binding('Inventory', inventoryColumns, 5),
    [
      tableView('inventory-table', 'Stock'),
      cardsView('inventory-cards', 'Products', 'Product', 'SKU'),
      formView('inventory-form', 'Add / Edit Item'),
    ],
    standardActions('inventory'),
  ),
};

// ---------------------------------------------------------------------------
// Contact directory
// ---------------------------------------------------------------------------

const contactColumns: ColumnSpec[] = [
  { name: 'Name', type: 'text' },
  { name: 'Company', type: 'text' },
  { name: 'Email', type: 'text' },
  { name: 'Phone', type: 'text' },
  { name: 'Tags', type: 'text' },
];

const contactDirectory: AppTemplate = {
  id: 'contact-directory',
  name: 'Contact Directory',
  description: 'A searchable directory of people with detail views per contact.',
  suggestedSheet: 'Contacts',
  suggestedHeaders: ['Name', 'Company', 'Email', 'Phone', 'Tags'],
  spec: appSpec(
    'app-contact-directory',
    'Contact Directory',
    binding('Contacts', contactColumns, 4),
    [
      tableView('contacts-table', 'All Contacts'),
      cardsView('contacts-cards', 'People', 'Name', 'Company'),
      { id: 'contacts-detail', kind: 'detail', title: 'Contact Details' },
      formView('contacts-form', 'Add / Edit Contact'),
    ],
    standardActions('contacts'),
  ),
};

/** The shipped sample templates (no-code-app-builder.md §7). */
export const APP_TEMPLATES: AppTemplate[] = [
  expenseTracker,
  projectDashboard,
  inventoryManager,
  contactDirectory,
];

/** Template ids, for galleries and MCP tooling. */
export function appTemplateIds(): string[] {
  return APP_TEMPLATES.map((t) => t.id);
}

/** Look up a template by id; undefined when unknown. */
export function getAppTemplate(id: string): AppTemplate | undefined {
  return APP_TEMPLATES.find((t) => t.id === id);
}
