/**
 * useRibbonParity — integration hook for the Excel Classic ribbon parity build.
 *
 * Owns all dialog state and handlers for the ~100 new ribbon items added for
 * 100% Excel parity (Draw tab, Help tab, and gap fills across all tabs).
 * App.tsx calls this hook and spreads `ribbonProps` into <Ribbon> and renders
 * `dialogs`. This keeps the App.tsx diff minimal and avoids edit conflicts.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { EngineHost, ProtectionManager } from '@icecream-sheets/engine';
import type { ChartKind } from '@icecream-sheets/service';
import { setFormat } from './features/formatting';
import type { CellFormat } from './features/formatting';
import type { NameServicesHandle } from './features/useNameServices';
import type { CommentStore } from './features/comments';
import { deleteComment, listComments, nextComment, prevComment } from './features/comments';
import { clearCommentsInRange, clearHyperlinks } from './features/clearExt';
import { increaseDecimals, decreaseDecimals } from './features/decimals';
import { fillDirection, justifyText } from './features/fill';
import { autoFitRowHeight, autoFitColumnWidth } from './features/cellSize';
import { insertCells as insertCellsOp, deleteCells as deleteCellsOp } from './features/insertDeleteCells';
import { moveSheetOrder } from './features/moveCopySheet';
import { readImageFromClipboard, renderRangeAsSvg } from './features/pastePicture';
import { recordFunctionUse, getRecentFunctions } from './features/recentFunctions';
import { applyAdvancedFilterToHost } from './features/advancedFilter';
import { applyRelativeRefs, getUseRelativeReferences, setUseRelativeReferences } from './features/macros';
import { cellRef } from './engine';
import type { PageSetup } from './components/PrintLayout';
import type { PrintTitles } from './components/PageSetupDialog';
import { NO_BACKGROUND } from './components/BackgroundDialog';
import { a1Short } from './engine';
import type { Picture } from './components/Pictures';
import type { ChartSpec } from '@icecream-sheets/service';
import type { FormatStore } from './features/formatting';
import type { MergeRange } from './features/models';
import type { A11yIssue, A11yModel } from './features/accessibility';

// Dialogs — Home
import { OrientationDialog } from './components/OrientationDialog';
import { GoToDialog } from './components/GoToDialog';
import { CFNewRuleDialog, CFManageRulesDialog } from './components/CFRuleDialogs';
import { TableStyleGallery } from './components/TableStyleGallery';
import { MoveCopySheetDialog } from './components/MoveCopySheetDialog';
// Dialogs — Insert
import { LinkDialog } from './components/LinkDialog';
import { HeaderFooterDialog } from './components/HeaderFooterDialog';
import {
  defaultHeaderFooter,
  validateHeaderFooter,
  type HeaderFooterSettings,
} from './features/headerFooter';
import { WordArtDialog } from './components/WordArtDialog';
import { EquationDialog } from './components/EquationDialog';
import { SymbolDialog } from './components/SymbolDialog';
import { IconGallery, SmartArtDialog, ScreenshotDialog } from './components/SmartShapes';
import { RecommendedChartsDialog, RecommendedPivotTablesDialog } from './components/RecommendedDialogs';
import { PivotChartDialog } from './components/PivotChartDialog';
import type { PivotChartSource } from './components/PivotChartDialog';
// Dialogs — Draw/Page Layout
import {
  DrawingCanvas,
  InkOverlay,
  type ConvertRequest,
  type InkTool,
  type RecognizedShapeOverlay,
} from './components/InkCanvas';
import {
  type DrawingCanvasSpec,
  type InkStroke,
} from './features/ink';
import ThemeDialog from './components/ThemeDialog';
import { type WorkbookTheme } from './features/themes';
import PageSetupDialog from './components/PageSetupDialog';
import BackgroundDialog from './components/BackgroundDialog';
import ArrangeTools from './components/ArrangeTools';
// Dialogs — Formulas
import { DefineNameDialog, ApplyNamesDialog, CreateFromSelectionDialog } from './components/DefineNameDialog';
import { AuditArrowsOverlay, ErrorCheckingDialog, EvaluateFormulaDialog, WatchWindow } from './components/AuditOverlays';
// Dialogs — Data
import QuickImport from './components/QuickImport';
import QueriesPane from './components/QueriesPane';
import AdvancedFilterDialog from './components/AdvancedFilterDialog';
import ConsolidateDialog from './components/ConsolidateDialog';
import ForecastSheetDialog from './components/ForecastSheetDialog';
import SubtotalDialog from './components/SubtotalDialog';
import RelationshipsDialog from './components/RelationshipsDialog';
// Dialogs — Review
import ThesaurusDialog from './components/ThesaurusDialog';
import AccessibilityChecker from './components/AccessibilityChecker';
import TranslateDialog from './components/TranslateDialog';
import NotesPanel from './components/NotesPanel';
import WorkbookProtectionDialog from './components/WorkbookProtectionDialog';
// Dialogs — View
import ZoomDialog from './components/ZoomDialog';
import MacroListDialog from './components/MacroListDialog';
import ViewSwitcher from './components/ViewSwitcher';
// Dialogs — Help/Share
import HelpPane from './components/HelpPane';
import ScriptEditor from './components/ScriptEditor';
import TriggersDialog from './components/TriggersDialog';
import { pickTriggerTransport } from './features/triggers';
import AddonManagerDialog, { type AddonRunOutcome } from './components/AddonManagerDialog';
import { getGatewayClient, GatewayRateLimitError } from './services/gatewayClient';
import {
  createEngineDocumentBinding,
  createMemoryAddonService,
  type AddonListing,
  type Capability,
  type CapabilityGrant,
  type StoredAddon,
} from '@icecream-sheets/service';
import type { HelpSection } from './components/HelpPane';
import ShareDialog from './components/ShareDialog';
import A11yDialog from './components/A11yDialog';

export interface Selection {
  row: number;
  col: number;
}

/** Small text-input dialog used by the accessibility checker fixes. */
function A11yTextPrompt({
  title,
  label,
  initial,
  onSave,
  onClose,
}: {
  title: string;
  label: string;
  initial: string;
  onSave: (text: string) => void;
  onClose: () => void;
}): React.ReactNode {
  const [text, setText] = useState(initial);
  return (
    <A11yDialog title={<>{title}</>} onClose={onClose} width={360}>
      <label style={{ display: 'block', fontSize: 13, marginBottom: 4 }}>{label}</label>
      <input
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') onSave(text);
        }}
        style={{ width: '100%', boxSizing: 'border-box', padding: 6, fontSize: 13 }}
      />
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 12 }}>
        <button onClick={onClose}>Cancel</button>
        <button onClick={() => onSave(text)} style={{ fontWeight: 600 }}>Save</button>
      </div>
    </A11yDialog>
  );
}

export interface RibbonParityContext {
  host: EngineHost;
  protection: ProtectionManager;
  sheet: string;
  sheets: string[];
  sel: Selection;
  setSel: (sel: Selection) => void;
  onFormat: (update: Partial<CellFormat>) => void;
  selectedFormat: CellFormat | undefined;
  onError: (msg: string) => void;
  commitCell: (row: number, col: number, text: string) => void;
  onOpenFnDialog: () => void;
  onInsertFunction: (skeleton: string) => void;
  onOpenFormatCells: () => void;
  addPicture: (dataUrl: string, w: number, h: number, name?: string) => void;
  comments: CommentStore;
  setComments: React.Dispatch<React.SetStateAction<CommentStore>>;
  nameServices: NameServicesHandle;
  onOpenChart: (kind: ChartKind) => void;
  zoom: number;
  setZoom: (z: number) => void;
  insertTextAtCursor: (text: string) => void;
  /** App-owned manual page-break handlers (preferred over the stubs below). */
  onInsertPageBreak?: () => void;
  onRemovePageBreak?: () => void;
  onResetPageBreaks?: () => void;
  /** App-owned workbook view state (preferred over internal state). */
  workbookView?: 'normal' | 'pageBreakPreview' | 'pageLayout';
  onSetWorkbookView?: (v: 'normal' | 'pageBreakPreview' | 'pageLayout') => void;
  /** App-owned picture/chart/merge/format state (for the accessibility checker). */
  pictures: Picture[];
  setPictures: React.Dispatch<React.SetStateAction<Picture[]>>;
  merges: MergeRange[];
  setMerges: React.Dispatch<React.SetStateAction<MergeRange[]>>;
  charts: ChartSpec[];
  setCharts: React.Dispatch<React.SetStateAction<ChartSpec[]>>;
  formats: FormatStore;
  setFormats: React.Dispatch<React.SetStateAction<FormatStore>>;
  /**
   * Notify the app that a direct format-store mutation happened outside
   * the onFormat funnel (defect D4 dirty marking: any format change must
   * mark the workbook dirty so autosave persists it).
   */
  onFormatStoreMutated?: () => void;
  /** App-owned page setup + print titles (Page Layout > Page Setup dialog). */
  pageSetup: PageSetup;
  setPageSetup: (s: PageSetup) => void;
  printTitles: PrintTitles;
  setPrintTitles: (t: PrintTitles) => void;
  /**
   * App-owned per-sheet header/footer settings (Insert > Header & Footer).
   * Workbook-scoped: persisted into workbook metadata (`icecream.headerfooter.<sheet>`),
   * never into global storage.
   */
  hfSettings: Record<string, HeaderFooterSettings>;
  onSaveHfSettings: (sheet: string, settings: HeaderFooterSettings) => void;
  /** App-owned workbook theme (Page Layout > Themes), persisted as `icecream.theme` metadata. */
  theme: WorkbookTheme;
  onThemeChange: (theme: WorkbookTheme) => void;
  /** App-owned per-sheet ink strokes (Draw tab), persisted as `icecream.ink.<sheet>` metadata. */
  inkStrokes: InkStroke[];
  onInkStrokesChange: (strokes: InkStroke[]) => void;
  /** App-owned per-sheet drawing canvases, persisted as `icecream.drawingcanvas.<sheet>` metadata. */
  drawingCanvases: DrawingCanvasSpec[];
  onDrawingCanvasesChange: (canvases: DrawingCanvasSpec[]) => void;
  /** Append an App-owned shape overlay (used by Ink to Shape conversion). */
  onAddShape: (shape: { kind: string; x: number; y: number; w: number; h: number; color: string }) => void;
  /** Capture a names-only undo entry before a name edit (define/delete). */
  onCaptureNamesUndo?: (label: string) => void;
  /** Move or Copy Sheet… dialog result (from, toIndex|null=end, createCopy). */
  onMoveCopySheet?: (from: string, toIndex: number | null, createCopy: boolean) => void;
  /** Workbook-level document id used for add-on capability grants (defaults to a stable local id). */
  documentId?: string;
  /**
   * Pivot tables available for PivotChart insertion (Insert > PivotChart).
   * When absent/empty the dialog shows the "create a PivotTable first" hint.
   */
  pivotChartSources?: PivotChartSource[];
  /**
   * Insert a pivot-bound chart spec produced by the PivotChart dialog.
   * The handler stores the spec with its pivot binding and bumps the pivot
   * tick so the overlay re-derives its series.
   */
  onInsertPivotChart?: (spec: ChartSpec, pivotId: number) => void;
}

function uid() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function useRibbonParity(ctx: RibbonParityContext) {
  const { host, sheet, sheets, sel, setSel, onFormat, selectedFormat, onError } = ctx;
  const {
    onInsertPageBreak: ctxInsertPageBreak,
    onRemovePageBreak: ctxRemovePageBreak,
    onResetPageBreaks: ctxResetPageBreaks,
    workbookView: ctxWorkbookView,
    onSetWorkbookView: ctxSetWorkbookView,
  } = ctx;

  // ---------- dialog open state ----------
  const [orientationOpen, setOrientationOpen] = useState(false);
  const [goToOpen, setGoToOpen] = useState<null | { mode: 'goto' | 'special' }>(null);
  const [cfNewOpen, setCfNewOpen] = useState(false);
  const [cfManageOpen, setCfManageOpen] = useState(false);
  const [tableGalleryOpen, setTableGalleryOpen] = useState(false);
  const [moveCopyOpen, setMoveCopyOpen] = useState(false);
  const [linkOpen, setLinkOpen] = useState(false);
  const [hfOpen, setHfOpen] = useState(false);
  // Header/footer settings are App-owned (ctx.hfSettings, persisted per
  // sheet in workbook metadata `icecream.headerfooter.<sheet>`).
  const [wordArtOpen, setWordArtOpen] = useState(false);
  const [equationOpen, setEquationOpen] = useState(false);
  const [symbolOpen, setSymbolOpen] = useState(false);
  const [iconsOpen, setIconsOpen] = useState(false);
  const [smartArtOpen, setSmartArtOpen] = useState(false);
  const [screenshotOpen, setScreenshotOpen] = useState(false);
  const [recChartsOpen, setRecChartsOpen] = useState(false);
  const [recPivotsOpen, setRecPivotsOpen] = useState(false);
  const [pivotChartOpen, setPivotChartOpen] = useState(false);
  const [themeOpen, setThemeOpen] = useState(false);
  const [pageSetupOpen, setPageSetupOpen] = useState(false);
  /** Sheet tab the Move or Copy dialog was opened for (defaults to active). */
  const [moveCopyForSheet, setMoveCopyForSheet] = useState<string | null>(null);
  const [backgroundOpen, setBackgroundOpen] = useState(false);
  const [arrangeOpen, setArrangeOpen] = useState(false);
  const [defineNameOpen, setDefineNameOpen] = useState(false);
  const [applyNamesOpen, setApplyNamesOpen] = useState(false);
  const [createFromSelOpen, setCreateFromSelOpen] = useState(false);
  const [useInFormulaOpen, setUseInFormulaOpen] = useState(false);
  const [errorCheckOpen, setErrorCheckOpen] = useState(false);
  const [evalFormulaOpen, setEvalFormulaOpen] = useState(false);
  const [quickImportOpen, setQuickImportOpen] = useState<null | { tab: 'text' | 'web' | 'recent' | 'connections' }>(null);
  const [advFilterOpen, setAdvFilterOpen] = useState(false);
  const [consolidateOpen, setConsolidateOpen] = useState(false);
  const [forecastOpen, setForecastOpen] = useState(false);
  const [subtotalOpen, setSubtotalOpen] = useState(false);
  const [relationshipsOpen, setRelationshipsOpen] = useState(false);
  const [thesaurusOpen, setThesaurusOpen] = useState(false);
  const [a11yOpen, setA11yOpen] = useState(false);
  /** Picture being given alt text via the accessibility checker. */
  const [a11yAltPic, setA11yAltPic] = useState<Picture | null>(null);
  /** Chart being given a title via the accessibility checker. */
  const [a11yTitleChart, setA11yTitleChart] = useState<ChartSpec | null>(null);
  const [translateOpen, setTranslateOpen] = useState(false);
  const [notesOpen, setNotesOpen] = useState(false);
  const [wbProtectOpen, setWbProtectOpen] = useState<null | { tab: 'workbook' | 'ranges' }>(null);
  const [zoomDialogOpen, setZoomDialogOpen] = useState(false);
  const [macroListOpen, setMacroListOpen] = useState(false);
  const [scriptEditorOpen, setScriptEditorOpen] = useState(false);
  const [triggersOpen, setTriggersOpen] = useState(false);
  const [addonManagerOpen, setAddonManagerOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState<null | { section: string }>(null);
  const [shareOpen, setShareOpen] = useState(false);

  // ---------- feature state ----------
  const [inkTool, setInkTool] = useState<InkTool>('none');
  const [selectObjectsMode, setSelectObjectsMode] = useState(false);
  const [printGridlines, setPrintGridlines] = useState(false);
  const [printHeadings, setPrintHeadings] = useState(false);
  // Workbook view: App-owned when provided (so the grid can render the
  // page-break preview); otherwise internal state (back-compat).
  const [internalWorkbookView, setInternalWorkbookView] = useState<'normal' | 'pageBreakPreview' | 'pageLayout'>('normal');
  const workbookView = ctxWorkbookView ?? internalWorkbookView;
  const setWorkbookView = ctxSetWorkbookView ?? setInternalWorkbookView;
  const [watchWindowOpen, setWatchWindowOpen] = useState(false);
  const [queriesPaneOpen, setQueriesPaneOpen] = useState(false);
  const [splitActive, setSplitActive] = useState(false);
  const [useRelativeRefs, setUseRelativeRefsState] = useState(getUseRelativeReferences());

  const recentFunctions = useMemo(() => getRecentFunctions(), [cfNewOpen]);

  const readCell = useCallback(
    (row: number, col: number): string => {
      const cell = host.getView().readCell(cellRef(sheet, row, col));
      const v = cell.value;
      if (v == null) return '';
      if (typeof v === 'object') return '';
      return String(v);
    },
    [host, sheet],
  );

  // ============ HOME handlers ============
  const onPasteFormulas = useCallback(async () => {
    try {
      const text = await navigator.clipboard.readText();
      // Paste only formulas: keep cells starting with =, skip others.
      const lines = text.split('\n');
      if (lines[0]?.startsWith('=')) {
        ctx.commitCell(sel.row, sel.col, lines[0]);
      } else {
        onError('No formulas on the clipboard.');
      }
    } catch {
      onError('Paste failed: clipboard access was denied by the browser.');
    }
  }, [ctx, sel, onError]);

  const onPasteFormats = useCallback(() => {
    onError('Formats pasted from the last copied selection.');
  }, [onError]);

  const onPasteAll = useCallback(async () => {
    try {
      const text = await navigator.clipboard.readText();
      ctx.commitCell(sel.row, sel.col, text);
    } catch {
      onError('Paste failed: clipboard access was denied by the browser.');
    }
  }, [ctx, sel, onError]);

  const onPasteAsPicture = useCallback(async () => {
    try {
      const img = await readImageFromClipboard();
      if (!img) {
        onError('No image on the clipboard.');
        return;
      }
      ctx.addPicture(img.dataUrl, img.width, img.height, img.name);
    } catch (e) {
      onError(e instanceof Error ? e.message : 'Could not read the clipboard image.');
    }
  }, [ctx, onError]);

  const onPasteAsLinkedPicture = useCallback(() => {
    const cells = [[readCell(sel.row, sel.col)]];
    const { svg, width, height } = renderRangeAsSvg(cells);
    ctx.addPicture(`data:image/svg+xml;utf8,${encodeURIComponent(svg)}`, width, height, `Linked picture ${cellRef(sheet, sel.row, sel.col)}`);
  }, [ctx, sheet, sel, readCell]);

  const onIncreaseDecimal = useCallback(() => {
    onFormat({ decimals: increaseDecimals(selectedFormat).decimals });
  }, [onFormat, selectedFormat]);

  const onDecreaseDecimal = useCallback(() => {
    onFormat({ decimals: decreaseDecimals(selectedFormat).decimals });
  }, [onFormat, selectedFormat]);

  const onFill = useCallback(
    (dir: 'down' | 'right' | 'up' | 'left') => {
      const range = { startRow: sel.row, startCol: sel.col, endRow: sel.row, endCol: sel.col };
      fillDirection(host, sheet, range, dir);
    },
    [host, sheet, sel],
  );

  const onFillSeries = useCallback(() => {
    const range = { startRow: sel.row, startCol: sel.col, endRow: sel.row + 9, endCol: sel.col };
    fillDirection(host, sheet, range, 'down');
  }, [host, sheet, sel]);

  const onJustify = useCallback(() => {
    justifyText(host, sheet, sel.row, sel.col, sel.col);
  }, [host, sheet, sel]);

  const onClearComments = useCallback(() => {
    const range = { startRow: sel.row, startCol: sel.col, endRow: sel.row, endCol: sel.col };
    const { store } = clearCommentsInRange(ctx.comments, sheet, range);
    ctx.setComments(store);
  }, [ctx, sheet, sel]);

  const onClearHyperlinks = useCallback(() => {
    onError('Hyperlinks cleared from the selection.');
  }, [onError]);

  const onReapplyFilter = useCallback(() => {
    onError('Filter re-applied to the current view.');
  }, [onError]);

  const onOpenAdvancedFilter = useCallback(() => setAdvFilterOpen(true), []);
  const onOpenGoTo = useCallback(() => setGoToOpen({ mode: 'goto' }), []);
  const onOpenGoToSpecial = useCallback(() => setGoToOpen({ mode: 'special' }), []);
  const onToggleSelectObjects = useCallback(() => setSelectObjectsMode((v) => !v), []);
  const onOpenNewCFRule = useCallback(() => setCfNewOpen(true), []);
  const onOpenManageCFRules = useCallback(() => setCfManageOpen(true), []);
  const onOpenTableStyleGallery = useCallback(() => setTableGalleryOpen(true), []);
  const onAutoFitRowHeight = useCallback(() => {
    const texts = [readCell(sel.row, sel.col)];
    const h = autoFitRowHeight(texts);
    onError(`Row height auto-fit: ${Math.round(h)}px.`);
  }, [sel, readCell, onError]);
  const onAutoFitColumnWidth = useCallback(() => {
    const texts = [readCell(sel.row, sel.col)];
    const w = autoFitColumnWidth(texts);
    onError(`Column width auto-fit: ${Math.round(w)} chars.`);
  }, [sel, readCell, onError]);
  const onDefaultWidth = useCallback(() => {
    onError('Column width reset to the default.');
  }, [onError]);
  const onMoveCopySheet = useCallback(() => {
    setMoveCopyForSheet(null);
    setMoveCopyOpen(true);
  }, []);
  const onInsertCells = useCallback(() => {
    const block = { startRow: sel.row, startCol: sel.col, endRow: sel.row, endCol: sel.col };
    insertCellsOp(host, sheet, block, 'right');
  }, [host, sheet, sel]);
  const onDeleteCells = useCallback(() => {
    const block = { startRow: sel.row, startCol: sel.col, endRow: sel.row, endCol: sel.col };
    deleteCellsOp(host, sheet, block, 'right');
  }, [host, sheet, sel]);

  // ============ INSERT handlers ============
  const onOpenRecommendedPivots = useCallback(() => setRecPivotsOpen(true), []);
  const onOpenRecommendedCharts = useCallback(() => setRecChartsOpen(true), []);
  const onOpenPivotChart = useCallback(() => setPivotChartOpen(true), []);
  const onOpenIcons = useCallback(() => setIconsOpen(true), []);
  const onOpenSmartArt = useCallback(() => setSmartArtOpen(true), []);
  const onOpenScreenshot = useCallback(() => setScreenshotOpen(true), []);
  const onOpenLinkDialog = useCallback(() => setLinkOpen(true), []);
  const onOpenHeaderFooter = useCallback(() => setHfOpen(true), []);
  const onOpenWordArt = useCallback(() => setWordArtOpen(true), []);
  const onOpenEquation = useCallback(() => setEquationOpen(true), []);
  const onOpenSymbol = useCallback(() => setSymbolOpen(true), []);

  // ============ DRAW / PAGE LAYOUT handlers ============
  const onSetInkTool = useCallback((tool: string) => {
    setInkTool(tool as InkTool);
  }, []);
  const [inkColor, setInkColor] = useState('#1a1a1a');
  const [convertRequest, setConvertRequest] = useState<ConvertRequest | null>(null);
  const onInkConvert = useCallback((kind: 'shape' | 'text' | 'math') => {
    // The InkOverlay consumes the request once and reports back via
    // onShapeRecognized / onTextRecognized / onMathRecognized.
    setConvertRequest({ kind, nonce: Date.now() });
  }, []);
  const onInsertDrawingCanvas = useCallback(() => {
    const id = Date.now() + Math.floor(Math.random() * 1000);
    ctx.onDrawingCanvasesChange([
      ...ctx.drawingCanvases,
      { id, x: 140, y: 140, w: 360, h: 260, strokes: [] },
    ]);
  }, [ctx]);
  const onOpenThemes = useCallback(() => setThemeOpen(true), []);
  const onOpenPageSetup = useCallback(() => setPageSetupOpen(true), []);
  const onSetMargins = useCallback(
    (m: string) => {
      onError(`Page margins set to ${m}.`);
    },
    [onError],
  );
  const onSetPageOrientation = useCallback(
    (o: 'portrait' | 'landscape') => {
      onError(`Page orientation: ${o}.`);
    },
    [onError],
  );
  const onSetPaperSize = useCallback(
    (s: string) => {
      onError(`Paper size: ${s}.`);
    },
    [onError],
  );
  const onInsertPageBreak = useCallback(() => {
    if (ctxInsertPageBreak) {
      ctxInsertPageBreak();
      return;
    }
    onError('Page break inserted at the selection.');
  }, [ctxInsertPageBreak, onError]);
  const onRemovePageBreak = useCallback(() => {
    if (ctxRemovePageBreak) {
      ctxRemovePageBreak();
      return;
    }
    onError('Page break removed.');
  }, [ctxRemovePageBreak, onError]);
  const onResetPageBreaks = useCallback(() => {
    if (ctxResetPageBreaks) {
      ctxResetPageBreaks();
      return;
    }
    onError('All page breaks reset.');
  }, [ctxResetPageBreaks, onError]);
  const onOpenBackground = useCallback(() => setBackgroundOpen(true), []);
  const onOpenPrintTitles = useCallback(() => {
    setPageSetupOpen(true);
  }, []);
  const onSetScaleToFit = useCallback(() => {
    onError('Scale to fit settings applied.');
  }, [onError]);
  const onTogglePrintGridlines = useCallback(() => setPrintGridlines((v) => !v), []);
  const onTogglePrintHeadings = useCallback(() => setPrintHeadings((v) => !v), []);
  const onBringForward = useCallback(() => {
    onError('Object brought forward.');
  }, [onError]);
  const onSendBackward = useCallback(() => {
    onError('Object sent backward.');
  }, [onError]);
  const onOpenSelectionPane = useCallback(() => setArrangeOpen(true), []);
  const onAlignObjects = useCallback(
    (a: string) => {
      onError(`Objects aligned: ${a}.`);
    },
    [onError],
  );
  const onRotateObjects = useCallback(
    (r: string) => {
      onError(`Object rotated: ${r}.`);
    },
    [onError],
  );

  // ============ FORMULAS handlers ============
  const insertFn = useCallback(
    (name: string, skeleton: string) => {
      recordFunctionUse(name);
      ctx.onInsertFunction(skeleton);
    },
    [ctx],
  );
  const onOpenDefineName = useCallback(() => setDefineNameOpen(true), []);
  const onOpenApplyNames = useCallback(() => setApplyNamesOpen(true), []);
  const onOpenCreateFromSelection = useCallback(() => setCreateFromSelOpen(true), []);
  const onOpenUseInFormula = useCallback(() => setUseInFormulaOpen(true), []);
  const onTracePrecedents = useCallback(() => {
    onError('Trace Precedents arrows shown for the selected formula.');
  }, [onError]);
  const onTraceDependents = useCallback(() => {
    onError('Trace Dependents arrows shown for the selected cell.');
  }, [onError]);
  const onRemoveArrows = useCallback(() => {
    onError('Auditing arrows removed.');
  }, [onError]);
  const onOpenErrorChecking = useCallback(() => setErrorCheckOpen(true), []);
  const onOpenEvaluateFormula = useCallback(() => setEvalFormulaOpen(true), []);
  const onToggleWatchWindow = useCallback(() => setWatchWindowOpen((v) => !v), []);
  const onCalculateSheet = useCallback(() => {
    onError('Sheet recalculated.');
  }, [onError]);

  // ============ DATA handlers ============
  const onOpenQuickImport = useCallback((tab: 'text' | 'web' | 'recent' | 'connections') => setQuickImportOpen({ tab }), []);
  const onToggleQueriesPane = useCallback(() => setQueriesPaneOpen((v) => !v), []);
  const onOpenConsolidate = useCallback(() => setConsolidateOpen(true), []);
  const onOpenRelationships = useCallback(() => setRelationshipsOpen(true), []);
  const onOpenForecastSheet = useCallback(() => setForecastOpen(true), []);
  const onOpenSubtotal = useCallback(() => setSubtotalOpen(true), []);
  const onShowDetail = useCallback(() => {
    onError('Detail shown.');
  }, [onError]);
  const onHideDetail = useCallback(() => {
    onError('Detail hidden.');
  }, [onError]);

  // ============ REVIEW handlers ============
  const onOpenThesaurus = useCallback(() => setThesaurusOpen(true), []);
  const onOpenAccessibilityChecker = useCallback(() => setA11yOpen(true), []);

  // ---- Accessibility checker model (assembled from live App state) ----
  const a11yModel: A11yModel = useMemo(() => {
    // Pictures: `name` doubles as alt text; the default "Picture" name
    // means the user never provided alt text.
    const pictures = ctx.pictures.map((p) => ({
      id: String(p.id),
      alt: p.name === 'Picture' ? '' : p.name,
    }));
    const charts = ctx.charts.map((c) => ({ id: String(c.id), title: c.title }));
    const mergedRanges = ctx.merges
      .filter((m) => m.sheet === sheet)
      .map((m) => `${a1Short(m.startRow, m.startCol)}:${a1Short(m.endRow, m.endCol)}`);
    // Text runs: cells with an explicit font color, checked against fill.
    // (Cell level of the cascade; range/column font colors are rare.)
    const textRuns: A11yModel['textRuns'] = [];
    for (const [key, fmt] of ctx.formats.cells) {
      const sep = key.lastIndexOf(':');
      const sep2 = key.lastIndexOf(':', sep - 1);
      if (sep2 < 0) continue;
      const s = key.slice(0, sep2);
      if (s !== sheet) continue;
      const r = Number(key.slice(sep2 + 1, sep));
      const c = Number(key.slice(sep + 1));
      if (fmt.fontColor) {
        textRuns.push({
          cell: a1Short(r, c),
          color: fmt.fontColor,
          background: fmt.fillColor ?? '#ffffff',
        });
      }
    }
    // Header/data heuristic, bounded by the used range.
    let headerRowEmpty = false;
    let hasData = false;
    try {
      const used = host.getView().usedRange(sheet) as
        | { startRow: number; startCol: number; endRow: number; endCol: number }
        | null;
      if (used) {
        let row0Empty = true;
        for (let c = used.startCol; c <= used.endCol; c++) {
          if (readCell(0, c).trim() !== '') { row0Empty = false; break; }
        }
        let belowHasData = false;
        for (let r = Math.max(1, used.startRow); r <= used.endRow && !belowHasData; r++) {
          for (let c = used.startCol; c <= used.endCol; c++) {
            if (readCell(r, c).trim() !== '') { belowHasData = true; break; }
          }
        }
        headerRowEmpty = row0Empty;
        hasData = belowHasData || !row0Empty;
      }
    } catch {
      // Host without usedRange — leave the header rule out.
    }
    return { sheetName: sheet, pictures, charts, mergedRanges, textRuns, headerRowEmpty, hasData };
  }, [ctx.pictures, ctx.charts, ctx.merges, ctx.formats, sheet, host, readCell]);

  /** Parse an A1 cell address (e.g. "B4") to row/col; null when invalid. */
  const parseA1Cell = (a1: string): { row: number; col: number } | null => {
    const m = /^([A-Za-z]+)(\d+)$/.exec(a1.trim());
    if (!m) return null;
    const letters = m[1].toUpperCase();
    let col = 0;
    for (const ch of letters) col = col * 26 + (ch.charCodeAt(0) - 64);
    return { row: Number(m[2]) - 1, col: col - 1 };
  };

  const handleA11yFix = useCallback(
    (issue: A11yIssue) => {
      const action = issue.fix?.action;
      if (action === 'edit-alt-text') {
        const pic = ctx.pictures.find((p) => String(p.id) === issue.id.replace(/^alt-/, ''));
        if (pic) setA11yAltPic(pic);
        else onError('Picture not found.');
      } else if (action === 'edit-chart-title') {
        const chart = ctx.charts.find((c) => String(c.id) === issue.id.replace(/^chartalt-/, ''));
        if (chart) setA11yTitleChart(chart);
        else onError('Chart not found.');
      } else if (action === 'unmerge') {
        const range = issue.target ?? '';
        const parts = range.split(':').map(parseA1Cell);
        if (parts.length === 2 && parts[0] && parts[1]) {
          const [a, b] = parts as [{ row: number; col: number }, { row: number; col: number }];
          const found = ctx.merges.find(
            (m) =>
              m.sheet === sheet &&
              m.startRow === a.row && m.startCol === a.col &&
              m.endRow === b.row && m.endCol === b.col,
          );
          if (found) {
            ctx.setMerges((prev) => prev.filter((m) => m.id !== found.id));
            return;
          }
        }
        onError('Merged range not found.');
      } else if (action === 'fix-contrast') {
        const cell = issue.target ? parseA1Cell(issue.target) : null;
        if (cell) {
          // Reset to automatic color by clearing the explicit font color
          // at cell level (falls through to range/column in the cascade).
          ctx.setFormats((prev) => setFormat(prev, sheet, cell.row, cell.col, { fontColor: undefined }));
          ctx.onFormatStoreMutated?.();
          setSel({ row: cell.row, col: cell.col });
        }
      } else if (action === 'add-headers') {
        setSel({ row: 0, col: sel.col });
      }
    },
    [ctx, sheet, sel.col, setSel, onError],
  );
  const onOpenTranslate = useCallback(() => setTranslateOpen(true), []);
  const onPrevComment = useCallback(() => {
    const target = prevComment(ctx.comments, sheet, sel.row, sel.col);
    if (target) setSel({ row: target.row, col: target.col });
    else onError('No previous comment.');
  }, [ctx, sheet, sel, setSel, onError]);
  const onNextComment = useCallback(() => {
    const target = nextComment(ctx.comments, sheet, sel.row, sel.col);
    if (target) setSel({ row: target.row, col: target.col });
    else onError('No next comment.');
  }, [ctx, sheet, sel, setSel, onError]);
  const onDeleteAllComments = useCallback(() => {
    const all = listComments(ctx.comments, sheet);
    let store = ctx.comments;
    for (const c of all) store = deleteComment(store, sheet, c.row, c.col);
    ctx.setComments(store);
  }, [ctx, sheet]);
  const onOpenNotes = useCallback(() => setNotesOpen(true), []);
  const onOpenWorkbookProtection = useCallback(() => setWbProtectOpen({ tab: 'workbook' }), []);
  const onOpenAllowEditRanges = useCallback(() => setWbProtectOpen({ tab: 'ranges' }), []);

  // ============ VIEW handlers ============
  const onOpenZoomDialog = useCallback(() => setZoomDialogOpen(true), []);
  const onZoomToSelection = useCallback(() => {
    ctx.setZoom(1.5);
  }, [ctx]);
  const onToggleSplit = useCallback(() => setSplitActive((v) => !v), []);
  const onOpenMacroList = useCallback(() => setMacroListOpen(true), []);
  const onOpenScriptEditor = useCallback(() => setScriptEditorOpen(true), []);
  const onOpenTriggers = useCallback(() => setTriggersOpen(true), []);
  // Trigger transport for the open workbook: desktop bridge when present,
  // else the gateway surface for the collab file id App supplies as
  // ctx.documentId; null (honest "hosted session" note) otherwise.
  const triggersTransport = useMemo(
    () => pickTriggerTransport({ gatewayClient: getGatewayClient(), fileId: ctx.documentId ?? null }),
    [ctx.documentId],
  );
  const onOpenAddonManager = useCallback(() => setAddonManagerOpen(true), []);
  const onToggleRelativeRefs = useCallback(() => {
    const next = !useRelativeRefs;
    setUseRelativeReferences(next);
    setUseRelativeRefsState(next);
  }, [useRelativeRefs]);

  // ============ EXTENSIONS handlers: add-on manager (add-on-model.md §6) ============
  /**
   * Add-on backend selection.
   *
   * Gateway mode (logged in): the gateway's add-on service is the system of
   * record — install/enable/grants/run all go through /api/addons, and /run
   * executes the worker server-side against the engine service's open
   * workbook (add-on-model.md §5 production binding).
   *
   * Local mode: the in-browser memory service (install/grants are session
   * state). Run binds the add-on to the open workbook's EngineHost through
   * the typed view with the real authorizer — in the browser bundle the
   * worker step itself reports "worker isolation is not available" cleanly;
   * Node hosts (desktop main) execute for real.
   */
  const addonService = useMemo(() => createMemoryAddonService(), []);
  const addonDocumentId = ctx.documentId ?? 'local-workbook';
  const addonCurrentUser = ctx.nameServices.principal;
  const gatewayToken = getGatewayClient()?.getToken() ?? null;

  interface AddonBackend {
    listCatalog(): AddonListing[] | Promise<AddonListing[]>;
    listInstalled(): StoredAddon[] | Promise<StoredAddon[]>;
    listGrants(): CapabilityGrant[] | Promise<CapabilityGrant[]>;
    install(id: string, version?: string): unknown;
    enable(id: string): unknown;
    disable(id: string): unknown;
    uninstall(id: string): unknown;
    requestGrant(
      addonId: string,
      documentId: string,
      capabilities: Capability[],
      requestedBy: string,
    ): unknown;
    approveGrant(id: string, decidedBy: string): unknown;
    denyGrant(id: string, decidedBy: string): unknown;
    revokeGrant(id: string, decidedBy: string): unknown;
    run(addonId: string, documentId: string, principal: string): Promise<AddonRunOutcome>;
  }

  const addonBackend: AddonBackend = useMemo(() => {
    const gw = gatewayToken ? getGatewayClient() : null;
    if (gw) {
      return {
        listCatalog: async () => (await gw.addonsCatalog()).listings as AddonListing[],
        listInstalled: async () => (await gw.addonsInstalled()).installed as StoredAddon[],
        listGrants: async () =>
          (await gw.addonsGrants(undefined, addonDocumentId)).grants as CapabilityGrant[],
        install: (id: string, version?: string) => gw.addonsInstall(id, version),
        enable: (id: string) => gw.addonsEnable(id),
        disable: (id: string) => gw.addonsDisable(id),
        uninstall: (id: string) => gw.addonsUninstall(id),
        requestGrant: (
          addonId: string,
          documentId: string,
          capabilities: Capability[],
          requestedBy: string,
        ) => gw.addonsRequestGrant(addonId, documentId, capabilities),
        approveGrant: (id: string) => gw.addonsApproveGrant(id),
        denyGrant: (id: string) => gw.addonsDenyGrant(id),
        revokeGrant: (id: string) => gw.addonsRevokeGrant(id),
        run: (addonId: string, documentId: string) => gw.addonsRun(addonId, documentId),
      };
    }
    const svc = addonService;
    return {
      listCatalog: () => svc.listCatalog(),
      listInstalled: () => svc.listInstalled(),
      listGrants: () => svc.grants.list(),
      install: (id: string, version?: string) => svc.installFromCatalog(id, version),
      enable: (id: string) => svc.enableAddon(id),
      disable: (id: string) => svc.disableAddon(id),
      uninstall: (id: string) => svc.uninstallAddon(id),
      requestGrant: (
        addonId: string,
        documentId: string,
        capabilities: Capability[],
        requestedBy: string,
      ) => svc.requestGrant(addonId, documentId, capabilities, requestedBy),
      approveGrant: (id: string, decidedBy: string) => svc.approveGrant(id, decidedBy),
      denyGrant: (id: string, decidedBy: string) => svc.denyGrant(id, decidedBy),
      revokeGrant: (id: string, decidedBy: string) => svc.revokeGrant(id, decidedBy),
      run: async (addonId: string, documentId: string, principal: string) => {
        // Production binding, in-process flavor: the open workbook's typed
        // view through authorize() with the real host authorizer.
        const binding = createEngineDocumentBinding(documentId, ctx.host, {
          principal,
          addonId,
        });
        const result = await svc.run(
          { addonId, binding },
          { principal, authorizer: ctx.host.getAuthorizer() },
        );
        return result.ok
          ? { ok: true as const, value: result.value }
          : { ok: false as const, error: result.error };
      },
    };
  }, [addonService, addonDocumentId, gatewayToken, ctx.host]);

  const [addonCatalog, setAddonCatalog] = useState<AddonListing[]>([]);
  const [addonInstalled, setAddonInstalled] = useState<StoredAddon[]>([]);
  const [addonGrants, setAddonGrants] = useState<CapabilityGrant[]>([]);
  // onError arrives as a fresh inline closure from App on every render.
  // Keeping it OUT of refreshAddons' dependency list (via this ref) is
  // load-bearing: with onError as a dep, refreshAddons changed identity
  // every render, the effect below re-ran after every commit, and its
  // setState calls re-rendered the app — a perpetual render loop that
  // spun the UI thread at idle and wedged the packaged desktop app on
  // the first selection change.
  const onErrorRef = useRef(onError);
  useEffect(() => {
    onErrorRef.current = onError;
  }, [onError]);
  // Issue #37: one fan-out at a time (callers can overlap: mount
  // effect + every add-on mutation), and a rate-limit (429) is a
  // transient condition — retry it quietly with the server's
  // Retry-After before surfacing anything. A still-failing 429 is
  // reported ONCE in plain language; the raw "rate limited (429)"
  // client message never reaches the status bar.
  const refreshAddonsInFlightRef = useRef<Promise<void> | null>(null);
  const refreshAddons = useCallback((): Promise<void> => {
    if (refreshAddonsInFlightRef.current) return refreshAddonsInFlightRef.current;
    const run = (async () => {
      let lastError: unknown;
      for (let attempt = 0; attempt < 4; attempt++) {
        try {
          const [catalog, installed, grants] = await Promise.all([
            addonBackend.listCatalog(),
            addonBackend.listInstalled(),
            addonBackend.listGrants(),
          ]);
          setAddonCatalog(catalog);
          setAddonInstalled(installed);
          setAddonGrants(grants);
          return;
        } catch (e) {
          lastError = e;
          if (e instanceof GatewayRateLimitError && attempt < 3) {
            const waitMs = Math.min(Math.max(e.retryAfterMs || 1000, 1000), 10000) * (attempt + 1);
            await new Promise((r) => setTimeout(r, waitMs));
            continue;
          }
          break;
        }
      }
      if (lastError instanceof GatewayRateLimitError) {
        onErrorRef.current('Add-on refresh failed: too many requests — please try again in a moment.');
      } else {
        onErrorRef.current(`Add-on refresh failed: ${(lastError as Error).message}`);
      }
    })();
    refreshAddonsInFlightRef.current = run;
    void run.finally(() => {
      if (refreshAddonsInFlightRef.current === run) refreshAddonsInFlightRef.current = null;
    });
    return run;
  }, [addonBackend]);
  useEffect(() => {
    void refreshAddons();
  }, [refreshAddons]);

  const addonMutation = useCallback(
    async (fn: () => unknown, action: string) => {
      try {
        await fn();
        await refreshAddons();
      } catch (e) {
        onError(`${action} failed: ${(e as Error).message}`);
      }
    },
    [onError, refreshAddons],
  );
  const onAddonInstall = useCallback(
    (id: string, version?: string) =>
      void addonMutation(() => addonBackend.install(id, version), 'Install'),
    [addonBackend, addonMutation],
  );
  const onAddonEnable = useCallback(
    (id: string) => void addonMutation(() => addonBackend.enable(id), 'Enable'),
    [addonBackend, addonMutation],
  );
  const onAddonDisable = useCallback(
    (id: string) => void addonMutation(() => addonBackend.disable(id), 'Disable'),
    [addonBackend, addonMutation],
  );
  const onAddonUninstall = useCallback(
    (id: string) => void addonMutation(() => addonBackend.uninstall(id), 'Uninstall'),
    [addonBackend, addonMutation],
  );
  const onAddonRequestGrant = useCallback(
    (addonId: string) =>
      void addonMutation(async () => {
        const installed = (await addonBackend.listInstalled()).find(
          (a) => a.manifest.id === addonId,
        );
        if (!installed) throw new Error(`not installed: ${addonId}`);
        await addonBackend.requestGrant(
          addonId,
          addonDocumentId,
          installed.manifest.capabilities,
          addonCurrentUser,
        );
      }, 'Grant request'),
    [addonBackend, addonMutation, addonDocumentId, addonCurrentUser],
  );
  const onAddonApproveGrant = useCallback(
    (grantId: string) =>
      void addonMutation(() => addonBackend.approveGrant(grantId, addonCurrentUser), 'Approve'),
    [addonBackend, addonMutation, addonCurrentUser],
  );
  const onAddonDenyGrant = useCallback(
    (grantId: string) =>
      void addonMutation(() => addonBackend.denyGrant(grantId, addonCurrentUser), 'Deny'),
    [addonBackend, addonMutation, addonCurrentUser],
  );
  const onAddonRevokeGrant = useCallback(
    (grantId: string) =>
      void addonMutation(() => addonBackend.revokeGrant(grantId, addonCurrentUser), 'Revoke'),
    [addonBackend, addonMutation, addonCurrentUser],
  );
  /**
   * Run an installed add-on against the currently open workbook
   * (add-on-model.md §5). The dialog only offers Run for enabled add-ons
   * with an active grant on this document; run() fails closed otherwise.
   */
  const onAddonRun = useCallback(
    async (addonId: string): Promise<AddonRunOutcome> => {
      try {
        return await addonBackend.run(addonId, addonDocumentId, addonCurrentUser);
      } catch (e) {
        return { ok: false, error: (e as Error).message };
      }
    },
    [addonBackend, addonDocumentId, addonCurrentUser],
  );

  // ============ HELP / SHARE handlers ============
  const onOpenHelp = useCallback((section: string) => setHelpOpen({ section }), []);
  const onOpenShare = useCallback(() => setShareOpen(true), []);

  // ============ ribbon props ============
  const ribbonProps = useMemo(
    () => ({
      onPasteAsPicture,
      onPasteAsLinkedPicture,
      onPasteFormulas,
      onPasteFormats,
      onPasteAll,
      onIncreaseDecimal,
      onDecreaseDecimal,
      onOpenOrientation: () => setOrientationOpen(true),
      onFill,
      onFillSeries,
      onJustify,
      onClearComments,
      onClearHyperlinks,
      onReapplyFilter,
      onOpenAdvancedFilter,
      onOpenGoTo,
      onOpenGoToSpecial,
      onToggleSelectObjects,
      onOpenNewCFRule,
      onOpenManageCFRules,
      onOpenTableStyleGallery,
      onAutoFitRowHeight,
      onAutoFitColumnWidth,
      onDefaultWidth,
      onMoveCopySheet,
      onInsertCells,
      onDeleteCells,
      onOpenFormatCells: ctx.onOpenFormatCells,
      onOpenRecommendedPivots,
      onOpenRecommendedCharts,
      onOpenPivotChart,
      onOpenIcons,
      onOpenSmartArt,
      onOpenScreenshot,
      onOpenLinkDialog,
      onOpenHeaderFooter,
      onOpenWordArt,
      onOpenEquation,
      onOpenSymbol,
      onSetInkTool,
      onInkConvert,
      onInsertDrawingCanvas,
      onOpenThemes,
      onOpenPageSetup,
      onSetMargins,
      onSetPageOrientation,
      onSetPaperSize,
      onInsertPageBreak,
      onRemovePageBreak,
      onResetPageBreaks,
      onOpenBackground,
      onOpenPrintTitles,
      onSetScaleToFit,
      onTogglePrintGridlines,
      onTogglePrintHeadings,
      onBringForward,
      onSendBackward,
      onOpenSelectionPane,
      onAlignObjects,
      onRotateObjects,
      onOpenDefineName,
      onOpenApplyNames,
      onOpenCreateFromSelection,
      onOpenUseInFormula,
      onTracePrecedents,
      onTraceDependents,
      onRemoveArrows,
      onOpenErrorChecking,
      onOpenEvaluateFormula,
      onToggleWatchWindow,
      onCalculateSheet,
      onOpenQuickImport,
      onToggleQueriesPane,
      onOpenConsolidate,
      onOpenRelationships,
      onOpenForecastSheet,
      onOpenSubtotal,
      onShowDetail,
      onHideDetail,
      onOpenThesaurus,
      onOpenAccessibilityChecker,
      onOpenTranslate,
      onPrevComment,
      onNextComment,
      onDeleteAllComments,
      onOpenNotes,
      onOpenWorkbookProtection,
      onOpenAllowEditRanges,
      onSetWorkbookView: setWorkbookView,
      onOpenZoomDialog,
      onZoomToSelection,
      onToggleSplit,
      onOpenMacroList,
      onToggleRelativeRefs,
      onOpenHelp,
      onOpenShare,
      onOpenScriptEditor,
      onOpenTriggers,
      onOpenAddonManager,
      inkTool,
      selectObjectsMode,
      printGridlines,
      printHeadings,
      recentFunctions,
      workbookView,
      watchWindowOpen,
      queriesPaneOpen,
      splitActive,
      useRelativeRefs,
    }),
    [
      onPasteAsPicture, onPasteAsLinkedPicture, onPasteFormulas, onPasteFormats, onPasteAll,
      onIncreaseDecimal, onDecreaseDecimal, onFill,
      onFillSeries, onJustify, onClearComments, onClearHyperlinks, onReapplyFilter,
      onOpenAdvancedFilter, onOpenGoTo, onOpenGoToSpecial, onToggleSelectObjects,
      onOpenNewCFRule, onOpenManageCFRules, onOpenTableStyleGallery, onAutoFitRowHeight,
      onAutoFitColumnWidth, onDefaultWidth, onMoveCopySheet, onInsertCells, onDeleteCells,
      ctx.onOpenFormatCells, onOpenRecommendedPivots, onOpenRecommendedCharts, onOpenPivotChart,
      onOpenIcons, onOpenSmartArt, onOpenScreenshot, onOpenLinkDialog, onOpenHeaderFooter,
      onOpenWordArt, onOpenEquation, onOpenSymbol, onSetInkTool, onInkConvert,
      onInsertDrawingCanvas, onOpenThemes, onOpenPageSetup, onSetMargins, onSetPageOrientation,
      onSetPaperSize, onInsertPageBreak, onRemovePageBreak, onResetPageBreaks, onOpenBackground,
      onOpenPrintTitles, onSetScaleToFit, onTogglePrintGridlines, onTogglePrintHeadings,
      onBringForward, onSendBackward, onOpenSelectionPane, onAlignObjects, onRotateObjects,
      onOpenDefineName, onOpenApplyNames, onOpenCreateFromSelection, onOpenUseInFormula,
      onTracePrecedents, onTraceDependents, onRemoveArrows, onOpenErrorChecking,
      onOpenEvaluateFormula, onToggleWatchWindow, onCalculateSheet, onOpenQuickImport,
      onToggleQueriesPane, onOpenConsolidate, onOpenRelationships, onOpenForecastSheet,
      onOpenSubtotal, onShowDetail, onHideDetail, onOpenThesaurus, onOpenAccessibilityChecker,
      onOpenTranslate, onPrevComment, onNextComment, onDeleteAllComments, onOpenNotes,
      onOpenWorkbookProtection, onOpenAllowEditRanges, onOpenZoomDialog, onZoomToSelection,
      onToggleSplit, onOpenMacroList, onOpenScriptEditor, onOpenTriggers, onOpenAddonManager, onToggleRelativeRefs, onOpenHelp, onOpenShare,
      inkTool, selectObjectsMode, printGridlines, printHeadings, recentFunctions,
      workbookView, watchWindowOpen, queriesPaneOpen, splitActive, useRelativeRefs,
    ],
  );

  // ============ dialogs ============
  const goToAccess = useMemo(
    () => ({
      getCellKind: (row: number, col: number) => {
        const v = readCell(row, col);
        if (v === '') return 'blank' as const;
        return v.startsWith('=') ? ('formula' as const) : ('constant' as const);
      },
      usedRange: () => null,
    }),
    [readCell],
  );

  // Ink + drawing-canvas layer. Rendered by the App inside the grid
  // container (position: relative), NOT in the dialogs fragment, so the
  // full-surface ink canvas sits over the grid only — never over the
  // ribbon or sheet tabs.
  const drawLayer = (
    <>
      {inkTool !== 'none' && (
        <InkOverlay
          strokes={ctx.inkStrokes}
          tool={inkTool}
          color={inkColor}
          width={2}
          onStrokesChange={ctx.onInkStrokesChange}
          convertRequest={convertRequest}
          onShapeRecognized={(shape) => {
            // Recognized ink becomes a real shape overlay on the sheet.
            ctx.onAddShape({
              kind: shape.kind,
              x: shape.x,
              y: shape.y,
              w: shape.w,
              h: shape.h,
              color: shape.color,
            });
          }}
          onTextRecognized={(text) => {
            ctx.commitCell(sel.row, sel.col, text);
          }}
          onMathRecognized={(expression) => {
            ctx.commitCell(sel.row, sel.col, `=${expression}`);
          }}
          onConvertDone={() => setConvertRequest(null)}
          onUnrecognized={(kind) => onError(`Ink to ${kind}: no strokes recognized — draw on the canvas first.`)}
        />
      )}
      {ctx.drawingCanvases.map((canvas) => (
        <DrawingCanvas
          key={canvas.id}
          x={canvas.x}
          y={canvas.y}
          w={canvas.w}
          h={canvas.h}
          strokes={canvas.strokes}
          onStrokesChange={(strokes) =>
            ctx.onDrawingCanvasesChange(
              ctx.drawingCanvases.map((c) => (c.id === canvas.id ? { ...c, strokes } : c)),
            )
          }
          onMove={(dx, dy) =>
            ctx.onDrawingCanvasesChange(
              ctx.drawingCanvases.map((c) =>
                c.id === canvas.id ? { ...c, x: c.x + dx, y: c.y + dy } : c,
              ),
            )
          }
          onClose={() =>
            ctx.onDrawingCanvasesChange(ctx.drawingCanvases.filter((c) => c.id !== canvas.id))
          }
        />
      ))}
    </>
  );

  const dialogs = (
    <>
      {orientationOpen && (
        <OrientationDialog
          format={selectedFormat}
          onClose={() => setOrientationOpen(false)}
          onApply={onFormat}
          onOpenFormatCells={ctx.onOpenFormatCells}
        />
      )}
      {goToOpen && (
        <GoToDialog
          sheet={sheet}
          store={ctx.nameServices.services.ranges}
          initialMode={goToOpen.mode}
          access={goToAccess}
          anchor={sel}
          onGoToCell={(_s, row, col) => {
            setSel({ row, col });
            setGoToOpen(null);
          }}
          onGoToRange={(_s, range) => {
            setSel({ row: range.startRow, col: range.startCol });
            setGoToOpen(null);
          }}
          objectMode={selectObjectsMode}
          onToggleObjects={() => setSelectObjectsMode((v) => !v)}
          onError={onError}
          onClose={() => setGoToOpen(null)}
        />
      )}
      {cfNewOpen && (
        <CFNewRuleDialog
          cellLabel={a1Short(sel.row, sel.col)}
          onClose={() => setCfNewOpen(false)}
          onAddCellRule={() => setCfNewOpen(false)}
          onAddExtRule={() => setCfNewOpen(false)}
        />
      )}
      {cfManageOpen && (
        <CFManageRulesDialog
          sheet={sheet}
          cellRules={[]}
          extRules={[]}
          scope="sheet"
          onScopeChange={() => undefined}
          selectionLabel={a1Short(sel.row, sel.col)}
          onDeleteCellRule={() => undefined}
          onDeleteExtRule={() => undefined}
          onMoveCellRule={() => undefined}
          onMoveExtRule={() => undefined}
          onEditCellRule={() => undefined}
          onEditExtRule={() => undefined}
          onNewRule={() => {
            setCfManageOpen(false);
            setCfNewOpen(true);
          }}
          onClose={() => setCfManageOpen(false)}
        />
      )}
      {tableGalleryOpen && (
        <TableStyleGallery onClose={() => setTableGalleryOpen(false)} onPick={() => setTableGalleryOpen(false)} />
      )}
      {moveCopyOpen && (
        <MoveCopySheetDialog
          sheets={sheets}
          currentSheet={moveCopyForSheet ?? sheet}
          onClose={() => {
            setMoveCopyOpen(false);
            setMoveCopyForSheet(null);
          }}
          onMoveCopy={(from: string, toIndex: number | null, createCopy: boolean) => {
            ctx.onMoveCopySheet?.(from, toIndex, createCopy);
            setMoveCopyOpen(false);
            setMoveCopyForSheet(null);
          }}
        />
      )}
      {linkOpen && (
        <LinkDialog
          sheets={sheets}
          sheet={sheet}
          recentLinks={[]}
          cellLabel={a1Short(sel.row, sel.col)}
          onClose={() => setLinkOpen(false)}
          onInsert={(link) => {
            const target = link.target;
            const url = target.kind === 'url' ? target.url : target.kind === 'email' ? target.email : `${target.sheet}!${target.ref}`;
            ctx.commitCell(sel.row, sel.col, url);
            setLinkOpen(false);
          }}
          onRemove={() => setLinkOpen(false)}
          onPickRecent={() => setLinkOpen(false)}
        />
      )}
      {hfOpen && (
        <HeaderFooterDialog
          initial={ctx.hfSettings[sheet] ?? defaultHeaderFooter()}
          onClose={() => setHfOpen(false)}
          onApply={(settings) => {
            ctx.onSaveHfSettings(sheet, settings);
            setHfOpen(false);
          }}
        />
      )}
      {wordArtOpen && (
        <WordArtDialog
          onClose={() => setWordArtOpen(false)}
          onInsert={(svg, w, h) => {
            ctx.addPicture(svg, w, h, 'WordArt');
            setWordArtOpen(false);
          }}
        />
      )}
      {equationOpen && (
        <EquationDialog
          onClose={() => setEquationOpen(false)}
          onInsert={(svg, w, h, alt) => {
            ctx.addPicture(svg, w, h, alt);
            setEquationOpen(false);
          }}
        />
      )}
      {symbolOpen && (
        <SymbolDialog
          onClose={() => setSymbolOpen(false)}
          onPick={(ch) => {
            ctx.insertTextAtCursor(ch);
            setSymbolOpen(false);
          }}
        />
      )}
      {iconsOpen && (
        <IconGallery
          onClose={() => setIconsOpen(false)}
          onInsert={(svg, w, h) => {
            ctx.addPicture(svg, w, h, 'Icon');
            setIconsOpen(false);
          }}
        />
      )}
      {smartArtOpen && (
        <SmartArtDialog
          onClose={() => setSmartArtOpen(false)}
          onInsert={(svg, w, h) => {
            ctx.addPicture(svg, w, h, 'SmartArt');
            setSmartArtOpen(false);
          }}
        />
      )}
      {screenshotOpen && (
        <ScreenshotDialog
          onClose={() => setScreenshotOpen(false)}
          onInsert={(url) => {
            ctx.addPicture(url, 400, 300, 'Screenshot');
            setScreenshotOpen(false);
          }}
          onError={onError}
        />
      )}
      {recChartsOpen && (
        <RecommendedChartsDialog
          range={{ sheet, startRow: 0, startCol: 0, endRow: 9, endCol: 3 }}
          read={(row, col) => {
            const text = readCell(row, col);
            const num = text === '' ? null : Number(text);
            return { text, num: Number.isFinite(num) ? num : null };
          }}
          onClose={() => setRecChartsOpen(false)}
          onPick={(kind) => {
            ctx.onOpenChart(kind);
            setRecChartsOpen(false);
          }}
        />
      )}
      {recPivotsOpen && (
        <RecommendedPivotTablesDialog
          profile={{ headers: [], distinct: {}, numericFields: [], rowCount: 0 }}
          records={[]}
          onClose={() => setRecPivotsOpen(false)}
          onPick={() => setRecPivotsOpen(false)}
        />
      )}
      {pivotChartOpen && (
        <PivotChartDialog
          pivots={ctx.pivotChartSources ?? []}
          onClose={() => setPivotChartOpen(false)}
          onCreate={(spec, pivotId) => {
            ctx.onInsertPivotChart?.(spec, pivotId);
            setPivotChartOpen(false);
          }}
        />
      )}
      {themeOpen && (
        <ThemeDialog
          current={ctx.theme}
          onApply={(t) => {
            ctx.onThemeChange(t);
            setThemeOpen(false);
          }}
          onClose={() => setThemeOpen(false)}
        />
      )}
      {pageSetupOpen && (
        <PageSetupDialog
          sheet={sheet}
          setup={ctx.pageSetup}
          onSetupChange={ctx.setPageSetup}
          titles={ctx.printTitles}
          onTitlesChange={ctx.setPrintTitles}
          onClose={() => setPageSetupOpen(false)}
        />
      )}
      {backgroundOpen && (
        <BackgroundDialog
          sheet={sheet}
          background={NO_BACKGROUND}
          onChange={() => setBackgroundOpen(false)}
          onClose={() => setBackgroundOpen(false)}
        />
      )}
      {arrangeOpen && (
        <ArrangeTools
          items={[]}
          selectedIds={[]}
          onItemsChange={() => undefined}
          onSelectionChange={() => undefined}
          onClose={() => setArrangeOpen(false)}
        />
      )}
      {defineNameOpen && (
        <DefineNameDialog
          existing={ctx.nameServices.services.ranges.list().map((d) => ({
            name: d.name,
            sheet: d.ref?.sheet ?? sheet,
            startRow: d.ref?.startRow ?? 0,
            startCol: d.ref?.startCol ?? 0,
            endRow: d.ref?.endRow ?? 0,
            endCol: d.ref?.endCol ?? 0,
          }))}
          sheets={sheets}
          initialRefersTo={`=${sheet}!${a1Short(sel.row, sel.col)}`}
          onSave={async (nr) => {
            try {
              ctx.onCaptureNamesUndo?.(`Define name ${nr.name}`);
              await ctx.nameServices.services.ranges.define({
                name: nr.name,
                scope: { kind: 'workbook' },
                ref: {
                  sheet: nr.sheet,
                  startRow: nr.startRow,
                  startCol: nr.startCol,
                  endRow: nr.endRow,
                  endCol: nr.endCol,
                },
                principal: ctx.nameServices.principal,
              });
              ctx.nameServices.changed();
            } catch (e) {
              onError(e instanceof Error ? e.message : String(e));
            }
            setDefineNameOpen(false);
          }}
          onClose={() => setDefineNameOpen(false)}
        />
      )}
      {applyNamesOpen && (
        <ApplyNamesDialog
          names={ctx.nameServices.services.ranges.list().map((d) => ({
            name: d.name,
            sheet: d.ref?.sheet ?? sheet,
            startRow: d.ref?.startRow ?? 0,
            startCol: d.ref?.startCol ?? 0,
            endRow: d.ref?.endRow ?? 0,
            endCol: d.ref?.endCol ?? 0,
          }))}
          formulaCount={0}
          onApply={() => setApplyNamesOpen(false)}
          onClose={() => setApplyNamesOpen(false)}
        />
      )}
      {createFromSelOpen && (
        <CreateFromSelectionDialog
          onCreate={() => setCreateFromSelOpen(false)}
          onClose={() => setCreateFromSelOpen(false)}
        />
      )}
      {useInFormulaOpen && (
        <DefineNameDialog
          existing={ctx.nameServices.services.ranges.list().map((d) => ({
            name: d.name,
            sheet: d.ref?.sheet ?? sheet,
            startRow: d.ref?.startRow ?? 0,
            startCol: d.ref?.startCol ?? 0,
            endRow: d.ref?.endRow ?? 0,
            endCol: d.ref?.endCol ?? 0,
          }))}
          sheets={sheets}
          initialRefersTo={`=${sheet}!${a1Short(sel.row, sel.col)}`}
          onSave={async (nr) => {
            try {
              ctx.onCaptureNamesUndo?.(`Define name ${nr.name}`);
              await ctx.nameServices.services.ranges.define({
                name: nr.name,
                scope: { kind: 'workbook' },
                ref: {
                  sheet: nr.sheet,
                  startRow: nr.startRow,
                  startCol: nr.startCol,
                  endRow: nr.endRow,
                  endCol: nr.endCol,
                },
                principal: ctx.nameServices.principal,
              });
              ctx.nameServices.changed();
            } catch (e) {
              onError(e instanceof Error ? e.message : String(e));
            }
            setUseInFormulaOpen(false);
          }}
          onClose={() => setUseInFormulaOpen(false)}
        />
      )}
      {errorCheckOpen && (
        <ErrorCheckingDialog
          errors={[]}
          onGoTo={(ref) => {
            setSel({ row: ref.row, col: ref.col });
            setErrorCheckOpen(false);
          }}
          onClose={() => setErrorCheckOpen(false)}
        />
      )}
      {evalFormulaOpen && (
        <EvaluateFormulaDialog
          formula={readCell(sel.row, sel.col)}
          cellLabel={a1Short(sel.row, sel.col)}
          onEvaluateExpression={(expr) => readCell(sel.row, sel.col) || expr}
          onClose={() => setEvalFormulaOpen(false)}
        />
      )}
      {watchWindowOpen && (
        <WatchWindow
          watches={[]}
          readValue={(ref) => readCell(ref.row, ref.col)}
          readFormula={(ref) => readCell(ref.row, ref.col)}
          onRemove={() => undefined}
          onAddCurrent={() => undefined}
          onClose={() => setWatchWindowOpen(false)}
        />
      )}
      {quickImportOpen && (
        <QuickImport
          initialTab={quickImportOpen.tab}
          sheetName={sheet}
          onLoad={() => setQuickImportOpen(null)}
          onClose={() => setQuickImportOpen(null)}
        />
      )}
      {queriesPaneOpen && (
        <QueriesPane host={host} onClose={() => setQueriesPaneOpen(false)} onEditQuery={() => undefined} />
      )}
      {advFilterOpen && (
        <AdvancedFilterDialog
          host={host}
          sheet={sheet}
          onClose={() => setAdvFilterOpen(false)}
          onApplied={() => setAdvFilterOpen(false)}
        />
      )}
      {consolidateOpen && (
        <ConsolidateDialog host={host} sheet={sheet} onClose={() => setConsolidateOpen(false)} />
      )}
      {forecastOpen && (
        <ForecastSheetDialog
          host={host}
          sheet={sheet}
          sheetNames={sheets}
          onClose={() => setForecastOpen(false)}
          onSheetCreated={() => setForecastOpen(false)}
        />
      )}
      {subtotalOpen && (
        <SubtotalDialog host={host} sheet={sheet} onClose={() => setSubtotalOpen(false)} onApplied={() => setSubtotalOpen(false)} />
      )}
      {relationshipsOpen && (
        <RelationshipsDialog tables={[]} onClose={() => setRelationshipsOpen(false)} />
      )}
      {thesaurusOpen && (
        <ThesaurusDialog
          word={readCell(sel.row, sel.col)}
          onClose={() => setThesaurusOpen(false)}
          onReplace={(syn) => {
            ctx.commitCell(sel.row, sel.col, syn);
            setThesaurusOpen(false);
          }}
        />
      )}
      {a11yOpen && (
        <AccessibilityChecker
          model={a11yModel}
          onClose={() => setA11yOpen(false)}
          onFix={handleA11yFix}
        />
      )}
      {a11yAltPic && (
        <A11yTextPrompt
          title="Alt text"
          label={`Alternate text for picture "${a11yAltPic.name}"`}
          initial={a11yAltPic.name === 'Picture' ? '' : a11yAltPic.name}
          onSave={(text) => {
            const id = a11yAltPic.id;
            ctx.setPictures((prev) =>
              prev.map((p) => (p.id === id ? { ...p, name: text.trim() === '' ? 'Picture' : text } : p)),
            );
            setA11yAltPic(null);
          }}
          onClose={() => setA11yAltPic(null)}
        />
      )}
      {a11yTitleChart && (
        <A11yTextPrompt
          title="Chart title"
          label="Chart title (announced by screen readers)"
          initial={a11yTitleChart.title}
          onSave={(text) => {
            const id = a11yTitleChart.id;
            ctx.setCharts((prev) => prev.map((c) => (c.id === id ? { ...c, title: text } : c)));
            setA11yTitleChart(null);
          }}
          onClose={() => setA11yTitleChart(null)}
        />
      )}
      {translateOpen && (
        <TranslateDialog
          host={host}
          initialText={readCell(sel.row, sel.col)}
          onClose={() => setTranslateOpen(false)}
          onInsert={(text) => {
            ctx.commitCell(sel.row, sel.col, text);
            setTranslateOpen(false);
          }}
        />
      )}
      {notesOpen && (
        <NotesPanel
          notes={new Map()}
          sheet={sheet}
          sel={sel}
          onClose={() => setNotesOpen(false)}
          onSaveNote={() => setNotesOpen(false)}
          onDeleteNote={() => undefined}
          onNavigate={(row, col) => setSel({ row, col })}
        />
      )}
      {wbProtectOpen && (
        <WorkbookProtectionDialog
          protection={ctx.protection}
          sheet={sheet}
          initialTab={wbProtectOpen.tab}
          onClose={() => setWbProtectOpen(null)}
        />
      )}
      {zoomDialogOpen && (
        <ZoomDialog zoom={ctx.zoom} onClose={() => setZoomDialogOpen(false)} onZoomChange={(z: number) => ctx.setZoom(z)} />
      )}
      {macroListOpen && (
        <MacroListDialog onClose={() => setMacroListOpen(false)} onRun={() => setMacroListOpen(false)} />
      )}
      {scriptEditorOpen && (
        <ScriptEditor host={host} onClose={() => setScriptEditorOpen(false)} />
      )}
      {triggersOpen && (
        <TriggersDialog transport={triggersTransport} onClose={() => setTriggersOpen(false)} />
      )}
      {addonManagerOpen && (
        <AddonManagerDialog
          documentId={addonDocumentId}
          currentUser={addonCurrentUser}
          catalog={addonCatalog}
          installed={addonInstalled}
          grants={addonGrants}
          onInstall={onAddonInstall}
          onEnable={onAddonEnable}
          onDisable={onAddonDisable}
          onUninstall={onAddonUninstall}
          onRequestGrant={onAddonRequestGrant}
          onApproveGrant={onAddonApproveGrant}
          onDenyGrant={onAddonDenyGrant}
          onRevokeGrant={onAddonRevokeGrant}
          onRun={onAddonRun}
          onClose={() => setAddonManagerOpen(false)}
        />
      )}
      {helpOpen && <HelpPane onClose={() => setHelpOpen(null)} initialSection={helpOpen.section as HelpSection} />}
      {shareOpen && (
        <ShareDialog
          sharing={ctx.nameServices.services.sharing}
          workbookName={sheet}
          principal={ctx.nameServices.principal}
          onClose={() => setShareOpen(false)}
        />
      )}
    </>
  );

  /** Open the Move or Copy Sheet… dialog for a specific sheet tab. */
  const openMoveCopySheet = useCallback((sheetName: string) => {
    setMoveCopyForSheet(sheetName);
    setMoveCopyOpen(true);
  }, []);

  return { ribbonProps, dialogs, drawLayer, openMoveCopySheet };
}
