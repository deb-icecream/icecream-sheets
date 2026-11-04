/**
 * Named ranges and named functions — browser-safe service surface.
 *
 * Design-docs/named-ranges-and-named-functions.md. The sandboxed execution
 * runtime (node:vm / python3) lives in './node.js' and is intentionally NOT
 * re-exported here — import it from '@icecream-sheets/service/names-node'
 * (same split as the automation lane's automation-node subpath).
 */
export {
  NameError,
  nameKey,
  scopeKey,
  validateNameSyntax,
  isValidDefinedName,
  NAMED_VALUE_TYPES,
  isNamedValueType,
  NAMED_FUNCTION_LANGUAGES,
  isNamedFunctionLanguage,
  type NamedRangeDef,
  type NameRangeRef,
  type NameScope,
  type NamedValueType,
  type NamedFunctionParam,
  type NamedFunctionSignature,
  type NamedFunctionLanguage,
  type NamedFunctionVersion,
  type NamedFunctionDef,
  type NameErrorCode,
  type NameValidationOptions,
} from './types.js';

export {
  quoteSheetName,
  unquoteSheetName,
  formatAbsoluteRef,
  parseDefinedNameRef,
  refToTarget,
} from './a1.js';
// NOTE: colIndexToLetters / colLettersToIndex / parseA1Range are already
// exported from the service root (chartModel); this module uses its own
// copies internally but does not re-export them to avoid duplicates.

export {
  NamedRangeStore,
  type AuthorizeFn,
  type CreateNamedRangeStoreOptions,
  type DefineNameInput,
  type DefinedNameLike,
  type NamedRangeStoreOptions,
  type NameResolution,
} from './namedRanges.js';

export {
  NamedFunctionRegistry,
  validateSignature,
  validatedSource,
  stripTypeScript,
  compileToLambda,
  extractExpressionBody,
  isExpressionSyntax,
  isFunctionBodySyntax,
  transpileJsExpressionToFormula,
  parseLambdaRef,
  type CreateNamedFunctionRegistryOptions,
  type InvokeFn,
  type NamedFunctionRegistryOptions,
  type DefineFunctionInput,
  type UpdateFunctionInput,
} from './namedFunctions.js';

export {
  bindNamedRanges,
  bindNamedFunctions,
  bindForSubject,
  bindAll,
  unbindAll,
  PERM_DENIED_EXPR,
  type NameEnginePort,
  type BindStats,
} from './engineBinding.js';

export {
  SharingService,
  isShareLevel,
  type ShareLevel,
  type GrantRow,
  type AccessRequestRow,
  type AccessRequestOptions,
  type SharingServiceOptions,
} from './sharing.js';
