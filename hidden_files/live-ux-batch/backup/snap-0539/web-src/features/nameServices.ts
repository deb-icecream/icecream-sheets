/**
 * Per-workbook name services for the web app.
 *
 * Owns the service-layer model for named ranges, named functions, and
 * sharing (design-docs/named-ranges-and-named-functions.md):
 *   - NamedRangeStore: stable IDs, scope, shadowing, dangling names
 *   - NamedFunctionRegistry: typed signatures, versioning
 *   - AccessTable + SharingService: Viewer/Editor/Manager grants
 *
 * Each workbook gets a stable ID; the stores persist via localStorage.
 * On open, defined names from the XLSX adapter are imported into the
 * stores, then bound to the engine. On save, the stores export back to
 * defined names.
 */
import {
  AccessTable,
  KeyManager,
  NamedFunctionRegistry,
  NamedRangeStore,
  SharingService,
  bindAll,
  type DefinedNameLike,
  type Persistence,
} from '@icecream-sheets/service';
import type { EngineWorkbook } from '@icecream-sheets/engine';

const STORAGE_PREFIX = 'icecream.names.';
const WORKBOOK_IDS_KEY = 'icecream.workbookIds';

/** localStorage-backed Persistence for the service stores. */
function localStoragePersistence(): Persistence {
  return {
    load: (key: string) => {
      try {
        return localStorage.getItem(`${STORAGE_PREFIX}${key}`);
      } catch {
        return null;
      }
    },
    save: (key: string, value: string) => {
      try {
        localStorage.setItem(`${STORAGE_PREFIX}${key}`, value);
      } catch {
        // Storage full; non-fatal.
      }
    },
    clear: (key: string) => {
      try {
        localStorage.removeItem(`${STORAGE_PREFIX}${key}`);
      } catch {
        // Ignore.
      }
    },
  };
}

/** Stable per-workbook ID, persisted across sessions. */
export function getWorkbookId(workbookName: string): string {
  const key = `${STORAGE_PREFIX}id.${workbookName}`;
  let id: string | null = null;
  try {
    id = localStorage.getItem(key);
  } catch {
    // Ignore.
  }
  if (!id) {
    id = `wb_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
    try {
      localStorage.setItem(key, id);
    } catch {
      // Ignore.
    }
  }
  return id;
}

/** The local user is the workbook owner with full rights. */
export const OWNER_PRINCIPAL = 'owner';

export interface NameServices {
  workbookId: string;
  ranges: NamedRangeStore;
  functions: NamedFunctionRegistry;
  access: AccessTable;
  sharing: SharingService;
  /** Persist all store definitions (stores auto-persist on change). */
  persist(): void;
  /** Bind all names/functions to the engine for the given subject. */
  bindToEngine(wb: EngineWorkbook): void;
}

/**
 * Create (or load) the name services for a workbook.
 *
 * Async: the stores are encrypted at rest (WebCrypto), so they are built
 * through the async `create()` factories. Callers should suspend on the
 * returned promise (see useNameServices).
 *
 * @param workbookName Human-readable name (for the storage key).
 */
export async function createNameServices(workbookName: string): Promise<NameServices> {
  const workbookId = getWorkbookId(workbookName);
  const persistence = localStoragePersistence();
  // One KeyManager per service instance (design §7); the name stores scope
  // their encrypted persistence to the workbookId, the access table to the
  // service scope.
  const keys = new KeyManager(persistence);

  // The local owner has full rights; authorize everything (sync).
  const authorize = (): boolean => true;

  const [ranges, functions, access] = await Promise.all([
    NamedRangeStore.create({
      persistence,
      workbookId,
      authorize,
      keys,
    }),
    NamedFunctionRegistry.create({
      persistence,
      workbookId,
      authorize,
      // Browser: static checks only. Python/statement bodies need the service
      // runtime; they bind as stubs (calls evaluate to #VALUE!).
      invoke: () => ({ error: 'Service runtime required for this function.' }),
      keys,
    }),
    AccessTable.create(persistence, keys),
  ]);

  const sharing = new SharingService({ table: access, workbookId });
  // Ensure the local owner row exists.
  await sharing.ensureOwner(OWNER_PRINCIPAL);

  const services: NameServices = {
    workbookId,
    ranges,
    functions,
    access,
    sharing,

    persist() {
      // The stores persist automatically via the Persistence layer on
      // every mutation. This is a no-op for API compatibility.
    },

    bindToEngine(wb: EngineWorkbook) {
      // The EngineWorkbook satisfies the service's NameEnginePort.
      // bindAll pushes every definition (or =ICEPERMDENIED() for denied
      // names) into the engine, so formulas resolve through the store.
      const port = {
        addNamedExpression: (name: string, ref: string, sheetIndex?: number) =>
          wb.addNamedExpression(name, ref, sheetIndex),
        changeNamedExpression: (name: string, ref: string, sheetIndex?: number) =>
          wb.changeNamedExpression(name, ref, sheetIndex),
        removeNamedExpression: (name: string, sheetIndex?: number) =>
          wb.removeNamedExpression(name, sheetIndex),
        getNamedExpressionFormula: (name: string, sheetIndex?: number) =>
          wb.getNamedExpressionFormula(name, sheetIndex),
        listNamedExpressions: (sheetIndex?: number) =>
          wb.listNamedExpressions(sheetIndex),
        defineNamedFunction: (name: string, lambda: string | null) =>
          wb.defineNamedFunction(name, lambda),
        removeNamedFunction: (name: string) => wb.removeNamedFunction(name),
        sheetIndex: (name: string) => wb.sheetIndex(name),
        sheetNames: () => wb.sheetNames(),
      };
      try {
        bindAll(ranges, functions, port);
      } catch {
        // Binding is best-effort; the engine's own defined-names path
        // (constructor) already covers the common case.
      }
    },
  };

  return services;
}

/** Export store definitions as XLSX defined names (for save). */
export function exportDefinedNames(
  services: NameServices,
  sheetNames: string[],
): DefinedNameLike[] {
  return services.ranges.toDefinedNames(sheetNames);
}

/** Import XLSX defined names into the stores (for open). */
export async function importDefinedNames(
  services: NameServices,
  names: DefinedNameLike[],
  sheetNames: string[],
): Promise<{ imported: string[]; skipped: { name: string; reason: string }[] }> {
  return services.ranges.importDefinedNames(names, sheetNames, OWNER_PRINCIPAL);
}
