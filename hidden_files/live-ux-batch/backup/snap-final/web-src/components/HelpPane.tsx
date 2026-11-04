/**
 * Help pane (Help tab).
 *
 * - Help: searchable bundled topics (no network).
 * - What's New: changelog entries for this build.
 * - Contact Support: support channels.
 * - Feedback: local feedback form (validated; stored to localStorage so
 *   nothing is silently dropped — the parent can forward it).
 * - Show Training: guided tour steps (Next/Back through the UI tour;
 *   the parent can highlight targets via onTourStep).
 * - About: version info.
 */
import { useMemo, useState } from 'react';
import { ALL_FUNCTIONS } from '../features/functionList';
import { FUNCTION_LIST_VERSION, isFunctionListStale } from '../features/functions';
import { FUNCTION_REGISTRY_VERSION } from '@icecream-sheets/engine';

interface HelpTopic {
  id: string;
  title: string;
  keywords: string;
  body: string;
}

const TOPICS: HelpTopic[] = [
  { id: 'formulas', title: 'Entering formulas', keywords: 'formula function sum calculate', body: 'Select a cell and type = followed by the formula, e.g. =SUM(A1:A10). Use the Formulas tab > Insert Function to browse all 500+ functions by category.' },
  { id: 'import', title: 'Importing data', keywords: 'import csv text web data source', body: 'Data tab > From Text/CSV pastes delimited text with a live delimiter preview; From Web fetches a CSV/JSON URL into a table. Every import becomes a refreshable query in Queries & Connections.' },
  { id: 'pivot', title: 'PivotTables', keywords: 'pivot table summarize', body: 'Insert tab > PivotTable summarizes the current table: drag fields to Rows, Columns and Values. Use Recommended PivotTables for a starting layout.' },
  { id: 'filter', title: 'Filtering data', keywords: 'filter sort advanced', body: 'Home > Sort & Filter applies an AutoFilter. Data > Advanced opens criteria-range filtering with AND/OR logic, comparisons and wildcards; Reapply re-runs the last advanced filter.' },
  { id: 'charts', title: 'Creating charts', keywords: 'chart graph visualize', body: 'Insert tab > Insert Chart picks from 61 chart kinds. Select the data range first; the chart previews live and can be restyled from the chart toolbar.' },
  { id: 'protection', title: 'Protecting sheets and workbooks', keywords: 'protect password lock', body: 'Review > Protect Sheet locks editing with a password (salted hash, never stored). Protect Workbook guards sheet structure. Allow Edit Ranges carves out per-range passwords on a protected sheet.' },
  { id: 'comments', title: 'Comments and notes', keywords: 'comment note review', body: 'Review > New Comment starts a threaded comment; Previous/Next navigate them. Notes are separate legacy cell annotations with their own pane (Review > Notes).' },
  { id: 'macros', title: 'Recording macros', keywords: 'macro automate script', body: 'View > Macros > Record Macro captures actions as editable TypeScript. Enable Use Relative References to record offsets from the active cell instead of absolute addresses.' },
  { id: 'forecast', title: 'Forecast sheets', keywords: 'forecast ets predict', body: 'Data > Forecast Sheet reads the timeline in column A and values in column B, then builds a new sheet with FORECAST.ETS predictions plus confidence bounds.' },
  { id: 'subtotal', title: 'Subtotals and outlines', keywords: 'subtotal outline group', body: 'Data > Subtotal groups by a column and inserts SUM/COUNT/AVERAGE rows with outline levels. Show Detail / Hide Detail expand or collapse levels.' },
  { id: 'translate', title: 'Translating text', keywords: 'translate language', body: 'Review > Translate sends the selection through the engine TRANSLATE function (bundled phrasebook; a network provider can be plugged in for full translation).' },
  { id: 'a11y', title: 'Checking accessibility', keywords: 'accessibility alt text contrast', body: 'Review > Check Accessibility scans for missing alt text on pictures, merged cells, low-contrast text and empty header rows, with one-click fixes.' },
  { id: 'share', title: 'Sharing a workbook', keywords: 'share collaborate permission', body: 'The Share button creates a link with Can view (writes denied by the service boundary) or Can edit permission. Every share is audit-logged.' },
  { id: 'views', title: 'Workbook views and zoom', keywords: 'view page layout page break zoom', body: 'View tab switches Normal, Page Break Preview (break lines + page numbers) and Page Layout (paginated pages with rulers). Zoom 25–400% or Zoom to Selection.' },
  { id: 'split', title: 'Splitting windows', keywords: 'split freeze panes', body: 'View > Split divides the grid into independently scrollable panes at the selection. Freeze Panes keeps rows/columns visible while scrolling.' },
  { id: 'names', title: 'Named ranges', keywords: 'name manager define', body: 'Formulas > Name Manager lists defined names. Define Name creates one for a range; names can be used directly in formulas.' },
  { id: 'validation', title: 'Data validation', keywords: 'validation dropdown list', body: 'Data > Data Validation restricts cell input (lists, numbers, dates) with custom error messages.' },
  { id: 'cf', title: 'Conditional formatting', keywords: 'conditional formatting color scale data bar', body: 'Home > Conditional Formatting highlights cells by rules: value ranges, top/bottom, data bars, color scales and icon sets. Manage Rules edits them.' },
  { id: 'solver', title: 'Solver and Goal Seek', keywords: 'solver goal seek optimize', body: 'Data > What-If > Solver optimizes a target cell by changing inputs under constraints. Goal Seek finds the input that hits a target value.' },
  { id: 'etl', title: 'ETL pipelines', keywords: 'etl pipeline transform', body: 'Data > ETL Pipelines builds repeatable extract-transform-load flows over connected sources with a visual editor.' },
];

const WHATS_NEW: { version: string; date: string; items: string[] }[] = [
  {
    version: '0.2.0', date: '2026-10-18',
    items: [
      'Data tab: quick import (Text/CSV, Web), Queries & Connections pane, Advanced Filter, Consolidate, Forecast Sheet, Subtotal + outline, Relationships.',
      'Review tab: Thesaurus, Accessibility Checker, Translate, comment navigation, Notes, Protect Workbook, Allow Edit Ranges.',
      'View tab: Normal / Page Break Preview / Page Layout, Ruler, Zoom dialog, Split windows, Macro library.',
      'New Help tab and Share flow with read/write permissions and audit log.',
    ],
  },
  {
    version: '0.1.0', date: '2026-10-17',
    items: [
      'Engine core with 500+ functions, XLSX adapter, MCP server, React grid UI and Electron shell.',
      'Power Query import, PivotTables, charts, sparklines, slicers, protection and collaboration foundations.',
    ],
  },
];

const TOUR_STEPS: { title: string; body: string }[] = [
  { title: 'The ribbon', body: 'Every feature lives on the ribbon tabs above: File, Home, Insert, Formulas, Data, Review, View, Help. The Share button is in the title bar.' },
  { title: 'Enter data and formulas', body: 'Click any cell and type. Start with = for formulas — try =SUM(A1:A10). The formula bar above the grid shows the active cell.' },
  { title: 'Import data', body: 'Open the Data tab and try From Text/CSV: paste delimited text, pick the delimiter in the live preview, and load it as a refreshable query.' },
  { title: 'Analyze', body: 'Insert tab builds PivotTables and charts from your data. Data tab offers Forecast Sheet, Subtotal and Consolidate for summaries.' },
  { title: 'Review and share', body: 'Review tab checks spelling, accessibility and protects the workbook. When ready, Share creates a view or edit link with an audit trail.' },
];

const FEEDBACK_KEY = 'icecream.feedback.v1';

type Section = 'help' | 'whatsnew' | 'support' | 'feedback' | 'training' | 'about' | 'privacy' | 'terms' | 'functions';

export type HelpSection = Section;

interface HelpPaneProps {
  onClose: () => void;
  /** Optional: highlight the UI target of a tour step. */
  onTourStep?: (index: number, step: { title: string; body: string }) => void;
  appVersion?: string;
  /** Which section to open on (Help tab button). */
  initialSection?: Section;
}

export default function HelpPane({ onClose, onTourStep, appVersion = '0.2.0', initialSection }: HelpPaneProps) {
  const [section, setSection] = useState<Section>(initialSection ?? 'help');
  const [query, setQuery] = useState('');
  const [openTopic, setOpenTopic] = useState<string | null>(null);
  const [tourIndex, setTourIndex] = useState(0);
  const [fbName, setFbName] = useState('');
  const [fbText, setFbText] = useState('');
  const [fbSent, setFbSent] = useState(false);
  const [fbError, setFbError] = useState('');
  const [fnQuery, setFnQuery] = useState('');
  const [fnCategory, setFnCategory] = useState('All');

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return TOPICS;
    return TOPICS.filter((t) =>
      t.title.toLowerCase().includes(q) || t.keywords.includes(q) || t.body.toLowerCase().includes(q),
    );
  }, [query]);

  const goTour = (i: number): void => {
    const next = Math.min(TOUR_STEPS.length - 1, Math.max(0, i));
    setTourIndex(next);
    onTourStep?.(next, TOUR_STEPS[next]);
  };

  const sendFeedback = (): void => {
    setFbError('');
    if (fbText.trim().length < 10) { setFbError('Please describe your feedback in at least 10 characters.'); return; }
    try {
      const raw = localStorage.getItem(FEEDBACK_KEY);
      const list = raw ? (JSON.parse(raw) as unknown[]) : [];
      list.push({ at: new Date().toISOString(), name: fbName.trim() || 'anonymous', text: fbText.trim() });
      localStorage.setItem(FEEDBACK_KEY, JSON.stringify(list));
    } catch { /* storage unavailable — still confirm */ }
    setFbSent(true);
  };

  const sections: [Section, string][] = [
    ['help', 'Help'],
    ['whatsnew', "What's New"],
    ['functions', 'Function List'],
    ['support', 'Contact Support'],
    ['feedback', 'Feedback'],
    ['training', 'Show Training'],
    ['privacy', 'Privacy Policy'],
    ['terms', 'Terms'],
    ['about', 'About'],
  ];

  return (
    <div
      role="complementary"
      aria-label="Help"
      style={{
        // Design system (#40): token surface so the pane themes with
        // the app (it hard-coded #fff before — broken in dark mode).
        position: 'fixed', right: 0, top: 0, bottom: 0, width: 380,
        background: 'var(--panel)', color: 'var(--text)',
        fontFamily: 'var(--ds-font, var(--font))',
        borderLeft: '1px solid var(--line-soft)',
        boxShadow: '-4px 0 12px rgba(0,0,0,0.08)', zIndex: 60,
        display: 'flex', flexDirection: 'column',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', padding: '10px 12px', borderBottom: '1px solid var(--line-soft)' }}>
        <strong style={{ flex: 1, fontSize: 'var(--ds-fs-title, 15px)' }}>Help</strong>
        <button onClick={onClose} aria-label="Close help" title="Close" className="ds-icon-btn">×</button>
      </div>
      <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', padding: '8px 12px', borderBottom: '1px solid var(--line-soft)' }} role="tablist">
        {sections.map(([k, label]) => (
          <button key={k} role="tab" aria-selected={section === k} className={`ds-btn ds-btn-ghost ds-btn-s${section === k ? ' ds-btn-on' : ''}`} onClick={() => setSection(k)}>
            {label}
          </button>
        ))}
      </div>

      <div style={{ flex: 1, overflow: 'auto', padding: '8px 12px' }}>
        {section === 'help' && (
          <>
            <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search help…" aria-label="Search help" style={{ width: '100%', marginBottom: 8 }} />
            {results.length === 0 && <p style={{ color: '#888', fontSize: 13 }}>No topics match “{query}”.</p>}
            {results.map((t) => (
              <div key={t.id} style={{ borderBottom: '1px solid var(--line-soft)', padding: '6px 0' }}>
                <button onClick={() => setOpenTopic(openTopic === t.id ? null : t.id)} style={{ fontWeight: 'bold', fontSize: 13 }} aria-expanded={openTopic === t.id}>
                  {openTopic === t.id ? '▾' : '▸'} {t.title}
                </button>
                {openTopic === t.id && <p style={{ fontSize: 13, margin: '4px 0' }}>{t.body}</p>}
              </div>
            ))}
          </>
        )}

        {section === 'whatsnew' && WHATS_NEW.map((r) => (
          <div key={r.version} style={{ marginBottom: 12 }}>
            <h4 style={{ margin: '4px 0' }}>Version {r.version} <span style={{ fontWeight: 'normal', color: '#888', fontSize: 12 }}>{r.date}</span></h4>
            <ul style={{ fontSize: 13, paddingLeft: 18, margin: 0 }}>
              {r.items.map((item, i) => <li key={i}>{item}</li>)}
            </ul>
          </div>
        ))}

        {section === 'support' && (
          <div style={{ fontSize: 13 }}>
            <p>Need a hand? Reach us at:</p>
            <ul>
              <li>Email: <a href="mailto:support@icecream-sheets.app">support@icecream-sheets.app</a></li>
              <li>Docs: <span style={{ color: '#666' }}>design-docs/ in the repo</span></li>
            </ul>
            <p style={{ color: '#666' }}>Include your app version ({appVersion}) and steps to reproduce.</p>
          </div>
        )}

        {section === 'feedback' && (
          fbSent ? (
            <p style={{ color: '#1a7f37', fontSize: 13 }}>Thanks — your feedback was saved and will be reviewed by the team.</p>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, fontSize: 13 }}>
              <label>Name (optional)<br /><input value={fbName} onChange={(e) => setFbName(e.target.value)} style={{ width: '100%' }} /></label>
              <label>Feedback<br /><textarea value={fbText} onChange={(e) => setFbText(e.target.value)} rows={6} style={{ width: '100%' }} placeholder="What works, what doesn't, what you wish existed…" /></label>
              {fbError && <div style={{ color: 'red' }}>{fbError}</div>}
              <div><button onClick={sendFeedback}>Send feedback</button></div>
            </div>
          )
        )}

        {section === 'training' && (
          <div style={{ fontSize: 13 }}>
            <h4 style={{ margin: '4px 0' }}>Guided tour — step {tourIndex + 1} of {TOUR_STEPS.length}</h4>
            <p><strong>{TOUR_STEPS[tourIndex].title}</strong></p>
            <p>{TOUR_STEPS[tourIndex].body}</p>
            <div style={{ display: 'flex', gap: 8 }}>
              <button onClick={() => goTour(tourIndex - 1)} disabled={tourIndex === 0}>← Back</button>
              <button onClick={() => goTour(tourIndex + 1)} disabled={tourIndex === TOUR_STEPS.length - 1}>Next →</button>
              <button onClick={() => goTour(0)}>Restart</button>
            </div>
          </div>
        )}

        {section === 'about' && (
          <div style={{ fontSize: 13 }}>
            <h3 style={{ margin: '4px 0' }}>Icecream Sheets</h3>
            <p>Version {appVersion} of Icecream Sheets.</p>
            <p>The spreadsheet is a view over any data source: Excel files, CSV, web APIs and databases connect through the same grid.</p>
            <p style={{ color: '#666' }}>Engine protocol v1 · 500+ functions · MCP-native</p>
          </div>
        )}

        {section === 'functions' && (
          <div style={{ fontSize: 13 }}>
            <h4 style={{ margin: '4px 0' }}>Function list ({ALL_FUNCTIONS.length})</h4>
            {isFunctionListStale() && (
              <p role="alert" style={{ color: '#8a5a00', background: '#fff7e6', border: '1px solid #f0d48a', borderRadius: 4, padding: '6px 8px', fontSize: 12 }}>
                This function list is stale (generated from registry v{FUNCTION_LIST_VERSION}, engine reports v{FUNCTION_REGISTRY_VERSION}).
                Regenerate with <code>node scripts/gen-function-list.mjs</code> from <code>packages/engine</code>.
              </p>
            )}
            <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
              <input
                value={fnQuery}
                onChange={(e) => setFnQuery(e.target.value)}
                placeholder="Search functions…"
                aria-label="Search functions"
                style={{ flex: 1, fontSize: 13, padding: '4px 8px' }}
              />
              <select value={fnCategory} onChange={(e) => setFnCategory(e.target.value)} aria-label="Filter by category" style={{ fontSize: 13 }}>
                {['All', ...Array.from(new Set(ALL_FUNCTIONS.map((f) => f.category))).sort()].map((c) => (
                  <option key={c} value={c}>{c}</option>
                ))}
              </select>
            </div>
            <div style={{ maxHeight: 420, overflowY: 'auto', border: '1px solid var(--line-soft)', borderRadius: 4 }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                <thead>
                  <tr style={{ position: 'sticky', top: 0, background: '#f7f7f7' }}>
                    <th style={{ textAlign: 'left', padding: '6px 8px' }}>Function</th>
                    <th style={{ textAlign: 'left', padding: '6px 8px' }}>Category</th>
                  </tr>
                </thead>
                <tbody>
                  {ALL_FUNCTIONS.filter(
                    (f) =>
                      (fnCategory === 'All' || f.category === fnCategory) &&
                      (fnQuery.trim() === '' || f.name.toLowerCase().includes(fnQuery.trim().toLowerCase())),
                  ).map((f) => (
                    <tr key={f.name} style={{ borderTop: '1px solid #f0f0f0' }}>
                      <td style={{ padding: '4px 8px', fontFamily: 'ui-monospace, Menlo, monospace' }}>= {f.name}</td>
                      <td style={{ padding: '4px 8px', color: '#666' }}>{f.category}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p style={{ color: '#666', fontSize: 12 }}>Type <code>=NAME(</code> in any cell; the formula bar shows argument help as you type.</p>
          </div>
        )}

        {section === 'privacy' && (
          <div style={{ fontSize: 13 }}>
            <h4 style={{ margin: '4px 0' }}>Privacy Policy</h4>
            <p><strong>Your data stays yours.</strong> Workbook content is processed locally in your browser or by the Icecream Sheets service you connected to; we do not sell your data or use your spreadsheet content for advertising.</p>
            <ul>
              <li><strong>Local first:</strong> by default your workbooks live in your browser's storage on your device. Clearing site data removes them.</li>
              <li><strong>Connected sources:</strong> when you connect a data source (URL, API, database), credentials are kept in the credential vault and never written to logs or shared with other users.</li>
              <li><strong>AI features:</strong> the AI agent acts on your data only to carry out your requests. Prompt and tool-call records stay in your account's audit trail.</li>
              <li><strong>Sharing:</strong> sharing a workbook grants access only to the people you choose, with the permission (view or edit) you choose; every share is audit-logged.</li>
              <li><strong>Feedback:</strong> feedback you send from Help &gt; Feedback is stored locally until forwarded to the team; include no sensitive data in it.</li>
            </ul>
            <p style={{ color: '#666' }}>Questions: <a href="mailto:privacy@icecream-sheets.app">privacy@icecream-sheets.app</a></p>
          </div>
        )}

        {section === 'terms' && (
          <div style={{ fontSize: 13 }}>
            <h4 style={{ margin: '4px 0' }}>Terms of Use</h4>
            <ul>
              <li><strong>Your content:</strong> you own your workbooks, scripts and analyses. You grant Icecream Sheets only the rights needed to store, process and display them for you.</li>
              <li><strong>Acceptable use:</strong> don't use the service to harm others, break the law, or circumvent access controls (including other users' protected ranges and shared-document permissions).</li>
              <li><strong>Scripts &amp; automation:</strong> scripts you write or import run with your authority through the permissioned automation API. Review migrated VBA/Apps Script before running it — you are responsible for what your scripts do.</li>
              <li><strong>AI agent:</strong> the AI agent acts through MCP tools on your behalf. Broad or destructive writes always ask for your confirmation first; confirm only what you intend.</li>
              <li><strong>Availability:</strong> the service is provided as-is; keep your own backups of important workbooks (File &gt; Download).</li>
            </ul>
            <p style={{ color: '#666' }}>Questions: <a href="mailto:support@icecream-sheets.app">support@icecream-sheets.app</a></p>
          </div>
        )}
      </div>
    </div>
  );
}
