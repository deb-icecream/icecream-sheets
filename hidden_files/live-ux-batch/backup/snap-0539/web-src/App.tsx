import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ENGINE_PROTOCOL_VERSION,
  EngineWorkbook,
  SUPPORTED_LOCALES,
  defaultParallelOptions,
  setCopilotProvider,
  setPythonProvider,
  setWebFetchProvider,
  type CalculationMode,
  type DefinedName,
  type EngineHost,
  type ParallelRecalcOptions,
  type ParallelRecalcStats,
  type SupportedLocale,
  type WorkbookData,
} from '@icecream-sheets/engine';
import ParallelCalcDialog from './components/ParallelCalcDialog';
import { webWorkerBackendFactory } from './parallelWebBackend';
import { useRibbonParity } from './ribbonParity';
import {
  a1Short,
  cellRef,
  colLabel,
  connectGatewayHost,
  formatDisplay,
  getGateway,
  getHost,
  isGatewayMode,
  onHostReplaced,
  parseEdit,
  replaceHost,
  notifyHostReplaced,
} from './engine';
import { RemoteAgentBackend } from './services/remoteAgent';
import type { AgentChatBackend } from './services/remoteAgent';
import { RemoteEngineHost } from './services/remoteEngine';
// Cycle 10 desktop engine/view separation: the IPC-backed engine host
// (workbook in the Electron main process; renderer is a pure consumer).
import { IpcEngineHost } from './services/ipcEngine';
import { GatewayLogin, isDevLoginEnabled } from './components/GatewayLogin';
import { FirebaseLoginButton } from './components/FirebaseLoginButton';
import { FirebaseAuthService, type FirebaseAuthState } from './services/firebaseAuth';
import { createFirebasePort } from './services/firebasePort';
import {
  DesktopAgentBackend,
  desktopAuthStatus,
  desktopPickOpen,
  desktopSaveBytes,
  desktopSaveStatus,
  desktopSaveXlsxDirect,
  desktopSyncExtras,
  isDesktop,
  onDesktopConfirmNew,
  onDesktopMenuHelp,
  onDesktopMenuOpen,
  onDesktopMenuPreferences,
  onDesktopMenuSave,
  onDesktopMenuSaveAs,
  onDesktopOpenPath,
  openDesktopLogin,
  signalDesktopRendererReady,
} from './services/desktopAgent';
import { snapshotToWorkbookData, snapshotFiltered, workbookFromData, importedFormatsToStore, externalLinksFromWorkbookData, namedRangeToWorkbookData, sanitizeSheetName, applyFormatStoreToWorkbookData, formatStoreToSheetData, mergeDefinedNames } from './io';
// Storage adapters (track 9): Open/Save resolve the adapter by file
// extension through the engine's AdapterRegistry (xlsx/csv/tsv/ods).
import {
  adapterForFilename,
  adapterForSaveFormat,
  registerAdapters,
  saveFormatById,
  type SaveFormatId,
} from './adapters';
import {
  CHARTS_METADATA_KEY,
  SMARTART_METADATA_KEY,
  SMARTART_PARTS_METADATA_KEY,
  EXTERNAL_LINKS_METADATA_KEY,
  PIVOT_PARTS_METADATA_KEY,
  PIVOT_TABLES_METADATA_KEY,
} from '@icecream-sheets/xlsx-adapter';
import {
  CHART_SPECS_METADATA_KEY,
  type ChartNameResolutionContext,
  importedChartsFromMetadata,
  importedChartToSpec,
  importedPivotChartToSpec,
  pivotChartSpecsFromMetadata,
  pivotChartSpecsToMetadata,
} from './features/importedCharts';
import {
  importedSmartArtFromMetadata,
  importedSmartArtPictureName,
  importedSmartArtToPicture,
  smartArtLayoutMappingReport,
  smartArtPartsFromMetadata,
} from './features/importedSmartArt';
import {
  buildImportedPivotResult,
  importedPivotMatrix,
  importedPivotRecords,
  importedPivotSourceRange,
  importedPivotToSpec,
  importedPivotsFromMetadata,
  pivotPartsFromMetadata,
} from '@icecream-sheets/service';
import { registerDataModelCubes } from '@icecream-sheets/service';
import {
  cubeFromPivot,
  registerCube,
  registerPivot,
  unregisterCube,
  unregisterPivot,
} from '@icecream-sheets/engine';
import { CollabBridge } from './collab';
import {
  CollabTransport,
  getOrCreateClientId,
  type PresenceParticipant,
  type RejectedOp,
} from './services/collabTransport';
import { participantDisplayName, participantInitials } from './services/presenceNames';
import type { AppCommand } from './commands';
import type { EngineLoadResult } from './services/engineTransport';
import { buildLocalMirror, workbookDataFromDesktopLoadResult, workbookDataFromLoadResult } from './features/localMirror';
import { resolveHybridThresholds } from './services/routedEdit';
import {
  hasInFlightEdits as hostHasInFlightEdits,
  waitForEditsToSettle,
} from './services/saveInterlock';
import { markFileSelected } from './services/firstPagePerf';

/**
 * Base64-encode file bytes OFF the main thread (Blob + FileReader), so
 * uploading a 12MB workbook to the engine service doesn't cost a
 * multi-hundred-ms UI-thread task (Cycle 10, Phase 2).
 */
function uint8ToBase64(buffer: Uint8Array): Promise<string> {
  return new Promise((resolve, reject) => {
    try {
      const reader = new FileReader();
      reader.onload = () => {
        const s = String(reader.result ?? '');
        const comma = s.indexOf(',');
        resolve(comma >= 0 ? s.slice(comma + 1) : s);
      };
      reader.onerror = () => reject(reader.error ?? new Error('could not read file bytes'));
      reader.readAsDataURL(new Blob([buffer as unknown as BlobPart]));
    } catch (e) {
      reject(e instanceof Error ? e : new Error(String(e)));
    }
  });
}
import ShortcutsDialog from './components/ShortcutsDialog';
import MenuSearchDialog from './components/MenuSearchDialog';
import SettingsDialog from './components/SettingsDialog';
import HelpPane from './components/HelpPane';
import WorkbookLibraryDialog from './components/WorkbookLibraryDialog';
import { WorkbookLibrary, type LibraryEntry } from './library';
import { applyTheme, loadSettings, saveSettings, type UserSettings } from './settings';
import { getLocalePreset, type LocaleConfig } from './features/locale';
import {
  sparklineKey,
  type SparklinePlacement,
  type SparklineType,
} from './features/sparklines';
import {
  decryptFileWithPassword,
  encryptFileWithPassword,
  encryptedFilename,
  isEncryptedFile,
} from './features/fileCrypto';
import { FilePasswordDialog } from './components/FilePasswordDialog';
import { cellEditText, firstCellText, nextSheetName } from './ribbon/clipboard';
import Grid, { gridContentX, gridContentY, MAX_ROWS, MAX_COLS } from './Grid';
import {
  cellSelection,
  insertTarget,
  isSingleCell,
  rangeSelection,
  selectionBounds,
  selectionRects,
  type GridSelection,
} from './features/selection';
import FormulaBar from './FormulaBar';
import SheetTabs from './SheetTabs';
import Ribbon from './ribbon/Ribbon';
import StatusBar from './StatusBar';
import FindDialog from './components/FindDialog';
import A11yDialog from './components/A11yDialog';
import ContextMenu, { type MenuItem } from './components/ContextMenu';
import { CFDialog, FilterDialog, ValidationDialog, cellLabelOf } from './components/FormatDialogs';
import InsertFunctionDialog from './components/InsertFunctionDialog';
import {
  RowHeightDialog, ColumnWidthDialog, RenameSheetDialog,
  AUTOSUM_FNS, ACCOUNTING_CURRENCIES, BORDER_COLORS, BORDER_STYLES, PASTE_SPECIAL_ITEMS,
} from './components/HomeExtras';
import {
  TopBottomDialog, DataBarDialog, ColorScaleDialog, IconSetDialog,
} from './components/CFExtendedDialogs';
import { NameManagerDialog } from './components/NameManagerDialog';
import SortDialog from './components/SortDialog';
import CommentDialog from './components/CommentsDialog';
import { ProtectionDialog } from './components/ProtectionDialog';
import { ChartOverlay } from './components/Charts';
import ChartDialog from './components/ChartDialog';
import {
  addTrendlinesToConfig,
  canSubjectReadCell,
  canViewReport,
  describePivotBinding,
  filterBindingRecordsForSubject,
  insertColBreak,
  insertRowBreak,
  makeChartSpec,
  pageBreaksFromMetadata,
  pageBreaksMetadataKey,
  pageBreaksToMetadata,
  paginateSheet,
  pivotResultToSeries,
  removeColBreak,
  removeRowBreak,
  renderSheetPdf,
  resetPageBreaks,
  type AuthorizePort,
  type CellReader,
  type ChartKind,
  type ChartRange,
  type ChartSeries,
  type ChartSpec,
  type NamedRangeDef,
  type PageBreaks,
  type PaginatedPage,
  type PrintPageSetup,
} from '@icecream-sheets/service';
import { persistCharts, restoreCharts } from './features/chartStore';
import { ShapeOverlay, TextBoxOverlay, SHAPE_KINDS, TEXTBOXES_METADATA_KEY, textBoxesFromMetadata, type Shape, type ShapeKind, type TextBox } from './components/Overlays';
import AgentChat from './components/AgentChat';
import { ArtifactFrame } from './components/ArtifactHost';
// Product shell (shell integration): landing page, Workspace home,
// generated-apps gallery, and the share recipient flow. The product
// modules under ./product own their UI; this shell owns the routing.
import { LandingPage } from './product/LandingPage';
import { Workspace } from './product/Workspace';
import { AppsGallery, SharedAppLanding } from './product/AppsGallery';
import { ProductApi } from './product/productApi';
import {
  applyThemeChoice,
  effectiveDisplayName,
  getSessionSettings,
  setSessionProfile,
  setSessionSettings,
} from './product/userSettings';
import { SharesApi, shareIdFromSearch } from './product/sharesApi';
import { BuiltAppsApi } from './product/builtAppsApi';
import { planBuiltAppSync } from './product/builtAppSync';
import {
  buildFileUrl,
  buildHomeUrl,
  fileIdFromUrl,
  stashReturnFile,
  takeReturnFile,
} from './product/deepLink';
import { createServer } from '@icecream-sheets/mcp-server/server';
import { AgentRuntime } from '@icecream-sheets/service';
import {
  createArtifactStore,
  materializeRecipientCopy,
  registerIntentPorts,
  type ArtifactSpec,
  type McpCallFn,
  type MetadataStore,
} from '@icecream-sheets/service';
import { getLocalMcpCall } from './services/mcpToolClient';
import VoiceCommandPalette from './components/VoiceCommandPalette';
import { resolvePaletteTier } from './services/voiceTier';
import { createGatewayTranscribe } from './services/voiceTranscribe';
import { createAppGenerationPort } from './services/appGenerationPort';
import {
  PictureOverlay,
  fileToPictureDataUrl,
  picturesFromMetadata,
  picturesToMetadata,
  PICTURES_METADATA_KEY,
  type Picture,
} from './components/Pictures';
import {
  DEFAULT_PAGE_SETUP,
  PAGE_SETUP_METADATA_PREFIX,
  PrintPreviewDialog,
  pageSetupFromMetadata,
  pageSetupToMetadata,
  type PageSetup,
} from './components/PrintLayout';
import {
  DEFAULT_PRINT_TITLES,
  PRINT_TITLES_METADATA_PREFIX,
  printTitlesFromMetadata,
  printTitlesToMetadata,
  toPrintPageSetup,
  type PrintTitles,
} from './components/PageSetupDialog';
import FormatCellsDialog from './components/FormatCellsDialog';
import OpenDataSourceDialog from './components/OpenDataSourceDialog';
import OpenFromUrlDialog from './components/OpenFromUrlDialog';
import {
  headerFooterFromMetadata,
  headerFooterMetadataKey,
  headerFooterToMetadata,
} from './components/HeaderFooterDialog';
import type { HeaderFooterSettings } from './features/headerFooter';
import {
  DEFAULT_THEME,
  THEME_METADATA_KEY,
  themeFromMetadata,
  themeToMetadata,
  type WorkbookTheme,
} from './features/themes';
import {
  drawingCanvasMetadataKey,
  drawingCanvasesFromMetadata,
  drawingCanvasesToMetadata,
  inkMetadataKey,
  inkStrokesFromMetadata,
  inkStrokesToMetadata,
  type DrawingCanvasSpec,
  type InkStroke,
} from './features/ink';
// NO-IMPORT
import {
  applyRefreshPlan,
  bindingForSheet,
  buildConnectorDeps,
  dataSourceRegistry,
  persistDataSourceBindings,
  planSheetRefresh,
  restoreDataSourceBindings,
  timeAgo,
  uniqueSheetName,
  writeTableToNewSheet,
  type ConnectorKind,
  type ConnectorSpec,
  type SourceBinding,
  type TableData,
} from './features/dataSources';
import { PivotTableBuilderDialog, PivotTableView } from './components/PivotTable';
import { AppBuilderDialog } from './components/AppBuilder';
import { AppRunnerDialog } from './components/AppViews';
import GroupByDialog from './components/GroupByDialog';
import EmailDialog from './components/EmailDialog';
import { DownloadDialog, type DownloadNameOption, type DownloadScope } from './components/DownloadDialog';
import { randomizeRange } from './features/randomize';
import { sendWorkbookEmail, type WorkbookEmail } from './features/email';
import { getGatewayClient, type EngineOpenResult } from './services/gatewayClient';
import {
  IdleSessionController,
  lifecycleTransportOf,
  resolveSessionLifecycleConfig,
  shouldRunSessionLifecycle,
} from './services/sessionLifecycle';
import { createAppStore, type AppSpec } from '@icecream-sheets/service';
import {
  ReportBuilderDialog,
  ReportListDialog,
  ReportViewerDialog,
  type AvailableChart,
  type AvailablePivot,
  type EtlBindingRefreshResult,
  type ReportSourceInfo,
} from './components/Reports';
import { persistReports, restoreReports } from './features/reportStore';
// Remaining tracks: power query, data types, form controls, 3D maps, external links.
import PowerQueryDialog from './components/PowerQuery';
import EtlEditor from './components/EtlEditor';
import { DataTypeDialog, DataTypeCard } from './components/DataTypes';
import { FormControlOverlay, FORM_CONTROL_KINDS, type FormControl, type FormControlKind } from './components/FormControls';
import {
  GlobeOverlay,
  GlobeSetupDialog,
  pointsFromRows,
  type PlacesGeocodeOutcome,
  type PlacesGeocodeProgress,
} from './components/Globe3D';
import {
  geocodeBatch,
  geocodedToLatLong,
  getGeocodeService,
  normalizePlaceQuery,
} from './features/geocode';
import ExternalLinksDialog from './components/ExternalLinksDialog';
import { dtCellKey, type DataTypeValue } from './features/dataTypes';
import { SlicerPanel } from './components/Slicer';
import { TimelinePanel } from './components/Timeline';
import SparklineDialog from './components/SparklineDialog';
import RevisionHistoryDialog from './components/RevisionHistory';
import { SmartChipDialog, SmartChipCard } from './components/SmartChips';
import { SensitivityBar } from './components/SensitivityBar';
import { SyncStatus, type ConflictChoice } from './components/SyncStatus';
import {
  toggleSlicerValue,
  clearSlicer,
  distinctColumnValues,
  bindSlicerPivot,
  unbindSlicerPivot,
  type SlicerSpec,
} from './features/slicers';
import { timelineExtent, type TimelineSpec } from './features/timelines';
import {
  resolveSmartChip,
  parseChipFormula,
  smartChipCellKey,
  type SmartChipValue,
} from './features/smartChips';
import {
  OpLog,
  detectConflicts,
  type Op,
  type OpKind,
  type OpConflict,
} from '@icecream-sheets/engine';
import {
  KeyManager,
  createSensitivityStore,
  type Persistence,
  type SensitivityLabel,
  type SensitivityStore,
} from '@icecream-sheets/service';
import { suspended } from './suspended';
import MacroRecorderDialog from './components/MacroRecorderDialog';
import { isMacroRecording, onMacroRecordingChange, recordAction, toAutomationFormat } from './automation';
import { ExternalLinkRegistry, findExternalRefs } from './features/externalLinks';
import type { LatLong } from './features/globe';
import {
  createPivot,
  refreshPivot,
  recordsFromGrid,
  applySlicersToPivotSpec,
  validateReportSpec,
  type PivotRecord,
  type PivotResult,
  type PivotSpec,
  type ReportBinding,
  type ReportSpec,
} from '@icecream-sheets/service';
import {
  runRecipe,
  makeTable,
  type EtlTable,
  type RunRecord,
} from '@icecream-sheets/service';
import { tableToGrid } from './components/etlHelpers';
import {
  etlFetchText,
  etlRecipeStore,
  etlRunHistoryStore,
  etlVersionStore,
} from './components/etlStores';
import {
  TypedView,
  ProtectionManager,
  Authorizer,
  allowAllPolicy,
} from '@icecream-sheets/engine';
import { UndoManager, isAsyncHost } from './features/undo';
import { a1Range } from './features/definedNames';
import {
  getFormat, setFormat, setRangeFormat, clearFormat, clearRangeFormat, clearSheetFormats,
  createFormatStore, setColumnFormat,
  createDataTypeStore, setColumnDataTypes,
  dataTypesToMetadata, dataTypesFromMetadata, DATATYPES_METADATA_KEY,
  CELL_STYLE_PRESETS,
  type FormatStore, type CellFormat, type NumberFormat,
  type DataTypeStore, type ColumnDataType,
  THEME_COLORS,
} from './features/formatting';
import {
  makeExtCFRule, topNMatches, dataBarWidth, colorScaleColor, iconFor, collectNumericValues,
  type ExtCFRule,
} from './features/cfExtended';
import { useNameServices } from './features/useNameServices';
import { NamedFunctionDialog } from './components/NamedFunctionDialog';
import {
  makeGroup, toggleGroup, removeGroup, isRowHiddenByGroup, isColHiddenByGroup,
  type Group,
} from './features/groups';
import {
  commentKey, getComment, setComment, deleteComment,
  type CommentStore,
} from './features/comments';
import { splitTextToColumns, detectDelimiter } from './features/textColumns';
import { isCorrect, checkText } from './features/spelling';
import { stripToValues, parseTsvGrid } from './features/clipboardExt';
import { suggestAutosumRange, autosumFormula } from './features/cellOps';
import { findAll, replaceAll, type FindOptions } from './features/findReplace';
import SolverDialog from './components/SolverDialog';
import IterativeDialog from './components/IterativeDialog';
import { DEFAULT_ITERATIVE, type IterativeSettings } from '@icecream-sheets/engine';
import { GoalSeekDialog, ScenarioManagerDialog, DataTableDialog, type DataTableKind } from './components/WhatIfDialogs';
import FlashFillDialog from './components/FlashFillDialog';
import InferencePanel from './components/InferencePanel';
import ColumnStatsDialog from './components/ColumnStatsDialog';
import { buildInferenceContext, applyProposal } from './inference';
import {
  cleanupProposalsForSheet,
  suggestFormulasForSheet,
  whitespaceCleanupProposal,
  profileColumnSet,
  type Proposal,
  type ColumnProfile,
} from '@icecream-sheets/service';
import {
  solve, goalSeek, computeOneVarTable, computeTwoVarTable,
  createScenarioSet, addScenario, deleteScenario, captureScenario, scenarioWrites, scenarioSummary,
  analyzeFlashFill, analyzeFlashFillTwoCol, instantiateFormula,
  type SolverSpec, type SolverEvaluator, type ScenarioSet, type FlashFillProposal,
} from '@icecream-sheets/engine';
import {
  deleteCols,
  deleteRows,
  insertCols,
  insertRows,
  sortByColumn,
  columnValues,
  type SortDir,
} from './features/sheetOps';
import {
  findMerge,
  findValidation,
  isMergeAnchor,
  makeCFRule,
  makeMerge,
  makeValidationRule,
  validateEdit,
  type CFOperator,
  type CFRule,
  type FilterState,
  type MergeRange,
  type ValidationRule,
} from './features/models';

export interface Selection {
  row: number;
  col: number;
}

// Register the xlsx/csv/tsv/ods storage adapters with the engine's
// AdapterRegistry once (track 9). Idempotent; Open/Save resolve adapters
// by file extension from here on.
registerAdapters();

/** localStorage-backed Persistence for service metadata stores (sensitivity). */
function localStoragePersistence(): Persistence {
  return {
    load: (k) => {
      try { return localStorage.getItem(k); } catch { return null; }
    },
    save: (k, v) => {
      try { localStorage.setItem(k, v); } catch { /* storage full/blocked: keep memory copy */ }
    },
    clear: (k) => {
      try { localStorage.removeItem(k); } catch { /* ignore */ }
    },
  };
}

/** localStorage keys for cross-tab op-log sync. */
const OPLOG_KEY_PREFIX = 'icecream-sheets.oplog.v1.';
const OPLOG_TABS_KEY = 'icecream-sheets.oplog.tabs.v1';

/** Identity key for an op across tabs (seqs are log-local). */
function opKey(op: Op): string {
  return `${String(op.payload['tab'] ?? '?')}:${op.seq}`;
}

function readTabs(): string[] {
  try {
    const raw = localStorage.getItem(OPLOG_TABS_KEY);
    const arr = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(arr) ? arr.filter((t): t is string => typeof t === 'string') : [];
  } catch {
    return [];
  }
}

export interface CtxMenuState {
  x: number;
  y: number;
  items: MenuItem[];
}

// No-code app builder: app specs live in the service metadata store
// (design-docs/no-code-app-builder.md §2), persisted here via localStorage.
const appPersistence: Persistence = {
  load: (k) => {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  save: (k, v) => {
    try {
      localStorage.setItem(k, v);
    } catch {
      // Storage full or unavailable: apps stay in memory for the session.
    }
  },
  clear: (k) => {
    try {
      localStorage.removeItem(k);
    } catch {
      // ignore
    }
  },
};
const appStore = createAppStore(appPersistence);

/**
 * Subscribe to a host's edit-flight changes (the save interlock's
 * EditInFlightTracker, exposed by IpcEngineHost/RemoteEngineHost as
 * subscribeEditFlight): the listener fires on EVERY edit begin/end, so
 * a save handler watching it for its in-flight window learns that an
 * edit landed during the save even when that edit already settled
 * again before the save completed. Duck-typed like saveInterlock's
 * editFlightSourceOf; hosts without the signal yield a no-op.
 */
function subscribeEditFlightChanges(host: unknown, onChange: () => void): () => void {
  const h = host as { subscribeEditFlight?: unknown };
  if (typeof h.subscribeEditFlight === 'function') {
    return (h.subscribeEditFlight as (listener: () => void) => () => void)(onChange);
  }
  return () => {};
}

/** Phase 2 fileId plumbing: the share/join link carries `#file=<fileId>`. */
function readFileIdFromHash(): string | null {
  try {
    const m = window.location.hash.match(/[#&]file=([^&]+)/);
    return m ? decodeURIComponent(m[1]) : null;
  } catch {
    return null;
  }
}

function writeFileIdToHash(fileId: string): void {
  try {
    const url = new URL(window.location.href);
    url.hash = `file=${encodeURIComponent(fileId)}`;
    window.history.replaceState(null, '', url.toString());
  } catch {
    // Hash is a convenience for joining; the session state is authoritative.
  }
}

function clearFileIdFromHash(): void {
  try {
    const url = new URL(window.location.href);
    if (/[#&]file=/.test(url.hash)) {
      url.hash = '';
      window.history.replaceState(null, '', url.toString());
    }
  } catch {
    // Hash is a convenience for joining; the session state is authoritative.
  }
}

/* ------------------------------------------------------------------ */
/* Product shell routing helpers (shell integration)                   */
/* ------------------------------------------------------------------ */

/** sessionStorage key for a share a logged-out visitor was headed to. */
const RETURN_SHARE_KEY = 'icecream-sheets.return-share';
/** sessionStorage key for a share data-copy import awaiting its grid. */
const PENDING_SHARE_IMPORT_KEY = 'icecream-sheets.pending-share-import';
/** sessionStorage key for a completed import whose app landing is owed. */
const PENDING_SHARE_LANDING_KEY = 'icecream-sheets.pending-share-landing';
/** Issue #18: one-shot notice stashed before the restore reload (see openRemoteBuffer). */
const OPEN_FAILURE_NOTICE_KEY = 'icecream-sheets.open-failure-notice';

/**
 * A received share's data copy, waiting for its workbook to load in the
 * grid: the accept step creates the catalog file and navigates to its
 * deep link; once the (blank) workbook is loaded, the shell writes the
 * snapshot into it, saves it, and only then raises the shared app
 * full-screen (SharedAppLanding).
 */
interface PendingShareImport {
  fileId: string;
  sheet: string;
  cells: unknown[][];
  artifactId: string;
  appName: string;
}

function stashReturnShare(shareId: string): void {
  try {
    globalThis.sessionStorage?.setItem(RETURN_SHARE_KEY, shareId);
  } catch {
    // Best-effort, like the return-file stash in product/deepLink.
  }
}

/** Take the stashed return share, removing it (read-once). */
function takeReturnShare(): string | null {
  try {
    const store = globalThis.sessionStorage;
    if (!store) return null;
    const value = store.getItem(RETURN_SHARE_KEY);
    if (value) store.removeItem(RETURN_SHARE_KEY);
    return value ? value : null;
  } catch {
    return null;
  }
}

function writePendingShareImport(pending: PendingShareImport): void {
  try {
    globalThis.sessionStorage?.setItem(PENDING_SHARE_IMPORT_KEY, JSON.stringify(pending));
  } catch {
    // Storage unavailable — the accept flow surfaces this as an error
    // only if the import step then cannot find its payload.
  }
}

function readPendingShareImport(): PendingShareImport | null {
  try {
    const raw = globalThis.sessionStorage?.getItem(PENDING_SHARE_IMPORT_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<PendingShareImport> | null;
    if (
      !parsed ||
      typeof parsed.fileId !== 'string' ||
      typeof parsed.sheet !== 'string' ||
      !Array.isArray(parsed.cells) ||
      typeof parsed.artifactId !== 'string' ||
      typeof parsed.appName !== 'string'
    ) {
      return null;
    }
    return parsed as PendingShareImport;
  } catch {
    return null;
  }
}

function clearPendingShareImport(): void {
  try {
    globalThis.sessionStorage?.removeItem(PENDING_SHARE_IMPORT_KEY);
  } catch {
    // Best-effort cleanup.
  }
}

/**
 * A completed share import whose full-screen app landing is still
 * owed: the import reloads the file page so the grid repaints from
 * the session snapshot (the importing page's own structural ops do
 * not repaint its remote view), and the landing raises on the fresh
 * page once its join completes.
 */
interface PendingShareLanding {
  fileId: string;
  artifactId: string;
}

function writePendingShareLanding(landing: PendingShareLanding): void {
  try {
    globalThis.sessionStorage?.setItem(PENDING_SHARE_LANDING_KEY, JSON.stringify(landing));
  } catch {
    // Storage unavailable — the landing simply does not raise.
  }
}

function readPendingShareLanding(): PendingShareLanding | null {
  try {
    const raw = globalThis.sessionStorage?.getItem(PENDING_SHARE_LANDING_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<PendingShareLanding> | null;
    if (!parsed || typeof parsed.fileId !== 'string' || typeof parsed.artifactId !== 'string') {
      return null;
    }
    return { fileId: parsed.fileId, artifactId: parsed.artifactId };
  } catch {
    return null;
  }
}

function clearPendingShareLanding(): void {
  try {
    globalThis.sessionStorage?.removeItem(PENDING_SHARE_LANDING_KEY);
  } catch {
    // Best-effort cleanup.
  }
}

/**
 * Issue #17: map a join-by-link failure to plain user language. The raw
 * gateway error (file UUIDs, JSON bodies) must NEVER reach user-visible
 * copy — it goes to the console only. Returns the sentence shown in the
 * blocking error state under the file's name.
 */
function joinFailureMessage(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e);
  if (/409|claim|already owns|different file/i.test(raw)) {
    return 'This file is already open in another session. Close it there, or wait a moment for that session to end, then try again.';
  }
  if (/401|403|unauthor|forbidden|sign-in|sign in/i.test(raw)) {
    return 'You may not have access to this file, or your sign-in has expired. Sign in again, then try again.';
  }
  if (/404|not found/i.test(raw)) {
    return 'This file could not be found. It may have been deleted, or the link may be incomplete.';
  }
  return 'Something went wrong while opening this file. Check your connection, then try again.';
}

export default function App() {
  const [host, setHost] = useState<EngineHost>(() => getHost());
  const [tick, setTick] = useState(0);
  const [sheet, setSheet] = useState<string>('Sheet1');
  const [sel, setSel] = useState<Selection>({ row: 0, col: 0 });
  /**
   * Rich grid selection (features/selection.ts): cell / range / rows /
   * cols / all. `sel` above stays the anchor (active cell) and is kept in
   * sync by applyGridSelection. Selection is VIEW-ONLY state: changing it
   * touches no engine/host, no network, no revision traffic — view state
   * + re-render only. (The presence heartbeat keeps advertising just the
   * anchor cell, unchanged.)
   */
  const [gridSel, setGridSel] = useState<GridSelection>(() => cellSelection(0, 0));

  /**
   * Chat artifacts (AI-GENERATED APP PATTERN): the artifact store is the
   * service metadata store backed by localStorage, so generated apps
   * survive across sessions and are re-openable from the chat's Apps tab.
   */
  const [artifactStore] = useState<MetadataStore<ArtifactSpec>>(() =>
    createArtifactStore(localStoragePersistence()),
  );
  /** MCP call fn for generated apps (null when the local engine is unavailable). */
  const [artifactMcpCall, setArtifactMcpCall] = useState<McpCallFn | null>(null);
  const artifactMcpCallRef = useRef<McpCallFn | null>(null);
  artifactMcpCallRef.current = artifactMcpCall;
  const sheetRef = useRef(sheet);
  sheetRef.current = sheet;
  /**
   * D-SEL-2 (stale closures): context-menu items are built synchronously
   * during the contextmenu event — BEFORE a right-click re-point's setState
   * has re-rendered — so handlers captured then close over the PRE-menu
   * selection. These refs always mirror the current selection (assigned in
   * the render body like sheetRef above); the menu-reachable data-action
   * handlers below read the refs, so a menu action always acts on the
   * selection that is current at ACTION time, never at menu-build time.
   */
  const selRef = useRef(sel);
  selRef.current = sel;
  const gridSelRef = useRef(gridSel);
  gridSelRef.current = gridSel;

  // Rebuild the artifact MCP client when the engine host changes. In
  // gateway mode there is no local MCP server: generated apps reach
  // MCP tools through the gateway's /api/agent/tools/call instead
  // (FIX-E; the client is resolved at call time so login timing does
  // not matter, and the allowlist is enforced server-side).
  useEffect(() => {
    if (isGatewayMode()) {
      setArtifactMcpCall(
        () =>
          (tool: string, args: Record<string, unknown>): Promise<unknown> => {
            const gw = getGatewayClient();
            if (!gw) throw new Error('Not connected to the gateway.');
            return gw.callTool(tool, args);
          },
      );
      return;
    }
    let cancelled = false;
    getLocalMcpCall(host)
      .then((call) => {
        // Wrap: React treats a bare function passed to setState as an
        // updater and would invoke call(null) as a tool call.
        if (!cancelled) setArtifactMcpCall(() => call);
      })
      .catch(() => {
        if (!cancelled) setArtifactMcpCall(null);
      });
    return () => {
      cancelled = true;
    };
  }, [host]);

  // Register the app-generation pipeline port once: the chat intent
  // router dispatches route 'app' here (AppGenerationPort).
  useEffect(() => {
    registerIntentPorts({
      appGeneration: createAppGenerationPort({
        getMcpCall: async () => {
          const call = artifactMcpCallRef.current;
          if (!call) {
            throw new Error('Generated apps need an MCP connection — none is available.');
          }
          return call;
        },
        getStore: () => artifactStore,
        getSheet: () => sheetRef.current,
        // FIX-E gateway lane: generation runs on the agent service.
        ...(isGatewayMode()
          ? {
              gatewayGenerate: async (prompt: string, sheet: string) => {
                const gw = getGatewayClient();
                if (!gw) throw new Error('Not connected to the gateway.');
                const res = (await gw.generateApp(prompt, sheet)) as {
                  result: import('@icecream-sheets/service').GenerateArtifactResult;
                };
                return res.result;
              },
            }
          : {}),
      }),
    });
  }, [artifactStore]);
  // Per-user settings (platform-shell.md §4): profile store, never
  // workbook bytes. Grid defaults initialize from the saved profile.
  const [settings, setSettings] = useState<UserSettings>(() => {
    const s = loadSettings();
    // Migrate the legacy standalone formula-language key into the profile.
    let legacy: string | null = null;
    try {
      legacy = localStorage.getItem('icecream.formulaLang');
    } catch {
      legacy = null;
    }
    if (legacy && SUPPORTED_LOCALES.some((l) => l.id === legacy) && legacy !== s.formulaLanguage) {
      s.formulaLanguage = legacy as SupportedLocale;
      try {
        localStorage.removeItem('icecream.formulaLang');
      } catch {
        // ignore
      }
      saveSettings(s);
    }
    return s;
  });
  const [calcMode, setCalcMode] = useState<CalculationMode>(settings.calculationMode);
  const [lastError, setLastError] = useState<string | null>(null);
  // Issue #18: a failed-open restore notice lives in its own slot —
  // the open/join success paths clear lastError after the restored
  // workbook loads, which silently ate a notice routed through it.
  const [restoreNotice, setRestoreNotice] = useState<string | null>(null);
  const [zoom, setZoom] = useState(settings.defaultZoom);
  const [showGridlines, setShowGridlines] = useState(settings.showGridlines);
  const [showFormulaBar, setShowFormulaBar] = useState(settings.showFormulaBar);
  /** Locale config for number/date/currency rendering (from user settings). */
  const localeConfig: LocaleConfig = useMemo(
    () => getLocalePreset(settings.locale),
    [settings.locale],
  );
  const [insertReq, setInsertReq] = useState<{ text: string; nonce: number } | null>(null);

  // Feature state (UI layer; engine protocol has no formatting model).
  const undoRef = useRef<UndoManager>(new UndoManager());
  const pictureInputRef = useRef<HTMLInputElement>(null);
  const [undoTick, setUndoTick] = useState(0);
  const [cfRules, setCfRules] = useState<CFRule[]>([]);
  const [validations, setValidations] = useState<ValidationRule[]>([]);
  const [merges, setMerges] = useState<MergeRange[]>([]);
  const [freeze, setFreeze] = useState<{ row: number; col: number } | null>(null);
  const [filters, setFilters] = useState<FilterState>(new Map());
  const [hiddenSheets, setHiddenSheets] = useState<Set<string>>(new Set());
  const [sortState, setSortState] = useState<{ col: number; dir: 'asc' | 'desc' } | null>(null);
  const [agentOpen, setAgentOpen] = useState(false);

  /**
   * AI Agent (track 29): the runtime acts only through the versioned MCP
   * server — even in-process, every agent read/write crosses the MCP
   * protocol boundary via an in-memory transport. The runtime is rebuilt
   * when the workbook host is replaced (file open).
   */
  const agentBoxRef = useRef<{ host: EngineHost; runtime: AgentChatBackend } | null>(null);
  useEffect(() => {
    const prev = agentBoxRef.current;
    agentBoxRef.current = null;
    void prev?.runtime.close();
  }, [host]);
  /**
   * Agent backend (spec a/b/d/e):
   * - web gateway mode → AI Agent host service through the gateway
   * - desktop → login-gated remote agent via Electron IPC (spec d)
   * - local web → in-process AgentRuntime against the local engine
   */
  const getAgentRuntime = (): AgentChatBackend => {
    let box = agentBoxRef.current;
    if (!box || box.host !== host) {
      const gw = getGateway();
      let runtime: AgentChatBackend;
      if (gw && isGatewayMode()) {
        runtime = new RemoteAgentBackend(gw);
      } else if (isDesktop()) {
        runtime = new DesktopAgentBackend();
      } else {
        runtime = new AgentRuntime({
          server: createServer(host),
          principal: 'web-user',
          userId: 'web-user',
        });
      }
      box = { host, runtime };
      agentBoxRef.current = box;
    }
    return box.runtime;
  };
  // Desktop sign-in state for the agent gate (spec d: logged out = local only).
  const [desktopAuthed, setDesktopAuthed] = useState<boolean | null>(null);
  const refreshDesktopAuth = useCallback(() => {
    if (isDesktop()) {
      void desktopAuthStatus().then((s) => setDesktopAuthed(s.loggedIn));
    }
  }, []);
  useEffect(() => {
    refreshDesktopAuth();
  }, [refreshDesktopAuth]);
  const [formats, setFormats] = useState<FormatStore>(createFormatStore());
  /** Column/range data-type metadata (layer 2: informs default formats). */
  const [dataTypes, setDataTypes] = useState<DataTypeStore>(createDataTypeStore());
  const [fnDialogOpen, setFnDialogOpen] = useState(false);
  const [fnDialogCategory, setFnDialogCategory] = useState<string>('All');
  const [showHeadings, setShowHeadings] = useState(true);
  // Extended ribbon features.
  // Named ranges/functions/sharing: service-layer stores (design-docs
  // named-ranges-and-named-functions.md). The hook owns per-workbook
  // persistence and engine binding; `nameVersion` re-renders dialogs.
  const nameServices = useNameServices('workbook');
  // Named-range undo: the undo manager snapshots/restores store definitions
  // around structural ops (insert/delete rows/cols shift tracked refs) and
  // name edits (define/delete/rename in the dialogs).
  useEffect(() => {
    undoRef.current.setNamesHooks({
      snapshotNames: () => nameServices.services.ranges.snapshotDefs(),
      restoreNames: (defs) => {
        // restoreDefs mutates the in-memory defs synchronously; the
        // encrypted write completes in the background.
        void nameServices.services.ranges.restoreDefs(defs);
        nameServices.changed();
      },
    });
  }, [nameServices]);
  const [showFormulas, setShowFormulas] = useState(false);
  const [formulaTexts, setFormulaTexts] = useState<Map<string, string>>(new Map());
  const [comments, setComments] = useState<CommentStore>(new Map());
  const [showComments, setShowComments] = useState(true);
  const [rowHeights, setRowHeights] = useState<Map<number, number>>(new Map());
  const [colWidths, setColWidths] = useState<Map<number, number>>(new Map());
  const [hiddenRows, setHiddenRows] = useState<Set<number>>(new Set());
  const [hiddenCols, setHiddenCols] = useState<Set<number>>(new Set());
  const [groups, setGroups] = useState<Group[]>([]);
  const [extCfRules, setExtCfRules] = useState<ExtCFRule[]>([]);
  const [focusCell, setFocusCell] = useState(false);
  const [formatPainter, setFormatPainter] = useState<{ sheet: string; row: number; col: number } | null>(null);
  const [charts, setCharts] = useState<ChartSpec[]>(() => restoreCharts());
  const [chartDialog, setChartDialog] = useState<{ kind: ChartKind; range: ChartRange } | null>(null);
  const [editingChart, setEditingChart] = useState<ChartSpec | null>(null);
  const [shapes, setShapes] = useState<Shape[]>([]);
  const [pictures, setPictures] = useState<Picture[]>([]);
  // Print layout (per design-docs/print-and-page-layout.md: page setup is
  // adapter metadata, never cell data).
  const [pageSetup, setPageSetup] = useState<PageSetup>(DEFAULT_PAGE_SETUP);
  // Print titles (rows/cols repeated on every printed page), owned by the
  // Page Setup dialog and plumbed into the pagination engine via
  // toPrintPageSetup. Persisted per sheet under `icecream.printtitles.<sheet>`.
  const [printTitles, setPrintTitles] = useState<PrintTitles>(DEFAULT_PRINT_TITLES);
  // Ribbon deep-store (RibbonParityContext): per-sheet header/footer
  // settings, the workbook theme, and per-sheet ink strokes + drawing
  // canvases. Persisted as workbook metadata (`icecream.headerfooter.<sheet>`,
  // `icecream.theme`, `icecream.ink.<sheet>`, `icecream.drawingcanvas.<sheet>`)
  // so they survive save/reopen; restored on open below.
  const [hfSettings, setHfSettings] = useState<Record<string, HeaderFooterSettings>>({});
  const [workbookTheme, setWorkbookTheme] = useState<WorkbookTheme>(DEFAULT_THEME);
  const [inkStrokesBySheet, setInkStrokesBySheet] = useState<Record<string, InkStroke[]>>({});
  const [drawingCanvasesBySheet, setDrawingCanvasesBySheet] = useState<
    Record<string, DrawingCanvasSpec[]>
  >({});
  // Per-sheet page-setup/print-titles stashed on open (GAP-9): the dialog
  // state above only models the active sheet, but the file's native
  // settings for every other sheet must still survive a save. The active
  // sheet always uses the live state; all other sheets use the stash.
  // External workbook links (xl/externalLinks) parsed on open: stashed so
  // the download path can regenerate the link parts even though snapshots
  // carry no adapter metadata. Validated JSON from the adapter.
  const externalLinksMetaRef = useRef<unknown>(undefined);
  const pageSetupBySheetRef = useRef<Record<string, unknown>>({});
  const printTitlesBySheetRef = useRef<Record<string, unknown>>({});
  const [printPreviewOpen, setPrintPreviewOpen] = useState(false);
  // Manual page breaks per sheet (design-docs/print-and-page-layout.md §2):
  // persist as `icecream.pagebreaks.<sheet>` metadata, never in cell data.
  const [pageBreaksBySheet, setPageBreaksBySheet] = useState<Record<string, PageBreaks>>({});
  // Workbook view: normal | pageBreakPreview | pageLayout (View tab).
  const [workbookView, setWorkbookView] = useState<'normal' | 'pageBreakPreview' | 'pageLayout'>('normal');
  const [textBoxes, setTextBoxes] = useState<TextBox[]>([]);
  const [overlayId, setOverlayId] = useState(1);
  interface PivotEntry {
    id: number;
    title: string;
    spec: PivotSpec;
    /** Null when the pivot could not be computed — see `notice`. */
    result: PivotResult | null;
    sourceSheet: string;
    sourceRange: { startRow: number; startCol: number; endRow: number; endCol: number };
    /**
     * Imported XLSX pivots whose cache has no live worksheet range refresh
     * from these cached records instead (computePivotResult prefers this).
     */
    fallbackRecords?: PivotRecord[];
    /**
     * When set, the pivot could not be computed (empty shell, missing
     * cache) — the overlay renders this notice instead of a table.
     */
    notice?: string;
    /** Matrix override for the view (e.g. the values-on-rows layout). */
    matrix?: (string | number | null)[][];
    /** Engine registry key (`registerPivot`/`registerCube`), for cleanup. */
    registryKey?: string;
  }
  const [pivots, setPivots] = useState<PivotEntry[]>([]);
  const [pivotBuilderOpen, setPivotBuilderOpen] = useState(false);
  /**
   * Raw pivot parts captured on open (`xlsx.pivotParts` metadata), carried
   * to the save path so the adapter re-injects the pivot XML byte-for-byte
   * (SheetJS would otherwise drop every pivot on save).
   */
  const pivotPartsRef = useRef<unknown>(undefined);
  /**
   * Raw SmartArt diagram parts captured on open (see smartart.ts). The save
   * path re-attaches them so the adapter re-emits the diagram XML
   * byte-for-byte on save (SheetJS would otherwise drop every diagram).
   */
  const smartArtPartsRef = useRef<unknown>(undefined);
  /** Engine registry keys (`xlsx:<name>`) for imported pivots, for cleanup. */
  const importedPivotKeysRef = useRef<string[]>([]);
  /** Connection names of data-model cubes rebuilt from ranges, for cleanup. */
  const cubeDataModelKeysRef = useRef<string[]>([]);
  /**
   * The LOCAL MIRROR engine (Cycle 10, Phase 2; gateway mode only).
   * ONE FLAG, TWO CONSEQUENCES (user's final rule — canonical wording
   * in packages/engine/src/parallel/types.ts): the /load response
   * carries a complete mirror (every cell's formula + cached value +
   * data type) ONLY when the auto-flag is OFF; the client builds a
   * local engine from it here so "local calc available" is real and the
   * local routing rules can be evaluated. Flag ON: no mirror ships,
   * this stays null, and EVERY edit routes to the server unconditionally
   * (no local routing rule is even evaluated). The server's workbook is
   * always the source of truth; the mirror is a calc target, never an
   * authority. Phase 3's router reads this ref.
   */
  const localMirrorRef = useRef<EngineHost | null>(null);
  // W15: generation counter for gateway opens — a deferred mid-stream
  // hydration scheduled by an older open must never fire into a newer one.
  const remoteOpenSeqRef = useRef(0);
  // Data > Data Tools: Randomize Range + Group-by View.
  const [groupByOpen, setGroupByOpen] = useState(false);
  // File > Email (Mail connector): null when closed, else the send mode.
  const [emailMode, setEmailMode] = useState<'workbook' | 'sheet' | null>(null);
  // File > Download dialog (Cycle 7 per-name download filtering): scope =
  // whole workbook or one defined name.
  const [downloadDialogOpen, setDownloadDialogOpen] = useState(false);
  // No-code app builder (design-docs/no-code-app-builder.md).
  const [appBuilderOpen, setAppBuilderOpen] = useState(false);
  const [apps, setApps] = useState<AppSpec[]>(() => appStore.all());
  const [runningAppId, setRunningAppId] = useState<string | null>(null);
  // Native reports & dashboards (design-docs/native-reports-and-dashboards.md):
  // versioned ReportSpecs in the service metadata store.
  const [reports, setReports] = useState<ReportSpec[]>(() => restoreReports());
  const [reportListOpen, setReportListOpen] = useState(false);
  const [reportBuilder, setReportBuilder] = useState<{ editing: ReportSpec | null } | null>(null);
  const [reportViewing, setReportViewing] = useState<ReportSpec | null>(null);
  /** ETL recipes available for report tables (§6) — re-read when the builder opens. */
  const reportEtlRecipes = useMemo(
    () => (reportBuilder ? etlRecipeStore().all().map((r) => ({ id: r.id, name: r.name })) : []),
    [reportBuilder],
  );
  // Remaining tracks.
  const [powerQueryOpen, setPowerQueryOpen] = useState(false);
  // Connected data sources (core architecture: the sheet is a view over any
  // data source). Bindings persist in the service metadata store.
  const [dataSourceOpen, setDataSourceOpen] = useState(false);
  const [openFromUrlOpen, setOpenFromUrlOpen] = useState(false);
  /**
   * Read-only mode: the workbook has no save target (e.g. opened from a URL).
   * Save is disabled in the UI (ribbon + shortcuts) and no auto-save runs.
   */
  const [readOnly, setReadOnly] = useState(false);
  /** Auto-save state for the status bar indicator. */
  const [saveState, setSaveState] = useState<'saved' | 'saving' | 'dirty' | 'error'>('saved');
  /**
   * Dirty epoch (direct-save race guard): incremented at the app's two
   * dirty-marking funnels (the commitCell path and markFormatDirty —
   * the only setSaveState('dirty') sources outside autosave itself). A
   * save handler captures the epoch when its serialization starts and
   * may only mark 'saved' on success when the epoch is unchanged: an
   * edit landing WHILE a save is in flight re-dirties the workbook, and
   * the save — which serialized the pre-edit state — must not clobber
   * that dirty flag (the edit would look saved when it is not in the
   * file, and autosave would never re-fire for it).
   */
  const dirtyEpochRef = useRef(0);
  /**
   * Cycle 10 (user's rule): DISPLAY IS PROGRESSIVE; MUTATION IS GATED.
   * Save, autosave, export and editing are blocked until the workbook is
   * 100% loaded — serializing a half-built model would write unloaded
   * sheets back empty (data loss). `workbookLoaded` drives the UI (the
   * ribbon's disabled "Loading…" save state); the ref mirror lets hot
   * callbacks/autosave read it without re-subscribing. Desktop opens
   * flip it false at engine:load start and true when the round-trip +
   * hydration complete; it starts true because the main-process host
   * boots with a blank workbook, which IS fully loaded. Web opens are
   * gated by the gateway open flow; this flag stays true there.
   */
  const [workbookLoaded, setWorkbookLoadedState] = useState(true);
  const workbookLoadedRef = useRef(true);
  const setWorkbookLoaded = useCallback((loaded: boolean) => {
    workbookLoadedRef.current = loaded;
    setWorkbookLoadedState(loaded);
  }, []);
  /**
   * Streaming-open progress for the StatusBar (Phase 4): percent of the
   * workbook the load stream has processed + a distinct calculating
   * phase when data is in but the engine build lags. Driven by the
   * stream's per-chunk fields (progressPct / calculating); falls back to
   * sheets-hydrated over total sheets when a server build doesn't send
   * them. Resets when workbookLoaded flips — the SAME transition that
   * unlocks edit/save.
   */
  const [loadProgress, setLoadProgress] = useState<{ pct: number | null; calculating: boolean }>({
    pct: null,
    calculating: false,
  });
  /**
   * Idle session lifecycle (deployment-architecture.md §Idle rule):
   * when the engine session is released after the idle timeout, the
   * workbook is evicted server-side and this app is DISCONNECTED —
   * editing/save gate exactly like not-loaded (the same gate family as
   * workbookLoaded: commitCell, buildDownloadBytes and the autosave
   * effect all consult sessionDisconnectedRef alongside
   * workbookLoadedRef), with a visible "Disconnected — idle" status +
   * Reconnect in the StatusBar. Reconnect rehydrates checksum-verified
   * on the server; only then does this flip back. Desktop-local (IPC
   * host) never engages the lifecycle — no server session exists.
   */
  const [sessionDisconnected, setSessionDisconnectedState] = useState(false);
  const sessionDisconnectedRef = useRef(false);
  const [sessionError, setSessionError] = useState<string | null>(null);
  const sessionControllerRef = useRef<IdleSessionController | null>(null);
  const setSessionDisconnected = useCallback((d: boolean) => {
    sessionDisconnectedRef.current = d;
    setSessionDisconnectedState(d);
  }, []);

  // Idle lifecycle controller lifecycle: created only for a REMOTE
  // (gateway) host with the config switch on — desktop-local (IPC) and
  // the default local topology never create one (see sessionLifecycle.ts
  // for the seam). Rebuilt when the host is replaced (login / open).
  useEffect(() => {
    const config = resolveSessionLifecycleConfig();
    if (!shouldRunSessionLifecycle({ configEnabled: config.enabled, gatewayMode: isGatewayMode() })) {
      return undefined;
    }
    if (!(host instanceof RemoteEngineHost)) return undefined;
    const transport = lifecycleTransportOf(host.getTransport());
    if (!transport) return undefined;
    const controller = new IdleSessionController({
      transport,
      config,
      activityTarget: window,
      pageHideTarget: window,
      onStateChange: (change) => {
        if (change.state === 'connected') {
          setSessionDisconnected(false);
          setSessionError(null);
          // The server workbook was rebuilt (rehydrate): the session
          // is live + checksum-verified, so the host's read gate lifts
          // (Phase 2 fix) — drop every cached view of the old
          // in-memory workbook and re-read.
          host.markSessionBound();
          notifyHostReplaced();
        } else if (change.state === 'disconnected') {
          setSessionDisconnected(true);
          setSessionError(null);
        } else if (change.state === 'error') {
          setSessionDisconnected(true);
          setSessionError(change.error ?? 'Session error — editing stays locked.');
        } else {
          // reconnecting: stay locked until checksum verification lands.
          setSessionDisconnected(true);
        }
      },
    });
    sessionControllerRef.current = controller;
    controller.start();
    return () => {
      controller.dispose();
      if (sessionControllerRef.current === controller) sessionControllerRef.current = null;
    };
  }, [host, setSessionDisconnected]);

  /** Manual reconnect (StatusBar button) — same verified path as activity. */
  const handleSessionReconnect = useCallback(() => {
    // Phase 2: a transport drop reconnects by re-running the gateway
    // lookup (fresh owner endpoint + token), not the idle rehydrate.
    if (transportDownRef.current && collabTransportRef.current) {
      collabTransportRef.current.reconnectNow();
      return;
    }
    void sessionControllerRef.current?.reconnect();
  }, []);
  const [sourceBindings, setSourceBindings] = useState<SourceBinding[]>(() =>
    restoreDataSourceBindings(),
  );
  const [etlOpen, setEtlOpen] = useState(false);
  const [dataTypeDialogOpen, setDataTypeDialogOpen] = useState(false);
  const [dataTypeCells, setDataTypeCells] = useState<Map<string, DataTypeValue>>(new Map());
  const [dataTypeCardKey, setDataTypeCardKey] = useState<string | null>(null);
  // Slicers + timelines (track 14): floating filter controls bound to columns.
  const [slicers, setSlicers] = useState<SlicerSpec[]>([]);
  const [slicerValues, setSlicerValues] = useState<Map<number, string[]>>(new Map());
  const [timelines, setTimelines] = useState<TimelineSpec[]>([]);
  // Sparklines (track 14): in-cell charts bound to data ranges.
  const [sparklines, setSparklines] = useState<SparklinePlacement[]>([]);
  const [sparklineDialogOpen, setSparklineDialogOpen] = useState(false);
  const [sparklineId, setSparklineId] = useState(1);
  // Formula language (track 22): initialized from the user profile;
  // persisted into the profile (platform-shell.md §4), not workbook bytes.
  const [formulaLang, setFormulaLang] = useState<SupportedLocale>(settings.formulaLanguage);
  const formulaLangRef = useRef(formulaLang);
  formulaLangRef.current = formulaLang;
  // Latest settings for hot callbacks (open flow reads the MT threshold
  // without re-subscribing) — same pattern as formulaLangRef.
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  // Save format (track 9): Open/Save resolve adapters by file extension.
  const [saveFormat, setSaveFormat] = useState<SaveFormatId>('xlsx');
  // Collaboration (track 10): the bridge owns the CollabSession; edits
  // flow through its OT pipeline. collabTick re-renders presence + log UI.
  const collabRef = useRef<CollabBridge | null>(null);
  const [collabTick, setCollabTick] = useState(0);
  void collabTick;
  const [revisionOpen, setRevisionOpen] = useState(false);
  // Phase 2 co-authoring: the SSE collab transport (gateway mode only),
  // the session's fileId (share/join link state, mirrored to `#file=`),
  // live presence participants, and server-rejected ops retained with
  // their input intact (visible rejection, never silent — doc §7).
  const collabTransportRef = useRef<CollabTransport | null>(null);
  // Shell integration: the canonical deep link is `?file=<id>` (the
  // Workspace's anchors); the legacy `#file=` hash is still read, and
  // the search parameter wins when both are present (product/deepLink).
  const [collabFileId, setCollabFileId] = useState<string | null>(() =>
    fileIdFromUrl(window.location),
  );
  const collabFileIdRef = useRef<string | null>(collabFileId);
  const setCollabFile = useCallback((fileId: string | null) => {
    collabFileIdRef.current = fileId;
    setCollabFileId(fileId);
    if (fileId) writeFileIdToHash(fileId);
    else clearFileIdFromHash();
  }, []);
  // Product shell routing state (shell integration; gateway mode +
  // non-desktop only — local mode and desktop keep the straight-to-grid
  // behavior): landing vs sign-in gate when logged out; the share
  // recipient flow and the Workspace home when authed. productApi /
  // sharesApi are created beside gwClient below (they need it).
  const [showLogin, setShowLogin] = useState(false);
  const [routeShareId, setRouteShareId] = useState<string | null>(() =>
    shareIdFromSearch(window.location.search),
  );
  /** The recipient's materialized app copy, shown full-screen once its data copy is imported. */
  const [shareSpec, setShareSpec] = useState<ArtifactSpec | null>(null);
  const [shareAcceptError, setShareAcceptError] = useState<string | null>(null);
  const shareAcceptStartedRef = useRef<string | null>(null);
  const shareImportStartedRef = useRef<string | null>(null);
  /**
   * The share-import runner lives beside the save machinery (it needs
   * saveWorkbookToServerLibrary); the join flow invokes it through this
   * ref the moment the data copy's session has loaded — on web,
   * workbookLoaded stays true throughout, so it cannot be the trigger.
   */
  const shareImportRunnerRef = useRef<(() => void) | null>(null);
  /** Set by the join flow when a file's session snapshot has landed. */
  const shareJoinCompletedRef = useRef<string | null>(null);
  /** A gallery app opened full-screen over the Workspace home. */
  const [workspaceAppId, setWorkspaceAppId] = useState<string | null>(null);
  /** Restore's working view: ask the chat panel to open this artifact. */
  const [chatArtifactRequest, setChatArtifactRequest] = useState<{ id: string; seq: number } | null>(
    null,
  );
  /** Voice handoff (#41): an unmatched palette utterance, seeded into
   * the agent composer when the panel opens. */
  const [chatDraftSeed, setChatDraftSeed] = useState<{ text: string; seq: number } | null>(null);
  const [collabParticipants, setCollabParticipants] = useState<PresenceParticipant[]>([]);
  // D9: the header chip shows the open file's NAME, never its raw id.
  // Resolved from the owner's catalog when the file is theirs; a
  // joiner (not the owner) falls back to a neutral label.
  const [collabFileName, setCollabFileName] = useState<string | null>(null);
  // Issue #17: a failed join-by-link blocks the app with this error
  // state (file name + plain-language next step) instead of leaving a
  // phantom editable grid whose edits silently die.
  const [joinFailure, setJoinFailure] = useState<{ fileName: string; message: string } | null>(null);
  // Issue #18: when a failed local open restored the previous workbook
  // via a reload (openRemoteBuffer), surface the stashed failure once —
  // when the restored workbook finishes loading (the join's own
  // success path clears the error slot, so surfacing at mount would
  // be overwritten before the user could read it).
  useEffect(() => {
    if (!workbookLoaded) return;
    try {
      const notice = sessionStorage.getItem(OPEN_FAILURE_NOTICE_KEY);
      if (notice) {
        sessionStorage.removeItem(OPEN_FAILURE_NOTICE_KEY);
        setRestoreNotice(notice);
        window.setTimeout(() => setRestoreNotice(null), 30000);
      }
    } catch {
      // Storage unavailable — nothing to surface.
    }
  }, [workbookLoaded]);
  // (The resolving effect lives below the productApi declaration —
  // an effect's deps array is evaluated in body order, so referencing
  // productApi from here would hit its TDZ on first render.)
  const [collabRejected, setCollabRejected] = useState<RejectedOp[]>([]);
  const transportDownRef = useRef(false);
  // Non-gating offline indicator (design doc §7): true while the collab
  // transport is reconnecting after a drop. Editing continues against
  // the mirror + durable queue; this only drives the StatusBar notice.
  const [transportOffline, setTransportOffline] = useState(false);
  // Smart chips (track 15 extension): people/files/calendar/finance/rating.
  const [smartChipDialogOpen, setSmartChipDialogOpen] = useState(false);
  const [smartChipCells, setSmartChipCells] = useState<Map<string, SmartChipValue>>(new Map());
  const [smartChipCardKey, setSmartChipCardKey] = useState<string | null>(null);
  // Sensitivity labels: service metadata store over a localStorage adapter.
  // Creation is async (encrypted at rest needs WebCrypto), so the first
  // render suspends until the store resolves (Suspense boundary in main.tsx).
  const sensitivity: SensitivityStore = suspended(
    'sensitivity-store',
    () => createSensitivityStore(localStoragePersistence(), new KeyManager(localStoragePersistence())),
  );
  const [sensitivityTick, setSensitivityTick] = useState(0);
  // Offline op log (track 5): every mutation is recorded; while offline the
  // ops stay pending, and other tabs' ops arrive via storage events.
  const [oplog] = useState(() => new OpLog());
  const [tabId] = useState(() => Math.random().toString(36).slice(2));
  const appliedKeysRef = useRef<Set<string>>(new Set());
  const lastSyncSeqRef = useRef(0);
  const [pendingOps, setPendingOps] = useState(0);
  const [online, setOnline] = useState(() =>
    typeof navigator === 'undefined' ? true : navigator.onLine,
  );
  const [conflicts, setConflicts] = useState<OpConflict[]>([]);
  const [formControls, setFormControls] = useState<FormControl[]>([]);
  const [globeSetupOpen, setGlobeSetupOpen] = useState(false);
  const [globes, setGlobes] = useState<{ id: number; points: LatLong[]; size: number; x: number; y: number; offline?: boolean }[]>([]);
  const [extLinksOpen, setExtLinksOpen] = useState(false);
  const extRegistry = useRef(new ExternalLinkRegistry()).current;
  const [liveMessage, setLiveMessage] = useState('');
  /**
   * Screen-reader announcement (design-docs/accessibility.md §2.3). Always
   * goes through here instead of setLiveMessage directly: screen readers
   * ignore unchanged live-region text (and React bails out on identical
   * state), so repeating an action — two page-break inserts, two PDF
   * downloads — would only announce once. Clearing first in a separate
   * tick forces every announcement through.
   */
  const announce = useCallback((msg: string) => {
    setLiveMessage('');
    window.setTimeout(() => setLiveMessage(msg), 40);
  }, []);
  // Data tools: Solver, What-If Analysis, Flash Fill (track 7 + track 16).
  const [solverOpen, setSolverOpen] = useState(false);
  const [goalSeekOpen, setGoalSeekOpen] = useState(false);
  const [scenarioOpen, setScenarioOpen] = useState(false);
  const [dataTableOpen, setDataTableOpen] = useState(false);
  const [scenarioSet, setScenarioSet] = useState<ScenarioSet>(() => createScenarioSet());
  const [flashFillProposal, setFlashFillProposal] = useState<{
    proposal: FlashFillProposal;
    targetCol: number;
    startRow: number;
    sourceRef: string;
    previewRows: { input: string; output: string }[];
  } | null>(null);
  // Deterministic inference panel (design-docs/deterministic-inference.md §3).
  const [inferencePanel, setInferencePanel] = useState<{
    title: string;
    proposals: Proposal[];
  } | null>(null);
  // Column statistics dialog (Data > Column Statistics).
  const [columnStats, setColumnStats] = useState<{ profiles: ColumnProfile[]; title: string } | null>(null);
  const [iterativeOpen, setIterativeOpen] = useState(false);
  const [iterativeSettings, setIterativeSettings] = useState<IterativeSettings>(DEFAULT_ITERATIVE);

  // Parallel recalculation (track 13): worker-pool options + last stats.
  const [parallelCalcOpen, setParallelCalcOpen] = useState(false);
  const [parallelOpts, setParallelOpts] = useState<ParallelRecalcOptions>(() => defaultParallelOptions());
  const [lastParallelStats, setLastParallelStats] = useState<ParallelRecalcStats | null>(null);
  const workersAvailable = typeof Worker !== 'undefined';

  // Dialogs.
  const [findOpen, setFindOpen] = useState(false);
  // Platform shell (design-docs/platform-shell.md §§2,4,6): command
  // registry surfaces — shortcuts dialog (Ctrl+/), menu search (Alt+/),
  // per-user settings, and the workbook library (New/Open/Copy/Trash).
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [menuSearchOpen, setMenuSearchOpen] = useState(false);
  const [voicePaletteOpen, setVoicePaletteOpen] = useState(false);
  // Voice command palette (Pro tier): the tier is read from our gateway
  // JWT's claim (stamped at login — product-layer contract), re-resolved
  // each time the palette opens so a mid-session login or promotion is
  // honored. Dictation rides the agent service's /transcribe route and
  // exists only in gateway sessions; local/desktop modes use typed
  // input or OS dictation.
  const paletteTier = useMemo(
    () => resolvePaletteTier(),
    // Re-resolve on open, not on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [voicePaletteOpen],
  );
  const voiceTranscribe = useMemo(() => {
    if (!isGatewayMode()) return null;
    const gw = getGatewayClient();
    return gw ? createGatewayTranscribe(gw) : null;
  }, []);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [library] = useState(() => new WorkbookLibrary());
  const [libraryId, setLibraryId] = useState<string | null>(null);
  // Desktop native save: the last path written through File → Save.
  const [desktopPath, setDesktopPath] = useState<string | null>(null);
  /**
   * GAP-2/GAP-5/GAP-10: the desktop save path may be auto-saved to
   * silently ONLY when the main process has seen it through a native
   * dialog or an OS open (trusted dir). A dropped file's path (from
   * Electron's File.path) is claimed for Save-dialog pre-fill but stays
   * untrusted until the first dialog-confirmed save — auto-save skips it
   * so a dropped file never triggers a surprise modal.
   */
  const desktopPathTrustedRef = useRef(true);
  // Desktop Help menu → HelpPane (GAP-7).
  const [desktopHelpOpen, setDesktopHelpOpen] = useState(false);
  // Bump when a pivot is refreshed so bound PivotCharts re-derive series.
  const [pivotTick, setPivotTick] = useState(0);
  const [findMatches, setFindMatches] = useState<{ row: number; col: number }[]>([]);
  const [findIdx, setFindIdx] = useState(0);
  const [cfOpen, setCfOpen] = useState(false);
  const [validationOpen, setValidationOpen] = useState(false);
  const [filterOpen, setFilterOpen] = useState<{ col: number } | null>(null);
  const [ctxMenu, setCtxMenu] = useState<CtxMenuState | null>(null);
  // Extended dialog states.
  const [rowHeightOpen, setRowHeightOpen] = useState(false);
  const [colWidthOpen, setColWidthOpen] = useState(false);
  const [renameSheetOpen, setRenameSheetOpen] = useState(false);
  const [sortDialogOpen, setSortDialogOpen] = useState(false);
  const [macroDialogOpen, setMacroDialogOpen] = useState(false);
  const [macroRecording, setMacroRecording] = useState(isMacroRecording());
  useEffect(() => onMacroRecordingChange(() => setMacroRecording(isMacroRecording())), []);
  const [nameManagerOpen, setNameManagerOpen] = useState(false);
  const [namedFunctionOpen, setNamedFunctionOpen] = useState(false);
  const [commentDialogOpen, setCommentDialogOpen] = useState(false);
  // Sheet protection (track 19). The ProtectionManager enforces via the
  // Authorizer policy; protectionTick forces re-render on protect/unprotect.
  const [protection] = useState(() => new ProtectionManager());
  const [protectionDialogOpen, setProtectionDialogOpen] = useState(false);
  // File password dialog (faces a & b): { mode, buffer, filename }.
  const [filePassword, setFilePassword] = useState<{
    mode: 'open' | 'download';
    buffer?: Uint8Array;
    filename?: string;
    /** Gateway mode: decrypt client-side, then upload XLSX to the engine service. */
    remote?: boolean;
  } | null>(null);
  const [filePasswordError, setFilePasswordError] = useState<string | null>(null);
  const [filePasswordBusy, setFilePasswordBusy] = useState(false);
  // Gateway login gate (spec a/c): no JWT → no engine/service access.
  const [gwClient] = useState(() => getGateway());
  const [gwAuthed, setGwAuthed] = useState(() => (getGateway()?.loggedIn ?? true));
  // Product-layer clients over the gateway connection (shell
  // integration): the Workspace catalog API and the app-share API.
  const [productApi] = useState<ProductApi | null>(() => (gwClient ? new ProductApi(gwClient) : null));
  // D9: resolve the open collab file's display name for the header
  // chip (the chip never renders the raw file id).
  useEffect(() => {
    if (!collabFileId || !productApi) {
      setCollabFileName(null);
      return;
    }
    let cancelled = false;
    void productApi
      .listFiles()
      .then((res) => {
        if (cancelled) return;
        setCollabFileName(res.files.find((f) => f.fileId === collabFileId)?.name ?? null);
      })
      .catch(() => {
        if (!cancelled) setCollabFileName(null);
      });
    return () => {
      cancelled = true;
    };
  }, [collabFileId, productApi]);
  const [sharesApi] = useState<SharesApi | null>(() => (gwClient ? new SharesApi(gwClient) : null));
  // W4: server-side persistence for UI-built apps (gateway mode only —
  // null in local mode, where the localStorage app store stays the
  // only store, exactly as before).
  const [builtAppsApi] = useState<BuiltAppsApi | null>(() =>
    gwClient ? new BuiltAppsApi(gwClient) : null,
  );
  // Firebase Google sign-in (Cycle 9, Phase 1): the state machine behind
  // the header login button and the Google option in the login gate.
  // GatewayClient already implements the token-exchange side
  // (loginWithFirebaseIdToken/logout). Only in gateway mode — local mode
  // has no gateway to exchange with.
  const [firebaseAuth] = useState<FirebaseAuthService | null>(
    () => (gwClient ? new FirebaseAuthService(createFirebasePort(), gwClient) : null),
  );
  // Firebase state mirrored for the login gate's rendering: in the
  // production flavor the landing page fires Google sign-in directly,
  // so it needs the in-flight/error state to show progress and report
  // a cancelled or failed popup in place. Tracked only while the gate
  // is up (not yet authed); the transition effect below owns login.
  const [fbGateState, setFbGateState] = useState<FirebaseAuthState | null>(
    () => firebaseAuth?.current ?? null,
  );
  useEffect(() => {
    if (!firebaseAuth || gwAuthed) return;
    setFbGateState(firebaseAuth.current);
    return firebaseAuth.subscribe(setFbGateState);
  }, [firebaseAuth, gwAuthed]);
  // Auth coherence (user ruling, 2026-10-22): a gateway 401 with a live
  // Firebase session triggers ONE silent re-exchange + retry inside
  // GatewayClient; with no session the token is cleared and the auth
  // state converges to logged-out — the two never split. Wired ONLY in
  // the Firebase posture: in the dev-login posture the gateway token
  // belongs to the dev session (the Firebase service is logged-out by
  // design there), and some proxied routes 401 by design in signed
  // mode (e.g. session-extras) — treating those as token death would
  // clear a healthy dev token and anonymize every later call.
  useEffect(() => {
    if (!gwClient || !firebaseAuth) return;
    if (isDevLoginEnabled(gwClient)) return;
    gwClient.setReauthProvider(() => firebaseAuth.reauthenticateGateway());
    return () => gwClient.setReauthProvider(null);
  }, [gwClient, firebaseAuth]);
  // Desktop always shows the login button: the desktop branch of
  // FirebaseLoginButton drives window.icecreamDesktop.auth (login window flow)
  // and does not need the web FirebaseAuthService.
  const [showDesktopLogin] = useState(() => isDesktop());
  // The local user is the workbook owner: exempt from cell hiding, and the
  // principal stamped on protection actions. (A future multi-user service
  // replaces this with the JWT session principal.)
  const sessionPrincipal = 'user';
  // Compose the engine authorizer: protectionPolicy (locked/hidden cells,
  // workbook structure) over the base policy. Rebuilt whenever the host is
  // replaced (Open / New) so the new host enforces protection too.
  const makeAuthorizer = useCallback(
    () => new Authorizer(protection.protectionPolicy(allowAllPolicy())),
    [protection],
  );
  const wireProtection = useCallback(
    (h: EngineHost) => {
      h.getAuthorizer().setPolicy(protection.protectionPolicy(allowAllPolicy()));
      h.setHiddenCheck((ref, principal) =>
        protection.isHiddenFrom(ref.sheet, ref.row, ref.col, principal),
      );
    },
    [protection],
  );
  // Wire protection into the initial host + mark the owner exempt from hiding.
  useEffect(() => {
    protection.setHiddenExemptPrincipals([sessionPrincipal]);
    wireProtection(getHost());
    wireFunctionProviders();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  /** Replace the host (Open / New) keeping protection enforcement wired. */
  const replaceWiredHost = useCallback(
    (workbook: import('@icecream-sheets/engine').EngineWorkbook) => {
      const h = replaceHost(workbook, makeAuthorizer());
      wireProtection(h);
      return h;
    },
    [makeAuthorizer, wireProtection],
  );
  /**
   * Wire the engine's function providers for the web host (2026-10-18):
   * - WEBSERVICE → browser fetch via sync XHR (the Fetch component seam).
   * - PY → MCP execute_code over the direct MCP ingress (sync XHR).
   * - COPILOT → AgentRuntime via the agent service (sync XHR in gateway
   *   mode); falls back to the engine's built-in deterministic analyst.
   * Providers are process-global in the engine; wiring once is enough.
   */
  const wireFunctionProviders = useCallback(() => {
    // Sync XHR helper (the engine's provider seam is synchronous).
    const syncPost = (url: string, body: unknown, headers: Record<string, string> = {}): string => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', url, false);
      xhr.setRequestHeader('Content-Type', 'application/json');
      for (const [k, v] of Object.entries(headers)) xhr.setRequestHeader(k, v);
      xhr.send(JSON.stringify(body));
      if (xhr.status < 200 || xhr.status >= 300) {
        throw new Error(`HTTP ${xhr.status}: ${xhr.responseText.slice(0, 200)}`);
      }
      return xhr.responseText;
    };
    const syncGet = (url: string): string => {
      const xhr = new XMLHttpRequest();
      xhr.open('GET', url, false);
      xhr.send();
      if (xhr.status < 200 || xhr.status >= 300) {
        throw new Error(`HTTP ${xhr.status}: ${xhr.responseText.slice(0, 200)}`);
      }
      return xhr.responseText;
    };

    // WEBSERVICE: browser fetch (sync XHR). CORS applies per the target.
    setWebFetchProvider((url: string): string => {
      const xhr = new XMLHttpRequest();
      xhr.open('GET', url, false);
      xhr.send();
      if (xhr.status < 200 || xhr.status >= 300) {
        throw new Error(`WEBSERVICE: fetch failed for "${url}" (HTTP ${xhr.status}).`);
      }
      return xhr.responseText.slice(0, 32767);
    });

    // MCP base URL: explicit env, else derive from the gateway URL
    // (direct ingress, not through the gateway — 2026-10-18 decision).
    const gwUrl = (() => {
      try {
        const env = (import.meta as unknown as { env?: Record<string, string> }).env;
        return env?.['VITE_GATEWAY_URL'] ?? null;
      } catch {
        return null;
      }
    })();
    const mcpBase = (() => {
      try {
        const env = (import.meta as unknown as { env?: Record<string, string> }).env;
        if (env?.['VITE_MCP_URL']) return env['VITE_MCP_URL'].replace(/\/+$/, '');
      } catch { /* ignore */ }
      if (gwUrl) {
        try {
          const u = new URL(gwUrl);
          return `${u.protocol}//${u.hostname}:8106`;
        } catch { /* ignore */ }
      }
      return 'http://127.0.0.1:8106';
    })();

    // PY: run Python through the MCP server's execute_code (sandboxed).
    // Uses the MCP streamable-HTTP transport with a minimal handshake.
    setPythonProvider({
      run: (code: string, args: unknown[]): { value: unknown } | { error: string } => {
        try {
          // MCP initialize handshake (sync XHR).
          const initXhr = new XMLHttpRequest();
          initXhr.open('POST', `${mcpBase}/mcp`, false);
          initXhr.setRequestHeader('Content-Type', 'application/json');
          initXhr.setRequestHeader('Accept', 'application/json, text/event-stream');
          initXhr.send(
            JSON.stringify({
              jsonrpc: '2.0', id: 1, method: 'initialize',
              params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'icecream-web-py', version: '1.0' } },
            }),
          );
          const sessionId = initXhr.getResponseHeader('mcp-session-id') ?? '';
          const call = (payload: unknown): unknown => {
            const xhr = new XMLHttpRequest();
            xhr.open('POST', `${mcpBase}/mcp`, false);
            xhr.setRequestHeader('Content-Type', 'application/json');
            xhr.setRequestHeader('Accept', 'application/json, text/event-stream');
            if (sessionId) xhr.setRequestHeader('mcp-session-id', sessionId);
            xhr.send(JSON.stringify(payload));
            const text = xhr.responseText;
            // SSE framing: take the last data: line.
            const lines = text.split('\n').filter((l) => l.startsWith('data:'));
            const last = lines.length > 0 ? lines[lines.length - 1].slice(5).trim() : text;
            return JSON.parse(last);
          };
          void syncPost; void syncGet;
          call({ jsonrpc: '2.0', method: 'notifications/initialized' });
          const res = call({
            jsonrpc: '2.0', id: 2, method: 'tools/call',
            params: { name: 'execute_code', arguments: { language: 'python', code, args } },
          }) as { result?: { content?: { text?: string }[] }; error?: { message?: string } };
          if (res.error) return { error: res.error.message ?? 'MCP execute_code failed' };
          const outText = res.result?.content?.[0]?.text ?? '';
          try {
            const parsed = JSON.parse(outText) as { ok?: boolean; error?: string; result?: unknown };
            if (parsed.ok === false) return { error: parsed.error ?? 'Python execution failed' };
            return { value: parsed.result ?? parsed };
          } catch {
            return { value: outText };
          }
        } catch (e) {
          return { error: e instanceof Error ? e.message : String(e) };
        }
      },
    });

    // COPILOT: route to the AI Agent host via the agent service (gateway
    // mode). Local/desktop mode keeps the engine's built-in analyst.
    if (gwUrl) {
      const token = (() => {
        try {
          return localStorage.getItem('icecream-sheets.gateway-token');
        } catch {
          return null;
        }
      })();
      if (token) {
        const agentUrl = gwUrl.replace(/\/+$/, '');
        setCopilotProvider({
          ask: (prompt: string): string => {
            const resText = syncPost(
              `${agentUrl}/api/agent/message`,
              { text: prompt },
              { Authorization: `Bearer ${token}` },
            );
            try {
              const parsed = JSON.parse(resText) as { reply?: string; message?: string };
              return parsed.reply ?? parsed.message ?? resText;
            } catch {
              return resText;
            }
          },
        });
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // Tick forces re-render on protect/unprotect (read below to satisfy TS).
  const [protectionTick, setProtectionTick] = useState(0);
  void protectionTick;
  const [cfTopBottomOpen, setCfTopBottomOpen] = useState(false);
  const [cfDataBarOpen, setCfDataBarOpen] = useState(false);
  const [cfColorScaleOpen, setCfColorScaleOpen] = useState(false);
  const [cfIconSetOpen, setCfIconSetOpen] = useState(false);
  const [spellingOpen, setSpellingOpen] = useState(false);
  const [formatCellsOpen, setFormatCellsOpen] = useState(false);
  const [unhideOpen, setUnhideOpen] = useState(false);
  const [tabColors, setTabColors] = useState<Map<string, string>>(new Map());
  const [spellingIssues, setSpellingIssues] = useState<{ row: number; col: number; word: string }[]>([]);

  // Active sheet: the selected sheet if still visible, else the first visible.
  // Perf (2026-10-19): host.sheetNames() is O(sheets); the old
  // host.snapshot().sheets.map(...) re-serialized the whole workbook
  // (1.8M getSerialized calls, ~1.5s) on EVERY render.
  const sheetNames = host.sheetNames();
  const visibleSheets = sheetNames.filter((n) => !hiddenSheets.has(n));
  const activeSheet = visibleSheets.includes(sheet) ? sheet : (visibleSheets[0] ?? 'Sheet1');

  // Re-render on engine events (cellsChanged / recalcComplete / sheetAdded).
  useEffect(() => {
    const unsub = host.subscribe(() => setTick((t) => t + 1));
    return unsub;
  }, [host]);

  // Collaboration (track 10): attach a CollabSession to the engine host.
  // Local edits flow through the session's OT pipeline (transform +
  // revision log) via the bridge; a new document gets a fresh log.
  useEffect(() => {
    const bridge = new CollabBridge({
      // Phase 2: the bridge's identity IS the transport's identity —
      // the persisted clientId (localStorage 'icecream.clientId') and
      // the gateway principal, so op envelopes, presence, and the
      // revision log all name the same client.
      clientId: getOrCreateClientId(),
      principal: getGatewayClient()?.principal ?? 'You',
    });
    bridge.attach(host, () => setCollabTick((t) => t + 1));
    collabRef.current = bridge;
    return () => {
      bridge.detach();
      if (collabRef.current === bridge) collabRef.current = null;
    };
  }, [host]);

  // Re-apply the chosen formula language when the host is replaced
  // (file open rebuilds the workbook, which defaults to enUS).
  useEffect(() => {
    try {
      host.setFormulaLanguage(formulaLangRef.current);
    } catch {
      // Keep the workbook default; the switcher can retry.
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [host]);

  // Apply the per-user theme choice (platform-shell.md §4).
  useEffect(() => {
    applyTheme(settings.theme);
  }, [settings.theme]);

  // Track host replacement (Open .xlsx rebuilds the workbook).
  useEffect(() => {
    return onHostReplaced(() => {
      const h = getHost();
      setHost(h);
      const names = h.sheetNames();
      // Wave-C W5: a host replacement is not always a new workbook.
      // The join-by-link flow notifies again after its terminal
      // snapshot lands — seconds after the connected host already
      // rendered tabs and the user could switch sheets. Resetting to
      // the first sheet there stomped the user's tab switch: the
      // grid sat on the near-empty first sheet while the chosen
      // sheet's data was already cached (the "join never paints"
      // defect). Keep the user's sheet when it exists in the new
      // host; a genuinely new workbook that lacks it still lands
      // on sheet 1, exactly as before.
      setSheet((prev) => (names.includes(prev) ? prev : (names[0] ?? 'Sheet1')));
      setSel({ row: 0, col: 0 });
      setGridSel(cellSelection(0, 0));
      setCalcMode('automatic');
      setLastError(null);
      undoRef.current.clear();
      setUndoTick((t) => t + 1);
      setCfRules([]);
      setValidations([]);
      setMerges([]);
      setFreeze(null);
      setFilters(new Map());
      setHiddenSheets(new Set());
      setFormats(createFormatStore());
    });
  }, []);

  // Advertise presence (sheet + selection) for the collaborators UI.
  useEffect(() => {
    collabRef.current?.heartbeatSelf(activeSheet, sel.row, sel.col);
  }, [activeSheet, sel.row, sel.col]);

  /**
   * Shell integration — first open of a Workspace catalog upload. The
   * join handshake claims a FRESH engine session (joined=false,
   * revision 0) that holds nothing yet; when the catalog record has
   * uploaded bytes (storageRef) and no stored state, drive the engine's
   * /load/storage-ref DIRECTLY on the owner engine (the bytes never
   * cross this client). A joined session (a co-author already loaded
   * it) or a rehydrated one (revision > 0) already holds the workbook —
   * reloading under it would destroy live state, so both are skipped,
   * as are ad-hoc join links with no catalog record.
   */
  const loadCatalogUploadIfNeeded = useCallback(
    async (
      opened: EngineOpenResult,
      fileId: string,
      transport: CollabTransport,
    ): Promise<EngineLoadResult | null> => {
      if (!productApi) return null;
      if (opened.joined || opened.rehydrated || opened.revision > 0) return null;
      const rec = await productApi.getFile(fileId).catch(() => null);
      if (!rec?.storageRef || rec.hasStoredState) return null;
      return transport.loadStorageRefDirect({
        bucket: rec.storageRef.bucket,
        object: rec.storageRef.object,
        format: rec.sourceFormat,
        sourceName: rec.name,
      });
    },
    [productApi],
  );

  // Phase 2 collab transport (gateway mode only): one transport per
  // remote host. It owns the SSE delta channel (always on, §8), the
  // durable outbound queue, presence, and server-reported save status;
  // attaching it to the host stops /events polling and routes every
  // mutating execute through POST /ops. Local + desktop hosts never
  // create one. The bridge is wired to it both ways: local ops
  // broadcast out, remote deltas + presence feed back in.
  useEffect(() => {
    if (!(host instanceof RemoteEngineHost)) return undefined;
    const gateway = getGatewayClient();
    if (!gateway) return undefined;
    const remote = host;
    const transport = new CollabTransport({
      gateway,
      principal: gateway.principal ?? 'You',
      // Presence display name (workspace-settings brief): the settings
      // display name is the source, provider name/email the fallback —
      // read live at every presence post, so a name saved in Settings
      // reaches live sessions on the next heartbeat too.
      presenceDisplayName: () => effectiveDisplayName(),
      host: {
        applyDeltaCells: (cells, meta) => remote.applyDeltaCells(cells, meta),
        applySessionEvent: (ev) => remote.applySessionEvent(ev),
        resync: async () => {
          await remote.resyncToCurrentState();
        },
      },
      onStateChange: (s) => {
        if (s === 'connected') {
          if (transportDownRef.current) {
            transportDownRef.current = false;
            setTransportOffline(false);
            setSessionDisconnected(false);
            setSessionError(null);
          }
        } else if (s === 'reconnecting') {
          // A transport drop is NOT an idle release (design doc §7): a
          // disconnected client keeps working against its local mirror
          // and its ops go to the transport's DURABLE queue, flushing in
          // order after catch-up on reconnect — the transport re-runs
          // the gateway lookup and lands (possibly on a new owner);
          // endpoints are leased, never reused (§9). Editing must NOT
          // gate here: the sessionDisconnected gate belongs exclusively
          // to the idle-release lifecycle (IdleSessionController), where
          // the server has actually evicted the session. (Validation
          // finding: gating on 'reconnecting' silently rejected every
          // offline edit after the first — the first raced in before
          // the drop was detected; the rest died at commitCell's gate.)
          transportDownRef.current = true;
          setTransportOffline(true);
        }
      },
      onStatus: (st) => {
        // Saving…/Saved is SERVER-REPORTED only (§5): live vs stored
        // revision from the status event, never client inference. An
        // edit still in flight toward the server is not yet in its
        // liveRevision, so a caught-up read must not win that race
        // (same guard as the gateway autosave status poll).
        if (!st.saving && st.storedRevision >= st.revision && hostHasInFlightEdits(host)) return;
        setSaveState(st.saving || st.storedRevision < st.revision ? 'saving' : 'saved');
      },
      onParticipants: (ps) => {
        setCollabParticipants(ps);
        collabRef.current?.setRemoteParticipants(ps);
      },
      onCharts: (incoming) => {
        // FIX-G (trace §4.1e): native charts authored in the engine
        // session (agent create_chart, or a co-client's) arrive as the
        // full session list — merge by spec id into the chart store,
        // the same setCharts + persistCharts pair handleCreateChart
        // makes. The overlay then renders bound to live data.
        if (incoming.length === 0) return;
        setCharts((prev) => {
          const byId = new Map(prev.map((c) => [c.id, c]));
          for (const c of incoming) byId.set(c.id, { ...c, nativePart: true });
          const next = [...byId.values()];
          persistCharts(next);
          return next;
        });
      },
      onDelta: (delta) => {
        // Feed the bridge's revision log (changes UI). Own ops are
        // already logged by the bridge's local apply path.
        if (delta.origin.clientId === transport.clientId) return;
        const first = delta.cells[0];
        if (!first) return;
        collabRef.current?.ingestRemoteDelta(
          {
            id: `${delta.origin.clientId ?? 'server'}:${delta.origin.clientSeq ?? delta.revision}`,
            type: 'cell.set',
            baseRevision: delta.revision - 1,
            params: {
              sheet: first.sheet,
              row: first.row,
              col: first.col,
              value: first.formula ?? (first.value ? (first.value as { value: unknown }).value ?? null : null),
            },
          },
          delta.origin.principal ?? 'Peer',
        );
      },
      onRejected: (entry) => {
        setCollabRejected([...transport.rejected]);
        setLastError(
          `Edit rejected by the server (${entry.reason}). Your input was retained — see the notice above the grid.`,
        );
      },
    });
    collabTransportRef.current = transport;
    remote.attachCollabTransport(transport);
    // Download metadata goes DIRECT to the owning engine over this
    // transport (the gateway-proxied /api/engine/download forwards the
    // gateway JWT, which the signed-mode engine refuses — downloads
    // 401'd for Phase 2 file sessions; see collabTransport
    // .downloadMetadata). The gateway still signs the storage URL.
    gateway.setDirectDownloadMetadataProvider((extras) => transport.downloadMetadata(extras));
    // Residual (p): the BYTE-response /download classes (named-range
    // subsets + non-xlsx formats) go direct over the same transport —
    // on the proxied branch they 401 in signed mode exactly like the
    // metadata call did.
    gateway.setDirectDownloadBytesProvider((extras) => transport.downloadBytes(extras));
    // Library save goes DIRECT over the same transport (the
    // gateway-proxied /api/engine/library-save forwards the gateway
    // JWT, which the signed-mode engine refuses — the normal Ctrl+S
    // library save 401'd for Phase 2 file sessions; see
    // collabTransport.librarySave).
    gateway.setDirectLibrarySaveProvider(async (payload) => {
      const entry = await transport.librarySave(payload);
      return entry ? { ok: true as const, entry } : null;
    });
    // Library-entry OPEN goes DIRECT over the same transport (the
    // gateway-proxied GET /api/engine/library/:id forwards the gateway
    // JWT, which the signed-mode engine refuses — opening a workbook
    // from the library 401'd for Phase 2 file sessions; see
    // collabTransport.libraryBytes). The session bind that follows a
    // library open goes direct too (the proxied bind 401'd silently,
    // so AutoSave checkpoints never committed into the user's entry;
    // see collabTransport.bindLibrary).
    gateway.setDirectLibraryBytesProvider((id) => transport.libraryBytes(id));
    gateway.setDirectBindLibraryProvider((id, name) => transport.bindLibrary(id, name));
    const bridge = collabRef.current;
    bridge?.setBroadcastHandler((op) => {
      transport.submitBridgeOp(op);
    });
    bridge?.setPresenceSendHandler((sheet, row, col) => {
      transport.sendPresence({ sheet, row, col });
    });
    // #8 residual: the StatusBar roster resolves self's display name
    // through the same chain the outgoing presence payload is stamped
    // with, read live so a settings rename lands without a reload.
    bridge?.setSelfDisplayNameProvider(() => effectiveDisplayName());
    // Join-by-link: a `#file=<fileId>` present at startup performs the
    // join handshake instead of waiting for a fresh upload.
    const joinFileId = collabFileIdRef.current;
    if (joinFileId) {
      void transport
        .connect(joinFileId)
        .then(async (opened) => {
          // Shell integration: a first-open Workspace upload needs its
          // bytes loaded into the fresh claimed session before the
          // snapshot is taken (no-op for joined/rehydrated sessions).
          const loadResult = await loadCatalogUploadIfNeeded(opened, joinFileId, transport);
          const snap = await remote.snapshotAsync().catch(() => undefined);
          // ORDER IS LOAD-BEARING (the defect-E2 doctrine; sweep finding
          // F-5 / issue #19): the host-replaced handler RESETS the
          // per-workbook stores — setFormats(createFormatStore())
          // included — so the notify must come BEFORE any hydration
          // that seeds them. This flow used to notify once before
          // hydrate and AGAIN after the snapshot landed; the second
          // notify wiped the format store hydrateOpenedWorkbook had
          // just seeded from the /load payload, so a Workspace /
          // deep-link open rendered the file's stored number formats
          // (dates, percents) as raw numbers. The snapshot is fetched
          // first now and the single notify still lands after it (the
          // Wave-C W5 tab-sync the trailing notify existed for),
          // immediately before hydration.
          notifyHostReplaced();
          if (loadResult) {
            // File-2 defect D1: the /load/storage-ref response IS the
            // session's /load-shaped result — hydrate from it exactly
            // like the stream flow's terminal hydrate. Without this the
            // result was discarded and the snapshot below (which carries
            // no workbook metadata) was the only hydration, so imported
            // pictures, text boxes, chart specs and every other
            // metadata-driven overlay never rendered on a Workspace /
            // deep-link open.
            const data = workbookDataFromLoadResult(loadResult);
            const colNonEmptyBySheet = new Map<string, number[]>(
              Object.entries(loadResult.columnCounts),
            );
            hydrateOpenedWorkbook(data, { skipEngineSide: true, colNonEmptyBySheet });
          } else if (snap?.metadata) {
            // Joined/rehydrated session: no /load payload exists for
            // this client, so the snapshot is the only hydration
            // source — its additive metadata field (File-2 D1
            // follow-up) feeds the same overlay hydration the load
            // path runs, or imported pictures/text boxes never render
            // for this client.
            hydrateOverlayMetadata(snap.metadata);
          }
          setWorkbookLoaded(true);
          // If this file is a share data copy, its snapshot import can
          // only run now — the session is loaded and bound.
          shareJoinCompletedRef.current = joinFileId;
          shareImportRunnerRef.current?.();
        })
        .catch((e: unknown) => {
          // Issue #17: never render the raw gateway error (file UUIDs,
          // JSON) and never leave the phantom grid behind it — block
          // with a plain-language error state naming the file. The raw
          // error goes to the console only.
          console.warn('[collab] join failed:', e);
          const message = joinFailureMessage(e);
          setLastError(`Could not open the shared file. ${message}`);
          setJoinFailure({ fileName: 'Shared file', message });
          // Name the file from the owner's catalog when it is theirs
          // (same resolution as the header chip); a joiner keeps the
          // neutral label — the raw file id never renders.
          if (productApi) {
            void productApi
              .listFiles()
              .then((res) => {
                const name = res.files.find((f) => f.fileId === joinFileId)?.name;
                if (name) {
                  setJoinFailure((prev) => (prev ? { ...prev, fileName: name } : prev));
                }
              })
              .catch(() => {});
          }
        });
    }
    return () => {
      bridge?.setBroadcastHandler(null);
      bridge?.setPresenceSendHandler(null);
      gateway.setDirectDownloadMetadataProvider(null);
      gateway.setDirectDownloadBytesProvider(null);
      gateway.setDirectLibrarySaveProvider(null);
      gateway.setDirectLibraryBytesProvider(null);
      gateway.setDirectBindLibraryProvider(null);
      remote.detachCollabTransport();
      transport.disconnect();
      if (collabTransportRef.current === transport) collabTransportRef.current = null;
    };
  }, [host, setSessionDisconnected, setWorkbookLoaded, loadCatalogUploadIfNeeded]);


  const bumpUndo = useCallback(() => setUndoTick((t) => t + 1), []);

  /**
   * Capture a names-only undo entry before a name edit (define/delete/
   * rename in the name dialogs). The UndoManager snapshots the store defs;
   * undo/redo restore them via the hooks registered above.
   */
  const captureNamesUndo = useCallback(
    (label: string) => {
      undoRef.current.captureNamesOnly(label);
      bumpUndo();
    },
    [bumpUndo],
  );

  // ---- Offline op log -----------------------------------------------------
  // Every mutation is recorded; while offline the ops stay pending, other
  // tabs' ops arrive via storage events, and conflicts surface in SyncStatus.

  /** Record a mutation in the op log; queued (pending) while offline. */
  const logOp = useCallback(
    (kind: OpKind, payload: Record<string, unknown>) => {
      const op = oplog.append({ principal: sessionPrincipal, kind, payload: { ...payload, tab: tabId } });
      appliedKeysRef.current.add(opKey(op));
      try {
        localStorage.setItem(OPLOG_KEY_PREFIX + tabId, oplog.serialize());
      } catch { /* storage unavailable */ }
      if (typeof navigator === 'undefined' || navigator.onLine) {
        lastSyncSeqRef.current = op.seq; // online edits flush immediately
      }
      setPendingOps(oplog.lastSeq() - lastSyncSeqRef.current);
    },
    [oplog, tabId],
  );

  /**
   * Shift tracked named ranges after an insert/delete row/col op
   * (design-docs/named-ranges-and-named-functions.md §1: the identity
   * tracks insert/delete/move). The web app implements structure as cell
   * copies, so the store shifts refs explicitly here; undo restores defs.
   */
  const shiftNamesForStructure = useCallback(
    (
      sheet: string,
      op: 'insertRows' | 'deleteRows' | 'insertCols' | 'deleteCols',
      at: number,
      count: number,
    ) => {
      const store = nameServices.services.ranges;
      // Structural shifts mutate the in-memory defs synchronously; the
      // encrypted writes complete in the background.
      switch (op) {
        case 'insertRows':
          void store.applyInsertRows(sheet, at, count);
          break;
        case 'deleteRows':
          void store.applyDeleteRows(sheet, at, count);
          break;
        case 'insertCols':
          void store.applyInsertCols(sheet, at, count);
          break;
        case 'deleteCols':
          void store.applyDeleteCols(sheet, at, count);
          break;
      }
      nameServices.changed();
    },
    [nameServices],
  );

  /** Apply one op to the engine (remote replay / conflict resolution). */
  const applyOpToEngine = useCallback(
    (op: Op) => {
      const p = op.payload;
      const sheet = typeof p['sheet'] === 'string' ? p['sheet'] : activeSheet;
      const row = typeof p['row'] === 'number' ? p['row'] : 0;
      const col = typeof p['col'] === 'number' ? p['col'] : 0;
      const ref = cellRef(sheet, row, col);
      switch (op.kind) {
        case 'setCell':
          host.execute({ cmd: 'setCell', ref, value: (p['value'] ?? null) as never });
          break;
        case 'setFormula':
          host.execute({ cmd: 'setFormula', ref, formula: String(p['formula'] ?? '') });
          break;
        case 'clearCell':
          host.execute({ cmd: 'setCell', ref, value: null });
          break;
        case 'insertRow': {
          const at = Number(p['at'] ?? 0);
          const count = Number(p['count'] ?? 1);
          insertRows(host, sheet, at, count);
          shiftNamesForStructure(sheet, 'insertRows', at, count);
          break;
        }
        case 'deleteRow': {
          const at = Number(p['at'] ?? 0);
          const count = Number(p['count'] ?? 1);
          deleteRows(host, sheet, at, count);
          shiftNamesForStructure(sheet, 'deleteRows', at, count);
          break;
        }
        case 'insertCol': {
          const at = Number(p['at'] ?? 0);
          const count = Number(p['count'] ?? 1);
          insertCols(host, sheet, at, count);
          shiftNamesForStructure(sheet, 'insertCols', at, count);
          break;
        }
        case 'deleteCol': {
          const at = Number(p['at'] ?? 0);
          const count = Number(p['count'] ?? 1);
          deleteCols(host, sheet, at, count);
          shiftNamesForStructure(sheet, 'deleteCols', at, count);
          break;
        }
        case 'addSheet':
          host.execute({ cmd: 'addSheet', name: String(p['name'] ?? 'Sheet') });
          break;
        case 'deleteSheet': {
          const name = String(p['name'] ?? '');
          if (name !== '') {
            // No undo capture here: the originating tab captured it; replay
            // only needs store coherence (refs on the sheet go dangling).
            host.execute({ cmd: 'deleteSheet', name });
            void nameServices.services.ranges.deleteSheetRefs(name);
            nameServices.changed();
          }
          break;
        }
        case 'renameSheet': {
          const from = String(p['from'] ?? p['name'] ?? '');
          const to = String(p['to'] ?? p['newName'] ?? '');
          if (from !== '' && to !== '') {
            host.execute({ cmd: 'renameSheet', name: from, newName: to });
            void nameServices.services.ranges.renameSheet(from, to);
            nameServices.changed();
          }
          break;
        }
        case 'duplicateSheet': {
          const name = String(p['name'] ?? '');
          if (name !== '') {
            const res = host.execute({
              cmd: 'duplicateSheet',
              name,
              ...(typeof p['newName'] === 'string' ? { newName: p['newName'] } : {}),
            });
            if (!res.ok) setLastError(res.error);
          }
          break;
        }
        case 'moveSheet': {
          const name = String(p['name'] ?? '');
          if (name !== '') {
            const res = host.execute({ cmd: 'moveSheet', name, toIndex: Number(p['toIndex'] ?? 0) });
            if (!res.ok) setLastError(res.error);
          }
          break;
        }
        default:
          break;
      }
      setTick((t) => t + 1);
    },
    [host, activeSheet, shiftNamesForStructure, nameServices, setLastError],
  );

  /** Ingest another tab's op log: replay clean ops, hold conflicts for review. */
  const processRemoteLog = useCallback(
    (raw: string) => {
      const remote = OpLog.deserialize(raw);
      const incoming = remote
        .all()
        .filter((o) => o.payload['tab'] !== tabId && !appliedKeysRef.current.has(opKey(o)));
      if (incoming.length === 0) return;
      const mine = oplog.since(lastSyncSeqRef.current).filter((o) => o.payload['tab'] === tabId);
      const found = detectConflicts(mine, incoming, 0);
      const conflictedKeys = new Set(found.map((c) => opKey(c.remote)));
      setConflicts((prev) => {
        const seen = new Set(prev.map((c) => opKey(c.remote)));
        const next = [...prev];
        for (const c of found) {
          if (!seen.has(opKey(c.remote))) next.push(c);
        }
        return next;
      });
      for (const op of incoming) {
        if (conflictedKeys.has(opKey(op))) continue; // held for manual resolution
        applyOpToEngine(op);
        appliedKeysRef.current.add(opKey(op));
      }
    },
    [oplog, tabId, applyOpToEngine],
  );

  /** Mark the queue flushed (called on reconnect and by "Sync now"). */
  const handleSyncNow = useCallback(() => {
    lastSyncSeqRef.current = oplog.lastSeq();
    setPendingOps(0);
  }, [oplog]);

  /** Resolve one cell conflict: keep mine / keep theirs / keep both. */
  const handleResolveConflict = useCallback(
    (conflict: OpConflict, choice: ConflictChoice) => {
      const rKey = opKey(conflict.remote);
      if (choice === 'theirs' || choice === 'both') {
        applyOpToEngine(conflict.remote);
        if (choice === 'both') {
          // Keep my value in the cell; preserve theirs as a cell comment.
          applyOpToEngine(conflict.local);
          const p = conflict.local.payload;
          const sheet = String(p['sheet'] ?? activeSheet);
          const row = Number(p['row'] ?? 0);
          const col = Number(p['col'] ?? 0);
          const theirValue =
            conflict.remote.kind === 'setFormula'
              ? String(conflict.remote.payload['formula'] ?? '')
              : JSON.stringify(conflict.remote.payload['value'] ?? null);
          setComments((prev) =>
            setComment(prev, sheet, row, col, `Peer value kept: ${theirValue}`),
          );
        }
      }
      appliedKeysRef.current.add(rKey);
      setConflicts((prev) => prev.filter((c) => opKey(c.remote) !== rKey));
      setLastError(null);
    },
    [applyOpToEngine, activeSheet],
  );

  // Cross-tab op sync via storage events + online/offline tracking.
  useEffect(() => {
    try {
      const tabs = readTabs();
      if (!tabs.includes(tabId)) {
        localStorage.setItem(OPLOG_TABS_KEY, JSON.stringify([...tabs, tabId]));
      }
      // Replay ops written by other tabs before we mounted.
      for (const t of tabs) {
        if (t === tabId) continue;
        const raw = localStorage.getItem(OPLOG_KEY_PREFIX + t);
        if (raw) processRemoteLog(raw);
      }
    } catch { /* storage unavailable */ }
    const onStorage = (e: StorageEvent) => {
      if (e.key && e.key.startsWith(OPLOG_KEY_PREFIX) && e.key !== OPLOG_KEY_PREFIX + tabId && e.newValue) {
        processRemoteLog(e.newValue);
      }
    };
    const onOnline = () => {
      setOnline(true);
      handleSyncNow();
    };
    const onOffline = () => setOnline(false);
    window.addEventListener('storage', onStorage);
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    return () => {
      window.removeEventListener('storage', onStorage);
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
    };
  }, [tabId, processRemoteLog, handleSyncNow]);

  const commitCell = useCallback(
    (row: number, col: number, text: string) => {
      // Cycle 10 (user's rule: mutation is gated): edits are rejected
      // while the workbook is loading — in gateway mode the server is
      // mid-open and reads/edits would hit a stale model; same on desktop.
      if (!workbookLoadedRef.current) {
        setLastError('Workbook is still loading — editing is disabled until the load completes.');
        return;
      }
      // Idle-rule gate (same family): a released session is evicted
      // server-side — edits are rejected until a checksum-verified
      // reconnect rehydrates it.
      if (sessionDisconnectedRef.current) {
        setLastError('Disconnected (idle) — reconnect to resume editing.');
        return;
      }
      // Sheet protection gate (track 19): locked cells reject edits.
      if (!protection.isCellEditable(activeSheet, row, col)) {
        setLastError(
          `Cell ${a1Short(row, col)} is locked: unprotect "${activeSheet}" to edit it.`,
        );
        return;
      }
      // Data validation gate.
      const rule = findValidation(validations, activeSheet, row, col);
      if (rule && text.trim() !== '' && !validateEdit(rule, text)) {
        setLastError(`Invalid value: must be one of ${rule.list.join(', ')}`);
        return;
      }
      // Cycle 10 Phase 3: gateway/desktop hosts return a PROMISE from
      // execute() (routed async pipeline / IPC) — the typed value is
      // already displayed optimistically by the host; the result settles
      // here. Local hosts return synchronously. One settle path serves
      // both. A routed rejection has already rolled the cell back
      // visibly in the host; surfacing the error completes §7's
      // "rollback is visible, never silent".
      const settleEdit = (
        raw: { ok: boolean; error?: string } | Promise<{ ok: boolean; error?: string }>,
        onOk: () => void,
      ): void => {
        const settle = (res: { ok: boolean; error?: string }): void => {
          if (!res.ok) setLastError(res.error ?? 'Edit failed.');
          else {
            setLastError(null);
            onOk();
          }
        };
        if (raw instanceof Promise) {
          void raw.then(settle, (e: unknown) =>
            setLastError(e instanceof Error ? e.message : String(e)),
          );
        } else {
          settle(raw);
        }
      };
      // Smart-chip syntax: =CHIP("person","Ada Lovelace") inserts a rich chip
      // instead of a formula (track 15 extension).
      const chipParse = parseChipFormula(text);
      if (chipParse) {
        const chip = resolveSmartChip(chipParse.kind, chipParse.key);
        if (!chip) {
          setLastError(`Unknown ${chipParse.kind} chip: "${chipParse.key}".`);
          return;
        }
        const applyChip = (): void => {
          const chipRef = cellRef(activeSheet, row, col);
          const raw = host.execute({ cmd: 'setCell', ref: chipRef, value: chip.display });
          // D2: on async hosts `raw` is a Promise — reading `.ok` off it
          // (the old code) always read failure. settleEdit awaits it.
          settleEdit(raw as never, () => {
            setSmartChipCells((prev) => new Map(prev).set(smartChipCellKey(activeSheet, row, col), chip));
            logOp('setCell', { sheet: activeSheet, row, col, value: chip.display });
          });
          bumpUndo();
        };
        if (isAsyncHost(host)) {
          void undoRef.current
            .captureAsync(host, activeSheet, [{ row, col }], `Insert chip ${a1Short(row, col)}`)
            .then(applyChip, (e: unknown) =>
              setLastError(e instanceof Error ? e.message : String(e)),
            );
        } else {
          undoRef.current.capture(host, activeSheet, [{ row, col }], `Insert chip ${a1Short(row, col)}`);
          applyChip();
        }
        return;
      }
      const ref = cellRef(activeSheet, row, col);
      const parsed = parseEdit(text);
      // Formulas use real defined names now (design-docs §5: the engine
      // resolves name → stable ID at parse time via named expressions).
      // No text substitution — the NameManager's NamedRangeStore is the
      // source of truth, bound to the engine.
      const key = `${activeSheet}:${row}:${col}`;
      const dispatchEdit = (): void => {
      if (parsed.kind === 'formula') {
        const formula = parsed.formula;
        setFormulaTexts((prev) => new Map(prev).set(key, formula));
        // Collaboration (track 10): the edit goes through the OT pipeline
        // (transform + revision log) before reaching the engine host.
        const bridge = collabRef.current;
        const raw = bridge
          ? bridge.applySetFormula(ref, formula)
          : host.execute({ cmd: 'setFormula', ref, formula });
        settleEdit(raw as never, () => {
          logOp('setFormula', { sheet: activeSheet, row, col, formula });
          recordAction({ kind: 'setFormula', ref: { sheet: activeSheet, row, col }, formula });
        });
      } else {
        setFormulaTexts((prev) => {
          const next = new Map(prev);
          next.delete(key);
          return next;
        });
        const bridge = collabRef.current;
        const raw = bridge
          ? bridge.applySetCell(ref, parsed.value)
          : host.execute({ cmd: 'setCell', ref, value: parsed.value });
        settleEdit(raw as never, () => {
          logOp('setCell', { sheet: activeSheet, row, col, value: parsed.value });
          recordAction({ kind: 'setCell', ref: { sheet: activeSheet, row, col }, value: parsed.value });
        });
      }
      bumpUndo();
      // Any committed edit dirties the workbook for auto-save.
      if (!readOnly) {
        dirtyEpochRef.current++;
        setSaveState('dirty');
      }
      };
      // Record undo BEFORE mutating (D2): on async hosts (gateway /
      // desktop IPC) the before-state must be awaited through the host's
      // authoritative async read — a synchronous capture reads the
      // read-through cache, which can hold only the EMPTY placeholder
      // for an uncached cell — and the edit must not dispatch until the
      // capture lands, or the entry records the post-edit value. Local
      // hosts keep the exact synchronous path.
      if (isAsyncHost(host)) {
        void undoRef.current
          .captureAsync(host, activeSheet, [{ row, col }], `Edit ${a1Short(row, col)}`)
          .then(dispatchEdit, (e: unknown) =>
            setLastError(e instanceof Error ? e.message : String(e)),
          );
      } else {
        undoRef.current.capture(host, activeSheet, [{ row, col }], `Edit ${a1Short(row, col)}`);
        dispatchEdit();
      }
    },
    [host, activeSheet, validations, bumpUndo, logOp, readOnly],
  );

  const handleUndo = useCallback(() => {
    void (async () => {
      // Async-aware undo (D2): on gateway/desktop hosts execute() returns
      // a Promise and view reads are cache placeholders, so the sync
      // undo() misread both (always "Nothing to undo.", redo captured a
      // phantom empty state). undoAsync awaits the real reads + results.
      // The restore goes through host.execute — on the gateway host that
      // IS the routed-edit path, keeping the server as source of truth
      // (HYBRID-CONSISTENCY: undo is itself a routed edit).
      if (await undoRef.current.undoAsync(host)) {
        setLastError(null);
      } else {
        setLastError('Nothing to undo.');
      }
      bumpUndo();
    })();
  }, [host, bumpUndo]);

  const handleRedo = useCallback(() => {
    void (async () => {
      // Async-aware redo (D2): see handleUndo.
      if (await undoRef.current.redoAsync(host)) {
        setLastError(null);
      } else {
        setLastError('Nothing to redo.');
      }
      bumpUndo();
    })();
  }, [host, bumpUndo]);

  // Keep the engine's parallel worker factory + options in sync.
  useEffect(() => {
    try {
      host.setWorkerBackendFactory(webWorkerBackendFactory());
    } catch {
      // Host does not support worker factories (e.g. remote): parallel
      // recalculation stays unavailable; serial path is unaffected.
    }
    // The gateway engine service configures its own parallel pool at
    // startup (ONE FLAG rule); the browser must not push its options to
    // the remote host — and RemoteEngineHost.execute() is async anyway.
    if (host instanceof RemoteEngineHost) return;
    const res = host.execute({ cmd: 'setParallelRecalcOptions', options: parallelOpts });
    if (!res.ok) setLastError(res.error);
  }, [host, parallelOpts]);

  const handleRecalculate = useCallback(async () => {
    const useParallel =
      parallelOpts.enabled && workersAvailable && !(host instanceof RemoteEngineHost);
    if (useParallel) {
      const res = await host.executeAsync({ cmd: 'recalculateParallel' });
      if (res.ok && 'stats' in res) {
        setLastParallelStats(res.stats);
        recordAction({ kind: 'recalculate' });
        setLastError(null);
      } else {
        setLastError(res.ok ? null : (res as { error: string }).error);
      }
      return;
    }
    const raw = host.execute({ cmd: 'recalculate' });
    if (raw instanceof Promise) {
      void raw.then(
        (res) => {
          if (res.ok) recordAction({ kind: 'recalculate' });
          setLastError(res.ok ? null : res.error);
        },
        (e: unknown) => setLastError(e instanceof Error ? e.message : String(e)),
      );
      return;
    }
    if (raw.ok) recordAction({ kind: 'recalculate' });
    setLastError(raw.ok ? null : raw.error);
  }, [host, parallelOpts, workersAvailable]);

  const handleToggleMode = useCallback(() => {
    const mode: CalculationMode = calcMode === 'automatic' ? 'manual' : 'automatic';
    const res = host.execute({ cmd: 'setCalculationMode', mode });
    if (res.ok) {
      setCalcMode(mode);
      setLastError(null);
    } else {
      setLastError(res.error);
    }
  }, [host, calcMode]);

  const handleAddSheet = useCallback(
    (name: string) => {
      const res = host.execute({ cmd: 'addSheet', name });
      if (res.ok) {
        recordAction({ kind: 'addSheet', name });
        setHiddenSheets((prev) => {
          const next = new Set(prev);
          next.delete(name);
          return next;
        });
        setSheet(name);
        setSel({ row: 0, col: 0 });
      setGridSel(cellSelection(0, 0));
        setLastError(null);
      } else {
        setLastError(res.error);
      }
    },
    [host],
  );

  const handleDeleteSheet = useCallback(
    (name: string) => {
      if (visibleSheets.length <= 1) {
        setLastError('Cannot delete the only visible sheet.');
        return;
      }
      const res = host.execute({ cmd: 'deleteSheet', name });
      if (!res.ok) {
        setLastError(res.error);
        return;
      }
      // Named ranges pointing at the sheet go dangling (#REF!).
      void nameServices.services.ranges.deleteSheetRefs(name);
      nameServices.changed();
      logOp('deleteSheet', { name });
      setHiddenSheets((prev) => {
        const next = new Set(prev);
        next.delete(name);
        return next;
      });
      if (sheet === name) {
        const next = visibleSheets.find((n) => n !== name) ?? 'Sheet1';
        setSheet(next);
        setSel({ row: 0, col: 0 });
      setGridSel(cellSelection(0, 0));
      }
      setLastError(null);
    },
    [visibleSheets, sheet, host, nameServices, logOp],
  );

  /** Rename the active sheet through the engine protocol (real rename). */
  const handleRenameSheet = useCallback(
    (newName: string) => {
      const res = host.execute({ cmd: 'renameSheet', name: activeSheet, newName });
      if (!res.ok) {
        setLastError(res.error);
        return;
      }
      const clean = newName.trim();
      // Keep tracked named ranges coherent with the new sheet name.
      void nameServices.services.ranges.renameSheet(activeSheet, clean);
      nameServices.changed();
      logOp('renameSheet', { from: activeSheet, to: clean });
      // Migrate the per-sheet page-setup stash keys (GAP-9) so the renamed
      // sheet's print settings survive the next save.
      {
        const ps = pageSetupBySheetRef.current[activeSheet];
        if (ps !== undefined) {
          const next = { ...pageSetupBySheetRef.current };
          delete next[activeSheet];
          next[clean] = ps;
          pageSetupBySheetRef.current = next;
        }
        const pt = printTitlesBySheetRef.current[activeSheet];
        if (pt !== undefined) {
          const next = { ...printTitlesBySheetRef.current };
          delete next[activeSheet];
          next[clean] = pt;
          printTitlesBySheetRef.current = next;
        }
      }
      setSheet(clean);
      setSel({ row: 0, col: 0 });
      setGridSel(cellSelection(0, 0));
      setLastError(null);
    },
    [host, activeSheet, nameServices, logOp],
  );

  /**
   * Move or Copy Sheet… (Home > Cells > Format, and the sheet-tab menu):
   * real protocol ops — moveSheet reorders tabs (formulas survive via the
   * rebuild), duplicateSheet copies values + formulas.
   */
  const handleMoveCopySheet = useCallback(
    (from: string, toIndex: number | null, createCopy: boolean) => {
      if (createCopy) {
        const res = host.execute({ cmd: 'duplicateSheet', name: from });
        if (!res.ok) {
          setLastError(res.error);
          return;
        }
        const newName = (res.data as { name: string }).name;
        logOp('duplicateSheet', { name: from, newName });
        if (toIndex !== null) {
          const mv = host.execute({ cmd: 'moveSheet', name: newName, toIndex });
          if (!mv.ok) {
            setLastError(mv.error);
            return;
          }
          logOp('moveSheet', { name: newName, toIndex });
        }
        setSheet(newName);
        setSel({ row: 0, col: 0 });
      setGridSel(cellSelection(0, 0));
      } else {
        const res = host.execute({ cmd: 'moveSheet', name: from, toIndex: toIndex ?? sheetNames.length });
        if (!res.ok) {
          setLastError(res.error);
          return;
        }
        logOp('moveSheet', { name: from, toIndex: toIndex ?? sheetNames.length });
      }
      setLastError(null);
    },
    [host, logOp, sheetNames.length],
  );

  const handleNew = useCallback(() => {
    // Gateway mode: the workbook lives in the engine service; reset it
    // there (spec c). Local mode: swap in a fresh local workbook.
    if (host instanceof RemoteEngineHost) {
      const remote = host;
      void (async () => {
        try {
          setWorkbookLoaded(false);
          // Phase 2 (F6): claim-then-reset. A New workbook is a NEW
          // file — mint its fresh fileId + session through the gateway
          // open handshake FIRST and point the share link at it, then
          // reset on the CLAIMED session (resetRemoteAsync prefers the
          // collab direct reset whenever a handshake session is opened).
          // Resetting first via the legacy transport would mint a fresh
          // anonymous session and reset that instead, stranding the new
          // file's claim (the one-process/one-live-session rule 409s it).
          const transport = collabTransportRef.current;
          if (transport) {
            const prevFileId = collabFileIdRef.current;
            let releasedPrev = false;
            // Releasing mirrors the open-file switch rule: if this tab
            // CREATED the current session, release it first; if this tab
            // merely JOINED it, just disconnect locally — a joiner never
            // tears down a session it does not own.
            if (transport.sessionId && prevFileId) {
              if (transport.wasJoined === false) {
                await transport.releaseOpenedSession('superseded-by-new-workbook').catch(() => false);
              } else {
                transport.disconnect();
              }
              setCollabFile(null);
              releasedPrev = true;
            }
            try {
              const opened = await transport.connect();
              setCollabFile(opened.fileId);
            } catch (e) {
              if (releasedPrev && prevFileId) {
                // Abort-on-mint-failure with a previous session mirrors
                // openRemoteBuffer's narrowed rule: restore the previous
                // session by id and abort — never reset into it. The
                // outer catch surfaces the error and re-enables the UI
                // with the current workbook unchanged.
                try {
                  const rejoined = await transport.connect(prevFileId);
                  setCollabFile(rejoined.fileId);
                } catch {
                  /* previous file stays checkpointed server-side */
                }
                throw new Error('Could not open a session for the new workbook — the current workbook is unchanged.');
              }
              // No-previous-session failure keeps the Phase 1
              // warn-and-continue posture.
              console.warn('[collab] open handshake for new workbook failed:', e);
            }
          }
          await remote.resetRemoteAsync(); // lands on the CLAIMED session via the host's collab preference; legacy reset only when no handshake session exists
          notifyHostReplaced();
          setReadOnly(false);
          setSaveState('saved');
          pageSetupBySheetRef.current = {};
          printTitlesBySheetRef.current = {};
          externalLinksMetaRef.current = undefined;
          setPageSetup(DEFAULT_PAGE_SETUP);
          setPrintTitles(DEFAULT_PRINT_TITLES);
          setWorkbookLoaded(true);
        } catch (e) {
          setWorkbookLoaded(true);
          setLastError(e instanceof Error ? e.message : String(e));
        }
      })();
      return;
    }
    // Cycle 10 desktop: the workbook lives in the MAIN-process engine —
    // reset it there (engine:new); the renderer host object is the IPC
    // adapter and stays. The UI cleanup below mirrors the local path.
    if (host instanceof IpcEngineHost) {
      const ipc = host;
      void (async () => {
        try {
          setWorkbookLoaded(false);
          await ipc.newIpc();
          notifyHostReplaced();
          setReadOnly(false);
          setSaveState('saved');
          pageSetupBySheetRef.current = {};
          printTitlesBySheetRef.current = {};
          externalLinksMetaRef.current = undefined;
          setPageSetup(DEFAULT_PAGE_SETUP);
          setPrintTitles(DEFAULT_PRINT_TITLES);
          setWorkbookLoaded(true);
        } catch (e) {
          setWorkbookLoaded(true);
          setLastError(e instanceof Error ? e.message : String(e));
        }
      })();
      return;
    }
    replaceWiredHost(new EngineWorkbook());
    setReadOnly(false);
    setSaveState('saved');
    // A blank workbook has no page-setup settings to carry: clear the
    // per-sheet stash so a previously opened file's settings never leak
    // into the new file's save.
    pageSetupBySheetRef.current = {};
    printTitlesBySheetRef.current = {};
    externalLinksMetaRef.current = undefined;
    setPageSetup(DEFAULT_PAGE_SETUP);
    setPrintTitles(DEFAULT_PRINT_TITLES);
  }, [host, replaceWiredHost]);

  /**
   * Cells covered by the current selection, intersected with the sheet's
   * USED RANGE — the full data model, never just the rendered/virtualized
   * window: a selected row means every model cell in that row inside the
   * used range, including off-screen cells. Iteration is capped so a
   * select-all on a huge used range stays bounded.
   */
  const selectionCells = useCallback(
    (maxCells = 200_000): { row: number; col: number }[] => {
      // D-SEL-2: read through the live ref — Clear/Cut menu actions run
      // after a right-click re-point that postdates the menu build.
      const gs = gridSelRef.current;
      const used = host.getView().usedRange(activeSheet);
      if (!used) return [{ row: gs.anchorRow, col: gs.anchorCol }];
      const out: { row: number; col: number }[] = [];
      for (const rect of selectionRects(gs, MAX_ROWS - 1, MAX_COLS - 1)) {
        const sr = Math.max(rect.startRow, used.startRow);
        const er = Math.min(rect.endRow, used.endRow);
        const sc = Math.max(rect.startCol, used.startCol);
        const ec = Math.min(rect.endCol, used.endCol);
        for (let r = sr; r <= er; r++) {
          for (let c = sc; c <= ec; c++) {
            out.push({ row: r, col: c });
            if (out.length >= maxCells) return out;
          }
        }
      }
      return out;
    },
    [host, activeSheet],
  );

  /**
   * Delete-key / Clear Contents semantics (Excel): clear CONTENTS only —
   * value AND formula removed, cell left truly empty, dependents
   * recalculate; formats untouched; no structural row/column deletion.
   * Uniform path for EVERY shape including a single cell (addendum
   * 2026-10-21): host.execute setCell value:null — the handleClearAll
   * precedent — rather than commitCell(''), so formula removal is
   * guaranteed by construction. One undo capture for the whole batch.
   */
  const handleClearSelection = useCallback(() => {
    if (!workbookLoadedRef.current) {
      setLastError('Workbook is still loading — editing is disabled until the load completes.');
      return;
    }
    if (sessionDisconnectedRef.current) {
      setLastError('Disconnected (idle) — reconnect to resume editing.');
      return;
    }
    const cells = selectionCells();
    const editable = cells.filter(({ row, col }) => protection.isCellEditable(activeSheet, row, col));
    if (editable.length === 0) {
      if (cells.length > 0) {
        setLastError(`Selection is locked: unprotect "${activeSheet}" to edit it.`);
      }
      return;
    }
    undoRef.current.capture(host, activeSheet, editable.slice(0, 5000), 'clear-selection');
    for (const { row, col } of editable) {
      host.execute({ cmd: 'setCell', ref: cellRef(activeSheet, row, col), value: null } as never);
    }
    // Drop stale formula text for the cleared cells (display layer only).
    setFormulaTexts((prev) => {
      let next: Map<string, string> | null = null;
      for (const { row, col } of editable) {
        const key = `${activeSheet}:${row}:${col}`;
        if (prev.has(key)) {
          next ??= new Map(prev);
          next.delete(key);
        }
      }
      return next ?? prev;
    });
    bumpUndo();
    if (!readOnly) {
      dirtyEpochRef.current++;
      setSaveState('dirty');
    }
    setLastError(null);
  }, [host, activeSheet, selectionCells, protection, bumpUndo, readOnly]);

  /** Ribbon / context-menu Clear: operates on the current selection. */
  const handleClear = useCallback(() => {
    handleClearSelection();
  }, [handleClearSelection]);

  const handleInsertFunction = useCallback((skeleton: string) => {
    setInsertReq((prev) => ({ text: skeleton, nonce: (prev?.nonce ?? 0) + 1 }));
  }, []);

  // ---- Structure ops (insert/delete rows/cols, sort) ----
  const runSheetOp = useCallback(
    (label: string, fn: () => void) => {
      const used = host.getView().usedRange(activeSheet);
      const cells: { row: number; col: number }[] = [];
      if (used) {
        for (let r = used.startRow; r <= used.endRow + 1; r++) {
          for (let c = used.startCol; c <= used.endCol + 1; c++) {
            cells.push({ row: r, col: c });
          }
        }
      }
      // Structural ops shift tracked named ranges too — capture their
      // before-state so undo restores the defs (not just the cells).
      undoRef.current.capture(host, activeSheet, cells.slice(0, 5000), label, true);
      fn();
      setLastError(null);
      bumpUndo();
    },
    [host, activeSheet, bumpUndo],
  );


  const handleInsertRow = useCallback(() => {
    // D-SEL-2: live anchor — menu actions postdate the menu build.
    const { row } = selRef.current;
    runSheetOp(`Insert row at ${row + 1}`, () => {
      insertRows(host, activeSheet, row, 1);
      shiftNamesForStructure(activeSheet, 'insertRows', row, 1);
    });
    recordAction({ kind: 'insertRows', sheet: activeSheet, atRow: row, count: 1 });
  }, [runSheetOp, host, activeSheet, shiftNamesForStructure]);

  const handleInsertRowBelow = useCallback(() => {
    const { row } = selRef.current;
    runSheetOp(`Insert row at ${row + 2}`, () => {
      insertRows(host, activeSheet, row + 1, 1);
      shiftNamesForStructure(activeSheet, 'insertRows', row + 1, 1);
    });
    recordAction({ kind: 'insertRows', sheet: activeSheet, atRow: row + 1, count: 1 });
  }, [runSheetOp, host, activeSheet, shiftNamesForStructure]);

  const handleDeleteRow = useCallback(() => {
    const { row } = selRef.current;
    runSheetOp(`Delete row ${row + 1}`, () => {
      deleteRows(host, activeSheet, row, 1);
      shiftNamesForStructure(activeSheet, 'deleteRows', row, 1);
    });
    recordAction({ kind: 'deleteRows', sheet: activeSheet, atRow: row, count: 1 });
  }, [runSheetOp, host, activeSheet, shiftNamesForStructure]);

  const handleInsertCol = useCallback(() => {
    const { col } = selRef.current;
    runSheetOp(`Insert column`, () => {
      insertCols(host, activeSheet, col, 1);
      shiftNamesForStructure(activeSheet, 'insertCols', col, 1);
    });
    recordAction({ kind: 'insertColumns', sheet: activeSheet, atCol: col, count: 1 });
  }, [runSheetOp, host, activeSheet, shiftNamesForStructure]);

  const handleInsertColRight = useCallback(() => {
    const { col } = selRef.current;
    runSheetOp(`Insert column`, () => {
      insertCols(host, activeSheet, col + 1, 1);
      shiftNamesForStructure(activeSheet, 'insertCols', col + 1, 1);
    });
    recordAction({ kind: 'insertColumns', sheet: activeSheet, atCol: col + 1, count: 1 });
  }, [runSheetOp, host, activeSheet, shiftNamesForStructure]);

  /**
   * Header context-menu structural inserts (addendum 2026-10-21): the
   * row menu offers above/below, the column menu left/right. Count/at
   * come from insertTarget (features/selection.ts): clicking inside a
   * rows/cols selection inserts as many rows/columns as the selection
   * spans in total (above = at its minimum, below = at its maximum + 1);
   * otherwise one at the clicked header. Same engine-protocol path as
   * the ribbon handlers (runSheetOp + insertRows/insertCols +
   * shiftNamesForStructure), so references shift per Excel semantics.
   */
  const handleInsertRowsMenu = useCallback(
    (clickedRow: number, side: 'before' | 'after') => {
      // D-SEL-2: live selection — the menu was built before the re-point.
      const { at, count } = insertTarget(gridSelRef.current, 'rows', clickedRow, side);
      runSheetOp(`Insert ${count} row(s) ${side === 'before' ? 'above' : 'below'}`, () => {
        insertRows(host, activeSheet, at, count);
        shiftNamesForStructure(activeSheet, 'insertRows', at, count);
      });
      recordAction({ kind: 'insertRows', sheet: activeSheet, atRow: at, count });
    },
    [runSheetOp, host, activeSheet, shiftNamesForStructure],
  );

  const handleInsertColsMenu = useCallback(
    (clickedCol: number, side: 'before' | 'after') => {
      // D-SEL-2: live selection — the menu was built before the re-point.
      const { at, count } = insertTarget(gridSelRef.current, 'cols', clickedCol, side);
      runSheetOp(`Insert ${count} column(s) ${side === 'before' ? 'left' : 'right'}`, () => {
        insertCols(host, activeSheet, at, count);
        shiftNamesForStructure(activeSheet, 'insertCols', at, count);
      });
      recordAction({ kind: 'insertColumns', sheet: activeSheet, atCol: at, count });
    },
    [runSheetOp, host, activeSheet, shiftNamesForStructure],
  );

  const handleFilterByValue = useCallback(() => {
    // D-SEL-2: live anchor — menu actions postdate the menu build.
    const { row, col } = selRef.current;
    const v = host.getView().readCell(cellRef(activeSheet, row, col)).value;
    if (v != null) setFilters(new Map([[col, new Set([String(v)])]]));
  }, [host, activeSheet]);

  const handleDeleteCol = useCallback(() => {
    const { col } = selRef.current;
    runSheetOp(`Delete column`, () => {
      deleteCols(host, activeSheet, col, 1);
      shiftNamesForStructure(activeSheet, 'deleteCols', col, 1);
    });
    recordAction({ kind: 'deleteColumns', sheet: activeSheet, atCol: col, count: 1 });
  }, [runSheetOp, host, activeSheet, shiftNamesForStructure]);

  const handleSort = useCallback(
    (dir: SortDir) => {
      // D-SEL-2: live anchor — menu actions postdate the menu build.
      const { col } = selRef.current;
      runSheetOp(`Sort ${dir === 'asc' ? 'A→Z' : 'Z→A'}`, () =>
        sortByColumn(host, activeSheet, col, dir, true),
      );
      const used = host.getView().usedRange(activeSheet);
      if (used) {
        recordAction({
          kind: 'sortRange',
          range: used,
          keys: [{ col: col - used.startCol, ascending: dir === 'asc' }],
        });
      }
      setSortState({ col, dir });
    },
    [runSheetOp, host, activeSheet],
  );


  // ---- Filter ----
  const handleApplyFilter = useCallback(
    (col: number, selected: Set<string> | null) => {
      setFilters((prev) => {
        const next = new Map(prev);
        if (selected === null) next.delete(col);
        else next.set(col, selected);
        return next;
      });
      setFilterOpen(null);
    },
    [],
  );

  // ---- Freeze panes ----
  const handleFreeze = useCallback(() => {
    // Freeze rows above and columns left of the selection (Excel semantics).
    if (sel.row === 0 && sel.col === 0) {
      setLastError('Select a cell below/right of where to freeze.');
      return;
    }
    setFreeze({ row: sel.row, col: sel.col });
    setLastError(null);
  }, [sel]);

  const handleUnfreeze = useCallback(() => setFreeze(null), []);

  // ---- Merge ----
  const handleMerge = useCallback(() => {
    // Merge the selection with the cell below-right (2x1 default like Excel's merge of selection).
    // Here: merge selected cell with the one to its right if that is a simple 1x2.
    // D-SEL-2: live anchor — menu actions postdate the menu build.
    const { row, col } = selRef.current;
    const existing = findMerge(merges, activeSheet, row, col);
    if (existing) {
      setLastError('Cell is already merged. Unmerge first.');
      return;
    }
    // Default: merge sel with the cell to the right.
    const m = makeMerge({
      sheet: activeSheet,
      startRow: row,
      startCol: col,
      endRow: row,
      endCol: col + 1,
    });
    setMerges((prev) => [...prev, m]);
    setLastError(null);
  }, [merges, activeSheet]);

  // ---- Cell formatting (pure UI state, no engine involvement) ----
  /**
   * Defect D4: a format change is a workbook change. Before this, format
   * handlers only updated the FormatStore — the workbook was never marked
   * dirty, so a format-only session never autosaved (and a save after a
   * value edit dropped the formats, which the save path never read).
   * Every format mutation funnels through markFormatDirty().
   */
  const markFormatDirty = useCallback(() => {
    if (!readOnly) {
      dirtyEpochRef.current++;
      setSaveState('dirty');
    }
  }, [readOnly]);

  // Format undo (issue #21): the undo manager snapshots/restores the
  // format store around format actions through these hooks, exactly
  // like the named-range hooks. The store is immutable (every helper
  // returns a fresh store), so the live ref IS the snapshot; restores
  // swap the state and funnel through the same dirty marking as a
  // fresh format edit, so an undone format still autosaves.
  const formatsRef = useRef(formats);
  useEffect(() => {
    formatsRef.current = formats;
  }, [formats]);
  useEffect(() => {
    undoRef.current.setFormatsHooks({
      snapshotFormats: () => formatsRef.current,
      restoreFormats: (store) => {
        formatsRef.current = store;
        setFormats(store);
        markFormatDirty();
      },
    });
  }, [markFormatDirty]);

  /**
   * Apply a format update to the current selection. Selection-aware:
   * one setRangeFormat call per selection rect (range entries are O(1)
   * per rect — a whole row/column/select-all costs one entry per span,
   * never per-cell). A single-cell selection keeps the legacy setFormat
   * path byte-for-byte: a cell-level entry always wins the cascade, so a
   * format applied to one cell stays visible even over a stale range
   * entry (see features/formatting.ts getFormat precedence).
   */
  const handleFormat = useCallback(
    (update: Partial<CellFormat>) => {
      undoRef.current.captureFormatsOnly('Format cells');
      if (isSingleCell(gridSel)) {
        setFormats((prev) => setFormat(prev, activeSheet, sel.row, sel.col, update));
      } else {
        setFormats((prev) => {
          let next = prev;
          for (const rect of selectionRects(gridSel, MAX_ROWS - 1, MAX_COLS - 1)) {
            next = setRangeFormat(next, activeSheet, rect.startRow, rect.startCol, rect.endRow, rect.endCol, update);
          }
          return next;
        });
      }
      markFormatDirty();
      const bounds = selectionBounds(gridSel, MAX_ROWS - 1, MAX_COLS - 1);
      recordAction({
        kind: 'setCellFormat',
        range: { sheet: activeSheet, ...bounds },
        format: toAutomationFormat(update),
      });
    },
    [activeSheet, sel, gridSel, markFormatDirty],
  );

  /** Apply a named cell style preset to the current selection. */
  const handleCellStyle = useCallback(
    (name: string) => {
      const preset = CELL_STYLE_PRESETS[name];
      if (!preset) return;
      undoRef.current.captureFormatsOnly('Cell style');
      if (isSingleCell(gridSel)) {
        setFormats((prev) => setFormat(prev, activeSheet, sel.row, sel.col, preset));
      } else {
        setFormats((prev) => {
          let next = prev;
          for (const rect of selectionRects(gridSel, MAX_ROWS - 1, MAX_COLS - 1)) {
            next = setRangeFormat(next, activeSheet, rect.startRow, rect.startCol, rect.endRow, rect.endCol, preset);
          }
          return next;
        });
      }
      markFormatDirty();
    },
    [activeSheet, sel, gridSel, markFormatDirty],
  );

  /** Clear all formatting from the current selection (per rect for rich shapes). */
  const handleClearFormat = useCallback(() => {
    undoRef.current.captureFormatsOnly('Clear formatting');
    if (isSingleCell(gridSel)) {
      setFormats((prev) => clearFormat(prev, activeSheet, sel.row, sel.col));
    } else {
      setFormats((prev) => {
        let next = prev;
        for (const rect of selectionRects(gridSel, MAX_ROWS - 1, MAX_COLS - 1)) {
          next = clearRangeFormat(next, activeSheet, rect.startRow, rect.startCol, rect.endRow, rect.endCol);
        }
        return next;
      });
    }
    markFormatDirty();
  }, [activeSheet, sel, gridSel, markFormatDirty]);

  /** Get the current format of the selected cell (for ribbon control state). */
  const selectedFormat = getFormat(formats, activeSheet, sel.row, sel.col);

  /** Apply banded-row table styling to the used range. */
  const handleFormatAsTable = useCallback(() => {
    const used = host.getView().usedRange(activeSheet);
    if (!used) {
      setLastError('No data to format as a table.');
      return;
    }
    undoRef.current.captureFormatsOnly('Format as table');
    setFormats((prev) => {
      let next = prev;
      const headerBg = '#305496';
      const bandA = '#D9E1F2';
      const bandB = '#FFFFFF';
      for (let r = used.startRow; r <= used.endRow; r++) {
        for (let c = used.startCol; c <= used.endCol; c++) {
          const isHeader = r === used.startRow;
          next = setFormat(next, activeSheet, r, c, {
            fillColor: isHeader ? headerBg : r % 2 === 0 ? bandA : bandB,
            fontColor: isHeader ? '#FFFFFF' : undefined,
            bold: isHeader ? true : undefined,
            borders: {
              top: { style: 'thin', color: '#B4C6E7' },
              bottom: { style: 'thin', color: '#B4C6E7' },
              left: { style: 'thin', color: '#B4C6E7' },
              right: { style: 'thin', color: '#B4C6E7' },
            },
          });
        }
      }
      return next;
    });
    markFormatDirty();
    setLastError(null);
  }, [host, activeSheet, markFormatDirty]);

  /** Remove duplicate rows based on the selected column's values. */
  const handleRemoveDuplicates = useCallback(() => {
    const used = host.getView().usedRange(activeSheet);
    if (!used) {
      setLastError('No data to de-duplicate.');
      return;
    }
    const seen = new Set<string>();
    const dupRows: number[] = [];
    for (let r = used.startRow; r <= used.endRow; r++) {
      const cell = host.getView().readCell(cellRef(activeSheet, r, sel.col));
      const key = cell.value ? formatDisplay(cell.value) : '';
      if (seen.has(key)) dupRows.push(r);
      else seen.add(key);
    }
    if (dupRows.length === 0) {
      setLastError('No duplicate values found in the selected column.');
      return;
    }
    // Delete from bottom up so row indices stay valid. Structural like the
    // ribbon ops: capture names too (undo restores the defs) and shift
    // tracked named ranges after each deletion
    // (design-docs/named-ranges-and-named-functions.md §1).
    undoRef.current.capture(host, activeSheet, dupRows.map((row) => ({ row, col: sel.col })), 'remove-duplicates', true);
    for (const r of [...dupRows].sort((a, b) => b - a)) {
      const res = host.execute({ cmd: 'deleteRow', ref: cellRef(activeSheet, r, 0) } as never);
      if (res.ok) shiftNamesForStructure(activeSheet, 'deleteRows', r, 1);
    }
    setUndoTick((t) => t + 1);
    setLastError(`Removed ${dupRows.length} duplicate row(s).`);
  }, [host, activeSheet, sel.col, shiftNamesForStructure]);

  const handleNotImplemented = useCallback(
    (feature: string) => setLastError(`${feature} is not implemented yet.`),
    [],
  );

  /** Manual page breaks (design-docs/print-and-page-layout.md §2). */
  const handleInsertPageBreak = useCallback(() => {
    // Excel behavior: a row break above and a column break left of the
    // active cell (no-ops at row 0 / column 0).
    setPageBreaksBySheet((prev) => {
      const cur = prev[activeSheet] ?? { rows: [], cols: [] };
      let next = cur;
      if (sel.row > 0) next = insertRowBreak(next, sel.row - 1);
      if (sel.col > 0) next = insertColBreak(next, sel.col - 1);
      return next === cur ? prev : { ...prev, [activeSheet]: next };
    });
    announce('Page break inserted at the selection.');
  }, [activeSheet, sel]);
  const handleRemovePageBreak = useCallback(() => {
    setPageBreaksBySheet((prev) => {
      const cur = prev[activeSheet];
      if (!cur) return prev;
      const next = removeColBreak(removeRowBreak(cur, sel.row - 1), sel.col - 1);
      return { ...prev, [activeSheet]: next };
    });
    announce('Page break removed.');
  }, [activeSheet, sel]);
  const handleResetPageBreaks = useCallback(() => {
    setPageBreaksBySheet((prev) => ({ ...prev, [activeSheet]: resetPageBreaks() }));
    announce('All page breaks reset.');
  }, [activeSheet]);

  // ---- Excel Classic ribbon parity (100% coverage) ----
  /**
   * PivotChart dialog result (Insert > PivotChart): store the user-configured
   * spec (kind/title chosen in the dialog) with its pivot binding, so the
   * overlay re-derives series from the live pivot result. The dialog builds
   * its spec over a virtual "Pivot:<title>" sheet for the preview; that is
   * replaced here with the pivot's real source range — a virtual sheet name
   * would crash readers (and reload) with "Unknown sheet".
   */
  const handleInsertPivotChartSpec = useCallback(
    (spec: ChartSpec, pivotId: number) => {
      const p = pivots.find((x) => x.id === pivotId);
      if (!p || !p.result) return;
      const id = overlayId;
      setOverlayId((i) => i + 1);
      const valueIndex = spec.pivot?.valueIndex ?? 0;
      const bound: ChartSpec = {
        ...spec,
        id,
        range: { sheet: p.sourceSheet, ...p.sourceRange },
        pivot: { pivotId, valueIndex },
        title: spec.title || describePivotBinding(p.result, { pivotId, valueIndex }),
      };
      setCharts((prev) => {
        const next = [...prev, bound];
        persistCharts(next);
        return next;
      });
      setPivotTick((t) => t + 1);
    },
    [pivots, overlayId],
  );

  // ---- Ribbon deep-store handlers (RibbonParityContext) ----
  /** Persist one sheet's header/footer settings (Insert > Header & Footer). */
  const handleSaveHfSettings = useCallback((sheet: string, settings: HeaderFooterSettings) => {
    setHfSettings((prev) => ({ ...prev, [sheet]: settings }));
  }, []);
  /** Ink strokes for the active sheet (Draw tab). */
  const handleInkStrokesChange = useCallback(
    (strokes: InkStroke[]) => {
      setInkStrokesBySheet((prev) => ({ ...prev, [activeSheet]: strokes }));
    },
    [activeSheet],
  );
  /** Drawing canvases for the active sheet (Draw tab). */
  const handleDrawingCanvasesChange = useCallback(
    (canvases: DrawingCanvasSpec[]) => {
      setDrawingCanvasesBySheet((prev) => ({ ...prev, [activeSheet]: canvases }));
    },
    [activeSheet],
  );
  /** Ink-to-shape conversion result: append a real shape overlay. */
  const handleAddShape = useCallback(
    (shape: { kind: string; x: number; y: number; w: number; h: number; color: string }) => {
      const id = overlayId;
      setOverlayId((i) => i + 1);
      setShapes((prev) => [
        ...prev,
        {
          id,
          kind: shape.kind,
          x: shape.x,
          y: shape.y,
          w: shape.w,
          h: shape.h,
          color: shape.color,
          fillColor: 'none',
        },
      ]);
    },
    [overlayId],
  );

  const ribbonParity = useRibbonParity({
    host,
    protection,
    // Add-on capability grants bind to the OPEN gateway file's id
    // (case-11 fix): without this, ribbonParity falls back to
    // 'local-workbook' even while a catalog file is open, so add-on
    // grants/runs target a document that is not the one on screen.
    // Local mode has no collab file (null) and keeps the local id.
    documentId: collabFileId ?? undefined,
    sheet: activeSheet,
    sheets: visibleSheets,
    sel,
    setSel,
    onFormat: handleFormat,
    selectedFormat,
    onError: (msg) => setLastError(msg),
    commitCell,
    onOpenFnDialog: () => {
      setFnDialogCategory('All');
      setFnDialogOpen(true);
    },
    onInsertFunction: handleInsertFunction,
    onOpenFormatCells: () => setFormatCellsOpen(true),
    addPicture: (dataUrl, w, h, name) =>
      setPictures((prev) => [...prev, { id: Date.now() + Math.random(), x: 140, y: 140, w, h, dataUrl, name: name ?? 'Picture' }]),
    comments,
    setComments,
    nameServices,
    onOpenChart: (kind) => setChartDialog({ kind, range: { sheet: activeSheet, startRow: 0, startCol: 0, endRow: 9, endCol: 3 } }),
    zoom,
    setZoom,
    insertTextAtCursor: (text) => {
      // Insert at the active cell's edit position (append for simplicity).
      const cur = cellEditText(host.getView().readCell(cellRef(activeSheet, sel.row, sel.col)));
      commitCell(sel.row, sel.col, cur + text);
    },
    onInsertPageBreak: handleInsertPageBreak,
    onRemovePageBreak: handleRemovePageBreak,
    onResetPageBreaks: handleResetPageBreaks,
    workbookView,
    onSetWorkbookView: setWorkbookView,
    pictures,
    setPictures,
    merges,
    setMerges,
    charts,
    setCharts,
    formats,
    setFormats,
    onFormatStoreMutated: markFormatDirty,
    pageSetup,
    setPageSetup,
    printTitles,
    setPrintTitles,
    hfSettings,
    onSaveHfSettings: handleSaveHfSettings,
    theme: workbookTheme,
    onThemeChange: setWorkbookTheme,
    inkStrokes: inkStrokesBySheet[activeSheet] ?? [],
    onInkStrokesChange: handleInkStrokesChange,
    drawingCanvases: drawingCanvasesBySheet[activeSheet] ?? [],
    onDrawingCanvasesChange: handleDrawingCanvasesChange,
    onAddShape: handleAddShape,
    onCaptureNamesUndo: captureNamesUndo,
    onMoveCopySheet: handleMoveCopySheet,
    pivotChartSources: pivots
      .filter((p) => p.result)
      .map((p) => ({ id: p.id, title: p.title, result: p.result as PivotResult })),
    onInsertPivotChart: handleInsertPivotChartSpec,
  });

  /**
   * Page-break preview pages (View > Page Break Preview): paginated with
   * the deterministic service engine from the live grid geometry, so the
   * preview shows exactly what Download-as-PDF will produce.
   */
  const previewPages = useMemo<PaginatedPage[] | undefined>(() => {
    if (workbookView !== 'pageBreakPreview') return undefined;
    const used = host.getView().usedRange(activeSheet);
    if (!used) return undefined;
    return paginateSheet(
      {
        sheet: activeSheet,
        used,
        rowHeight: (r) => rowHeights.get(r) ?? 24,
        colWidth: (c) => colWidths.get(c) ?? 96,
      },
      toPrintPageSetup(pageSetup, printTitles),
      pageBreaksBySheet[activeSheet] ?? { rows: [], cols: [] },
    );
  }, [workbookView, host, activeSheet, rowHeights, colWidths, pageSetup, printTitles, pageBreaksBySheet]);

  // ---- Extended ribbon handlers ----

  /** Paste Special > Values: paste clipboard text with formulas stripped. */
  const handlePasteValues = useCallback(async () => {
    try {
      const text = await navigator.clipboard.readText();
      // D-SEL-2: live anchor — menu actions postdate the menu build.
      const anchor = selRef.current;
      commitCell(anchor.row, anchor.col, stripToValues(text));
    } catch {
      setLastError('Paste failed: clipboard access was denied by the browser.');
    }
  }, [commitCell]);

  /**
   * Clipboard TSV for the current selection: selection rects ∩ used range
   * (full data model — off-screen cells included), rows joined '\n',
   * cells '\t', multiple rects as blocks in rect order separated by '\n'.
   * A single-cell selection produces exactly the old single-cell text.
   */
  const selectionTsv = useCallback((): string => {
    // D-SEL-2: read through the live refs — menu Copy/Cut actions run
    // after a right-click re-point that postdates the menu build.
    const gs = gridSelRef.current;
    const anchor = selRef.current;
    if (isSingleCell(gs)) {
      const cell = host.getView().readCell(cellRef(activeSheet, anchor.row, anchor.col));
      return cellEditText(cell);
    }
    const used = host.getView().usedRange(activeSheet);
    if (!used) {
      const cell = host.getView().readCell(cellRef(activeSheet, anchor.row, anchor.col));
      return cellEditText(cell);
    }
    const blocks: string[] = [];
    for (const rect of selectionRects(gs, MAX_ROWS - 1, MAX_COLS - 1)) {
      const sr = Math.max(rect.startRow, used.startRow);
      const er = Math.min(rect.endRow, used.endRow);
      const sc = Math.max(rect.startCol, used.startCol);
      const ec = Math.min(rect.endCol, used.endCol);
      if (sr > er || sc > ec) continue;
      const lines: string[] = [];
      for (let r = sr; r <= er; r++) {
        const cells: string[] = [];
        for (let c = sc; c <= ec; c++) {
          cells.push(cellEditText(host.getView().readCell(cellRef(activeSheet, r, c))));
        }
        lines.push(cells.join('\t'));
      }
      blocks.push(lines.join('\n'));
    }
    return blocks.join('\n');
  }, [host, activeSheet]);

  /** Clipboard: cut/copy/paste the current selection (for context menus). */
  const handleCut = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(selectionTsv());
      handleClear();
    } catch {
      setLastError('Cut failed: clipboard access was denied by the browser.');
    }
  }, [selectionTsv, handleClear]);

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(selectionTsv());
    } catch {
      setLastError('Copy failed: clipboard access was denied by the browser.');
    }
  }, [selectionTsv]);

  const handlePaste = useCallback(async () => {
    try {
      const text = await navigator.clipboard.readText();
      const grid = parseTsvGrid(text);
      const is1x1 = grid.length <= 1 && (grid[0]?.length ?? 0) <= 1;
      // D-SEL-2: live anchor — menu actions postdate the menu build.
      const anchor = selRef.current;
      if (is1x1) {
        // Legacy path, unchanged.
        commitCell(anchor.row, anchor.col, firstCellText(text));
        return;
      }
      // Multi-cell paste: write the grid starting at the anchor, one
      // commitCell per cell (existing edit path — gates, validation,
      // undo capture per cell), skipping non-editable cells, capped.
      const PASTE_CAP = 5000;
      let written = 0;
      let truncated = false;
      for (let i = 0; i < grid.length && !truncated; i++) {
        for (let j = 0; j < grid[i].length; j++) {
          if (written >= PASTE_CAP) {
            truncated = true;
            break;
          }
          const r = anchor.row + i;
          const c = anchor.col + j;
          if (!protection.isCellEditable(activeSheet, r, c)) continue;
          commitCell(r, c, grid[i][j]);
          written++;
        }
      }
      if (truncated) {
        setLastError(`Paste truncated at ${PASTE_CAP} cells (clipboard grid is larger).`);
      }
    } catch {
      setLastError('Paste failed: clipboard access was denied by the browser.');
    }
  }, [commitCell, activeSheet, protection]);

  /** Format Painter: arm/disarm; next selection applies the source format. */
  const handleFormatPainter = useCallback(() => {
    setFormatPainter((prev) =>
      prev ? null : { sheet: activeSheet, row: sel.row, col: sel.col },
    );
  }, [activeSheet, sel]);

  /** Screen-reader announcement for a newly selected anchor cell (track 23). */
  const announceSelection = useCallback(
    (row: number, col: number) => {
      try {
        const v = formatDisplay(host.getView().readCell(cellRef(activeSheet, row, col)).value);
        announce(`${colLabel(col)}${row + 1}: ${v || 'empty'}`);
      } catch {
        announce(`${colLabel(col)}${row + 1}`);
      }
    },
    [activeSheet, host],
  );

  /**
   * Apply a rich grid selection: gridSel and the legacy anchor `sel` move
   * together (sel = the selection's anchor). View state + re-render only —
   * no host/engine calls beyond the anchor announcement read the legacy
   * path already performed, no network, no revision traffic.
   */
  const applyGridSelection = useCallback(
    (next: GridSelection) => {
      setGridSel(next);
      setSel({ row: next.anchorRow, col: next.anchorCol });
      announceSelection(next.anchorRow, next.anchorCol);
    },
    [announceSelection],
  );

  /**
   * Grid rich-selection entry point. Format Painter takes precedence the
   * same way it does for plain clicks: when armed, the source format is
   * applied at the clicked anchor, the painter disarms, and the selection
   * shape does NOT change (collapses to the anchor cell).
   */
  const handleGridSelectionChange = useCallback(
    (next: GridSelection) => {
      if (formatPainter) {
        const { anchorRow: row, anchorCol: col } = next;
        const src = getFormat(formats, formatPainter.sheet, formatPainter.row, formatPainter.col);
        if (src) {
          undoRef.current.captureFormatsOnly('Format painter');
          setFormats((prev) => setFormat(prev, activeSheet, row, col, { ...src }));
          markFormatDirty();
        }
        setFormatPainter(null);
        setGridSel(cellSelection(row, col));
        setSel({ row, col });
        return;
      }
      applyGridSelection(next);
    },
    [formatPainter, formats, activeSheet, markFormatDirty, applyGridSelection],
  );

  /** Intercept selection while Format Painter is armed. */
  const handleSelectWithPainter = useCallback(
    (row: number, col: number) => {
      if (formatPainter) {
        const src = getFormat(formats, formatPainter.sheet, formatPainter.row, formatPainter.col);
        if (src) {
          undoRef.current.captureFormatsOnly('Format painter');
          setFormats((prev) => setFormat(prev, activeSheet, row, col, { ...src }));
          markFormatDirty();
        }
        setFormatPainter(null);
        return;
      }
      setSel({ row, col });
      setGridSel(cellSelection(row, col));
      announceSelection(row, col);
    },
    [formatPainter, formats, activeSheet, markFormatDirty, announceSelection],
  );

  /** AutoSum: insert =FN(range) above/left of selection. */
  const handleAutoSum = useCallback(
    (fn: string) => {
      const used = host.getView().usedRange(activeSheet);
      const range = suggestAutosumRange(
        used ? { startRow: used.startRow, endRow: used.endRow, startCol: used.startCol, endCol: used.endCol } : null,
        sel.row,
        sel.col,
      );
      if (!range) {
        setLastError('AutoSum needs data above or to the left of the selection.');
        return;
      }
      commitCell(sel.row, sel.col, autosumFormula(fn, range));
    },
    [host, activeSheet, sel, commitCell],
  );

  /** Clear submenu. */
  const handleClearAll = useCallback(() => {
    undoRef.current.capture(host, activeSheet, [{ row: sel.row, col: sel.col }], 'clear-all');
    host.execute({ cmd: 'setCell', ref: cellRef(activeSheet, sel.row, sel.col), value: null } as never);
    setFormats((prev) => clearFormat(prev, activeSheet, sel.row, sel.col));
    markFormatDirty();
    setFormulaTexts((prev) => {
      const next = new Map(prev);
      next.delete(`${activeSheet}:${sel.row}:${sel.col}`);
      return next;
    });
    bumpUndo();
  }, [host, activeSheet, sel, bumpUndo, markFormatDirty]);

  /** Row height / column width. */
  const handleRowHeight = useCallback(
    (h: number) => setRowHeights((prev) => new Map(prev).set(sel.row, h)),
    [sel.row],
  );
  const handleColWidth = useCallback(
    (w: number) => setColWidths((prev) => new Map(prev).set(sel.col, w)),
    [sel.col],
  );

  /** Hide/Unhide rows/columns. */
  const handleHideRow = useCallback(() => {
    // D-SEL-2: live anchor — menu actions postdate the menu build.
    setHiddenRows((prev) => new Set(prev).add(selRef.current.row));
  }, []);
  const handleHideCol = useCallback(() => {
    setHiddenCols((prev) => new Set(prev).add(selRef.current.col));
  }, []);
  const handleUnhideRows = useCallback(() => setHiddenRows(new Set()), []);
  const handleUnhideCols = useCallback(() => setHiddenCols(new Set()), []);

  /** Freeze panes variants. */
  const handleFreezeTopRow = useCallback(() => setFreeze({ row: 1, col: 0 }), []);
  const handleFreezeFirstCol = useCallback(() => setFreeze({ row: 0, col: 1 }), []);

  /** Custom sort dialog. */
  const handleCustomSort = useCallback(
    (col: number, dir: 'asc' | 'desc') => {
      runSheetOp(`Sort ${dir === 'asc' ? 'A→Z' : 'Z→A'}`, () =>
        sortByColumn(host, activeSheet, col, dir, true),
      );
      setSortState({ col, dir });
      setSortDialogOpen(false);
    },
    [runSheetOp, host, activeSheet],
  );

  /** Text to Columns. */
  const handleTextToColumns = useCallback(() => {
    const used = host.getView().usedRange(activeSheet);
    if (!used) {
      setLastError('No data to split.');
      return;
    }
    const colVals = columnValues(host, activeSheet, sel.col);
    const sample = colVals.find((v) => v.trim() !== '') ?? '';
    const delim = detectDelimiter(sample);
    let splitCount = 0;
    undoRef.current.capture(
      host,
      activeSheet,
      colVals.map((_, i) => ({ row: used.startRow + i, col: sel.col })),
      'text-to-columns',
    );
    colVals.forEach((v, i) => {
      const parts = splitTextToColumns([v], delim)[0] ?? [];
      parts.forEach((p, j) => {
        commitCell(used.startRow + i, sel.col + j, p);
      });
      if (parts.length > 1) splitCount++;
    });
    bumpUndo();
    setLastError(splitCount > 0 ? `Split ${splitCount} cell(s) on "${delim === '\t' ? 'Tab' : delim}".` : 'No delimiters found.');
  }, [host, activeSheet, sel.col, commitCell, bumpUndo]);

  /** Group / Ungroup rows/columns. */
  const handleGroupRows = useCallback(() => {
    const used = host.getView().usedRange(activeSheet);
    if (!used) return;
    setGroups((prev) => makeGroup(prev, activeSheet, 'row', used.startRow, used.endRow));
  }, [host, activeSheet]);
  const handleGroupCols = useCallback(() => {
    const used = host.getView().usedRange(activeSheet);
    if (!used) return;
    setGroups((prev) => makeGroup(prev, activeSheet, 'col', used.startCol, used.endCol));
  }, [host, activeSheet]);
  const handleUngroupAll = useCallback(() => {
    setGroups((prev) => prev.filter((g) => g.sheet !== activeSheet));
  }, [activeSheet]);
  const handleToggleGroup = useCallback((id: number) => {
    setGroups((prev) => toggleGroup(prev, id));
  }, []);

  /** Effective hidden rows/cols = manual hides + collapsed groups. */
  const effectiveHiddenRows = useMemo(() => {
    const s = new Set(hiddenRows);
    const used = host.getView().usedRange(activeSheet);
    const endRow = used?.endRow ?? 1000;
    for (let r = 0; r <= endRow; r++) {
      if (isRowHiddenByGroup(groups, activeSheet, r)) s.add(r);
    }
    return s;
  }, [hiddenRows, groups, host, activeSheet]);
  const effectiveHiddenCols = useMemo(() => {
    const s = new Set(hiddenCols);
    const used = host.getView().usedRange(activeSheet);
    const endCol = used?.endCol ?? 100;
    for (let c = 0; c <= endCol; c++) {
      if (isColHiddenByGroup(groups, activeSheet, c)) s.add(c);
    }
    return s;
  }, [hiddenCols, groups, host, activeSheet]);

  /** Extract a numeric value from a TypedValue, or null. */
  const numVal = (v: unknown): number | null => {
    if (v && typeof v === 'object' && 'kind' in v && (v as { kind: unknown }).kind === 'number') {
      const n = (v as unknown as { value: unknown }).value;
      return typeof n === 'number' ? n : null;
    }
    return null;
  };

  /** Extended CF style resolver for the grid. */
  const extCfStyle = useCallback(
    (row: number, col: number): React.CSSProperties | null => {
      for (const rule of extCfRules) {
        if (rule.sheet !== activeSheet) continue;
        if (row < rule.startRow || row > rule.endRow || col < rule.startCol || col > rule.endCol) continue;
        if (rule.kind === 'dataBar') {
          const vals: number[] = [];
          for (let r = rule.startRow; r <= rule.endRow; r++) {
            vals.push(numVal(host.getView().readCell(cellRef(activeSheet, r, col)).value) ?? 0);
          }
          const num = numVal(host.getView().readCell(cellRef(activeSheet, row, col)).value) ?? 0;
          const min = Math.min(...vals, 0);
          const max = Math.max(...vals, 1);
          const w = dataBarWidth(num, min, max);
          return {
            background: `linear-gradient(to right, ${rule.color ?? '#638EC6'} ${w}%, transparent ${w}%)`,
          };
        }
        if (rule.kind === 'colorScale') {
          const vals: number[] = [];
          for (let r = rule.startRow; r <= rule.endRow; r++) {
            const n = numVal(host.getView().readCell(cellRef(activeSheet, r, col)).value);
            if (n !== null) vals.push(n);
          }
          if (vals.length === 0) continue;
          const cur = numVal(host.getView().readCell(cellRef(activeSheet, row, col)).value);
          if (cur === null) continue;
          return { backgroundColor: colorScaleColor(cur, Math.min(...vals), Math.max(...vals), rule.color ?? '#63BE7B', rule.color2 ?? '#F8696B') };
        }
        if (rule.kind === 'iconSet') {
          const vals: number[] = [];
          for (let r = rule.startRow; r <= rule.endRow; r++) {
            const n = numVal(host.getView().readCell(cellRef(activeSheet, r, col)).value);
            if (n !== null) vals.push(n);
          }
          if (vals.length === 0) continue;
          const cur = numVal(host.getView().readCell(cellRef(activeSheet, row, col)).value);
          if (cur === null) continue;
          const icon = iconFor(cur, Math.min(...vals), Math.max(...vals));
          // Icons render as text prefix via ::before is complex; use background tint + title.
          return icon === 'up'
            ? { backgroundColor: '#c6efce' }
            : icon === 'down'
              ? { backgroundColor: '#ffc7ce' }
              : { backgroundColor: '#ffeb9c' };
        }
        if (rule.kind === 'topN') {
          const vals: number[] = [];
          for (let r = rule.startRow; r <= rule.endRow; r++) {
            vals.push(numVal(host.getView().readCell(cellRef(activeSheet, r, col)).value) ?? NaN);
          }
          const matches = topNMatches(vals, rule);
          const idx = row - rule.startRow;
          if (matches[idx]) return { backgroundColor: '#ffc7ce', color: '#9c0006' };
        }
      }
      return null;
    },
    [extCfRules, activeSheet, host],
  );

  /** Add an extended CF rule on the selected cell. */
  const addExtCFRule = useCallback(
    (partial: Omit<ExtCFRule, 'id' | 'sheet' | 'startRow' | 'startCol' | 'endRow' | 'endCol'>) => {
      setExtCfRules((prev) => [
        ...prev,
        makeExtCFRule({
          ...partial,
          sheet: activeSheet,
          startRow: sel.row,
          startCol: sel.col,
          endRow: sel.row,
          endCol: sel.col,
        }),
      ]);
    },
    [activeSheet, sel],
  );

  /** Comments. */
  const handleSaveComment = useCallback(
    (text: string) => {
      setComments((prev) =>
        text.trim() === ''
          ? deleteComment(prev, activeSheet, sel.row, sel.col)
          : setComment(prev, activeSheet, sel.row, sel.col, text),
      );
      setCommentDialogOpen(false);
    },
    [activeSheet, sel],
  );

  /** Sheet protection (track 19). */
  const handleProtectSheet = useCallback(
    (password: string | undefined) => {
      protection.protectSheet(activeSheet, password, {}, { principal: 'user' });
      setProtectionTick((t) => t + 1);
    },
    [protection, activeSheet],
  );
  const handleUnprotectSheet = useCallback(
    (password: string | undefined): boolean => {
      const ok = protection.unprotectSheet(activeSheet, password, { principal: 'user' });
      if (ok) setProtectionTick((t) => t + 1);
      return ok;
    },
    [protection, activeSheet],
  );

  /** Formula language (track 22): switch the engine's locale; function
   * names in existing formulas re-render and new formulas parse in it. */
  const handleFormulaLangChange = useCallback(
    (locale: SupportedLocale) => {
      setFormulaLang(locale);
      // Persist into the per-user profile (platform-shell.md §4).
      setSettings((prev) => {
        const next = { ...prev, formulaLanguage: locale };
        saveSettings(next);
        return next;
      });
      if (host instanceof RemoteEngineHost) {
        // Gateway mode: the switch must reach the SERVER engine (the
        // local base-class call would set it on an empty stub workbook),
        // and the formula-text refresh must not snapshot + read per-cell
        // over the wire (the old path was 1.8M sync round-trips on P95).
        // Batched async range reads: one request per sheet.
        const remote = host;
        void (async () => {
          try {
            await remote.setFormulaLanguageAsync(locale);
            const next = new Map<string, string>();
            for (const name of remote.sheetNames()) {
              const used = await remote.usedRangeAsync(name);
              if (!used) continue;
              const r = await remote.readRangeAsync(used);
              r.formulas.forEach((rowFormulas, ri) => {
                rowFormulas.forEach((f, ci) => {
                  if (f !== null && f !== undefined) {
                    next.set(`${name}:${used.startRow + ri}:${used.startCol + ci}`, f);
                  }
                });
              });
            }
            setFormulaTexts(next);
            setLastError(null);
          } catch (e) {
            setLastError(e instanceof Error ? e.message : String(e));
          }
        })();
        return;
      }
      try {
        host.setFormulaLanguage(locale);
        // Refresh cached formula texts (show-formulas mode) so they render
        // in the new locale too.
        const next = new Map<string, string>();
        for (const s of host.snapshot().sheets) {
          for (const cell of s.cells) {
            const f = host.getView().readCell({ sheet: s.name, row: cell.ref.row, col: cell.ref.col }).formula;
            if (f !== undefined) next.set(`${s.name}:${cell.ref.row}:${cell.ref.col}`, f);
          }
        }
        setFormulaTexts(next);
        setLastError(null);
      } catch (e) {
        setLastError(e instanceof Error ? e.message : String(e));
      }
    },
    [host],
  );
  const handleDeleteComment = useCallback(() => {
    // D-SEL-2: live anchor — menu actions postdate the menu build.
    const { row, col } = selRef.current;
    setComments((prev) => deleteComment(prev, activeSheet, row, col));
    setCommentDialogOpen(false);
  }, [activeSheet]);

  /** Spelling check on the used range. */
  const handleSpelling = useCallback(() => {
    const used = host.getView().usedRange(activeSheet);
    if (!used) {
      setLastError('No data to spell-check.');
      return;
    }
    const issues: { row: number; col: number; word: string }[] = [];
    for (let r = used.startRow; r <= used.endRow && issues.length < 100; r++) {
      for (let c = used.startCol; c <= used.endCol && issues.length < 100; c++) {
        const v = host.getView().readCell(cellRef(activeSheet, r, c)).value;
        if (!v || v.kind !== 'string') continue;
        const sv = (v as unknown as { value: unknown }).value;
        if (typeof sv !== 'string') continue;
        for (const m of checkText(sv)) {
          if (!isCorrect(m.word)) issues.push({ row: r, col: c, word: m.word });
        }
      }
    }
    setSpellingIssues(issues);
    setSpellingOpen(true);
    if (issues.length === 0) setLastError('Spell check complete: no issues found.');
  }, [host, activeSheet]);

  /** Insert chart: open the chart dialog with the chosen kind pre-selected. */
  const handleInsertChart = useCallback(
    (kind: ChartKind) => {
      const used = host.getView().usedRange(activeSheet);
      const range: ChartRange = used
        ? {
            sheet: activeSheet,
            startRow: used.startRow,
            startCol: used.startCol,
            endRow: Math.min(used.endRow, used.startRow + 49),
            endCol: Math.min(used.endCol, used.startCol + 9),
          }
        : { sheet: activeSheet, startRow: 0, startCol: 0, endRow: 4, endCol: 2 };
      setEditingChart(null);
      setChartDialog({ kind, range });
    },
    [host, activeSheet],
  );

  /** Commit a new or edited chart spec to the metadata store. */
  const handleCreateChart = useCallback(
    (spec: ChartSpec) => {
      const id = spec.id || overlayId;
      if (!spec.id) setOverlayId((i) => i + 1);
      const full: ChartSpec = { ...spec, id };
      setCharts((prev) => {
        const next = prev.some((c) => c.id === id) ? prev.map((c) => (c.id === id ? full : c)) : [...prev, full];
        persistCharts(next);
        return next;
      });
      setChartDialog(null);
      setEditingChart(null);
    },
    [overlayId],
  );

  /**
   * PivotChart: insert a chart bound to a pivot table's live result
   * (packages/service pivotChart.ts). The spec carries a pivot binding
   * instead of a cell range; the overlay re-derives series from the pivot
   * result on every render, so Refresh keeps the chart in sync.
   */
  const handleInsertPivotChart = useCallback(
    (pivotId: number) => {
      const p = pivots.find((x) => x.id === pivotId);
      if (!p || !p.result) return;
      const id = overlayId;
      setOverlayId((i) => i + 1);
      const binding = { pivotId, valueIndex: 0 };
      const spec = makeChartSpec({
        id,
        kind: 'column-clustered',
        range: { sheet: p.sourceSheet, ...p.sourceRange },
        title: describePivotBinding(p.result, binding),
        pivot: binding,
        x: 160,
        y: 160,
        w: 520,
        h: 340,
      });
      setCharts((prev) => {
        const next = [...prev, spec];
        persistCharts(next);
        return next;
      });
      setPivotTick((t) => t + 1);
    },
    [pivots, overlayId],
  );

  /** Series source for pivot-bound chart overlays (null = pivot gone). */  const getPivotSeries = useCallback(
    (spec: ChartSpec): ChartSeries | null => {
      const b = spec.pivot;
      if (!b) return null;
      const p = pivots.find((x) => x.id === b.pivotId);
      return p && p.result ? pivotResultToSeries(p.result, b.valueIndex) : null;
    },
    [pivots],
  );

  const handleDeleteChart = useCallback((id: number) => {    setCharts((prev) => {
      const next = prev.filter((c) => c.id !== id);
      persistCharts(next);
      return next;
    });
  }, []);

  const handleMoveChart = useCallback(
    (id: number, x: number, y: number) => {
      setCharts((prev) => {
        // A manually moved chart becomes free-floating: drop its cell anchor
        // so the anchor doesn't override the dragged position on re-render.
        const next = prev.map((c) =>
          c.id === id ? { ...c, x: Math.max(0, x), y: Math.max(0, y), anchorCells: undefined } : c,
        );
        persistCharts(next);
        return next;
      });
    },
    [],
  );

  const handleResizeChart = useCallback((id: number, w: number, h: number) => {
    setCharts((prev) => {
      const next = prev.map((c) => (c.id === id ? { ...c, w, h, anchorCells: undefined } : c));
      persistCharts(next);
      return next;
    });
  }, []);

  // ---- Remaining tracks: power query, data types, form controls, 3D maps ----

  /** Load a Power Query result grid into the sheet at the current selection. */
  const handlePowerQueryLoad = useCallback(
    (grid: string[][]) => {
      if (grid.length === 0) return;
      const { row, col } = sel;
      grid.forEach((r, i) => {
        r.forEach((v, j) => {
          commitCell(row + i, col + j, v);
        });
      });
      announce(`Loaded ${grid.length} rows from Power Query`);
    },
    [sel, commitCell],
  );

  /** Load an ETL pipeline result grid into the sheet at the current selection. */
  const handleEtlLoad = useCallback(
    (grid: string[][], tableName: string) => {
      if (grid.length === 0) return;
      const { row, col } = sel;
      grid.forEach((r, i) => {
        r.forEach((v, j) => {
          commitCell(row + i, col + j, v);
        });
      });
      announce(`Loaded ${grid.length - 1} rows into "${tableName}" from ETL pipeline`);
    },
    [sel, commitCell],
  );

  /** Insert a linked data-type value at the current selection. */
  const handleInsertDataType = useCallback(
    (value: DataTypeValue) => {
      const key = dtCellKey(activeSheet, sel.row, sel.col);
      setDataTypeCells((prev) => new Map(prev).set(key, value));
      commitCell(sel.row, sel.col, value.display);
      announce(`Inserted ${value.kind} data type: ${value.display}`);
    },
    [activeSheet, sel, commitCell],
  );

  /** Insert a smart chip at the selection (dialog path). */
  const handleInsertSmartChip = useCallback(
    (value: SmartChipValue) => {
      commitCell(sel.row, sel.col, value.display);
      setSmartChipCells((prev) => new Map(prev).set(smartChipCellKey(activeSheet, sel.row, sel.col), value));
      announce(`Inserted ${value.kind} chip: ${value.display}`);
    },
    [activeSheet, sel, commitCell],
  );

  /** Read a cell's display text (for slicer/timeline column scans). */
  const readCellText = useCallback(
    (sheet: string, row: number, col: number): string => {
      try {
        return formatDisplay(host.getView().readCell(cellRef(sheet, row, col)).value);
      } catch {
        return '';
      }
    },
    [host],
  );

  /** Insert a slicer bound to the selected column (Insert > Filters). */
  const handleInsertSlicer = useCallback(() => {
    const col = sel.col;
    const field = readCellText(activeSheet, 0, col) || colLabel(col);
    const values = distinctColumnValues(col, 2000, (r, c) => readCellText(activeSheet, r, c));
    if (values.length === 0) {
      setLastError(`Slicer needs values: column ${colLabel(col)} is empty.`);
      return;
    }
    const id = Date.now();
    setSlicers((prev) => [...prev, { id, col, field, selected: [], pivotIds: [], x: 32 + prev.length * 48, y: 170, w: 220 }]);
    setSlicerValues((prev) => new Map(prev).set(id, values));
    setLastError(null);
  }, [sel.col, activeSheet, readCellText]);

  /** Open the sparkline dialog (Insert > Sparklines); the sparkline renders
   * in the selected cell. */
  const handleInsertSparkline = useCallback(() => {
    setSparklineDialogOpen(true);
  }, []);

  /** Confirm from the sparkline dialog: place the sparkline in the cell. */
  const handleConfirmSparkline = useCallback(
    (type: SparklineType, range: string) => {
      const id = sparklineId;
      setSparklineId(id + 1);
      setSparklines((prev) => [
        ...prev,
        { id, sheet: activeSheet, row: sel.row, col: sel.col, type, range },
      ]);
      setLastError(null);
    },
    [sparklineId, activeSheet, sel.row, sel.col],
  );

  /** Remove the sparkline in the selected cell, if any. */
  const handleRemoveSparkline = useCallback(() => {
    setSparklines((prev) => prev.filter((s) => !(s.sheet === activeSheet && s.row === sel.row && s.col === sel.col)));
  }, [activeSheet, sel.row, sel.col]);

  /** Sparklines keyed by cell for the grid renderer. */
  const sparklineCells = useMemo(() => {
    const m = new Map<string, SparklinePlacement>();
    for (const s of sparklines) {
      if (s.sheet === activeSheet) m.set(sparklineKey(s.sheet, s.row, s.col), s);
    }
    return m;
  }, [sparklines, activeSheet]);

  /** Insert a timeline bound to the selected date column (Insert > Filters). */
  const handleInsertTimeline = useCallback(() => {
    const col = sel.col;
    const field = readCellText(activeSheet, 0, col) || colLabel(col);
    const extent = timelineExtent(col, 2000, (r, c) => readCellText(activeSheet, r, c));
    if (!extent) {
      setLastError(`Timeline needs dates: column ${colLabel(col)} has no recognizable dates.`);
      return;
    }
    const id = Date.now();
    setTimelines((prev) => [
      ...prev,
      { id, col, field, start: extent.min, end: extent.max, granularity: 'months', x: 280 + prev.length * 48, y: 170, w: 300 },
    ]);
    setLastError(null);
  }, [sel.col, activeSheet, readCellText]);

  /** Change the workbook sensitivity label (audited by the store). */
  const handleSensitivityChange = useCallback(
    (label: SensitivityLabel) => {
      // setLabel is async (the encrypted write); the in-memory label updates
      // synchronously, so the tick follows the write.
      void sensitivity.setLabel(label, sessionPrincipal).then(() => {
        setSensitivityTick((t) => t + 1);
      });
      announce(`Sensitivity label set to ${label}.`);
    },
    [sensitivity, sessionPrincipal],
  );

  /** Insert a form control overlay bound to the selected cell. */
  const handleInsertFormControl = useCallback(
    (kind: FormControlKind) => {
      const def = FORM_CONTROL_KINDS.find((k) => k.id === kind);
      const id = overlayId;
      setOverlayId((n) => n + 1);
      setFormControls((prev) => [
        ...prev,
        {
          id,
          kind,
          label: def ? def.label : kind,
          x: 120 + prev.length * 24,
          y: 120 + prev.length * 24,
          w: kind === 'listbox' ? 140 : 120,
          h: 40,
          boundRow: sel.row,
          boundCol: sel.col,
          options: kind === 'dropdown' || kind === 'listbox' ? ['Option 1', 'Option 2', 'Option 3'] : [],
        },
      ]);
      announce(`Inserted ${kind} control bound to ${cellLabelOf(sel.row, sel.col)}`);
    },
    [overlayId, sel],
  );

  /** Read a bound cell's display text for form controls. */
  const formControlValue = useCallback(
    (row: number, col: number): string => {
      try {
        return formatDisplay(host.getView().readCell(cellRef(activeSheet, row, col)).value);
      } catch {
        return '';
      }
    },
    [host, activeSheet],
  );

  /** Read the used range as a header row plus data rows of display strings. */
  const readUsedRangeData = useCallback((): { headers: string[]; rows: string[][] } | null => {
    const view = host.getView();
    const usedRange = view.usedRange(activeSheet);
    if (!usedRange) return null;
    const headers: string[] = [];
    const rows: string[][] = [];
    for (let c = usedRange.startCol; c <= usedRange.endCol; c++) {
      headers.push(formatDisplay(view.readCell(cellRef(activeSheet, usedRange.startRow, c)).value));
    }
    for (let r = usedRange.startRow + 1; r <= usedRange.endRow; r++) {
      const row: string[] = [];
      for (let c = usedRange.startCol; c <= usedRange.endCol; c++) {
        row.push(formatDisplay(view.readCell(cellRef(activeSheet, r, c)).value));
      }
      rows.push(row);
    }
    return { headers, rows };
  }, [host, activeSheet]);

  /** Create a 3D globe from the used range. */
  const handleCreateGlobe = useCallback(
    (latCol: number, longCol: number, labelCol?: number, valueCol?: number) => {
      try {
        const data = readUsedRangeData();
        if (!data) {
          announce('Sheet is empty');
          return;
        }
        const points = pointsFromRows(data.headers, data.rows, latCol, longCol, labelCol, valueCol);
        if (points.length === 0) {
          announce('No valid latitude/longitude rows found');
          return;
        }
        const id = overlayId;
        setOverlayId((n) => n + 1);
        setGlobes((prev) => [...prev, { id, points, size: 320, x: 140, y: 100 }]);
        announce(`3D map created with ${points.length} points`);
      } catch {
        announce('Could not read data for 3D map');
      }
    },
    [readUsedRangeData, overlayId],
  );

  /** Create a 3D globe by geocoding a column of place names. */
  const handleCreateGlobeFromPlaces = useCallback(
    async (
      nameCol: number,
      valueCol: number | undefined,
      onProgress: (p: PlacesGeocodeProgress) => void,
    ): Promise<PlacesGeocodeOutcome> => {
      const svc = getGeocodeService();
      const liveId = svc.liveProviderId;
      const emptyOutcome = (): PlacesGeocodeOutcome => ({
        plotted: 0,
        total: 0,
        unknown: [],
        offline: svc.isOffline(),
        providerName: liveId === 'none' ? 'bundled sample table' : liveId,
      });
      try {
        const data = readUsedRangeData();
        const names = (data?.rows ?? [])
          .map((r) => (r[nameCol] ?? '').trim())
          .filter((s) => s !== '');
        if (names.length === 0) {
          announce(data ? 'No place names found in the selected column' : 'Sheet is empty');
          return emptyOutcome();
        }
        const values = new Map<string, number>();
        if (valueCol !== undefined && data) {
          for (const r of data.rows) {
            const key = normalizePlaceQuery(r[nameCol] ?? '');
            const v = Number(r[valueCol]);
            if (key && Number.isFinite(v)) values.set(key, v);
          }
        }
        const items = await geocodeBatch(svc, names, {
          onProgress: (done, total) => onProgress({ done, total }),
        });
        const points = geocodedToLatLong(items, values.size > 0 ? values : undefined);
        const unknown = items.filter((i) => !i.result).map((i) => i.query);
        const usedBundled = items.some((i) => i.result?.provenance === 'bundled');
        const offline = svc.isOffline() || (liveId !== 'none' && usedBundled);
        const outcome: PlacesGeocodeOutcome = {
          plotted: points.length,
          total: items.length,
          unknown,
          offline,
          providerName:
            liveId === 'none'
              ? 'bundled sample table'
              : offline
                ? 'bundled sample table (offline)'
                : liveId === 'nominatim'
                  ? 'OpenStreetMap Nominatim'
                  : liveId,
        };
        if (points.length === 0) {
          announce('No places could be geocoded');
          return outcome;
        }
        const id = overlayId;
        setOverlayId((n) => n + 1);
        setGlobes((prev) => [...prev, { id, points, size: 320, x: 140, y: 100, offline: outcome.offline }]);
        announce(`3D map created with ${points.length} places`);
        return outcome;
      } catch {
        announce('Could not geocode places for 3D map');
        return emptyOutcome();
      }
    },
    [readUsedRangeData, overlayId],
  );

  /** Collect all formulas in the workbook (for the external-links scanner). */  const collectFormulas = useCallback((): { sheet: string; cell: string; formula: string }[] => {
    const out: { sheet: string; cell: string; formula: string }[] = [];
    try {
      const view = host.getView();
      for (const sheet of sheetNames) {
        const used = view.usedRange(sheet);
        if (!used) continue;
        for (let r = used.startRow; r <= used.endRow; r++) {
          for (let c = used.startCol; c <= used.endCol; c++) {
            const ref = cellRef(sheet, r, c);
            const text = cellEditText(view.readCell(ref));
            if (text.startsWith('=')) out.push({ sheet, cell: a1Short(r, c), formula: text });
          }
        }
      }
    } catch {
      // ignore
    }
    return out;
  }, [host, sheetNames]);

  /** Header row of the used range (for the 3D Maps column picker). */
  const globeHeaders: string[] = useMemo(() => {
    try {
      const view = host.getView();
      const used = view.usedRange(activeSheet);
      if (!used) return [];
      const headers: string[] = [];
      for (let c = used.startCol; c <= used.endCol; c++) {
        const t = formatDisplay(view.readCell(cellRef(activeSheet, used.startRow, c)).value);
        headers.push(t === '' ? `Column ${colLabel(c)}` : t);
      }
      return headers;
    } catch {
      return [];
    }
  }, [host, activeSheet, tick]);

  /**
   * CellReader adapter over the typed computational view for the chart
   * component. The chart module only sees display text + numeric values.
   */
  const chartReader: CellReader = useCallback(
    (row: number, col: number) => {
      const v = host.getView().readCell(cellRef(activeSheet, row, col)).value;
      const text = v ? formatDisplay(v) : '';
      const t = text.trim();
      const num = t !== '' && !Number.isNaN(Number(t)) ? Number(t) : null;
      return { text, num };
    },
    [host, activeSheet],
  );

  /**
   * Sheet-pinned cell reader for chart overlays. Imported charts bind to the
   * sheet that owns their data (spec.range.sheet), which is not necessarily
   * the active sheet — reading the active sheet would show the wrong data.
   */
  const chartReaderForSheet = useCallback(
    (sheet: string): CellReader =>
      (row: number, col: number) => {
        const v = host.getView().readCell(cellRef(sheet, row, col)).value;
        const text = v ? formatDisplay(v) : '';
        const t = text.trim();
        const num = t !== '' && !Number.isNaN(Number(t)) ? Number(t) : null;
        return { text, num };
      },
    [host],
  );

  /**
   * Sheet-aware cell reader for imported charts: their per-series ranges
   * (spec.seriesRanges) may span sheets, so the overlay builds series via
   * extractSeriesFromRanges with this reader.
   */
  const chartCellAt = useCallback(
    (sheet: string, row: number, col: number) => {
      const v = host.getView().readCell(cellRef(sheet, row, col)).value;
      const text = v ? formatDisplay(v) : '';
      const t = text.trim();
      const num = t !== '' && !Number.isNaN(Number(t)) ? Number(t) : null;
      return { text, num };
    },
    [host],
  );

  /**
   * Resolve a chart spec to grid content coordinates for the overlay layer
   * inside the grid viewport. Charts imported from drawingML carry
   * anchorCells; their px position is derived live from the grid's own
   * cell-coordinate mapping so they scroll with the cells, sit below the
   * sticky headers' origin, and follow column/row resizes. Charts without
   * an anchor use their stored x/y/w/h as content coordinates.
   */
  const positionedChartSpec = useCallback(
    (ch: ChartSpec): ChartSpec => {
      const a = ch.anchorCells;
      if (!a) return ch;
      const x = gridContentX(a.fromCol, colWidths, effectiveHiddenCols, showHeadings);
      const y = gridContentY(a.fromRow, rowHeights, effectiveHiddenRows, showHeadings);
      const x2 = gridContentX(a.toCol, colWidths, effectiveHiddenCols, showHeadings);
      const y2 = gridContentY(a.toRow, rowHeights, effectiveHiddenRows, showHeadings);
      return { ...ch, x, y, w: Math.max(240, x2 - x), h: Math.max(180, y2 - y) };
    },
    [colWidths, rowHeights, effectiveHiddenCols, effectiveHiddenRows, showHeadings],
  );

  /**
   * Read the active sheet's used range through the typed view and build
   * plain JSON records for the pivot service component. The pivot module
   * itself never touches the engine — it only sees these records.
   */
  const readPivotSource = useCallback((): {
    headers: string[];
    records: Record<string, unknown>[];
    distinct: Record<string, string[]>;
    range: { startRow: number; startCol: number; endRow: number; endCol: number };
  } | null => {
    const view = host.getView();
    const used = view.usedRange(activeSheet);
    if (!used) return null;
    const range = {
      sheet: activeSheet,
      startRow: used.startRow,
      startCol: used.startCol,
      endRow: Math.min(used.endRow, used.startRow + 999),
      endCol: Math.min(used.endCol, used.startCol + 99),
    };
    const grid: unknown[][] = view
      .readRangeValues(range)
      .map((row) => row.map((v) => TypedView.toJson(v)));
    const toRecordValue = (v: unknown): unknown => {
      if (typeof v === 'object' && v !== null && 'error' in v) {
        return String((v as { error: string }).error);
      }
      return v;
    };
    // Drop trailing blank rows.
    while (grid.length > 0 && grid[grid.length - 1]?.every((v) => v === null)) grid.pop();
    if (grid.length < 2) return null;
    const headers = (grid[0] ?? []).map((h, i) =>
      h === null || h === undefined || h === '' ? `Column ${colLabel(range.startCol + i)}` : String(h),
    );
    const records = recordsFromGrid(headers, grid.slice(1)).map((rec) => {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(rec)) out[k] = toRecordValue(v);
      return out;
    });
    const distinct: Record<string, string[]> = {};
    for (const h of headers) {
      const seen = new Set<string>();
      for (const rec of records) {
        const v = rec[h];
        seen.add(v === null || v === undefined || v === '' ? '(blank)' : String(v));
      }
      distinct[h] = [...seen].sort();
    }
    return { headers, records, distinct, range };
  }, [host, activeSheet]);

  const handleInsertPivotTable = useCallback(() => {
    const src = readPivotSource();
    if (!src) {
      setLastError('PivotTable needs a table with a header row and at least one data row.');
      return;
    }
    setPivotBuilderOpen(true);
  }, [readPivotSource]);

  /**
   * No-code app builder: persist the new spec and open the running app.
   * W4: in gateway mode with a file open, the spec is stamped with the
   * file id and ALSO persisted server-side (builtAppsApi) — the
   * localStorage store is then only a cache. Local/desktop mode keeps
   * the previous local-only behavior exactly.
   */
  const handleCreateApp = useCallback(
    (spec: AppSpec) => {
      const fileId =
        builtAppsApi && !isDesktop() ? (collabFileIdRef.current ?? undefined) : undefined;
      const stamped: AppSpec = fileId ? { ...spec, fileId } : spec;
      appStore.add(stamped);
      setApps(appStore.all());
      setAppBuilderOpen(false);
      setRunningAppId(stamped.id);
      if (builtAppsApi && fileId) {
        void builtAppsApi.createApp(fileId, stamped).catch(() => {
          // Offline / server error: the local copy stands; the next
          // file-open sync re-uploads it (upload-on-open dedupe).
        });
      }
    },
    [builtAppsApi],
  );

  /** Persist spec mutations made by the running app (e.g. binding growth). */
  const handleAppSpecChange = useCallback(
    (next: AppSpec) => {
      appStore.saveAll(appStore.all().map((a) => (a.id === next.id ? next : a)));
      setApps(appStore.all());
      // W4: mirror the mutation to the server copy when this app is
      // bound to the currently open gateway file.
      const fileId = collabFileIdRef.current;
      if (builtAppsApi && !isDesktop() && fileId && next.fileId === fileId) {
        void builtAppsApi.updateApp(fileId, next).catch(() => {
          // Local copy stands; next sync reconciles (server wins for
          // ids it holds, so a failed update may be overwritten then —
          // the same posture as other cache-backed product stores).
        });
      }
    },
    [builtAppsApi],
  );

  // W4 built-app sync: once per (file, loaded) in gateway mode, fetch
  // the server list for the open file, upload local apps the server
  // lacks (migration of stranded localStorage apps, deduped), and
  // merge — server authoritative for ids it holds. Runs after the
  // workbook is loaded so the legacy sheet-match check sees real
  // sheet names. Failures leave the local cache untouched.
  const builtAppSyncKeyRef = useRef<string | null>(null);
  // Issue #37: a run's IN-FLIGHT state must live outside the effect
  // lifecycle. The previous shape consumed the key up front and FREED
  // it in cleanup whenever the run hadn't completed; sheetNames is a
  // fresh array on every render, so the effect re-ran constantly and
  // every render that landed while the listApps GET was in flight
  // freed the key and fired ANOTHER GET — a self-sustaining ~1/sec
  // request stream against the gateway's shared per-principal
  // rate-limit bucket (measured: 107 calls in ~110 s at localhost
  // latency). The bucket drained and unrelated calls (the add-on
  // refresh) began failing 429. Now: at most one run per key is ever
  // in flight, the key is consumed only when a run COMPLETES, and a
  // failed run backs off before the next invocation may retry it.
  const builtAppSyncInFlightRef = useRef<string | null>(null);
  const builtAppSyncRetryAfterRef = useRef<{ key: string; at: number } | null>(null);
  useEffect(() => {
    if (!builtAppsApi || !gwAuthed || isDesktop()) return;
    const fileId = collabFileId;
    if (!fileId || !workbookLoaded) return;
    const key = `${fileId}:${sheetNames.join('')}`;
    if (builtAppSyncKeyRef.current === key) return;
    if (builtAppSyncInFlightRef.current === key) return;
    const retryAfter = builtAppSyncRetryAfterRef.current;
    if (retryAfter && retryAfter.key === key && Date.now() - retryAfter.at < 5000) return;
    builtAppSyncInFlightRef.current = key;
    void (async () => {
      try {
        const serverApps = await builtAppsApi.listApps(fileId);
        const plan = planBuiltAppSync({
          local: appStore.all(),
          server: serverApps,
          fileId,
          sheetNames,
        });
        for (const upload of plan.uploads) {
          try {
            await builtAppsApi.createApp(fileId, upload);
          } catch {
            // One bad upload must not block the merge of the rest.
          }
        }
        // Re-plan the merge against the post-upload server list is
        // unnecessary: uploads are local specs stamped for this file,
        // already present in plan.merged via the local side.
        appStore.saveAll(plan.merged);
        builtAppSyncKeyRef.current = key; // consumed only on completion
        setApps(appStore.all());
      } catch {
        // Server unreachable: local cache remains the working copy.
        // The key stays unconsumed (a later change retries), rate-
        // limited by the backoff recorded here.
        builtAppSyncRetryAfterRef.current = { key, at: Date.now() };
      } finally {
        if (builtAppSyncInFlightRef.current === key) builtAppSyncInFlightRef.current = null;
      }
    })();
    // sheetNames is render-derived; the refs above dedupe runs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [builtAppsApi, gwAuthed, collabFileId, workbookLoaded, sheetNames]);

  const handleCreatePivot = useCallback(
    (spec: PivotSpec) => {
      const src = readPivotSource();
      if (!src) return;
      try {
        const result = createPivot(src.records, spec);
        const id = overlayId;
        setOverlayId((i) => i + 1);
        setPivots((prev) => [
          ...prev,
          { id, title: `PivotTable${id}`, spec, result, sourceSheet: activeSheet, sourceRange: src.range },
        ]);
      } catch (e) {
        setLastError(e instanceof Error ? e.message : String(e));
      }
    },
    [readPivotSource, overlayId, activeSheet],
  );

  /**
   * Effective pivot spec with every bound slicer's selection merged in
   * (packages/service slicer.ts: slicer filters replace same-field pivot
   * filters; unbound fields are untouched).
   */
  const effectivePivotSpec = useCallback(
    (p: { id: number; spec: PivotSpec }, allSlicers: SlicerSpec[]): PivotSpec => {
      const selections = allSlicers
        .filter((s) => s.pivotIds.includes(p.id))
        .map((s) => ({ field: s.field, selected: s.selected }));
      return applySlicersToPivotSpec(p.spec, selections);
    },
    [],
  );

  /** Recompute one pivot's result from its source range under `spec`; null on failure. */
  const computePivotResult = useCallback(
    (p: PivotEntry, spec: PivotSpec): PivotResult | null => {
      // Notice entries have nothing to compute; imported pivots without a
      // live worksheet range refresh from their cached records instead.
      if (p.notice || p.result === null) return null;
      if (p.fallbackRecords) {
        try {
          return refreshPivot(p.fallbackRecords, spec);
        } catch {
          return null;
        }
      }
      const view = host.getView();
      const { startRow, startCol, endRow, endCol } = p.sourceRange;
      const grid: unknown[][] = view
        .readRangeValues({ sheet: p.sourceSheet, startRow, startCol, endRow, endCol })
        .map((row) => row.map((v) => TypedView.toJson(v)));
      while (grid.length > 0 && grid[grid.length - 1]?.every((v) => v === null)) grid.pop();
      if (grid.length < 2) return null;
      const headers = (grid[0] ?? []).map((h, i) =>
        h === null || h === undefined || h === '' ? `Column ${colLabel(startCol + i)}` : String(h),
      );
      try {
        return refreshPivot(recordsFromGrid(headers, grid.slice(1)), spec);
      } catch {
        return null;
      }
    },
    [host],
  );

  const handleRefreshPivot = useCallback(
    (id: number) => {
      setPivots((prev) =>
        prev.map((p) => {
          if (p.id !== id) return p;
          const result = computePivotResult(p, effectivePivotSpec(p, slicers));
          return result ? { ...p, result } : p;
        }),
      );
      // Bound PivotCharts re-derive their series from the refreshed result.
      setPivotTick((t) => t + 1);
    },
    [computePivotResult, effectivePivotSpec, slicers],
  );

  /** Close a pivot overlay, unregistering its engine-local registrations. */
  const closePivot = useCallback((id: number) => {
    setPivots((prev) => {
      const gone = prev.find((x) => x.id === id);
      if (gone?.registryKey) {
        unregisterPivot(gone.registryKey);
        unregisterCube(gone.registryKey);
        importedPivotKeysRef.current = importedPivotKeysRef.current.filter(
          (k) => k !== gone.registryKey,
        );
      }
      return prev.filter((x) => x.id !== id);
    });
  }, []);

  /**
   * Slicer → pivot binding: after a slicer selection (or binding) change,
   * recompute every bound pivot with the slicer filter merged in.
   */
  const refreshPivotsForSlicer = useCallback(
    (slicer: SlicerSpec, allSlicers: SlicerSpec[]) => {
      if (slicer.pivotIds.length === 0) return;
      setPivots((prev) =>
        prev.map((p) => {
          if (!slicer.pivotIds.includes(p.id)) return p;
          const result = computePivotResult(p, effectivePivotSpec(p, allSlicers));
          return result ? { ...p, result } : p;
        }),
      );
      setPivotTick((t) => t + 1);
    },
    [computePivotResult, effectivePivotSpec],
  );

  /** Slicer selection toggled: update the slicer, then drive bound pivots. */
  const handleSlicerToggle = useCallback(
    (slicerId: number, value: string) => {
      const allValues = slicerValues.get(slicerId) ?? [];
      const next = slicers.map((x) => (x.id === slicerId ? toggleSlicerValue(x, value, allValues) : x));
      setSlicers(next);
      const changed = next.find((x) => x.id === slicerId);
      if (changed) refreshPivotsForSlicer(changed, next);
    },
    [slicers, slicerValues, refreshPivotsForSlicer],
  );

  /** Slicer cleared (select all): update, then drive bound pivots. */
  const handleSlicerClear = useCallback(
    (slicerId: number) => {
      const next = slicers.map((x) => (x.id === slicerId ? clearSlicer(x) : x));
      setSlicers(next);
      const changed = next.find((x) => x.id === slicerId);
      if (changed) refreshPivotsForSlicer(changed, next);
    },
    [slicers, refreshPivotsForSlicer],
  );

  /** Bind/unbind a pivot table to a slicer, then re-derive the pivot. */
  const handleSlicerPivotBinding = useCallback(
    (slicerId: number, pivotId: number, bind: boolean) => {
      const next = slicers.map((x) =>
        x.id === slicerId ? (bind ? bindSlicerPivot(x, pivotId) : unbindSlicerPivot(x, pivotId)) : x,
      );
      setSlicers(next);
      const changed = next.find((x) => x.id === slicerId);
      if (changed) refreshPivotsForSlicer(changed, next);
      announce(
        bind
          ? `Slicer bound to pivot; the pivot now follows the slicer selection.`
          : `Slicer unbound from pivot.`,
      );
    },
    [slicers, refreshPivotsForSlicer],
  );

  // ---- Native reports & dashboards (design-docs/native-reports-and-dashboards.md) ----
  // Reports read through the typed computational view; specs live in the
  // service metadata store (features/reportStore.ts).

  /** Current sheet's table as report source info for the builder. */
  const readReportSource = useCallback((): ReportSourceInfo | null => {
    const src = readPivotSource();
    if (!src) return null;
    return { sheet: activeSheet, range: src.range, headers: src.headers, distinct: src.distinct };
  }, [readPivotSource, activeSheet]);

  const handleNewReport = useCallback(() => {
    const src = readReportSource();
    if (!src) {
      setLastError('A report needs a table with a header row and at least one data row on the current sheet.');
      return;
    }
    setReportListOpen(false);
    setReportBuilder({ editing: null });
  }, [readReportSource]);

  const handleSaveReport = useCallback(
    (spec: ReportSpec) => {
      const errs = validateReportSpec(spec);
      if (errs.length > 0) {
        setLastError(`Invalid report: ${errs[0]}`);
        return;
      }
      setReports((prev) => {
        const next = prev.some((r) => r.id === spec.id)
          ? prev.map((r) => (r.id === spec.id ? spec : r))
          : [...prev, spec];
        persistReports(next);
        return next;
      });
      setReportBuilder(null);
      setReportListOpen(false);
      setReportViewing(spec);
    },
    [],
  );

  const handleDeleteReport = useCallback((id: string) => {
    setReports((prev) => {
      const next = prev.filter((r) => r.id !== id);
      persistReports(next);
      return next;
    });
    setReportViewing((v) => (v?.id === id ? null : v));
  }, []);

  /** Persist viewer-driven changes (slicer selections, data timestamp). */
  const handleUpdateReport = useCallback((spec: ReportSpec) => {
    setReports((prev) => {
      if (!prev.some((r) => r.id === spec.id)) return prev;
      const next = prev.map((r) => (r.id === spec.id ? spec : r));
      persistReports(next);
      return next;
    });
    setReportViewing(spec);
  }, []);

  /**
   * Report-layer authorize() (native-reports-and-dashboards.md §7): the
   * protection policy over the open policy — the same enforcement the
   * engine's Authorizer uses, so per-subject report views match the grid.
   */
  const reportPolicy: AuthorizePort = useCallback(
    (action: string, target: string, ctx: { principal: string }) =>
      protection.protectionPolicy(allowAllPolicy())(action, target, ctx),
    [protection],
  );

  /** Read one binding's records through the typed computational view. */
  const readReportBinding = useCallback(
    (binding: ReportBinding): PivotRecord[] => {
      const view = host.getView();
      const grid: unknown[][] = view
        .readRangeValues({
          sheet: binding.sheet,
          startRow: binding.startRow,
          startCol: binding.startCol,
          endRow: binding.endRow,
          endCol: binding.endCol,
        })
        .map((row) => row.map((v) => TypedView.toJson(v)));
      const headerIdx = binding.headerRow - binding.startRow;
      const toRecordValue = (v: unknown): unknown => {
        if (typeof v === 'object' && v !== null && 'error' in v) {
          return String((v as { error: string }).error);
        }
        return v;
      };
      return recordsFromGrid(binding.fields, grid.slice(headerIdx + 1)).map((rec) => {
        const out: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(rec)) out[k] = toRecordValue(v);
        return out;
      });
    },
    [host],
  );

  /** Read one chart source cell through the typed computational view. */
  const readReportChartCell = useCallback(
    (sheet: string, row: number, col: number): { text: string; num: number | null } => {
      const cell = host.getView().readCell(cellRef(sheet, row, col));
      return { text: formatDisplay(cell.value), num: numVal(cell.value) };
    },
    [host],
  );

  /**
   * Per-subject report views (native-reports-and-dashboards.md §7): binding
   * records are filtered through authorize() for the viewing subject —
   * hidden/unreadable cells become #PERM!, locked cells stay read-only
   * (report visuals never write through bindings).
   */
  const readReportBindingForSubject = useCallback(
    (binding: ReportBinding): PivotRecord[] =>
      filterBindingRecordsForSubject(binding, readReportBinding(binding), reportPolicy, sessionPrincipal),
    [readReportBinding, reportPolicy, sessionPrincipal],
  );
  const readReportChartCellForSubject = useCallback(
    (sheet: string, row: number, col: number): { text: string; num: number | null } => {
      if (!canSubjectReadCell(reportPolicy, sheet, row, col, sessionPrincipal)) {
        return { text: '#PERM!', num: null };
      }
      return readReportChartCell(sheet, row, col);
    },
    [readReportChartCell, reportPolicy, sessionPrincipal],
  );

  /**
   * Open a report for viewing, gated by §7: the subject must be able to read
   * every binding range the report draws from.
   */
  const handleViewReport = useCallback(
    (spec: ReportSpec) => {
      if (!canViewReport(spec, reportPolicy, sessionPrincipal)) {
        setLastError(`You don't have read access to all data behind "${spec.name}".`);
        return;
      }
      setReportListOpen(false);
      setReportViewing(spec);
    },
    [reportPolicy, sessionPrincipal],
  );

  /** Read a header row's field names for a sheet range. */
  const readReportHeaders = useCallback(
    (sheet: string, row: number, startCol: number, endCol: number): string[] => {
      const view = host.getView();
      const out: string[] = [];
      for (let c = startCol; c <= endCol; c++) {
        const t = formatDisplay(view.readCell(cellRef(sheet, row, c)).value).trim();
        out.push(t === '' ? `Column ${colLabel(c)}` : t);
      }
      return out;
    },
    [host],
  );

  /**
   * Run an ETL recipe for a report refresh (native-reports-and-dashboards.md
   * §6): ETL-backed tables refresh through the pipeline. Same runRecipe
   * pattern as the ETL editor, but the TableWriter targets each binding's
   * sheet range (not the selection), clears stale cells left by a larger
   * previous load, and records the run in the shared run history. Bindings
   * are expanded / fields re-read when the loaded table changed shape, so
   * the visuals that recompute right after see the new table.
   *
   * Like the editor's browser runs, writes go straight through the engine
   * protocol (no undo capture, no protection gate) — a pipeline load is an
   * explicit bulk replace, and a failed run never replaces the last good
   * table (runner §4).
   */
  const handleRunEtlBindingsForReport = useCallback(
    async (recipeId: string, bindings: ReportBinding[]): Promise<EtlBindingRefreshResult> => {
      const recipe = etlRecipeStore().all().find((r) => r.id === recipeId);
      if (!recipe) throw new Error(`ETL recipe "${recipeId}" not found in the recipe store`);

      const writeCell = (sheet: string, row: number, col: number, text: string): void => {
        const parsed = parseEdit(text);
        const ref = cellRef(sheet, row, col);
        if (parsed.kind === 'formula') {
          host.execute({ cmd: 'setFormula', ref, formula: parsed.formula });
        } else {
          host.execute({ cmd: 'setCell', ref, value: parsed.value });
        }
      };

      // Read a binding's current range back as an EtlTable (version retention).
      const readBindingTable = (b: ReportBinding): EtlTable | null => {
        try {
          const grid = host.getView().readRangeValues({
            sheet: b.sheet,
            startRow: b.startRow,
            startCol: b.startCol,
            endRow: b.endRow,
            endCol: b.endCol,
          });
          if (grid.length === 0) return null;
          const headers = grid[0].map((v, i) => {
            const t = v == null ? '' : formatDisplay(v).trim();
            return t === '' ? `Column ${colLabel(b.startCol + i)}` : t;
          });
          const matrix = grid.slice(1).map((row) =>
            headers.map((_, i) => {
              const v = row[i];
              if (v === null || v === undefined) return null;
              if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return v;
              return formatDisplay(v);
            }),
          );
          return makeTable(headers, matrix);
        } catch {
          return null;
        }
      };

      let loaded: EtlTable | null = null;
      const run: RunRecord = await runRecipe(recipe, {
        fetchText: etlFetchText,
        writer: {
          writeAtomic: async (_target, table) => {
            loaded = table;
            const grid = tableToGrid(table);
            const rows = grid.length;
            const cols = rows > 0 ? grid[0].length : 0;
            for (const b of bindings) {
              for (let i = 0; i < rows; i++) {
                for (let j = 0; j < cols; j++) {
                  writeCell(b.sheet, b.startRow + i, b.startCol + j, grid[i][j] ?? '');
                }
              }
              // Clear stale cells left over from a larger previous load.
              for (let r = b.startRow; r <= b.endRow; r++) {
                for (let c = b.startCol; c <= b.endCol; c++) {
                  if (r - b.startRow >= rows || c - b.startCol >= cols) {
                    host.execute({ cmd: 'setCell', ref: cellRef(b.sheet, r, c), value: null });
                  }
                }
              }
            }
          },
          readCurrent: async () => (bindings.length > 0 ? readBindingTable(bindings[0]) : null),
        },
        versions: await etlVersionStore(),
        sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      });
      etlRunHistoryStore().add(run);

      const out = bindings.map((b) => {
        if (!loaded) return b;
        const table = loaded as EtlTable;
        const endRow = Math.max(b.endRow, b.startRow + table.rows.length);
        const endCol = Math.max(b.endCol, b.startCol + table.columns.length - 1);
        const fields = readReportHeaders(b.sheet, b.headerRow, b.startCol, endCol);
        const sameFields =
          fields.length === b.fields.length && fields.every((f, i) => f === b.fields[i]);
        if (endRow === b.endRow && endCol === b.endCol && sameFields) return b;
        return { ...b, endRow, endCol, fields };
      });
      return { run, bindings: out };
    },
    [host, readReportHeaders],
  );

  const availableCharts: AvailableChart[] = useMemo(
    () => charts.map((c) => ({ id: c.id, title: c.title, spec: c })),
    [charts],
  );
  const availablePivots: AvailablePivot[] = useMemo(
    () =>
      pivots.map((p) => ({
        id: p.id,
        title: p.title,
        spec: p.spec,
        sourceSheet: p.sourceSheet,
        sourceRange: p.sourceRange,
      })),
    [pivots],
  );

  const handleInsertShape = useCallback(
    (kind: ShapeKind) => {
      const id = overlayId;
      setOverlayId((i) => i + 1);
      setShapes((prev) => [...prev, { id, kind, x: 120, y: 120, w: 160, h: 100, color: '#4472C4', fillColor: 'none' }]);
    },
    [overlayId],
  );

  // ---- Data tools: Solver, What-If Analysis, Flash Fill (tracks 7, 16) ----
  // All run through the typed computational view; writes go through
  // host.execute (authorize) with a single undo entry per operation.

  /** Parse "C1" into 0-based coordinates; null when invalid. */
  const parseCellA1 = useCallback((a1: string): { row: number; col: number } | null => {
    const clean = a1.trim().replace(/\s+/g, '');
    const m = /^\$?([A-Za-z]{1,3})\$?([0-9]+)$/.exec(clean);
    if (!m) return null;
    let col = 0;
    for (const ch of m[1].toUpperCase()) col = col * 26 + (ch.charCodeAt(0) - 64);
    col -= 1;
    const row = Number(m[2]) - 1;
    if (row < 0 || row > 1048575 || col < 0 || col > 16383) return null;
    return { row, col };
  }, []);

  /** Numeric value of a cell via the typed view; NaN when not a number. */
  const readNumeric = useCallback(
    (row: number, col: number): number => {
      const v = TypedView.toJson(host.getView().readCell(cellRef(activeSheet, row, col)).value);
      return typeof v === 'number' ? v : NaN;
    },
    [host, activeSheet],
  );

  /** Raw display value of a cell via the typed view. */
  const readRaw = useCallback(
    (row: number, col: number): number | string | boolean | null => {
      const v = TypedView.toJson(host.getView().readCell(cellRef(activeSheet, row, col)).value);
      return v && typeof v === 'object' ? null : (v as number | string | boolean | null);
    },
    [host, activeSheet],
  );

  /** Whether the cell holds a user-typed static value (not a formula). */
  const isStaticValue = useCallback(
    (row: number, col: number): boolean => {
      const cell = host.getView().readCell(cellRef(activeSheet, row, col));
      return !cell.formula && cell.value.kind !== 'null';
    },
    [host, activeSheet],
  );

  const handleSolve = useCallback(
    (spec: SolverSpec) => {
      const objPos = parseCellA1(spec.objectiveCell);
      const varPos = spec.variableCells.map((c) => ({ cell: c, pos: parseCellA1(c) }));
      const conPos = spec.constraints.map((c) => ({ ...c, pos: parseCellA1(c.cell) }));
      if (!objPos || varPos.some((v) => !v.pos) || conPos.some((c) => !c.pos)) {
        setLastError('Solver: invalid cell reference in the spec.');
        return;
      }
      // Snapshot originals so the whole solve is one undo step.
      const varCells = varPos.map((v) => ({ row: v.pos!.row, col: v.pos!.col }));
      undoRef.current.capture(host, activeSheet, varCells, 'Solver solution');
      const originals = new Map(varCells.map((c) => [`${c.row},${c.col}`, readRaw(c.row, c.col)]));

      const evaluate: SolverEvaluator = (vars) => {
        for (const v of varPos) {
          host.execute({
            cmd: 'setCell',
            ref: cellRef(activeSheet, v.pos!.row, v.pos!.col),
            value: vars[v.cell] ?? 0,
          });
        }
        const objective = readNumeric(objPos.row, objPos.col);
        const constraintValues = conPos.map((c) => readNumeric(c.pos!.row, c.pos!.col));
        return { objective, constraintValues };
      };
      const initial: Record<string, number> = {};
      for (const v of varPos) {
        const n = readNumeric(v.pos!.row, v.pos!.col);
        initial[v.cell] = Number.isFinite(n) ? n : 0;
      }
      let result;
      try {
        result = solve(spec, initial, evaluate);
      } catch (e) {
        // Restore originals on failure.
        for (const c of varCells) {
          const orig = originals.get(`${c.row},${c.col}`);
          host.execute({ cmd: 'setCell', ref: cellRef(activeSheet, c.row, c.col), value: orig ?? null });
        }
        setLastError(`Solver error: ${e instanceof Error ? e.message : String(e)}`);
        return;
      }
      // Apply the solution.
      for (const v of varPos) {
        host.execute({
          cmd: 'setCell',
          ref: cellRef(activeSheet, v.pos!.row, v.pos!.col),
          value: result.values[v.cell] ?? 0,
        });
      }
      setTick((t) => t + 1);
      announce(
        `${result.message} Objective (${spec.objectiveCell}) = ${result.objectiveValue}. ` +
          (result.maxViolation > 1e-6 ? `Max constraint violation: ${result.maxViolation}.` : 'All constraints satisfied.'),
      );
    },
    [host, activeSheet, parseCellA1, readNumeric, readRaw],
  );

  const handleGoalSeek = useCallback(
    (targetCell: string, targetValue: number, changingCell: string) => {
      const tPos = parseCellA1(targetCell);
      const cPos = parseCellA1(changingCell);
      if (!tPos || !cPos) {
        setLastError('Goal Seek: invalid cell reference.');
        return;
      }
      const guess = readNumeric(cPos.row, cPos.col);
      const start = Number.isFinite(guess) ? guess : 0;
      undoRef.current.capture(host, activeSheet, [{ row: cPos.row, col: cPos.col }], 'Goal Seek');
      const result = goalSeek(
        (x) => {
          host.execute({ cmd: 'setCell', ref: cellRef(activeSheet, cPos.row, cPos.col), value: x });
          return readNumeric(tPos.row, tPos.col);
        },
        targetValue,
        start,
      );
      host.execute({
        cmd: 'setCell',
        ref: cellRef(activeSheet, cPos.row, cPos.col),
        value: result.value,
      });
      setTick((t) => t + 1);
      announce(result.message);
      if (!result.converged) setLastError(result.message);
    },
    [host, activeSheet, parseCellA1, readNumeric],
  );

  // ---- Scenario Manager ----
  const handleAddScenario = useCallback(
    (name: string, changingCellsStr: string, comment: string) => {
      const cells = changingCellsStr
        .split(/[,;\s]+/)
        .map((s) => s.trim().toUpperCase())
        .filter(Boolean);
      if (cells.some((c) => !parseCellA1(c))) {
        setLastError('Scenario Manager: invalid cell reference.');
        return;
      }
      try {
        const scenario = captureScenario(
          name,
          cells,
          (cell) => {
            const p = parseCellA1(cell)!;
            const v = readRaw(p.row, p.col);
            return v === null ? '' : typeof v === 'boolean' ? (v ? 'TRUE' : 'FALSE') : v;
          },
          comment || undefined,
        );
        setScenarioSet((prev) => addScenario(prev, scenario));
        announce(`Scenario "${name}" added.`);
      } catch (e) {
        setLastError(e instanceof Error ? e.message : String(e));
      }
    },
    [parseCellA1, readRaw],
  );

  const handleShowScenario = useCallback(
    (name: string) => {
      const scenario = scenarioSet.scenarios.find((s) => s.name === name);
      if (!scenario) return;
      const writes = scenarioWrites(scenario);
      const cells = writes
        .map((w) => ({ cell: w.cell, pos: parseCellA1(w.cell) }))
        .filter((w) => w.pos) as { cell: string; pos: { row: number; col: number } }[];
      undoRef.current.capture(
        host,
        activeSheet,
        cells.map((c) => ({ row: c.pos.row, col: c.pos.col })),
        `Show scenario "${name}"`,
      );
      for (const c of cells) {
        const w = writes.find((x) => x.cell === c.cell)!;
        host.execute({ cmd: 'setCell', ref: cellRef(activeSheet, c.pos.row, c.pos.col), value: w.value });
      }
      setTick((t) => t + 1);
      announce(`Scenario "${name}" applied.`);
    },
    [host, activeSheet, scenarioSet, parseCellA1],
  );

  const handleDeleteScenario = useCallback((name: string) => {
    setScenarioSet((prev) => deleteScenario(prev, name));
  }, []);

  const handleScenarioSummary = useCallback(() => {
    const { headers, rows } = scenarioSummary(scenarioSet);
    if (rows.length === 0) return;
    const name = `Scenario Summary ${new Date().toLocaleTimeString()}`;
    host.execute({ cmd: 'addSheet', name });
    host.execute({ cmd: 'setCell', ref: cellRef(name, 0, 0), value: 'Scenario Summary' });
    headers.forEach((h, i) => host.execute({ cmd: 'setCell', ref: cellRef(name, 2, i), value: h }));
    rows.forEach((r, ri) =>
      r.forEach((v, ci) => host.execute({ cmd: 'setCell', ref: cellRef(name, 3 + ri, ci), value: v })),
    );
    setSheet(name);
    setTick((t) => t + 1);
  }, [host, scenarioSet]);

  // ---- Data Table ----
  const handleDataTable = useCallback(
    (kind: DataTableKind, inputCell: string, rowInputCell: string, colInputCell: string) => {
      const view = host.getView();
      const usedRange = view.usedRange(activeSheet);
      if (!usedRange) {
        setLastError('Data Table: the sheet is empty.');
        return;
      }
      const used = usedRange;
      const readNum = (r: number, c: number): number => {
        const v = TypedView.toJson(view.readCell(cellRef(activeSheet, r, c)).value);
        return typeof v === 'number' ? v : NaN;
      };
      // Contiguous numeric run starting at (row, col), going down / right.
      const colRun = (row: number, col: number): number[] => {
        const out: number[] = [];
        for (let r = row; r <= used.endRow && r < row + 1000; r++) {
          const n = readNum(r, col);
          if (!Number.isFinite(n)) break;
          out.push(n);
        }
        return out;
      };
      const rowRun = (row: number, col: number): number[] => {
        const out: number[] = [];
        for (let c = col; c <= used.endCol && c < col + 200; c++) {
          const n = readNum(row, c);
          if (!Number.isFinite(n)) break;
          out.push(n);
        }
        return out;
      };
      if (kind === 'one-var') {
        const inPos = parseCellA1(inputCell);
        if (!inPos) {
          setLastError('Data Table: invalid input cell.');
          return;
        }
        const values = colRun(sel.row, sel.col);
        if (values.length === 0) {
          setLastError('Data Table: select a column of input values first.');
          return;
        }
        // Formula cells: non-empty cells in the row directly above the selection start,
        // spanning right from the value column.
        const formulaCells: string[] = [];
        const headerRow = sel.row - 1;
        if (headerRow >= 0) {
          for (let c = sel.col + 1; c <= used.endCol; c++) {
            const cell = view.readCell(cellRef(activeSheet, headerRow, c));
            if (cell.formula || cell.value.kind !== 'null') {
              formulaCells.push(a1Short(headerRow, c));
            } else break;
          }
        }
        if (formulaCells.length === 0) {
          setLastError('Data Table: put formulas in the row above the value column first.');
          return;
        }
        const rows = computeOneVarTable(
          { inputCell, formulaCells, values },
          (inputs) => {
            for (const [cell, v] of Object.entries(inputs)) {
              const p = parseCellA1(cell)!;
              host.execute({ cmd: 'setCell', ref: cellRef(activeSheet, p.row, p.col), value: v });
            }
            const out: Record<string, number> = {};
            for (const fc of formulaCells) {
              const p = parseCellA1(fc)!;
              out[fc] = readNum(p.row, p.col);
            }
            return out;
          },
        );
        undoRef.current.capture(
          host,
          activeSheet,
          rows.flatMap((_, ri) => formulaCells.map((_, ci) => ({ row: sel.row + ri, col: sel.col + 1 + ci }))),
          'Data Table',
        );
        rows.forEach((r, ri) =>
          r.slice(1).forEach((v, ci) =>
            host.execute({
              cmd: 'setCell',
              ref: cellRef(activeSheet, sel.row + ri, sel.col + 1 + ci),
              value: Number.isFinite(v) ? v : null,
            }),
          ),
        );
        setTick((t) => t + 1);
        announce(`One-variable data table computed (${values.length} values × ${formulaCells.length} formulas).`);
      } else {
        const rowPos = parseCellA1(rowInputCell);
        const colPos = parseCellA1(colInputCell);
        if (!rowPos || !colPos) {
          setLastError('Data Table: invalid input cell.');
          return;
        }
        const rowValues = rowRun(sel.row, sel.col + 1);
        const colValues = colRun(sel.row + 1, sel.col);
        if (rowValues.length === 0 || colValues.length === 0) {
          setLastError('Data Table: select the corner cell with row values to the right and column values below.');
          return;
        }
        const corner = view.readCell(cellRef(activeSheet, sel.row, sel.col));
        const formulaCell = corner.formula ? a1Short(sel.row, sel.col) : null;
        if (!formulaCell) {
          setLastError('Data Table: the corner cell must contain the formula.');
          return;
        }
        const tables = computeTwoVarTable(
          { rowInputCell, colInputCell, formulaCells: [formulaCell], rowValues, colValues },
          (inputs) => {
            for (const [cell, v] of Object.entries(inputs)) {
              const p = parseCellA1(cell)!;
              host.execute({ cmd: 'setCell', ref: cellRef(activeSheet, p.row, p.col), value: v });
            }
            const p = parseCellA1(formulaCell)!;
            return { [formulaCell]: readNum(p.row, p.col) };
          },
        );
        const matrix = tables[0]!;
        undoRef.current.capture(
          host,
          activeSheet,
          matrix.flatMap((row, ri) => row.map((_, ci) => ({ row: sel.row + ri, col: sel.col + ci }))),
          'Data Table',
        );
        matrix.forEach((row, ri) =>
          row.forEach((v, ci) => {
            if (ri === 0 && ci === 0) return; // keep the corner formula
            host.execute({
              cmd: 'setCell',
              ref: cellRef(activeSheet, sel.row + ri, sel.col + ci),
              value: Number.isFinite(v) ? v : null,
            });
          }),
        );
        setTick((t) => t + 1);
        announce(`Two-variable data table computed (${rowValues.length} × ${colValues.length}).`);
      }
    },
    [host, activeSheet, sel, parseCellA1],
  );

  // ---- Flash Fill (track 16, deterministic-inference.md) ----
  const handleFlashFill = useCallback(() => {
    const view = host.getView();
    const usedRange = view.usedRange(activeSheet);
    if (!usedRange) {
      setLastError('Flash Fill: the sheet is empty.');
      return;
    }
    const used = usedRange;
    const targetCol = sel.col;
    const strAt = (r: number, c: number): string => {
      const v = readRaw(r, c);
      return v === null || v === undefined ? '' : String(v);
    };
    // Examples: rows in the target column with user-typed static values.
    // Source rows: rows where the source column (nearest non-empty column to
    // the left) has data.
    let sourceCol = -1;
    for (let c = targetCol - 1; c >= used.startCol; c--) {
      let hasData = false;
      for (let r = used.startRow; r <= Math.min(used.endRow, used.startRow + 200); r++) {
        if (strAt(r, c) !== '') {
          hasData = true;
          break;
        }
      }
      if (hasData) {
        sourceCol = c;
        break;
      }
    }
    if (sourceCol < 0) {
      setLastError('Flash Fill: type 1-2 examples in a column next to your data first.');
      return;
    }
    const exInputs: string[] = [];
    const exOutputs: string[] = [];
    const tgtInputs: string[] = [];
    const tgtRows: number[] = [];
    let firstExampleRow = -1;
    for (let r = used.startRow; r <= Math.min(used.endRow, used.startRow + 1000); r++) {
      const src = strAt(r, sourceCol);
      if (src === '') continue;
      if (isStaticValue(r, targetCol)) {
        if (firstExampleRow < 0) firstExampleRow = r;
        exInputs.push(src);
        exOutputs.push(strAt(r, targetCol));
      } else {
        tgtInputs.push(src);
        tgtRows.push(r);
      }
    }
    if (exInputs.length === 0) {
      setLastError('Flash Fill: type 1-2 examples of the result you want in this column first.');
      return;
    }
    if (tgtInputs.length === 0) {
      setLastError('Flash Fill: nothing to fill — every row already has a value.');
      return;
    }
    // Try two-column concat when there are two source columns.
    let proposal: FlashFillProposal | null = null;
    let sourceRef = a1Short(firstExampleRow >= 0 ? firstExampleRow : used.startRow, sourceCol);
    if (sourceCol - 1 >= used.startCol) {
      const colA = sourceCol - 1;
      const aInputs: string[] = [];
      const bInputs: string[] = [];
      const outs: string[] = [];
      const tA: string[] = [];
      const tB: string[] = [];
      for (let r = used.startRow; r <= Math.min(used.endRow, used.startRow + 1000); r++) {
        const a = strAt(r, colA);
        const b = strAt(r, sourceCol);
        if (a === '' && b === '') continue;
        if (isStaticValue(r, targetCol)) {
          aInputs.push(a);
          bInputs.push(b);
          outs.push(strAt(r, targetCol));
        } else {
          tA.push(a);
          tB.push(b);
        }
      }
      const two = analyzeFlashFillTwoCol(aInputs, bInputs, outs, tA, tB);
      if (two) {
        proposal = two;
        sourceRef = a1Short(firstExampleRow >= 0 ? firstExampleRow : used.startRow, colA);
      }
    }
    if (!proposal) {
      proposal = analyzeFlashFill(exInputs, exOutputs, tgtInputs);
    }
    if (!proposal) {
      setLastError('Flash Fill: no pattern found in your examples. Try 2-3 consistent examples.');
      return;
    }
    setFlashFillProposal({
      proposal,
      targetCol,
      startRow: tgtRows[0] ?? used.startRow,
      sourceRef,
      previewRows: tgtInputs.map((input, i) => ({ input, output: proposal!.values[i] ?? '' })),
    });
  }, [host, activeSheet, sel.col, readRaw, isStaticValue]);

  const applyFlashFill = useCallback(
    (asFormulas: boolean) => {
      const ff = flashFillProposal;
      if (!ff) return;
      const view = host.getView();
      const used = view.usedRange(activeSheet);
      const srcColLetter = ff.sourceRef.replace(/[0-9]/g, '');
      undoRef.current.capture(
        host,
        activeSheet,
        ff.previewRows.map((_, i) => ({ row: ff.startRow + i, col: ff.targetCol })),
        'Flash Fill',
      );
      // Map preview rows back to actual target rows.
      const tgtRows: number[] = [];
      if (used) {
        for (let r = used.startRow; r <= Math.min(used.endRow, used.startRow + 1000); r++) {
          if (!isStaticValue(r, ff.targetCol)) {
            const hasSource = ff.previewRows.length > tgtRows.length;
            if (hasSource) tgtRows.push(r);
          }
        }
      }
      ff.proposal.values.forEach((value, i) => {
        const row = tgtRows[i] ?? ff.startRow + i;
        if (asFormulas) {
          const formula = instantiateFormula(ff.proposal.formulaTemplate, `${srcColLetter}${row + 1}`);
          host.execute({ cmd: 'setFormula', ref: cellRef(activeSheet, row, ff.targetCol), formula });
        } else {
          host.execute({ cmd: 'setCell', ref: cellRef(activeSheet, row, ff.targetCol), value });
        }
      });
      setFlashFillProposal(null);
      setTick((t) => t + 1);
      announce(`Flash Fill applied ${ff.proposal.values.length} values (${ff.proposal.description}).`);
    },
    [host, activeSheet, flashFillProposal, isStaticValue],
  );

  // ---- Deterministic inference (design-docs/deterministic-inference.md) ----
  // Service-layer analyzers produce inspectable proposals; nothing applies
  // without the user's accept. Applying goes through host.execute(), which
  // re-runs authorize() per edit.
  const inferenceCtx = useCallback(
    () => buildInferenceContext(host, protection, sessionPrincipal),
    [host, protection],
  );

  const handleSuggestFormulas = useCallback(() => {
    try {
      const proposals = suggestFormulasForSheet(inferenceCtx(), activeSheet);
      setInferencePanel({ title: 'Formula Suggestions', proposals });
      announce(
        proposals.length > 0
          ? `Found ${proposals.length} formula suggestion${proposals.length === 1 ? '' : 's'}. Review before accepting.`
          : 'No formula suggestions for this sheet.',
      );
    } catch (e) {
      setLastError(`Formula suggestions failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }, [inferenceCtx, activeSheet]);

  const handleCleanUp = useCallback(() => {
    try {
      const proposals = cleanupProposalsForSheet(inferenceCtx(), activeSheet);
      setInferencePanel({ title: 'Clean Up Data', proposals });
      announce(
        proposals.length > 0
          ? `Found ${proposals.length} cleanup proposal${proposals.length === 1 ? '' : 's'}. Review before applying.`
          : 'No cleanup issues found on this sheet.',
      );
    } catch (e) {
      setLastError(`Cleanup scan failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }, [inferenceCtx, activeSheet]);

  /** Data > Column Statistics: descriptive profile of the selected column. */
  const handleColumnStats = useCallback(() => {
    try {
      const view = host.getView();
      const used = view.usedRange(activeSheet);
      if (!used) {
        setLastError('Column Statistics needs data on the sheet.');
        return;
      }
      const col = sel.col;
      const grid: unknown[][] = view
        .readRangeValues({ sheet: activeSheet, startRow: used.startRow, startCol: col, endRow: used.endRow, endCol: col })
        .map((row) => row.map((v) => TypedView.toJson(v)));
      const raw = grid.map((r) => r[0]);
      // First cell doubles as the column name when it is a non-blank string.
      let name = colLabel(col);
      let values = raw;
      const first = raw[0];
      if (typeof first === 'string' && first.trim() !== '') {
        name = first;
        values = raw.slice(1);
      }
      const profiles = profileColumnSet([{ name, values }]);
      setColumnStats({ profiles, title: `Column ${colLabel(col)}${name !== colLabel(col) ? ` (${name})` : ''}` });
    } catch (e) {
      setLastError(`Column Statistics failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }, [host, activeSheet, sel.col]);

  /**
   * Data > Trim Whitespace: one-click action wired to the deterministic
   * whitespace detector (packages/service inference/cleanup.ts). Applies
   * the cleanup proposal's edits directly through the same permissioned
   * path as proposal acceptance, with undo capture.
   */
  const handleTrimWhitespace = useCallback(() => {
    try {
      const proposal = whitespaceCleanupProposal(inferenceCtx(), activeSheet);
      if (!proposal) {
        announce('Trim Whitespace: no leading or trailing whitespace found.');
        return;
      }
      const cellEdits = proposal.edits.filter((e) => e.kind !== 'deleteRow');
      if (cellEdits.length > 0) {
        undoRef.current.capture(
          host,
          activeSheet,
          cellEdits.map((e) => ({ row: e.at.row, col: e.at.col })),
          proposal.title,
        );
        bumpUndo();
      }
      const { ok, failed } = applyProposal(host, proposal);
      setTick((t) => t + 1);
      if (failed.length > 0) {
        setLastError(`Trim Whitespace: applied ${ok}; ${failed.length} failed: ${failed[0].error ?? 'unknown error'}`);
      } else {
        announce(`Trim Whitespace: trimmed ${ok} cell${ok === 1 ? '' : 's'}. Undo to reverse.`);
      }
    } catch (e) {
      setLastError(`Trim Whitespace failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }, [host, activeSheet, inferenceCtx]);

  const handleAcceptProposal = useCallback(
    (proposal: Proposal, indices?: number[]) => {
      const accepted = indices
        ? proposal.edits.filter((_, i) => indices.includes(i))
        : proposal.edits;
      // Capture cell-level before-state for Undo (deleteRow is structural
      // and not covered by the cell-level Undo manager).
      const cellEdits = accepted.filter((e) => e.kind !== 'deleteRow');
      if (cellEdits.length > 0) {
        undoRef.current.capture(
          host,
          activeSheet,
          cellEdits.map((e) => ({ row: e.at.row, col: e.at.col })),
          proposal.title,
        );
        bumpUndo();
      }
      const { ok, failed } = applyProposal(host, proposal, indices, (sheet, row, count) =>
        shiftNamesForStructure(sheet, 'deleteRows', row, count),
      );
      setTick((t) => t + 1);
      setInferencePanel((prev) =>
        prev ? { ...prev, proposals: prev.proposals.filter((p) => p.id !== proposal.id) } : prev,
      );
      if (failed.length > 0) {
        setLastError(`Applied ${ok}; ${failed.length} failed: ${failed[0].error ?? 'unknown error'}`);
      } else {
        announce(
          `Applied "${proposal.title}" (${ok} change${ok === 1 ? '' : 's'}).` +
            (proposal.reversible ? ' Undo to reverse.' : ' Row deletions cannot be undone.'),
        );
      }
    },
    [host, activeSheet, bumpUndo, shiftNamesForStructure],
  );

  const handleRejectProposal = useCallback((proposalId: string) => {
    setInferencePanel((prev) =>
      prev ? { ...prev, proposals: prev.proposals.filter((p) => p.id !== proposalId) } : prev,
    );
  }, []);

  const handleModifyProposal = useCallback(
    (proposal: Proposal, newText: string) => {
      // Modify is offered for single-edit proposals: rewrite that edit's
      // text/formula, then apply it as the user's own confirmed change.
      const edit = proposal.edits[0];
      if (!edit) return;
      const rewritten =
        edit.kind === 'setFormula'
          ? { ...edit, formula: newText }
          : edit.kind === 'setValue'
            ? { ...edit, text: newText }
            : null;
      if (!rewritten) return;
      undoRef.current.capture(host, activeSheet, [{ row: edit.at.row, col: edit.at.col }], proposal.title);
      bumpUndo();
      const { ok, failed } = applyProposal(host, { ...proposal, edits: [rewritten] });
      setTick((t) => t + 1);
      setInferencePanel((prev) =>
        prev ? { ...prev, proposals: prev.proposals.filter((p) => p.id !== proposal.id) } : prev,
      );
      if (failed.length > 0) setLastError(`Modified change failed: ${failed[0].error ?? 'unknown error'}`);
      else announce(`Applied modified "${proposal.title}" (${ok} change). Undo to reverse.`);
    },
    [host, activeSheet, bumpUndo],
  );
  /** Insert a picture from a device file (downscaled, persisted with workbook). */
  const handleInsertPicture = useCallback(
    async (file: File) => {
      try {
        const dataUrl = await fileToPictureDataUrl(file);
        const id = overlayId;
        setOverlayId((i) => i + 1);
        // Intrinsic size when known; the overlay clamps to a sane default.
        setPictures((prev) => [...prev, { id, x: 140, y: 140, w: 320, h: 240, dataUrl, name: file.name }]);
        setLastError(null);
      } catch (e) {
        setLastError(e instanceof Error ? e.message : String(e));
      }
    },
    [overlayId],
  );

  /** Print layout: set/clear the print area from the current selection. */
  const handleSetPrintArea = useCallback(() => {
    // Selection is a single cell in this UI; use a small neighborhood so the
    // area is meaningful, matching Excel's "set print area to selection".
    const area = `${cellLabelOf(sel.row, sel.col)}:${cellLabelOf(sel.row + 9, sel.col + 5)}`;
    setPageSetup((prev) => ({ ...prev, printArea: area }));
    setLastError(null);
  }, [sel]);
  const handleClearPrintArea = useCallback(() => {
    setPageSetup((prev) => ({ ...prev, printArea: null }));
  }, []);
  const handleInsertTextBox = useCallback(() => {
    const id = overlayId;
    setOverlayId((i) => i + 1);
    setTextBoxes((prev) => [...prev, { id, x: 120, y: 120, w: 200, h: 80, text: 'Text box' }]);
  }, [overlayId]);

  /** Open Insert Function dialog pre-filtered to a category. */
  const openFnDialogFor = useCallback((category: string) => {
    setFnDialogCategory(category);
    setFnDialogOpen(true);
  }, []);

  /** Calculation mode setter (for the dropdown). */
  const handleSetCalcMode = useCallback(
    (mode: CalculationMode) => {
      const res = host.execute({ cmd: 'setCalculationMode', mode });
      if (res.ok) setCalcMode(mode);
      else setLastError(res.error);
    },
    [host],
  );

  /** Show Formulas toggle. */
  const handleToggleShowFormulas = useCallback(() => setShowFormulas((v) => !v), []);

  /** Clear all filters. */
  const handleClearFilter = useCallback(() => setFilters(new Map()), []);

  /** Focus Cell toggle. */
  const handleToggleFocusCell = useCallback(() => setFocusCell((v) => !v), []);

  /** Show Comments toggle. */
  const handleToggleShowComments = useCallback(() => setShowComments((v) => !v), []);

  /** Whether the selected cell has a comment. */
  const hasComment = getComment(comments, activeSheet, sel.row, sel.col) !== undefined;

  /** Function categories for the Formulas tab menus. */
  const fnCategories = useMemo(() => {
    const cats = new Set<string>();
    // Imported lazily to avoid circulars; functions.ts is already imported via InsertFunctionDialog.
    return ['All', 'Financial', 'Logical', 'Text', 'Date & Time', 'Lookup & Reference', 'Math & Trig', 'Statistical', 'Engineering', 'Lambda'];
  }, []);

  /** Double underline toggle. */
  const handleDoubleUnderline = useCallback(() => {
    const cur = getFormat(formats, activeSheet, sel.row, sel.col);
    handleFormat({ underline: cur?.underline === 'double' ? false : 'double' });
  }, [formats, activeSheet, sel, handleFormat]);

  /** Increase decimal places on the active cell (Excel Number group). */
  const handleIncreaseDecimal = useCallback(() => {
    const cur = getFormat(formats, activeSheet, sel.row, sel.col);
    const decimals = Math.min(10, (cur?.decimals ?? 2) + 1);
    handleFormat({ numberFormat: cur?.numberFormat ?? 'Number', decimals });
  }, [formats, activeSheet, sel, handleFormat]);

  /** Decrease decimal places on the active cell (Excel Number group). */
  const handleDecreaseDecimal = useCallback(() => {
    const cur = getFormat(formats, activeSheet, sel.row, sel.col);
    const decimals = Math.max(0, (cur?.decimals ?? 2) - 1);
    handleFormat({ numberFormat: cur?.numberFormat ?? 'Number', decimals });
  }, [formats, activeSheet, sel, handleFormat]);

  /** Border color: apply to all four sides keeping style. */
  const handleBorderColor = useCallback(
    (color: string) => {
      const cur = getFormat(formats, activeSheet, sel.row, sel.col);
      const c = color === 'Automatic' ? '#000000' : color;
      const sides = (['top', 'bottom', 'left', 'right'] as const).map((side) => [
        side,
        { style: cur?.borders?.[side]?.style ?? 'thin', color: c },
      ]);
      handleFormat({ borders: Object.fromEntries(sides) as CellFormat['borders'] });
    },
    [formats, activeSheet, sel, handleFormat],
  );

  /** Border style: apply to all four sides keeping color. */
  const handleBorderStyle = useCallback(
    (style: string) => {
      const cur = getFormat(formats, activeSheet, sel.row, sel.col);
      const sides = (['top', 'bottom', 'left', 'right'] as const).map((side) => [
        side,
        { style, color: cur?.borders?.[side]?.color ?? '#000000' },
      ]);
      handleFormat({ borders: Object.fromEntries(sides) as CellFormat['borders'] });
    },
    [formats, activeSheet, sel, handleFormat],
  );

  /** Accounting format with currency symbol. */
  const handleAccounting = useCallback(
    (symbol: string) => {
      handleFormat({ numberFormat: 'Accounting' });
      // Symbol is applied via number format; store symbol in a data attribute is overkill.
      // The Accounting format renders with $ by default; symbol variants need formatNumber support.
      setLastError(null);
    },
    [handleFormat],
  );

  const handleFullScreen = useCallback(() => {
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    else document.documentElement.requestFullscreen().catch(() => setLastError('Full screen was blocked by the browser.'));
  }, []);

  const handleToggleHeadings = useCallback(() => setShowHeadings((v) => !v), []);

  const handleUnmerge = useCallback(() => {
    // D-SEL-2: live anchor — menu actions postdate the menu build.
    const { row, col } = selRef.current;
    const existing = findMerge(merges, activeSheet, row, col);
    if (!existing) {
      setLastError('Selected cell is not merged.');
      return;
    }
    setMerges((prev) => prev.filter((m) => m.id !== existing.id));
    setLastError(null);
  }, [merges, activeSheet]);

  // ---- Conditional formatting ----
  const handleAddCFRule = useCallback(
    (operator: CFOperator, operands: string[], color: string) => {
      const rule = makeCFRule({
        sheet: activeSheet,
        startRow: sel.row,
        startCol: sel.col,
        endRow: sel.row,
        endCol: sel.col,
        operator,
        operands,
        color,
      });
      setCfRules((prev) => [...prev, rule]);
      setLastError(null);
    },
    [activeSheet, sel],
  );

  const handleClearCFRules = useCallback(() => {
    setCfRules((prev) => prev.filter((r) => !(r.sheet === activeSheet && r.startRow === sel.row && r.startCol === sel.col)));
    setLastError(null);
  }, [activeSheet, sel]);

  // ---- Data validation ----
  const handleSaveValidation = useCallback(
    (list: string[]) => {
      setValidations((prev) => {
        const without = prev.filter(
          (r) => !(r.sheet === activeSheet && r.row === sel.row && r.col === sel.col),
        );
        if (list.length === 0) return without;
        return [...without, makeValidationRule({ sheet: activeSheet, row: sel.row, col: sel.col, list })];
      });
      setLastError(null);
    },
    [activeSheet, sel],
  );

  const handleClearValidation = useCallback(() => {
    setValidations((prev) =>
      prev.filter((r) => !(r.sheet === activeSheet && r.row === sel.row && r.col === sel.col)),
    );
  }, [activeSheet, sel]);

  // ---- Find/replace ----
  const handleFind = useCallback(
    (query: string, opts: FindOptions) => {
      const matches = findAll(host, activeSheet, query, opts);
      setFindMatches(matches);
      setFindIdx(0);
      if (matches.length > 0) {
        setSel({ row: matches[0].row, col: matches[0].col });
      }
    },
    [host, activeSheet],
  );

  const handleFindNext = useCallback(() => {
    if (findMatches.length === 0) return;
    const next = (findIdx + 1) % findMatches.length;
    setFindIdx(next);
    setSel({ row: findMatches[next].row, col: findMatches[next].col });
  }, [findMatches, findIdx]);

  const handleReplaceAll = useCallback(
    (query: string, replacement: string, opts: FindOptions) => {
      if (!query) return;
      undoRef.current.capture(
        host,
        activeSheet,
        findAll(host, activeSheet, query, opts),
        `Replace "${query}"`,
      );
      const count = replaceAll(host, activeSheet, query, replacement, opts);
      setLastError(count === 0 ? 'No matches found.' : `Replaced in ${count} cell${count === 1 ? '' : 's'}.`);
      setFindMatches([]);
      bumpUndo();
    },
    [host, activeSheet, bumpUndo],
  );

  // ---- Context menu ----
  const openCtxMenu = useCallback((x: number, y: number, items: MenuItem[]) => {
    setCtxMenu({ x, y, items });
  }, []);

  /**
   * Apply settings from the Settings dialog (platform-shell.md §4):
   * persist to the per-user profile and apply live — formula language
   * re-wires localization, calculation mode / zoom / grid toggles apply
   * to the current session.
   */
  const handleSettingsSave = useCallback(
    (next: UserSettings) => {
      setSettings(next);
      saveSettings(next);
      applyTheme(next.theme);
      // Gateway mode: the SERVER record is the durable theme store
      // (#38). A theme changed here must land there too, or the shell's
      // next settings fetch (e.g. after a refresh) would resurrect the
      // old server choice over this one — the two stores diverged
      // silently before. Fire-and-forget: the local apply above already
      // took effect; a failed write-back surfaces on the next fetch.
      if (productApi && next.theme !== getSessionSettings()?.theme) {
        void productApi
          .updateSettings({ theme: next.theme })
          .then((view) => {
            setSessionSettings(view);
            applyThemeChoice(view.theme);
          })
          .catch(() => undefined);
      }
      setCalcMode(next.calculationMode);
      setZoom(next.defaultZoom);
      setShowGridlines(next.showGridlines);
      setShowFormulaBar(next.showFormulaBar);
      // Calculation Options: the MT cell-count threshold applies live to
      // the gateway host's routing (env override stays canonical).
      if (host instanceof RemoteEngineHost) {
        host.setHybridThresholds(
          resolveHybridThresholds({
            settingsMtThreshold: next.mtCellCountThreshold,
            env: (import.meta as unknown as { env?: Record<string, string | undefined> }).env,
          }),
        );
      }
      if (next.formulaLanguage !== formulaLangRef.current) {
        handleFormulaLangChange(next.formulaLanguage);
      }
    },
    [handleFormulaLangChange, host, productApi],
  );

  // ---- Context menus (Excel parity: cell, column, row, sheet tab) ----

  /** Cell right-click menu. */
  const cellMenuItems = useCallback(
    (): MenuItem[] => [
      { label: 'Cut', action: () => void handleCut(), title: 'Cut (Ctrl+X)' },
      { label: 'Copy', action: () => void handleCopy(), title: 'Copy (Ctrl+C)' },
      {
        label: 'Paste',
        submenu: [
          { label: 'Paste', action: () => void handlePaste(), title: 'Paste (Ctrl+V)' },
          { label: 'Values only', action: () => void handlePasteValues(), title: 'Paste values only (Ctrl+Shift+V)' },
        ],
      },
      {
        label: 'Paste Special',
        submenu: [
          { label: 'Values only', action: () => void handlePasteValues(), title: 'Paste values only (Ctrl+Shift+V)' },
          { label: 'Formulas only', disabled: true, title: 'Not yet implemented' },
          { label: 'Formatting only', disabled: true, title: 'Not yet implemented' },
          { label: 'Transpose', disabled: true, title: 'Not yet implemented' },
        ],
      },
      { separator: true, label: '' },
      {
        label: 'Insert',
        submenu: [
          { label: '1 Row Above', action: handleInsertRow },
          { label: '1 Row Below', action: handleInsertRowBelow },
          { label: '1 Column Left', action: handleInsertCol },
          { label: '1 Column Right', action: handleInsertColRight },
        ],
      },
      {
        label: 'Delete',
        submenu: [
          { label: `Row ${sel.row + 1}`, action: handleDeleteRow },
          { label: `Column ${colLabel(sel.col)}`, action: handleDeleteCol },
        ],
      },
      { label: 'Clear Contents', action: handleClear },
      { separator: true, label: '' },
      {
        label: 'Filter',
        submenu: [
          { label: 'Filter by Selected Value', action: () => handleFilterByValue() },
          { label: 'Clear Filter', action: () => handleClearFilter() },
        ],
      },
      {
        label: 'Sort',
        submenu: [
          { label: 'Smallest to Largest', action: () => handleSort('asc') },
          { label: 'Largest to Smallest', action: () => handleSort('desc') },
          { label: 'Custom Sort…', action: () => setSortDialogOpen(true) },
        ],
      },
      { separator: true, label: '' },
      { label: 'Format Cells…', action: () => setFormatCellsOpen(true), title: 'Format Cells (Ctrl+1)' },
      { label: 'Insert Link…', action: () => {
        const url = window.prompt('Enter URL:', 'https://');
        // D-SEL-2: live anchor — menu actions postdate the menu build.
        const anchor = selRef.current;
        if (url) commitCell(anchor.row, anchor.col, `=HYPERLINK("${url}")`);
      }, title: 'Insert link (Ctrl+K)' },
      { separator: true, label: '' },
      { label: 'New Comment…', action: () => setCommentDialogOpen(true), title: 'New Comment (Ctrl+Alt+M)' },
      { label: 'New Note', action: () => setCommentDialogOpen(true), title: 'New Note (Shift+F2)' },
      { label: 'Delete Comment', action: handleDeleteComment, disabled: !hasComment },
      { separator: true, label: '' },
      { label: 'Row Height…', action: () => setRowHeightOpen(true) },
      { label: 'Column Width…', action: () => setColWidthOpen(true) },
      {
        label: 'Hide',
        submenu: [
          { label: 'Hide Row', action: handleHideRow },
          { label: 'Hide Column', action: handleHideCol },
        ],
      },
      { separator: true, label: '' },
      { label: 'Merge Cells', action: handleMerge },
      { label: 'Unmerge Cells', action: handleUnmerge },
    ],
    [handleCut, handleCopy, handlePaste, handlePasteValues, handleInsertRow, handleInsertRowBelow, handleDeleteRow, handleInsertCol, handleInsertColRight, handleDeleteCol, handleClear, handleSort, handleMerge, handleUnmerge, handleHideRow, handleHideCol, handleDeleteComment, handleFilterByValue, handleClearFilter, hasComment, sel.col, sel.row],
  );

  /** Column header right-click menu. */
  const columnMenuItems = useCallback(
    (col: number): MenuItem[] => [
      { label: 'Cut', action: () => void handleCut(), title: 'Cut column (Ctrl+X)' },
      { label: 'Copy', action: () => void handleCopy(), title: 'Copy column (Ctrl+C)' },
      { label: 'Paste', action: () => void handlePaste(), title: 'Paste (Ctrl+V)' },
      { separator: true, label: '' },
      { label: 'Insert column left', action: () => handleInsertColsMenu(col, 'before'), title: 'Insert column(s) left of this one (selection-aware count)' },
      { label: 'Insert column right', action: () => handleInsertColsMenu(col, 'after'), title: 'Insert column(s) right of this one (selection-aware count)' },
      { label: 'Delete Columns', action: handleDeleteCol, title: 'Delete this column' },
      { label: 'Clear Contents', action: handleClear, title: 'Clear all cells in this column' },
      { separator: true, label: '' },
      { label: 'Format Cells…', action: () => setFormatCellsOpen(true) },
      { label: 'Column Width…', action: () => setColWidthOpen(true) },
      { label: 'Hide', action: handleHideCol },
      { label: 'Unhide Columns', action: handleUnhideCols },
      { separator: true, label: '' },
      { label: 'Sort A to Z', action: () => handleSort('asc') },
      { label: 'Sort Z to A', action: () => handleSort('desc') },
      { label: 'Filter', action: () => setFilterOpen({ col }) },
    ],
    [handleCut, handleCopy, handlePaste, handleInsertColsMenu, handleDeleteCol, handleClear, handleSort, handleHideCol, handleUnhideCols],
  );

  /** Row header right-click menu. */
  const rowMenuItems = useCallback(
    (row: number): MenuItem[] => [
      { label: 'Cut', action: () => void handleCut(), title: 'Cut row (Ctrl+X)' },
      { label: 'Copy', action: () => void handleCopy(), title: 'Copy row (Ctrl+C)' },
      { label: 'Paste', action: () => void handlePaste(), title: 'Paste (Ctrl+V)' },
      { separator: true, label: '' },
      { label: 'Insert row above', action: () => handleInsertRowsMenu(row, 'before'), title: 'Insert row(s) above this one (selection-aware count)' },
      { label: 'Insert row below', action: () => handleInsertRowsMenu(row, 'after'), title: 'Insert row(s) below this one (selection-aware count)' },
      { label: 'Delete Rows', action: handleDeleteRow, title: 'Delete this row' },
      { label: 'Clear Contents', action: handleClear, title: 'Clear all cells in this row' },
      { separator: true, label: '' },
      { label: 'Format Cells…', action: () => setFormatCellsOpen(true) },
      { label: 'Row Height…', action: () => setRowHeightOpen(true) },
      { label: 'Hide', action: handleHideRow },
      { label: 'Unhide Rows', action: handleUnhideRows },
    ],
    [handleCut, handleCopy, handlePaste, handleInsertRowsMenu, handleDeleteRow, handleClear, handleHideRow, handleUnhideRows],
  );

  /** Sheet tab right-click menu. */
  const sheetTabMenuItems = useCallback(
    (name: string): MenuItem[] => [
      { label: 'Insert Sheet…', action: () => handleAddSheet(nextSheetName(visibleSheets)) },
      { label: 'Delete', action: () => handleDeleteSheet(name) },
      { label: 'Rename…', action: () => { setSheet(name); setRenameSheetOpen(true); } },
      { separator: true, label: '' },
      {
        label: 'Tab Color',
        submenu: THEME_COLORS.slice(0, 12).map((c) => ({
          label: c,
          action: () => setTabColors((prev) => new Map(prev).set(name, c)),
        })),
      },
      { label: 'Hide', action: () => setHiddenSheets((prev) => new Set(prev).add(name)), disabled: visibleSheets.length <= 1, title: 'Hide this sheet' },
      { label: 'Unhide…', action: () => setUnhideOpen(true), disabled: hiddenSheets.size === 0 },
      { separator: true, label: '' },
      { label: 'Move or Copy…', action: () => ribbonParity.openMoveCopySheet(name) },
    ],
    [handleAddSheet, handleDeleteSheet, visibleSheets, hiddenSheets.size, ribbonParity.openMoveCopySheet],
  );

  const handleZoomIn = useCallback(
    () => setZoom((z) => Math.min(2, Math.round((z + 0.25) * 100) / 100)),
    [],
  );
  const handleZoomOut = useCallback(
    () => setZoom((z) => Math.max(0.5, Math.round((z - 0.25) * 100) / 100)),
    [],
  );
  const handleZoomReset = useCallback(() => setZoom(1), []);
  const handleToggleGridlines = useCallback(() => setShowGridlines((v) => !v), []);
  const handleToggleFormulaBar = useCallback(() => setShowFormulaBar((v) => !v), []);
  const handleError = useCallback((msg: string) => setLastError(msg), []);

  /**
   * Hydrate the metadata-driven overlays (imported/app-authored pictures
   * + text boxes) from a workbook metadata record. This is the exact
   * overlay step of the load-payload hydration (hydrateOpenedWorkbook),
   * factored out so the snapshot-only flows — a client JOINING a live
   * session, or REHYDRATING after a release — consume the snapshot's
   * additive `metadata` field through the identical code path (File-2
   * defect D1 follow-up: those flows never see a /load payload, and the
   * bare snapshot used to carry no metadata at all, so their imported
   * pictures and text boxes never rendered).
   */
  const hydrateOverlayMetadata = useCallback((metadata: Record<string, unknown>) => {
    // Restore app-owned overlays from adapter metadata.
    setPictures(picturesFromMetadata(metadata[PICTURES_METADATA_KEY]));
    // Imported text shapes ride the same channel (adapter seeds
    // `icecream.textboxes` from native drawings — File-2 defect D1).
    setTextBoxes(textBoxesFromMetadata(metadata[TEXTBOXES_METADATA_KEY]));
  }, []);

  /**
   * Hydrate all UI state from a parsed workbook (adapter data + metadata).
   * Shared by the in-browser open (web local mode) and — Cycle 10 — the
   * desktop IPC open: on desktop, parse + EngineWorkbook build happen in
   * the MAIN process (engine:load) and the engine-side registry wiring
   * (data-model cubes, imported-pivot registries) already ran there, so
   * `data` arrives as sheet summaries with EMPTY rows plus the adapter
   * metadata. opts.skipEngineSide skips the renderer-side copies of those
   * engine steps; opts.colNonEmptyBySheet feeds dynamic chart-name
   * resolution (the renderer has no rows on desktop).
   */
  const hydrateOpenedWorkbook = useCallback(
    (
      data: WorkbookData,
      opts: { skipEngineSide: boolean; colNonEmptyBySheet?: Map<string, number[]> },
    ) => {
      // Keep the file's external-link table for the save path (round-trip).
      externalLinksMetaRef.current =
        data.metadata[EXTERNAL_LINKS_METADATA_KEY] !== undefined &&
        externalLinksFromWorkbookData(data).length > 0
          ? data.metadata[EXTERNAL_LINKS_METADATA_KEY]
          : undefined;
      // Seed the format store with the file's Excel number formats
      // (styles.xml → per-cell format codes): they render until the user
      // sets their own format on a cell. Replaces any previous file's
      // formats so opens never leak stale formatting.
      setFormats(importedFormatsToStore(data));
      // Restore data-type metadata (layer 2) saved via custom properties.
      // Replaces any previous file's types so opens never leak stale types.
      setDataTypes(dataTypesFromMetadata(data.metadata[DATATYPES_METADATA_KEY]));
      // Seed column widths / row heights from the file's dimensions (!cols /
      // !rows). Stored on the column/row, never per-cell — pure UI hints.
      // Replaces any previous file's dimensions so opens never leak stale sizes.
      // Seed column widths / row heights from the file's dimensions (!cols /
      // !rows). Stored on the column/row, never per-cell — pure UI hints.
      // Replaces any previous file's dimensions so opens never leak stale sizes.
      {
        const first = data.sheets[0];
        const cw = new Map<number, number>();
        const rh = new Map<number, number>();
        if (first?.colWidths) {
          for (const [k, v] of Object.entries(first.colWidths)) cw.set(Number(k), v);
        }
        if (first?.rowHeights) {
          for (const [k, v] of Object.entries(first.rowHeights)) rh.set(Number(k), v);
        }
        setColWidths(cw);
        setRowHeights(rh);
        // Hidden columns/rows from the file.
        if (first?.hiddenCols) setHiddenCols(new Set(first.hiddenCols));
        if (first?.hiddenRows) setHiddenRows(new Set(first.hiddenRows));
      }
      // Restore protection flags (design §5: hints round-trip through XLSX).
      protection.fromMetadata(data.metadata);
      setProtectionTick((t) => t + 1);
      // Import the file's defined names into the service name store
      // (features/nameServices.ts: "On open, defined names from the XLSX
      // adapter are imported into the stores"). Item H / audit D3: this
      // import was NEVER wired — useNameServices.importFromDefinedNames
      // had no caller — so the store stayed empty for every opened file
      // and every consumer of the store lied: the Download dialog
      // claimed "No defined names in this workbook yet" for files with
      // 40/512 defined names, and named-range download could not find
      // any name the file actually carried. (Save was rescued separately
      // by defect E1, which merged the snapshot's names in; the dialog
      // reads ONLY the store.) Import is merge-only and idempotent:
      // non-range names (constants, _xlcn.* connection names, LAMBDAs)
      // are skipped-and-reported by the store, collisions are skipped,
      // and #REF! names import as dangling — so the deferred + terminal
      // hydrations of one open can both run it safely. Fire-and-forget:
      // hydration stays synchronous; the store's changed() re-render
      // lands the names in open dialogs when the import settles.
      if (data.definedNames && data.definedNames.length > 0) {
        void nameServices
          .importFromDefinedNames(data.definedNames, data.sheets.map((s) => s.name))
          .catch(() => undefined);
      }
      // Restore app-owned overlays from adapter metadata (shared with
      // the snapshot-only join/rehydrate path — hydrateOverlayMetadata).
      hydrateOverlayMetadata(data.metadata);
      // Render pivot tables embedded in the opened file: each becomes a
      // pivot overlay whose layout is computed from its pivot cache via the
      // service pivot component — nothing the file contained is silently
      // dropped. Replaces any previous file's pivots (like charts above).
      {
        // Unregister the previous file's imported pivots from the
        // engine-local registries (GETPIVOTDATA / CUBE* functions).
        // Cycle 10 desktop: those registries live in the main-process
        // engine — main already unregistered them for the new file.
        if (!opts.skipEngineSide) {
          for (const key of importedPivotKeysRef.current) {
            unregisterPivot(key);
            unregisterCube(key);
          }
        }
        importedPivotKeysRef.current = [];
        pivotPartsRef.current = pivotPartsFromMetadata(data.metadata[PIVOT_PARTS_METADATA_KEY]);
        const base = Date.now();
        const sheetNames = data.sheets.map((s) => s.name);
        const imported: PivotEntry[] = [];
        // Pivot names are workbook-unique in Excel, but some producers
        // duplicate them — disambiguate cube names so no pivot silently
        // replaces another in the engine registries.
        const usedNames = new Set<string>();
        importedPivotsFromMetadata(data.metadata[PIVOT_TABLES_METADATA_KEY]).forEach((t, i) => {
          const id = base + i + 1;
          const key = `xlsx:${t.name}#${i}`;
          let cubeName = t.name;
          if (usedNames.has(cubeName)) {
            let n = 2;
            cubeName = `${t.name} — ${t.sheetName}`;
            while (usedNames.has(cubeName)) {
              cubeName = `${t.name} — ${t.sheetName} (${n})`;
              n += 1;
            }
          }
          usedNames.add(cubeName);
          if (t.warning || t.values.length === 0) {
            // Empty shells and broken caches still surface — as a notice,
            // never a silent drop.
            imported.push({
              id,
              title: t.name,
              spec: importedPivotToSpec(t),
              result: null,
              sourceSheet: t.sheetName,
              sourceRange: { startRow: 0, startCol: 0, endRow: -1, endCol: -1 },
              notice:
                t.warning ??
                `"${t.name}" has no fields on rows, columns, or values yet.`,
            });
            return;
          }
          const result = buildImportedPivotResult(t);
          if (!result) {
            imported.push({
              id,
              title: t.name,
              spec: importedPivotToSpec(t),
              result: null,
              sourceSheet: t.sheetName,
              sourceRange: { startRow: 0, startCol: 0, endRow: -1, endCol: -1 },
              notice:
                t.warning ??
                `"${t.name}" has no cached records in the file — refresh from its source to populate it.`,
            });
            return;
          }
          const spec = importedPivotToSpec(t);
          const liveRange = importedPivotSourceRange(t);
          const liveOk =
            liveRange !== null && sheetNames.includes(liveRange.sheet);
          const entry: PivotEntry = {
            id,
            title: t.name,
            spec,
            result,
            sourceSheet: liveOk && liveRange ? liveRange.sheet : t.sheetName,
            sourceRange: liveOk && liveRange
              ? {
                  startRow: liveRange.startRow,
                  startCol: liveRange.startCol,
                  endRow: liveRange.endRow,
                  endCol: liveRange.endCol,
                }
              : { startRow: 0, startCol: 0, endRow: -1, endCol: -1 },
            matrix: importedPivotMatrix(result, t.dataOnRows),
            registryKey: key,
          };
          if (!liveOk) entry.fallbackRecords = importedPivotRecords(t);
          imported.push(entry);
          // Feed the engine-local registries: GETPIVOTDATA resolves the
          // pivot at its sheet location; the CUBE* functions resolve it as
          // an OLAP cube under the pivot's name. Cycle 10 desktop: the
          // registries live in the main-process engine — main already
          // registered them during engine:load.
          try {
            const matrix = entry.matrix ?? [];
            if (!opts.skipEngineSide) {
              registerPivot(key, result, {
                sheet: t.sheetIndex,
                col: t.anchor.col,
                row: t.anchor.row,
                cols: Math.max(1, matrix[0]?.length ?? 1),
                rows: Math.max(1, matrix.length),
              });
              registerCube(cubeFromPivot(result, cubeName));
              importedPivotKeysRef.current.push(key);
            }
          } catch {
            // Registry wiring must never break the open.
          }
        });
        setPivots(imported);
        // Render charts embedded in the opened file (drawingML import) AFTER
        // pivots, so pivot charts (<c:pivotSource>) can bind to their pivot
        // table by name: every embedded chart becomes a native overlay spec
        // on its own sheet, so nothing the file contained is silently
        // dropped. Pivot charts bind to the live pivot result (not a
        // snapshot) and stay in sync on refresh/slicer changes. Replaces any
        // previous file's charts. App-authored charts saved into the file
        // (icecream.chartspecs, name-based pivot bindings) are restored too.
        {
          const chartBase = Date.now() + 1_000_000;
          const pivotByName = new Map(imported.map((p) => [p.title, p]));
          const importedSpecs: ChartSpec[] = [];
          // Resolve defined names in chart series formulas (plain A1 names
          // and OFFSET/COUNTA dynamic names) against the opened workbook's
          // data, so charts whose series reference names render with live
          // data instead of being silently dropped.
          const sheetRowsByName = new Map(
            data.sheets.map((s) => [s.name.toLowerCase(), s.rows]),
          );
          const chartNameCtx: ChartNameResolutionContext = {
            definedNames: data.definedNames ?? [],
            sheetNames,
            countNonEmpty: (sheet, col) => {
              // Cycle 10 desktop: the renderer holds no rows — the main
              // process counted non-empty cells per column during
              // engine:load and sent the counts with the load result.
              const mainCounts = opts.colNonEmptyBySheet?.get(sheet);
              if (mainCounts) return mainCounts[col] ?? 0;
              const rows = sheetRowsByName.get(sheet.toLowerCase());
              if (!rows) return 0;
              let n = 0;
              for (const row of rows) {
                const v = row?.[col];
                if (v !== null && v !== undefined && v !== '') n++;
              }
              return n;
            },
          };
          importedChartsFromMetadata(data.metadata[CHARTS_METADATA_KEY]).forEach((c, i) => {
            if (c.pivotSource) {
              const pivot = pivotByName.get(c.pivotSource);
              if (pivot) {
                importedSpecs.push(importedPivotChartToSpec(c, pivot, chartBase + i, sheetNames, chartNameCtx));
                return;
              }
              // A pivot chart whose pivot table didn't import: fall through
              // to the regular path (may still render from cached formulas).
            }
            const spec = importedChartToSpec(c, chartBase + i, sheetNames, chartNameCtx);
            if (spec) importedSpecs.push(spec);
          });
          const restored = pivotChartSpecsFromMetadata(
            data.metadata[CHART_SPECS_METADATA_KEY],
            (name) => pivotByName.get(name)?.id,
          );
          const seenIds = new Set(importedSpecs.map((s) => s.id));
          for (const s of restored) {
            if (!seenIds.has(s.id)) {
              importedSpecs.push(s);
              seenIds.add(s.id);
            }
          }
          setCharts(importedSpecs);
          persistCharts(importedSpecs);
        }
      }
      // Render SmartArt diagrams embedded in the opened file (drawingML
      // diagram import): every diagram becomes a picture overlay on its own
      // sheet, rendered from its family with its text — nothing the file
      // contained is silently dropped. Replaces any previous file's
      // imported diagrams; the deterministic overlay names keep a
      // save → re-open cycle from duplicating them.
      {
        const base = Date.now();
        const diagrams = importedSmartArtFromMetadata(data.metadata[SMARTART_METADATA_KEY]);
        smartArtPartsRef.current = smartArtPartsFromMetadata(
          data.metadata[SMARTART_PARTS_METADATA_KEY],
        );
        const report = smartArtLayoutMappingReport(diagrams);
        for (const entry of report) {
          if (entry.exact) {
            console.info(
              `[SmartArt] "${entry.layoutName || entry.layoutId}" on "${entry.sheetName}" → ${entry.family} (exact)`,
            );
          } else {
            console.info(`[SmartArt] ${entry.note} (sheet "${entry.sheetName}")`);
          }
        }
        setPictures((prev) => {
          // Drop this file's previously imported diagrams (they are
          // re-added fresh below), but keep every user picture.
          const kept = prev.filter((p) => !p.name.startsWith('SmartArt - '));
          const existing = new Set(kept.map((p) => `${p.sheet ?? ''}::${p.name}`));
          const added = diagrams
            .filter((d) => !existing.has(`${d.sheetName}::${importedSmartArtPictureName(d)}`))
            .map((d, i) => importedSmartArtToPicture(d, base + i));
          return [...kept, ...added];
        });
      }
      const ps = pageSetupFromMetadata(data.metadata[`${PAGE_SETUP_METADATA_PREFIX}${data.sheets[0]?.name ?? ''}`]);
      if (ps) setPageSetup(ps);
      const pt = printTitlesFromMetadata(data.metadata[`${PRINT_TITLES_METADATA_PREFIX}${data.sheets[0]?.name ?? ''}`]);
      if (pt) setPrintTitles(pt);
      // Stash every sheet's page-setup/print-titles (GAP-9): the dialog
      // state only covers the active sheet, but the other sheets' native
      // settings must still round-trip on save. Replaces any previous
      // file's stash so opens never leak stale settings.
      {
        const psBySheet: Record<string, unknown> = {};
        const ptBySheet: Record<string, unknown> = {};
        for (const s of data.sheets) {
          const v = data.metadata[`${PAGE_SETUP_METADATA_PREFIX}${s.name}`];
          if (v !== undefined) psBySheet[s.name] = v;
          const t = data.metadata[`${PRINT_TITLES_METADATA_PREFIX}${s.name}`];
          if (t !== undefined) ptBySheet[s.name] = t;
        }
        pageSetupBySheetRef.current = psBySheet;
        printTitlesBySheetRef.current = ptBySheet;
      }
      // Restore manual page breaks for every sheet (native XML wins inside
      // the adapter; the metadata hint covers adapter-written files).
      const restored: Record<string, PageBreaks> = {};
      for (const s of data.sheets) {
        const b = pageBreaksFromMetadata(data.metadata[pageBreaksMetadataKey(s.name)]);
        if (b.rows.length > 0 || b.cols.length > 0) restored[s.name] = b;
      }
      setPageBreaksBySheet(restored);
      // Restore ribbon deep-store: per-sheet header/footer settings,
      // the workbook theme, and per-sheet ink strokes + drawing canvases.
      // Replaces any previous file's state so opens never leak stale data.
      {
        const hf: Record<string, HeaderFooterSettings> = {};
        const ink: Record<string, InkStroke[]> = {};
        const dc: Record<string, DrawingCanvasSpec[]> = {};
        for (const s of data.sheets) {
          const h = headerFooterFromMetadata(data.metadata[headerFooterMetadataKey(s.name)]);
          if (h) hf[s.name] = h;
          const st = inkStrokesFromMetadata(data.metadata[inkMetadataKey(s.name)]);
          if (st.length > 0) ink[s.name] = st;
          const cv = drawingCanvasesFromMetadata(data.metadata[drawingCanvasMetadataKey(s.name)]);
          if (cv.length > 0) dc[s.name] = cv;
        }
        setHfSettings(hf);
        setInkStrokesBySheet(ink);
        setDrawingCanvasesBySheet(dc);
        const th = themeFromMetadata(data.metadata[THEME_METADATA_KEY]);
        setWorkbookTheme(th ?? DEFAULT_THEME);
      }
      setLastError(null);
    },
    [protection, nameServices, hydrateOverlayMetadata],
  );

  /**
   * Cycle 10 desktop open: parse + EngineWorkbook build run in the MAIN
   * process through the engine:load IPC channel (see
   * apps/desktop/src/engine-load.ts). The renderer receives sheet
   * summaries + adapter metadata and hydrates UI state from them — the
   * renderer's UI thread never parses, builds, or recalcs. Mutation
   * stays gated (workbookLoaded) until the round-trip + hydration
   * complete: a save before that would serialize a half-hydrated model.
   */
  const openDesktopBuffer = useCallback(
    async (buffer: Uint8Array, filename: string): Promise<void> => {
      const ipc = getHost();
      if (!(ipc instanceof IpcEngineHost)) {
        setLastError('Desktop engine bridge unavailable.');
        return;
      }
      setWorkbookLoaded(false);
      let res: Awaited<ReturnType<IpcEngineHost['loadIpc']>>;
      try {
        res = await ipc.loadIpc(buffer, filename);
      } catch (e) {
        // The load itself failed: main's host still holds the previous
        // workbook (the swap is atomic) and the renderer's state still
        // matches it — un-gate and surface the error.
        setWorkbookLoaded(true);
        setLastError(e instanceof Error ? e.message : String(e));
        return;
      }
      try {
        // W14 (E4 stall): yield one macrotask between the load round-trip
        // and the hydration batch. The bridge recalcComplete render, this
        // continuation (result conversion + hydrate), and the hydration
        // render + browser Commit otherwise run as one unbroken
        // main-thread chain (measured ~108–125 ms of timer starvation at
        // P75 on a 2-core host; the yield splits it to ~61–66 ms). The
        // previous workbook stays painted and mutation stays gated
        // (workbookLoaded is still false here) throughout the yield, so
        // the progressive-view and save-gating rules are unaffected.
        await new Promise<void>((resolve) => { setTimeout(resolve, 0); });
        const data = workbookDataFromDesktopLoadResult(res);
        const colNonEmptyBySheet = new Map<string, number[]>(
          res.sheets.map((s) => [s.name, s.colNonEmpty ?? []]),
        );
        // ORDER IS LOAD-BEARING (defect E2): notify BEFORE hydrate, the
        // same order as the gateway open (notifyHostReplaced() then
        // hydrateOpenedWorkbook) and the local open (replaceWiredHost
        // notifies, then hydrate). The host-replaced handler resets
        // per-workbook UI state — setFormats(createFormatStore())
        // included — while hydrate SEEEDS the format store from the
        // file's formats/styles. Hydrating first and notifying second
        // wiped the just-seeded store in the same update batch, so a
        // desktop relaunch rendered saved bold / "0.00%" as fw 400 /
        // plain "0" even though the summary carried them (W10 R1b).
        notifyHostReplaced();
        hydrateOpenedWorkbook(data, { skipEngineSide: true, colNonEmptyBySheet });
        setWorkbookLoaded(true);
      } catch (e) {
        // Partial hydration: renderer state may no longer match the new
        // workbook in main — keep mutation gated and surface the error.
        setLastError(e instanceof Error ? e.message : String(e));
      }
    },
    [hydrateOpenedWorkbook, setWorkbookLoaded],
  );

  /**
   * Open a spreadsheet file (shared by the plain and password flows).
   * The storage adapter is resolved from the engine's AdapterRegistry by
   * file extension (track 9): xlsx/csv/tsv/ods.
   */
  const openXlsxBuffer = useCallback(
    (buffer: Uint8Array, filename: string) => {
      // Cycle 10 desktop: route the open through the engine:load IPC
      // channel (openDesktopBuffer) instead of parsing + building on the
      // UI thread.
      if (isDesktop()) {
        void openDesktopBuffer(buffer, filename);
        return;
      }
      const adapter = adapterForFilename(filename);
      const data = adapter.read(buffer);
      // OLAP data-model cubes (CUBE* functions): files whose data model
      // was built from a worksheet range carry CUBEVALUE/CUBEMEMBER
      // formulas against a connection (e.g. "ThisWorkbookDataModel") that
      // is not in the file — only its source range is (`xlsx.connections`
      // metadata from the adapter). Rebuild the cube from that range and
      // register it under the connection name so the formulas resolve
      // instead of #NAME?. This MUST run before the workbook is built:
      // the engine caches evaluated cells, so a cube registered after the
      // first read would leave the errors stuck. Replaces any previous
      // file's data-model cubes so opens never leak stale registrations.
      for (const key of cubeDataModelKeysRef.current) unregisterCube(key);
      cubeDataModelKeysRef.current = registerDataModelCubes(data);
      replaceWiredHost(workbookFromData(data));
      hydrateOpenedWorkbook(data, { skipEngineSide: false });
    },
    [hydrateOpenedWorkbook, openDesktopBuffer, replaceWiredHost],
  );

  /**
   * Open a file against the remote engine service (gateway mode).
   * Cycle 10, Phase 2: fully async — the tab stays responsive while the
   * server parses + builds (the old sync XHR froze the whole tab for
   * ~40s on P95), no snapshot is pulled (sheet names come from /load's
   * sheets[], cell data stays server-side and streams viewport-lazily),
   * and the metadata payload hydrates the same browser stores a local
   * open does (formats, charts, pivots, SmartArt, page setup, …).
   * DISPLAY IS PROGRESSIVE; MUTATION IS GATED: the old workbook stays
   * on screen while the server builds, the view appears as soon as the
   * load resolves, and editing/save/autosave/export stay gated at
   * workbookLoaded until hydration completes 100%.
   */
  const openRemoteBuffer = useCallback(
    async (buffer: Uint8Array, filename: string) => {
      if (!(host instanceof RemoteEngineHost)) return;
      const remote = host;
      // Issue #18: the previous file + whether the session switch below
      // drops its session live at FUNCTION scope so the LOAD-failure
      // catch can restore the previous session — the mint-failure path
      // already does; a load failure must too, or the tab is left
      // sessionless while the previous workbook sits checkpointed.
      let prevFileId: string | null = null;
      let droppedPrevSession = false;
      // Time-to-first-page instrumentation (Phase 4): file selected now.
      markFileSelected();
      setLoadProgress({ pct: 0, calculating: false });
      setWorkbookLoaded(false);
      let result: EngineLoadResult;
      // W15 (P95 TTFP): split the old first-chunk full hydration into a
      // FRAME step and a DEFERRED full hydration. The frame step —
      // notifyHostReplaced() — is all first paint needs from the meta
      // chunk (sheet names + active sheet + per-workbook UI reset; cell
      // values come from the host's pushed-cell cache, formats at meta
      // time are still empty). The full hydrateOpenedWorkbook run (format
      // store, pivots, charts, SmartArt, page setup, protection, … —
      // ~20 store updates + their renders) used to execute synchronously
      // inside the stream reader's delivery task BETWEEN meta and sheet
      // 1's first rows, delaying first paint by its full cost (measured
      // 0.25–0.9 s of main-thread work + contention on the shared VM).
      // It now runs one frame after the first rows have been seeded —
      // still seconds before `built` on big files, so overlays/formats
      // keep filling progressively — and the terminal hydration below
      // re-runs it authoritatively with the complete payload regardless.
      const openSeq = ++remoteOpenSeqRef.current;
      let frameNotified = false;
      let streamSettled = false;
      let deferredScheduled = false;
      let deferredHydrated = false;
      let latestAcc: EngineLoadResult | null = null;
      const scheduleDeferredHydrate = (): void => {
        if (deferredScheduled) return;
        deferredScheduled = true;
        const run = (): void => {
          if (streamSettled || deferredHydrated || openSeq !== remoteOpenSeqRef.current) return;
          deferredHydrated = true;
          const accNow = latestAcc;
          if (!accNow || accNow.sheets.length === 0) return;
          try {
            hydrateOpenedWorkbook(workbookDataFromLoadResult(accNow), {
              skipEngineSide: true,
              colNonEmptyBySheet: new Map<string, number[]>(
                Object.entries(accNow.columnCounts),
              ),
            });
          } catch {
            // Progressive-view only; the terminal hydration is authoritative.
          }
        };
        if (typeof requestAnimationFrame === 'function') {
          requestAnimationFrame(() => {
            setTimeout(run, 0);
          });
        } else {
          setTimeout(run, 16);
        }
      };
      // Phase 2 claim hygiene (fix): set when THIS open created the
      // server session — if the load then fails, the blank claim is
      // released in the catch below instead of squatting the engine.
      let createdSession: { sessionId: string } | null = null;
      const transport = collabTransportRef.current;
      try {
        // Off the main thread: Blob + FileReader do the base64 work, so
        // even a 12MB file doesn't cost a multi-hundred-ms main-thread
        // task (the old chunked btoa loop ran on the UI thread).
        const base64 = await uint8ToBase64(buffer);
        // The engine's load format follows the file's extension: a
        // legacy .xls rides the /load BIFF path (sweep finding F-2);
        // everything else is the xlsx stream path.
        const loadFormat: 'xlsx' | 'xls' = filename.toLowerCase().endsWith('.xls')
          ? 'xls'
          : 'xlsx';
        // Phase 2 join handshake (§9): BEFORE the load, ask the gateway
        // to open the file — it claims the ONE server session for a
        // fresh fileId and returns the owner endpoint + token; the
        // transport then connects directly (SSE deltas, /ops) and the
        // load below rides that direct connection with the handshake
        // token (RemoteEngineHost prefers the collab direct load
        // whenever a session is opened — the gateway-proxied load
        // endpoints are never used for a handshake-opened session).
        // Uploaded bytes are a NEW file every time, so this always
        // mints: joining the PREVIOUS file's session here would load
        // these bytes into the wrong file's session. (Joining an
        // existing file happens only via the `#file=` startup path,
        // which never loads.) A handshake failure leaves no collab
        // session bound, so the host falls back to the Phase 1
        // transport load exactly as before.
        if (transport) {
          prevFileId = collabFileIdRef.current;
          let switchAborted = false;
          try {
            // Switching files within this tab: the local engine hosts
            // ONE session, so the previous file's session must be let
            // go before the new claim — a live previous session 409s
            // the claim. If THIS tab created that session, release it
            // (checkpoints server-side; its co-clients re-claim and
            // rehydrate on reconnect, §9). If this tab merely JOINED
            // it, just disconnect locally — a guest never tears down
            // a session it does not own.
            if (transport.sessionId && prevFileId) {
              if (transport.wasJoined === false) {
                await transport.releaseOpenedSession('superseded-by-new-open').catch(() => false);
              } else {
                transport.disconnect();
              }
              setCollabFile(null);
              droppedPrevSession = true;
            }
            const opened = await transport.connect();
            setCollabFile(opened.fileId);
            if (!opened.joined) createdSession = { sessionId: opened.sessionId };
          } catch (e) {
            console.warn('[collab] gateway open handshake failed; continuing with load:', e);
            if (prevFileId) {
              // The switch dropped the previous session and the mint
              // failed: restore the tab's previous session (it is
              // checkpointed and re-joinable by id) and ABORT this
              // open — loading the new bytes into the restored session
              // would corrupt the previous file. With no previous
              // session, the Phase 1 fallback posture below stands.
              switchAborted = true;
              if (!transport.sessionId) {
                try {
                  const rejoined = await transport.connect(prevFileId);
                  setCollabFile(rejoined.fileId);
                } catch {
                  // Previous file stays checkpointed server-side.
                }
              }
            }
          }
          if (switchAborted) {
            throw new Error(
              'Could not open a session for the new file — the previous workbook is unchanged.',
            );
          }
        }
        // Progressive PUSH stream (Phase 4 stream design): the metadata
        // chunk (names/order + defined names + formats) hydrates the app
        // frame + sheet tabs immediately; sheet 1's pushed STORED values
        // (the file's own cached results) seed the view cache so the
        // first page paints REAL data before the engine build finishes —
        // first paint is NOT gated on calc. Later sheets stream in
        // behind; unarrived regions show the loading state. The promise
        // still resolves only at the terminal chunk (100% load), which
        // is what un-gates mutation below. When the server answers with
        // the classic single /load response instead, the chunk callback
        // fires once (terminal) and behavior is exactly the old path.
        result = await remote.loadXlsxAsync(base64, (acc, done, chunk) => {
          if (done) return;
          // StatusBar progress (Phase 4): server-driven percent when the
          // stream sends it; otherwise sheets-hydrated over total sheets.
          const pct =
            typeof chunk.progressPct === 'number'
              ? Math.max(0, Math.min(99, chunk.progressPct))
              : acc.sheets.length > 0
                ? Math.min(99, Math.round((acc.file.sheets.length / acc.sheets.length) * 100))
                : null;
          setLoadProgress({ pct, calculating: chunk.calculating === true });
          latestAcc = acc;
          try {
            if (!frameNotified && acc.sheets.length > 0) {
              frameNotified = true;
              // Frame only (W15, see above): sheet tabs + active sheet +
              // UI reset so sheet 1's pushed values can paint at once.
              notifyHostReplaced();
            }
            // Deferred full hydration is scheduled from the first ROWS
            // chunk, not from meta: the host seeds that chunk's values
            // (stamping first-values) BEFORE this callback runs, so the
            // hydrate's rAF+macrotask can only fire after the first-page
            // mark and the values render — never inside the meta→rows
            // window competing with them (first scheduling attempt put it
            // on the meta frame and the contention came back).
            if (chunk.rawType === 'rows') scheduleDeferredHydrate();
            // (Pushed cells are seeded per-chunk by the host itself —
            // RemoteEngineHost seeds each `rows` chunk's delta as it
            // arrives; re-seeding the accumulation here would be O(n²).)
          } catch {
            // Chunk hydration is progressive-view only; the terminal
            // hydration below is authoritative and still runs.
          }
        }, loadFormat);
        streamSettled = true;
      } catch (e) {
        // The load itself failed: the service still holds the previous
        // workbook and the UI still matches it — un-gate and surface.
        // (streamSettled also cancels any deferred mid-stream hydration:
        // a failed load must not hydrate a partial accumulation.)
        streamSettled = true;
        // Claim hygiene (Phase 2 fix): if THIS open claimed the session
        // (a fresh create) and the load never landed, release the claim
        // — a blank live session would 409 every subsequent open of a
        // different file until its lease/idle expiry. A JOINED session
        // is never released here (it is not ours to tear down).
        if (transport && createdSession) {
          await transport.releaseOpenedSession('load-failed').catch(() => false);
          setCollabFile(null);
        }
        // Issue #18: the switch dropped the previous session before
        // this open was attempted, and the load failed — put the
        // previous workbook back through the app's canonical open
        // path: a fresh boot join of its deep link (the same
        // navigation a Workspace file click makes). The previous
        // session was checkpointed when the switch released it, so
        // the join rehydrates it fully painted and editable. (An
        // in-place rejoin was tried first: the transport rebinds, but
        // the view the switch + failed load tore down does not
        // repaint from it.) The failure is stashed so the boot can
        // surface it once — the reload would otherwise swallow it.
        // (When this open JOINED a live session instead of claiming
        // one, the transport is still bound to it and there is
        // nothing to restore.)
        if (transport && droppedPrevSession && prevFileId && !transport.sessionId) {
          try {
            // Plain language only: the raw loader message (parser
            // internals) stays in the console, never in user copy.
            sessionStorage.setItem(
              OPEN_FAILURE_NOTICE_KEY,
              'That file could not be opened. Your previous workbook was restored.',
            );
          } catch {
            // Storage unavailable — the reload still restores the workbook.
          }
          window.location.assign(
            `${window.location.origin}${window.location.pathname}?file=${encodeURIComponent(prevFileId)}`,
          );
          return;
        }
        setLoadProgress({ pct: null, calculating: false });
        setWorkbookLoaded(true);
        setLastError(e instanceof Error ? e.message : String(e));
        return;
      }
      try {
        const data = workbookDataFromLoadResult(result);
        const colNonEmptyBySheet = new Map<string, number[]>(Object.entries(result.columnCounts));
        notifyHostReplaced();
        hydrateOpenedWorkbook(data, { skipEngineSide: true, colNonEmptyBySheet });
        // Local mirror (ONE FLAG rule): below-flag workbooks ship every
        // cell's formula + cached value + data type; the client builds a
        // local engine from it. Flag ON: no mirror ships.
        localMirrorRef.current?.dispose();
        localMirrorRef.current = null;
        try {
          localMirrorRef.current = buildLocalMirror(result);
        } catch {
          // A broken mirror never breaks the open: the server workbook is
          // the source of truth and the view still hydrates above.
          localMirrorRef.current = null;
        }
        // Phase 3 integration: hand the mirror + the CURRENT workbook's
        // cell count to the remote host's routed edit pipeline. The count
        // (not the mirror's own bounding box) drives deriveMirrorMode +
        // the MT auto-flag — ONE FLAG, TWO CONSEQUENCES. No mirror
        // (flag ON) → the host routes every edit to the server and never
        // consults a local engine.
        remote.setLocalMirror(
          localMirrorRef.current,
          Object.values(result.columnCounts).reduce(
            (n, cols) => n + cols.reduce((a, b) => a + b, 0),
            0,
          ),
          resolveHybridThresholds({
            settingsMtThreshold: settingsRef.current.mtCellCountThreshold,
            env: (import.meta as unknown as { env?: Record<string, string | undefined> }).env,
          }),
        );
        // Any pushed values that arrived with the terminal chunk paint now.
        remote.seedStreamedCells(result.streamedCells);
        setReadOnly(false);
        setSaveState('saved');
        // 100%: the progress readout flips to the normal ready state at
        // the SAME moment edit/save unlock — one transition.
        setLoadProgress({ pct: null, calculating: false });
        setWorkbookLoaded(true);
        setLastError(null);
      } catch (e) {
        // Partial hydration: renderer state may no longer match the new
        // workbook in main — keep mutation gated and surface the error.
        setLastError(e instanceof Error ? e.message : String(e));
      }
    },
    [host, hydrateOpenedWorkbook],
  );

  const handleOpenFile = useCallback(
    async (file: File) => {
      try {
        const buffer = new Uint8Array(await file.arrayBuffer());
        // Gateway mode: the file is parsed by the engine service (spec c).
        if (host instanceof RemoteEngineHost) {
          if (isEncryptedFile(buffer)) {
            // Decrypt client-side, then upload the XLSX bytes.
            setFilePasswordError(null);
            setFilePassword({ mode: 'open', buffer, filename: file.name, remote: true });
            return;
          }
          await openRemoteBuffer(buffer, file.name);
          return;
        }
        // Face a: password-to-open. Encrypted files prompt for the password;
        // the password derives the key and is never stored.
        if (isEncryptedFile(buffer)) {
          setFilePasswordError(null);
          setFilePassword({ mode: 'open', buffer, filename: file.name });
          return;
        }
        openXlsxBuffer(buffer, file.name);
        setReadOnly(false);
        setSaveState('saved');
      } catch (e) {
        setLastError(e instanceof Error ? e.message : String(e));
      }
    },
    [host, openRemoteBuffer, openXlsxBuffer],
  );

  /**
   * Drag-and-drop open (GAP-5; benefits web too): a dropped file opens
   * through the same flow as the file picker (handleOpenFile), including
   * the gateway-mode and password-to-open detours. On desktop Electron
   * exposes the file's real path, so a successful drop claims it as the
   * native save target — mirroring File > Open's in-place semantics —
   * but UNTRUSTED (GAP-10): auto-save skips it until the first
   * dialog-confirmed save, so a drop never pops a surprise Save modal.
   * Encrypted drops detour to the password dialog without claiming the
   * path (mirroring handleDesktopOpen / handleDesktopOpenPath).
   */
  const handleDropFile = useCallback(
    async (file: File) => {
      try {
        const fileWithPath = file as File & { path?: unknown };
        const nativePath =
          isDesktop() && typeof fileWithPath.path === 'string'
            ? fileWithPath.path
            : undefined;
        await handleOpenFile(file);
        if (nativePath) {
          // Only claim the path when the file actually opened: probe for
          // the encrypted detour (handleOpenFile left the password dialog
          // up and the previous workbook intact in that case).
          const probe = new Uint8Array(await file.arrayBuffer());
          if (!isEncryptedFile(probe)) {
            setDesktopPath(nativePath);
            setLibraryId(null);
            desktopPathTrustedRef.current = false;
          }
        }
      } catch (e) {
        setLastError(e instanceof Error ? e.message : String(e));
      }
    },
    [handleOpenFile],
  );


  /**
   * Download gate (design §6 + sensitivity labels): authorize() for the full
   * workbook, then sensitivity-label rules. Throws with a user-facing message
   * when the download is not allowed.
   */
  const checkDownloadAllowed = useCallback((): void => {
    const auth = { principal: sessionPrincipal };
    if (!host.getAuthorizer().authorize('workbook.download', 'workbook', auth)) {
      throw new Error('Download denied by policy.');
    }
    // Sensitivity enforcement (face c: authorize-style access control, not
    // encryption — the decision is audited by the SensitivityStore).
    // canDownload is async only because it writes the audit trail; the
    // allow/deny decision itself reads synchronous in-memory state, so mirror
    // it here (same rule as SensitivityStore.canDownload) and fire-and-forget
    // the audited store call to keep the download pipeline synchronous.
    const sensLabel = sensitivity.getLabel();
    const allowed =
      sensLabel === 'confidential'
        ? sensitivity.owners().includes(sessionPrincipal)
        : sessionPrincipal.length > 0;
    void sensitivity.canDownload(sensLabel, sessionPrincipal);
    if (!allowed) {
      throw new Error(
        `Download blocked: the "${sensLabel}" sensitivity label restricts downloads to owners.`,
      );
    }
    if (sensLabel === 'confidential' && !window.confirm('This workbook is labeled Confidential. Download it anyway?')) {
      throw new Error('Download cancelled.');
    }
  }, [host, protection, sensitivity, sessionPrincipal]);

  /**
   * Gateway mode: buildDownloadBytes() below is synchronous and reads
   * host.snapshot(), which for RemoteEngineHost is a cache read — the
   * authoritative snapshot lives on the engine service and must be
   * pulled first (snapshotAsync), or every sheet serializes EMPTY
   * (names + metadata only). Every async save/download flow awaits this
   * before building bytes. The remote host invalidates its cached
   * snapshot on every mutation, so the pull is fresh at save time.
   */
  /**
   * SAVE / AUTOSAVE INTERLOCK (Cycle 10 closure): while any routed edit
   * is in flight (server-routed edit awaiting its ack, or a desktop IPC
   * edit awaiting the main-process reply), the workbook holds
   * provisional / pre-edit state — a save serializing in that window
   * would persist the WRONG state. Every save path therefore DEFERS
   * here until the edit settles, then proceeds with the post-edit
   * state. The dirty flag is never touched by the deferral, so no save
   * is dropped and nothing is marked clean early. The signal is the
   * hosts' own (RemoteEngineHost: routed-edit tracker + session;
   * IpcEngineHost: execute tracker; the synchronous local host has no
   * in-flight window — see services/saveInterlock.ts). This sits
   * ALONGSIDE the workbookLoaded gate, never instead of it.
   */
  const awaitEditsSettled = useCallback(async (): Promise<void> => {
    await waitForEditsToSettle(host);
  }, [host]);

  const ensureSaveSnapshot = useCallback(async (): Promise<void> => {
    // Interlock FIRST: the snapshot pull must not even start while a
    // routed edit is in flight — the authoritative snapshot is only
    // meaningful once the edit's ack has landed server-side (gateway)
    // or in the main-process engine (desktop).
    await awaitEditsSettled();
    if (host instanceof RemoteEngineHost) await host.snapshotAsync();
    // Desktop: IpcEngineHost.snapshot() is likewise a sync cache read —
    // pull the authoritative main-process snapshot first, or the save
    // would serialize the name-only fallback (every sheet empty).
    else if (host instanceof IpcEngineHost) await host.snapshotAsync();
  }, [host, awaitEditsSettled]);

  /**
   * Attach every client-owned save extra to a WorkbookData: the active
   * sheet's grid dims, pictures, data-type metadata, page setup / print
   * titles, page breaks, header/footer + theme + ink + drawing state,
   * external links, raw pivot/SmartArt parts, and chart specs. Shared by
   * the in-tab serialization (buildDownloadBytes) and the gateway
   * server-download extras (buildServerSaveExtras) so the two paths can
   * never drift apart in what a save carries.
   */
  const applyClientSaveMetadata = useCallback((wbData: { sheets: Array<{ name: string; colWidths?: Record<string, number>; rowHeights?: Record<string, number>; hiddenCols?: number[]; hiddenRows?: number[] }>; metadata: Record<string, unknown> }): void => {
    // Column widths / row heights are UI hints stored on the column/row.
    // Attach the current grid sizes so they survive save/reopen.
    {
      const target = wbData.sheets.find((s) => s.name === activeSheet);
      if (target) {
        const cw: Record<string, number> = {};
        for (const [c, w] of colWidths) cw[String(c)] = w;
        if (Object.keys(cw).length > 0) target.colWidths = cw;
        const rh: Record<string, number> = {};
        for (const [r, h] of rowHeights) rh[String(r)] = h;
        if (Object.keys(rh).length > 0) target.rowHeights = rh;
        if (hiddenCols.size > 0) target.hiddenCols = [...hiddenCols];
        if (hiddenRows.size > 0) target.hiddenRows = [...hiddenRows];
      }
    }
    wbData.metadata[PICTURES_METADATA_KEY] = picturesToMetadata(pictures);
    // Data-type metadata (layer 2): column/range types survive save/reopen
    // via the same custom-properties channel. Values/formulas untouched.
    {
      const dtMeta = dataTypesToMetadata(dataTypes);
      if (dtMeta) wbData.metadata[DATATYPES_METADATA_KEY] = dtMeta;
    }
    wbData.metadata[`${PAGE_SETUP_METADATA_PREFIX}${activeSheet}`] = pageSetupToMetadata(pageSetup);
    wbData.metadata[`${PRINT_TITLES_METADATA_PREFIX}${activeSheet}`] = printTitlesToMetadata(printTitles);
    // GAP-9: carry the other sheets' stashed settings so their native
    // print settings survive the save (the dialog state only models the
    // active sheet).
    for (const name of sheetNames) {
      if (name === activeSheet) continue;
      const stashed = pageSetupBySheetRef.current[name];
      if (stashed !== undefined) wbData.metadata[`${PAGE_SETUP_METADATA_PREFIX}${name}`] = stashed;
      const stashedTitles = printTitlesBySheetRef.current[name];
      if (stashedTitles !== undefined) wbData.metadata[`${PRINT_TITLES_METADATA_PREFIX}${name}`] = stashedTitles;
    }
    // External workbook links: the engine resolves [N]Sheet!Ref formulas
    // through the parsed link table; carry it into the save so the adapter
    // regenerates the xl/externalLinks parts (round-trip).
    if (externalLinksMetaRef.current !== undefined) {
      wbData.metadata[EXTERNAL_LINKS_METADATA_KEY] = externalLinksMetaRef.current;
    }
    // Manual page breaks for every sheet (the xlsx adapter also mirrors
    // them into native <rowBreaks>/<colBreaks> XML).
    for (const [sheet, breaks] of Object.entries(pageBreaksBySheet)) {
      if (breaks.rows.length > 0 || breaks.cols.length > 0) {
        wbData.metadata[pageBreaksMetadataKey(sheet)] = pageBreaksToMetadata(breaks);
      }
    }
    // Ribbon deep-store: per-sheet header/footer settings, the workbook
    // theme, and per-sheet ink strokes + drawing canvases survive the
    // save through the metadata channel (restored on open above).
    for (const [sheet, settings] of Object.entries(hfSettings)) {
      wbData.metadata[headerFooterMetadataKey(sheet)] = headerFooterToMetadata(settings);
    }
    wbData.metadata[THEME_METADATA_KEY] = themeToMetadata(workbookTheme);
    for (const [sheet, strokes] of Object.entries(inkStrokesBySheet)) {
      if (strokes.length > 0) wbData.metadata[inkMetadataKey(sheet)] = inkStrokesToMetadata(strokes);
    }
    for (const [sheet, canvases] of Object.entries(drawingCanvasesBySheet)) {
      if (canvases.length > 0)
        wbData.metadata[drawingCanvasMetadataKey(sheet)] = drawingCanvasesToMetadata(canvases);
    }
    // Pivot round-trip: re-attach the raw pivot parts captured on open so
    // the adapter re-injects the pivot XML byte-for-byte on save (SheetJS
    // would otherwise drop every pivot).
    if (pivotPartsRef.current !== undefined) {
      wbData.metadata[PIVOT_PARTS_METADATA_KEY] = pivotPartsRef.current;
    }
    // SmartArt round-trip: re-attach the raw diagram parts captured on open
    // so the adapter re-emits the diagram XML byte-for-byte on save
    // (SheetJS would otherwise drop every diagram).
    if (smartArtPartsRef.current !== undefined) {
      wbData.metadata[SMARTART_PARTS_METADATA_KEY] = smartArtPartsRef.current;
    }
    // PivotChart round-trip: persist the app's chart specs — including
    // pivot-bound PivotCharts, whose binding is stored by pivot NAME
    // (session-local ids would be meaningless after reopen) — so they
    // survive save/reopen. Restored on open via CHART_SPECS_METADATA_KEY.
    wbData.metadata[CHART_SPECS_METADATA_KEY] = pivotChartSpecsToMetadata(
      charts,
      (pivotId) => pivots.find((p) => p.id === pivotId)?.title,
    );
  }, [pictures, pageSetup, printTitles, pageBreaksBySheet, activeSheet, colWidths, rowHeights, hiddenCols, hiddenRows, dataTypes, sheetNames, charts, pivots, hfSettings, workbookTheme, inkStrokesBySheet, drawingCanvasesBySheet]);

  /** Build the downloadable file bytes (permission-filtered, faces c/e).
   * The storage adapter comes from the AdapterRegistry by save format
   * (track 9). Encrypted download always uses xlsx. */
  const buildDownloadBytes = useCallback((format: SaveFormatId = saveFormat): Uint8Array => {
    // Cycle 10 save gating (user's rule — no partial-save path): EVERY
    // serialization (Save, Save As, export, encrypted download, email)
    // funnels through here, and all are blocked until the workbook is
    // 100% loaded, on every host. Serializing mid-load would write
    // unloaded sheets back empty. workbookLoaded is only ever false
    // inside a real open window (gateway async load, desktop IPC load).
    if (!workbookLoadedRef.current) {
      throw new Error('Workbook is still loading — save/export is disabled until the load completes.');
    }
    if (sessionDisconnectedRef.current) {
      throw new Error('Disconnected (idle) — save/export is disabled until a verified reconnect.');
    }
    checkDownloadAllowed();
    const snap = snapshotFiltered(host.snapshot(), (ref) =>
      protection.isHiddenFrom(ref.sheet, ref.row, ref.col, sessionPrincipal),
    );
    const adapter = adapterForSaveFormat(format);
    // Defined names (§3 + defect E1): the ENGINE's live names — carried
    // by the snapshot (imported names, engine-defined names, LAMBDA
    // functions, HF-unbindable names preserved verbatim) — are PRIMARY;
    // the service store's exports contribute only names the engine lacks
    // (Name-Manager definitions live only in the store). Emitting the
    // store list alone was E1: the store is never populated on open, so
    // every save wrote ZERO defined names while formulas still
    // referenced them — #NAME? on reopen, i.e. silent corruption.
    const definedNames = mergeDefinedNames(
      snap.definedNames,
      nameServices.exportToDefinedNames(sheetNames) as DefinedName[],
    );
    const wbData = snapshotToWorkbookData(snap, protection.toMetadata(), definedNames);
    applyClientSaveMetadata(wbData);
    // Defect D4: attach the format store's resolved per-cell formats +
    // styles. Formats are presentation state (never an engine cell
    // property), so the snapshot alone can never carry them — this is
    // the link whose absence dropped every ribbon-applied format.
    applyFormatStoreToWorkbookData(wbData, formats);
    return adapter.write(wbData);
  }, [checkDownloadAllowed, host, protection, sessionPrincipal, saveFormat, sheetNames, nameServices, applyClientSaveMetadata, formats]);

  /**
   * Gateway server-download extras (Cycle 10 defect 2c): the small
   * session payload the engine service merges into its server-side
   * serialization. Built by running the SAME metadata assembly as the
   * in-tab save over an empty workbook shell, then dropping the three
   * raw-part keys the server already holds from its own /load (pivot
   * parts, SmartArt parts, external links — re-sending them would just
   * duplicate megabytes of base64 the server state already carries).
   */
  const buildServerSaveExtras = useCallback((): {
    extraMetadata: Record<string, unknown>;
    definedNames: unknown;
    sheetDims: Record<string, unknown>;
    sheetStyles: Record<string, Record<string, unknown>>;
  } => {
    const shell: { sheets: Array<{ name: string; rows: never[]; colWidths?: Record<string, number>; rowHeights?: Record<string, number>; hiddenCols?: number[]; hiddenRows?: number[] }>; metadata: Record<string, unknown> } = {
      sheets: sheetNames.map((name) => ({ name, rows: [] })),
      metadata: {},
    };
    applyClientSaveMetadata(shell);
    const extraMetadata = { ...shell.metadata };
    delete extraMetadata[PIVOT_PARTS_METADATA_KEY];
    delete extraMetadata[SMARTART_PARTS_METADATA_KEY];
    delete extraMetadata[EXTERNAL_LINKS_METADATA_KEY];
    const sheetDims: Record<string, unknown> = {};
    for (const s of shell.sheets) {
      const dims: Record<string, unknown> = {};
      if (s.colWidths) dims.colWidths = s.colWidths;
      if (s.rowHeights) dims.rowHeights = s.rowHeights;
      if (s.hiddenCols) dims.hiddenCols = s.hiddenCols;
      if (s.hiddenRows) dims.hiddenRows = s.hiddenRows;
      if (Object.keys(dims).length > 0) sheetDims[s.name] = dims;
    }
    // Defect D4: the session's resolved cell styles ride along so the
    // SERVER's serialization carries ribbon-applied formats (the engine
    // service never holds the format store — formats are UI state).
    // Every sheet is reported (empty record included): the server
    // treats a reported sheet's styles as authoritative, so a cleared
    // format clears server-side too. Column formats expand over the
    // sheet's known used range (the server workbook's extent).
    const sheetStyles: Record<string, Record<string, unknown>> = {};
    for (const name of sheetNames) {
      let endRow = -1;
      try {
        endRow = host.getView().usedRange(name)?.endRow ?? -1;
      } catch {
        // No used range (empty sheet): explicit entries still expand.
      }
      const { styles } = formatStoreToSheetData(formats, name, endRow);
      sheetStyles[name] = (styles ?? {}) as Record<string, unknown>;
    }
    return {
      extraMetadata,
      // Defect E1: this is only the name STORE's contribution (names the
      // server engine lacks — Name-Manager definitions). The engine
      // service merges it UNDER its own live snapshot names
      // (engineSvc buildSaveWorkbookData), so an empty store list can no
      // longer zero the server save's defined-names table.
      definedNames: nameServices.exportToDefinedNames(sheetNames),
      sheetDims,
      sheetStyles,
    };
  }, [applyClientSaveMetadata, sheetNames, nameServices, formats, host]);

  /**
   * Fetch the workbook as .xlsx bytes FROM THE SERVER (gateway mode):
   * the engine service serializes its live workbook and streams the
   * bytes back — no snapshot ingest, no in-tab serialization, so a
   * P95-class workbook cannot crash the tab on save (defect 2c).
   * Returns null when not in (non-desktop) gateway mode, so callers
   * fall back to the in-tab path. Throws on gate/transport failure.
   */
  const fetchServerWorkbookBlob = useCallback(async (): Promise<Blob | null> => {
    if (isDesktop() || !isGatewayMode()) return null;
    const gateway = getGatewayClient();
    if (!gateway) return null;
    if (!workbookLoadedRef.current) {
      throw new Error('Workbook is still loading — save/export is disabled until the load completes.');
    }
    if (sessionDisconnectedRef.current) {
      throw new Error('Disconnected (idle) — save/export is disabled until a verified reconnect.');
    }
    // Save interlock: the SERVER serializes its live workbook — defer
    // until any in-flight routed edit's write-through has landed there.
    await awaitEditsSettled();
    checkDownloadAllowed();
    return gateway.engineDownloadXlsx({ filename: 'workbook.xlsx', ...buildServerSaveExtras() });
  }, [checkDownloadAllowed, buildServerSaveExtras, awaitEditsSettled]);

  /**
   * Fetch exported bytes FROM THE SERVER in any save format / scope
   * (Cycle 10 closure): named-range subsets and non-xlsx formats
   * (csv/tsv/ods/xlsb/html) serialize server-side from the live workbook
   * through the same adapters the in-tab save used — no snapshot pull,
   * so these flows survive P95 scale too. Whole-workbook scope carries
   * the same session extras as the xlsx download; named-range scope
   * carries only the client-resolved def (the name store + its
   * resolveForSubject check live client-side; the server re-filters its
   * snapshot per principal). Returns null outside gateway mode.
   */
  const fetchServerExportBlob = useCallback(async (opts: {
    format: SaveFormatId;
    filename: string;
    namedRange?: {
      name: string;
      ref: { sheet: string; startRow: number; startCol: number; endRow: number; endCol: number };
    };
  }): Promise<Blob | null> => {
    if (isDesktop() || !isGatewayMode()) return null;
    const gateway = getGatewayClient();
    if (!gateway) return null;
    if (!workbookLoadedRef.current) {
      throw new Error('Workbook is still loading — save/export is disabled until the load completes.');
    }
    if (sessionDisconnectedRef.current) {
      throw new Error('Disconnected (idle) — save/export is disabled until a verified reconnect.');
    }
    // Save interlock: defer the server-side serialization until any
    // in-flight routed edit has settled on the server.
    await awaitEditsSettled();
    checkDownloadAllowed();
    if (opts.namedRange) {
      return gateway.engineDownload({
        format: opts.format,
        filename: opts.filename,
        scope: 'namedRange',
        namedRange: opts.namedRange,
      });
    }
    return gateway.engineDownload({
      format: opts.format,
      filename: opts.filename,
      ...buildServerSaveExtras(),
    });
  }, [checkDownloadAllowed, buildServerSaveExtras, awaitEditsSettled]);

  /**
   * Gateway-mode library save (Cycle 10 closure): the engine service
   * serializes its live workbook and stores the bytes in the principal's
   * SERVER library store; only entry metadata returns, so neither the
   * manual library save nor autosave round-trips workbook bytes through
   * this tab. The local library mirrors the entry's metadata
   * (backend 'gateway') for the dialog. Returns null outside gateway
   * mode so callers keep the local-bytes path.
   */
  const saveWorkbookToServerLibrary = useCallback(async (target: {
    id?: string;
    name: string;
  }): Promise<LibraryEntry | null> => {
    if (isDesktop() || !isGatewayMode()) return null;
    const gateway = getGatewayClient();
    if (!gateway) return null;
    if (!workbookLoadedRef.current) {
      throw new Error('Workbook is still loading — save/export is disabled until the load completes.');
    }
    if (sessionDisconnectedRef.current) {
      throw new Error('Disconnected (idle) — save/export is disabled until a verified reconnect.');
    }
    // Save interlock: this is BOTH the manual library save and the
    // autosave's gateway path — defer until in-flight edits settle so
    // the server serializes the post-edit workbook.
    await awaitEditsSettled();
    checkDownloadAllowed();
    const { entry } = await gateway.engineLibrarySave({
      ...(target.id ? { id: target.id } : {}),
      name: target.name,
      ...buildServerSaveExtras(),
    });
    return library.upsertRemote({
      id: entry.id,
      name: entry.name,
      owner: sessionPrincipal,
      sizeBytes: entry.sizeBytes,
      modifiedAt: entry.modifiedAt,
    });
  }, [checkDownloadAllowed, buildServerSaveExtras, library, sessionPrincipal, awaitEditsSettled]);

  // Share data-copy import (shell integration): the accept step created
  // the recipient's catalog file and stashed the snapshot; once that
  // file's (blank) workbook has loaded in the grid, write the snapshot
  // into it, save it to the library, link the catalog record to the
  // stored state, and raise the recipient's app copy full-screen.
  // Trigger: the join flow calls shareImportRunnerRef the moment the
  // session's snapshot lands (on web workbookLoaded stays true, so it
  // cannot gate this); the assigning effect below also runs it once in
  // case the join completed first. Idempotent via the started ref +
  // the read-once pending stash.
  const runShareImport = useCallback(async (): Promise<void> => {
    if (!productApi) return;
    // Post-import landing raise: the import step reloaded this page
    // (see the success path below); once THIS page's join completes,
    // raise the recipient's app copy full-screen and clear the debt.
    const landing = readPendingShareLanding();
    if (
      landing &&
      landing.fileId === collabFileIdRef.current &&
      shareJoinCompletedRef.current === landing.fileId
    ) {
      clearPendingShareLanding();
      const spec = artifactStore.all().find((a) => a.id === landing.artifactId) ?? null;
      if (spec) setShareSpec(spec);
      return;
    }
    const pending = readPendingShareImport();
    if (!pending || pending.fileId !== collabFileIdRef.current) return;
    // The join flow is the only trustworthy "this file's workbook is
    // loaded" signal on web — until it lands, stay out of the way (the
    // join invokes the runner itself on completion).
    if (shareJoinCompletedRef.current !== pending.fileId) return;
    if (shareImportStartedRef.current === pending.fileId) return;
    shareImportStartedRef.current = pending.fileId;
    try {
      const sheetNames = host.snapshot().sheets.map((s) => s.name);
      if (!sheetNames.includes(pending.sheet)) {
        if (sheetNames.length === 1) {
          await host.execute({
            cmd: 'renameSheet',
            name: sheetNames[0]!,
            newName: pending.sheet,
          });
        } else {
          await host.execute({ cmd: 'addSheet', name: pending.sheet });
        }
      }
      for (let r = 0; r < pending.cells.length; r++) {
        const rowArr = pending.cells[r] ?? [];
        for (let c = 0; c < rowArr.length; c++) {
          const v = rowArr[c];
          if (v === null || v === undefined) continue;
          await host.execute({
            cmd: 'setCell',
            ref: cellRef(pending.sheet, r, c),
            value: v as never,
          });
        }
      }
      // Persist the imported workbook through the session's DIRECT
      // engine lane: the gateway-proxied library-save forwards the
      // gateway JWT verbatim and the signed-mode engine rejects it
      // (401, verified live 2026-10-22), while the transport's
      // access-token lane works. The catalog record is then linked to
      // the stored entry exactly as the proxied path would have.
      const transport = collabTransportRef.current;
      if (!transport) throw new Error('no collab transport for the share import save');
      const saved = await transport.librarySaveDirect(pending.appName);
      library.upsertRemote({
        id: saved.id,
        name: saved.name,
        owner: sessionPrincipal,
        sizeBytes: saved.sizeBytes,
        modifiedAt: saved.modifiedAt,
      });
      await productApi
        .markOpened(pending.fileId, { libraryEntryId: saved.id, hasStoredState: true })
        .catch(() => undefined);
      clearPendingShareImport();
      // Reload onto the imported state before raising the app: the
      // importing page's remote view does not repaint its own
      // structural ops (verified live — the grid kept showing the
      // blank Sheet1 while the session already held the imported
      // sheet), while a fresh open paints the session snapshot
      // correctly. The landing debt survives the reload in
      // sessionStorage and is paid by the runner branch above.
      writePendingShareLanding({ fileId: pending.fileId, artifactId: pending.artifactId });
      window.location.assign(buildFileUrl(pending.fileId));
    } catch (e) {
      clearPendingShareImport();
      setLastError(
        `Could not finish importing the shared app's data: ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
    }
  }, [host, productApi, artifactStore, library, sessionPrincipal]);

  useEffect(() => {
    shareImportRunnerRef.current = () => {
      void runShareImport();
    };
    void runShareImport();
  }, [runShareImport]);

  /** Trigger a browser download from a Blob (web anchor-click path). */
  const downloadBlobObject = useCallback((blob: Blob, filename: string) => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }, []);

  // ---- Randomize Range (Data > Data Tools) ----
  const handleRandomizeRange = useCallback(() => {
    const used = host.getView().usedRange(activeSheet);
    if (!used) {
      setLastError('Nothing to randomize: the sheet is empty.');
      return;
    }
    runSheetOp('Randomize Range', () =>
      randomizeRange(
        host,
        {
          sheet: activeSheet,
          startRow: used.startRow,
          startCol: used.startCol,
          endRow: used.endRow,
          endCol: used.endCol,
        },
        true,
      ),
    );
    const n = Math.max(0, used.endRow - used.startRow);
    announce(`Randomized ${n} row${n === 1 ? '' : 's'}. Undo to reverse.`);
  }, [runSheetOp, host, activeSheet]);

  // ---- Group-by View (Data > Data Tools) ----
  const handleApplyGroupBy = useCallback(
    (result: { matrix: (string | number | null)[][]; title: string }) => {
      const existing = new Set(visibleSheets);
      let name = result.title.slice(0, 28) || 'GroupBy';
      for (let n = 2; existing.has(name); n++) {
        name = `${result.title.slice(0, 24)} ${n}`;
      }
      const res = host.execute({ cmd: 'addSheet', name });
      if (!res.ok) {
        setLastError(res.error);
        return;
      }
      result.matrix.forEach((row, r) => {
        row.forEach((value, c) => {
          host.execute({ cmd: 'setCell', ref: { sheet: name, row: r, col: c }, value });
        });
      });
      host.execute({ cmd: 'recalculate' });
      setGroupByOpen(false);
      setSheet(name);
      setSel({ row: 0, col: 0 });
      setGridSel(cellSelection(0, 0));
      announce(`Group-by view written to "${name}".`);
    },
    [host, visibleSheets],
  );

  // ---- Email (File > Email, Mail connector) ----
  const handleSendEmail = useCallback(
    async (
      email: WorkbookEmail,
      credential: { accessToken?: string; credentialRef?: string },
    ): Promise<string> => {
      const mode = emailMode ?? 'workbook';
      const filename = mode === 'workbook' ? 'workbook.xlsx' : `${activeSheet}.csv`;
      // Gateway mode (Cycle 10 closure): the attachment is serialized
      // SERVER-side (xlsx whole workbook / csv via the same adapters the
      // in-tab path used — the CSV adapter serializes the first sheet,
      // exactly as buildDownloadBytes('csv') did) and only the finished
      // bytes cross into the tab, because the mail connector itself runs
      // here with the user's credential. No snapshot pull.
      const serverBlob = await fetchServerExportBlob({
        format: mode === 'workbook' ? 'xlsx' : 'csv',
        filename,
      });
      const bytes = serverBlob
        ? new Uint8Array(await serverBlob.arrayBuffer())
        : (await ensureSaveSnapshot(), buildDownloadBytes(mode === 'workbook' ? 'xlsx' : 'csv'));
      const mimeType =
        mode === 'workbook'
          ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
          : 'text/csv';
      const gateway = isGatewayMode() ? getGatewayClient() : null;
      const id = await sendWorkbookEmail({
        email,
        attachment: { filename, mimeType, data: bytes },
        accessToken: credential.accessToken,
        credentialRef: credential.credentialRef,
        resolveCredential:
          credential.credentialRef && gateway
            ? {
                resolveCredential: async (ref: string) =>
                  (await gateway.vaultRetrieve(ref)).secret,
              }
            : undefined,
      });
      announce(`Email sent (message id ${id}).`);
      return id;
    },
    [buildDownloadBytes, ensureSaveSnapshot, emailMode, activeSheet, fetchServerExportBlob],
  );


  /**
   * Download bytes to the user's disk. Web: anchor-click download.
   * Desktop (GAP-3): Electron drops anchor-click downloads silently into
   * ~/Downloads with no dialog, so downloads route through the native
   * Save flow with the suggested filename pre-filled (suggestedName):
   * Download-as-PDF (the only print path), Save-encrypted, per-name
   * DownloadDialog, CSV/TSV/ODS exports, report PDFs.
   */
  const downloadBlob = useCallback(async (bytes: Uint8Array, filename: string, mime: string) => {
    if (isDesktop()) {
      try {
        await desktopSaveBytes(bytes, undefined, filename);
      } catch (e) {
        setLastError(e instanceof Error ? e.message : String(e));
      }
      return;
    }
    const blob = new Blob([bytes as BlobPart], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }, []);

  /**
   * Capped print snapshot (design-docs/print-and-page-layout.md §4): the
   * single snapshot the print preview and Download-as-PDF share, so the
   * preview shows exactly what the PDF contains. The cap keeps a
   * pathological used range from OOMing the tab.
   */
  const printSnapshot = useMemo(() => {
    const view = host.getView();
    const used = view.usedRange(activeSheet);
    if (!used) return null;
    const MAX_PDF_ROWS = 5000;
    const MAX_PDF_COLS = 200;
    const endRow = Math.min(used.endRow, used.startRow + MAX_PDF_ROWS - 1);
    const endCol = Math.min(used.endCol, used.startCol + MAX_PDF_COLS - 1);
    return {
      snapshot: {
        sheet: activeSheet,
        used: { ...used, endRow, endCol },
        rowHeight: (r: number) => rowHeights.get(r) ?? 24,
        colWidth: (c: number) => colWidths.get(c) ?? 96,
      },
      capped: endRow < used.endRow || endCol < used.endCol,
    };
  }, [host, activeSheet, rowHeights, colWidths]);

  /** Display text of one cell — shared by the preview and the PDF. */
  const printCellText = useCallback(
    (row: number, col: number) =>
      formatDisplay(host.getView().readCell(cellRef(activeSheet, row, col)).value),
    [host, activeSheet],
  );

  /**
   * Print-preview pages (File > Print Preview): paginated with the
   * deterministic service engine from the same snapshot Download-as-PDF
   * uses, so preview page breaks can never diverge from the PDF (design
   * §3–§4: Download-as-PDF is the single print path, no separate layout
   * implementation to drift).
   */
  const printDialogPages = useMemo<PaginatedPage[]>(() => {
    if (!printPreviewOpen || !printSnapshot) return [];
    return paginateSheet(
      printSnapshot.snapshot,
      toPrintPageSetup(pageSetup, printTitles),
      pageBreaksBySheet[activeSheet] ?? { rows: [], cols: [] },
    );
  }, [printPreviewOpen, printSnapshot, pageSetup, printTitles, pageBreaksBySheet, activeSheet]);

  /**
   * Native Download-as-PDF (design-docs/print-and-page-layout.md §3): the
   * single print path. Paginates the print snapshot with the deterministic
   * engine (page setup + manual breaks) and renders real PDF bytes —
   * no window.print(), no browser Save-as-PDF involved.
   */
  const handleDownloadPdf = useCallback(() => {
    try {
      // Cycle 10 save gating: PDF is an export — blocked until 100% loaded.
      if (!workbookLoadedRef.current) {
        setLastError('Workbook is still loading — export is disabled until the load completes.');
        return;
      }
      if (!printSnapshot) {
        setLastError('Nothing to print: the sheet is empty.');
        return;
      }
      const bytes = renderSheetPdf({
        snapshot: printSnapshot.snapshot,
        setup: toPrintPageSetup(pageSetup, printTitles),
        breaks: pageBreaksBySheet[activeSheet] ?? { rows: [], cols: [] },
        cellText: printCellText,
        fileName: `${activeSheet}.xlsx`,
        title: `${activeSheet} — Icecream Sheets`,
      });
      downloadBlob(bytes, `${activeSheet}.pdf`, 'application/pdf');
      announce(
        printSnapshot.capped ? 'PDF downloaded (capped at 5000 rows × 200 cols).' : 'PDF downloaded.',
      );
    } catch (e) {
      setLastError(`PDF export failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }, [printSnapshot, pageSetup, printTitles, pageBreaksBySheet, activeSheet, printCellText, downloadBlob]);

  /** Face b: password-on-download — encrypt the file with a password. */
  const handleDownloadEncrypted = useCallback(() => {
    // Cycle 10 save gating (defect D3): the encrypted download is an
    // EXPORT — blocked until the workbook is 100% loaded, exactly like
    // Save. (The submit path's serializers also throw on this gate; the
    // dialog must not even open over a half-loaded workbook.)
    if (!workbookLoadedRef.current) {
      setLastError('Workbook is still loading — save is disabled until the load completes.');
      return;
    }
    setFilePasswordError(null);
    setFilePassword({ mode: 'download', filename: 'workbook.xlsx' });
  }, []);

  const handleFilePasswordSubmit = useCallback(
    async (password: string) => {
      if (!filePassword) return;
      setFilePasswordBusy(true);
      setFilePasswordError(null);
      try {
        if (filePassword.mode === 'open' && filePassword.buffer) {
          const { bytes } = await decryptFileWithPassword(filePassword.buffer, password);
          const remote = filePassword.remote === true;
          setFilePassword(null);
          // Gateway mode: upload the decrypted XLSX to the engine service.
          if (remote) await openRemoteBuffer(bytes, filePassword.filename ?? 'workbook.xlsx');
          else openXlsxBuffer(bytes, filePassword.filename ?? 'workbook.xlsx');
        } else {
          // Gateway mode: encrypt the SERVER-serialized bytes (defect
          // 2c — the encrypted envelope is built client-side per design
          // §4, but its plaintext no longer requires a snapshot ingest;
          // only the compressed .xlsx crosses into the tab). Local /
          // desktop keep the in-tab build.
          const serverBlob = await fetchServerWorkbookBlob();
          const xlsx = serverBlob
            ? new Uint8Array(await serverBlob.arrayBuffer())
            : (await ensureSaveSnapshot(), buildDownloadBytes('xlsx'));
          const enc = await encryptFileWithPassword(xlsx, password, 'workbook.xlsx');
          setFilePassword(null);
          downloadBlob(enc, encryptedFilename('workbook.xlsx'), 'application/json');
          setLastError(null);
        }
      } catch (e) {
        setFilePasswordError(e instanceof Error ? e.message : String(e));
      } finally {
        setFilePasswordBusy(false);
      }
    },
    [filePassword, openXlsxBuffer, buildDownloadBytes, ensureSaveSnapshot, downloadBlob, fetchServerWorkbookBlob],
  );

  /**
   * Build the downloadable bytes for one defined name (Cycle 7 per-name
   * download filtering). Same gates as the whole-workbook path:
   * checkDownloadAllowed() for the workbook-level authorize + sensitivity
   * labels, then the snapshot is permission-filtered so cells hidden from
   * the subject are dropped from the file (fail closed, design §6). The
   * name itself must already be resolved for the subject (unknown / denied /
   * dangling rejected by the caller — named-ranges §4).
   */
  const buildNamedRangeDownloadBytes = useCallback((def: NamedRangeDef): Uint8Array => {
    // Cycle 10 save gating (no partial-save path): named-range export is
    // an export like any other — blocked until 100% loaded.
    if (!workbookLoadedRef.current) {
      throw new Error('Workbook is still loading — save/export is disabled until the load completes.');
    }
    if (sessionDisconnectedRef.current) {
      throw new Error('Disconnected (idle) — save/export is disabled until a verified reconnect.');
    }
    checkDownloadAllowed();
    const snap = snapshotFiltered(host.snapshot(), (ref) =>
      protection.isHiddenFrom(ref.sheet, ref.row, ref.col, sessionPrincipal),
    );
    const wbData = namedRangeToWorkbookData(snap, def, () => false);
    const adapter = adapterForSaveFormat(saveFormat);
    return adapter.write(wbData);
  }, [checkDownloadAllowed, host, protection, sessionPrincipal, saveFormat]);

  /** File > Download (and Ctrl+S / Save command): open the download dialog
   * so the user can pick the scope — whole workbook or one named range. */
  const handleDownload = useCallback(() => {
    // Cycle 10 save gating (defect D3 audit): the download dialog is the
    // entry to whole-workbook AND named-range export — it must not open
    // while the workbook is loading (the ribbon Save button is disabled
    // then, but Ctrl+S / the command palette also land here). The
    // confirm handler's serializers gate as a second line of defense.
    if (!workbookLoadedRef.current) {
      setLastError('Workbook is still loading — save is disabled until the load completes.');
      return;
    }
    setDownloadDialogOpen(true);
  }, []);

  const handleConfirmDownload = useCallback(async (scope: DownloadScope) => {
    try {
      // Design §6: downloads respect permissions (authorize() gate +
      // sensitivity labels); cells the subject cannot read are dropped from
      // the file entirely (never leaked as blanks).
      const fmt = saveFormatById(saveFormat);
      // Gateway mode, whole workbook (ANY format): the SERVER serializes
      // and streams the bytes back (defect 2c for xlsx; Cycle 10 closure
      // for csv/tsv/ods/xlsb/html) — no snapshot pull, no in-tab
      // serialization, so P95-class saves cannot crash the tab.
      if (scope.kind === 'workbook') {
        const blob = await fetchServerExportBlob({
          format: saveFormat,
          filename: `workbook.${fmt.ext}`,
        });
        if (blob) {
          downloadBlobObject(blob, `workbook.${fmt.ext}`);
          setDownloadDialogOpen(false);
          setLastError(null);
          return;
        }
      }
      if (scope.kind === 'namedRange') {
        const store = nameServices.services.ranges;
        const def = store.list().find((d) => d.id === scope.nameId);
        if (!def) throw new Error('Download blocked: the selected name no longer exists.');
        // Named-ranges §4: reading through a name enforces the same
        // authorize() checks as addressing the cells directly. Fail closed:
        // a name the subject cannot read blocks the download entirely.
        const res = store.resolveForSubject(
          def.name,
          sessionPrincipal,
          def.scope.kind === 'sheet' ? def.scope.sheet : undefined,
        );
        if (res.status === 'unknown') {
          throw new Error(`Download blocked: unknown defined name "${def.name}".`);
        }
        if (res.status === 'dangling') {
          throw new Error(`Download blocked: "${def.name}" no longer refers to any cells (#REF!).`);
        }
        if (res.status === 'denied') {
          throw new Error(`Download blocked: you don't have read access to "${def.name}".`);
        }
        // Gateway mode (Cycle 10 closure): the subset is built SERVER-side
        // from the resolved def (res.def.ref) over the server's
        // permission-filtered snapshot — no snapshot pull in the tab.
        if (res.def.ref) {
          const blob = await fetchServerExportBlob({
            format: saveFormat,
            filename: `${sanitizeSheetName(def.name, 'range')}.${fmt.ext}`,
            namedRange: { name: res.def.name, ref: res.def.ref },
          });
          if (blob) {
            downloadBlobObject(blob, `${sanitizeSheetName(def.name, 'range')}.${fmt.ext}`);
            announce(`Downloaded named range "${def.name}".`);
            setDownloadDialogOpen(false);
            setLastError(null);
            return;
          }
        }
        // Local/desktop fallback: pull the authoritative snapshot before
        // the sync builder below reads host.snapshot().
        await ensureSaveSnapshot();
        const bytes = buildNamedRangeDownloadBytes(res.def);
        downloadBlob(bytes, `${sanitizeSheetName(def.name, 'range')}.${fmt.ext}`, fmt.mime);
        announce(`Downloaded named range "${def.name}".`);
      } else {
        // Local/desktop fallback path.
        await ensureSaveSnapshot();
        const bytes = buildDownloadBytes();
        downloadBlob(bytes, `workbook.${fmt.ext}`, fmt.mime);
      }
      setDownloadDialogOpen(false);
      setLastError(null);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg !== 'Download cancelled.') setLastError(msg);
      // Keep the dialog open so the user can pick a different scope.
    }
  }, [buildDownloadBytes, buildNamedRangeDownloadBytes, ensureSaveSnapshot, downloadBlob, nameServices, sessionPrincipal, saveFormat, announce, fetchServerExportBlob, downloadBlobObject]);

  /**
   * Desktop File → Open (native dialog in the main process; the xlsx
   * adapter runs in the renderer via the shared adapter registry).
   */
  const handleDesktopOpen = useCallback(async () => {
    try {
      const picked = await desktopPickOpen();
      if (!picked) return;
      if (isEncryptedFile(picked.bytes)) {
        setFilePasswordError(null);
        setFilePassword({ mode: 'open', buffer: picked.bytes, filename: picked.path });
        return;
      }
      openXlsxBuffer(picked.bytes, picked.path);
      setDesktopPath(picked.path);
      // GAP-10: picked through the native dialog — main trusts this path.
      desktopPathTrustedRef.current = true;
      setLibraryId(null);
      setReadOnly(false);
      setSaveState('saved');
      setLastError(null);
    } catch (e) {
      setLastError(e instanceof Error ? e.message : String(e));
    }
  }, [openXlsxBuffer]);

  /**
   * Desktop File → Save. Writes in place when the workbook already has a
   * native path, otherwise shows the Save dialog.
   */
  const handleDesktopSave = useCallback(async () => {
    // Cycle 10 save gating (user's rule): manual Save is blocked until
    // the workbook is 100% loaded — no partial-save path exists.
    if (!workbookLoadedRef.current) {
      setLastError('Workbook is still loading — save is disabled until the load completes.');
      return;
    }
    // Save interlock (Cycle 10 closure): DEFER while a routed edit is
    // in flight — the click is honored, just after the edit settles, so
    // the bytes written are the post-edit state (dirty is preserved
    // until then; ensureSaveSnapshot re-checks the interlock too).
    await awaitEditsSettled();
    try {
      // Direct streaming save (direct-save pass): for .xlsx the MAIN
      // process serializes its LIVE engine model through the shared
      // streaming serializer — this renderer never snapshots or
      // serializes on this path (no ensureSaveSnapshot /
      // buildDownloadBytes). A throw is a save error (surfaced below,
      // destination untouched) — never a silent fallback.
      if (saveFormat === 'xlsx') {
        // Dirty-race guard: the renderer stays live while main
        // serializes, so an edit can land during this save. It is NOT
        // in the file (main's synchronous serialize pins the settled
        // pre-edit state; executes queue behind it) — capture the
        // dirty epoch + watch the edit-flight tracker, and on success
        // mark 'saved' ONLY when neither moved.
        const epochAtSaveStart = dirtyEpochRef.current;
        let flightChanges = 0;
        const unsubFlight = subscribeEditFlightChanges(host, () => {
          flightChanges++;
        });
        let direct: Awaited<ReturnType<typeof desktopSaveXlsxDirect>>;
        try {
          direct = await desktopSaveXlsxDirect(
            buildServerSaveExtras(),
            desktopPath ?? undefined,
          );
        } finally {
          unsubFlight();
        }
        if (direct !== null) {
          if (direct.path) {
            setDesktopPath(direct.path);
            // GAP-10: a dialog-confirmed (or trusted direct) save establishes
            // the main process's trusted dir — this path is now safe for
            // silent auto-save. GAP-2: Save clears the dirty indicator —
            // unless an edit landed during the save (race guard above):
            // then the workbook stays dirty so autosave re-fires for it.
            desktopPathTrustedRef.current = true;
            setSaveState(
              flightChanges === 0 &&
                dirtyEpochRef.current === epochAtSaveStart &&
                !hostHasInFlightEdits(host)
                ? 'saved'
                : 'dirty',
            );
            setLastError(null);
          }
          return;
        }
        console.warn(
          '[desktop save] direct streaming save unavailable (bridge missing) — falling back to renderer serialization',
        );
      }
      await ensureSaveSnapshot();
      const bytes = buildDownloadBytes();
      const saved = await desktopSaveBytes(bytes, desktopPath ?? undefined);
      if (saved) {
        setDesktopPath(saved);
        // GAP-10: a dialog-confirmed (or trusted direct) save establishes
        // the main process's trusted dir — this path is now safe for
        // silent auto-save. GAP-2: Save clears the dirty indicator.
        desktopPathTrustedRef.current = true;
        setSaveState('saved');
        setLastError(null);
      }
    } catch (e) {
      setLastError(e instanceof Error ? e.message : String(e));
    }
  }, [buildDownloadBytes, ensureSaveSnapshot, desktopPath, awaitEditsSettled, buildServerSaveExtras, saveFormat]);

  /**
   * Desktop File → Save As (GAP-7). Saves with NO suggested path, so the
   * main process shows the native Save dialog.
   */
  const handleDesktopSaveAs = useCallback(async () => {
    // Cycle 10 save gating (user's rule): Save As is blocked until the
    // workbook is 100% loaded — no partial-save path exists.
    if (!workbookLoadedRef.current) {
      setLastError('Workbook is still loading — save is disabled until the load completes.');
      return;
    }
    // Save interlock (Cycle 10 closure): DEFER while a routed edit is
    // in flight, exactly like Save — the dialog opens after settle.
    await awaitEditsSettled();
    try {
      // Direct streaming save (direct-save pass): same live-model path
      // as Save, with NO suggested path so main shows the Save dialog.
      // A throw surfaces as the save error below — no silent fallback.
      if (saveFormat === 'xlsx') {
        // Dirty-race guard (same as Save): edits landing while the
        // dialog/serialize is in flight — including during the dialog,
        // before main's serializer pins its state — keep the workbook
        // dirty unless they provably settled into the serialized state:
        // only an unmoved epoch + unmoved flight tracker + nothing in
        // flight at completion may mark 'saved'.
        const epochAtSaveStart = dirtyEpochRef.current;
        let flightChanges = 0;
        const unsubFlight = subscribeEditFlightChanges(host, () => {
          flightChanges++;
        });
        let direct: Awaited<ReturnType<typeof desktopSaveXlsxDirect>>;
        try {
          direct = await desktopSaveXlsxDirect(buildServerSaveExtras(), undefined);
        } finally {
          unsubFlight();
        }
        if (direct !== null) {
          if (direct.path) {
            setDesktopPath(direct.path);
            // GAP-10: the dialog-confirmed save establishes the trusted dir;
            // GAP-2: Save As clears the dirty indicator too — subject to
            // the race guard above.
            desktopPathTrustedRef.current = true;
            setSaveState(
              flightChanges === 0 &&
                dirtyEpochRef.current === epochAtSaveStart &&
                !hostHasInFlightEdits(host)
                ? 'saved'
                : 'dirty',
            );
            setLastError(null);
          }
          return;
        }
        console.warn(
          '[desktop save] direct streaming save unavailable (bridge missing) — falling back to renderer serialization',
        );
      }
      await ensureSaveSnapshot();
      const bytes = buildDownloadBytes();
      const saved = await desktopSaveBytes(bytes);
      if (saved) {
        setDesktopPath(saved);
        // GAP-10: the dialog-confirmed save establishes the trusted dir;
        // GAP-2: Save As clears the dirty indicator too.
        desktopPathTrustedRef.current = true;
        setSaveState('saved');
        setLastError(null);
      }
    } catch (e) {
      setLastError(e instanceof Error ? e.message : String(e));
    }
  }, [buildDownloadBytes, ensureSaveSnapshot, awaitEditsSettled, buildServerSaveExtras, saveFormat]);

  /**
   * Desktop OS-triggered open (GAP-4: double-click / open-with). Bytes
   * arrive with the `icecream:open-path` event; the workbook loads through
   * the existing openXlsxBuffer flow.
   */
  const handleDesktopOpenPath = useCallback(
    (info: { path: string; bytes: Uint8Array }) => {
      try {
        if (isEncryptedFile(info.bytes)) {
          setFilePasswordError(null);
          setFilePassword({ mode: 'open', buffer: info.bytes, filename: info.path });
          return;
        }
        openXlsxBuffer(info.bytes, info.path);
        setDesktopPath(info.path);
        // GAP-10: OS-handed open — main trusts this path.
        desktopPathTrustedRef.current = true;
        setLibraryId(null);
        setReadOnly(false);
        setSaveState('saved');
        setLastError(null);
      } catch (e) {
        setLastError(e instanceof Error ? e.message : String(e));
      }
    },
    [openXlsxBuffer],
  );

  // Late-bound handler refs for the global key handler below (declared
  // before the handlers to avoid TDZ; the key handler is registered once).
  const handleDownloadRef = useRef(handleDownload);
  handleDownloadRef.current = handleDownload;
  const handleDesktopSaveRef = useRef(handleDesktopSave);
  handleDesktopSaveRef.current = handleDesktopSave;
  // Fresh saveState for the desktop dirty-guard subscription (GAP-6),
  // which is registered once and must not close over stale state.
  const saveStateRef = useRef(saveState);
  saveStateRef.current = saveState;

  // Desktop native File menu items (main.ts buildMenu) route here.
  // signalDesktopRendererReady (GAP-9) is called AFTER subscribing, so any
  // main→renderer events queued before the renderer was listening (menu
  // clicks, OS file opens) flush into live listeners.
  useEffect(() => {
    if (!isDesktop()) return undefined;
    const offOpen = onDesktopMenuOpen(() => void handleDesktopOpen());
    const offSave = onDesktopMenuSave(() => void handleDesktopSave());
    const offSaveAs = onDesktopMenuSaveAs(() => void handleDesktopSaveAs());
    const offPath = onDesktopOpenPath((info) => handleDesktopOpenPath(info));
    const offPrefs = onDesktopMenuPreferences(() => setSettingsOpen(true));
    const offHelp = onDesktopMenuHelp(() => setDesktopHelpOpen(true));
    // GAP-6: File → New Workbook asks here before main reloads. Fresh
    // saveState via saveStateRef (registered once). main fail-closes when
    // the answer never arrives, so a hung renderer can never wipe work.
    const offConfirmNew = onDesktopConfirmNew(async () => {
      if (saveStateRef.current !== 'dirty') return true;
      return window.confirm('You have unsaved changes. Discard them and start a new workbook?');
    });
    signalDesktopRendererReady();
    return () => {
      offOpen();
      offSave();
      offSaveAs();
      offPath();
      offPrefs();
      offHelp();
      offConfirmNew();
    };
  }, [handleDesktopOpen, handleDesktopSave, handleDesktopSaveAs, handleDesktopOpenPath]);

  // GAP-6: native-window dirty guard. beforeunload fires for Cmd+Q / the
  // close button on desktop; New Workbook's reload is covered by the
  // renderer round-trip above (Electron reload skips beforeunload).
  // Desktop-only BY DESIGN: web auto-save covers library workbooks, and
  // web users close tabs often enough that a prompt there is noise.
  useEffect(() => {
    if (!isDesktop()) return undefined;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (saveStateRef.current === 'dirty') {
        e.preventDefault();
        // Legacy Chrome/Electron requires returnValue to show the prompt.
        e.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, []);

  // Cycle 10 desktop: MCP (:8106) now serves the MAIN-process host
  // directly (the workbook lives there) — the old renderer forward
  // handler is retired. Protection enforcement lives in the main-process
  // host too: keep its ProtectionManager in sync whenever the renderer's
  // protection state changes (open hydration bumps protectionTick, as do
  // protect/unprotect actions). Fires once on mount with the initial
  // state, so main always has a current policy.
  useEffect(() => {
    if (!isDesktop()) return undefined;
    const ipc = getHost();
    if (ipc instanceof IpcEngineHost) {
      void ipc.setProtectionIpc(protection.toMetadata()).catch(() => undefined);
    }
    return undefined;
  }, [protectionTick, protection]);

  /**
   * Workbook library (platform-shell.md §2): open a library entry by id —
   * bytes come from the library's bytes backend (IndexedDB / memory).
   */
  const handleLibraryOpenEntry = useCallback(
    async (entry: LibraryEntry) => {
      try {
        // Gateway-stored entries (Cycle 10 closure): the bytes live in
        // the engine service's library store — fetch them and open
        // through the remote (server-side) open path.
        if (entry.backend === 'gateway' && isGatewayMode() && !isDesktop()) {
          const gateway = getGatewayClient();
          if (gateway) {
            const blob = await gateway.engineLibraryBytes(entry.id);
            const bytes = new Uint8Array(await blob.arrayBuffer());
            if (bytes.length === 0) throw new Error('The stored workbook is empty.');
            await openRemoteBuffer(bytes, entry.name);
            // Bind the fresh server session to this entry: server
            // AutoSave checkpoints then commit into the user's file
            // itself, not only the session-internal autosave entry.
            void gateway.engineBindLibrary(entry.id, entry.name).catch(() => undefined);
            setLibraryId(entry.id);
            setDesktopPath(null);
            setLibraryOpen(false);
            setLastError(null);
            return;
          }
        }
        const bytes = await library.open(entry.id);
        if (!bytes) {
          setLastError(`Could not read "${entry.name}" from the workbook library.`);
          return;
        }
        if (isEncryptedFile(bytes)) {
          setFilePasswordError(null);
          setFilePassword({ mode: 'open', buffer: bytes, filename: entry.name });
          setLibraryOpen(false);
          return;
        }
        openXlsxBuffer(bytes, entry.name);
        setLibraryId(entry.id);
        setDesktopPath(null);
        setLibraryOpen(false);
        setLastError(null);
      } catch (e) {
        setLastError(e instanceof Error ? e.message : String(e));
      }
    },
    [library, openXlsxBuffer, openRemoteBuffer],
  );

  /**
   * "Open from URL": fetch a spreadsheet file over HTTP and open it exactly
   * like a local file (same adapter, same format/type/dimension seeding).
   * The workbook opens read-only (no save target): Save is disabled and no
   * auto-save runs. CORS failures surface a clear error.
   */
  const handleOpenFromUrl = useCallback(
    async (url: string) => {
      setOpenFromUrlOpen(false);
      try {
        setLastError(null);
        announce('Fetching workbook from URL…');
        let resp: Response;
        try {
          resp = await fetch(url);
        } catch (e) {
          // Network failure or CORS block: fetch rejects with TypeError.
          throw new Error(
            `Could not fetch the file. The server may not allow cross-origin requests (CORS). (${e instanceof Error ? e.message : String(e)})`,
          );
        }
        if (!resp.ok) {
          throw new Error(`Server returned ${resp.status} ${resp.statusText}.`);
        }
        const buf = new Uint8Array(await resp.arrayBuffer());
        if (buf.length === 0) throw new Error('The downloaded file is empty.');
        // Derive a filename for adapter selection from the URL path.
        const pathName = new URL(url).pathname;
        const filename = pathName.split('/').pop() || 'workbook.xlsx';
        openXlsxBuffer(buf, filename);
        setReadOnly(true);
        setSaveState('saved');
        announce(`Opened ${filename} from URL (read-only).`);
      } catch (e) {
        setLastError(e instanceof Error ? e.message : String(e));
      }
    },
    [openXlsxBuffer],
  );
  /**
   * "Open data source" (core architecture): materialize a connector table as
   * a new sheet in the typed computational view, then persist the connector
   * spec as a source binding so Refresh can re-fetch it later. Formulas,
   * charts and pivots work over the sheet like any other.
   */
  const handleOpenDataSource = useCallback(
    async (spec: ConnectorSpec, table: TableData) => {
      try {
        const name = uniqueSheetName(sheetNames, spec.label);
        await writeTableToNewSheet(host, name, table);
        // Seed layer-2 data-type metadata from the connector schema so typed
        // columns get sensible default formats (date → Date, etc.). This is
        // metadata only: it never touches values or formulas.
        setDataTypes((prev) =>
          setColumnDataTypes(prev, name, table.types as ColumnDataType[]),
        );
        const binding: SourceBinding = {
          id: name,
          sheetName: name,
          spec,
          lastRefresh: new Date().toISOString(),
          rowCount: table.rows.length + 1,
          colCount: table.columns.length,
        };
        const next = [...sourceBindings.filter((b) => b.sheetName !== name), binding];
        persistDataSourceBindings(next);
        setSourceBindings(next);
        setSheet(name);
        setSel({ row: 0, col: 0 });
      setGridSel(cellSelection(0, 0));
        setDataSourceOpen(false);
        setLastError(null);
        announce(`Opened ${spec.label} as sheet "${name}" (${table.rows.length} rows).`);
      } catch (e) {
        setLastError(e instanceof Error ? e.message : String(e));
      }
    },
    [host, sheetNames, sourceBindings],
  );

  /** Re-fetch one binding and atomically swap its sheet's data region. */
  const refreshOneBinding = useCallback(
    async (binding: SourceBinding): Promise<SourceBinding> => {
      const table = await dataSourceRegistry.fetch(binding.spec, buildConnectorDeps(getGatewayClient()));
      const plan = planSheetRefresh(binding.rowCount, binding.colCount, table);
      await applyRefreshPlan(host, binding.sheetName, plan);
      // Drop stale formula-text overlays for the rewritten region.
      setFormulaTexts((prev) => {
        const next = new Map(prev);
        for (const key of [...next.keys()]) {
          if (key.startsWith(`${binding.sheetName}:`)) next.delete(key);
        }
        return next;
      });
      return {
        ...binding,
        lastRefresh: new Date().toISOString(),
        rowCount: plan.rowCount,
        colCount: plan.colCount,
      };
    },
    [host],
  );

  const storeRefreshedBindings = useCallback((updated: SourceBinding[]) => {
    persistDataSourceBindings(updated);
    setSourceBindings(updated);
  }, []);

  /** Refresh the connected data source feeding a sheet (default: active sheet). */
  const handleRefreshDataSource = useCallback(
    async (sheetName?: string) => {
      const target = sheetName ?? activeSheet;
      const binding = bindingForSheet(sourceBindings, target);
      if (!binding) {
        setLastError(`"${target}" has no connected data source.`);
        return;
      }
      try {
        const updated = await refreshOneBinding(binding);
        storeRefreshedBindings(
          sourceBindings.map((b) => (b.sheetName === binding.sheetName ? updated : b)),
        );
        setLastError(null);
        announce(`Refreshed "${binding.sheetName}" from ${binding.spec.label}.`);
      } catch (e) {
        setLastError(e instanceof Error ? e.message : String(e));
      }
    },
    [activeSheet, sourceBindings, refreshOneBinding, storeRefreshedBindings],
  );

  /** Re-fetch every connected data source; reports per-source failures. */
  const handleRefreshAllDataSources = useCallback(async () => {
    if (sourceBindings.length === 0) {
      setLastError('No connected data sources to refresh.');
      return;
    }
    const failures: string[] = [];
    const next = [...sourceBindings];
    for (let i = 0; i < next.length; i++) {
      const binding = next[i] as SourceBinding;
      try {
        next[i] = await refreshOneBinding(binding);
      } catch (e) {
        failures.push(`"${binding.sheetName}": ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    storeRefreshedBindings(next);
    if (failures.length > 0) {
      setLastError(`Refresh failed for ${failures.length} source(s): ${failures.join('; ')}`);
    } else {
      setLastError(null);
      announce(`Refreshed ${next.length} connected data source(s).`);
    }
  }, [sourceBindings, refreshOneBinding, storeRefreshedBindings]);

  /** Sheet-tab badges for connected sources (icon + tooltip). */
  const sourceBadgeMap = useMemo(() => {
    const m = new Map<string, string>();
    for (const b of sourceBindings) {
      let kindLabel: string = b.spec.kind;
      try {
        kindLabel = dataSourceRegistry.get(b.spec.kind as ConnectorKind).displayName;
      } catch {
        // Unknown kind (custom connector not registered here) — show the id.
      }
      m.set(
        b.sheetName,
        `Connected source: ${b.spec.label} (${kindLabel}) · refreshed ${timeAgo(b.lastRefresh)}`,
      );
    }
    return m;
  }, [sourceBindings]);


  /**
   * Save the current workbook into the library (New lifecycle): updates
   * the entry in place when it was opened from the library, otherwise
   * creates a new entry.
   */
  const handleLibrarySave = useCallback(
    async (name: string): Promise<LibraryEntry | null> => {
      // Cycle 10 save gating (defect D3 audit): library save is a save —
      // blocked until the workbook is 100% loaded. (It was already
      // fail-closed downstream: buildDownloadBytes /
      // saveWorkbookToServerLibrary throw on this gate. This early check
      // keeps the refusal immediate and the message consistent.)
      if (!workbookLoadedRef.current) {
        setLastError('Workbook is still loading — save is disabled until the load completes.');
        return null;
      }
      try {
        // Save interlock (Cycle 10 closure): manual library save DEFERS
        // while a routed edit is in flight (the gateway/local paths
        // below re-check via saveWorkbookToServerLibrary /
        // ensureSaveSnapshot, so the serialized bytes are post-edit).
        await awaitEditsSettled();
        const existing = libraryId ? library.get(libraryId) : undefined;
        // Gateway mode (Cycle 10 closure): bytes are produced AND stored
        // server-side; the tab only mirrors the entry metadata.
        const serverEntry = await saveWorkbookToServerLibrary({
          ...(existing && !existing.trashed ? { id: existing.id } : {}),
          name: existing && !existing.trashed ? existing.name : name,
        });
        if (serverEntry) {
          setLibraryId(serverEntry.id);
          setLastError(null);
          return serverEntry;
        }
        await ensureSaveSnapshot();
        const bytes = buildDownloadBytes();
        let entry: LibraryEntry | null;
        if (existing && !existing.trashed) {
          await library.updateBytes(existing.id, bytes);
          entry = library.get(existing.id) ?? null;
        } else {
          entry = await library.create(name, bytes, sessionPrincipal, 'local');
          setLibraryId(entry.id);
        }
        setLastError(null);
        return entry;
      } catch (e) {
        setLastError(e instanceof Error ? e.message : String(e));
        return null;
      }
    },
    [buildDownloadBytes, ensureSaveSnapshot, library, libraryId, sessionPrincipal, saveWorkbookToServerLibrary, awaitEditsSettled],
  );

  /**
   * Auto-save: when the workbook is writable and has a save target — a
   * library entry (web), or a native file path (desktop, GAP-2) — a
   * committed edit marks it dirty; 2s after the last edit the workbook
   * is saved silently and the status bar indicator updates.
   * Read-only workbooks never auto-save (no save target).
   *
   * SAVE INTERLOCK (Cycle 10 closure): the timer is NOT gated on
   * in-flight edits up front — a server-routed edit can still be
   * awaiting its ack when the 2s debounce fires. Instead, the fired
   * timer DEFERS: it waits for the edit to settle before flipping to
   * 'saving' or serializing anything, then saves the post-edit state
   * immediately. The dirty flag is preserved throughout the deferral
   * (never dropped, never marked clean early), and if another edit is
   * in flight by the time the save lands, the workbook stays dirty so
   * the effect re-arms and saves again after that edit settles.
   */
  useEffect(() => {
    // Cycle 10 save gating: no autosave while the workbook is loading —
    // the timer fires on its own and would serialize a half-built model.
    if (saveState !== 'dirty' || readOnly || !workbookLoaded || sessionDisconnected) return undefined;
    // Gateway mode (Addendum 6): AUTOSAVE IS SERVER-SIDE ONLY. The
    // engine service's scheduler flushes batches itself; this client
    // NEVER calls a save on a timer here. This effect is a STATUS
    // POLL ONLY: it reads the server's live-vs-stored revisions and
    // displays the outcome (Saved ⇔ storageRevision == liveRevision
    // && !extrasDirty). The epoch/flight guard mirrors the desktop
    // poll: an edit in flight toward the server is not yet in its
    // liveRevision, so a caught-up read must not win that race.
    if (!isDesktop() && isGatewayMode()) {
      const gateway = getGatewayClient();
      if (!gateway) return undefined;
      let cancelled = false;
      const poll = async (): Promise<void> => {
        // Phase 2 (Worker F, defect F3): while the SSE collab channel
        // is connected, save status arrives as `status` events (design
        // doc §8 — the channel is always on; Worker B wired onStatus to
        // the same indicator). The proxied poll below targets the
        // gateway's proxy session, which does not exist for a file
        // session in signed mode, so it can only 401 — skip it and let
        // the SSE status drive Saving…/Saved.
        if (collabTransportRef.current?.connectionState === 'connected') return;
        const epochAtPollStart = dirtyEpochRef.current;
        try {
          const st = await gateway.engineSaveStatus();
          if (cancelled) return;
          if (
            st.storageRevision === st.liveRevision &&
            !st.extrasDirty &&
            dirtyEpochRef.current === epochAtPollStart &&
            !hostHasInFlightEdits(host)
          ) {
            setSaveState('saved');
          }
        } catch {
          // Status unavailable: stay dirty; a later poll retries.
        }
      };
      void poll();
      const interval = setInterval(() => {
        void poll();
      }, 2000);
      return () => {
        cancelled = true;
        clearInterval(interval);
      };
    }
    if (libraryId) {
      const timer = setTimeout(async () => {
        // Interlock deferral: hold (still dirty) until edits settle.
        await awaitEditsSettled();
        setSaveState('saving');
        try {
          // Gateway mode (Cycle 10 closure): autosave serializes + stores
          // server-side — no snapshot pull, no bytes through the tab.
          const serverEntry = await saveWorkbookToServerLibrary({
            id: libraryId,
            name: library.get(libraryId)?.name ?? 'workbook.xlsx',
          });
          if (!serverEntry) {
            await ensureSaveSnapshot();
            const bytes = buildDownloadBytes();
            await library.updateBytes(libraryId, bytes);
          }
          // A newer edit in flight is not covered by this save: stay
          // dirty so the deferred save fires again when it settles.
          setSaveState(hostHasInFlightEdits(host) ? 'dirty' : 'saved');
        } catch (e) {
          setSaveState('error');
          setLastError(e instanceof Error ? e.message : String(e));
        }
      }, 2000);
      return () => clearTimeout(timer);
    }
    // Desktop (GAP-2): no library entry, but the native path set by
    // File > Open / drop / Save / Save As is the save target. Same 2s
    // debounce, same status-bar indicator; a cancelled Save dialog (no
    // saved path) leaves it dirty, and an untrusted path (GAP-5 drop,
    // main hasn't seen it through a dialog — GAP-10) is skipped so
    // auto-save never pops a surprise modal.
    // Cycle 10 save gating (user's rule): auto-save is blocked until the
    // workbook is 100% loaded — the workbookLoaded dep re-arms the
    // effect when the load completes.
    if (isDesktop() && desktopPath && desktopPathTrustedRef.current && workbookLoaded) {
      // Autosave ownership (Addendum 6): for .xlsx the MAIN process
      // owns autosave entirely — its scheduler checkpoints journaled
      // ops + synced extras to this path on the settle cadence. The
      // renderer NO LONGER initiates any flush or serialization here:
      // this effect is a STATUS POLL ONLY. It reads main's save status
      // (~2 s while dirty) and displays the outcome: storageRevision
      // === liveRevision && !extrasDirty → 'saved'; anything else
      // stays 'dirty' (storage behind; main's next checkpoint batch
      // closes the gap and a later poll observes it). Manual Save
      // (handleDesktopSave) remains the only client-initiated save.
      if (saveFormat === 'xlsx') {
        let cancelled = false;
        const poll = async (): Promise<void> => {
          // An edit still in flight toward main is not yet in main's
          // journal — its revisions would read "caught up" early.
          // Capture the dirty epoch and require it (plus the flight
          // tracker) to stand still across the status read, the same
          // dirty-race guard as manual Save.
          const epochAtPollStart = dirtyEpochRef.current;
          let status: Awaited<ReturnType<typeof desktopSaveStatus>>;
          try {
            status = await desktopSaveStatus();
          } catch {
            status = null;
          }
          if (cancelled || !status) return;
          if (
            status.storageRevision === status.liveRevision &&
            !status.extrasDirty &&
            dirtyEpochRef.current === epochAtPollStart &&
            !hostHasInFlightEdits(host)
          ) {
            setSaveState('saved');
          }
        };
        void poll();
        const interval = setInterval(() => {
          void poll();
        }, 2000);
        return () => {
          cancelled = true;
          clearInterval(interval);
        };
      }
      // Non-xlsx formats have no main-process checkpoint serializer
      // (the direct path is xlsx-only, per the direct-save brief): the
      // legacy renderer-bytes autosave below remains for them alone.
      const timer = setTimeout(async () => {
        // Interlock deferral (desktop autosave, same rule as web):
        // hold (still dirty) until any in-flight IPC edit settles.
        await awaitEditsSettled();
        setSaveState('saving');
        try {
          await ensureSaveSnapshot();
          const bytes = buildDownloadBytes();
          const saved = await desktopSaveBytes(bytes, desktopPath);
          if (saved) {
            setDesktopPath(saved);
            // A newer edit in flight is not covered by this save: stay
            // dirty so the deferred save fires again when it settles.
            setSaveState(hostHasInFlightEdits(host) ? 'dirty' : 'saved');
          } else {
            // Dialog cancelled: stay dirty so the user can retry.
            setSaveState('dirty');
          }
        } catch (e) {
          setSaveState('error');
          setLastError(e instanceof Error ? e.message : String(e));
        }
      }, 2000);
      return () => clearTimeout(timer);
    }
    return undefined;
  }, [saveState, readOnly, libraryId, desktopPath, buildDownloadBytes, ensureSaveSnapshot, library, workbookLoaded, saveWorkbookToServerLibrary, awaitEditsSettled, host, sessionDisconnected, buildServerSaveExtras, saveFormat]);

  // Session-extras sync (Addendum 6): the renderer's session extras
  // (styles / dims / name extras / metadata) are pushed to the main
  // process as they change, so main-side checkpoints include them.
  // buildServerSaveExtras' identity is the reused change signal — it
  // is rebuilt whenever the format store, the name services, the sheet
  // set, or the client-metadata applier changes. This is state sync,
  // NOT a save trigger: the debounced send never flushes anything; the
  // flush decision stays in main's scheduler.
  useEffect(() => {
    if (!isDesktop() || !workbookLoaded) return undefined;
    const timer = setTimeout(() => {
      void desktopSyncExtras(buildServerSaveExtras()).catch(() => false);
    }, 800);
    return () => clearTimeout(timer);
  }, [buildServerSaveExtras, workbookLoaded]);

  // Session-extras sync, gateway mode (Addendum 6): the same extras
  // are pushed to the ENGINE SERVICE as they change, so the server's
  // autosave flushes are never blind (styles/dims/name extras/
  // metadata are flushable content via its metadata-dirty flag).
  // State sync only — never a save trigger; buildServerSaveExtras'
  // identity is the change signal, as on desktop.
  useEffect(() => {
    if (isDesktop() || !isGatewayMode() || !workbookLoaded) return undefined;
    const timer = setTimeout(() => {
      const extras = buildServerSaveExtras();
      // Phase 2 (Worker F, defect F3): with a live collab session the
      // extras go DIRECTLY to the owning engine over the collab channel
      // (session-scoped token) — the gateway-proxied call targets a
      // proxy session that does not exist in signed mode and 401s, so
      // the server never saw the extras. The proxied call remains the
      // fallback for gateway sessions with no collab transport.
      const transport = collabTransportRef.current;
      if (transport?.connectionState === 'connected') {
        void transport.postSessionExtras(extras).catch(() => undefined);
        return;
      }
      const gateway = getGatewayClient();
      if (gateway) void gateway.engineSessionExtras(extras).catch(() => undefined);
    }, 800);
    return () => clearTimeout(timer);
  }, [buildServerSaveExtras, workbookLoaded]);

  // ---- Keyboard shortcuts ----
  // Placed after the save handlers: Ctrl+S routes to native save (desktop)
  // or download (web); Ctrl+P opens print preview (suppressing the
  // browser's own print dialog); Ctrl+/ opens the shortcuts dialog;
  // Alt+/ opens global menu search. All resolve against the command
  // registry (§6).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      const inInput = target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT';
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === 'z') {
        if (!inInput) {
          e.preventDefault();
          handleUndo();
        }
      } else if ((e.ctrlKey || e.metaKey) && (e.key.toLowerCase() === 'y' || (e.shiftKey && e.key.toLowerCase() === 'z'))) {
        if (!inInput) {
          e.preventDefault();
          handleRedo();
        }
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        setFindOpen(true);
      } else if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'p') {
        // Ctrl+Shift+P — voice command palette (Pro). Checked before
        // Ctrl+P (print), whose branch does not exclude Shift.
        e.preventDefault();
        setVoicePaletteOpen(true);
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'p') {
        // Ctrl+P — print preview (the single print path): the browser's
        // own print dialog is suppressed so app chrome never prints.
        // Benefits web too.
        e.preventDefault();
        setPrintPreviewOpen(true);
      } else if ((e.ctrlKey || e.metaKey) && e.key === '/') {
        // Ctrl+/ — keyboard-shortcuts dialog (command registry).
        e.preventDefault();
        setShortcutsOpen(true);
      } else if (e.altKey && !e.ctrlKey && !e.metaKey && e.key === '/') {
        // Alt+/ — global menu search (command palette).
        e.preventDefault();
        setMenuSearchOpen(true);
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        // Ctrl+S — save: native save on desktop, download on web.
        // Disabled in read-only mode (no save target).
        e.preventDefault();
        if (!inInput && !readOnly) {
          if (isDesktop()) void handleDesktopSaveRef.current();
          else handleDownloadRef.current();
        }
      } else if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === 'c') {
        // D-SEL-3: Ctrl+C — copy the current selection as TSV through the
        // data-model path (selectionTsv reads the engine, never the DOM),
        // the same handler the context menus use. Skipped while typing in
        // an input so the field keeps native copy.
        if (!inInput) {
          e.preventDefault();
          void handleCopy();
        }
      } else if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === 'x') {
        // D-SEL-3: Ctrl+X — cut through the data-model path (copy TSV +
        // clear selection contents). Disabled in read-only mode.
        if (!inInput && !readOnly) {
          e.preventDefault();
          void handleCut();
        }
      } else if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === 'v') {
        // D-SEL-3: Ctrl+V — paste through the data-model path
        // (clipboard TSV → commitCell per cell). Disabled in read-only.
        if (!inInput && !readOnly) {
          e.preventDefault();
          void handlePaste();
        }
      } else if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'v') {
        // D-SEL-3: Ctrl+Shift+V — paste values only (formulas stripped).
        if (!inInput && !readOnly) {
          e.preventDefault();
          void handlePasteValues();
        }
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [handleUndo, handleRedo, readOnly, handleCopy, handleCut, handlePaste, handlePasteValues]);

  const filterValues = useMemo(
    () => (filterOpen ? columnValues(host, activeSheet, filterOpen.col) : []),
    [host, activeSheet, filterOpen],
  );

  /** Fields for the pivot builder, computed when the dialog opens. */
  const pivotBuilderFields = useMemo(
    () => (pivotBuilderOpen ? readPivotSource() : null),
    [pivotBuilderOpen, readPivotSource],
  );

  const canUndo = undoTick >= 0 && undoRef.current.canUndo();
  const canRedo = undoTick >= 0 && undoRef.current.canRedo();

  /**
   * Command registry (design-docs/platform-shell.md §6): menu search
   * (Alt+/) and the keyboard-shortcuts dialog (Ctrl+/) resolve against
   * this same registry, so shortcuts behave identically on web and
   * desktop. Shortcut labels here describe chords actually bound in the
   * global key handler or the grid.
   */
  const commands: AppCommand[] = useMemo(
    () => [
      // File
      { id: 'file.new', label: 'New workbook', category: 'File', run: handleNew, description: 'Start a new blank workbook' },
      { id: 'file.library', label: 'Workbooks…', category: 'File', run: () => setLibraryOpen(true), description: 'Open the workbook library (New / Open / Copy / Trash)' },
      { id: 'file.open', label: 'Open file…', category: 'File', shortcut: isDesktop() ? 'Ctrl+O' : undefined, run: () => { if (isDesktop()) void handleDesktopOpen(); }, enabled: () => isDesktop(), description: 'Open a workbook via the native file dialog (desktop)' },
      { id: 'file.save', label: 'Save', category: 'File', shortcut: 'Ctrl+S', run: () => { if (isDesktop()) void handleDesktopSave(); else handleDownload(); }, enabled: () => !readOnly && workbookLoadedRef.current && !sessionDisconnectedRef.current, description: isDesktop() ? 'Save to the current file (desktop)' : 'Download the workbook' },
      { id: 'file.saveEncrypted', label: 'Save encrypted…', category: 'File', run: handleDownloadEncrypted, enabled: () => workbookLoadedRef.current, description: 'Download the workbook encrypted with a password' },
      { id: 'file.printPreview', label: 'Print preview', category: 'File', shortcut: 'Ctrl+P', run: () => setPrintPreviewOpen(true), description: 'Open the print preview (the single print path)' },
      // Edit
      { id: 'edit.undo', label: 'Undo', category: 'Edit', shortcut: 'Ctrl+Z', run: handleUndo, enabled: () => canUndo },
      { id: 'edit.redo', label: 'Redo', category: 'Edit', shortcut: 'Ctrl+Y', run: handleRedo, enabled: () => canRedo },
      { id: 'edit.cut', label: 'Cut', category: 'Edit', shortcut: 'Ctrl+X', run: () => void handleCut() },
      { id: 'edit.copy', label: 'Copy', category: 'Edit', shortcut: 'Ctrl+C', run: () => void handleCopy() },
      { id: 'edit.paste', label: 'Paste', category: 'Edit', shortcut: 'Ctrl+V', run: () => void handlePaste() },
      { id: 'edit.find', label: 'Find…', category: 'Edit', shortcut: 'Ctrl+F', run: () => setFindOpen(true) },
      { id: 'edit.clear', label: 'Clear contents', category: 'Edit', shortcut: 'Delete', run: handleClear, description: 'Clear the selected cell' },
      // View
      { id: 'view.shortcuts', label: 'Keyboard shortcuts…', category: 'View', shortcut: 'Ctrl+/', run: () => setShortcutsOpen(true), description: 'Searchable list of all shortcuts' },
      { id: 'view.menuSearch', label: 'Menu search…', category: 'View', shortcut: 'Alt+/', run: () => setMenuSearchOpen(true), description: 'Type to find and run any command' },
      { id: 'view.voicePalette', label: 'Voice command palette…', category: 'View', shortcut: 'Ctrl+Shift+P', run: () => setVoicePaletteOpen(true), description: 'Dictate or type a command — matched, shown, and run only on your confirmation (Pro feature)' },
      { id: 'view.settings', label: 'Settings…', category: 'View', run: () => setSettingsOpen(true), description: 'Per-user preferences (theme, formula language, calculation)' },
      { id: 'view.zoomIn', label: 'Zoom in', category: 'View', run: handleZoomIn },
      { id: 'view.zoomOut', label: 'Zoom out', category: 'View', run: handleZoomOut },
      { id: 'view.zoomReset', label: 'Reset zoom to 100%', category: 'View', run: handleZoomReset },
      { id: 'view.gridlines', label: 'Toggle gridlines', category: 'View', run: handleToggleGridlines },
      { id: 'view.formulaBar', label: 'Toggle formula bar', category: 'View', run: handleToggleFormulaBar },
      { id: 'view.showFormulas', label: 'Toggle show formulas', category: 'View', run: handleToggleShowFormulas },
      { id: 'view.revisionHistory', label: 'Revision history', category: 'View', run: () => setRevisionOpen(true) },
      // Insert
      { id: 'insert.chart', label: 'Insert chart…', category: 'Insert', run: () => handleInsertChart('column-clustered') },
      { id: 'insert.pivot', label: 'Insert PivotTable…', category: 'Insert', run: () => setPivotBuilderOpen(true) },
      { id: 'insert.sparkline', label: 'Insert sparkline…', category: 'Insert', run: () => setSparklineDialogOpen(true) },
      { id: 'insert.function', label: 'Insert function…', category: 'Insert', run: () => setFnDialogOpen(true) },
      // Grid navigation (bound in the grid's key handler)
      { id: 'grid.editCell', label: 'Edit cell', category: 'Navigation', shortcut: 'F2', run: () => announce('Press F2 with a cell selected to edit it.'), description: 'Bound in the grid — select a cell first' },
      { id: 'grid.commitDown', label: 'Commit and move down', category: 'Navigation', shortcut: 'Enter', run: () => undefined, description: 'Bound in the grid editor' },
      { id: 'grid.commitRight', label: 'Commit and move right', category: 'Navigation', shortcut: 'Tab', run: () => undefined, description: 'Bound in the grid editor' },
      { id: 'grid.move', label: 'Move selection', category: 'Navigation', shortcut: 'Arrow keys', run: () => undefined, description: 'Arrow keys move the selection in the grid' },
      // Sync
      { id: 'sync.now', label: 'Sync now', category: 'Sync', run: () => void handleSyncNow(), description: 'Replay pending offline operations' },
    ],
    [
      handleNew, handleDesktopOpen, handleDesktopSave, handleDownload, handleDownloadEncrypted,
      handleUndo, handleRedo, handleCut, handleCopy, handlePaste, handleClear,
      handleZoomIn, handleZoomOut, handleZoomReset, handleToggleGridlines,
      handleToggleFormulaBar, handleToggleShowFormulas, handleInsertChart, handleSyncNow,
      canUndo, canRedo,
    ],
  );

  // Firebase auth state → app session (Cycle 9, Phase 1). A completed
  // Google sign-in carries the same onLoggedIn transition as the gate's
  // local-dev login (swap in the remote engine host, mark authed); a
  // sign-out from the header button drops the JWT and returns to the
  // login gate. Only transitions are handled — the initial logged-out
  // state must not disturb an existing stored session.
  useEffect(() => {
    if (!firebaseAuth) return;
    let prev = firebaseAuth.current.status;
    const unsub = firebaseAuth.subscribe((s) => {
      if (s.status === 'logged-in' && prev !== 'logged-in') {
        setHost(connectGatewayHost());
        setGwAuthed(true);
      } else if (s.status === 'logged-out' && prev === 'logged-in') {
        setGwAuthed(false);
      }
      prev = s.status;
    });
    let cancelled = false;
    void firebaseAuth
      .restoreSession({ clearOrphanToken: gwClient ? !isDevLoginEnabled(gwClient) : false })
      .then(() => {
        // Coherence resync: if restore cleared an orphan token (no
        // Firebase session behind it), the stored-token boot posture
        // must not keep the app half-alive on the Workspace while the
        // header claims signed-out — drop to the login gate.
        if (!cancelled && gwClient && !gwClient.loggedIn) setGwAuthed(false);
      });
    return () => {
      cancelled = true;
      unsub();
    };
  }, [firebaseAuth]);

  // Workspace settings (workspace-settings brief): once authed in
  // gateway mode, fetch the caller's server-persisted settings, apply
  // the Icecream Office theme, and seed the presence name source. The
  // server record is the only durable, authoritative copy; the theme is
  // additionally mirrored into the local profile purely as a boot cache
  // (next load paints it before first paint, then this fetch confirms or
  // corrects it) — see storedProfileTheme / main.tsx (#38).
  const settingsLoadedForRef = useRef<string | null>(null);
  useEffect(() => {
    if (!gwClient || !gwAuthed || isDesktop() || !productApi) return;
    const principal = gwClient.principal ?? 'user';
    if (settingsLoadedForRef.current === principal) return;
    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    // The latch is set ONLY on success (#38): the old code latched before
    // the fetch, so one failed round trip on refresh (a 401 inside the
    // sign-in restore window, a transient 503) silently kept the boot /
    // local-profile theme for the whole session — the saved theme "changed
    // on its own" after a refresh. A failed attempt now retries once after
    // a short delay, and any later auth flip re-runs the effect.
    const attempt = async (isRetry: boolean): Promise<void> => {
      try {
        const view = await productApi.getSettings();
        if (cancelled) return;
        settingsLoadedForRef.current = principal;
        setSessionSettings(view);
        applyThemeChoice(view.theme);
        // Mirror the authoritative choice into the local profile + the
        // spreadsheet's settings state, so the sheet view's own theme
        // application can never resurrect a stale local value and the
        // next boot paints this choice immediately (no flash).
        saveSettings({ ...loadSettings(), theme: view.theme });
        setSettings((prev) => (prev.theme === view.theme ? prev : { ...prev, theme: view.theme }));
        const fb = firebaseAuth?.current;
        const fbUser = fb?.status === 'logged-in' ? fb.user : null;
        setSessionProfile({
          displayName: view.googleName ?? fbUser?.displayName ?? null,
          email: view.email ?? fbUser?.email ?? null,
        });
      } catch {
        if (cancelled || isRetry) {
          // Settings unavailable (gateway 503 posture): keep the
          // defaults — system theme, provider-name presence fallback.
          return;
        }
        retryTimer = setTimeout(() => {
          if (!cancelled) void attempt(true);
        }, 2000);
      }
    };
    void attempt(false);
    return () => {
      cancelled = true;
      if (retryTimer) clearTimeout(retryTimer);
    };
  }, [gwClient, gwAuthed, productApi, firebaseAuth]);

  // On sign-out, drop the session's settings copy entirely.
  useEffect(() => {
    if (!gwAuthed) {
      settingsLoadedForRef.current = null;
      setSessionSettings(null);
      setSessionProfile(null);
    }
  }, [gwAuthed]);

  // Shell routing (shell integration): while logged out, remember any
  // deep-link target (file or share) so login returns the visitor to it.
  useEffect(() => {
    if (!gwClient || gwAuthed || isDesktop()) return;
    const f = fileIdFromUrl(window.location);
    if (f) stashReturnFile(f);
    const s = shareIdFromSearch(window.location.search);
    if (s) stashReturnShare(s);
  }, [gwClient, gwAuthed]);

  // Shell routing: once authed, consume the stashed targets (read-once).
  useEffect(() => {
    if (!gwClient || !gwAuthed || isDesktop()) return;
    const s = takeReturnShare();
    if (s) setRouteShareId((prev) => prev ?? s);
    const f = takeReturnFile();
    if (f && !collabFileIdRef.current) {
      setCollabFile(f);
      // Canonicalize to the ?file= deep link (setCollabFile mirrors the
      // legacy #file= hash; the search param is the canonical form).
      try {
        const url = new URL(window.location.href);
        url.searchParams.set('file', f);
        window.history.replaceState(null, '', url.toString());
      } catch {
        // Best-effort — the session state is authoritative.
      }
    }
  }, [gwClient, gwAuthed, setCollabFile]);

  // Shell routing: a legacy #file= link followed INSIDE the running
  // app (pasted URL, in-app anchor) is only a same-document hash
  // change — no reload, and the boot path never re-reads it (the
  // agent-track D2 symptom: zero gateway requests, nothing paints).
  // Route it through the canonical ?file= deep link with a real
  // navigation, exactly like a Workspace file anchor. A hash naming
  // the file already open is the app"s own mirror write — ignored.
  useEffect(() => {
    const onHashChange = () => {
      const fid = fileIdFromUrl(window.location);
      if (fid && fid !== collabFileIdRef.current) {
        window.location.assign(buildFileUrl(fid));
      }
    };
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  // Share recipient accept (shell integration): fetch the package,
  // materialize the recipient's OWN copies (app artifact + data file),
  // and navigate to the data copy's deep link. The pending-import
  // effect (below, after the save machinery) writes the snapshot into
  // the fresh workbook, saves it, and raises the app full-screen.
  useEffect(() => {
    if (!gwClient || !gwAuthed || isDesktop()) return;
    if (!routeShareId || !productApi || !sharesApi) return;
    if (shareAcceptStartedRef.current === routeShareId) return;
    shareAcceptStartedRef.current = routeShareId;
    let cancelled = false;
    void (async () => {
      try {
        const { pkg } = await sharesApi.getShare(routeShareId);
        const copy = materializeRecipientCopy(pkg, {
          principal: gwClient.principal ?? 'user',
        });
        if (cancelled) return;
        if (!artifactStore.all().some((a) => a.id === copy.artifact.id)) {
          artifactStore.add(copy.artifact);
        }
        const rec = await productApi.createFile(pkg.app.name, 'shared');
        if (cancelled) return;
        writePendingShareImport({
          fileId: rec.fileId,
          sheet: copy.snapshot.sheet,
          cells: copy.snapshot.cells,
          artifactId: copy.artifact.id,
          appName: pkg.app.name,
        });
        window.location.assign(buildFileUrl(rec.fileId));
      } catch (e) {
        if (!cancelled) {
          setShareAcceptError(e instanceof Error ? e.message : String(e));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [gwClient, gwAuthed, routeShareId, productApi, sharesApi, artifactStore]);

  // Gateway login gate (spec a): in gateway mode the app is unusable
  // without a JWT — the gateway 401s every /api/* call. Desktop uses its
  // own login flow (spec d), never this gate. On login the in-process
  // placeholder engine is replaced with the remote engine service.
  if (gwClient && !gwAuthed && !isDesktop()) {
    // Shell routing: a deep-link target goes straight to the sign-in
    // gate (the target was stashed above and is picked up after login);
    // a bare visit gets the public landing page first. Its Sign in
    // action fires Google sign-in directly in the production flavor,
    // and reveals the gate only where dev login is enabled.
    const hasLinkTarget =
      fileIdFromUrl(window.location) !== null ||
      shareIdFromSearch(window.location.search) !== null;
    // Production flavor (user ruling, 2026-10-22): the landing page's
    // "Sign in with Google" button IS the sign-in — one click fires the
    // Firebase Google popup directly, no intermediate dialog. The login
    // transition lands via the firebaseAuth subscription effect above.
    // Only where dev login is enabled (dev builds / localhost gateway)
    // does the button reveal the GatewayLogin dialog, which carries the
    // dev user-ID field alongside Google.
    const directSignIn = firebaseAuth !== null && !isDevLoginEnabled(gwClient);
    if (!hasLinkTarget && !showLogin) {
      return (
        <LandingPage
          loggedIn={false}
          onSignIn={() => {
            if (directSignIn && firebaseAuth) {
              void firebaseAuth.signInWithGoogle();
            } else {
              setShowLogin(true);
            }
          }}
          onOpenWorkspace={() => setShowLogin(true)}
          signInBusy={directSignIn && fbGateState?.status === 'logging-in'}
          signInError={
            directSignIn && fbGateState?.status === 'error'
              ? fbGateState.error.message
              : null
          }
        />
      );
    }
    return (
      <GatewayLogin
        client={gwClient}
        firebaseAuth={firebaseAuth}
        onLoggedIn={() => {
          setHost(connectGatewayHost());
          setGwAuthed(true);
        }}
      />
    );
  }

  // Share accept in flight: the accept effect creates the recipient's
  // copies and navigates to the data copy — never flash the Workspace
  // or a blank grid in between.
  if (gwClient && gwAuthed && !isDesktop() && routeShareId) {
    return (
      <div style={{ padding: 24, fontFamily: 'system-ui, sans-serif', fontSize: 14 }}>
        {shareAcceptError ? (
          <>
            <p>Could not open that shared app: {shareAcceptError}</p>
            <p>
              <a href={`${window.location.origin}${window.location.pathname}`}>
                Go to your workspace
              </a>
            </p>
          </>
        ) : (
          <p>Opening the shared app — preparing your own copy of its data…</p>
        )}
      </div>
    );
  }

  // Post-login home (shell integration): the Workspace — file list,
  // recents, uploads, and the generated-apps gallery in its Apps slot.
  // File opens are REAL anchor navigations to the ?file= deep link, so
  // the grid path below is entered exactly as a fresh page load.
  if (gwClient && gwAuthed && !isDesktop() && !collabFileId && productApi) {
    const workspaceApp = workspaceAppId
      ? (artifactStore.all().find((a) => a.id === workspaceAppId) ?? null)
      : null;
    return (
      <>
        <Workspace
          api={productApi}
          accountSlot={
            firebaseAuth || showDesktopLogin ? (
              <FirebaseLoginButton auth={firebaseAuth ?? undefined} />
            ) : undefined
          }
          settings={{
            profileEmail:
              firebaseAuth?.current.status === 'logged-in'
                ? firebaseAuth.current.user.email
                : null,
            profileName:
              firebaseAuth?.current.status === 'logged-in'
                ? firebaseAuth.current.user.displayName
                : null,
            onFirebaseDelete: async () => {
              if (!firebaseAuth) return 'not-applicable';
              const r = await firebaseAuth.deleteAccount();
              return r.outcome;
            },
            onSignedOut: () => {
              // Account deleted: end every local session leg and land
              // on the public landing page, logged out.
              try {
                gwClient?.logout();
              } catch {
                // best effort — the state flips below are the guarantee
              }
              setSessionSettings(null);
              setSessionProfile(null);
              applyThemeChoice('system');
              saveSettings({ ...loadSettings(), theme: 'system' });
              setShowLogin(false);
              if (firebaseAuth) {
                void firebaseAuth.signOut().catch(() => undefined);
              }
              setGwAuthed(false);
            },
          }}
          appsSlot={
            <AppsGallery
              store={artifactStore}
              mcpCall={artifactMcpCall}
              onOpen={(id) => setWorkspaceAppId(id)}
              sheets={[]}
              sharesApi={sharesApi}
            />
          }
        />
        {workspaceApp && (
          <div
            data-workspace-app={workspaceApp.id}
            style={{
              position: 'fixed',
              inset: 0,
              zIndex: 240,
              background: 'var(--panel)',
              color: 'var(--text)',
              display: 'flex',
              flexDirection: 'column',
            }}
          >
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                padding: '8px 12px',
                borderBottom: '1px solid var(--line)',
                background: 'var(--header-bg)',
              }}
            >
              <div style={{ flex: 1, fontSize: 13 }}>
                <strong>{workspaceApp.name}</strong>
              </div>
              <button
                type="button"
                style={{ padding: '4px 10px', fontSize: 12 }}
                onClick={() => setWorkspaceAppId(null)}
              >
                Close
              </button>
            </div>
            <ArtifactFrame spec={workspaceApp} mcpCall={artifactMcpCall} />
          </div>
        )}
      </>
    );
  }

  /**
   * Floating overlays (charts, shapes, pictures, text boxes, pivots, form
   * controls, globes) rendered INSIDE the grid's scrollable content div
   * (Grid `overlays` prop) in grid content coordinates. They scroll with
   * the cells and are clipped by the grid viewport, so they can never
   * paint over the ribbon, formula bar, sheet tabs, or status bar, nor
   * spill outside the app window.
   */
  const gridOverlays = (
    <>
      {charts
        .filter((ch) => ch.range.sheet === activeSheet)
        .map((ch) => {
        const spec = positionedChartSpec(ch);
        return (
          <ChartOverlay
            key={`chart-${ch.id}`}
            spec={spec}
            read={chartReaderForSheet(ch.range.sheet)}
            readAt={chartCellAt}
            version={tick}
            getPivotSeries={getPivotSeries}
            pivotVersion={pivotTick}
            onClose={() => handleDeleteChart(ch.id)}
            onMove={(x, y) => handleMoveChart(ch.id, x, y)}
            onResize={(w, h) => handleResizeChart(ch.id, w, h)}
            onEdit={() => {
              setEditingChart(ch);
              setChartDialog({ kind: ch.kind, range: ch.range });
            }}
          />
        );
      })}
      {shapes.map((s) => (
        <ShapeOverlay
          key={`shape-${s.id}`}
          shape={s}
          onClose={() => setShapes((prev) => prev.filter((x) => x.id !== s.id))}
          onMove={(dx, dy) => setShapes((prev) => prev.map((p) => (p.id === s.id ? { ...p, x: p.x + dx, y: p.y + dy } : p)))}
          onColors={(fillColor, color) =>
            setShapes((prev) => prev.map((p) => (p.id === s.id ? { ...p, fillColor, color } : p)))
          }
        />
      ))}
      {pictures
        .filter((p) => p.sheet === undefined || p.sheet === activeSheet)
        .map((p) => (
        <PictureOverlay
          key={`pic-${p.id}`}
          picture={p}
          onClose={() => setPictures((prev) => prev.filter((x) => x.id !== p.id))}
          onMove={(dx, dy) => setPictures((prev) => prev.map((q) => (q.id === p.id ? { ...q, x: q.x + dx, y: q.y + dy } : q)))}
          onResize={(w, h) => setPictures((prev) => prev.map((q) => (q.id === p.id ? { ...q, w, h } : q)))}
        />
      ))}
      {textBoxes
        .filter((b) => b.sheet === undefined || b.sheet === activeSheet)
        .map((b) => (
        <TextBoxOverlay
          key={`tb-${b.id}`}
          box={b}
          onChange={(text) => setTextBoxes((prev) => prev.map((p) => (p.id === b.id ? { ...p, text } : p)))}
          onClose={() => setTextBoxes((prev) => prev.filter((x) => x.id !== b.id))}
        />
      ))}
      {pivots.map((p, pivotIdx) => (
        // The wrapper never intercepts grid pointer events itself: the
        // notice card is informational (only its close button is
        // interactive), so it is click-through — stacked notice cards used
        // to swallow dblclicks over a 420px-wide band of cells on every
        // sheet (Cycle 10 defect D4). A computed pivot table is a real
        // interactive panel (scroll + Refresh/PivotChart/Close), so it
        // opts back into pointer events on its own box only.
        <div key={`pivot-${p.id}`} style={{ position: 'absolute', left: 240, top: 120 + pivotIdx * 24, pointerEvents: 'none' }}>
          {p.notice || !p.result ? (
            <div
              style={{
                background: '#fffbe6',
                border: '1px solid #e3c878',
                boxShadow: '0 4px 16px rgba(0,0,0,0.2)',
                padding: 8,
                maxWidth: 420,
                fontSize: 12,
                pointerEvents: 'none',
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                <strong style={{ fontSize: 13 }}>{p.title}</strong>
                <button type="button" onClick={() => closePivot(p.id)} aria-label={`Close ${p.title}`} style={{ pointerEvents: 'auto' }}>
                  ✕
                </button>
              </div>
              <div>{p.notice ?? 'This pivot table could not be computed.'}</div>
            </div>
          ) : (
            <div style={{ pointerEvents: 'auto' }}>
              <PivotTableView
                pivot={p.result}
                matrix={p.matrix}
                title={p.title}
                onClose={() => closePivot(p.id)}
                onRefresh={() => handleRefreshPivot(p.id)}
                onInsertChart={() => handleInsertPivotChart(p.id)}
              />
            </div>
          )}
        </div>
      ))}
      {formControls.map((fc) => (
        <FormControlOverlay
          key={`fc-${fc.id}`}
          control={fc}
          boundValue={formControlValue(fc.boundRow, fc.boundCol)}
          onClose={() => setFormControls((prev) => prev.filter((x) => x.id !== fc.id))}
          onMove={(dx, dy) => setFormControls((prev) => prev.map((p) => (p.id === fc.id ? { ...p, x: p.x + dx, y: p.y + dy } : p)))}
          onWrite={(value) => commitCell(fc.boundRow, fc.boundCol, value)}
          onButtonPress={handleRecalculate}
        />
      ))}
      {globes.map((g) => (
        <div key={`globe-${g.id}`} style={{ position: 'absolute', left: g.x, top: g.y, pointerEvents: 'auto' }}>
          <GlobeOverlay
            points={g.points}
            size={g.size}
            offline={g.offline}
            onClose={() => setGlobes((prev) => prev.filter((x) => x.id !== g.id))}
            onMove={(dx, dy) => setGlobes((prev) => prev.map((p) => (p.id === g.id ? { ...p, x: p.x + dx, y: p.y + dy } : p)))}
          />
        </div>
      ))}
    </>
  );

  return (
    <>
    <div
      className="app"
      data-tick={tick}
      // GAP-5: dropping a spreadsheet file anywhere on the app opens it
      // (handleDropFile). preventDefault on dragOver is required for drop
      // to fire; main.ts's will-navigate guard keeps the desktop shell
      // from navigating away (data-loss risk). Web benefits too.
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        const file = e.dataTransfer?.files?.[0];
        if (file) void handleDropFile(file);
      }}
    >
      {/* D5: horizontal body row — the main column (header, ribbon,
          grid, tabs, status) and the DOCKED agent panel as siblings;
          the grid shrinks when the panel opens, never covered. */}
      <div className="app-body-row">
      <div className="app-main-col">
      {/* Accessibility: skip links are the first focusable elements (§2.4). */}
      <a
        href="#grid-region"
        className="skip-link"
        onClick={(e) => {
          e.preventDefault();
          document.querySelector<HTMLElement>('.grid-wrap')?.focus();
        }}
      >
        Skip to grid
      </a>
      <a
        href="#ribbon-region"
        className="skip-link"
        onClick={(e) => {
          e.preventDefault();
          document.querySelector<HTMLElement>('.ribbon-tabstrip [role="tab"]')?.focus();
        }}
      >
        Skip to ribbon
      </a>
      <div
        className="app-header"
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          padding: '4px 12px',
          borderBottom: '1px solid var(--line)',
          background: 'var(--header-bg)',
          color: 'var(--text)',
        }}
      >
        {gwClient ? (
          <a
            href={buildHomeUrl()}
            aria-label="Icecream Sheets — home"
            title="Back to your workspace"
            style={{ fontSize: 13, fontWeight: 700, color: 'inherit', textDecoration: 'none' }}
          >
            🧊 Icecream Sheets
          </a>
        ) : (
          <strong style={{ fontSize: 13 }}>🧊 Icecream Sheets</strong>
        )}
        <SensitivityBar label={sensitivity.getLabel()} onChange={handleSensitivityChange} />
        {/* Phase 2 presence: live participants in this session (SSE
            presence channel) — initials + color from the display name
            (workspace-settings: the Settings name when one rides the
            presence payload), title = name ?? principal. */}
        {collabParticipants.length > 0 && (
          <span
            className="collab-avatars"
            role="group"
            aria-label="People in this session"
            style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}
          >
            {collabParticipants.map((p) => (
              <span
                key={p.principal}
                className="collab-avatar"
                title={participantDisplayName(p)}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  width: 22,
                  height: 22,
                  borderRadius: '50%',
                  background: p.color,
                  color: '#fff',
                  fontSize: 10,
                  fontWeight: 600,
                }}
              >
                {participantInitials(participantDisplayName(p))}
              </span>
            ))}
          </span>
        )}
        {collabFileId && (
          <span
            className="collab-file-id"
            title="Share this link to let another browser join this session"
            style={{ fontSize: 11, color: '#64748b' }}
          >
            🔗 {collabFileName ?? 'Shared file'}
          </span>
        )}
        <span style={{ flex: 1 }} />
        {(firebaseAuth || showDesktopLogin) && <FirebaseLoginButton auth={firebaseAuth ?? undefined} />}
        <SyncStatus
          online={online}
          pending={pendingOps}
          conflicts={conflicts}
          onSyncNow={handleSyncNow}
          onResolve={handleResolveConflict}
        />
      </div>
      {/* Cycle 10: edit lock — ribbon edits are disabled while the
          workbook is loading (mutation is gated at 100% load); the
          user's own readOnly state is untouched by this. */}
      <Ribbon
        {...ribbonParity.ribbonProps}
        calcMode={calcMode}
        sheet={activeSheet}
        sheets={visibleSheets}
        sel={sel}
        host={host}
        zoom={zoom}
        showGridlines={showGridlines}
        showFormulaBar={showFormulaBar}
        canUndo={canUndo}
        canRedo={canRedo}
        hasFreeze={freeze !== null}
        formatPainterActive={formatPainter !== null}
        showFormulas={showFormulas}
        showComments={showComments}
        focusCell={focusCell}
        hasComment={hasComment}
        fnCategories={fnCategories}
        onNew={handleNew}
        onOpenFile={handleOpenFile}
        onOpenDataSource={() => setDataSourceOpen(true)}
        onOpenFromUrl={() => setOpenFromUrlOpen(true)}
        readOnly={readOnly || !workbookLoaded || sessionDisconnected}
        onOpenLibrary={() => setLibraryOpen(true)}
        onOpenSettings={() => setSettingsOpen(true)}
        onOpenShortcuts={() => setShortcutsOpen(true)}
        isDesktop={isDesktop()}
        onDesktopOpen={() => void handleDesktopOpen()}
        onDesktopSave={() => void handleDesktopSave()}
        desktopLoading={!workbookLoaded}
        onDownload={handleDownload}
        onDownloadEncrypted={handleDownloadEncrypted}
        onDownloadPdf={handleDownloadPdf}
        onRecalculate={handleRecalculate}
        onToggleMode={handleToggleMode}
        onSetCalcMode={handleSetCalcMode}
        onAddSheet={handleAddSheet}
        onDeleteSheet={() => handleDeleteSheet(activeSheet)}
        onClear={handleClear}
        onCommitCell={commitCell}
        onInsertFunction={handleInsertFunction}
        onZoomIn={handleZoomIn}
        onZoomOut={handleZoomOut}
        onZoomReset={handleZoomReset}
        onToggleGridlines={handleToggleGridlines}
        onToggleFormulaBar={handleToggleFormulaBar}
        onError={handleError}
        onUndo={handleUndo}
        onRedo={handleRedo}
        onFind={() => setFindOpen(true)}
        onSortAsc={() => handleSort('asc')}
        onRandomizeRange={handleRandomizeRange}
        onOpenGroupBy={() => setGroupByOpen(true)}
        onOpenEmail={(mode) => {
          // Cycle 10 save gating (defect D3 audit): emailing the workbook
          // serializes it (an export) — the dialog must not open while
          // loading. handleSendEmail's serializers gate as backstop.
          if (!workbookLoadedRef.current) {
            setLastError('Workbook is still loading — export is disabled until the load completes.');
            return;
          }
          setEmailMode(mode);
        }}
        onSortDesc={() => handleSort('desc')}
        onCustomSort={() => setSortDialogOpen(true)}
        onClearFilter={handleClearFilter}
        onOpenFilter={(col) => setFilterOpen({ col })}
        onFreeze={handleFreeze}
        onFreezeTopRow={handleFreezeTopRow}
        onFreezeFirstCol={handleFreezeFirstCol}
        onUnfreeze={handleUnfreeze}
        onToggleFocusCell={handleToggleFocusCell}
        onMerge={handleMerge}
        onUnmerge={handleUnmerge}
        onOpenCF={() => setCfOpen(true)}
        onClearCF={handleClearCFRules}
        onOpenTopBottomCF={() => setCfTopBottomOpen(true)}
        onOpenDataBarCF={() => setCfDataBarOpen(true)}
        onOpenColorScaleCF={() => setCfColorScaleOpen(true)}
        onOpenIconSetCF={() => setCfIconSetOpen(true)}
        onOpenValidation={() => setValidationOpen(true)}
        onInsertRow={handleInsertRow}
        onDeleteRow={handleDeleteRow}
        onInsertCol={handleInsertCol}
        onDeleteCol={handleDeleteCol}
        showHeadings={showHeadings}
        selectedFormat={selectedFormat}
        onOpenFnDialog={() => { setFnDialogCategory('All'); setFnDialogOpen(true); }}
        onOpenFnDialogFor={openFnDialogFor}
        onToggleHeadings={handleToggleHeadings}
        onFullScreen={handleFullScreen}
        onOpenMacroRecorder={() => setMacroDialogOpen(true)}
        macroRecording={macroRecording}
        onFormat={handleFormat}
        onCellStyle={handleCellStyle}
        onClearFormat={handleClearFormat}
        onFormatAsTable={handleFormatAsTable}
        onRemoveDuplicates={handleRemoveDuplicates}
        onDoubleUnderline={handleDoubleUnderline}
        onBorderColor={handleBorderColor}
        onBorderStyle={handleBorderStyle}
        onAccounting={handleAccounting}
        onIncreaseDecimal={handleIncreaseDecimal}
        onDecreaseDecimal={handleDecreaseDecimal}
        onPasteValues={handlePasteValues}
        onFormatPainter={handleFormatPainter}
        onClearAll={handleClearAll}
        onAutoSum={handleAutoSum}
        onRowHeight={() => setRowHeightOpen(true)}
        onColWidth={() => setColWidthOpen(true)}
        onHideRow={handleHideRow}
        onHideCol={handleHideCol}
        onUnhideRows={handleUnhideRows}
        onUnhideCols={handleUnhideCols}
        onRenameSheet={() => setRenameSheetOpen(true)}
        onTextToColumns={handleTextToColumns}
        onSolver={() => setSolverOpen(true)}
        onGoalSeek={() => setGoalSeekOpen(true)}
        onScenarioManager={() => setScenarioOpen(true)}
        onDataTable={() => setDataTableOpen(true)}
        onFlashFill={handleFlashFill}
        onSuggestFormulas={handleSuggestFormulas}
        onCleanUp={handleCleanUp}
        onColumnStats={handleColumnStats}
        onTrimWhitespace={handleTrimWhitespace}
        onOpenIterative={() => setIterativeOpen(true)}
        onOpenParallelCalc={() => setParallelCalcOpen(true)}
        onGroupRows={handleGroupRows}
        onGroupCols={handleGroupCols}
        onUngroupAll={handleUngroupAll}
        onToggleShowFormulas={handleToggleShowFormulas}
        onOpenNameManager={() => setNameManagerOpen(true)}
        onOpenNamedFunctions={() => setNamedFunctionOpen(true)}
        onNewComment={() => setCommentDialogOpen(true)}
        onToggleShowComments={handleToggleShowComments}
        onDeleteComment={handleDeleteComment}
        onSpelling={handleSpelling}
        onManageProtection={() => setProtectionDialogOpen(true)}
        isSheetProtected={protection.isSheetProtected(activeSheet)}
        sensitivityLabel={sensitivity.getLabel()}
        onSensitivityChange={handleSensitivityChange}
        onInsertSlicer={handleInsertSlicer}
        onInsertTimeline={handleInsertTimeline}
        onInsertSparkline={handleInsertSparkline}
        onRemoveSparkline={handleRemoveSparkline}
        saveFormat={saveFormat}
        onSaveFormatChange={(f) => setSaveFormat(f as SaveFormatId)}
        onOpenRevisionHistory={() => setRevisionOpen(true)}
        onInsertChart={handleInsertChart}
        onNewReport={handleNewReport}
        onOpenReports={() => setReportListOpen(true)}
        onInsertShape={handleInsertShape}
        onInsertTextBox={handleInsertTextBox}
        onInsertPicture={() => pictureInputRef.current?.click()}
        onOpenPrintPreview={() => setPrintPreviewOpen(true)}
        onSetPrintArea={handleSetPrintArea}
        onClearPrintArea={handleClearPrintArea}
        onInsertPivotTable={handleInsertPivotTable}
        onOpenAppBuilder={() => setAppBuilderOpen(true)}
        appList={apps.map((a) => ({ id: a.id, name: a.name }))}
        onOpenApp={(id) => setRunningAppId(id)}
        onInsertFormControl={handleInsertFormControl}
        onOpenGlobeSetup={() => setGlobeSetupOpen(true)}
        onOpenPowerQuery={() => setPowerQueryOpen(true)}
        onRefreshDataSource={() => void handleRefreshDataSource()}
        onRefreshAllDataSources={() => void handleRefreshAllDataSources()}
        canRefreshDataSource={bindingForSheet(sourceBindings, activeSheet) !== undefined}
        onOpenEtl={() => setEtlOpen(true)}
        onOpenDataTypeDialog={() => setDataTypeDialogOpen(true)}
        onOpenSmartChipDialog={() => setSmartChipDialogOpen(true)}
        onOpenExternalLinks={() => setExtLinksOpen(true)}
        onNotImplemented={handleNotImplemented}
      />
      {ribbonParity.dialogs}
      {groupByOpen && (
        <GroupByDialog
          host={host}
          sheet={activeSheet}
          onClose={() => setGroupByOpen(false)}
          onApply={handleApplyGroupBy}
        />
      )}
      {emailMode !== null && (
        <EmailDialog
          filename={emailMode === 'workbook' ? 'workbook.xlsx' : `${activeSheet}.csv`}
          defaultFrom=""
          onClose={() => setEmailMode(null)}
          onSend={handleSendEmail}
        />
      )}
      {downloadDialogOpen && (
        <DownloadDialog
          names={nameServices.services.ranges.list().map((d): DownloadNameOption => ({
            id: d.id,
            name: d.name,
            scopeLabel: d.scope.kind === 'sheet' ? `Sheet: ${d.scope.sheet}` : 'Workbook',
            refLabel: d.ref
              ? a1Range({
                  name: d.name,
                  sheet: d.ref.sheet,
                  startRow: d.ref.startRow,
                  startCol: d.ref.startCol,
                  endRow: d.ref.endRow,
                  endCol: d.ref.endCol,
                })
              : '#REF!',
            dangling: d.ref === null,
          }))}
          formatExt={saveFormatById(saveFormat).ext}
          onDownload={handleConfirmDownload}
          onClose={() => setDownloadDialogOpen(false)}
        />
      )}
      {pivotBuilderOpen && (
        <PivotTableBuilderDialog
          fields={(pivotBuilderFields?.headers ?? []).map((h) => ({
            name: h,
            values: pivotBuilderFields?.distinct[h] ?? [],
          }))}
          onClose={() => setPivotBuilderOpen(false)}
          onCreate={handleCreatePivot}
        />
      )}
      {appBuilderOpen && (
        <AppBuilderDialog
          host={host}
          sheets={visibleSheets}
          initialSheet={activeSheet}
          onClose={() => setAppBuilderOpen(false)}
          onCreate={handleCreateApp}
        />
      )}
      {runningAppId &&
        (() => {
          const running = apps.find((a) => a.id === runningAppId);
          return running ? (
            <AppRunnerDialog
              spec={running}
              host={host}
              onClose={() => setRunningAppId(null)}
              onSpecChange={handleAppSpecChange}
            />
          ) : null;
        })()}
      {reportListOpen && (
        <ReportListDialog
          reports={reports}
          onOpen={handleViewReport}
          onDelete={handleDeleteReport}
          onNew={handleNewReport}
          onClose={() => setReportListOpen(false)}
        />
      )}
      {reportBuilder && (
        <ReportBuilderDialog
          editing={reportBuilder.editing}
          source={readReportSource()}
          charts={availableCharts}
          pivots={availablePivots}
          readHeaders={readReportHeaders}
          onSave={handleSaveReport}
          onClose={() => setReportBuilder(null)}
          etlRecipes={reportEtlRecipes}
        />
      )}
      {reportViewing && (
        <ReportViewerDialog
          spec={reportViewing}
          readBinding={readReportBindingForSubject}
          readChartCell={readReportChartCellForSubject}
          onUpdate={handleUpdateReport}
          onEdit={() => {
            setReportViewing(null);
            setReportBuilder({ editing: reports.find((r) => r.id === reportViewing.id) ?? reportViewing });
          }}
          onClose={() => setReportViewing(null)}
          runEtlBindings={handleRunEtlBindingsForReport}
        />
      )}
      {solverOpen && (
        <SolverDialog
          defaultCell={a1Short(sel.row, sel.col)}
          onClose={() => setSolverOpen(false)}
          onSolve={handleSolve}
        />
      )}
      {goalSeekOpen && (
        <GoalSeekDialog
          defaultCell={a1Short(sel.row, sel.col)}
          onClose={() => setGoalSeekOpen(false)}
          onSeek={handleGoalSeek}
        />
      )}
      {scenarioOpen && (
        <ScenarioManagerDialog
          scenarioSet={scenarioSet}
          onClose={() => setScenarioOpen(false)}
          onAdd={handleAddScenario}
          onDelete={handleDeleteScenario}
          onShow={handleShowScenario}
          onSummary={handleScenarioSummary}
        />
      )}
      {dataTableOpen && (
        <DataTableDialog onClose={() => setDataTableOpen(false)} onCreate={handleDataTable} />
      )}
      {flashFillProposal && (
        <FlashFillDialog
          proposal={flashFillProposal.proposal}
          sourceRef={flashFillProposal.sourceRef}
          previewRows={flashFillProposal.previewRows}
          onClose={() => setFlashFillProposal(null)}
          onApply={() => applyFlashFill(false)}
          onApplyAsFormulas={() => applyFlashFill(true)}
        />
      )}
      {columnStats && (
        <ColumnStatsDialog
          title={columnStats.title}
          profiles={columnStats.profiles}
          onClose={() => setColumnStats(null)}
        />
      )}
      {inferencePanel && (
        <InferencePanel
          title={inferencePanel.title}
          proposals={inferencePanel.proposals}
          onAccept={handleAcceptProposal}
          onReject={handleRejectProposal}
          onModify={handleModifyProposal}
          onClose={() => setInferencePanel(null)}
        />
      )}
      {iterativeOpen && (
        <IterativeDialog
          initial={iterativeSettings}
          onClose={() => setIterativeOpen(false)}
          onSave={setIterativeSettings}
        />
      )}
      {parallelCalcOpen && (
        <ParallelCalcDialog
          initial={parallelOpts}
          lastStats={lastParallelStats}
          workersAvailable={workersAvailable}
          onClose={() => setParallelCalcOpen(false)}
          onSave={setParallelOpts}
        />
      )}
      {fnDialogOpen && (
        <InsertFunctionDialog
          initialCategory={fnDialogCategory}
          onInsert={handleInsertFunction}
          onClose={() => setFnDialogOpen(false)}
        />
      )}
      {showFormulaBar && (
        <FormulaBar
          host={host}
          sheet={activeSheet}
          sel={sel}
          onCommit={commitCell}
          insertRequest={insertReq}
          version={tick}
          onNavigate={(t) => {
            // Name-box navigation (sweep F-8): a sheet prefix naming a
            // sheet this workbook does not have voids the navigation
            // (the box simply restores the current address); a valid
            // one switches sheets first.
            if (t.sheet !== activeSheet) {
              if (!host.sheetNames().includes(t.sheet)) return;
              setSheet(t.sheet);
            }
            setSel({ row: t.startRow, col: t.startCol });
            setGridSel(rangeSelection(t.startRow, t.startCol, t.endRow, t.endCol));
          }}
        />
      )}
      <div className={showGridlines ? 'grid-zoom' : 'grid-zoom no-gridlines'} style={{ zoom, position: 'relative' }}>
        <Grid
          host={host}
          sheet={activeSheet}
          sel={sel}
          onSelect={(row, col) => handleSelectWithPainter(row, col)}
          selection={gridSel}
          onSelectionChange={handleGridSelectionChange}
          onClearSelection={handleClearSelection}
          onCommit={commitCell}
          version={tick}
          cfRules={cfRules}
          validations={validations}
          merges={merges}
          freeze={freeze}
          filters={filters}
          sortState={sortState}
          rowHeights={rowHeights}
          colWidths={colWidths}
          hiddenRows={effectiveHiddenRows}
          hiddenCols={effectiveHiddenCols}
          showFormulas={showFormulas}
          formulaTexts={formulaTexts}
          comments={showComments ? comments : new Map()}
          dataTypeCells={dataTypeCells}
          dataTypeCardKey={dataTypeCardKey}
          onToggleDataTypeCard={(key) => setDataTypeCardKey((prev) => (prev === key ? null : key))}
          slicerSpecs={slicers}
          timelineSpecs={timelines}
          sparklineCells={sparklineCells}
          smartChipCells={smartChipCells}
          smartChipCardKey={smartChipCardKey}
          onToggleSmartChipCard={(key) => setSmartChipCardKey((prev) => (prev === key ? null : key))}
          focusCell={focusCell}
          extCfStyle={extCfStyle}
          formats={formats}
          dataTypes={dataTypes}
          locale={localeConfig}
          showHeadings={showHeadings}
          onContextMenu={openCtxMenu}
          onOpenFilter={(col) => setFilterOpen({ col })}
          getCellMenu={cellMenuItems}
          getColumnMenu={columnMenuItems}
          getRowMenu={rowMenuItems}
          isCellLocked={(row, col) =>
            protection.isSheetProtected(activeSheet) &&
            !protection.isCellEditable(activeSheet, row, col)
          }
          isCellHiddenVisible={(row, col) =>
            protection.isCellHidden(activeSheet, row, col) &&
            !protection.isHiddenFrom(activeSheet, row, col, sessionPrincipal)
          }
          pageBreaks={pageBreaksBySheet[activeSheet]}
          printPages={previewPages}
          overlays={gridOverlays}
          remoteSelections={collabParticipants.filter(
            (p) => p.principal !== (gwClient?.principal ?? 'You'),
          )}
        />
        {ribbonParity.drawLayer}
      </div>
      {(slicers.length > 0 || timelines.length > 0) && (
        <div
          className="floating-filters"
          style={{ position: 'fixed', inset: 0, pointerEvents: 'none', zIndex: 45 }}
          aria-hidden={false}
        >
          {slicers.map((s) => (
            <SlicerPanel
              key={`slicer-${s.id}`}
              spec={s}
              values={slicerValues.get(s.id) ?? []}
              pivots={pivots.map((p) => ({ id: p.id, title: p.title }))}
              onToggle={(v) => handleSlicerToggle(s.id, v)}
              onClear={() => handleSlicerClear(s.id)}
              onTogglePivotBinding={(pivotId, bind) => handleSlicerPivotBinding(s.id, pivotId, bind)}
              onRemove={() => {
                setSlicers((prev) => prev.filter((x) => x.id !== s.id));
                setSlicerValues((prev) => {
                  const next = new Map(prev);
                  next.delete(s.id);
                  return next;
                });
              }}
            />
          ))}
          {timelines.map((t) => (
            <TimelinePanel
              key={`timeline-${t.id}`}
              spec={t}
              extent={timelineExtent(t.col, 2000, (r, c) => readCellText(activeSheet, r, c))}
              onChange={(ns) => setTimelines((prev) => prev.map((x) => (x.id === t.id ? ns : x)))}
              onRemove={() => setTimelines((prev) => prev.filter((x) => x.id !== t.id))}
            />
          ))}
        </div>
      )}
      <SheetTabs
        sheets={visibleSheets}
        active={activeSheet}
        tabColors={tabColors}
        sourceBadges={sourceBadgeMap}
        onSelect={setSheet}
        onAdd={handleAddSheet}
        onDelete={handleDeleteSheet}
        onContextMenu={(x, y, name) => openCtxMenu(x, y, sheetTabMenuItems(name))}
      />
      {sparklineDialogOpen && (
        <SparklineDialog
          defaultRange={`${colLabel(0)}${sel.row + 1}:${colLabel(4)}${sel.row + 1}`}
          locationLabel={a1Short(sel.row, sel.col)}
          onClose={() => setSparklineDialogOpen(false)}
          onInsert={handleConfirmSparkline}
        />
      )}
      {revisionOpen && (
        <RevisionHistoryDialog
          changes={collabRef.current?.changes() ?? []}
          onClose={() => setRevisionOpen(false)}
        />
      )}
      <StatusBar
        protocolVersion={ENGINE_PROTOCOL_VERSION}
        calcMode={calcMode}
        address={a1Short(sel.row, sel.col)}
        lastError={lastError ?? restoreNotice}
        isProtected={protection.isSheetProtected(activeSheet)}
        formulaLang={formulaLang}
        onFormulaLangChange={handleFormulaLangChange}
        collaborators={collabRef.current?.collaborators() ?? []}
        saveState={saveState}
        readOnly={readOnly}
        workbookLoaded={workbookLoaded}
        loadProgressPct={loadProgress.pct}
        loadCalculating={loadProgress.calculating}
        sessionDisconnected={sessionDisconnected}
        sessionError={sessionError}
        offline={transportOffline}
        onReconnect={handleSessionReconnect}
      />
      {/* Cycle 10 (user's rule): the open-incomplete banner. DISPLAY IS
          PROGRESSIVE; MUTATION IS GATED — the view renders progressively
          as data streams in (you can look; unloaded regions show a
          loading state, never wrong data presented as final), while
          editing, save, autosave and export stay gated until the
          workbook is 100% loaded. Non-blocking: it sits above the grid
          without intercepting interaction. */}
      {/* Phase 2 visible rejection (doc §7): ops the server rejected are
          retained locally with their input intact — never silently
          dropped. NO overwrite notifications exist anywhere (user
          ruling: silent); this banner is only for REJECTED own ops. */}
      {collabRejected.length > 0 && (
        <div
          role="alert"
          style={{
            position: 'absolute',
            top: 8,
            right: 12,
            zIndex: 80,
            maxWidth: 420,
            padding: '8px 12px',
            borderRadius: 6,
            background: '#fef2f2',
            border: '1px solid #fca5a5',
            color: '#7f1d1d',
            fontSize: 12,
            boxShadow: '0 2px 8px rgba(0,0,0,0.2)',
          }}
        >
          <strong>
            {collabRejected.length} edit{collabRejected.length === 1 ? '' : 's'} rejected by the
            server — input retained:
          </strong>
          <ul style={{ margin: '4px 0 0', paddingLeft: 16 }}>
            {collabRejected.map((r) => (
              <li key={r.clientSeq}>
                {r.reason}: {JSON.stringify(r.cmd).slice(0, 120)}
                <button
                  type="button"
                  aria-label="Dismiss retained rejected edit"
                  onClick={() => {
                    collabTransportRef.current?.clearRejected(r.clientSeq);
                    setCollabRejected((prev) => prev.filter((x) => x.clientSeq !== r.clientSeq));
                  }}
                  style={{ marginLeft: 6 }}
                >
                  ✕
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
      {!workbookLoaded && (
        <div
          role="status"
          aria-live="polite"
          title="Editing, save, autosave and export unlock when the workbook finishes loading"
          style={{
            position: 'absolute',
            top: 8,
            left: '50%',
            transform: 'translateX(-50%)',
            zIndex: 80,
            padding: '6px 16px',
            borderRadius: 6,
            background: '#1d4ed8',
            color: '#fff',
            fontSize: 13,
            boxShadow: '0 2px 8px rgba(0,0,0,0.25)',
            pointerEvents: 'none',
          }}
        >
          ⏳ Loading workbook… you can look, but editing and save unlock when the load completes
        </div>
      )}
      {findOpen && (
        <FindDialog
          onClose={() => {
            setFindOpen(false);
            setFindMatches([]);
          }}
          onFind={handleFind}
          onFindNext={handleFindNext}
          onReplaceAll={handleReplaceAll}
          matchCount={findMatches.length}
        />
      )}
      {shortcutsOpen && (
        <ShortcutsDialog commands={commands} onClose={() => setShortcutsOpen(false)} />
      )}
      {menuSearchOpen && (
        <MenuSearchDialog commands={commands} onClose={() => setMenuSearchOpen(false)} />
      )}
      {voicePaletteOpen && (
        <VoiceCommandPalette
          sheet={sheet}
          selection={sel}
          tier={paletteTier}
          mcpCall={artifactMcpCall}
          ready={workbookLoaded}
          transcribe={voiceTranscribe}
          onAskAgent={(utterance) => {
            // Voice/chat merge (#41, design doc §7): the palette could
            // not match confidently — hand the words to the agent
            // instead of forcing a guess. Panel opens docked with the
            // utterance in the composer; the user reviews and sends.
            setVoicePaletteOpen(false);
            setChatDraftSeed({ text: utterance, seq: Date.now() });
            setAgentOpen(true);
          }}
          onClose={() => setVoicePaletteOpen(false)}
        />
      )}
      {settingsOpen && (
        <SettingsDialog
          settings={settings}
          onSave={(next) => {
            handleSettingsSave(next);
            setSettingsOpen(false);
          }}
          onClose={() => setSettingsOpen(false)}
        />
      )}
      {desktopHelpOpen && <HelpPane onClose={() => setDesktopHelpOpen(false)} />}
      {libraryOpen && (
        <WorkbookLibraryDialog
          library={library}
          currentId={libraryId}
          onOpen={(entry) => void handleLibraryOpenEntry(entry)}
          onNew={() => {
            setLibraryOpen(false);
            setLibraryId(null);
            handleNew();
          }}
          onSaveToLibrary={handleLibrarySave}
          onClose={() => setLibraryOpen(false)}
        />
      )}
      {cfOpen && (
        <CFDialog
          cellLabel={cellLabelOf(sel.row, sel.col)}
          onClose={() => setCfOpen(false)}
          onAdd={handleAddCFRule}
        />
      )}
      {validationOpen && (
        <ValidationDialog
          cellLabel={cellLabelOf(sel.row, sel.col)}
          existing={findValidation(validations, activeSheet, sel.row, sel.col)?.list ?? []}
          onClose={() => setValidationOpen(false)}
          onSave={handleSaveValidation}
          onClear={handleClearValidation}
        />
      )}
      {filterOpen && (
        <FilterDialog
          colLabel={colLabel(filterOpen.col)}
          values={filterValues}
          selected={filters.get(filterOpen.col) ?? new Set(filterValues)}
          onClose={() => setFilterOpen(null)}
          onApply={(s) => handleApplyFilter(filterOpen.col, s)}
        />
      )}
      {ctxMenu && (
        <ContextMenu
          x={ctxMenu.x}
          y={ctxMenu.y}
          items={ctxMenu.items}
          onClose={() => setCtxMenu(null)}
        />
      )}
      {/* Hidden file picker for Insert > Pictures */}
      <input
        ref={pictureInputRef}
        type="file"
        accept="image/*"
        style={{ display: 'none' }}
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void handleInsertPicture(f);
          e.target.value = '';
        }}
      />
      {printPreviewOpen && (
        <PrintPreviewDialog
          sheet={activeSheet}
          setup={pageSetup}
          onSetupChange={setPageSetup}
          readCell={printCellText}
          pages={printDialogPages}
          onDownloadPdf={handleDownloadPdf}
          onClose={() => setPrintPreviewOpen(false)}
        />
      )}
      {/* Extended dialogs */}
      {rowHeightOpen && (
        <RowHeightDialog
          current={rowHeights.get(sel.row) ?? 24}
          onClose={() => setRowHeightOpen(false)}
          onApply={(h) => { handleRowHeight(h); setRowHeightOpen(false); }}
        />
      )}
      {colWidthOpen && (
        <ColumnWidthDialog
          current={colWidths.get(sel.col) ?? 96}
          onClose={() => setColWidthOpen(false)}
          onApply={(w) => { handleColWidth(w); setColWidthOpen(false); }}
        />
      )}
      {renameSheetOpen && (
        <RenameSheetDialog
          current={activeSheet}
          onClose={() => setRenameSheetOpen(false)}
          onApply={(n) => { handleRenameSheet(n); setRenameSheetOpen(false); }}
        />
      )}
      {macroDialogOpen && <MacroRecorderDialog onClose={() => setMacroDialogOpen(false)} />}
      {sortDialogOpen && (
        <SortDialog
          columns={Array.from({ length: 26 }, (_, i) => ({ index: i, label: colLabel(i) }))}
          onClose={() => setSortDialogOpen(false)}
          onSort={handleCustomSort}
        />
      )}
      {nameManagerOpen && (
        <NameManagerDialog
          store={nameServices.services.ranges}
          sheetNames={visibleSheets}
          defaultSheet={activeSheet}
          principal={nameServices.principal}
          onClose={() => setNameManagerOpen(false)}
          onChanged={nameServices.changed}
          onBeforeChange={captureNamesUndo}
        />
      )}
      {namedFunctionOpen && (
        <NamedFunctionDialog
          registry={nameServices.services.functions}
          principal={nameServices.principal}
          onClose={() => setNamedFunctionOpen(false)}
          onChanged={nameServices.changed}
        />
      )}
      {commentDialogOpen && (
        <CommentDialog
          cellLabel={cellLabelOf(sel.row, sel.col)}
          existing={getComment(comments, activeSheet, sel.row, sel.col) ?? ''}
          onClose={() => setCommentDialogOpen(false)}
          onSave={handleSaveComment}
          onDelete={handleDeleteComment}
        />
      )}
      {protectionDialogOpen && (
        <ProtectionDialog
          sheetName={activeSheet}
          isProtected={protection.isSheetProtected(activeSheet)}
          onClose={() => setProtectionDialogOpen(false)}
          onProtect={handleProtectSheet}
          onUnprotect={handleUnprotectSheet}
        />
      )}
      {filePassword && (
        <FilePasswordDialog
          mode={filePassword.mode}
          filename={filePassword.filename}
          error={filePasswordError}
          busy={filePasswordBusy}
          onClose={() => {
            setFilePassword(null);
            setFilePasswordError(null);
          }}
          onSubmit={handleFilePasswordSubmit}
        />
      )}
      {powerQueryOpen && (
        <PowerQueryDialog
          onClose={() => setPowerQueryOpen(false)}
          onLoad={handlePowerQueryLoad}
        />
      )}
      {dataSourceOpen && (
        <OpenDataSourceDialog
          onClose={() => setDataSourceOpen(false)}
          onOpen={(spec, table) => void handleOpenDataSource(spec, table)}
          gateway={getGatewayClient()}
          connectorDeps={buildConnectorDeps(getGatewayClient())}
        />
      )}
      {openFromUrlOpen && (
        <OpenFromUrlDialog
          onClose={() => setOpenFromUrlOpen(false)}
          onOpen={(url) => void handleOpenFromUrl(url)}
        />
      )}
      {/* NO-DIALOG */}
      {etlOpen && (
        <EtlEditor
          onClose={() => setEtlOpen(false)}
          onLoadTable={handleEtlLoad}
        />
      )}
      {dataTypeDialogOpen && (
        <DataTypeDialog
          onClose={() => setDataTypeDialogOpen(false)}
          onInsert={handleInsertDataType}
        />
      )}
      {smartChipDialogOpen && (
        <SmartChipDialog
          onClose={() => setSmartChipDialogOpen(false)}
          onInsert={handleInsertSmartChip}
        />
      )}
      {globeSetupOpen && (
        <GlobeSetupDialog
          headers={globeHeaders}
          onClose={() => setGlobeSetupOpen(false)}
          onCreate={handleCreateGlobe}
          onCreateFromPlaces={handleCreateGlobeFromPlaces}
        />
      )}
      {extLinksOpen && (
        <ExternalLinksDialog
          registry={extRegistry}
          formulas={collectFormulas()}
          onClose={() => setExtLinksOpen(false)}
          onChanged={() => setTick((t) => t + 1)}
        />
      )}
      {chartDialog && (
        <ChartDialog
          sheet={activeSheet}
          initialKind={chartDialog.kind}
          initialRange={chartDialog.range}
          read={chartReader}
          editing={editingChart}
          onCreate={handleCreateChart}
          onClose={() => {
            setChartDialog(null);
            setEditingChart(null);
          }}
        />
      )}
      {cfTopBottomOpen && (
        <TopBottomDialog
          cellLabel={cellLabelOf(sel.row, sel.col)}
          onClose={() => setCfTopBottomOpen(false)}
          onAddTopBottom={(tb, n) => { addExtCFRule({ kind: 'topN', topBottom: tb, n }); setCfTopBottomOpen(false); }}
          onAddAboveAverage={() => { addExtCFRule({ kind: 'topN', aboveAverage: true }); setCfTopBottomOpen(false); }}
        />
      )}
      {cfDataBarOpen && (
        <DataBarDialog
          cellLabel={cellLabelOf(sel.row, sel.col)}
          onClose={() => setCfDataBarOpen(false)}
          onAdd={(color) => { addExtCFRule({ kind: 'dataBar', color }); setCfDataBarOpen(false); }}
        />
      )}
      {cfColorScaleOpen && (
        <ColorScaleDialog
          cellLabel={cellLabelOf(sel.row, sel.col)}
          onClose={() => setCfColorScaleOpen(false)}
          onAdd={(low, high) => { addExtCFRule({ kind: 'colorScale', color: low, color2: high }); setCfColorScaleOpen(false); }}
        />
      )}
      {cfIconSetOpen && (
        <IconSetDialog
          cellLabel={cellLabelOf(sel.row, sel.col)}
          onClose={() => setCfIconSetOpen(false)}
          onAdd={() => { addExtCFRule({ kind: 'iconSet', iconSet: 'arrows3' }); setCfIconSetOpen(false); }}
        />
      )}
      {formatCellsOpen && (
        <FormatCellsDialog
          cellLabel={cellLabelOf(sel.row, sel.col)}
          format={selectedFormat}
          onClose={() => setFormatCellsOpen(false)}
          onFormat={handleFormat}
          onClearFormat={handleClearFormat}
        />
      )}
      {unhideOpen && (
        <A11yDialog title={<>Unhide Sheets</>} onClose={() => setUnhideOpen(false)}>
            <div style={{ maxHeight: 240, overflow: 'auto' }}>
              {[...hiddenSheets].map((name) => (
                <div key={name} className="dialog-row">
                  <span>{name}</span>
                  <button
                    onClick={() => {
                      setHiddenSheets((prev) => {
                        const next = new Set(prev);
                        next.delete(name);
                        return next;
                      });
                      setUnhideOpen(false);
                    }}
                  >
                    Unhide
                  </button>
                </div>
              ))}
              {hiddenSheets.size === 0 && <p>No hidden sheets.</p>}
            </div>
            <div className="dialog-actions">
              <button onClick={() => setUnhideOpen(false)}>Close</button>
            </div>
        </A11yDialog>
      )}
      {spellingOpen && (
        <A11yDialog
          title={<>Spelling ({spellingIssues.length} issue{spellingIssues.length === 1 ? '' : 's'})</>}
          onClose={() => setSpellingOpen(false)}
        >
            <div style={{ maxHeight: 300, overflow: 'auto' }}>
              {spellingIssues.length === 0 ? (
                <p>No misspellings found.</p>
              ) : (
                spellingIssues.slice(0, 50).map((issue, i) => (
                  <div key={i} className="dialog-row">
                    <span>{cellLabelOf(issue.row, issue.col)}:</span>
                    <strong>{issue.word}</strong>
                    <button onClick={() => { setSel({ row: issue.row, col: issue.col }); setSpellingOpen(false); }}>
                      Go to
                    </button>
                  </div>
                ))
              )}
            </div>
            <div className="dialog-actions">
              <button onClick={() => setSpellingOpen(false)}>Close</button>
            </div>
        </A11yDialog>
      )}
      {/* Screen-reader live region for cell changes (track 23). */}
      <div aria-live="polite" aria-atomic="true" className="sr-only" role="status">
        {liveMessage}
      </div>
      {/* AI Agent entry point (track 29): chat is one surface to the agent. */}
      {!agentOpen && (
        <button
          type="button"
          className="agent-fab"
          onClick={() => setAgentOpen(true)}
          title="Open the AI Agent chat"
          aria-label="Open the AI Agent chat"
        >
          ✦ Agent
        </button>
      )}
      {/* Voice command palette entry point (Pro tier). Default-tier
          sessions see the Pro marker up front and the labeled gate
          inside — never a silent absence. */}
      {!voicePaletteOpen && (
        <button
          type="button"
          className="voice-fab"
          onClick={() => setVoicePaletteOpen(true)}
          title="Open the voice command palette (Ctrl+Shift+P)"
          aria-label="Open the voice command palette"
        >
          🎙️ Voice{paletteTier === 'default' ? ' · Pro' : ''}
        </button>
      )}
      {agentOpen && isDesktop() && desktopAuthed === false && (
        <A11yDialog title={<>Sign in for the AI Agent</>} onClose={() => setAgentOpen(false)}>
            <p className="dialog-hint">
              The AI Agent runs as a remote service behind the API gateway and
              requires sign-in. Your spreadsheets keep working fully offline
              either way.
            </p>
            <div className="dialog-actions">
              <button onClick={() => setAgentOpen(false)}>Not now</button>
              <button
                className="primary"
                onClick={() => {
                  openDesktopLogin();
                  // Re-check after the login window closes (poll briefly).
                  let tries = 0;
                  const t = setInterval(() => {
                    tries += 1;
                    void desktopAuthStatus().then((s) => {
                      if (s.loggedIn || tries > 20) {
                        clearInterval(t);
                        setDesktopAuthed(s.loggedIn);
                      }
                    });
                  }, 1000);
                }}
              >
                Sign in…
              </button>
            </div>
        </A11yDialog>
      )}
      {joinFailure && (
        // Issue #17: blocking error state for a failed join-by-link. The
        // grid behind it is NOT usable — this covers the whole app
        // until the user leaves or retries. Copy names the file and the
        // next step; no ids or raw error text ever render here.
        <div className="join-failure-overlay">
          <div className="join-failure-card" role="alertdialog" aria-modal="true" aria-labelledby="join-failure-title">
            <h2 id="join-failure-title">{joinFailure.fileName}</h2>
            <p>{joinFailure.message}</p>
            <div className="join-failure-actions">
              <button
                type="button"
                onClick={() => {
                  window.location.assign(window.location.origin + window.location.pathname);
                }}
              >
                Back to files
              </button>
              <button type="button" onClick={() => window.location.reload()}>
                Try again
              </button>
            </div>
          </div>
        </div>
      )}
      {shareSpec && (
        // Share recipient landing (shell integration): the shared app
        // full-screen over its data copy in the grid. Restore returns
        // to the working view — this grid, with the app open in the
        // chat panel.
        <SharedAppLanding
          spec={shareSpec}
          mcpCall={artifactMcpCall}
          onRestore={() => {
            setChatArtifactRequest({ id: shareSpec.id, seq: Date.now() });
            setShareSpec(null);
            setAgentOpen(true);
          }}
        />
      )}
      {dataTypeCardKey && dataTypeCells.get(dataTypeCardKey) && (
        <div style={{ position: 'absolute', left: 300, top: 180, zIndex: 70 }}>
          <DataTypeCard
            value={dataTypeCells.get(dataTypeCardKey)!}
            onClose={() => setDataTypeCardKey(null)}
            onExtractField={(_label, fieldValue) => {
              commitCell(sel.row + 1, sel.col, fieldValue);
              setDataTypeCardKey(null);
            }}
          />
        </div>
      )}
      {smartChipCardKey && smartChipCells.get(smartChipCardKey) && (
        <div style={{ position: 'absolute', left: 580, top: 180, zIndex: 70 }}>
          <SmartChipCard
            value={smartChipCells.get(smartChipCardKey)!}
            onClose={() => setSmartChipCardKey(null)}
            onExtractField={(_label, fieldValue) => {
              commitCell(sel.row + 1, sel.col, fieldValue);
              setSmartChipCardKey(null);
            }}
          />
        </div>
      )}
      </div>{/* .app-main-col */}
      {agentOpen && !(isDesktop() && desktopAuthed === false) && (
        <AgentChat
          runtime={getAgentRuntime()}
          sheet={sheet}
          onClose={() => setAgentOpen(false)}
          watchSupported={!isGatewayMode() && !isDesktop()}
          artifactStore={artifactStore}
          artifactMcpCall={artifactMcpCall}
          initialArtifactRequest={chatArtifactRequest}
          initialDraft={chatDraftSeed}
        />
      )}
      </div>{/* .app-body-row */}
    </div>
    </>
  );
}
