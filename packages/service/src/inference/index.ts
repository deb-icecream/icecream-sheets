/**
 * Deterministic inference (design-docs/deterministic-inference.md).
 *
 * Deterministic analyzers producing inspectable, reversible proposals for
 * autocomplete, formula suggestions, and cleanup. Separate from the AI
 * Agent: no model calls, no learning across workbooks (v1 out of scope),
 * nothing auto-applies.
 *
 * All analyzers are headless: they take an InferenceContext (typed-view
 * reader + bound authorize()) and return Proposal objects. The host
 * applies accepted edits through its own permissioned write path.
 */
export {
  nextProposalId,
  selectProposalEdits,
  applyProposalEdits,
  type ApplyResult,
  type CellCoord,
  type Proposal,
  type ProposalExecutor,
  type ProposedEdit,
  type ProposalKind,
  type ProposalPreviewCell,
} from './types.js';
export {
  a1Cell,
  a1Range,
  colToLetters,
  displayValue as inferenceDisplayValue,
  isReadableValue,
  lettersToCol,
  type InferenceAuthorize,
  type InferenceCell,
  type InferenceContext,
  type InferenceReader,
  type InferenceUsedRange,
  type RangeBounds,
} from './ports.js';
export {
  canReadCell,
  canWriteCell,
  cellTarget,
  filterEditsByPermission,
} from './permissions.js';
export {
  autocompleteFormula,
  completionAtCaret,
  rangeColumnsFromGrid,
  suggestCellValues,
  suggestFunctions,
  suggestRangeRefs,
  type AutocompleteOptions,
  type FormulaCompletionKind,
  type FormulaCompletionRequest,
  type FunctionSuggestion,
  type RangeColumnInfo,
  type RangeSuggestion,
  type ValueSuggestion,
} from './autocomplete.js';
export {
  columnDataRange,
  profileColumns,
  suggestFormulasForSheet,
  type ColumnData,
  type FormulaSuggestion,
  type SuggestFormulasOptions,
} from './formulas.js';
export {
  cleanupProposalsForSheet,
  whitespaceCleanupProposal,
  type CleanupOptions,
} from './cleanup.js';
export type { FunctionCatalogEntry } from './functions.generated.js';
export { FUNCTION_CATALOG, FUNCTION_CATALOG_VERSION } from './functions.generated.js';
