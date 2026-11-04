/**
 * Web adapter for the service metadata store.
 *
 * Per design-docs/native-reports-and-dashboards.md §2, chart specs live in
 * the service metadata store. This module binds the generic
 * @icecream-sheets/service MetadataStore to browser localStorage.
 *
 * Pure serialize/deserialize/migrate functions live in the service package;
 * import them from '@icecream-sheets/service'.
 */
import {
  createChartStore,
  type ChartSpec,
  type Persistence,
} from '@icecream-sheets/service';

// Re-export pure functions from the service package for convenience.
export {
  serializeCharts,
  deserializeCharts,
  migrateChart,
  type StoredCharts,
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
      // Storage full / private mode — charts still live in App state.
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

/** Singleton chart-spec store for the web client. */
const chartStore = createChartStore(localStoragePersistence);

/** Persist charts to the browser metadata store. No-op outside browsers. */
export function persistCharts(charts: ChartSpec[]): void {
  chartStore.saveAll(charts);
}

/** Restore charts from the browser metadata store. */
export function restoreCharts(): ChartSpec[] {
  return chartStore.all();
}

/** Clear the persisted charts (used by "New workbook" reset). */
export function clearStoredCharts(): void {
  chartStore.clear();
}
