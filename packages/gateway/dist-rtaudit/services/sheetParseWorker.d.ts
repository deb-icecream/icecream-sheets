import { type FastSheetResult } from '@icecream-sheets/xlsx-adapter';
export interface SheetParseTask {
    sheetIndex: number;
    xmlBytes: Uint8Array;
    sharedStrings: string[];
    styleFormatCodes: string[];
    display: boolean;
    streamChunks: boolean;
}
export type WorkerSheetResult = Omit<FastSheetResult, 'rows' | 'displayRows'> & {
    rows: FastSheetResult['rows'] | null;
    displayRows: FastSheetResult['displayRows'];
};
