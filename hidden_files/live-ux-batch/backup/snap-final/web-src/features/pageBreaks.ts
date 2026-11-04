/**
 * Manual page breaks (Page Layout > Page Setup > Breaks).
 *
 * The canonical model lives in @icecream-sheets/service (pageBreaks.ts) and
 * is re-exported here so the web app has a single source of truth. Breaks
 * are consumed by the service pagination engine (paginateSheet), which both
 * the print preview and Download-as-PDF use — there is no client-side
 * pagination fork.
 */
export {
  PAGE_BREAKS_METADATA_PREFIX,
  EMPTY_PAGE_BREAKS,
  pageBreaksMetadataKey,
  insertRowBreak,
  removeRowBreak,
  insertColBreak,
  removeColBreak,
  resetPageBreaks,
  hasPageBreaks,
  pageBreaksToMetadata,
  pageBreaksFromMetadata,
  type PageBreaks,
} from '@icecream-sheets/service';
