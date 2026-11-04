/**
 * React hook owning the per-workbook name services.
 *
 * Creates the NamedRangeStore, NamedFunctionRegistry, AccessTable, and
 * SharingService for the current workbook (stable ID + localStorage
 * persistence), binds them to the engine, and exposes a version counter so
 * dialogs refresh when the stores change.
 *
 * Store creation is async (encrypted at rest via WebCrypto). The promise is
 * cached per workbook name and the first render suspends until it resolves
 * (Suspense boundary in main.tsx), so `services` keeps its synchronous
 * non-null type for every consumer.
 */
import { useMemo, useState, useCallback } from 'react';
import { suspended } from '../suspended';
import {
  createNameServices,
  importDefinedNames,
  exportDefinedNames,
  OWNER_PRINCIPAL,
  type NameServices,
} from './nameServices';
import type { EngineWorkbook } from '@icecream-sheets/engine';
import type { DefinedNameLike } from '@icecream-sheets/service';

export function useNameServices(workbookName: string) {
  const services: NameServices = suspended(
    `name-services:${workbookName}`,
    () => createNameServices(workbookName),
  );
  const [version, setVersion] = useState(0);

  const changed = useCallback(() => {
    services.persist();
    setVersion((v) => v + 1);
  }, [services]);

  const bindToEngine = useCallback(
    (wb: EngineWorkbook) => {
      services.bindToEngine(wb);
    },
    [services],
  );

  const importFromDefinedNames = useCallback(
    async (names: DefinedNameLike[], sheetNames: string[]): Promise<void> => {
      await importDefinedNames(services, names, sheetNames);
      changed();
    },
    [services, changed],
  );

  const exportToDefinedNames = useCallback(
    (sheetNames: string[]): DefinedNameLike[] => {
      return exportDefinedNames(services, sheetNames);
    },
    [services],
  );

  return useMemo(
    () => ({
      services,
      version,
      changed,
      bindToEngine,
      importFromDefinedNames,
      exportToDefinedNames,
      principal: OWNER_PRINCIPAL,
    }),
    [services, version, changed, bindToEngine, importFromDefinedNames, exportToDefinedNames],
  );
}

export type NameServicesHandle = ReturnType<typeof useNameServices>;
