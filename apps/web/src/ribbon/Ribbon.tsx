/**
 * Excel-style ribbon for Icecream Sheets — full parity build.
 *
 * Tabs: File, Home, Insert, Page Layout, Formulas, Data, Review, View.
 * Every enabled button is wired to real behavior: cell-data mutations go
 * through EngineHost.execute(); pure-UI formatting goes through the
 * formatting model in App state. Controls the engine cannot support yet
 * are rendered DISABLED with a tooltip explaining why — never dead buttons.
 */
import { Children, Fragment, memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { ReactElement, ReactNode } from 'react';
import type { CalculationMode, EngineHost } from '@icecream-sheets/engine';
import type { SensitivityLabel } from '@icecream-sheets/service';
import { cellRef } from '../engine';
import type { Selection } from '../App';
import { cellEditText, firstCellText, nextSheetName } from './clipboard';
import {
  RibbonButton,
  RibbonGroup,
  RibbonSelect,
  RibbonMenu,
  RibbonMenuItem,
  RibbonSubmenu,
  ColorSwatches,
} from './RibbonControls';
import * as Icons from './icons';
import {
  FONT_NAMES,
  FONT_SIZES,
  NUMBER_FORMATS,
  BORDER_PRESETS,
  CELL_STYLE_NAMES,
  THEME_COLORS,
  type CellFormat,
  type NumberFormat,
} from '../features/formatting';
import {
  AUTOSUM_FNS,
  ACCOUNTING_CURRENCIES,
  BORDER_COLORS,
  BORDER_STYLES,
  PASTE_SPECIAL_ITEMS,
} from '../components/HomeExtras';
import { CHART_GROUPS, type ChartKind } from '@icecream-sheets/service';
import { SHAPE_CATEGORIES, shapesByCategory, type ShapeCategoryId } from '@icecream-sheets/service';
import { type ShapeKind } from '../components/Overlays';
import { FORM_CONTROL_KINDS, type FormControlKind } from '../components/FormControls';
import './ribbon.css';

export type RibbonTabId =
  | 'File'
  | 'Home'
  | 'Insert'
  | 'Draw'
  | 'Page Layout'
  | 'Formulas'
  | 'Data'
  | 'Review'
  | 'View'
  | 'Extensions'
  | 'Help';

const TABS: RibbonTabId[] = [
  'File',
  'Home',
  'Insert',
  'Draw',
  'Page Layout',
  'Formulas',
  'Data',
  'Review',
  'View',
  'Extensions',
  'Help',
];

/** Issue #24: at the narrowest widths the two longest tab labels swap to a
 * short form via CSS (see ribbon.css, the max-width:440px tier reads
 * data-short). The DOM text — and therefore the accessible name — always
 * stays the full label; only the painted glyphs change. */
const TAB_SHORT_LABELS: Partial<Record<RibbonTabId, string>> = {
  'Page Layout': 'Layout',
  Extensions: 'Ext',
};

interface FunctionDef {
  name: string;
  skeleton: string;
  hint: string;
}

const QUICK_FUNCTIONS: FunctionDef[] = [
  { name: 'SUM', skeleton: '=SUM()', hint: 'Adds the numbers in a range' },
  { name: 'AVERAGE', skeleton: '=AVERAGE()', hint: 'Average of the numbers in a range' },
  { name: 'COUNT', skeleton: '=COUNT()', hint: 'Counts the numbers in a range' },
  { name: 'MIN', skeleton: '=MIN()', hint: 'Smallest number in a range' },
  { name: 'MAX', skeleton: '=MAX()', hint: 'Largest number in a range' },
  { name: 'IF', skeleton: '=IF(,,)', hint: 'Returns one value if true, another if false' },
];

export interface RibbonProps {
  calcMode: CalculationMode;
  sheet: string;
  sheets: string[];
  sel: Selection;
  host: EngineHost;
  zoom: number;
  showGridlines: boolean;
  showFormulaBar: boolean;
  showHeadings: boolean;
  canUndo: boolean;
  canRedo: boolean;
  hasFreeze: boolean;
  /** Current format of the selected cell (for toggle/button state). */
  selectedFormat: CellFormat | undefined;
  // Extended state.
  formatPainterActive: boolean;
  showFormulas: boolean;
  showComments: boolean;
  focusCell: boolean;
  hasComment: boolean;
  fnCategories: string[];
  onNew: () => void;
  onOpenFile: (file: File) => void;
  onOpenDataSource: () => void;
  onOpenFromUrl: () => void;
  /** Workbook library (platform-shell.md §2): the "Open" flow. */
  onOpenLibrary: () => void;
  /** Per-user settings (platform-shell.md §4). */
  onOpenSettings: () => void;
  /** Keyboard-shortcuts dialog (Ctrl+/). */
  onOpenShortcuts: () => void;
  /** Desktop shell: native Open/Save via the main process. */
  isDesktop: boolean;
  onDesktopOpen: () => void;
  onDesktopSave: () => void;
  /**
   * Cycle 10 (user's rule: mutation is gated): the workbook is still
   * loading — save/export render disabled with a "Loading…" state and
   * the reason, since serializing a half-loaded workbook would write
   * unloaded sheets back empty. Wired to the App's workbookLoaded flag:
   * true during ANY open window (gateway async load, desktop IPC load).
   */
  desktopLoading?: boolean;
  onDownload: () => void;
  /** The workbook is read-only (no save target): Save is disabled. */
  readOnly?: boolean;
  onDownloadEncrypted: () => void;
  /** Native Download-as-PDF (design-docs/print-and-page-layout.md §3). */
  onDownloadPdf: () => void;
  /** Save format for downloads (track 9): xlsx/csv/tsv/ods/html. */
  saveFormat: string;
  onSaveFormatChange: (format: string) => void;
  onRecalculate: () => void;
  onToggleMode: () => void;
  onSetCalcMode: (mode: CalculationMode) => void;
  onOpenIterative: () => void;
  onOpenParallelCalc: () => void;
  onAddSheet: (name: string) => void;
  onDeleteSheet: () => void;
  onClear: () => void;
  onCommitCell: (row: number, col: number, text: string) => void;
  onInsertFunction: (skeleton: string) => void;
  onOpenFnDialog: () => void;
  onOpenFnDialogFor: (category: string) => void;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onZoomReset: () => void;
  onToggleGridlines: () => void;
  onToggleFormulaBar: () => void;
  onToggleHeadings: () => void;
  onFullScreen: () => void;
  /** Open the sparkline insert dialog. */
  onInsertSparkline: () => void;
  /** Remove the sparkline at the selection, if any. */
  onRemoveSparkline: () => void;
  /** Open the Macros (recorder) dialog. */
  onOpenMacroRecorder: () => void;
  /** True while the macro recorder is capturing. */
  macroRecording: boolean;
  onError: (msg: string) => void;
  onUndo: () => void;
  onRedo: () => void;
  onFind: () => void;
  onSortAsc: () => void;
  onSortDesc: () => void;
  onCustomSort: () => void;
  onClearFilter: () => void;
  onOpenFilter: (col: number) => void;
  onFreeze: () => void;
  onFreezeTopRow: () => void;
  onFreezeFirstCol: () => void;
  onUnfreeze: () => void;
  onToggleFocusCell: () => void;
  onMerge: () => void;
  onUnmerge: () => void;
  onOpenCF: () => void;
  onClearCF: () => void;
  onOpenTopBottomCF: () => void;
  onOpenDataBarCF: () => void;
  onOpenColorScaleCF: () => void;
  onOpenIconSetCF: () => void;
  onOpenValidation: () => void;
  onInsertRow: () => void;
  onDeleteRow: () => void;
  onInsertCol: () => void;
  onDeleteCol: () => void;
  // Formatting (pure UI state in App).
  onFormat: (update: Partial<CellFormat>) => void;
  onCellStyle: (name: string) => void;
  onClearFormat: () => void;
  onFormatAsTable: () => void;
  onRemoveDuplicates: () => void;
  onDoubleUnderline: () => void;
  onBorderColor: (color: string) => void;
  onBorderStyle: (style: string) => void;
  onAccounting: (symbol: string) => void;
  // Clipboard.
  onPasteValues: () => void;
  onPasteFormulas: () => void;
  onPasteFormats: () => void;
  onPasteAll: () => void;
  onFormatPainter: () => void;
  // Cells.
  onClearAll: () => void;
  onAutoSum: (fn: string) => void;
  onRowHeight: () => void;
  onColWidth: () => void;
  onHideRow: () => void;
  onHideCol: () => void;
  onUnhideRows: () => void;
  onUnhideCols: () => void;
  onRenameSheet: () => void;
  // Data.
  onTextToColumns: () => void;
  onGroupRows: () => void;
  onGroupCols: () => void;
  onUngroupAll: () => void;
  onSolver: () => void;
  onGoalSeek: () => void;
  onScenarioManager: () => void;
  onDataTable: () => void;
  onFlashFill: () => void;
  onSuggestFormulas: () => void;
  onCleanUp: () => void;
  onColumnStats: () => void;
  onTrimWhitespace: () => void;
  /** Data > Data Tools > Randomize Range: shuffle the data rows of the selection. */
  onRandomizeRange: () => void;
  /** Data > Data Tools > Group-by View: pivot-style summary into a new sheet. */
  onOpenGroupBy: () => void;
  /**
   * File > Email submenu (Mail connector): send the workbook or the active
   * sheet as an attachment.
   */
  onOpenEmail: (mode: 'workbook' | 'sheet') => void;
  // Formulas.
  onToggleShowFormulas: () => void;
  onOpenNameManager: () => void;
  onOpenNamedFunctions: () => void;
  // Review.
  onNewComment: () => void;
  onToggleShowComments: () => void;
  onDeleteComment: () => void;
  onSpelling: () => void;
  onManageProtection: () => void;
  isSheetProtected: boolean;
  onOpenRevisionHistory: () => void;
  sensitivityLabel: SensitivityLabel;
  onSensitivityChange: (label: SensitivityLabel) => void;
  // Insert.
  onInsertChart: (kind: ChartKind) => void;
  onInsertShape: (kind: ShapeKind) => void;
  onInsertTextBox: () => void;
  onInsertPivotTable: () => void;
  onInsertPicture: () => void;
  onInsertFormControl: (kind: FormControlKind) => void;
  onNewReport: () => void;
  onOpenReports: () => void;
  // Apps (no-code app builder).
  onOpenAppBuilder: () => void;
  appList: { id: string; name: string }[];
  onOpenApp: (id: string) => void;
  onOpenGlobeSetup: () => void;
  onInsertSlicer: () => void;
  onInsertTimeline: () => void;
  // Data: power query, data types, external links.
  onOpenPowerQuery: () => void;
  onOpenEtl: () => void;
  onRefreshDataSource: () => void;
  onRefreshAllDataSources: () => void;
  canRefreshDataSource: boolean;
  onOpenDataTypeDialog: () => void;
  onOpenSmartChipDialog: () => void;
  onOpenExternalLinks: () => void;
  // Page Layout / print.
  onOpenPrintPreview: () => void;
  onSetPrintArea: () => void;
  onClearPrintArea: () => void;
  // Placeholders for genuinely unimplemented backends.
  onNotImplemented: (feature: string) => void;
  // ---- Ribbon parity additions (Excel Classic) ----
  // Home: clipboard/format
  onPasteAsPicture: () => void;
  onPasteAsLinkedPicture: () => void;
  onIncreaseDecimal: () => void;
  onDecreaseDecimal: () => void;
  onOpenOrientation: () => void;
  onFill: (dir: 'down' | 'up' | 'right' | 'left') => void;
  onFillSeries: () => void;
  onJustify: () => void;
  onClearComments: () => void;
  onClearHyperlinks: () => void;
  onReapplyFilter: () => void;
  onOpenAdvancedFilter: () => void;
  onOpenGoTo: () => void;
  onOpenGoToSpecial: () => void;
  onToggleSelectObjects: () => void;
  selectObjectsMode: boolean;
  onOpenNewCFRule: () => void;
  onOpenManageCFRules: () => void;
  onOpenTableStyleGallery: () => void;
  onAutoFitRowHeight: () => void;
  onAutoFitColumnWidth: () => void;
  onDefaultWidth: () => void;
  onMoveCopySheet: () => void;
  onInsertCells: () => void;
  onDeleteCells: () => void;
  onOpenFormatCells: () => void;
  // Insert
  onOpenRecommendedPivots: () => void;
  onOpenRecommendedCharts: () => void;
  onOpenPivotChart: () => void;
  onOpenIcons: () => void;
  onOpenSmartArt: () => void;
  onOpenScreenshot: () => void;
  onOpenLinkDialog: () => void;
  onOpenHeaderFooter: () => void;
  onOpenWordArt: () => void;
  onOpenEquation: () => void;
  onOpenSymbol: () => void;
  // Draw
  inkTool: string;
  onSetInkTool: (tool: string) => void;
  onInkConvert: (kind: 'text' | 'shape' | 'math') => void;
  onInsertDrawingCanvas: () => void;
  // Page Layout
  onOpenThemes: () => void;
  onOpenPageSetup: () => void;
  onSetMargins: (preset: string) => void;
  onSetPageOrientation: (o: 'portrait' | 'landscape') => void;
  onSetPaperSize: (size: string) => void;
  onInsertPageBreak: () => void;
  onRemovePageBreak: () => void;
  onResetPageBreaks: () => void;
  onOpenBackground: () => void;
  onOpenPrintTitles: () => void;
  onSetScaleToFit: (w: number, h: number, scale: number) => void;
  printGridlines: boolean;
  printHeadings: boolean;
  onTogglePrintGridlines: () => void;
  onTogglePrintHeadings: () => void;
  onBringForward: () => void;
  onSendBackward: () => void;
  onOpenSelectionPane: () => void;
  onAlignObjects: (mode: string) => void;
  onRotateObjects: (mode: string) => void;
  // Formulas
  recentFunctions: string[];
  onOpenDefineName: () => void;
  onOpenApplyNames: () => void;
  onOpenCreateFromSelection: () => void;
  onOpenUseInFormula: () => void;
  onTracePrecedents: () => void;
  onTraceDependents: () => void;
  onRemoveArrows: () => void;
  onOpenErrorChecking: () => void;
  onOpenEvaluateFormula: () => void;
  onToggleWatchWindow: () => void;
  watchWindowOpen: boolean;
  onCalculateSheet: () => void;
  // Data
  onOpenQuickImport: (tab: 'text' | 'web' | 'recent' | 'connections') => void;
  onToggleQueriesPane: () => void;
  queriesPaneOpen: boolean;
  onOpenConsolidate: () => void;
  onOpenRelationships: () => void;
  onOpenForecastSheet: () => void;
  onOpenSubtotal: () => void;
  onShowDetail: () => void;
  onHideDetail: () => void;
  // Review
  onOpenThesaurus: () => void;
  onOpenAccessibilityChecker: () => void;
  onOpenTranslate: () => void;
  onPrevComment: () => void;
  onNextComment: () => void;
  onDeleteAllComments: () => void;
  onOpenNotes: () => void;
  onOpenWorkbookProtection: () => void;
  onOpenAllowEditRanges: () => void;
  // View
  workbookView: 'normal' | 'pageBreakPreview' | 'pageLayout';
  onSetWorkbookView: (v: 'normal' | 'pageBreakPreview' | 'pageLayout') => void;
  onOpenZoomDialog: () => void;
  onZoomToSelection: () => void;
  onToggleSplit: () => void;
  splitActive: boolean;
  onOpenMacroList: () => void;
  useRelativeRefs: boolean;
  onToggleRelativeRefs: () => void;
  // Extensions > Apps Script editor (automation lane)
  onOpenScriptEditor: () => void;
  // Extensions > Triggers dialog (automation lane §3)
  onOpenTriggers: () => void;
  // Extensions > add-on manager (add-on-model.md §6: "Get add-ons opens the product-owned catalog")
  onOpenAddonManager: () => void;
  // Help
  onOpenHelp: (section: string) => void;
  // Share
  onOpenShare: () => void;
}

/* ------------------------------------------------------------------ */
/* Ribbon panel: fit-compression + group collapse + triangle scroll    */
/* (issue #24). The ribbon NEVER renders a native scrollbar. When the  */
/* active tab's groups are wider than the panel, RibbonPanel first     */
/* compresses through deterministic fit levels (ribbon-fit-1/2/3 in     */
/* ribbon.css), then collapses whole groups right-to-left into the     */
/* "More" dropdown, and only if content STILL overflows (a single      */
/* group wider than the panel) does it pin the ◀ ▶ triangle buttons    */
/* at the panel's ends and scroll the content row programmatically.    */
/*                                                                     */
/* The fit is computed in ONE layout-effect pass per reset (mount,     */
/* tab switch, window resize): candidate classes are poked onto the    */
/* DOM imperatively and measured pre-paint, then committed to React    */
/* state exactly once. No cascading setState, no observers feeding     */
/* back into layout — the computation cannot oscillate.                */
/* ------------------------------------------------------------------ */

const RIBBON_FIT_LEVELS = ['', 'ribbon-fit-1', 'ribbon-fit-2', 'ribbon-fit-3'] as const;
/** Width reserved for the "More" button when any group is collapsed. */
const RIBBON_MORE_WIDTH = 84;

interface PanelItem {
  key: string;
  node: ReactNode;
  group: boolean;
}

/** Flatten the active tab's fragment into its ordered top-level items. */
function panelItems(children: ReactNode): PanelItem[] {
  const items: PanelItem[] = [];
  const walk = (nodes: ReactNode) => {
    Children.forEach(nodes, (child) => {
      if (!child || typeof child !== 'object') return;
      const el = child as ReactElement<{ children?: ReactNode }>;
      if (el.type === RibbonGroup) {
        items.push({ key: `g${items.length}`, node: el, group: true });
      } else if (el.props && 'children' in el.props) {
        walk(el.props.children);
      } else {
        items.push({ key: `x${items.length}`, node: el, group: false });
      }
    });
  };
  walk(children);
  return items;
}

/**
 * The pinned dropdown holding collapsed groups, in their original order.
 * Portaled to document.body with position:fixed like RibbonMenu (issue
 * #24) so the clipping ribbon panel cannot slice it; right-aligned to the
 * More button so it always opens on-screen.
 */
function RibbonCollapsedMenu({ items }: { items: PanelItem[] }) {
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState<{ top: number; right: number } | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const popupRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (ref.current && !ref.current.contains(t) && popupRef.current && !popupRef.current.contains(t)) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    const onMove = () => setOpen(false);
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    window.addEventListener('resize', onMove);
    window.addEventListener('scroll', onMove, true);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', onMove);
      window.removeEventListener('scroll', onMove, true);
    };
  }, [open ]);

  return (
    <div className="ribbon-menu ribbon-overflow-root" ref={ref}>
      <button
        type="button"
        className="ribbon-btn small ribbon-overflow-btn"
        title="More commands — groups that do not fit in the ribbon"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={(e) => {
          if (!open) {
            const r = e.currentTarget.getBoundingClientRect();
            setAnchor({ top: r.bottom + 4, right: Math.max(4, window.innerWidth - r.right) });
          }
          setOpen((o) => !o);
        }}
      >
        <span className="ribbon-btn-label">More ▾</span>
      </button>
      {open &&
        anchor &&
        createPortal(
          <div
            className="ribbon-menu-popup ribbon-overflow-popup ribbon-popup-fixed"
            role="menu"
            ref={popupRef}
            style={{ top: anchor.top, right: anchor.right }}
            onClick={(e) => {
              // Plain controls act and close the menu; nested dropdown
              // buttons (inside .ribbon-menu) manage themselves.
              if (!(e.target as HTMLElement).closest('.ribbon-menu')) setOpen(false);
            }}
          >
            {items.map((it) => (
              <div key={it.key} className="ribbon-overflow-section" role="none">
                {it.node}
              </div>
            ))}
          </div>,
          document.body,
        )}
    </div>
  );
}

interface RibbonFit {
  level: number;
  collapsed: number;
  arrows: boolean;
}

const FIT_ZERO: RibbonFit = { level: 0, collapsed: 0, arrows: false };

function RibbonPanel({ resetKey, children }: { resetKey: string; children: ReactNode }) {
  const panelRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const pendingRef = useRef(true);
  const fitRef = useRef<RibbonFit>(FIT_ZERO);
  const [fit, setFitState] = useState<RibbonFit>(FIT_ZERO);
  // Bumped on every fit reset so a reset ALWAYS produces a commit (and thus
  // a layout-effect pass) even when the fit state is already FIT_ZERO.
  const [, setEpoch] = useState(0);
  const bumpEpoch = useCallback(() => setEpoch((e) => e + 1), []);
  const endsRef = useRef({ left: false, right: false });
  const [scrollEnds, setScrollEnds] = useState(endsRef.current);

  const items = panelItems(children);
  const groupTotal = items.reduce((n, i) => n + (i.group ? 1 : 0), 0);
  const visible: PanelItem[] = [];
  const overflowed: PanelItem[] = [];
  let seenGroups = 0;
  for (const it of items) {
    if (it.group) {
      seenGroups += 1;
      if (seenGroups > groupTotal - fit.collapsed) overflowed.push(it);
      else visible.push(it);
    } else {
      visible.push(it);
    }
  }

  const setFit = useCallback((next: RibbonFit) => {
    const cur = fitRef.current;
    if (cur.level === next.level && cur.collapsed === next.collapsed && cur.arrows === next.arrows) return;
    fitRef.current = next;
    setFitState(next);
  }, []);

  const updateEnds = useCallback(() => {
    const panel = panelRef.current;
    const content = contentRef.current;
    if (!panel || !content) return;
    const max = content.scrollWidth - panel.clientWidth;
    const next = { left: content.scrollLeft > 1, right: content.scrollLeft < max - 1 };
    // Compare BEFORE dispatching (via the ref mirror): dispatching a
    // same-value update from a layout effect still costs a render to
    // discover the equality, and that render re-runs the layout effect —
    // a self-sustaining nested-update loop (React error #185).
    if (endsRef.current.left === next.left && endsRef.current.right === next.right) return;
    endsRef.current = next;
    setScrollEnds(next);
  }, []);

  /**
   * One-shot fit computation. Runs pre-paint with the panel rendered in the
   * zero state (all groups visible, uncompressed): pokes candidate fit
   * classes onto the panel, measures natural (unshrunk) content width at
   * each level, then measures per-group widths to choose the collapse
   * count, and commits the result once.
   */
  const computeFit = useCallback(() => {
    const panel = panelRef.current;
    const content = contentRef.current;
    if (!panel || !content) return;
    const groups = Array.from(content.querySelectorAll<HTMLElement>(':scope > .ribbon-group'));
    // Natural widths: stop flex from shrinking groups while measuring.
    const prevFlex = groups.map((g) => g.style.flex);
    groups.forEach((g) => {
      g.style.flex = 'none';
    });
    try {
      const avail = content.clientWidth;
      let chosen: RibbonFit | null = null;
      for (let level = 0; level < RIBBON_FIT_LEVELS.length; level += 1) {
        panel.className = ['ribbon-panel', RIBBON_FIT_LEVELS[level]].filter(Boolean).join(' ');
        if (content.scrollWidth <= avail) {
          chosen = { level, collapsed: 0, arrows: false };
          break;
        }
      }
      if (!chosen) {
        // Even the tightest compression overflows: collapse whole groups
        // right-to-left (at the max fit level) until the rest fits.
        const widths = groups.map((g) => g.offsetWidth);
        const total = widths.reduce((a, b) => a + b, 0);
        let sum = total;
        let collapsed = 0;
        while (collapsed < widths.length - 1 && sum + RIBBON_MORE_WIDTH > avail) {
          collapsed += 1;
          sum -= widths[widths.length - collapsed];
        }
        const arrows = sum + (collapsed > 0 ? RIBBON_MORE_WIDTH : 0) > avail;
        chosen = { level: RIBBON_FIT_LEVELS.length - 1, collapsed, arrows };
      }
      panel.className = ['ribbon-panel', RIBBON_FIT_LEVELS[chosen.level]].filter(Boolean).join(' ');
      setFit(chosen);
    } finally {
      groups.forEach((g, i) => {
        g.style.flex = prevFlex[i];
      });
    }
  }, [setFit]);

  useLayoutEffect(() => {
    // Compute ONLY on a commit that renders the zero state (all groups
    // visible, uncompressed) — measuring a mid-collapse DOM would count
    // only the visible subset and poison the result. A reset always pairs
    // pending=true with setFit(FIT_ZERO), so the zero commit is guaranteed
    // to arrive; until it does, the flag simply stays set.
    const f = fitRef.current;
    if (pendingRef.current && f.level === 0 && f.collapsed === 0 && !f.arrows) {
      pendingRef.current = false;
      computeFit();
    }
    // Selection-render fix (#77): the scroll-ends state only feeds the
    // scroll buttons, which render only when fit.arrows is set; reading
    // layout after every commit otherwise forces a reflow per render.
    if (fitRef.current.arrows) updateEnds();
  });

  // A new tab starts from the uncompressed layout and re-fits itself.
  // (Mount is skipped: the panel already starts at FIT_ZERO + pending.)
  const prevResetKeyRef = useRef(resetKey);
  useEffect(() => {
    if (prevResetKeyRef.current === resetKey) return;
    prevResetKeyRef.current = resetKey;
    pendingRef.current = true;
    setFit(FIT_ZERO);
    bumpEpoch();
    if (contentRef.current) contentRef.current.scrollLeft = 0;
  }, [resetKey, setFit, bumpEpoch]);

  // A viewport resize re-runs the whole fit from scratch. (Window resize
  // only — observing the panel itself would feed the fit's own layout
  // changes back in as resets.)
  useEffect(() => {
    let t: ReturnType<typeof setTimeout> | undefined;
    const onResize = () => {
      if (t) clearTimeout(t);
      t = setTimeout(() => {
        pendingRef.current = true;
        setFit(FIT_ZERO);
        bumpEpoch();
      }, 150);
    };
    window.addEventListener('resize', onResize);
    return () => {
      if (t) clearTimeout(t);
      window.removeEventListener('resize', onResize);
    };
  }, [setFit, bumpEpoch]);

  // Verification pass: tab content can finish rendering AFTER the fit was
  // measured (lazy chunks), which would leave the committed fit too loose.
  // 200 ms after every fit commit, validate the committed state against the
  // LIVE layout — measured from the content's direct children so open menu
  // popups (deeper descendants) cannot inflate it — and re-fit from scratch
  // if real content still overflows. Bounded retries per tab.
  const verifyAttemptsRef = useRef(0);
  useEffect(() => {
    verifyAttemptsRef.current = 0;
  }, [resetKey]);
  useEffect(() => {
    const t = setTimeout(() => {
      const panel = panelRef.current;
      const content = contentRef.current;
      if (!panel || !content) return;
      let live = 0;
      for (const child of Array.from(content.children)) {
        const el = child as HTMLElement;
        live = Math.max(live, el.offsetLeft + el.offsetWidth - content.offsetLeft);
      }
      const f = fitRef.current;
      const terminal = f.level >= RIBBON_FIT_LEVELS.length - 1 && f.arrows;
      if (live > panel.clientWidth + 1 && !terminal && verifyAttemptsRef.current < 4) {
        verifyAttemptsRef.current += 1;
        pendingRef.current = true;
        setFit(FIT_ZERO);
        bumpEpoch();
      }
    }, 200);
    return () => clearTimeout(t);
  }, [fit, setFit, bumpEpoch]);

  const page = (dir: 1 | -1) => {
    const panel = panelRef.current;
    const content = contentRef.current;
    if (!panel || !content) return;
    content.scrollBy({ left: dir * Math.max(160, panel.clientWidth * 0.8), behavior: 'smooth' });
  };

  const fitClass = RIBBON_FIT_LEVELS[fit.level];
  return (
    <div className="ribbon-panel-wrap">
      {fit.arrows && (
        <button
          type="button"
          className="ribbon-scroll-btn left"
          aria-label="Scroll ribbon left"
          title="Scroll ribbon left"
          disabled={!scrollEnds.left}
          onClick={() => page(-1)}
        >
          ◀
        </button>
      )}
      <div className={['ribbon-panel', fitClass].filter(Boolean).join(' ')} role="tabpanel" ref={panelRef}>
        <div className="ribbon-panel-content" ref={contentRef} onScroll={updateEnds}>
          {visible.map((it) => (
            <Fragment key={it.key}>{it.node}</Fragment>
          ))}
          {overflowed.length > 0 && <RibbonCollapsedMenu items={overflowed} />}
        </div>
      </div>
      {fit.arrows && (
        <button
          type="button"
          className="ribbon-scroll-btn right"
          aria-label="Scroll ribbon right"
          title="Scroll ribbon right"
          disabled={!scrollEnds.right}
          onClick={() => page(1)}
        >
          ▶
        </button>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Selection-render fix (#77): the ribbon's group contents are memoized
 * components (below). They receive only the values they DISPLAY plus this
 * one stable dispatcher — modeled on Grid's cellEvents — whose methods
 * always invoke the LATEST Ribbon props (kept in a ref by the Ribbon
 * component), so a memoized group never acts on stale handlers and never
 * re-renders just because App re-created a handler closure. */

type RibbonCallbackProps = {
  [K in keyof RibbonProps as RibbonProps[K] extends (...args: never[]) => unknown
    ? K
    : never]: RibbonProps[K];
};

export interface RibbonEvents extends RibbonCallbackProps {
  copy(): void;
  cut(): void;
  paste(): void;
  toggleFormat(key: 'bold' | 'italic' | 'underline' | 'strikethrough' | 'wrapText'): void;
  growFont(): void;
  shrinkFont(): void;
  indentBy(delta: number): void;
  openFilePicker(): void;
  openFilterSel(): void;
  addSheet(): void;
}

const RIBBON_CALLBACK_NAMES: readonly string[] = [
  'onNew',
  'onOpenFile',
  'onOpenDataSource',
  'onOpenFromUrl',
  'onOpenLibrary',
  'onOpenSettings',
  'onOpenShortcuts',
  'onDesktopOpen',
  'onDesktopSave',
  'onDownload',
  'onDownloadEncrypted',
  'onDownloadPdf',
  'onSaveFormatChange',
  'onRecalculate',
  'onToggleMode',
  'onSetCalcMode',
  'onOpenIterative',
  'onOpenParallelCalc',
  'onAddSheet',
  'onDeleteSheet',
  'onClear',
  'onCommitCell',
  'onInsertFunction',
  'onOpenFnDialog',
  'onOpenFnDialogFor',
  'onZoomIn',
  'onZoomOut',
  'onZoomReset',
  'onToggleGridlines',
  'onToggleFormulaBar',
  'onToggleHeadings',
  'onFullScreen',
  'onInsertSparkline',
  'onRemoveSparkline',
  'onOpenMacroRecorder',
  'onError',
  'onUndo',
  'onRedo',
  'onFind',
  'onSortAsc',
  'onSortDesc',
  'onCustomSort',
  'onClearFilter',
  'onOpenFilter',
  'onFreeze',
  'onFreezeTopRow',
  'onFreezeFirstCol',
  'onUnfreeze',
  'onToggleFocusCell',
  'onMerge',
  'onUnmerge',
  'onOpenCF',
  'onClearCF',
  'onOpenTopBottomCF',
  'onOpenDataBarCF',
  'onOpenColorScaleCF',
  'onOpenIconSetCF',
  'onOpenValidation',
  'onInsertRow',
  'onDeleteRow',
  'onInsertCol',
  'onDeleteCol',
  'onFormat',
  'onCellStyle',
  'onClearFormat',
  'onFormatAsTable',
  'onRemoveDuplicates',
  'onDoubleUnderline',
  'onBorderColor',
  'onBorderStyle',
  'onAccounting',
  'onPasteValues',
  'onPasteFormulas',
  'onPasteFormats',
  'onPasteAll',
  'onFormatPainter',
  'onClearAll',
  'onAutoSum',
  'onRowHeight',
  'onColWidth',
  'onHideRow',
  'onHideCol',
  'onUnhideRows',
  'onUnhideCols',
  'onRenameSheet',
  'onTextToColumns',
  'onGroupRows',
  'onGroupCols',
  'onUngroupAll',
  'onSolver',
  'onGoalSeek',
  'onScenarioManager',
  'onDataTable',
  'onFlashFill',
  'onSuggestFormulas',
  'onCleanUp',
  'onColumnStats',
  'onTrimWhitespace',
  'onRandomizeRange',
  'onOpenGroupBy',
  'onOpenEmail',
  'onToggleShowFormulas',
  'onOpenNameManager',
  'onOpenNamedFunctions',
  'onNewComment',
  'onToggleShowComments',
  'onDeleteComment',
  'onSpelling',
  'onManageProtection',
  'onOpenRevisionHistory',
  'onSensitivityChange',
  'onInsertChart',
  'onInsertShape',
  'onInsertTextBox',
  'onInsertPivotTable',
  'onInsertPicture',
  'onInsertFormControl',
  'onNewReport',
  'onOpenReports',
  'onOpenAppBuilder',
  'onOpenApp',
  'onOpenGlobeSetup',
  'onInsertSlicer',
  'onInsertTimeline',
  'onOpenPowerQuery',
  'onOpenEtl',
  'onRefreshDataSource',
  'onRefreshAllDataSources',
  'onOpenDataTypeDialog',
  'onOpenSmartChipDialog',
  'onOpenExternalLinks',
  'onOpenPrintPreview',
  'onSetPrintArea',
  'onClearPrintArea',
  'onNotImplemented',
  'onPasteAsPicture',
  'onPasteAsLinkedPicture',
  'onIncreaseDecimal',
  'onDecreaseDecimal',
  'onOpenOrientation',
  'onFill',
  'onFillSeries',
  'onJustify',
  'onClearComments',
  'onClearHyperlinks',
  'onReapplyFilter',
  'onOpenAdvancedFilter',
  'onOpenGoTo',
  'onOpenGoToSpecial',
  'onToggleSelectObjects',
  'onOpenNewCFRule',
  'onOpenManageCFRules',
  'onOpenTableStyleGallery',
  'onAutoFitRowHeight',
  'onAutoFitColumnWidth',
  'onDefaultWidth',
  'onMoveCopySheet',
  'onInsertCells',
  'onDeleteCells',
  'onOpenFormatCells',
  'onOpenRecommendedPivots',
  'onOpenRecommendedCharts',
  'onOpenPivotChart',
  'onOpenIcons',
  'onOpenSmartArt',
  'onOpenScreenshot',
  'onOpenLinkDialog',
  'onOpenHeaderFooter',
  'onOpenWordArt',
  'onOpenEquation',
  'onOpenSymbol',
  'onSetInkTool',
  'onInkConvert',
  'onInsertDrawingCanvas',
  'onOpenThemes',
  'onOpenPageSetup',
  'onSetMargins',
  'onSetPageOrientation',
  'onSetPaperSize',
  'onInsertPageBreak',
  'onRemovePageBreak',
  'onResetPageBreaks',
  'onOpenBackground',
  'onOpenPrintTitles',
  'onSetScaleToFit',
  'onTogglePrintGridlines',
  'onTogglePrintHeadings',
  'onBringForward',
  'onSendBackward',
  'onOpenSelectionPane',
  'onAlignObjects',
  'onRotateObjects',
  'onOpenDefineName',
  'onOpenApplyNames',
  'onOpenCreateFromSelection',
  'onOpenUseInFormula',
  'onTracePrecedents',
  'onTraceDependents',
  'onRemoveArrows',
  'onOpenErrorChecking',
  'onOpenEvaluateFormula',
  'onToggleWatchWindow',
  'onCalculateSheet',
  'onOpenQuickImport',
  'onToggleQueriesPane',
  'onOpenConsolidate',
  'onOpenRelationships',
  'onOpenForecastSheet',
  'onOpenSubtotal',
  'onShowDetail',
  'onHideDetail',
  'onOpenThesaurus',
  'onOpenAccessibilityChecker',
  'onOpenTranslate',
  'onPrevComment',
  'onNextComment',
  'onDeleteAllComments',
  'onOpenNotes',
  'onOpenWorkbookProtection',
  'onOpenAllowEditRanges',
  'onSetWorkbookView',
  'onOpenZoomDialog',
  'onZoomToSelection',
  'onToggleSplit',
  'onOpenMacroList',
  'onToggleRelativeRefs',
  'onOpenScriptEditor',
  'onOpenTriggers',
  'onOpenAddonManager',
  'onOpenHelp',
  'onOpenShare',
];

function makeRibbonEvents(
  propsRef: { current: RibbonProps },
  fileRef: { current: HTMLInputElement | null },
): RibbonEvents {
  const ev: Record<string, (...args: never[]) => unknown> = {};
  for (const name of RIBBON_CALLBACK_NAMES) {
    ev[name] = (...args: never[]) => {
      const fn = (propsRef.current as unknown as Record<string, unknown>)[name];
      return typeof fn === 'function' ? (fn as (...a: never[]) => unknown)(...args) : undefined;
    };
  }
  const readSelectedCell = () => {
    const p = propsRef.current;
    return p.host.getView().readCell(cellRef(p.sheet, p.sel.row, p.sel.col));
  };
  const helpers: Record<string, (...args: never[]) => unknown> = {
    copy: async () => {
      try {
        await navigator.clipboard.writeText(cellEditText(readSelectedCell()));
      } catch {
        propsRef.current.onError('Copy failed: clipboard access was denied by the browser.');
      }
    },
    cut: async () => {
      try {
        await navigator.clipboard.writeText(cellEditText(readSelectedCell()));
        propsRef.current.onClear();
      } catch {
        propsRef.current.onError('Cut failed: clipboard access was denied by the browser.');
      }
    },
    paste: async () => {
      const p = propsRef.current;
      try {
        const text = await navigator.clipboard.readText();
        p.onCommitCell(p.sel.row, p.sel.col, firstCellText(text));
      } catch {
        p.onError('Paste failed: clipboard access was denied by the browser.');
      }
    },
    toggleFormat: (key: 'bold' | 'italic' | 'underline' | 'strikethrough' | 'wrapText') => {
      const p = propsRef.current;
      p.onFormat({ [key]: !p.selectedFormat?.[key] } as Partial<CellFormat>);
    },
    growFont: () => {
      const p = propsRef.current;
      const cur = p.selectedFormat?.fontSize ?? 11;
      const next = FONT_SIZES.find((s) => s > cur) ?? 72;
      p.onFormat({ fontSize: next });
    },
    shrinkFont: () => {
      const p = propsRef.current;
      const cur = p.selectedFormat?.fontSize ?? 11;
      const next = [...FONT_SIZES].reverse().find((s) => s < cur) ?? 8;
      p.onFormat({ fontSize: next });
    },
    indentBy: (delta: number) => {
      const p = propsRef.current;
      p.onFormat({ indent: Math.max(0, Math.min(6, (p.selectedFormat?.indent ?? 0) + delta)) });
    },
    openFilePicker: () => {
      fileRef.current?.click();
    },
    openFilterSel: () => {
      const p = propsRef.current;
      p.onOpenFilter(p.sel.col);
    },
    addSheet: () => {
      const p = propsRef.current;
      p.onAddSheet(nextSheetName(p.sheets));
    },
  };
  return Object.assign(ev, helpers) as unknown as RibbonEvents;
}

/* Memoized ribbon group contents (#77): each renders exactly the original
 * group JSX, but re-renders only when one of its displayed props changes. */

const FileWorkbookContent = memo(function FileWorkbookContent(props: {
  ev: RibbonEvents;
}) {
  const { onNew, onOpenLibrary } = props.ev;
  return (
    <>
      <RibbonButton label="New" size="large" icon={<Icons.IconNewWorkbook />} onClick={onNew} title="Start a new blank workbook" />
      <RibbonButton
        label="Workbooks…"
        size="large"
        icon={<Icons.IconOpenFile />}
        onClick={onOpenLibrary}
        title="Workbook library: New / Open / Copy / Trash (platform-shell.md §2)"
      />
    </>
  );
});

const FileFileContent = memo(function FileFileContent(props: {
  ev: RibbonEvents;
  isDesktop: boolean;
  desktopLoading: boolean;
  readOnly: boolean;
  saveFormat: string;
}) {
  const { onDesktopOpen, onDesktopSave, onDownload, onDownloadEncrypted, onDownloadPdf, onOpenDataSource, onOpenEmail, onOpenFromUrl, onSaveFormatChange, openFilePicker } = props.ev;
  const { isDesktop, desktopLoading, readOnly, saveFormat } = props;
  return (
    <>
      {isDesktop ? (
        <>
          <RibbonButton
            label="Open…"
            size="large"
            icon={<Icons.IconOpenFile />}
            onClick={onDesktopOpen}
            title="Open a workbook via the native file dialog (Ctrl+O)"
          />
          <RibbonButton
            label={desktopLoading ? 'Loading…' : 'Save'}
            size="large"
            icon={<Icons.IconSave />}
            onClick={onDesktopSave}
            disabled={readOnly || desktopLoading}
            title={
              desktopLoading
                ? 'Workbook is still loading — save is disabled until the load completes'
                : readOnly
                  ? 'Read-only: this workbook has no save target'
                  : 'Save to the current file, or choose a location (Ctrl+S)'
            }
          />
        </>
      ) : (
        <>
          <RibbonButton
            label="Open file"
            size="large"
            icon={<Icons.IconOpenFile />}
            onClick={openFilePicker}
            title="Open a spreadsheet file from disk (.xlsx, .csv, .tsv, .ods)"
          />
          <RibbonButton
            label="Open data source…"
            size="large"
            icon={<Icons.IconOpenDataSource />}
            onClick={onOpenDataSource}
            title="Connect a live data source (CSV/JSON URL, REST API, SQL) — its data opens as a sheet"
          />
          <RibbonButton
            label="Open from URL…"
            size="large"
            icon={<Icons.IconOpenFile />}
            onClick={onOpenFromUrl}
            title="Open a spreadsheet file from a URL (read-only)"
          />
        </>
      )}
      <RibbonButton
        label={desktopLoading ? 'Loading…' : `Save .${saveFormat}`}
        size="large"
        icon={<Icons.IconSave />}
        onClick={onDownload}
        disabled={readOnly || desktopLoading}
        title={
          desktopLoading
            ? 'Workbook is still loading — save is disabled until the load completes'
            : readOnly
              ? 'Read-only: this workbook has no save target'
              : `Download the workbook as a .${saveFormat} file`
        }
      />
      <RibbonSelect
        label="Format"
        value={saveFormat}
        options={['xlsx', 'csv', 'tsv', 'ods', 'html']}
        onChange={onSaveFormatChange}
        title="Download format (track 9: adapters resolve by extension)"
        width={86}
      />
      <RibbonButton
        label={desktopLoading ? 'Loading…' : 'Save encrypted'}
        size="large"
        onClick={onDownloadEncrypted}
        disabled={desktopLoading}
        title={
          desktopLoading
            ? 'Workbook is still loading — save is disabled until the load completes'
            : 'Download the workbook encrypted with a password (face b)'
        }
      />
      <RibbonButton
        label={desktopLoading ? 'Loading…' : 'Download as PDF'}
        size="large"
        onClick={onDownloadPdf}
        disabled={desktopLoading}
        title={
          desktopLoading
            ? 'Workbook is still loading — export is disabled until the load completes'
            : 'Download the active sheet as PDF (native renderer; honors page setup and page breaks)'
        }
      />
      <RibbonMenu label="Email" title="Send via the Mail connector (OAuth2)" icon={<Icons.IconShare />}>
        <RibbonMenuItem
          label="Send Workbook…"
          disabled={desktopLoading}
          title={
            desktopLoading
              ? 'Workbook is still loading — export is disabled until the load completes'
              : 'Send Workbook…'
          }
          onClick={() => onOpenEmail('workbook')}
        />
        <RibbonMenuItem
          label="Send Active Sheet…"
          disabled={desktopLoading}
          title={
            desktopLoading
              ? 'Workbook is still loading — export is disabled until the load completes'
              : 'Send Active Sheet…'
          }
          onClick={() => onOpenEmail('sheet')}
        />
      </RibbonMenu>
    </>
  );
});

const FilePreferencesContent = memo(function FilePreferencesContent(props: {
  ev: RibbonEvents;
}) {
  const { onOpenSettings, onOpenShortcuts } = props.ev;
  return (
    <>
      <RibbonButton
        label="Settings…"
        size="large"
        onClick={onOpenSettings}
        title="Per-user settings: theme, formula language, calculation (platform-shell.md §4)"
      />
      <RibbonButton
        label="Shortcuts…"
        size="large"
        onClick={onOpenShortcuts}
        title="Keyboard shortcuts (Ctrl+/)"
      />
    </>
  );
});

const HomeClipboardContent = memo(function HomeClipboardContent(props: {
  ev: RibbonEvents;
  formatPainterActive: boolean;
}) {
  const { onFormatPainter, onPasteAll, onPasteAsLinkedPicture, onPasteAsPicture, onPasteFormats, onPasteFormulas, onPasteValues, copy: handleCopy, cut: handleCut, paste: handlePaste } = props.ev;
  const { formatPainterActive } = props;
  return (
    <>
      <RibbonButton label="Cut" size="large" icon={<Icons.IconCut />} onClick={handleCut} title="Cut the selected cell (Ctrl+X)" />
      <RibbonButton label="Copy" size="large" icon={<Icons.IconCopy />} onClick={handleCopy} title="Copy the selected cell (Ctrl+C)" />
      <RibbonMenu label="Paste" title="Paste (Ctrl+V)" icon={<Icons.IconPaste />}>
        <RibbonMenuItem label="Paste" onClick={handlePaste} title="Paste (Ctrl+V)" />
        <RibbonSubmenu label="Paste Special" title="Paste with options">
          {PASTE_SPECIAL_ITEMS.map((item) => (
            <RibbonMenuItem
              key={item.id}
              label={item.label}
              disabled={!item.enabled}
              title={item.enabled ? item.label : item.reason}
              onClick={() => {
                if (item.id === 'values') onPasteValues();
                else if (item.id === 'formulas') onPasteFormulas();
                else if (item.id === 'formats') onPasteFormats();
                else if (item.id === 'all') onPasteAll();
              }}
            />
          ))}
        </RibbonSubmenu>
        <RibbonMenuItem label="Paste as Picture" onClick={onPasteAsPicture} title="Paste the clipboard image as a picture" />
        <RibbonMenuItem label="Paste as Linked Picture" onClick={onPasteAsLinkedPicture} title="Paste the selection as a linked picture that updates" />
      </RibbonMenu>
      <RibbonButton
        label="Format Painter"
        size="large"
        icon={<Icons.IconFormatPainter />}
        active={formatPainterActive}
        onClick={onFormatPainter}
        title={formatPainterActive ? 'Click a cell to apply the copied format (click again to cancel)' : 'Copy formatting from the selected cell, then click another cell to apply it'}
      />
    </>
  );
});

const HomeFontContent = memo(function HomeFontContent(props: {
  ev: RibbonEvents;
  fontName: string;
  fontSize: number;
  bold: boolean;
  italic: boolean;
  underlineActive: boolean;
  strikethrough: boolean;
  doubleUnderline: boolean;
}) {
  const { onBorderColor, onBorderStyle, onDoubleUnderline, onFormat, growFont, shrinkFont, toggleFormat: toggle } = props.ev;
  const { fontName, fontSize, bold, italic, underlineActive, strikethrough, doubleUnderline } = props;
  return (
    <>
      <RibbonSelect
        label="Font"
        value={fontName}
        options={FONT_NAMES}
        onChange={(v) => onFormat({ fontName: v })}
        title="Font name"
        width={110}
      />
      <RibbonSelect
        label="Size"
        value={String(fontSize)}
        options={FONT_SIZES.map(String)}
        onChange={(v) => onFormat({ fontSize: Number(v) })}
        title="Font size"
        width={56}
      />
      <RibbonButton label="B" active={bold} onClick={() => toggle('bold')} title="Bold (Ctrl+B)" />
      <RibbonButton label="I" active={italic} onClick={() => toggle('italic')} title="Italic (Ctrl+I)" />
      <RibbonButton label="U" active={underlineActive} onClick={() => toggle('underline')} title="Underline (Ctrl+U)" />
      <RibbonButton label="S" active={strikethrough} onClick={() => toggle('strikethrough')} title="Strikethrough" />
      <RibbonButton label="U=" active={doubleUnderline} onClick={onDoubleUnderline} title="Double underline" />
      <RibbonButton label="A+" icon={<Icons.IconFontGrow />} onClick={growFont} title="Increase font size" />
      <RibbonButton label="A−" icon={<Icons.IconFontShrink />} onClick={shrinkFont} title="Decrease font size" />
      <RibbonMenu label="A" title="Font color" icon={<Icons.IconFontColor />}>
        <ColorSwatches colors={THEME_COLORS} onPick={(c) => onFormat({ fontColor: c })} />
      </RibbonMenu>
      <RibbonMenu label="▦" title="Fill color" icon={<Icons.IconFillColor />}>
        <ColorSwatches colors={THEME_COLORS} onPick={(c) => onFormat({ fillColor: c })} />
      </RibbonMenu>
      <RibbonMenu label="Borders" title="Cell borders" icon={<Icons.IconBorders />}>
        {BORDER_PRESETS.map((p) => (
          <RibbonMenuItem
            key={p.name}
            label={p.name}
            onClick={() => onFormat({ borders: p.apply })}
          />
        ))}
        <RibbonSubmenu label="Border Color" title="Border color">
          {BORDER_COLORS.map((c) => (
            <RibbonMenuItem
              key={c}
              label={c}
              preview={<span style={{ display: 'inline-block', width: 12, height: 12, backgroundColor: c === 'Automatic' ? '#000' : c, marginRight: 6, border: '1px solid #999' }} />}
              onClick={() => onBorderColor(c)}
            />
          ))}
        </RibbonSubmenu>
        <RibbonSubmenu label="Border Style" title="Border line style">
          {BORDER_STYLES.map((s) => (
            <RibbonMenuItem key={s.id} label={s.label} onClick={() => onBorderStyle(s.id)} />
          ))}
        </RibbonSubmenu>
      </RibbonMenu>
    </>
  );
});

const HomeAlignmentContent = memo(function HomeAlignmentContent(props: {
  ev: RibbonEvents;
  hAlign: CellFormat['hAlign'];
  vAlign: CellFormat['vAlign'];
  wrapText: boolean;
}) {
  const { onFormat, onMerge, onOpenOrientation, onUnmerge, indentBy: indent, toggleFormat: toggle } = props.ev;
  const { hAlign, vAlign, wrapText } = props;
  return (
    <>
      <RibbonButton label="⇤" icon={<Icons.IconAlignLeft />} active={hAlign === 'left'} onClick={() => onFormat({ hAlign: 'left' })} title="Align left" />
      <RibbonButton label="⇔" icon={<Icons.IconAlignCenter />} active={hAlign === 'center'} onClick={() => onFormat({ hAlign: 'center' })} title="Center" />
      <RibbonButton label="⇥" icon={<Icons.IconAlignRight />} active={hAlign === 'right'} onClick={() => onFormat({ hAlign: 'right' })} title="Align right" />
      <RibbonButton label="⤒" icon={<Icons.IconAlignTop />} active={vAlign === 'top'} onClick={() => onFormat({ vAlign: 'top' })} title="Top align" />
      <RibbonButton label="↕" icon={<Icons.IconAlignMiddle />} active={vAlign === 'middle'} onClick={() => onFormat({ vAlign: 'middle' })} title="Middle align" />
      <RibbonButton label="⤓" icon={<Icons.IconAlignBottom />} active={vAlign === 'bottom'} onClick={() => onFormat({ vAlign: 'bottom' })} title="Bottom align" />
      <RibbonButton label="Wrap" icon={<Icons.IconWrapText />} active={wrapText} onClick={() => toggle('wrapText')} title="Wrap text" />
      <RibbonButton label="⇥+" icon={<Icons.IconIndentIncrease />} onClick={() => indent(1)} title="Increase indent" />
      <RibbonButton label="⇤−" icon={<Icons.IconIndentDecrease />} onClick={() => indent(-1)} title="Decrease indent" />
      <RibbonMenu label="Orientation" title="Text orientation" icon={<Icons.IconOrientation />}>
        <RibbonMenuItem label="Angle Counterclockwise" onClick={() => onFormat({ orientation: 45 })} title="Rotate text 45° counterclockwise" />
        <RibbonMenuItem label="Angle Clockwise" onClick={() => onFormat({ orientation: -45 })} title="Rotate text 45° clockwise" />
        <RibbonMenuItem label="Vertical Text" onClick={() => onFormat({ verticalText: true })} title="Stack text vertically" />
        <RibbonMenuItem label="Rotate Text Up" onClick={() => onFormat({ orientation: 90 })} title="Rotate text 90° up" />
        <RibbonMenuItem label="Rotate Text Down" onClick={() => onFormat({ orientation: -90 })} title="Rotate text 90° down" />
        <RibbonMenuItem label="Format Cell Alignment…" onClick={onOpenOrientation} title="Open the orientation dialog" />
      </RibbonMenu>
      <RibbonMenu label="Merge & Center" title="Merge cells" icon={<Icons.IconMergeCenter />}>
        <RibbonMenuItem label="Merge & Center" onClick={() => { onMerge(); onFormat({ hAlign: 'center', vAlign: 'middle' }); }} title="Merge the selected cells and center the content" />
        <RibbonMenuItem label="Merge Across" onClick={() => onMerge()} title="Merge cells in each row separately" />
        <RibbonMenuItem label="Merge Cells" onClick={() => onMerge()} title="Merge the selected cells" />
        <RibbonMenuItem label="Unmerge Cells" onClick={onUnmerge} title="Unmerge the selected merged range" />
      </RibbonMenu>
    </>
  );
});

const HomeNumberContent = memo(function HomeNumberContent(props: {
  ev: RibbonEvents;
  numberFormat: string;
}) {
  const { onAccounting, onDecreaseDecimal, onFormat, onIncreaseDecimal } = props.ev;
  const { numberFormat } = props;
  return (
    <>
      <RibbonSelect
        label="Format"
        value={numberFormat}
        options={NUMBER_FORMATS}
        onChange={(v) => onFormat({ numberFormat: v as NumberFormat })}
        title="Number format"
        width={100}
      />
      <RibbonButton label="%" icon={<Icons.IconPercent />} onClick={() => onFormat({ numberFormat: 'Percentage' })} title="Percent style" />
      <RibbonMenu label="$" title="Accounting format" icon={<Icons.IconAccounting />}>
        {ACCOUNTING_CURRENCIES.map((c) => (
          <RibbonMenuItem
            key={c.code}
            label={`${c.symbol} ${c.label}`}
            onClick={() => onAccounting(c.symbol)}
          />
        ))}
      </RibbonMenu>
      <RibbonButton label="," icon={<Icons.IconComma />} onClick={() => onFormat({ numberFormat: 'Number' })} title="Comma style (thousands separator)" />
      <RibbonButton label=".0→" icon={<Icons.IconIncreaseDecimal />} onClick={onIncreaseDecimal} title="Increase decimal places" />
      <RibbonButton label="←.0" icon={<Icons.IconDecreaseDecimal />} onClick={onDecreaseDecimal} title="Decrease decimal places" />
    </>
  );
});

const HomeStylesContent = memo(function HomeStylesContent(props: {
  ev: RibbonEvents;
}) {
  const { onCellStyle, onClearCF, onOpenCF, onOpenColorScaleCF, onOpenDataBarCF, onOpenIconSetCF, onOpenManageCFRules, onOpenNewCFRule, onOpenTableStyleGallery, onOpenTopBottomCF } = props.ev;
  return (
    <>
      <RibbonMenu label="Conditional Formatting" title="Highlight cells with rules" icon={<Icons.IconConditionalFormatting />}>
        <RibbonSubmenu label="Highlight Cell Rules" title="Highlight cells by value">
          <RibbonMenuItem label="Greater Than…" onClick={onOpenCF} />
          <RibbonMenuItem label="Less Than…" onClick={onOpenCF} />
          <RibbonMenuItem label="Between…" onClick={onOpenCF} />
          <RibbonMenuItem label="Equal To…" onClick={onOpenCF} />
          <RibbonMenuItem label="Text Contains…" onClick={onOpenCF} />
          <RibbonMenuItem label="Duplicate Values…" onClick={onOpenCF} title="Highlights cells whose value appears more than once (uses Equal To on duplicates)" />
        </RibbonSubmenu>
        <RibbonSubmenu label="Top/Bottom Rules" title="Highlight top or bottom values">
          <RibbonMenuItem label="Top 10…" onClick={onOpenTopBottomCF} />
          <RibbonMenuItem label="Bottom 10…" onClick={onOpenTopBottomCF} />
          <RibbonMenuItem label="Above Average…" onClick={onOpenTopBottomCF} />
        </RibbonSubmenu>
        <RibbonSubmenu label="Data Bars" title="Show bars proportional to values">
          <RibbonMenuItem label="Choose Color…" onClick={onOpenDataBarCF} />
        </RibbonSubmenu>
        <RibbonSubmenu label="Color Scales" title="Shade cells by value">
          <RibbonMenuItem label="Choose Scale…" onClick={onOpenColorScaleCF} />
        </RibbonSubmenu>
        <RibbonSubmenu label="Icon Sets" title="Show icons by value">
          <RibbonMenuItem label="3 Arrows…" onClick={onOpenIconSetCF} />
        </RibbonSubmenu>
        <RibbonMenuItem label="New Rule…" onClick={onOpenNewCFRule} title="Create a custom conditional formatting rule" />
        <RibbonMenuItem label="Manage Rules…" onClick={onOpenManageCFRules} title="View, edit, and reorder all conditional formatting rules" />
        <RibbonMenuItem label="Clear Rules" onClick={onClearCF} title="Remove highlight rules on the selected cell" />
      </RibbonMenu>
      <RibbonMenu label="Cell Styles" title="Apply a preset cell style" icon={<Icons.IconCellStyles />}>
        {CELL_STYLE_NAMES.map((name) => (
          <RibbonMenuItem key={name} label={name} onClick={() => onCellStyle(name)} />
        ))}
      </RibbonMenu>
      <RibbonButton label="Format as Table" icon={<Icons.IconFormatAsTable />} onClick={onOpenTableStyleGallery} title="Apply a table style from the gallery" />
    </>
  );
});

const HomeCellsContent = memo(function HomeCellsContent(props: {
  ev: RibbonEvents;
}) {
  const { onAutoFitColumnWidth, onAutoFitRowHeight, onColWidth, onDefaultWidth, onDeleteCells, onDeleteCol, onDeleteRow, onHideCol, onHideRow, onInsertCells, onInsertCol, onInsertRow, onMoveCopySheet, onOpenFormatCells, onRenameSheet, onRowHeight, onUnhideCols, onUnhideRows } = props.ev;
  return (
    <>
      <RibbonMenu label="Insert" title="Insert cells, rows, or columns" icon={<Icons.IconInsertRow />}>
        <RibbonMenuItem label="Insert Cells…" onClick={onInsertCells} title="Insert cells, shifting existing cells" />
        <RibbonMenuItem label="Insert Sheet Rows" onClick={onInsertRow} title="Insert rows above the selection" />
        <RibbonMenuItem label="Insert Sheet Columns" onClick={onInsertCol} title="Insert columns left of the selection" />
      </RibbonMenu>
      <RibbonMenu label="Delete" title="Delete cells, rows, or columns" icon={<Icons.IconDeleteRow />}>
        <RibbonMenuItem label="Delete Cells…" onClick={onDeleteCells} title="Delete cells, shifting remaining cells" />
        <RibbonMenuItem label="Delete Sheet Rows" onClick={onDeleteRow} title="Delete the selected rows" />
        <RibbonMenuItem label="Delete Sheet Columns" onClick={onDeleteCol} title="Delete the selected columns" />
      </RibbonMenu>
      <RibbonMenu label="Format" title="Row height, column width, hide, rename" icon={<Icons.IconRowHeight />}>
        <RibbonMenuItem label="Row Height…" onClick={onRowHeight} title="Set the height of the selected row" />
        <RibbonMenuItem label="AutoFit Row Height" onClick={onAutoFitRowHeight} title="Size rows to fit their content" />
        <RibbonMenuItem label="Column Width…" onClick={onColWidth} title="Set the width of the selected column" />
        <RibbonMenuItem label="AutoFit Column Width" onClick={onAutoFitColumnWidth} title="Size columns to fit their content" />
        <RibbonMenuItem label="Default Width…" onClick={onDefaultWidth} title="Set the default column width" />
        <RibbonSubmenu label="Hide & Unhide" title="Hide or show rows and columns">
          <RibbonMenuItem label="Hide Row" onClick={onHideRow} />
          <RibbonMenuItem label="Hide Column" onClick={onHideCol} />
          <RibbonMenuItem label="Unhide Rows" onClick={onUnhideRows} />
          <RibbonMenuItem label="Unhide Columns" onClick={onUnhideCols} />
        </RibbonSubmenu>
        <RibbonMenuItem label="Rename Sheet…" onClick={onRenameSheet} title="Rename the current sheet" />
        <RibbonMenuItem label="Move or Copy Sheet…" onClick={onMoveCopySheet} title="Move or copy the current sheet" />
        <RibbonMenuItem label="Format Cells…" onClick={onOpenFormatCells} title="Open the Format Cells dialog (Ctrl+1)" />
      </RibbonMenu>
    </>
  );
});

const HomeEditingContent = memo(function HomeEditingContent(props: {
  ev: RibbonEvents;
  canUndo: boolean;
  canRedo: boolean;
  selectObjectsMode: boolean;
}) {
  const { onAutoSum, onClear, onClearAll, onClearComments, onClearFilter, onClearFormat, onClearHyperlinks, onCustomSort, onFill, onFillSeries, onFind, onJustify, onOpenAdvancedFilter, onOpenFnDialog, onOpenGoTo, onOpenGoToSpecial, onReapplyFilter, onRedo, onSortAsc, onSortDesc, onToggleSelectObjects, onUndo, openFilterSel } = props.ev;
  const { canUndo, canRedo, selectObjectsMode } = props;
  return (
    <>
      <RibbonMenu label="AutoSum" title="Insert a summary formula" icon={<Icons.IconAutoSum />}>
        {AUTOSUM_FNS.map((f) => (
          <RibbonMenuItem key={f.fn} label={f.name} onClick={() => onAutoSum(f.fn)} title={`Insert =${f.fn}()`} />
        ))}
        <RibbonMenuItem label="More Functions…" onClick={onOpenFnDialog} title="Browse all functions" />
      </RibbonMenu>
      <RibbonMenu label="Fill" title="Fill cells" icon={<Icons.IconFill />}>
        <RibbonMenuItem label="Down" onClick={() => onFill('down')} title="Fill down (Ctrl+D)" />
        <RibbonMenuItem label="Right" onClick={() => onFill('right')} title="Fill right (Ctrl+R)" />
        <RibbonMenuItem label="Up" onClick={() => onFill('up')} title="Fill up" />
        <RibbonMenuItem label="Left" onClick={() => onFill('left')} title="Fill left" />
        <RibbonMenuItem label="Series…" onClick={onFillSeries} title="Fill a series with options" />
        <RibbonMenuItem label="Justify" onClick={onJustify} title="Redistribute text across columns" />
      </RibbonMenu>
      <RibbonMenu label="Clear" title="Clear cell contents or formatting" icon={<Icons.IconClear />}>
        <RibbonMenuItem label="Clear All" onClick={onClearAll} title="Clear contents and formatting" />
        <RibbonMenuItem label="Clear Formats" onClick={onClearFormat} title="Remove formatting only" />
        <RibbonMenuItem label="Clear Contents" onClick={onClear} title="Clear contents only" />
        <RibbonMenuItem label="Clear Comments and Notes" onClick={onClearComments} title="Remove comments and notes" />
        <RibbonMenuItem label="Clear Hyperlinks" onClick={onClearHyperlinks} title="Remove hyperlinks, keep text" />
      </RibbonMenu>
      <RibbonMenu label="Sort & Filter" title="Sort and filter data" icon={<Icons.IconSortFilter />}>
        <RibbonMenuItem label="Sort A to Z" onClick={onSortAsc} />
        <RibbonMenuItem label="Sort Z to A" onClick={onSortDesc} />
        <RibbonMenuItem label="Custom Sort…" onClick={onCustomSort} />
        <RibbonMenuItem label="Filter" onClick={openFilterSel} />
        <RibbonMenuItem label="Clear Filter" onClick={onClearFilter} />
        <RibbonMenuItem label="Reapply" onClick={onReapplyFilter} title="Reapply the current filter" />
        <RibbonMenuItem label="Advanced…" onClick={onOpenAdvancedFilter} title="Advanced filter with criteria range" />
      </RibbonMenu>
      <RibbonMenu label="Find & Select" title="Find, replace, and navigate" icon={<Icons.IconFind />}>
        <RibbonMenuItem label="Find…" onClick={onFind} title="Find text (Ctrl+F)" />
        <RibbonMenuItem label="Replace…" onClick={onFind} title="Find and replace text (Ctrl+H)" />
        <RibbonMenuItem label="Go To…" onClick={onOpenGoTo} title="Go to a cell reference (Ctrl+G)" />
        <RibbonMenuItem label="Go To Special…" onClick={onOpenGoToSpecial} title="Select cells by type" />
        <RibbonMenuItem label={selectObjectsMode ? "✓ Select Objects" : "Select Objects"} onClick={onToggleSelectObjects} title="Select drawing objects instead of cells" />
      </RibbonMenu>
      <RibbonButton label="Undo" icon={<Icons.IconUndo />} onClick={onUndo} disabled={!canUndo} title="Undo (Ctrl+Z)" />
      <RibbonButton label="Redo" icon={<Icons.IconRedo />} onClick={onRedo} disabled={!canRedo} title="Redo (Ctrl+Y)" />
    </>
  );
});

const InsertTablesContent = memo(function InsertTablesContent(props: {
  ev: RibbonEvents;
}) {
  const { onFormatAsTable, onInsertPivotTable, onOpenRecommendedPivots } = props.ev;
  return (
    <>
      <RibbonButton label="Table" size="large" icon={<Icons.IconTable />} onClick={onFormatAsTable} title="Format the used range as a table (banded rows)" />
      <RibbonButton label="PivotTable" size="large" icon={<Icons.IconPivotTable />} onClick={onInsertPivotTable} title="Summarize the used range with a PivotTable" />
      <RibbonButton label="Recommended PivotTables" icon={<Icons.IconRecommendedPivot />} onClick={onOpenRecommendedPivots} title="Get suggested PivotTable layouts for your data" />
    </>
  );
});

const InsertAppsContent = memo(function InsertAppsContent(props: {
  ev: RibbonEvents;
  appList: { id: string; name: string }[];
}) {
  const { onOpenApp, onOpenAppBuilder } = props.ev;
  const { appList } = props;
  return (
    <>
      <RibbonButton label="Build App" size="large" icon={<Icons.IconBuildApp />} onClick={onOpenAppBuilder} title="Generate a no-code data app from a table" />
      <RibbonMenu label="My Apps" title="Open a saved app" icon={<Icons.IconBuildApp />}>
        {appList.length === 0 && (
          <RibbonMenuItem label="No apps yet" onClick={() => {}} disabled title="Build your first app with Build App" />
        )}
        {appList.map((a) => (
          <RibbonMenuItem key={a.id} label={a.name} onClick={() => onOpenApp(a.id)} title={`Open ${a.name}`} />
        ))}
      </RibbonMenu>
    </>
  );
});

const InsertFiltersContent = memo(function InsertFiltersContent(props: {
  ev: RibbonEvents;
}) {
  const { onInsertSlicer, onInsertTimeline } = props.ev;
  return (
    <>
      <RibbonButton label="Slicer" icon={<Icons.IconSlicer />} onClick={onInsertSlicer} title="Insert a slicer: visual filter buttons for the selected column" />
      <RibbonButton label="Timeline" icon={<Icons.IconTimeline />} onClick={onInsertTimeline} title="Insert a timeline: visual date-range filter for the selected date column" />
    </>
  );
});

const InsertSparklinesContent = memo(function InsertSparklinesContent(props: {
  ev: RibbonEvents;
}) {
  const { onInsertSparkline, onRemoveSparkline } = props.ev;
  return (
    <>
      <RibbonButton label="Sparkline" icon={<Icons.IconSparkline />} onClick={onInsertSparkline} title="Insert a sparkline (mini in-cell chart) for the selected data" />
      <RibbonButton label="Remove Sparkline" icon={<Icons.IconRemoveSparkline />} onClick={onRemoveSparkline} title="Remove the sparkline at the selected cell" />
    </>
  );
});

const InsertIllustrationsContent = memo(function InsertIllustrationsContent(props: {
  ev: RibbonEvents;
}) {
  const { onInsertPicture, onInsertShape, onOpenIcons, onOpenScreenshot, onOpenSmartArt } = props.ev;
  return (
    <>
      <RibbonButton label="Pictures" icon={<Icons.IconPicture />} onClick={onInsertPicture} title="Insert a picture from your device" />
      <RibbonMenu label="Shapes" title="Insert a shape (full Excel gallery)" icon={<Icons.IconShapes />}>
        {SHAPE_CATEGORIES.map((cat: { id: ShapeCategoryId; label: string }) => (
          <RibbonSubmenu key={cat.id} label={cat.label} title={`${cat.label} shapes`}>
            {shapesByCategory(cat.id).map((s) => (
              <RibbonMenuItem key={s.id} label={s.name} onClick={() => onInsertShape(s.id)} />
            ))}
          </RibbonSubmenu>
        ))}
      </RibbonMenu>
      <RibbonButton label="Icons" icon={<Icons.IconIcons />} onClick={onOpenIcons} title="Insert an icon from the gallery" />
      <RibbonButton label="SmartArt" icon={<Icons.IconSmartArt />} onClick={onOpenSmartArt} title="Insert a SmartArt graphic" />
      <RibbonButton label="Screenshot" icon={<Icons.IconScreenshot />} onClick={onOpenScreenshot} title="Capture a screenshot to insert" />
    </>
  );
});

const InsertChartsContent = memo(function InsertChartsContent(props: {
  ev: RibbonEvents;
}) {
  const { onInsertChart, onOpenPivotChart, onOpenRecommendedCharts } = props.ev;
  return (
    <>
      <RibbonMenu label="Insert Chart" title="Chart the selected data range" icon={<Icons.IconInsertChart />}>
        {CHART_GROUPS.map((g) => (
          <RibbonSubmenu key={g.id} label={g.label} title={`${g.label} charts`}>
            {g.kinds.map((k) => (
              <RibbonMenuItem key={k.id} label={k.label} onClick={() => onInsertChart(k.id)} />
            ))}
          </RibbonSubmenu>
        ))}
      </RibbonMenu>
      <RibbonButton label="Recommended Charts" icon={<Icons.IconRecommendedChart />} onClick={onOpenRecommendedCharts} title="Get chart recommendations for your data" />
      <RibbonButton label="PivotChart" icon={<Icons.IconPivotChart />} onClick={onOpenPivotChart} title="Chart an existing PivotTable" />
    </>
  );
});

const InsertLinksContent = memo(function InsertLinksContent(props: {
  ev: RibbonEvents;
}) {
  const { onClearHyperlinks, onOpenLinkDialog } = props.ev;
  return (
    <>
      <RibbonMenu label="Link" title="Insert or manage hyperlinks" icon={<Icons.IconHyperlink />}>
        <RibbonMenuItem label="Insert Link…" onClick={onOpenLinkDialog} title="Insert a hyperlink (Ctrl+K)" />
        <RibbonMenuItem label="Remove Link" onClick={onClearHyperlinks} title="Remove hyperlinks, keep text" />
      </RibbonMenu>
    </>
  );
});

const InsertTextContent = memo(function InsertTextContent(props: {
  ev: RibbonEvents;
}) {
  const { onInsertTextBox, onOpenHeaderFooter, onOpenWordArt } = props.ev;
  return (
    <>
      <RibbonButton label="Text Box" icon={<Icons.IconTextBox />} onClick={onInsertTextBox} title="Insert a floating text box" />
      <RibbonButton label="Header & Footer" icon={<Icons.IconHeaderFooter />} onClick={onOpenHeaderFooter} title="Edit headers and footers" />
      <RibbonButton label="WordArt" icon={<Icons.IconWordArt />} onClick={onOpenWordArt} title="Insert decorative text" />
    </>
  );
});

const InsertSymbolsContent = memo(function InsertSymbolsContent(props: {
  ev: RibbonEvents;
}) {
  const { onOpenEquation, onOpenSymbol } = props.ev;
  return (
    <>
      <RibbonMenu label="Equation" title="Insert a math equation" icon={<Icons.IconEquation />}>
        <RibbonMenuItem label="Insert New Equation" onClick={onOpenEquation} title="Build an equation with the editor" />
      </RibbonMenu>
      <RibbonButton label="Symbol" icon={<Icons.IconSymbol />} onClick={onOpenSymbol} title="Insert a special character" />
    </>
  );
});

const InsertReportsContent = memo(function InsertReportsContent(props: {
  ev: RibbonEvents;
}) {
  const { onNewReport, onOpenReports } = props.ev;
  return (
    <>
      <RibbonButton label="New Report" size="large" icon={<Icons.IconNewReport />} onClick={onNewReport} title="Build a report from the current sheet's table (charts, PivotTables, KPI cards)" />
      <RibbonButton label="My Reports" icon={<Icons.IconReports />} onClick={onOpenReports} title="Open the report gallery" />
    </>
  );
});

const InsertSheetsContent = memo(function InsertSheetsContent(props: {
  ev: RibbonEvents;
}) {
  const { onDeleteSheet, addSheet } = props.ev;
  return (
    <>
      <RibbonButton
        label="New Sheet"
        size="large"
        icon={<Icons.IconNewSheet />}
        onClick={addSheet}
        title="Add a new sheet to the workbook"
      />
      <RibbonButton
        label="Delete Sheet"
        size="large"
        icon={<Icons.IconDeleteSheet />}
        onClick={onDeleteSheet}
        title="Remove the current sheet from view"
      />
    </>
  );
});

const InsertRowsColumnsContent = memo(function InsertRowsColumnsContent(props: {
  ev: RibbonEvents;
}) {
  const { onDeleteCol, onDeleteRow, onInsertCol, onInsertRow } = props.ev;
  return (
    <>
      <RibbonButton label="Insert Row" icon={<Icons.IconInsertRow />} onClick={onInsertRow} title="Insert a blank row above the selection" />
      <RibbonButton label="Delete Row" icon={<Icons.IconDeleteRow />} onClick={onDeleteRow} title="Delete the selected row" />
      <RibbonButton label="Insert Column" icon={<Icons.IconInsertColumn />} onClick={onInsertCol} title="Insert a blank column left of the selection" />
      <RibbonButton label="Delete Column" icon={<Icons.IconDeleteColumn />} onClick={onDeleteCol} title="Delete the selected column" />
    </>
  );
});

const InsertFormControlsContent = memo(function InsertFormControlsContent(props: {
  ev: RibbonEvents;
}) {
  const { onInsertFormControl } = props.ev;
  return (
    <>
      <RibbonMenu label="Controls" title="Insert a form control bound to the selected cell" icon={<Icons.IconFormControls />}>
        {FORM_CONTROL_KINDS.map((c) => (
          <RibbonMenuItem key={c.id} label={c.label} onClick={() => onInsertFormControl(c.id)} />
        ))}
      </RibbonMenu>
    </>
  );
});

const InsertMapsContent = memo(function InsertMapsContent(props: {
  ev: RibbonEvents;
}) {
  const { onOpenGlobeSetup } = props.ev;
  return (
    <>
      <RibbonButton label="3D Map" icon={<Icons.IconMap3d />} onClick={onOpenGlobeSetup} title="Plot locations or latitude/longitude data on a 3D globe" />
    </>
  );
});

const DrawToolsContent = memo(function DrawToolsContent(props: {
  ev: RibbonEvents;
  inkTool: string;
}) {
  const { onSetInkTool } = props.ev;
  const { inkTool } = props;
  return (
    <>
      <RibbonButton label="Pen" size="large" icon={<Icons.IconPen />} active={inkTool === 'pen'} onClick={() => onSetInkTool('pen')} title="Draw with the pen" />
      <RibbonButton label="Highlighter" size="large" icon={<Icons.IconHighlighter />} active={inkTool === 'highlighter'} onClick={() => onSetInkTool('highlighter')} title="Highlight with the highlighter" />
      <RibbonButton label="Eraser" icon={<Icons.IconEraser />} active={inkTool === 'eraser'} onClick={() => onSetInkTool('eraser')} title="Erase ink strokes" />
      <RibbonButton label="Ruler" icon={<Icons.IconRuler />} active={inkTool === 'ruler'} onClick={() => onSetInkTool('ruler')} title="Draw straight lines with the ruler" />
      <RibbonButton label="Lasso Select" icon={<Icons.IconLasso />} active={inkTool === 'lasso'} onClick={() => onSetInkTool('lasso')} title="Select ink strokes with the lasso" />
    </>
  );
});

const DrawConvertContent = memo(function DrawConvertContent(props: {
  ev: RibbonEvents;
}) {
  const { onInkConvert } = props.ev;
  return (
    <>
      <RibbonButton label="Ink to Text" icon={<Icons.IconInkToText />} onClick={() => onInkConvert('text')} title="Convert selected ink to text" />
      <RibbonButton label="Ink to Shape" icon={<Icons.IconShapes />} onClick={() => onInkConvert('shape')} title="Convert selected ink to a shape" />
      <RibbonButton label="Ink to Math" icon={<Icons.IconEquation />} onClick={() => onInkConvert('math')} title="Convert selected ink to a math expression" />
    </>
  );
});

const DrawCanvasContent = memo(function DrawCanvasContent(props: {
  ev: RibbonEvents;
}) {
  const { onInsertDrawingCanvas } = props.ev;
  return (
    <>
      <RibbonButton label="Drawing Canvas" icon={<Icons.IconTextBox />} onClick={onInsertDrawingCanvas} title="Insert a bounded drawing canvas" />
    </>
  );
});

const PageLayoutThemesContent = memo(function PageLayoutThemesContent(props: {
  ev: RibbonEvents;
}) {
  const { onOpenThemes } = props.ev;
  return (
    <>
      <RibbonButton label="Themes" size="large" icon={<Icons.IconThemes />} onClick={onOpenThemes} title="Apply a workbook theme (colors, fonts, effects)" />
    </>
  );
});

const PageLayoutPageSetupContent = memo(function PageLayoutPageSetupContent(props: {
  ev: RibbonEvents;
}) {
  const { onClearPrintArea, onInsertPageBreak, onOpenBackground, onOpenPageSetup, onOpenPrintPreview, onOpenPrintTitles, onRemovePageBreak, onResetPageBreaks, onSetMargins, onSetPageOrientation, onSetPaperSize, onSetPrintArea } = props.ev;
  return (
    <>
      <RibbonMenu label="Margins" title="Page margins" icon={<Icons.IconMargins />}>
        <RibbonMenuItem label="Normal" onClick={() => onSetMargins('normal')} title="Normal margins" />
        <RibbonMenuItem label="Wide" onClick={() => onSetMargins('wide')} title="Wide margins" />
        <RibbonMenuItem label="Narrow" onClick={() => onSetMargins('narrow')} title="Narrow margins" />
        <RibbonMenuItem label="Custom Margins…" onClick={onOpenPageSetup} title="Set custom margins" />
      </RibbonMenu>
      <RibbonMenu label="Orientation" title="Page orientation" icon={<Icons.IconPageOrientation />}>
        <RibbonMenuItem label="Portrait" onClick={() => onSetPageOrientation('portrait')} title="Portrait orientation" />
        <RibbonMenuItem label="Landscape" onClick={() => onSetPageOrientation('landscape')} title="Landscape orientation" />
      </RibbonMenu>
      <RibbonMenu label="Size" title="Paper size" icon={<Icons.IconPageSize />}>
        {['Letter', 'A4', 'Legal', 'A3', 'Tabloid'].map((s) => (
          <RibbonMenuItem key={s} label={s} onClick={() => onSetPaperSize(s)} />
        ))}
      </RibbonMenu>
      <RibbonMenu label="Print Area" title="Set the print area" icon={<Icons.IconPrintArea />}>
        <RibbonMenuItem label="Set Print Area" onClick={onSetPrintArea} title="Print only the selected cells" />
        <RibbonMenuItem label="Clear Print Area" onClick={onClearPrintArea} title="Print the whole sheet" />
      </RibbonMenu>
      <RibbonMenu label="Breaks" title="Page breaks" icon={<Icons.IconPageBreaks />}>
        <RibbonMenuItem label="Insert Page Break" onClick={onInsertPageBreak} title="Insert a page break at the selection" />
        <RibbonMenuItem label="Remove Page Break" onClick={onRemovePageBreak} title="Remove the page break at the selection" />
        <RibbonMenuItem label="Reset All Page Breaks" onClick={onResetPageBreaks} title="Remove all manual page breaks" />
      </RibbonMenu>
      <RibbonButton label="Background" icon={<Icons.IconPicture />} onClick={onOpenBackground} title="Set a sheet background" />
      <RibbonButton label="Print Titles" icon={<Icons.IconPrintTitles />} onClick={onOpenPrintTitles} title="Repeat rows/columns on every printed page" />
      <RibbonButton label="Print Preview" icon={<Icons.IconPrintPreview />} onClick={onOpenPrintPreview} title="Preview how the sheet will print" />
    </>
  );
});

const PageLayoutScaleToFitContent = memo(function PageLayoutScaleToFitContent(props: {
  ev: RibbonEvents;
}) {
  const { onSetScaleToFit } = props.ev;
  return (
    <>
      <RibbonMenu label="Width" title="Fit to pages wide" icon={<Icons.IconScaleToFit />}>
        {[1, 2, 3].map((n) => (
          <RibbonMenuItem key={n} label={`${n} page${n > 1 ? 's' : ''}`} onClick={() => onSetScaleToFit(n, 0, 0)} />
        ))}
        <RibbonMenuItem label="Automatic" onClick={() => onSetScaleToFit(0, 0, 100)} />
      </RibbonMenu>
      <RibbonMenu label="Height" title="Fit to pages tall" icon={<Icons.IconScaleToFit />}>
        {[1, 2, 3].map((n) => (
          <RibbonMenuItem key={n} label={`${n} page${n > 1 ? 's' : ''}`} onClick={() => onSetScaleToFit(0, n, 0)} />
        ))}
        <RibbonMenuItem label="Automatic" onClick={() => onSetScaleToFit(0, 0, 100)} />
      </RibbonMenu>
    </>
  );
});

const PageLayoutSheetOptionsContent = memo(function PageLayoutSheetOptionsContent(props: {
  ev: RibbonEvents;
  showGridlines: boolean;
  showHeadings: boolean;
  printGridlines: boolean;
  printHeadings: boolean;
}) {
  const { onToggleGridlines, onToggleHeadings, onTogglePrintGridlines, onTogglePrintHeadings } = props.ev;
  const { showGridlines, showHeadings, printGridlines, printHeadings } = props;
  return (
    <>
      <RibbonButton
        label="Gridlines"
        icon={<Icons.IconGridlines />}
        active={showGridlines}
        onClick={onToggleGridlines}
        title="Show or hide gridlines"
      />
      <RibbonButton
        label="Headings"
        icon={<Icons.IconHeadings />}
        active={showHeadings}
        onClick={onToggleHeadings}
        title="Show or hide row/column headings"
      />
      <RibbonButton
        label="Print Gridlines"
        active={printGridlines}
        onClick={onTogglePrintGridlines}
        title="Print gridlines"
      />
      <RibbonButton
        label="Print Headings"
        active={printHeadings}
        onClick={onTogglePrintHeadings}
        title="Print row/column headings"
      />
    </>
  );
});

const PageLayoutArrangeContent = memo(function PageLayoutArrangeContent(props: {
  ev: RibbonEvents;
}) {
  const { onAlignObjects, onBringForward, onOpenSelectionPane, onRotateObjects, onSendBackward } = props.ev;
  return (
    <>
      <RibbonButton label="Bring Forward" icon={<Icons.IconBringForward />} onClick={onBringForward} title="Bring the selected object forward" />
      <RibbonButton label="Send Backward" icon={<Icons.IconSendBackward />} onClick={onSendBackward} title="Send the selected object backward" />
      <RibbonButton label="Selection Pane" icon={<Icons.IconSelectionPane />} onClick={onOpenSelectionPane} title="Show the selection pane" />
      <RibbonMenu label="Align" title="Align selected objects" icon={<Icons.IconAlignCenter />}>
        {['Left', 'Center', 'Right', 'Top', 'Middle', 'Bottom'].map((m) => (
          <RibbonMenuItem key={m} label={`Align ${m}`} onClick={() => onAlignObjects(m.toLowerCase())} />
        ))}
      </RibbonMenu>
      <RibbonMenu label="Rotate" title="Rotate or flip the selected object" icon={<Icons.IconRuler />}>
        <RibbonMenuItem label="Rotate Right 90°" onClick={() => onRotateObjects('right')} />
        <RibbonMenuItem label="Rotate Left 90°" onClick={() => onRotateObjects('left')} />
        <RibbonMenuItem label="Flip Horizontal" onClick={() => onRotateObjects('flipH')} />
        <RibbonMenuItem label="Flip Vertical" onClick={() => onRotateObjects('flipV')} />
      </RibbonMenu>
    </>
  );
});

const FormulasFunctionLibraryContent = memo(function FormulasFunctionLibraryContent(props: {
  ev: RibbonEvents;
  fnCategories: string[];
  recentFunctions: string[];
}) {
  const { onAutoSum, onInsertFunction, onOpenFnDialog, onOpenFnDialogFor } = props.ev;
  const { fnCategories, recentFunctions } = props;
  return (
    <>
      <RibbonButton label="Insert Function" size="large" icon={<Icons.IconInsertFunction />} onClick={onOpenFnDialog} title="Browse all engine functions by category" />
      <RibbonMenu label="AutoSum" title="Insert a summary formula" icon={<Icons.IconAutoSum />}>
        {AUTOSUM_FNS.map((f) => (
          <RibbonMenuItem key={f.fn} label={f.name} onClick={() => onAutoSum(f.fn)} title={`Insert =${f.fn}()`} />
        ))}
        <RibbonMenuItem label="More Functions…" onClick={onOpenFnDialog} title="Browse all functions" />
      </RibbonMenu>
      <RibbonMenu label="Recently Used" title="Recently used functions" icon={<Icons.IconMoreFunctions />}>
        {recentFunctions.length === 0 && (
          <RibbonMenuItem label="No recent functions" onClick={() => {}} disabled title="Use Insert Function to get started" />
        )}
        {recentFunctions.map((fn) => (
          <RibbonMenuItem key={fn} label={fn} onClick={() => onInsertFunction(`=${fn}()`)} title={`Insert =${fn}()`} />
        ))}
      </RibbonMenu>
      {['Financial', 'Logical', 'Text', 'Date & Time', 'Lookup & Reference', 'Math & Trig'].map((cat) => (
        <RibbonButton
          key={cat}
          label={cat}
          icon={<Icons.IconMoreFunctions />}
          onClick={() => onOpenFnDialogFor(cat)}
          title={`Browse ${cat} functions`}
        />
      ))}
      <RibbonMenu label="More" title="More function categories" icon={<Icons.IconMoreFunctions />}>
        {fnCategories
          .filter((c) => !['Financial', 'Logical', 'Text', 'Date & Time', 'Lookup & Reference', 'Math & Trig', 'All'].includes(c))
          .map((cat) => (
            <RibbonMenuItem key={cat} label={cat} onClick={() => onOpenFnDialogFor(cat)} />
          ))}
      </RibbonMenu>
    </>
  );
});

const FormulasDefinedNamesContent = memo(function FormulasDefinedNamesContent(props: {
  ev: RibbonEvents;
}) {
  const { onOpenApplyNames, onOpenCreateFromSelection, onOpenDefineName, onOpenNameManager, onOpenNamedFunctions, onOpenUseInFormula } = props.ev;
  return (
    <>
      <RibbonButton label="Name Manager" size="large" icon={<Icons.IconNameManager />} onClick={onOpenNameManager} title="Create, edit, and delete named ranges" />
      <RibbonButton label="Define Name" icon={<Icons.IconDefineName />} onClick={onOpenDefineName} title="Define a name for the selection" />
      <RibbonButton label="Named Functions" icon={<Icons.IconDefineName />} onClick={onOpenNamedFunctions} title="Define and manage named functions (LAMBDA/JS/TS/Python)" />
      <RibbonMenu label="Use in Formula" title="Insert a defined name" icon={<Icons.IconUseInFormula />}>
        <RibbonMenuItem label="Insert Name…" onClick={onOpenUseInFormula} title="Pick a name to insert" />
      </RibbonMenu>
      <RibbonButton label="Create from Selection" icon={<Icons.IconCreateFromSelection />} onClick={onOpenCreateFromSelection} title="Create names from row/column labels" />
      <RibbonButton label="Apply Names" icon={<Icons.IconApplyNames />} onClick={onOpenApplyNames} title="Replace references with names in formulas" />
    </>
  );
});

const FormulasFormulaAuditingContent = memo(function FormulasFormulaAuditingContent(props: {
  ev: RibbonEvents;
  showFormulas: boolean;
  watchWindowOpen: boolean;
}) {
  const { onOpenErrorChecking, onOpenEvaluateFormula, onRemoveArrows, onToggleShowFormulas, onToggleWatchWindow, onTraceDependents, onTracePrecedents } = props.ev;
  const { showFormulas, watchWindowOpen } = props;
  return (
    <>
      <RibbonButton label="Trace Precedents" icon={<Icons.IconTracePrecedents />} onClick={onTracePrecedents} title="Show arrows to cells that feed this formula" />
      <RibbonButton label="Trace Dependents" icon={<Icons.IconTraceDependents />} onClick={onTraceDependents} title="Show arrows to cells that use this cell" />
      <RibbonButton label="Remove Arrows" icon={<Icons.IconRemoveArrows />} onClick={onRemoveArrows} title="Clear tracer arrows" />
      <RibbonButton
        label="Show Formulas"
        size="large"
        icon={<Icons.IconShowFormulas />}
        active={showFormulas}
        onClick={onToggleShowFormulas}
        title="Show formulas instead of calculated values"
      />
      <RibbonButton label="Error Checking" icon={<Icons.IconErrorChecking />} onClick={onOpenErrorChecking} title="Find and fix formula errors" />
      <RibbonButton label="Evaluate Formula" icon={<Icons.IconEvaluateFormula />} onClick={onOpenEvaluateFormula} title="Step through formula evaluation" />
      <RibbonButton label="Watch Window" icon={<Icons.IconWatchWindow />} active={watchWindowOpen} onClick={onToggleWatchWindow} title="Monitor cell values in the Watch Window" />
    </>
  );
});

const FormulasCalculationContent = memo(function FormulasCalculationContent(props: {
  ev: RibbonEvents;
  calcMode: CalculationMode;
}) {
  const { onCalculateSheet, onOpenIterative, onOpenParallelCalc, onRecalculate, onSetCalcMode } = props.ev;
  const { calcMode } = props;
  return (
    <>
      <RibbonButton
        label="Recalculate"
        size="large"
        icon={<Icons.IconCalculateNow />}
        onClick={onRecalculate}
        title="Recalculate all formulas now"
      />
      <RibbonButton
        label="Calculate Sheet"
        icon={<Icons.IconCalculateSheet />}
        onClick={onCalculateSheet}
        title="Recalculate the current sheet"
      />
      <RibbonMenu label={calcMode === 'automatic' ? 'Automatic' : calcMode === 'manual' ? 'Manual' : 'Auto Except Tables'} title="Calculation options" icon={<Icons.IconCalculateNow />}>
        <RibbonMenuItem label="Automatic" onClick={() => onSetCalcMode('automatic')} title="Recalculate automatically" />
        <RibbonMenuItem label="Automatic Except for Data Tables" onClick={() => onSetCalcMode('autoExceptDataTables' as CalculationMode)} title="Automatic except data tables" />
        <RibbonMenuItem label="Manual" onClick={() => onSetCalcMode('manual')} title="Recalculate only on demand" />
        <RibbonMenuItem label="Iteration Settings…" onClick={onOpenIterative} title="Set maximum iterations and maximum change for circular references" />
        <RibbonMenuItem label="Calculation Options…" onClick={onOpenParallelCalc} title="Parallel recalculation: worker pool, worker count, thresholds" />
      </RibbonMenu>
    </>
  );
});

const DataGetTransformDataContent = memo(function DataGetTransformDataContent(props: {
  ev: RibbonEvents;
}) {
  const { onOpenEtl, onOpenPowerQuery, onOpenQuickImport } = props.ev;
  return (
    <>
      <RibbonButton label="Get Data" size="large" icon={<Icons.IconGetData />} onClick={onOpenPowerQuery} title="Import from CSV, JSON, or a web URL and shape it with Power Query steps" />
      <RibbonButton label="From Text/CSV" icon={<Icons.IconFromTextCsv />} onClick={() => onOpenQuickImport('text')} title="Import a text or CSV file" />
      <RibbonButton label="From Web" icon={<Icons.IconFromWeb />} onClick={() => onOpenQuickImport('web')} title="Import data from a web page" />
      <RibbonMenu label="Recent Sources" title="Recently used data sources" icon={<Icons.IconRecentSources />}>
        <RibbonMenuItem label="Open Recent Sources…" onClick={() => onOpenQuickImport('recent')} />
      </RibbonMenu>
      <RibbonButton label="Existing Connections" icon={<Icons.IconExistingConnections />} onClick={() => onOpenQuickImport('connections')} title="Connect via a saved connection" />
      <RibbonButton label="ETL Pipelines" icon={<Icons.IconEtlPipeline />} onClick={onOpenEtl} title="Build repeatable extract-transform-load pipelines: versioned recipes, scheduled refresh, run history" />
    </>
  );
});

const DataQueriesConnectionsContent = memo(function DataQueriesConnectionsContent(props: {
  ev: RibbonEvents;
  queriesPaneOpen: boolean;
  canRefreshDataSource: boolean;
}) {
  const { onRefreshAllDataSources, onRefreshDataSource, onToggleQueriesPane } = props.ev;
  const { queriesPaneOpen, canRefreshDataSource } = props;
  return (
    <>
      <RibbonButton label="Queries & Connections" icon={<Icons.IconQueriesPane />} active={queriesPaneOpen} onClick={onToggleQueriesPane} title="Show the Queries & Connections pane" />
      <RibbonButton
        label="Refresh"
        icon={<Icons.IconRefresh />}
        onClick={onRefreshDataSource}
        disabled={!canRefreshDataSource}
        title={canRefreshDataSource ? 'Re-fetch the connected data source for this sheet' : 'This sheet has no connected data source'}
      />
      <RibbonButton label="Refresh All" icon={<Icons.IconRefreshAll />} onClick={onRefreshAllDataSources} title="Re-fetch every connected data source" />
    </>
  );
});

const DataSortFilterContent = memo(function DataSortFilterContent(props: {
  ev: RibbonEvents;
}) {
  const { onClearFilter, onCustomSort, onOpenAdvancedFilter, onReapplyFilter, onSortAsc, onSortDesc, openFilterSel } = props.ev;
  return (
    <>
      <RibbonButton label="Sort A to Z" icon={<Icons.IconSortAsc />} onClick={onSortAsc} title="Sort rows by the selected column, ascending" />
      <RibbonButton label="Sort Z to A" icon={<Icons.IconSortDesc />} onClick={onSortDesc} title="Sort rows by the selected column, descending" />
      <RibbonButton label="Custom Sort…" icon={<Icons.IconCustomSort />} onClick={onCustomSort} title="Sort by any column and direction" />
      <RibbonButton label="Filter" icon={<Icons.IconFilter />} onClick={openFilterSel} title="Filter rows by values in the selected column" />
      <RibbonButton label="Clear" icon={<Icons.IconClear />} onClick={onClearFilter} title="Remove all filters" />
      <RibbonButton label="Reapply" icon={<Icons.IconReapplyFilter />} onClick={onReapplyFilter} title="Reapply the current filter" />
      <RibbonButton label="Advanced…" icon={<Icons.IconAdvancedFilter />} onClick={onOpenAdvancedFilter} title="Advanced filter with criteria range" />
    </>
  );
});

const DataDataToolsContent = memo(function DataDataToolsContent(props: {
  ev: RibbonEvents;
}) {
  const { onCleanUp, onColumnStats, onFlashFill, onOpenConsolidate, onOpenDataTypeDialog, onOpenExternalLinks, onOpenGroupBy, onOpenRelationships, onOpenSmartChipDialog, onOpenValidation, onRandomizeRange, onRemoveDuplicates, onSuggestFormulas, onTextToColumns, onTrimWhitespace } = props.ev;
  return (
    <>
      <RibbonButton label="Data Validation" icon={<Icons.IconDataValidation />} onClick={onOpenValidation} title="Restrict the selected cell to a dropdown list" />
      <RibbonButton label="Remove Duplicates" icon={<Icons.IconRemoveDuplicates />} onClick={onRemoveDuplicates} title="Remove duplicate rows based on the selected column" />
      <RibbonButton label="Text to Columns" icon={<Icons.IconTextToColumns />} onClick={onTextToColumns} title="Split the selected column's text on a delimiter" />
      <RibbonButton label="Flash Fill" icon={<Icons.IconFlashFill />} onClick={onFlashFill} title="Fill from examples you typed (Ctrl+E)" />
      <RibbonButton label="Consolidate…" icon={<Icons.IconConsolidate />} onClick={onOpenConsolidate} title="Combine values from multiple ranges" />
      <RibbonButton label="Relationships" icon={<Icons.IconTable />} onClick={onOpenRelationships} title="Manage table relationships" />
      <RibbonButton label="Suggest Formulas" icon={<Icons.IconMoreFunctions />} onClick={onSuggestFormulas} title="Propose formulas from column headers and data patterns" />
      <RibbonButton label="Clean Up" icon={<Icons.IconClear />} onClick={onCleanUp} title="Find whitespace, mixed types, and duplicate rows — review before applying" />
      <RibbonButton label="Column Statistics" icon={<Icons.IconDataType />} onClick={onColumnStats} title="Descriptive statistics for the selected column: counts, types, min/max/mean/median, most common values" />
      <RibbonButton label="Trim Whitespace" icon={<Icons.IconClear />} onClick={onTrimWhitespace} title="Remove leading and trailing whitespace from cells on this sheet" />
      <RibbonButton label="Data Types" icon={<Icons.IconDataType />} onClick={onOpenDataTypeDialog} title="Insert a linked stock or geography data type" />
      <RibbonButton label="Smart Chips" icon={<Icons.IconSmartChip />} onClick={onOpenSmartChipDialog} title="Insert a smart chip: person, file, calendar, finance, or rating" />
      <RibbonButton label="External Links" icon={<Icons.IconExternalLink />} onClick={onOpenExternalLinks} title="Manage links to other workbooks ([n]Sheet!Cell)" />
      <RibbonButton label="Randomize Range" icon={<Icons.IconRefresh />} onClick={onRandomizeRange} title="Shuffle the data rows of the selected range (header row stays in place)" />
      <RibbonButton label="Group-by View" icon={<Icons.IconTable />} onClick={onOpenGroupBy} title="Build a pivot-style group-by summary of this sheet into a new sheet" />
    </>
  );
});

const DataForecastContent = memo(function DataForecastContent(props: {
  ev: RibbonEvents;
}) {
  const { onDataTable, onGoalSeek, onOpenForecastSheet, onScenarioManager, onSolver } = props.ev;
  return (
    <>
      <RibbonMenu label="What-If Analysis" title="Scenario Manager, Goal Seek, Data Table" icon={<Icons.IconWhatIf />}>
        <RibbonMenuItem label="Scenario Manager…" onClick={onScenarioManager} />
        <RibbonMenuItem label="Goal Seek…" onClick={onGoalSeek} />
        <RibbonMenuItem label="Data Table…" onClick={onDataTable} />
      </RibbonMenu>
      <RibbonButton label="Forecast Sheet" icon={<Icons.IconForecastSheet />} onClick={onOpenForecastSheet} title="Create a forecast sheet with confidence bounds" />
      <RibbonButton label="Solver" icon={<Icons.IconSolver />} onClick={onSolver} title="Optimize a target cell by changing variable cells" />
    </>
  );
});

const DataOutlineContent = memo(function DataOutlineContent(props: {
  ev: RibbonEvents;
}) {
  const { onGroupCols, onGroupRows, onHideDetail, onOpenSubtotal, onShowDetail, onUngroupAll } = props.ev;
  return (
    <>
      <RibbonMenu label="Group" title="Group rows or columns" icon={<Icons.IconGroup />}>
        <RibbonMenuItem label="Group Rows" onClick={onGroupRows} />
        <RibbonMenuItem label="Group Columns" onClick={onGroupCols} />
      </RibbonMenu>
      <RibbonButton label="Ungroup All" icon={<Icons.IconUngroup />} onClick={onUngroupAll} title="Remove all row/column groups" />
      <RibbonButton label="Subtotal…" icon={<Icons.IconSubtotal />} onClick={onOpenSubtotal} title="Insert subtotal rows" />
      <RibbonButton label="Show Detail" icon={<Icons.IconShowDetail />} onClick={onShowDetail} title="Expand outline detail" />
      <RibbonButton label="Hide Detail" icon={<Icons.IconHideDetail />} onClick={onHideDetail} title="Collapse outline detail" />
    </>
  );
});

const ReviewProofingContent = memo(function ReviewProofingContent(props: {
  ev: RibbonEvents;
}) {
  const { onOpenThesaurus, onSpelling } = props.ev;
  return (
    <>
      <RibbonButton label="Spelling" size="large" icon={<Icons.IconSpelling />} onClick={onSpelling} title="Check spelling in the used range" />
      <RibbonButton label="Thesaurus" icon={<Icons.IconThesaurus />} onClick={onOpenThesaurus} title="Look up synonyms for the selected word" />
    </>
  );
});

const ReviewAccessibilityContent = memo(function ReviewAccessibilityContent(props: {
  ev: RibbonEvents;
}) {
  const { onOpenAccessibilityChecker } = props.ev;
  return (
    <>
      <RibbonButton label="Check Accessibility" size="large" icon={<Icons.IconAccessibility />} onClick={onOpenAccessibilityChecker} title="Check for accessibility issues" />
    </>
  );
});

const ReviewLanguageContent = memo(function ReviewLanguageContent(props: {
  ev: RibbonEvents;
}) {
  const { onOpenTranslate } = props.ev;
  return (
    <>
      <RibbonButton label="Translate" size="large" icon={<Icons.IconTranslate />} onClick={onOpenTranslate} title="Translate the selected text" />
    </>
  );
});

const ReviewCommentsContent = memo(function ReviewCommentsContent(props: {
  ev: RibbonEvents;
  showComments: boolean;
  hasComment: boolean;
}) {
  const { onDeleteAllComments, onDeleteComment, onNewComment, onNextComment, onPrevComment, onToggleShowComments } = props.ev;
  const { showComments, hasComment } = props;
  return (
    <>
      <RibbonButton label="New Comment" size="large" icon={<Icons.IconNewComment />} onClick={onNewComment} title="Add a comment to the selected cell" />
      <RibbonButton label="Previous" icon={<Icons.IconPrevComment />} onClick={onPrevComment} title="Go to the previous comment" />
      <RibbonButton label="Next" icon={<Icons.IconNextComment />} onClick={onNextComment} title="Go to the next comment" />
      <RibbonButton
        label="Show Comments"
        icon={<Icons.IconShowComments />}
        active={showComments}
        onClick={onToggleShowComments}
        title="Show or hide comment indicators"
      />
      <RibbonMenu label="Delete" title="Delete comments" icon={<Icons.IconDeleteComment />}>
        <RibbonMenuItem label="Delete Comment" onClick={onDeleteComment} disabled={!hasComment} title="Delete the comment on the selected cell" />
        <RibbonMenuItem label="Delete All Comments" onClick={onDeleteAllComments} title="Delete all comments on this sheet" />
      </RibbonMenu>
    </>
  );
});

const ReviewNotesContent = memo(function ReviewNotesContent(props: {
  ev: RibbonEvents;
}) {
  const { onOpenNotes } = props.ev;
  return (
    <>
      <RibbonButton label="Notes" size="large" icon={<Icons.IconNewNote />} onClick={onOpenNotes} title="Show the notes pane" />
    </>
  );
});

const ReviewProtectContent = memo(function ReviewProtectContent(props: {
  ev: RibbonEvents;
  isSheetProtected: boolean;
}) {
  const { onManageProtection, onOpenAllowEditRanges, onOpenWorkbookProtection } = props.ev;
  const { isSheetProtected } = props;
  return (
    <>
      <RibbonButton
        label={isSheetProtected ? 'Unprotect Sheet' : 'Protect Sheet'}
        icon={<Icons.IconProtectSheet />}
        active={isSheetProtected}
        onClick={onManageProtection}
        title={isSheetProtected ? 'Remove sheet protection' : 'Protect the current sheet'}
      />
      <RibbonButton label="Protect Workbook" icon={<Icons.IconProtectWorkbook />} onClick={onOpenWorkbookProtection} title="Protect the workbook structure" />
      <RibbonButton label="Allow Edit Ranges" icon={<Icons.IconAllowEditRanges />} onClick={onOpenAllowEditRanges} title="Set per-range edit permissions" />
    </>
  );
});

const ReviewCollaborationContent = memo(function ReviewCollaborationContent(props: {
  ev: RibbonEvents;
}) {
  const { onOpenRevisionHistory } = props.ev;
  return (
    <>
      <RibbonButton
        label="Revision History"
        size="large"
        icon={<Icons.IconRevisionHistory />}
        onClick={onOpenRevisionHistory}
        title="Show the change log: every edit applied through the collaboration session"
      />
    </>
  );
});

const ReviewSensitivityContent = memo(function ReviewSensitivityContent(props: {
  ev: RibbonEvents;
  sensitivityLabel: SensitivityLabel;
}) {
  const { onSensitivityChange } = props.ev;
  const { sensitivityLabel } = props;
  return (
    <>
      <RibbonSelect
        label="Label"
        value={sensitivityLabel}
        options={['public', 'internal', 'confidential']}
        onChange={(v) => onSensitivityChange(v as SensitivityLabel)}
        title="Set the workbook's sensitivity label (audited; confidential restricts downloads and sharing)"
      />
    </>
  );
});

const ViewWorkbookViewsContent = memo(function ViewWorkbookViewsContent(props: {
  ev: RibbonEvents;
  workbookView: 'normal' | 'pageBreakPreview' | 'pageLayout';
}) {
  const { onSetWorkbookView } = props.ev;
  const { workbookView } = props;
  return (
    <>
      <RibbonButton label="Normal" icon={<Icons.IconNormalView />} active={workbookView === 'normal'} onClick={() => onSetWorkbookView('normal')} title="Normal view" />
      <RibbonButton label="Page Break Preview" icon={<Icons.IconPageBreakPreview />} active={workbookView === 'pageBreakPreview'} onClick={() => onSetWorkbookView('pageBreakPreview')} title="Preview page breaks" />
      <RibbonButton label="Page Layout" icon={<Icons.IconPageLayoutView />} active={workbookView === 'pageLayout'} onClick={() => onSetWorkbookView('pageLayout')} title="Page layout view" />
    </>
  );
});

const ViewShowContent = memo(function ViewShowContent(props: {
  ev: RibbonEvents;
  showGridlines: boolean;
  showFormulaBar: boolean;
  showHeadings: boolean;
}) {
  const { onSetWorkbookView, onToggleFormulaBar, onToggleGridlines, onToggleHeadings } = props.ev;
  const { showGridlines, showFormulaBar, showHeadings } = props;
  return (
    <>
      <RibbonButton
        label="Ruler"
        icon={<Icons.IconRuler />}
        onClick={() => onSetWorkbookView('pageLayout')}
        title="Show rulers (Page Layout view)"
      />
      <RibbonButton
        label="Gridlines"
        icon={<Icons.IconGridlines />}
        active={showGridlines}
        onClick={onToggleGridlines}
        title="Show or hide the grid cell borders"
      />
      <RibbonButton
        label="Formula Bar"
        icon={<Icons.IconFormulaBar />}
        active={showFormulaBar}
        onClick={onToggleFormulaBar}
        title="Show or hide the formula bar"
      />
      <RibbonButton
        label="Headings"
        icon={<Icons.IconHeadings />}
        active={showHeadings}
        onClick={onToggleHeadings}
        title="Show or hide row and column headings"
      />
    </>
  );
});

const ViewZoomContent = memo(function ViewZoomContent(props: {
  ev: RibbonEvents;
  zoom: number;
}) {
  const { onOpenZoomDialog, onZoomReset, onZoomToSelection } = props.ev;
  const { zoom } = props;
  return (
    <>
      <RibbonButton label="Zoom…" icon={<Icons.IconZoomDialog />} onClick={onOpenZoomDialog} title="Set the zoom level" />
      <RibbonButton label="100%" icon={<Icons.IconZoom100 />} onClick={onZoomReset} title="Reset zoom to 100%" />
      <RibbonButton label="Zoom to Selection" icon={<Icons.IconZoomToSelection />} onClick={onZoomToSelection} title="Zoom to fit the selection" />
      <span className="ribbon-readout" aria-live="polite">
        {Math.round(zoom * 100)}%
      </span>
    </>
  );
});

const ViewWindowContent = memo(function ViewWindowContent(props: {
  ev: RibbonEvents;
  hasFreeze: boolean;
  splitActive: boolean;
  focusCell: boolean;
}) {
  const { onFreeze, onFreezeFirstCol, onFreezeTopRow, onFullScreen, onToggleFocusCell, onToggleSplit, onUnfreeze } = props.ev;
  const { hasFreeze, splitActive, focusCell } = props;
  return (
    <>
      <RibbonMenu label="Freeze Panes" title="Freeze rows and columns" icon={<Icons.IconFreezePanes />}>
        <RibbonMenuItem label="Freeze at Selection" onClick={onFreeze} title="Freeze rows above and columns left of the selection" />
        <RibbonMenuItem label="Freeze Top Row" onClick={onFreezeTopRow} title="Freeze the first row" />
        <RibbonMenuItem label="Freeze First Column" onClick={onFreezeFirstCol} title="Freeze the first column" />
        {hasFreeze && <RibbonMenuItem label="Unfreeze Panes" onClick={onUnfreeze} />}
      </RibbonMenu>
      <RibbonButton label="Split" icon={<Icons.IconSplit />} active={splitActive} onClick={onToggleSplit} title="Split the window into panes" />
      <RibbonMenu label="Focus Cell" title="Highlight the selected cell" icon={<Icons.IconFocusCell />}>
        <RibbonMenuItem
          label={focusCell ? '✓ Focus Cell On' : 'Focus Cell Off'}
          onClick={onToggleFocusCell}
          title="Toggle an extra-prominent highlight on the selected cell"
        />
      </RibbonMenu>
      <RibbonButton label="Full Screen" icon={<Icons.IconFullScreen />} onClick={onFullScreen} title="Toggle browser full screen" />
    </>
  );
});

const ViewMacrosContent = memo(function ViewMacrosContent(props: {
  ev: RibbonEvents;
  macroRecording: boolean;
  useRelativeRefs: boolean;
}) {
  const { onOpenMacroList, onOpenMacroRecorder, onToggleRelativeRefs } = props.ev;
  const { macroRecording, useRelativeRefs } = props;
  return (
    <>
      <RibbonButton label="View Macros" icon={<Icons.IconViewMacros />} onClick={onOpenMacroList} title="View, run, and manage macros" />
      <RibbonButton
        label={macroRecording ? '● Recording…' : 'Record Macro'}
        icon={<Icons.IconRecordMacro />}
        active={macroRecording}
        onClick={onOpenMacroRecorder}
        title="Record your actions as an editable TypeScript macro (automation lane)"
      />
      <RibbonButton label={useRelativeRefs ? "✓ Relative Refs" : "Relative Refs"} icon={<Icons.IconMacroSecurity />} onClick={onToggleRelativeRefs} title="Record macros with relative references" />
    </>
  );
});

const ExtensionsAppsScriptContent = memo(function ExtensionsAppsScriptContent(props: {
  ev: RibbonEvents;
}) {
  const { onOpenScriptEditor, onOpenTriggers } = props.ev;
  return (
    <>
      <RibbonButton
        label="Script Editor"
        size="large"
        icon={<Icons.IconAppsScript />}
        onClick={onOpenScriptEditor}
        title="Write, translate and run automation scripts (TypeScript/JavaScript) through the permissioned automation API"
      />
      <RibbonButton
        label="Triggers"
        icon={<Icons.IconAppsScript />}
        onClick={onOpenTriggers}
        title="Run scripts automatically when this workbook opens, when cells are edited, or on a schedule"
      />
    </>
  );
});

const ExtensionsAddonsContent = memo(function ExtensionsAddonsContent(props: {
  ev: RibbonEvents;
}) {
  const { onOpenAddonManager } = props.ev;
  return (
    <>
      <RibbonButton
        label="Get add-ons"
        size="large"
        icon={<Icons.IconAddons />}
        onClick={onOpenAddonManager}
        title="Browse the product-owned add-on catalog: install, enable/disable, and approve capability grants"
      />
    </>
  );
});

const HelpHelpContent = memo(function HelpHelpContent(props: {
  ev: RibbonEvents;
}) {
  const { onOpenHelp } = props.ev;
  return (
    <>
      <RibbonButton label="Help" size="large" icon={<Icons.IconHelp />} onClick={() => onOpenHelp('help')} title="Open help" />
      <RibbonButton label="What's New" icon={<Icons.IconWhatsNew />} onClick={() => onOpenHelp('whatsnew')} title="See what's new" />
      <RibbonButton label="Function List" icon={<Icons.IconAbout />} onClick={() => onOpenHelp('functions')} title="Browse all functions by category" />
      <RibbonButton label="Contact Support" icon={<Icons.IconHelp />} onClick={() => onOpenHelp('support')} title="Contact support" />
      <RibbonButton label="Feedback" icon={<Icons.IconFeedback />} onClick={() => onOpenHelp('feedback')} title="Send feedback" />
      <RibbonButton label="Show Training" icon={<Icons.IconHelp />} onClick={() => onOpenHelp('training')} title="Take the guided tour" />
      <RibbonButton label="Privacy Policy" icon={<Icons.IconHelp />} onClick={() => onOpenHelp('privacy')} title="Read the privacy policy" />
      <RibbonButton label="Terms" icon={<Icons.IconHelp />} onClick={() => onOpenHelp('terms')} title="Read the terms of use" />
      <RibbonButton label="About" icon={<Icons.IconAbout />} onClick={() => onOpenHelp('about')} title="About Icecream Sheets" />
    </>
  );
});

export default function Ribbon(props: RibbonProps) {
  const {
    appList,
    calcMode,
    canRedo,
    canRefreshDataSource,
    canUndo,
    desktopLoading = false,
    fnCategories,
    focusCell,
    formatPainterActive,
    hasComment,
    hasFreeze,
    inkTool,
    isDesktop,
    isSheetProtected,
    macroRecording,
    printGridlines,
    printHeadings,
    queriesPaneOpen,
    readOnly = false,
    recentFunctions,
    saveFormat,
    selectObjectsMode,
    selectedFormat: fmt,
    sensitivityLabel,
    showComments,
    showFormulaBar,
    showFormulas,
    showGridlines,
    showHeadings,
    splitActive,
    useRelativeRefs,
    watchWindowOpen,
    workbookView,
    zoom,
  } = props;

  const [tab, setTab] = useState<RibbonTabId>('Home');
  const fileRef = useRef<HTMLInputElement>(null);
  // Selection-render fix (#77): latest-props ref + the one stable events
  // dispatcher handed to every memoized group content, plus content-keyed
  // stabilizations of the array props so their groups' memos hold even
  // while App still re-creates the arrays per render.
  const propsRef = useRef(props);
  propsRef.current = props;
  const events = useMemo(() => makeRibbonEvents(propsRef, fileRef), []);
  const appListStable = useMemo(() => appList, [JSON.stringify(appList)]);
  const fnCategoriesStable = useMemo(() => fnCategories, [JSON.stringify(fnCategories)]);
  const recentFunctionsStable = useMemo(() => recentFunctions, [JSON.stringify(recentFunctions)]);

  return (
    <div className="ribbon">
      <div className="ribbon-tabstrip" role="tablist" aria-label="Ribbon tabs">
        <span className="ribbon-brand">Icecream Sheets</span>
        {TABS.map((t) => (
          <button
            key={t}
            type="button"
            role="tab"
            aria-selected={t === tab}
            className={t === tab ? 'ribbon-tab active' : 'ribbon-tab'}
            data-short={TAB_SHORT_LABELS[t]}
            onClick={() => setTab(t)}
          >
            {t}
          </button>
        ))}
        <span style={{ flex: 1 }} />
        <button
          type="button"
          className="ribbon-tab ribbon-share"
          onClick={props.onOpenShare}
          title="Share this workbook"
          aria-label="Share"
        >
          <Icons.IconShare />
          <span className="ribbon-share-label"> Share</span>
        </button>
      </div>

      <RibbonPanel resetKey={tab}>
        {tab === 'File' && (
          <>
            <RibbonGroup label="Workbook">
              <FileWorkbookContent ev={events} />
            </RibbonGroup>
            <RibbonGroup label="File">
              <FileFileContent ev={events} isDesktop={isDesktop} desktopLoading={desktopLoading} readOnly={readOnly} saveFormat={saveFormat} />
            </RibbonGroup>
            <RibbonGroup label="Preferences">
              <FilePreferencesContent ev={events} />
            </RibbonGroup>
          </>
        )}

        {tab === 'Home' && (
          <>
            <RibbonGroup label="Clipboard">
              <HomeClipboardContent ev={events} formatPainterActive={formatPainterActive} />
            </RibbonGroup>

            <RibbonGroup label="Font">
              <HomeFontContent ev={events} fontName={fmt?.fontName ?? 'Calibri'} fontSize={fmt?.fontSize ?? 11} bold={!!fmt?.bold} italic={!!fmt?.italic} underlineActive={!!fmt?.underline} strikethrough={!!fmt?.strikethrough} doubleUnderline={fmt?.underline === 'double'} />
            </RibbonGroup>

            <RibbonGroup label="Alignment">
              <HomeAlignmentContent ev={events} hAlign={fmt?.hAlign} vAlign={fmt?.vAlign} wrapText={!!fmt?.wrapText} />
            </RibbonGroup>

            <RibbonGroup label="Number">
              <HomeNumberContent ev={events} numberFormat={fmt?.numberFormat ?? 'General'} />
            </RibbonGroup>

            <RibbonGroup label="Styles">
              <HomeStylesContent ev={events} />
            </RibbonGroup>

            <RibbonGroup label="Cells">
              <HomeCellsContent ev={events} />
            </RibbonGroup>

            <RibbonGroup label="Editing">
              <HomeEditingContent ev={events} canUndo={canUndo} canRedo={canRedo} selectObjectsMode={selectObjectsMode} />
            </RibbonGroup>
          </>
        )}

        {tab === 'Insert' && (
          <>
            <RibbonGroup label="Tables">
              <InsertTablesContent ev={events} />
            </RibbonGroup>
            <RibbonGroup label="Apps">
              <InsertAppsContent ev={events} appList={appListStable} />
            </RibbonGroup>
            <RibbonGroup label="Filters">
              <InsertFiltersContent ev={events} />
            </RibbonGroup>
            <RibbonGroup label="Sparklines">
              <InsertSparklinesContent ev={events} />
            </RibbonGroup>
            <RibbonGroup label="Illustrations">
              <InsertIllustrationsContent ev={events} />
            </RibbonGroup>
            <RibbonGroup label="Charts">
              <InsertChartsContent ev={events} />
            </RibbonGroup>
            <RibbonGroup label="Links">
              <InsertLinksContent ev={events} />
            </RibbonGroup>
            <RibbonGroup label="Text">
              <InsertTextContent ev={events} />
            </RibbonGroup>
            <RibbonGroup label="Symbols">
              <InsertSymbolsContent ev={events} />
            </RibbonGroup>
            <RibbonGroup label="Reports">
              <InsertReportsContent ev={events} />
            </RibbonGroup>
            <RibbonGroup label="Sheets">
              <InsertSheetsContent ev={events} />
            </RibbonGroup>
            <RibbonGroup label="Rows & Columns">
              <InsertRowsColumnsContent ev={events} />
            </RibbonGroup>
            <RibbonGroup label="Form Controls">
              <InsertFormControlsContent ev={events} />
            </RibbonGroup>
            <RibbonGroup label="Maps">
              <InsertMapsContent ev={events} />
            </RibbonGroup>
          </>
        )}

        {tab === 'Draw' && (
          <>
            <RibbonGroup label="Tools">
              <DrawToolsContent ev={events} inkTool={inkTool} />
            </RibbonGroup>
            <RibbonGroup label="Convert">
              <DrawConvertContent ev={events} />
            </RibbonGroup>
            <RibbonGroup label="Canvas">
              <DrawCanvasContent ev={events} />
            </RibbonGroup>
          </>
        )}

        {tab === 'Page Layout' && (
          <>
            <RibbonGroup label="Themes">
              <PageLayoutThemesContent ev={events} />
            </RibbonGroup>
            <RibbonGroup label="Page Setup">
              <PageLayoutPageSetupContent ev={events} />
            </RibbonGroup>
            <RibbonGroup label="Scale to Fit">
              <PageLayoutScaleToFitContent ev={events} />
            </RibbonGroup>
            <RibbonGroup label="Sheet Options">
              <PageLayoutSheetOptionsContent ev={events} showGridlines={showGridlines} showHeadings={showHeadings} printGridlines={printGridlines} printHeadings={printHeadings} />
            </RibbonGroup>
            <RibbonGroup label="Arrange">
              <PageLayoutArrangeContent ev={events} />
            </RibbonGroup>
          </>
        )}

        {tab === 'Formulas' && (
          <>
            <RibbonGroup label="Function Library">
              <FormulasFunctionLibraryContent ev={events} fnCategories={fnCategoriesStable} recentFunctions={recentFunctionsStable} />
            </RibbonGroup>
            <RibbonGroup label="Defined Names">
              <FormulasDefinedNamesContent ev={events} />
            </RibbonGroup>
            <RibbonGroup label="Formula Auditing">
              <FormulasFormulaAuditingContent ev={events} showFormulas={showFormulas} watchWindowOpen={watchWindowOpen} />
            </RibbonGroup>
            <RibbonGroup label="Calculation">
              <FormulasCalculationContent ev={events} calcMode={calcMode} />
            </RibbonGroup>
          </>
        )}

        {tab === 'Data' && (
          <>
            <RibbonGroup label="Get & Transform Data">
              <DataGetTransformDataContent ev={events} />
            </RibbonGroup>
            <RibbonGroup label="Queries & Connections">
              <DataQueriesConnectionsContent ev={events} queriesPaneOpen={queriesPaneOpen} canRefreshDataSource={canRefreshDataSource} />
            </RibbonGroup>
            <RibbonGroup label="Sort & Filter">
              <DataSortFilterContent ev={events} />
            </RibbonGroup>
            <RibbonGroup label="Data Tools">
              <DataDataToolsContent ev={events} />
            </RibbonGroup>
            <RibbonGroup label="Forecast">
              <DataForecastContent ev={events} />
            </RibbonGroup>
            <RibbonGroup label="Outline">
              <DataOutlineContent ev={events} />
            </RibbonGroup>
          </>
        )}

        {tab === 'Review' && (
          <>
            <RibbonGroup label="Proofing">
              <ReviewProofingContent ev={events} />
            </RibbonGroup>
            <RibbonGroup label="Accessibility">
              <ReviewAccessibilityContent ev={events} />
            </RibbonGroup>
            <RibbonGroup label="Language">
              <ReviewLanguageContent ev={events} />
            </RibbonGroup>
            <RibbonGroup label="Comments">
              <ReviewCommentsContent ev={events} showComments={showComments} hasComment={hasComment} />
            </RibbonGroup>
            <RibbonGroup label="Notes">
              <ReviewNotesContent ev={events} />
            </RibbonGroup>
            <RibbonGroup label="Protect">
              <ReviewProtectContent ev={events} isSheetProtected={isSheetProtected} />
            </RibbonGroup>
            <RibbonGroup label="Collaboration">
              <ReviewCollaborationContent ev={events} />
            </RibbonGroup>
            <RibbonGroup label="Sensitivity">
              <ReviewSensitivityContent ev={events} sensitivityLabel={sensitivityLabel} />
            </RibbonGroup>
          </>
        )}

        {tab === 'View' && (
          <>
            <RibbonGroup label="Workbook Views">
              <ViewWorkbookViewsContent ev={events} workbookView={workbookView} />
            </RibbonGroup>
            <RibbonGroup label="Show">
              <ViewShowContent ev={events} showGridlines={showGridlines} showFormulaBar={showFormulaBar} showHeadings={showHeadings} />
            </RibbonGroup>
            <RibbonGroup label="Zoom">
              <ViewZoomContent ev={events} zoom={zoom} />
            </RibbonGroup>
            <RibbonGroup label="Window">
              <ViewWindowContent ev={events} hasFreeze={hasFreeze} splitActive={splitActive} focusCell={focusCell} />
            </RibbonGroup>
            <RibbonGroup label="Macros">
              <ViewMacrosContent ev={events} macroRecording={macroRecording} useRelativeRefs={useRelativeRefs} />
            </RibbonGroup>
          </>
        )}

        {tab === 'Extensions' && (
          <>
            <RibbonGroup label="Apps Script">
              <ExtensionsAppsScriptContent ev={events} />
            </RibbonGroup>
            <RibbonGroup label="Add-ons">
              <ExtensionsAddonsContent ev={events} />
            </RibbonGroup>
          </>
        )}

        {tab === 'Help' && (
          <>
            <RibbonGroup label="Help">
              <HelpHelpContent ev={events} />
            </RibbonGroup>
          </>
        )}
      </RibbonPanel>

      <input
        ref={fileRef}
        type="file"
        accept=".xlsx,.xlsm,.xltx,.xltm,.csv,.tsv,.ods"
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) props.onOpenFile(f);
          e.target.value = '';
        }}
      />
    </div>
  );
}
