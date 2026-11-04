/**
 * AI app generation flow (AI-GENERATED APP PATTERN, user spec 2026-10-18).
 *
 *   chat prompt -> routePrompt -> generated React source -> ArtifactSpec
 *
 * INTENT ROUTING (user spec 2026-10-18): the chat identifies prompt intent
 * and routes (canonical router: agent/intentRouter.ts):
 *   (a) APP GENERATION prompts -> generate a React-only app here (MCP is
 *       the backend; no Python, no backend code).
 *   (b) DATA ANALYSIS / VISUALIZATION prompts -> NOT an app; the prompt is
 *       routed to the data-analysis component (AI generates Python from the
 *       data schema + intent, executes deterministically, produces a
 *       Chart.js visual). generateAndSaveArtifact returns { routed:
 *       'analysis' } for these so the UI can hand off instead of building
 *       an app.
 *   (c) Ambiguous prompts -> { routed: 'unknown' } with the router's
 *       human-in-the-loop question; the UI asks the user to pick "Build an
 *       app" or "Analyze" (or a template) and retries with a forced
 *       template.
 *   (d) Plain conversation -> { routed: 'not-artifact' }; normal chat
 *       handles it, nothing is generated.
 *
 * AppGenerator is pluggable: the product ships TemplateAppGenerator, a
 * deterministic template-based generator covering the common patterns
 * (sortable/filterable data table, chart dashboard, data-entry form) so
 * the flow works end-to-end TODAY without any model. Freeform React
 * generation needs an LLM: implement AppGenerator against a ModelBackend
 * (packages/service/src/agent/types.ts) and pass it in — the interface
 * accepts that later without rework. (Be honest: templates cover patterns,
 * not arbitrary apps; anything outside the three patterns needs the LLM
 * generator.)
 *
 * Generated source is plain JavaScript defining `function App()` with
 * React.createElement only (no JSX — the sandboxed iframe has no build
 * step). It receives (React, h, useState, useEffect, useRef, mcp) and may
 * ONLY touch data through `mcp.call(tool, args)` /
 * `mcp.subscribe(events, sheet, handler)` (see bridge.ts).
 */

import type { McpCallFn } from './bridge.js';
import { hasExplicitNativeChartIntent, routePrompt } from '../agent/intentRouter.js';
import {
  ARTIFACT_SPEC_VERSION,
  newArtifactId,
  validateArtifactSpec,
  type ArtifactColumn,
  type ArtifactColumnType,
  type ArtifactSpec,
  type ArtifactTemplate,
} from './spec.js';

// ---------------------------------------------------------------------------
// Intent routing
// ---------------------------------------------------------------------------
//
// The canonical chat intent router lives in ../agent/intentRouter.ts (the
// user's INTENT ROUTING spec, 2026-10-18): app-generation prompts route to
// 'app', data-analysis/visualization prompts route to 'analysis', plain
// chat goes to 'conversation', and ambiguous prompts come back as
// 'disambiguate' with the human-in-the-loop question. This module consumes
// that router — it does not reimplement it.

/** Pick the closest built-in template for an app prompt. */
export function detectTemplate(prompt: string): AppTemplateKind {
  const t = prompt.toLowerCase();
  if (/\bform\b|data entry|add (a )?row|\binput\b|enter data/.test(t)) return 'data-entry-form';
  if (/\bchart\b|\bgraph\b|\bplot\b|\bdashboard\b|\bvisual\b|kpi/.test(t)) return 'chart-dashboard';
  return 'data-table';
}

// ---------------------------------------------------------------------------
// Generator interface
// ---------------------------------------------------------------------------

export type AppTemplateKind = 'data-table' | 'chart-dashboard' | 'data-entry-form';

export const APP_TEMPLATE_KINDS: readonly AppTemplateKind[] = [
  'data-table',
  'chart-dashboard',
  'data-entry-form',
];

export interface AppGenerationInput {
  prompt: string;
  sheet: string;
  binding: {
    startRow: number;
    startCol: number;
    endRow: number;
    endCol: number;
    hasHeaderRow: boolean;
  };
  columns: ArtifactColumn[];
  template: AppTemplateKind;
  /**
   * #154: the bound sheet's actual cell values (the get_results matrix for
   * the binding range). The code-gen model previously received only column
   * NAMES + types — no values and no layout semantics — so for any figure
   * the user asked for it had to guess literals or invent a lookup (the
   * ProfitPulse app fuzzy-matched column-A labels and took column B, so
   * 'Total Revenue' -> 0 and 'Gross Profit' -> the 2012 value, not a total).
   * Values let the model see which row is which measure, which columns are
   * years, and what the true numbers are. Optional: generators that do not
   * need values (templates) ignore it.
   */
  values?: unknown[][];
}

export interface AppGenerationOutput {
  /** Plain-JS source defining `function App()`. */
  source: string;
  template: ArtifactTemplate;
  /**
   * Raw model-provided app name, when the generator asked the model for one
   * (LlmAppGenerator's dedicated naming call). Absent for template
   * generation and when naming failed — generateAndSaveArtifact then falls
   * back to the prompt-derived name. Cleaned there, never trusted raw.
   */
  name?: string;
}

/**
 * Pluggable app generator. The built-in TemplateAppGenerator is
 * deterministic; a future LLM-backed generator implements this same
 * interface (e.g. planning with a ModelBackend and returning the React
 * source it wrote) and drops in with no rework.
 */
export interface AppGenerator {
  readonly name: string;
  generate(input: AppGenerationInput): Promise<AppGenerationOutput>;
}

// ---------------------------------------------------------------------------
// Template-based generator (works today, no model)
// ---------------------------------------------------------------------------

/**
 * Escape a value for embedding in a <script> inside iframe srcDoc.
 * The one hard rule: the source must never contain "</script>".
 */
function safeSource(src: string): string {
  if (src.includes('</script')) {
    throw new Error('generated source must not contain "</script"');
  }
  return src;
}

function bindingPrelude(input: AppGenerationInput): string {
  const binding = {
    sheet: input.sheet,
    startRow: input.binding.startRow,
    startCol: input.binding.startCol,
    endRow: input.binding.endRow,
    endCol: input.binding.endCol,
    columns: input.columns.map((c) => ({ name: c.name, type: c.type, index: c.index })),
  };
  return 'var BINDING = ' + JSON.stringify(binding) + ';\n';
}

/**
 * Shared loader snippet: reads the bound range through the MCP bridge and
 * splits header/data rows. Every template embeds this plus its own
 * `mcp.subscribe(['cells_changed'], sheet, reload)` hook so sheet edits
 * re-render the app live (two-way binding, sheet -> app).
 */
const LOADER_SNIPPET = [
  'async function loadData() {',
  '  try {',
  '    var res = await mcp.call(\'read_cells\', {',
  '      sheet: BINDING.sheet,',
  '      startRow: BINDING.startRow,',
  '      startCol: BINDING.startCol,',
  '      endRow: BINDING.endRow,',
  '      endCol: BINDING.endCol',
  '    });',
  '    var cells = (res && res.cells) || [];',
  '    return { header: cells[0] || [], rows: cells.slice(1), error: \'\' };',
  '  } catch (e) {',
  '    return { header: [], rows: [], error: \'Load failed: \' + (e && e.message || e) };',
  '  }',
  '}',
  '',
].join('\n');

// Phase 1 design system: templates style with DaisyUI/Tailwind classes
// (the iframe stylesheet) instead of inline style objects, so template
// apps look identical to LLM apps. Inline style survives ONLY for
// data-driven values; chart bar geometry/colors are SVG attributes.

function dataTableTemplate(): string {
  return [
    LOADER_SNIPPET,
    'function App() {',
    '  var st = useState({ header: [], rows: [], error: \'\' });',
    '  var data = st[0], setData = st[1];',
    '  var sortSt = useState({ col: -1, dir: 1 });',
    '  var sort = sortSt[0], setSort = sortSt[1];',
    '  var filterSt = useState(\'\');',
    '  var filter = filterSt[0], setFilter = filterSt[1];',
    '  var editSt = useState(null);',
    '  var editing = editSt[0], setEditing = editSt[1];',
    '',
    '  async function reload() { setData(await loadData()); }',
    '  useEffect(function () {',
    '    reload();',
    '    // Live binding: re-read whenever the sheet changes.',
    '    var unsub = mcp.subscribe([\'cells_changed\'], BINDING.sheet, function () { reload(); });',
    '    return unsub;',
    '  }, []);',
    '',
    '  function onSort(col) {',
    '    setSort(sort.col === col ? { col: col, dir: -sort.dir } : { col: col, dir: 1 });',
    '  }',
    '  function cellText(v) { return v === null || v === undefined ? \'\' : String(v); }',
    '  var q = filter.trim().toLowerCase();',
    '  var shown = data.rows.filter(function (row) {',
    '    return q === \'\' || row.some(function (v) { return cellText(v).toLowerCase().indexOf(q) >= 0; });',
    '  });',
    '  if (sort.col >= 0) {',
    '    shown = shown.slice().sort(function (a, b) {',
    '      var va = a[sort.col], vb = b[sort.col];',
    '      var na = parseFloat(va), nb = parseFloat(vb);',
    '      var cmp = (!isNaN(na) && !isNaN(nb)) ? (na - nb)',
    '        : cellText(va).localeCompare(cellText(vb));',
    '      return cmp * sort.dir;',
    '    });',
    '  }',
    '',
    '  async function commitEdit(r, c, value) {',
    '    try {',
    '      await mcp.call(\'write_cells\', { cells: [{',
    '        sheet: BINDING.sheet,',
    '        row: BINDING.startRow + 1 + r,',
    '        col: BINDING.startCol + c,',
    '        value: value',
    '      }] });',
    '      setEditing(null);',
    '      // The write fires cells_changed; the subscription reloads us.',
    '    } catch (e) { setData({ header: data.header, rows: data.rows, error: \'Write failed: \' + (e && e.message || e) }); }',
    '  }',
    '',
    '  var headCells = data.header.map(function (hc, c) {',
    '    var arrow = sort.col === c ? (sort.dir === 1 ? \' ▲\' : \' ▼\') : \'\';',
    '    return h(\'th\', { key: c, className: \'cursor-pointer text-left border border-base-300\', onClick: function () { onSort(c); }, title: \'Click to sort\' }, cellText(hc) + arrow);',
    '  });',
    '  var bodyRows = shown.map(function (row, r) {',
    '    var tds = data.header.map(function (_, c) {',
    '      var isEd = editing && editing.r === r && editing.c === c;',
    '      if (isEd) {',
    '        return h(\'td\', { key: c, className: \'border border-base-300\' },',
    '          h(\'input\', {',
    '            className: \'input w-full\', autoFocus: true, defaultValue: cellText(row[c]),',
    '            onBlur: function (e) { commitEdit(r, c, e.target.value); },',
    '            onKeyDown: function (e) {',
    '              if (e.key === \'Enter\') commitEdit(r, c, e.target.value);',
    '              if (e.key === \'Escape\') setEditing(null);',
    '            }',
    '          }));',
    '      }',
    '      return h(\'td\', {',
    '        key: c, className: \'border border-base-300\', title: \'Double-click to edit\',',
    '        onDoubleClick: function () { setEditing({ r: r, c: c }); }',
    '      }, cellText(row[c]));',
    '    });',
    '    return h(\'tr\', { key: r }, tds);',
    '  });',
    '',
    '  return h(\'div\', { className: \'p-3 text-sm text-base-content\' },',
    '    data.error ? h(\'div\', { className: \'alert alert-error mb-2\' }, data.error) : null,',
    '    h(\'div\', { className: \'mb-2 flex items-center gap-2\' },',
    '      h(\'input\', {',
    '        className: \'input w-full max-w-60\',',
    '        placeholder: \'Filter rows…\', value: filter,',
    '        onChange: function (e) { setFilter(e.target.value); }',
    '      }),',
    '      h(\'span\', { className: \'text-base-content opacity-70\' }, shown.length + \' of \' + data.rows.length + \' rows\'),',
    '    ),',
    '    h(\'table\', { className: \'table w-full\' },',
    '      h(\'thead\', null, h(\'tr\', null, headCells)),',
    '      h(\'tbody\', null, bodyRows)',
    '    ),',
    '    h(\'div\', { className: \'mt-2 text-xs opacity-60\' },',
    '      \'Click a column header to sort. Double-click a cell to edit it back into the sheet.\')',
    '  );',
    '}',
  ].join('\n');
}

function chartDashboardTemplate(): string {
  return [
    LOADER_SNIPPET,
    'function num(v) { var n = parseFloat(v); return isNaN(n) ? null : n; }',
    'function App() {',
    '  var st = useState({ header: [], rows: [], error: \'\' });',
    '  var data = st[0], setData = st[1];',
    '',
    '  async function reload() { setData(await loadData()); }',
    '  useEffect(function () {',
    '    reload();',
    '    var unsub = mcp.subscribe([\'cells_changed\'], BINDING.sheet, function () { reload(); });',
    '    return unsub;',
    '  }, []);',
    '',
    '  // First text column = labels, first numeric column = values.',
    '  var labelCol = 0, valueCol = -1;',
    '  for (var c = 0; c < data.header.length; c++) {',
    '    var numeric = data.rows.some(function (row) { return num(row[c]) !== null; });',
    '    if (numeric && valueCol < 0) valueCol = c;',
    '  }',
    '  var pairs = valueCol >= 0 ? data.rows.map(function (row) {',
    '    return { label: String(row[labelCol] === null || row[labelCol] === undefined ? \'\' : row[labelCol]), value: num(row[valueCol]) || 0 };',
    '  }) : [];',
    '  var max = pairs.reduce(function (m, p) { return Math.max(m, p.value); }, 0) || 1;',
    '  var W = 560, H = 260, pad = 8, barGap = 4;',
    '  var bw = pairs.length > 0 ? (W - pad * 2) / pairs.length : 0;',
    '  var bars = pairs.map(function (p, i) {',
    '    var bh = Math.max(2, (p.value / max) * (H - 60));',
    '    var x = pad + i * bw + barGap / 2;',
    '    return h(\'g\', { key: i },',
    '      h(\'rect\', { x: x, y: H - 30 - bh, width: Math.max(2, bw - barGap), height: bh, fill: \'#4F81BD\' }, null),',
    '      h(\'text\', { x: x + (bw - barGap) / 2, y: H - 12, fontSize: 10, textAnchor: \'middle\', fill: \'currentColor\', opacity: 0.7 },',
    '        p.label.length > 12 ? p.label.slice(0, 11) + \'…\' : p.label),',
    '      h(\'text\', { x: x + (bw - barGap) / 2, y: H - 36 - bh, fontSize: 10, textAnchor: \'middle\', fill: \'currentColor\' }, String(p.value))',
    '    );',
    '  });',
    '  var total = pairs.reduce(function (s, p) { return s + p.value; }, 0);',
    '  var avg = pairs.length > 0 ? total / pairs.length : 0;',
    '',
    '  return h(\'div\', { className: \'p-3 text-sm text-base-content\' },',
    '    data.error ? h(\'div\', { className: \'alert alert-error mb-2\' }, data.error) : null,',
    '    h(\'div\', { className: \'mb-2 flex items-center gap-2\' },',
    '      h(\'div\', { className: \'text-xs text-base-content opacity-70\' }, \'Total: \', h(\'b\', null, String(Math.round(total * 100) / 100))),',
    '      h(\'div\', { className: \'text-xs text-base-content opacity-70\' }, \'Average: \', h(\'b\', null, String(Math.round(avg * 100) / 100))),',
    '      h(\'div\', { className: \'text-xs text-base-content opacity-70\' }, \'Rows: \', h(\'b\', null, String(pairs.length)))',
    '    ),',
    '    h(\'svg\', { width: W, height: H, className: \'rounded-box border border-base-300 bg-base-100\' }, bars),',
    '    h(\'div\', { className: \'mt-2 text-xs opacity-60\' },',
    '      \'Live: editing the sheet re-renders this dashboard through the MCP subscription.\')',
    '  );',
    '}',
  ].join('\n');
}

function dataEntryFormTemplate(input: AppGenerationInput): string {
  const fields = input.columns
    .map(
      (c) =>
        `  fields.push({ name: ${JSON.stringify(c.name)}, type: ${JSON.stringify(c.type)}, index: ${c.index} });`,
    )
    .join('\n');
  return [
    LOADER_SNIPPET,
    'var FIELDS = [];',
    fields,
    'function emptyForm() { var o = {}; FIELDS.forEach(function (f) { o[f.name] = \'\'; }); return o; }',
    'function App() {',
    '  var st = useState({ header: [], rows: [], error: \'\' });',
    '  var data = st[0], setData = st[1];',
    '  var formSt = useState(emptyForm());',
    '  var form = formSt[0], setForm = formSt[1];',
    '  var msgSt = useState(\'\');',
    '  var msg = msgSt[0], setMsg = msgSt[1];',
    '',
    '  async function reload() { setData(await loadData()); }',
    '  useEffect(function () {',
    '    reload();',
    '    var unsub = mcp.subscribe([\'cells_changed\'], BINDING.sheet, function () { reload(); });',
    '    return unsub;',
    '  }, []);',
    '',
    '  function setField(name, value) {',
    '    var next = Object.assign({}, form); next[name] = value; setForm(next);',
    '  }',
    '  function coerce(f, raw) {',
    '    if (raw === \'\') return null;',
    '    if (f.type === \'numeric\') { var n = parseFloat(raw); return isNaN(n) ? raw : n; }',
    '    if (f.type === \'boolean\') return /^(true|yes|1)$/i.test(raw);',
    '    return raw;',
    '  }',
    '  async function submit() {',
    '    try {',
    '      var row = BINDING.startRow + 1 + data.rows.length;',
    '      var cells = FIELDS.map(function (f) {',
    '        return { sheet: BINDING.sheet, row: row, col: BINDING.startCol + f.index, value: coerce(f, form[f.name]) };',
    '      });',
    '      await mcp.call(\'write_cells\', { cells: cells });',
    '      setForm(emptyForm());',
    '      setMsg(\'Row added.\');',
    '    } catch (e) { setMsg(\'Add failed: \' + (e && e.message || e)); }',
    '  }',
    '',
    '  var inputs = FIELDS.map(function (f) {',
    '    return h(\'div\', { key: f.name, className: \'mb-2.5\' },',
    '      h(\'label\', { className: \'mb-1 block text-xs text-base-content opacity-70\' }, f.name + (f.type !== \'text\' ? \' (\' + f.type + \')\' : \'\')),',
    '      h(\'input\', {',
    '        className: \'input w-full\', value: form[f.name],',
    '        type: f.type === \'numeric\' ? \'number\' : \'text\',',
    '        onChange: function (e) { setField(f.name, e.target.value); }',
    '      })',
    '    );',
    '  });',
    '',
    '  return h(\'div\', { className: \'p-3 text-sm text-base-content\' },',
    '    data.error ? h(\'div\', { className: \'alert alert-error mb-2\' }, data.error) : null,',
    '    h(\'h3\', { className: \'mb-3 text-lg font-bold\' }, \'Add row\' + (data.rows.length ? \' (\' + data.rows.length + \' rows so far)\' : \'\')),',
    '    inputs,',
    '    h(\'div\', { className: \'mb-2 flex items-center gap-2\' },',
    '      h(\'button\', { className: \'btn btn-primary\', onClick: submit }, \'Add row\'),',
    '      h(\'button\', { className: \'btn\', onClick: function () { setForm(emptyForm()); setMsg(\'\'); } }, \'Clear\')',
    '    ),',
    '    msg ? h(\'div\', { className: \'text-xs text-info\' }, msg) : null,',
    '    h(\'div\', { className: \'mt-2 text-xs opacity-60\' },',
    '      \'Submitted rows write straight into the sheet via MCP; the grid updates live.\')',
    '  );',
    '}',
  ].join('\n');
}

export class TemplateAppGenerator implements AppGenerator {
  readonly name = 'template-v1';

  async generate(input: AppGenerationInput): Promise<AppGenerationOutput> {
    const body =
      input.template === 'chart-dashboard'
        ? chartDashboardTemplate()
        : input.template === 'data-entry-form'
          ? dataEntryFormTemplate(input)
          : dataTableTemplate();
    const source = safeSource(bindingPrelude(input) + body);
    return { source, template: input.template };
  }
}

// ---------------------------------------------------------------------------
// Schema inference from MCP reads
// ---------------------------------------------------------------------------

function inferColumnType(values: unknown[]): ArtifactColumnType {
  let numeric = 0;
  let date = 0;
  let bool = 0;
  let total = 0;
  for (const v of values) {
    if (v === null || v === undefined || v === '') continue;
    total++;
    if (typeof v === 'boolean') bool++;
    else if (typeof v === 'number') numeric++;
    else if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v)) date++;
  }
  if (total === 0) return 'text';
  if (bool === total) return 'boolean';
  if (numeric / total >= 0.8) return 'numeric';
  if (date / total >= 0.5) return 'date';
  return 'text';
}

export interface InferredSchema {
  binding: {
    startRow: number;
    startCol: number;
    endRow: number;
    endCol: number;
    hasHeaderRow: boolean;
  };
  columns: ArtifactColumn[];
}

/**
 * Infer the app's data schema from a `get_results` cell matrix (used
 * range, origin at row 0 / col 0). First row is the header; column types
 * come from sampling the data rows.
 */
export function inferSchema(cells: unknown[][]): InferredSchema {
  const rows = cells.length;
  const cols = cells.reduce((m, r) => Math.max(m, r.length), 0);
  const headerRow = rows > 0 ? cells[0] : [];
  const columns: ArtifactColumn[] = [];
  for (let c = 0; c < cols; c++) {
    const rawName = headerRow[c];
    const name =
      rawName === null || rawName === undefined || String(rawName).trim() === ''
        ? `Column ${c + 1}`
        : String(rawName);
    const sample = cells.slice(1, 21).map((r) => r[c]);
    columns.push({ name, type: inferColumnType(sample), index: c });
  }
  return {
    binding: {
      startRow: 0,
      startCol: 0,
      endRow: Math.max(0, rows - 1),
      endCol: Math.max(0, cols - 1),
      hasHeaderRow: true,
    },
    columns,
  };
}

// ---------------------------------------------------------------------------
// Generation flow: prompt -> intent -> source -> artifact
// ---------------------------------------------------------------------------

/** Minimal store surface generateAndSaveArtifact needs. */
export interface ArtifactSink {
  add(spec: ArtifactSpec): void;
}

export interface GenerateArtifactDeps {
  callTool: McpCallFn;
  store: ArtifactSink;
  generator?: AppGenerator;
  /** Identity stamped on the artifact (ai-agent.md §3). */
  principal?: string;
  now?: () => number;
  /**
   * Force a template. Used when the routing decision was already made
   * upstream (the chat router dispatched route 'app', or the user picked
   * "Build an app" from disambiguation): skips re-routing entirely.
   */
  template?: AppTemplateKind;
}

export interface GenerateArtifactInput {
  prompt: string;
  sheet: string;
}

export type GenerateArtifactResult =
  | { routed: 'app'; spec: ArtifactSpec }
  | { routed: 'analysis'; reason: string }
  | { routed: 'not-artifact'; reason: string }
  | {
      routed: 'unknown';
      reason: string;
      question: string;
      options: readonly string[];
      suggestedTemplate: AppTemplateKind;
    };

const ANALYSIS_HANDOFF =
  'This looks like a data-analysis / visualization request, so it routes to the data-analysis ' +
  'component (AI generates Python from the data schema + intent, executes it deterministically, ' +
  'and produces a Chart.js visual) — not to app generation.';

/**
 * W3 hand-back: an explicit native-chart request ("add a column chart …
 * to the Sales sheet") can NEVER be satisfied by app generation — an app
 * is not a chart in the sheet. Building one anyway and reporting success
 * was the case-4 dead end. The artifact lane hands the request back with
 * the answerable path named instead: the chat agent's native-chart route
 * (create_chart). This applies even when a template was forced upstream
 * (the disambiguation "Build an app" answer for a chart prompt, or the
 * gateway lane's unconditional template) — a forced template is a routing
 * decision made elsewhere, not evidence the prompt is an app request.
 */
export const NATIVE_CHART_HANDOFF =
  'This is a native-chart request: you asked for a chart in the sheet itself. ' +
  'App generation cannot create a chart in the sheet, so no app was built. ' +
  'Ask the chat for the chart instead (e.g. "add a column chart of Month vs Revenue ' +
  'to the Sales sheet") and the agent will create the native chart in the sheet.';

/**
 * Thrown when the sheet named for generation does not exist in the
 * workbook (#64). This is a user-caused bad reference, not a server
 * failure: HTTP layers map it to a clean 4xx with this plain-language
 * message, never a 502.
 */
export class SheetNotFoundError extends Error {
  readonly sheet: string;
  constructor(sheet: string) {
    super(`Sheet "${sheet}" does not exist in this workbook.`);
    this.name = 'SheetNotFoundError';
    this.sheet = sheet;
  }
}

/**
 * Full flow: route the prompt, read the sheet schema through MCP,
 * generate the React source, validate, and persist the chat artifact.
 * All data access goes through the injected MCP callTool — there is no
 * direct engine or storage path.
 */

/**
 * Clean a model-provided app name into a displayable short name: first line
 * only (models ramble past it), no code fences, no surrounding quotes or
 * markdown bullets, single-spaced, capped at 60 chars (the gallery/lane
 * layout cap — same cap the prompt fallback uses). Returns null when
 * nothing usable remains, so the caller falls back.
 */
export function cleanArtifactName(raw: string | undefined): string | null {
  if (!raw) return null;
  let line = raw.split('\n')[0] ?? '';
  // Strip fence markers only — never a following word (an earlier
  // /```[a-z]*/ form ate the name's first word: '```Sales' matched as
  // fence + language tag and left 'Dashboard').
  line = line.replace(/```/g, '');
  line = line.replace(/^["'`#>*\-\s]+/g, '');
  line = line.replace(/["'`.\s]+$/g, '');
  line = line.replace(/\s+/g, ' ').trim();
  if (line === '') return null;
  if (line.length > 60) line = line.slice(0, 57) + '…';
  return line;
}

/**
 * Prompt-derived fallback name — the pre-LLM-naming behavior, kept verbatim:
 * the prompt itself, truncated at 60 chars. Used when the generator did not
 * provide a model name (template generation) or naming failed.
 */
export function fallbackArtifactName(prompt: string): string {
  return prompt.length > 60 ? prompt.slice(0, 57) + '…' : prompt;
}

export async function generateAndSaveArtifact(
  input: GenerateArtifactInput,
  deps: GenerateArtifactDeps,
): Promise<GenerateArtifactResult> {
  // W3: an explicit native-chart request hands back BEFORE any routing
  // or forced-template generation (see NATIVE_CHART_HANDOFF) — the app
  // lane must never silently build an app for it and call that success.
  if (hasExplicitNativeChartIntent(input.prompt)) {
    return { routed: 'not-artifact', reason: NATIVE_CHART_HANDOFF };
  }
  // When the caller forces a template, the routing decision was already
  // made upstream (e.g. the chat router dispatched route 'app', or the
  // user picked "Build an app" from disambiguation) — skip re-routing.
  if (!deps.template) {
    // Canonical intent routing (agent/intentRouter.ts).
    const decision = routePrompt(input.prompt, { sheet: input.sheet });
    if (decision.route === 'analysis') {
      return { routed: 'analysis', reason: ANALYSIS_HANDOFF };
    }
    if (decision.route === 'chart') {
      return { routed: 'not-artifact', reason: NATIVE_CHART_HANDOFF };
    }
    if (decision.route === 'conversation') {
      return {
        routed: 'not-artifact',
        reason:
          'This prompt is not an app or analysis request, so there is nothing to generate. ' +
          'Ask the chat to build an app (e.g. "build me a sortable app for …") to create one.',
      };
    }
    if (decision.route === 'disambiguate') {
      return {
        routed: 'unknown',
        reason: decision.question,
        question: decision.question,
        options: decision.options,
        suggestedTemplate: detectTemplate(input.prompt),
      };
    }
  }
  const template = deps.template ?? detectTemplate(input.prompt);
  const generator = deps.generator ?? new TemplateAppGenerator();
  const now = deps.now ?? Date.now;
  const principal = deps.principal ?? 'unknown';

  // Existence check (#64): get_results fails SOFT for an unknown sheet
  // (empty cells), so without this check a missing sheet travelled
  // downstream as a generic generation failure and the gateway mapped
  // it to a 502. Prove absence up front via list_sheets and throw the
  // typed error HTTP layers map to a 4xx. FAIL-OPEN: when the tool
  // surface cannot list sheets (older or stub MCP servers), the legacy
  // flow below runs exactly as before.
  try {
    const listed = (await deps.callTool('list_sheets', {})) as
      | { sheets?: unknown }
      | undefined;
    const names = Array.isArray(listed?.sheets) ? (listed.sheets as unknown[]) : undefined;
    if (names && !names.includes(input.sheet)) {
      throw new SheetNotFoundError(input.sheet);
    }
  } catch (e) {
    if (e instanceof SheetNotFoundError) throw e;
    // list_sheets unavailable: proceed with the legacy flow.
  }

  // Schema discovery through MCP (read-only).
  const res = (await deps.callTool('get_results', { sheet: input.sheet })) as {
    cells?: unknown[][];
  };
  const cells = Array.isArray(res?.cells) ? (res.cells as unknown[][]) : [];
  if (cells.length === 0) {
    throw new Error(`Sheet "${input.sheet}" is empty — there is no data to build the app from.`);
  }
  const schema = inferSchema(cells);

  const out = await generator.generate({
    prompt: input.prompt,
    sheet: input.sheet,
    binding: schema.binding,
    columns: schema.columns,
    template,
    // #154: pass the actual values, not just the schema — the code-gen
    // model must see the numbers it is asked to display.
    values: cells,
  });

  // Displayed name: the model-provided name when the generator asked the
  // model for one (cleaned here, never trusted raw); otherwise the
  // prompt-derived fallback (the pre-LLM-naming behavior, kept verbatim).
  // Naming failure must never fail generation — the fallback covers it.
  const name = cleanArtifactName(out.name) ?? fallbackArtifactName(input.prompt);

  const spec: ArtifactSpec = {
    id: newArtifactId(),
    version: ARTIFACT_SPEC_VERSION,
    kind: 'react-app',
    name,
    prompt: input.prompt,
    template: out.template,
    source: out.source,
    binding: {
      sheet: input.sheet,
      ...schema.binding,
      columns: schema.columns,
    },
    principal,
    createdAt: now(),
    updatedAt: now(),
  };
  const validated = validateArtifactSpec(spec);
  if (!validated.ok) {
    throw new Error(`generated artifact failed validation: ${validated.errors.join('; ')}`);
  }
  deps.store.add(validated.spec);
  return { routed: 'app', spec: validated.spec };
}
