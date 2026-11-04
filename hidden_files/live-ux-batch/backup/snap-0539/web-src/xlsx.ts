/**
 * XLSX adapter entry point.
 *
 * Uses the real workspace package @icecream-sheets/xlsx-adapter
 * (SheetJS-backed StorageAdapter). All Open/Save code programs against the
 * StorageAdapter interface from @icecream-sheets/engine, so the adapter
 * remains swappable.
 */
export { XlsxAdapter } from '@icecream-sheets/xlsx-adapter';
