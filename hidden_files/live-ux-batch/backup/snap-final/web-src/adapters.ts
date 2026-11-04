/**
 * Storage adapter registration for the web app (track 9).
 *
 * The engine's AdapterRegistry maps file extensions to StorageAdapters; the
 * engine core itself never imports a concrete adapter. This module is the
 * host-side wiring: it registers the xlsx/xlsb/csv/tsv/ods adapters into the
 * engine's default registry so Open/Save resolve the right adapter by file
 * extension. Call registerAdapters() once at app startup (idempotent).
 */
import { defaultAdapters, type StorageAdapter } from '@icecream-sheets/engine';
import { HtmlAdapter } from '@icecream-sheets/engine';
import { XlsxAdapter } from '@icecream-sheets/xlsx-adapter';
import { CsvAdapter, TsvAdapter } from '@icecream-sheets/csv-adapter';
import { OdsAdapter } from '@icecream-sheets/ods-adapter';
import { XlsbAdapter } from '@icecream-sheets/xlsb-adapter';

export const SAVE_FORMATS = [
  { id: 'xlsx', label: 'Excel Workbook (.xlsx)', ext: 'xlsx', mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' },
  { id: 'xlsb', label: 'Excel Binary Workbook (.xlsb)', ext: 'xlsb', mime: 'application/vnd.ms-excel.sheet.binary.macroEnabled.12' },
  { id: 'csv', label: 'CSV (.csv)', ext: 'csv', mime: 'text/csv' },
  { id: 'tsv', label: 'TSV (.tsv)', ext: 'tsv', mime: 'text/tab-separated-values' },
  { id: 'ods', label: 'OpenDocument (.ods)', ext: 'ods', mime: 'application/vnd.oasis.opendocument.spreadsheet' },
  { id: 'html', label: 'Web Page (.html)', ext: 'html', mime: 'text/html' },
] as const;

export type SaveFormatId = (typeof SAVE_FORMATS)[number]['id'];

export function saveFormatById(id: string): (typeof SAVE_FORMATS)[number] {
  return SAVE_FORMATS.find((f) => f.id === id) ?? SAVE_FORMATS[0];
}

let registered = false;

/** Register all storage adapters with the engine's default registry. */
export function registerAdapters(): void {
  if (registered) return;
  registered = true;
  if (!defaultAdapters.forName('xlsx')) {
    defaultAdapters.register({
      adapter: new XlsxAdapter(),
      extensions: ['xlsx', 'xlsm', 'xltx', 'xltm'],
      mimeTypes: ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
    });
  }
  if (!defaultAdapters.forName('csv')) {
    defaultAdapters.register({
      adapter: new CsvAdapter(),
      extensions: ['csv'],
      mimeTypes: ['text/csv'],
    });
  }
  if (!defaultAdapters.forName('tsv')) {
    defaultAdapters.register({
      adapter: new TsvAdapter(),
      extensions: ['tsv'],
      mimeTypes: ['text/tab-separated-values'],
    });
  }
  if (!defaultAdapters.forName('ods')) {
    defaultAdapters.register({
      adapter: new OdsAdapter(),
      extensions: ['ods'],
      mimeTypes: ['application/vnd.oasis.opendocument.spreadsheet'],
    });
  }
  if (!defaultAdapters.forName('xlsb')) {
    defaultAdapters.register({
      adapter: new XlsbAdapter(),
      extensions: ['xlsb'],
      mimeTypes: ['application/vnd.ms-excel.sheet.binary.macroEnabled.12'],
    });
  }
  if (!defaultAdapters.forName('html')) {
    defaultAdapters.register({
      adapter: new HtmlAdapter(),
      extensions: ['html', 'htm'],
      mimeTypes: ['text/html'],
    });
  }
}

/**
 * Resolve the adapter for an uploaded file by its extension. Falls back to
 * the xlsx adapter for unknown/missing extensions (historical behavior).
 */
export function adapterForFilename(filename: string): StorageAdapter {
  registerAdapters();
  return defaultAdapters.forFilename(filename) ?? defaultAdapters.forName('xlsx')!;
}

/** Resolve the adapter for a save-format id ('xlsx' | 'csv' | 'tsv' | 'ods' | 'html'). */
export function adapterForSaveFormat(id: SaveFormatId): StorageAdapter {
  registerAdapters();
  const adapter = defaultAdapters.forName(id);
  if (!adapter) throw new Error(`No storage adapter registered for save format "${id}"`);
  return adapter;
}
