/**
 * Web adapter for the report metadata store.
 *
 * Per design-docs/native-reports-and-dashboards.md §2, report specs live in
 * the service metadata store. This module binds the generic
 * @icecream-sheets/service MetadataStore to browser localStorage.
 *
 * Pure serialize/deserialize/migrate/validate functions live in the service
 * package; import them from '@icecream-sheets/service'.
 */
import {
  createReportStore,
  type Persistence,
  type ReportSpec,
} from '@icecream-sheets/service';

// Re-export pure functions from the service package for convenience.
export {
  REPORT_SPEC_VERSION,
  makeReportSpec,
  migrateReportSpec,
  validateReportSpec,
  serializeReports,
  deserializeReports,
  isRefreshDue,
  type ReportBinding,
  type ReportVisual,
  type ReportVisualKind,
  type ReportLayout,
  type ReportLayoutCell,
  type RefreshMode,
  type RefreshSchedule,
  type ReportRefresh,
  type ReportSpec,
  type KpiSpec,
  type KpiResult,
  type ReportSlicer,
  type ReportFilter,
} from '@icecream-sheets/service';

/** localStorage-backed persistence for the web client. */
const localStoragePersistence: Persistence = {
  load: (key) => {
    try {
      return typeof localStorage === 'undefined' ? null : localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  save: (key, value) => {
    try {
      if (typeof localStorage !== 'undefined') localStorage.setItem(key, value);
    } catch {
      // Storage full / private mode — reports still live in App state.
    }
  },
  clear: (key) => {
    try {
      if (typeof localStorage !== 'undefined') localStorage.removeItem(key);
    } catch {
      // ignore
    }
  },
};

/** Singleton report-spec store for the web client. */
const reportStore = createReportStore(localStoragePersistence);

/** Persist reports to the browser metadata store. No-op outside browsers. */
export function persistReports(reports: ReportSpec[]): void {
  reportStore.saveAll(reports);
}

/** Restore reports from the browser metadata store. */
export function restoreReports(): ReportSpec[] {
  return reportStore.all();
}

/** Clear the persisted reports (used by "New workbook" reset). */
export function clearStoredReports(): void {
  reportStore.clear();
}
