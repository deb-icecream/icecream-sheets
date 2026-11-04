/**
 * Header/footer feature — web re-export shim.
 *
 * The canonical model and Excel field-code expansion live in the
 * service layer (`@icecream-sheets/service` headerFooter.ts, per
 * AGENT.md §0). This module re-exports that API plus the legacy
 * web names (`renderHFText`, `renderHFSection`, `emptySection`) so
 * existing consumers keep working.
 */
export {
  HEADER_FOOTER_VERSION,
  defaultHeaderFooter,
  emptyHFSection,
  expandHFCodes,
  expandHFSection,
  isHFEmpty,
  isHFSectionEmpty,
  renderHFSectionPreview,
  sectionForPage,
  validateHeaderFooter,
  type HeaderFooterSettings,
  type HFRenderContext,
  type HFSection,
} from '@icecream-sheets/service';

/** Legacy alias: expand Excel field codes in a header/footer string. */
export { expandHFCodes as renderHFText } from '@icecream-sheets/service';
/** Legacy alias: join a section's expanded parts for single-line preview. */
export { renderHFSectionPreview as renderHFSection } from '@icecream-sheets/service';
/** Legacy alias: blank header/footer section. */
export { emptyHFSection as emptySection } from '@icecream-sheets/service';
