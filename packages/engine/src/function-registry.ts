/**
 * Versioned function registry — the SOURCE OF TRUTH for the function
 * inventory (design-docs/platform-shell.md §5: "The function list opens the
 * function reference generated from the versioned function registry").
 *
 * The function SET is generated from the actual HyperFormula plugin
 * registrations — HyperFormula built-ins plus every engine plugin batch
 * registered via ./plugins.js (imported below for its side effects) — never
 * from a hand-maintained name list. Each entry carries:
 *
 *   name        — uppercase function name as registered (e.g. 'SUM')
 *   version     — per-function semantic version, bumped when the function's
 *                 behavior changes (see PLUGIN_VERSIONS below)
 *   category    — Excel-style category for the function reference
 *   signature   — argument hint, e.g. 'SUM(number1, [number2], …)'
 *   description — one-line description
 *
 * FUNCTION_REGISTRY_VERSION bumps whenever the function set changes or any
 * entry's version/category/signature/description changes. Hosts that bundle
 * a generated list (apps/web/src/features/functionList.ts) export the
 * registry version they were generated from as FUNCTION_LIST_VERSION and
 * compare it against this at runtime to detect stale lists
 * (see apps/web/src/features/functions.ts isFunctionListStale()).
 *
 * Versioning contract (humans must honor this when touching plugins):
 * - Each engine-owned plugin batch has an entry in PLUGIN_VERSIONS keyed by
 *   its plugin class. When a batch's function semantics change (new
 *   behavior, a behavior-changing bug fix, changed argument handling),
 *   bump that batch's version AND FUNCTION_REGISTRY_VERSION.
 * - HyperFormula built-ins share BUILTIN_FUNCTION_VERSION; bump it (and the
 *   registry version) when a hyperformula upgrade changes built-in
 *   semantics.
 * - Adding/removing a function, or editing curated metadata below, bumps
 *   FUNCTION_REGISTRY_VERSION.
 *
 * Internal functions (never user-callable worksheet functions) are excluded
 * from the registry by rule, not by list: names starting with 'ICE' are the
 * engine's internal-function prefix (ICEPERMDENIED, ICENAMEDFUNC,
 * ICECEILING, ICEWORKDAYINTL, ICEEVAL, …), and HyperFormula's own VERSION
 * meta-function is not a worksheet function. HF.* operator functions ARE
 * included — they are real registered functions and the pre-registry
 * function list already documented them.
 */

// Side effects register every engine plugin batch with HyperFormula.
import './plugins.js';
import { HyperFormula, FunctionArgumentType } from 'hyperformula';
import type { FunctionPluginDefinition } from 'hyperformula';

// Engine-owned plugin batches (for PLUGIN_VERSIONS keys).
import { CompatPlugin, ConcatAliasPlugin } from './function-aliases.js';
import { CubeFunctionsPlugin } from './cube-functions.js';
import { DivergentBuiltinsPlugin } from './divergent-builtins.js';
import { SubtotalOverridePlugin } from './hf-overrides.js';
import { DynamicArrayPlugin } from './dynamic-arrays.js';
import { ExtendedFunctions11Plugin } from './extended-functions11.js';
import { ExtendedPlugin } from './extended-functions.js';
import { ExtendedPlugin2 } from './extended-functions2.js';
import { ExtendedPlugin3 } from './extended-functions3.js';
import { ExtendedPlugin4 } from './extended-functions4.js';
import { ExtendedPlugin5 } from './extended-functions5.js';
import { ExtendedPlugin7 } from './extended-functions7.js';
import { ExtendedPlugin8 } from './extended-functions8.js';
import { ExtendedPlugin9 } from './extended-functions9.js';
import { ExtendedPlugin10 } from './extended-functions10.js';
import { FinancialPlugin } from './financial-functions.js';
import { FinancialPlugin2 } from './financial-functions2.js';
import { FinancialPlugin3 } from './financial-functions3.js';
import { GroupByPlugin } from './groupby-functions.js';
import { GoogleFunctionsPlugin } from './google-functions.js';
import { BetadistOverridePlugin, CeilingMathOverridePlugin, HfOverridesPlugin, IntModOverridePlugin, LogicalOverridePlugin, PercentrankOverridePlugin, TextOverridePlugin } from './hf-overrides.js';
import { ImportFunctionsPlugin } from './import-functions.js';
import { LambdaPlugin } from './lambda-functions.js';
import { NamedFunctionPlugin } from './named-function-plugin.js';
import { PermDeniedPlugin } from './perm-error.js';

/** One entry of the versioned function registry. */
export interface FunctionRegistryEntry {
  /** Uppercase function name as registered, e.g. 'SUM'. */
  name: string;
  /** Per-function semantic version — bumped when the function's behavior changes. */
  version: number;
  /** Excel-style category for the function reference. */
  category: string;
  /** Argument hint, e.g. 'SUM(number1, [number2], …)'. */
  signature: string;
  /** One-line description. */
  description: string;
}

/**
 * Registry version. Bump whenever the function set changes or any entry's
 * version/category/signature/description changes.
 */
export const FUNCTION_REGISTRY_VERSION = 2;

/**
 * Per-plugin-batch function versions, keyed by plugin class (rename-proof:
 * the reference follows the class). Bump a batch's version when any of its
 * functions' semantics change, and bump FUNCTION_REGISTRY_VERSION too.
 * Plugin classes absent here are HyperFormula built-ins, which share
 * BUILTIN_FUNCTION_VERSION.
 */
const PLUGIN_VERSIONS = new Map<FunctionPluginDefinition, number>([
  [CompatPlugin, 1],
  [ConcatAliasPlugin, 1],
  [CubeFunctionsPlugin, 1],
  [DivergentBuiltinsPlugin, 1],
  [SubtotalOverridePlugin, 1],
  [DynamicArrayPlugin, 1],
  [ExtendedFunctions11Plugin, 1],
  [ExtendedPlugin, 1],
  [ExtendedPlugin2, 2],
  [ExtendedPlugin3, 1],
  [ExtendedPlugin4, 2],
  [ExtendedPlugin5, 2],
  [ExtendedPlugin7, 2],
  [ExtendedPlugin8, 1],
  [ExtendedPlugin9, 1],
  [ExtendedPlugin10, 1],
  [FinancialPlugin, 2],
  [FinancialPlugin2, 1],
  [FinancialPlugin3, 1],
  [GoogleFunctionsPlugin, 1],
  [GroupByPlugin, 1],
  [HfOverridesPlugin, 1],
  [IntModOverridePlugin, 1],
  [CeilingMathOverridePlugin, 1],
  [PercentrankOverridePlugin, 1],
  [BetadistOverridePlugin, 1],
  [ImportFunctionsPlugin, 1],
  [LambdaPlugin, 2],
  [LogicalOverridePlugin, 1],
  [TextOverridePlugin, 1],
  [NamedFunctionPlugin, 1],
  [PermDeniedPlugin, 1],
]);

/**
 * Shared version for HyperFormula built-in functions. Bump (with
 * FUNCTION_REGISTRY_VERSION) when a hyperformula upgrade changes built-in
 * semantics.
 */
const BUILTIN_FUNCTION_VERSION = 1;

/**
 * Internal functions excluded from the registry by rule: the 'ICE' prefix
 * marks engine-internal functions (ICEPERMDENIED, ICENAMEDFUNC, ICECEILING,
 * ICEWORKDAYINTL, ICEEVAL, …) that are never user-callable worksheet
 * functions, and VERSION is HyperFormula's own meta-function.
 */
function isInternalFunctionName(name: string): boolean {
  return name === 'VERSION' || name.startsWith('ICE');
}

function versionForPlugin(plugin: FunctionPluginDefinition | undefined): number {
  if (!plugin) return BUILTIN_FUNCTION_VERSION;
  return PLUGIN_VERSIONS.get(plugin) ?? BUILTIN_FUNCTION_VERSION;
}

/**
 * Deterministic keyword fallback category for functions missing from the
 * curated FUNCTION_CATEGORIES table (should be rare — the drift test
 * requires curated coverage review for new functions).
 */
function keywordCategory(name: string): string {
  const n = name.toUpperCase();
  if (/^(SUM|AVERAGE|COUNT|MIN|MAX|PRODUCT|STDEV|VAR|MEDIAN|MODE|RANK|LARGE|SMALL|AGGREGATE|SUBTOTAL)/.test(n))
    return 'Math & Trig';
  if (/DIST$|^(NORM|BINOM|POISSON|CHISQ|CONFIDENCE|FORECAST|TREND|SLOPE|INTERCEPT|CORREL|COVAR|PEARSON|RSQ|KURT|SKEW|PROB|PERCENT|QUARTILE|AVEDEV|DEVSQ|GEOMEAN|HARMEAN|TRIMMEAN)/.test(n))
    return 'Statistical';
  if (/^(PMT|FV|PV|RATE|NPER|IRR|XIRR|NPV|XNPV|YIELD|PRICE|DURATION|ACCRINT|DISC|INTRATE|RECEIVED|COUP|TBILL|DOLLAR|EFFECT|NOMINAL|SLN|SYD|DB|DDB|VDB|CUMIPMT|CUMPRINC|IPMT|PPMT|MIRR|RRI|PDURATION|ISPMT)/.test(n))
    return 'Financial';
  if (/^(LEFT|RIGHT|MID|LEN|FIND|SEARCH|REPLACE|SUBSTITUTE|TEXT|VALUE|TRIM|CLEAN|UPPER|LOWER|PROPER|CONCAT|CHAR|CODE|DOLLAR|FIXED|EXACT|REPT|TEXTBEFORE|TEXTAFTER|TEXTSPLIT|REGEX)/.test(n))
    return 'Text';
  if (/^(DATE|TIME|YEAR|MONTH|DAY|HOUR|MINUTE|SECOND|WEEKDAY|WEEKNUM|EDATE|EOMONTH|DATEDIF|NOW|TODAY|NETWORKDAYS|WORKDAY|ISOWEEKNUM|YEARFRAC|DAYS|DAYS360|DATEVALUE|TIMEVALUE)/.test(n))
    return 'Date & Time';
  if (/^(VLOOKUP|HLOOKUP|XLOOKUP|LOOKUP|MATCH|INDEX|OFFSET|INDIRECT|ADDRESS|ROW|COLUMN|ROWS|COLUMNS|TRANSPOSE|CHOOSE|HYPERLINK|FORMULATEXT|GETPIVOTDATA|RTD|FILTERXML|WEBSERVICE|ENCODEURL)/.test(n))
    return 'Lookup & Reference';
  if (/^(AND|OR|NOT|XOR|IF|IFS|SWITCH|IFERROR|IFNA|TRUE|FALSE)/.test(n)) return 'Logical';
  if (/^(LET|LAMBDA|MAP|REDUCE|SCAN|BYROW|BYCOL|MAKEARRAY|ISOMITTED)/.test(n)) return 'Lambda';
  if (/^(SORT|SORTBY|UNIQUE|FILTER|SEQUENCE|RANDARRAY|XMATCH|DROP|TAKE|CHOOSEROWS|CHOOSECOLS|EXPAND|HSTACK|VSTACK|TOROW|TOCOL|WRAPROWS|WRAPCOLS)/.test(n))
    return 'Dynamic Arrays';
  if (/^(CONVERT|BIN2|DEC2|HEX2|OCT2|BIT|DELTA|GESTEP|ERF|BESSEL|COMPLEX|IM)/.test(n))
    return 'Engineering';
  if (/^CUBE/.test(n)) return 'Cube';
  if (/^D[A-Z]+$/.test(n) && /^(DAVERAGE|DCOUNT|DCOUNTA|DGET|DMAX|DMIN|DPRODUCT|DSTDEV|DSTDEVP|DSUM|DVAR|DVARP)$/.test(n))
    return 'Database';
  if (/^(INFO|CELL|IS|TYPE|N\(|T\(|ERROR\.TYPE|NA\(|SHEET|SHEETS|AREAS)/.test(n)) return 'Information';
  return 'Other';
}

/** Generic argument name derived from a HyperFormula argument type. */
function argNameFor(argumentType: unknown): string {
  switch (argumentType) {
    case FunctionArgumentType.NUMBER:
    case FunctionArgumentType.SCALAR:
      return 'number';
    case FunctionArgumentType.STRING:
      return 'text';
    case FunctionArgumentType.BOOLEAN:
      return 'logical';
    case FunctionArgumentType.RANGE:
      return 'range';
    default:
      return 'value';
  }
}

/**
 * Synthesize a signature hint from the plugin's actual parameter metadata
 * (used when no curated signature exists): 'NAME(value1, [value2], …)'.
 * Optional args are bracketed; repeatLastArgs appends ', …'.
 */
function synthesizeSignature(
  plugin: FunctionPluginDefinition | undefined,
  name: string,
): string {
  const impl = plugin?.implementedFunctions?.[name];
  const params: Array<{ argumentType?: unknown; optionalArg?: boolean }> = Array.isArray(impl?.parameters)
    ? impl.parameters
    : [];
  const parts = params.map((p, i) => {
    const label = `${argNameFor(p?.argumentType)}${i + 1}`;
    return p?.optionalArg ? `[${label}]` : label;
  });
  if ((impl as { repeatLastArgs?: number } | undefined)?.repeatLastArgs) parts.push('…');
  return `${name}(${parts.join(', ')})`;
}

// ---------------------------------------------------------------------------
// Curated metadata tables (generated into this file; see /tmp/gen-tables.mjs
// for the one-time migration source). The drift test fails if any key stops
// referring to an actually-registered function.
// ---------------------------------------------------------------------------

/**
 * Curated function metadata. The function SET is generated from the
 * actual HyperFormula plugin registrations (see getFunctionRegistry);
 * these tables only supply display metadata, and the drift test
 * (tests/function-registry.test.ts) fails if any key here stops
 * referring to a registered function.
 */

// Categories migrated verbatim from the pre-registry functionList.ts,
// plus curated categories for the functions that list was missing.
const FUNCTION_CATEGORIES: Record<string, string> = {
  'ABS': 'Math & Trig',
  'ACCRINT': 'Financial',
  'ACCRINTM': 'Financial',
  'ACOS': 'Other',
  'ACOSH': 'Other',
  'ACOT': 'Other',
  'ACOTH': 'Other',
  'ADDRESS': 'Other',
  'AGGREGATE': 'Statistical',
  'AMORDEGRC': 'Financial',
  'AMORLINC': 'Financial',
  'AND': 'Logical',
  'ARABIC': 'Engineering',
  'AREAS': 'Other',
  'ARRAYFORMULA': 'Other',
  'ARRAYTOTEXT': 'Text',
  'ARRAY_CONSTRAIN': 'Dynamic Arrays',
  'ASC': 'Text',
  'ASIN': 'Other',
  'ASINH': 'Other',
  'ATAN': 'Other',
  'ATAN2': 'Other',
  'ATANH': 'Other',
  'AVEDEV': 'Other',
  'AVERAGE': 'Statistical',
  'AVERAGEA': 'Statistical',
  'AVERAGEIF': 'Statistical',
  'AVERAGEIFS': 'Statistical',
  'BAHTTEXT': 'Other',
  'BASE': 'Engineering',
  'BESSELI': 'Engineering',
  'BESSELJ': 'Engineering',
  'BESSELK': 'Engineering',
  'BESSELY': 'Engineering',
  'BETA.DIST': 'Statistical',
  'BETA.INV': 'Statistical',
  'BETADIST': 'Statistical',
  'BETAINV': 'Statistical',
  'BIN2DEC': 'Engineering',
  'BIN2HEX': 'Engineering',
  'BIN2OCT': 'Engineering',
  'BINOM.DIST': 'Statistical',
  'BINOM.DIST.RANGE': 'Statistical',
  'BINOM.INV': 'Statistical',
  'BINOMDIST': 'Statistical',
  'BITAND': 'Engineering',
  'BITLSHIFT': 'Other',
  'BITOR': 'Engineering',
  'BITRSHIFT': 'Other',
  'BITXOR': 'Other',
  'BYCOL': 'Lambda',
  'BYROW': 'Lambda',
  'CALL': 'Other',
  'CEILING': 'Math & Trig',
  'CEILING.MATH': 'Math & Trig',
  'CEILING.PRECISE': 'Math & Trig',
  'CELL': 'Information',
  'CHAR': 'Text',
  'CHIDIST': 'Other',
  'CHIDISTRT': 'Other',
  'CHIINV': 'Other',
  'CHIINVRT': 'Other',
  'CHISQ.DIST': 'Statistical',
  'CHISQ.DIST.RT': 'Statistical',
  'CHISQ.INV': 'Statistical',
  'CHISQ.INV.RT': 'Statistical',
  'CHISQ.TEST': 'Statistical',
  'CHITEST': 'Other',
  'CHOOSE': 'Lookup & Reference',
  'CHOOSECOLS': 'Lookup & Reference',
  'CHOOSEROWS': 'Lookup & Reference',
  'CLEAN': 'Other',
  'CODE': 'Text',
  'COLUMN': 'Lookup & Reference',
  'COLUMNS': 'Lookup & Reference',
  'COMBIN': 'Math & Trig',
  'COMBINA': 'Math & Trig',
  'COMPLEX': 'Engineering',
  'CONCAT': 'Text',
  'CONCATENATE': 'Text',
  'CONFIDENCE': 'Statistical',
  'CONFIDENCE.NORM': 'Statistical',
  'CONFIDENCE.T': 'Statistical',
  'CONVERT': 'Engineering',
  'COPILOT': 'Other',
  'CORREL': 'Statistical',
  'COS': 'Math & Trig',
  'COSH': 'Math & Trig',
  'COT': 'Other',
  'COTH': 'Other',
  'COUNT': 'Statistical',
  'COUNTA': 'Statistical',
  'COUNTBLANK': 'Statistical',
  'COUNTIF': 'Statistical',
  'COUNTIFS': 'Statistical',
  'COUNTUNIQUE': 'Statistical',
  'COUPDAYBS': 'Financial',
  'COUPDAYS': 'Financial',
  'COUPDAYSNC': 'Financial',
  'COUPNCD': 'Financial',
  'COUPNUM': 'Financial',
  'COUPPCD': 'Financial',
  'COVAR': 'Other',
  'COVARIANCE.P': 'Other',
  'COVARIANCE.S': 'Other',
  'COVARIANCEP': 'Other',
  'COVARIANCES': 'Other',
  'CRITBINOM': 'Other',
  'CSC': 'Other',
  'CSCH': 'Other',
  'CUBEKPIMEMBER': 'Cube',
  'CUBEMEMBER': 'Cube',
  'CUBEMEMBERPROPERTY': 'Cube',
  'CUBERANKEDMEMBER': 'Cube',
  'CUBESET': 'Cube',
  'CUBESETCOUNT': 'Cube',
  'CUBEVALUE': 'Cube',
  'CUMIPMT': 'Other',
  'CUMPRINC': 'Other',
  'DATE': 'Date & Time',
  'DATEDIF': 'Date & Time',
  'DATEVALUE': 'Date & Time',
  'DAVERAGE': 'Database',
  'DAY': 'Date & Time',
  'DAYS': 'Date & Time',
  'DAYS360': 'Date & Time',
  'DB': 'Financial',
  'DBCS': 'Text',
  'DCOUNT': 'Database',
  'DCOUNTA': 'Database',
  'DDB': 'Financial',
  'DEC2BIN': 'Other',
  'DEC2HEX': 'Other',
  'DEC2OCT': 'Other',
  'DECIMAL': 'Engineering',
  'DEGREES': 'Other',
  'DELTA': 'Engineering',
  'DETECTLANGUAGE': 'Other',
  'DEVSQ': 'Other',
  'DGET': 'Database',
  'DISC': 'Financial',
  'DMAX': 'Database',
  'DMIN': 'Database',
  'DOLLAR': 'Text',
  'DOLLARDE': 'Text',
  'DOLLARFR': 'Text',
  'DPRODUCT': 'Database',
  'DROP': 'Dynamic Arrays',
  'DSTDEV': 'Database',
  'DSTDEVP': 'Database',
  'DSUM': 'Database',
  'DURATION': 'Financial',
  'DVAR': 'Database',
  'DVARP': 'Database',
  'ECMA.CEILING': 'Math & Trig',
  'EDATE': 'Date & Time',
  'EFFECT': 'Other',
  'ENCODEURL': 'Other',
  'EOMONTH': 'Date & Time',
  'ERF': 'Engineering',
  'ERF.PRECISE': 'Statistical',
  'ERFC': 'Engineering',
  'ERFC.PRECISE': 'Statistical',
  'ERROR.TYPE': 'Information',
  'EUROCONVERT': 'Financial',
  'EVEN': 'Other',
  'EXACT': 'Text',
  'EXP': 'Math & Trig',
  'EXPAND': 'Math & Trig',
  'EXPON.DIST': 'Math & Trig',
  'EXPONDIST': 'Math & Trig',
  'F.DIST': 'Statistical',
  'F.DIST.RT': 'Statistical',
  'F.INV': 'Other',
  'F.INV.RT': 'Other',
  'F.TEST': 'Other',
  'FACT': 'Math & Trig',
  'FACTDOUBLE': 'Math & Trig',
  'FALSE': 'Other',
  'FDIST': 'Other',
  'FDISTRT': 'Other',
  'FIELDVALUE': 'Lookup & Reference',
  'FILTER': 'Dynamic Arrays',
  'FILTERXML': 'Other',
  'FIND': 'Text',
  'FINV': 'Other',
  'FINVRT': 'Other',
  'FISHER': 'Other',
  'FISHERINV': 'Other',
  'FIXED': 'Text',
  'FLOOR': 'Math & Trig',
  'FLOOR.MATH': 'Math & Trig',
  'FLOOR.PRECISE': 'Math & Trig',
  'FORECAST': 'Statistical',
  'FORECAST.ETS': 'Statistical',
  'FORECAST.ETS.CONFINT': 'Statistical',
  'FORECAST.ETS.SEASONALITY': 'Statistical',
  'FORECAST.ETS.STAT': 'Statistical',
  'FORECAST.LINEAR': 'Statistical',
  'FORMULATEXT': 'Other',
  'FREQUENCY': 'Statistical',
  'FTEST': 'Other',
  'FV': 'Financial',
  'FVSCHEDULE': 'Financial',
  'GAMMA': 'Statistical',
  'GAMMA.DIST': 'Statistical',
  'GAMMA.INV': 'Statistical',
  'GAMMADIST': 'Statistical',
  'GAMMAINV': 'Statistical',
  'GAMMALN': 'Statistical',
  'GAMMALN.PRECISE': 'Statistical',
  'GAUSS': 'Other',
  'GCD': 'Math & Trig',
  'GEOMEAN': 'Other',
  'GESTEP': 'Engineering',
  'GETPIVOTDATA': 'Lookup & Reference',
  'GOOGLEFINANCE': 'Financial',
  'GROUPBY': 'Lookup & Reference',
  'GROWTH': 'Statistical',
  'HARMEAN': 'Other',
  'HEX2BIN': 'Engineering',
  'HEX2DEC': 'Engineering',
  'HEX2OCT': 'Engineering',
  'HF.ADD': 'Other',
  'HF.CONCAT': 'Other',
  'HF.DIVIDE': 'Other',
  'HF.EQ': 'Other',
  'HF.GT': 'Other',
  'HF.GTE': 'Other',
  'HF.LT': 'Other',
  'HF.LTE': 'Other',
  'HF.MINUS': 'Other',
  'HF.MULTIPLY': 'Other',
  'HF.NE': 'Other',
  'HF.POW': 'Other',
  'HF.UMINUS': 'Other',
  'HF.UNARY_PERCENT': 'Other',
  'HF.UPLUS': 'Other',
  'HLOOKUP': 'Lookup & Reference',
  'HOUR': 'Date & Time',
  'HSTACK': 'Dynamic Arrays',
  'HYPERLINK': 'Other',
  'HYPGEOM.DIST': 'Statistical',
  'HYPGEOMDIST': 'Statistical',
  'IF': 'Logical',
  'IFERROR': 'Logical',
  'IFNA': 'Logical',
  'IFS': 'Logical',
  'IMABS': 'Engineering',
  'IMAGE': 'Other',
  'IMAGINARY': 'Other',
  'IMARGUMENT': 'Other',
  'IMCONJUGATE': 'Other',
  'IMCOS': 'Other',
  'IMCOSH': 'Other',
  'IMCOT': 'Other',
  'IMCSC': 'Other',
  'IMCSCH': 'Other',
  'IMDIV': 'Other',
  'IMEXP': 'Other',
  'IMLN': 'Other',
  'IMLOG10': 'Other',
  'IMLOG2': 'Other',
  'IMPORTDATA': 'Other',
  'IMPORTFEED': 'Other',
  'IMPORTHTML': 'Other',
  'IMPORTRANGE': 'Other',
  'IMPORTXML': 'Other',
  'IMPOWER': 'Other',
  'IMPRODUCT': 'Other',
  'IMREAL': 'Other',
  'IMSEC': 'Other',
  'IMSECH': 'Other',
  'IMSIN': 'Other',
  'IMSINH': 'Other',
  'IMSQRT': 'Other',
  'IMSUB': 'Other',
  'IMSUM': 'Other',
  'IMTAN': 'Other',
  'INDEX': 'Lookup & Reference',
  'INDIRECT': 'Lookup & Reference',
  'INFO': 'Information',
  'INT': 'Math & Trig',
  'INTERCEPT': 'Statistical',
  'INTERVAL': 'Math & Trig',
  'INTRATE': 'Financial',
  'IPMT': 'Financial',
  'IRR': 'Financial',
  'ISBINARY': 'Other',
  'ISBLANK': 'Information',
  'ISERR': 'Other',
  'ISERROR': 'Information',
  'ISEVEN': 'Information',
  'ISFORMULA': 'Other',
  'ISLOGICAL': 'Other',
  'ISNA': 'Information',
  'ISNONTEXT': 'Other',
  'ISNUMBER': 'Information',
  'ISO.CEILING': 'Other',
  'ISODD': 'Information',
  'ISOMITTED': 'Other',
  'ISOWEEKNUM': 'Other',
  'ISPMT': 'Other',
  'ISREF': 'Other',
  'ISTEXT': 'Information',
  'JIS': 'Text',
  'KURT': 'Statistical',
  'LAMBDA': 'Lambda',
  'LARGE': 'Statistical',
  'LCM': 'Math & Trig',
  'LEFT': 'Text',
  'LEN': 'Text',
  'LENB': 'Text',
  'LET': 'Lambda',
  'LINEST': 'Statistical',
  'LN': 'Math & Trig',
  'LOG': 'Math & Trig',
  'LOG10': 'Math & Trig',
  'LOGEST': 'Statistical',
  'LOGINV': 'Math & Trig',
  'LOGNORM.DIST': 'Math & Trig',
  'LOGNORM.INV': 'Math & Trig',
  'LOGNORMDIST': 'Math & Trig',
  'LOGNORMINV': 'Math & Trig',
  'LOOKUP': 'Lookup & Reference',
  'LOWER': 'Text',
  'MAKEARRAY': 'Lambda',
  'MAP': 'Lambda',
  'MATCH': 'Lookup & Reference',
  'MAX': 'Statistical',
  'MAXA': 'Statistical',
  'MAXIFS': 'Statistical',
  'MAXPOOL': 'Statistical',
  'MDETERM': 'Math & Trig',
  'MDURATION': 'Financial',
  'MEDIAN': 'Statistical',
  'MEDIANPOOL': 'Statistical',
  'MID': 'Text',
  'MIN': 'Statistical',
  'MINA': 'Statistical',
  'MINIFS': 'Statistical',
  'MINUTE': 'Statistical',
  'MINVERSE': 'Math & Trig',
  'MIRR': 'Other',
  'MMULT': 'Other',
  'MOD': 'Math & Trig',
  'MODE': 'Statistical',
  'MODE.MULT': 'Statistical',
  'MODE.SNGL': 'Statistical',
  'MONTH': 'Date & Time',
  'MROUND': 'Other',
  'MULTINOMIAL': 'Other',
  'MUNIT': 'Math & Trig',
  'N': 'Information',
  'NA': 'Information',
  'NEGBINOM.DIST': 'Other',
  'NEGBINOMDIST': 'Other',
  'NETWORKDAYS': 'Date & Time',
  'NETWORKDAYS.INTL': 'Date & Time',
  'NOMINAL': 'Other',
  'NORM.DIST': 'Statistical',
  'NORM.INV': 'Statistical',
  'NORM.S.DIST': 'Statistical',
  'NORM.S.INV': 'Statistical',
  'NORMDIST': 'Statistical',
  'NORMINV': 'Statistical',
  'NORMSDIST': 'Statistical',
  'NORMSINV': 'Statistical',
  'NOT': 'Logical',
  'NOW': 'Date & Time',
  'NPER': 'Financial',
  'NPV': 'Financial',
  'NUMBERSTRING': 'Text',
  'NUMBERVALUE': 'Other',
  'OCT2BIN': 'Engineering',
  'OCT2DEC': 'Engineering',
  'OCT2HEX': 'Engineering',
  'ODD': 'Other',
  'ODDFPRICE': 'Financial',
  'ODDFYIELD': 'Financial',
  'ODDLPRICE': 'Financial',
  'ODDLYIELD': 'Financial',
  'OFFSET': 'Lookup & Reference',
  'OR': 'Logical',
  'PDURATION': 'Other',
  'PEARSON': 'Other',
  'PERCENTILE': 'Statistical',
  'PERCENTILE.EXC': 'Statistical',
  'PERCENTILE.INC': 'Statistical',
  'PERCENTOF': 'Other',
  'PERCENTRANK': 'Statistical',
  'PERCENTRANK.EXC': 'Statistical',
  'PERCENTRANK.INC': 'Statistical',
  'PERMUT': 'Math & Trig',
  'PERMUTATIONA': 'Statistical',
  'PHI': 'Other',
  'PHONETIC': 'Text',
  'PI': 'Math & Trig',
  'PIVOTBY': 'Lookup & Reference',
  'PMT': 'Financial',
  'POISSON': 'Statistical',
  'POISSON.DIST': 'Statistical',
  'POISSONDIST': 'Statistical',
  'POWER': 'Math & Trig',
  'PPMT': 'Financial',
  'PRICE': 'Financial',
  'PRICEDISC': 'Financial',
  'PRICEMAT': 'Financial',
  'PROB': 'Statistical',
  'PRODUCT': 'Statistical',
  'PROPER': 'Text',
  'PV': 'Financial',
  'PY': 'Other',
  'QUARTILE': 'Statistical',
  'QUARTILE.EXC': 'Statistical',
  'QUARTILE.INC': 'Statistical',
  'QUOTIENT': 'Other',
  'RADIANS': 'Other',
  'RAND': 'Math & Trig',
  'RANDARRAY': 'Math & Trig',
  'RANDBETWEEN': 'Math & Trig',
  'RANK': 'Statistical',
  'RANK.AVG': 'Statistical',
  'RANK.EQ': 'Statistical',
  'RATE': 'Financial',
  'RECEIVED': 'Financial',
  'REDUCE': 'Lambda',
  'REGEXEXTRACT': 'Text',
  'REGEXREPLACE': 'Text',
  'REGEXTEST': 'Engineering',
  'REGISTER.ID': 'Other',
  'REPLACE': 'Text',
  'REPT': 'Text',
  'RIGHT': 'Text',
  'ROMAN': 'Engineering',
  'ROUND': 'Math & Trig',
  'ROUNDDOWN': 'Math & Trig',
  'ROUNDUP': 'Math & Trig',
  'ROW': 'Lookup & Reference',
  'ROWS': 'Lookup & Reference',
  'RRI': 'Other',
  'RSQ': 'Statistical',
  'RTD': 'Lookup & Reference',
  'SCAN': 'Lambda',
  'SEARCH': 'Text',
  'SEC': 'Other',
  'SECH': 'Other',
  'SECOND': 'Date & Time',
  'SEQUENCE': 'Math & Trig',
  'SERIESSUM': 'Other',
  'SHEET': 'Other',
  'SHEETS': 'Other',
  'SIGN': 'Other',
  'SIN': 'Math & Trig',
  'SINGLE': 'Math & Trig',
  'SINH': 'Math & Trig',
  'SKEW': 'Statistical',
  'SKEW.P': 'Statistical',
  'SKEWP': 'Statistical',
  'SLN': 'Financial',
  'SLOPE': 'Statistical',
  'SMALL': 'Statistical',
  'SORT': 'Dynamic Arrays',
  'SORTBY': 'Dynamic Arrays',
  'SPLIT': 'Other',
  'SQRT': 'Math & Trig',
  'SQRTPI': 'Math & Trig',
  'STANDARDIZE': 'Other',
  'STDEV': 'Statistical',
  'STDEV.P': 'Statistical',
  'STDEV.S': 'Statistical',
  'STDEVA': 'Statistical',
  'STDEVP': 'Statistical',
  'STDEVPA': 'Statistical',
  'STDEVS': 'Statistical',
  'STEYX': 'Other',
  'STOCKHISTORY': 'Financial',
  'SUBSTITUTE': 'Text',
  'SUBTOTAL': 'Other',
  'SUM': 'Statistical',
  'SUMIF': 'Statistical',
  'SUMIFS': 'Statistical',
  'SUMPRODUCT': 'Statistical',
  'SUMSQ': 'Statistical',
  'SUMX2MY2': 'Statistical',
  'SUMX2PY2': 'Statistical',
  'SUMXMY2': 'Statistical',
  'SWITCH': 'Logical',
  'SYD': 'Financial',
  'T': 'Text',
  'T.DIST': 'Statistical',
  'T.DIST.2T': 'Statistical',
  'T.DIST.RT': 'Statistical',
  'T.INV': 'Other',
  'T.INV.2T': 'Other',
  'T.TEST': 'Other',
  'TAKE': 'Dynamic Arrays',
  'TAN': 'Math & Trig',
  'TANH': 'Math & Trig',
  'TBILLEQ': 'Other',
  'TBILLPRICE': 'Other',
  'TBILLYIELD': 'Other',
  'TDIST': 'Other',
  'TDIST2T': 'Other',
  'TDISTRT': 'Other',
  'TEXT': 'Text',
  'TEXTAFTER': 'Text',
  'TEXTBEFORE': 'Text',
  'TEXTJOIN': 'Text',
  'TEXTSPLIT': 'Text',
  'THAIDAYOFWEEK': 'Text',
  'THAIDIGIT': 'Text',
  'THAIMONTHOFYEAR': 'Text',
  'THAINUMSOUND': 'Text',
  'THAINUMSTRING': 'Text',
  'THAISTRINGLENGTH': 'Text',
  'THAIYEAR': 'Text',
  'TIME': 'Date & Time',
  'TIMEVALUE': 'Date & Time',
  'TINV': 'Other',
  'TINV2T': 'Other',
  'TOCOL': 'Dynamic Arrays',
  'TODAY': 'Date & Time',
  'TOROW': 'Dynamic Arrays',
  'TRANSLATE': 'Other',
  'TRANSPOSE': 'Lookup & Reference',
  'TREND': 'Statistical',
  'TRIM': 'Text',
  'TRIMMEAN': 'Text',
  'TRIMRANGE': 'Text',
  'TRUE': 'Other',
  'TRUNC': 'Math & Trig',
  'TTEST': 'Other',
  'TYPE': 'Information',
  'UNICHAR': 'Other',
  'UNICODE': 'Other',
  'UNIQUE': 'Dynamic Arrays',
  'UPPER': 'Text',
  'VALUE': 'Text',
  'VALUETOTEXT': 'Text',
  'VAR': 'Statistical',
  'VAR.P': 'Statistical',
  'VAR.S': 'Statistical',
  'VARA': 'Statistical',
  'VARP': 'Statistical',
  'VARPA': 'Statistical',
  'VARS': 'Statistical',
  'VDB': 'Financial',
  'VLOOKUP': 'Lookup & Reference',
  'VSTACK': 'Dynamic Arrays',
  'WEBSERVICE': 'Other',
  'WEEKDAY': 'Date & Time',
  'WEEKNUM': 'Date & Time',
  'WEIBULL': 'Other',
  'WEIBULL.DIST': 'Other',
  'WEIBULLDIST': 'Other',
  'WORKDAY': 'Date & Time',
  'WORKDAY.INTL': 'Date & Time',
  'WRAPCOLS': 'Dynamic Arrays',
  'WRAPROWS': 'Dynamic Arrays',
  'XIRR': 'Financial',
  'XLOOKUP': 'Lookup & Reference',
  'XMATCH': 'Lookup & Reference',
  'XNPV': 'Other',
  'XOR': 'Logical',
  'YEAR': 'Date & Time',
  'YEARFRAC': 'Date & Time',
  'YIELD': 'Financial',
  'YIELDDISC': 'Financial',
  'YIELDMAT': 'Financial',
  'Z.TEST': 'Other',
  'ZTEST': 'Other',
};

// Signature hints migrated from the deterministic-inference catalog generator.
const FUNCTION_SIGNATURES: Record<string, string> = {
  'ABS': 'ABS(number)',
  'ADDRESS': 'ADDRESS(row_num, column_num, [abs_num], …)',
  'AND': 'AND(logical1, [logical2], …)',
  'AVERAGE': 'AVERAGE(number1, [number2], …)',
  'AVERAGEIF': 'AVERAGEIF(range, criteria, [average_range])',
  'AVERAGEIFS': 'AVERAGEIFS(average_range, criteria_range1, criteria1, …)',
  'CEILING': 'CEILING(number, significance)',
  'CHAR': 'CHAR(number)',
  'CHOOSE': 'CHOOSE(index_num, value1, …)',
  'CODE': 'CODE(text)',
  'COLUMN': 'COLUMN([reference])',
  'COLUMNS': 'COLUMNS(array)',
  'COMBIN': 'COMBIN(number, number_chosen)',
  'CONCAT': 'CONCAT(text1, [text2], …)',
  'CONCATENATE': 'CONCATENATE(text1, [text2], …)',
  'CORREL': 'CORREL(array1, array2)',
  'COS': 'COS(number)',
  'COUNT': 'COUNT(value1, [value2], …)',
  'COUNTA': 'COUNTA(value1, [value2], …)',
  'COUNTIF': 'COUNTIF(range, criteria)',
  'COUNTIFS': 'COUNTIFS(criteria_range1, criteria1, …)',
  'DATE': 'DATE(year, month, day)',
  'DATEDIF': 'DATEDIF(start_date, end_date, unit)',
  'DATEVALUE': 'DATEVALUE(date_text)',
  'DAY': 'DAY(serial_number)',
  'DAYS': 'DAYS(end_date, start_date)',
  'DAYS360': 'DAYS360(start_date, end_date, [method])',
  'DEGREES': 'DEGREES(angle)',
  'DOLLAR': 'DOLLAR(number, [decimals])',
  'EDATE': 'EDATE(start_date, months)',
  'EOMONTH': 'EOMONTH(start_date, months)',
  'EXACT': 'EXACT(text1, text2)',
  'EXP': 'EXP(number)',
  'FACT': 'FACT(number)',
  'FILTER': 'FILTER(array, include, [if_empty])',
  'FIND': 'FIND(find_text, within_text, [start_num])',
  'FIXED': 'FIXED(number, [decimals], [no_commas])',
  'FLOOR': 'FLOOR(number, significance)',
  'FORECAST': 'FORECAST(x, known_ys, known_xs)',
  'FORMULATEXT': 'FORMULATEXT(reference)',
  'FV': 'FV(rate, nper, pmt, [pv], [type])',
  'GCD': 'GCD(number1, [number2], …)',
  'GROUPBY': 'GROUPBY(row_fields, values, function, [field_headers], [total_depth], [sort_order], [filter_array], [field_relationship])',
  'HLOOKUP': 'HLOOKUP(lookup_value, table_array, row_index_num, [range_lookup])',
  'HOUR': 'HOUR(serial_number)',
  'HYPERLINK': 'HYPERLINK(link_location, [friendly_name])',
  'IF': 'IF(logical_test, value_if_true, [value_if_false])',
  'IFERROR': 'IFERROR(value, value_if_error)',
  'IFNA': 'IFNA(value, value_if_na)',
  'IFS': 'IFS(logical_test1, value1, …)',
  'INDEX': 'INDEX(array, row_num, [column_num])',
  'INDIRECT': 'INDIRECT(ref_text, [a1])',
  'INT': 'INT(number)',
  'INTERCEPT': 'INTERCEPT(known_ys, known_xs)',
  'IRR': 'IRR(values, [guess])',
  'ISBLANK': 'ISBLANK(value)',
  'ISERROR': 'ISERROR(value)',
  'ISNA': 'ISNA(value)',
  'ISNUMBER': 'ISNUMBER(value)',
  'ISTEXT': 'ISTEXT(value)',
  'LAMBDA': 'LAMBDA([parameter, …], calculation)',
  'LARGE': 'LARGE(array, k)',
  'LCM': 'LCM(number1, [number2], …)',
  'LEFT': 'LEFT(text, [num_chars])',
  'LEN': 'LEN(text)',
  'LET': 'LET(name1, name_value1, …, calculation)',
  'LN': 'LN(number)',
  'LOG': 'LOG(number, [base])',
  'LOG10': 'LOG10(number)',
  'LOWER': 'LOWER(text)',
  'MAP': 'MAP(array1, …, lambda)',
  'MATCH': 'MATCH(lookup_value, lookup_array, [match_type])',
  'MAX': 'MAX(number1, [number2], …)',
  'MAXIFS': 'MAXIFS(max_range, criteria_range1, criteria1, …)',
  'MEDIAN': 'MEDIAN(number1, [number2], …)',
  'MID': 'MID(text, start_num, num_chars)',
  'MIN': 'MIN(number1, [number2], …)',
  'MINIFS': 'MINIFS(min_range, criteria_range1, criteria1, …)',
  'MINUTE': 'MINUTE(serial_number)',
  'MOD': 'MOD(number, divisor)',
  'MONTH': 'MONTH(serial_number)',
  'MROUND': 'MROUND(number, multiple)',
  'N': 'N(value)',
  'NA': 'NA()',
  'NETWORKDAYS': 'NETWORKDAYS(start_date, end_date, [holidays])',
  'NOT': 'NOT(logical)',
  'NOW': 'NOW()',
  'NPER': 'NPER(rate, pmt, pv, [fv], [type])',
  'NPV': 'NPV(rate, value1, [value2], …)',
  'ODDFPRICE': 'ODDFPRICE(settlement, maturity, issue, first_coupon, rate, yld, redemption, frequency, [basis])',
  'ODDFYIELD': 'ODDFYIELD(settlement, maturity, issue, first_coupon, rate, pr, redemption, frequency, [basis])',
  'ODDLPRICE': 'ODDLPRICE(settlement, maturity, last_interest, rate, yld, redemption, frequency, [basis])',
  'ODDLYIELD': 'ODDLYIELD(settlement, maturity, last_interest, rate, pr, redemption, frequency, [basis])',
  'OFFSET': 'OFFSET(reference, rows, cols, [height], [width])',
  'OR': 'OR(logical1, [logical2], …)',
  'PERCENTILE': 'PERCENTILE(array, k)',
  'PERMUT': 'PERMUT(number, number_chosen)',
  'PI': 'PI()',
  'PIVOTBY': 'PIVOTBY(row_fields, col_fields, values, function, [field_headers], [row_total_depth], [row_sort_order], [col_total_depth], [col_sort_order], [filter_array], [relative_to])',
  'PMT': 'PMT(rate, nper, pv, [fv], [type])',
  'POWER': 'POWER(number, power)',
  'PRODUCT': 'PRODUCT(number1, [number2], …)',
  'PROPER': 'PROPER(text)',
  'PV': 'PV(rate, nper, pmt, [fv], [type])',
  'QUOTIENT': 'QUOTIENT(numerator, denominator)',
  'RADIANS': 'RADIANS(angle)',
  'RAND': 'RAND()',
  'RANDARRAY': 'RANDARRAY([rows], [columns], [min], [max], [whole_number])',
  'RANDBETWEEN': 'RANDBETWEEN(bottom, top)',
  'RANK': 'RANK(number, ref, [order])',
  'RATE': 'RATE(nper, pmt, pv, [fv], [type], [guess])',
  'REPLACE': 'REPLACE(old_text, start_num, num_chars, new_text)',
  'REPT': 'REPT(text, number_times)',
  'RIGHT': 'RIGHT(text, [num_chars])',
  'ROUND': 'ROUND(number, num_digits)',
  'ROUNDDOWN': 'ROUNDDOWN(number, num_digits)',
  'ROUNDUP': 'ROUNDUP(number, num_digits)',
  'ROW': 'ROW([reference])',
  'ROWS': 'ROWS(array)',
  'SEARCH': 'SEARCH(find_text, within_text, [start_num])',
  'SECOND': 'SECOND(serial_number)',
  'SEQUENCE': 'SEQUENCE(rows, [columns], [start], [step])',
  'SIN': 'SIN(number)',
  'SLOPE': 'SLOPE(known_ys, known_xs)',
  'SMALL': 'SMALL(array, k)',
  'SORT': 'SORT(array, [sort_index], [sort_order], …)',
  'SQRT': 'SQRT(number)',
  'STDEV': 'STDEV(number1, [number2], …)',
  'SUBSTITUTE': 'SUBSTITUTE(text, old_text, new_text, [instance_num])',
  'SUM': 'SUM(number1, [number2], …)',
  'SUMIF': 'SUMIF(range, criteria, [sum_range])',
  'SUMIFS': 'SUMIFS(sum_range, criteria_range1, criteria1, …)',
  'SUMPRODUCT': 'SUMPRODUCT(array1, [array2], …)',
  'SWITCH': 'SWITCH(expression, value1, result1, …, [default])',
  'T': 'T(value)',
  'TAN': 'TAN(number)',
  'TEXT': 'TEXT(value, format_text)',
  'TEXTAFTER': 'TEXTAFTER(text, delimiter, …)',
  'TEXTBEFORE': 'TEXTBEFORE(text, delimiter, …)',
  'TEXTJOIN': 'TEXTJOIN(delimiter, ignore_empty, text1, …)',
  'TEXTSPLIT': 'TEXTSPLIT(text, col_delimiter, …)',
  'TIME': 'TIME(hour, minute, second)',
  'TIMEVALUE': 'TIMEVALUE(time_text)',
  'TODAY': 'TODAY()',
  'TRANSPOSE': 'TRANSPOSE(array)',
  'TREND': 'TREND(known_ys, [known_xs], [new_xs], [const])',
  'TRIM': 'TRIM(text)',
  'TYPE': 'TYPE(value)',
  'UNIQUE': 'UNIQUE(array, [by_col], [exactly_once])',
  'UPPER': 'UPPER(text)',
  'VALUE': 'VALUE(text)',
  'VAR': 'VAR(number1, [number2], …)',
  'VLOOKUP': 'VLOOKUP(lookup_value, table_array, col_index_num, [range_lookup])',
  'WEEKDAY': 'WEEKDAY(serial_number, [return_type])',
  'WEEKNUM': 'WEEKNUM(serial_number, [return_type])',
  'WORKDAY': 'WORKDAY(start_date, days, [holidays])',
  'XIRR': 'XIRR(values, dates, [guess])',
  'XLOOKUP': 'XLOOKUP(lookup_value, lookup_array, return_array, [if_not_found], …)',
  'XMATCH': 'XMATCH(lookup_value, lookup_array, [match_mode], …)',
  'YEAR': 'YEAR(serial_number)',
  'YEARFRAC': 'YEARFRAC(start_date, end_date, [basis])',
};

/** Curated one-line descriptions for the most-used functions. */
const FUNCTION_DESCRIPTIONS: Record<string, string> = {
  SUM: 'Adds all the numbers in a range of cells.',
  AVERAGE: 'Returns the average of its arguments.',
  COUNT: 'Counts the cells that contain numbers.',
  COUNTA: 'Counts the non-empty cells in a range.',
  COUNTBLANK: 'Counts the empty cells in a range.',
  COUNTIF: 'Counts the cells in a range that meet a criterion.',
  COUNTIFS: 'Counts the cells that meet multiple criteria.',
  SUMIF: 'Adds the cells specified by a criterion.',
  SUMIFS: 'Adds the cells that meet multiple criteria.',
  AVERAGEIF: 'Averages the cells that meet a criterion.',
  AVERAGEIFS: 'Averages the cells that meet multiple criteria.',
  MIN: 'Returns the smallest number in a set.',
  MAX: 'Returns the largest number in a set.',
  MINIFS: 'Returns the minimum among cells that meet multiple criteria.',
  MAXIFS: 'Returns the maximum among cells that meet multiple criteria.',
  PRODUCT: 'Multiplies all its arguments.',
  SUMPRODUCT: 'Multiplies corresponding array entries and sums the products.',
  IF: 'Returns one value if a condition is true and another if false.',
  IFS: 'Checks multiple conditions and returns the value for the first true one.',
  AND: 'Returns TRUE if all arguments are true.',
  OR: 'Returns TRUE if any argument is true.',
  NOT: 'Reverses the logical value of its argument.',
  XOR: 'Returns TRUE when an odd number of arguments are true.',
  IFERROR: 'Returns a fallback value if an expression evaluates to an error.',
  IFNA: 'Returns a fallback value if an expression evaluates to #N/A.',
  SWITCH: 'Evaluates an expression against a list of values and returns the first match.',
  VLOOKUP: 'Looks up a value in the first column of a table and returns a value in the same row.',
  HLOOKUP: 'Looks up a value in the top row of a table and returns a value in the same column.',
  XLOOKUP: 'Searches a range for a match and returns the corresponding item.',
  XMATCH: 'Returns the relative position of a match in a range.',
  INDEX: 'Returns the value at a given position in a range.',
  GROUPBY: 'Groups data by row fields and aggregates the values for each group.',
  PIVOTBY: 'Groups data by row and column fields and aggregates values into a pivot-style grid.',
  OFFSET: 'Returns a reference to a range that is offset from a starting reference.',
  MATCH: 'Returns the relative position of an item in a range.',
  LOOKUP: 'Looks up a value in a range and returns a corresponding value.',
  INDIRECT: 'Returns the reference specified by a text string.',
  ADDRESS: 'Returns a cell reference as text.',
  ROW: 'Returns the row number of a reference.',
  COLUMN: 'Returns the column number of a reference.',
  ROWS: 'Returns the number of rows in a range.',
  COLUMNS: 'Returns the number of columns in a range.',
  CHOOSE: 'Picks a value from a list by index number.',
  HYPERLINK: 'Creates a clickable link to a location.',
  FORMULATEXT: 'Returns the formula in a cell as text.',
  GETPIVOTDATA: 'Returns data stored in a PivotTable.',
  RTD: 'Retrieves real-time data from a registered RTD topic.',
  CONCAT: 'Joins text strings into one string.',
  CONCATENATE: 'Joins text strings into one string.',
  TEXTJOIN: 'Joins text with a delimiter, optionally ignoring empty cells.',
  LEFT: 'Returns the first characters of a text string.',
  RIGHT: 'Returns the last characters of a text string.',
  MID: 'Returns characters from the middle of a text string.',
  LEN: 'Returns the number of characters in a text string.',
  TRIM: 'Removes extra spaces from text.',
  CLEAN: 'Removes non-printable characters from text.',
  UPPER: 'Converts text to uppercase.',
  LOWER: 'Converts text to lowercase.',
  PROPER: 'Capitalizes the first letter of each word.',
  SUBSTITUTE: 'Replaces text within a string.',
  REPLACE: 'Replaces characters within a text string by position.',
  TEXT: 'Formats a number as text using a format code.',
  VALUE: 'Converts a text string that represents a number to a number.',
  TEXTBEFORE: 'Returns the text before a delimiter.',
  TEXTAFTER: 'Returns the text after a delimiter.',
  TEXTSPLIT: 'Splits text into rows or columns by delimiters.',
  EXACT: 'Compares two text strings for exact equality.',
  FIND: 'Finds a substring, case-sensitive.',
  SEARCH: 'Finds a substring, case-insensitive.',
  REPT: 'Repeats text a given number of times.',
  CHAR: 'Returns the character for a code number.',
  CODE: 'Returns the code number of the first character.',
  DOLLAR: 'Converts a number to text in currency format.',
  FIXED: 'Formats a number as text with fixed decimals.',
  ROUND: 'Rounds a number to a specified number of digits.',
  ROUNDUP: 'Rounds a number away from zero.',
  ROUNDDOWN: 'Rounds a number toward zero.',
  ABS: 'Returns the absolute value of a number.',
  INT: 'Rounds a number down to the nearest integer.',
  TRUNC: 'Truncates a number to an integer.',
  MOD: 'Returns the remainder of a division.',
  QUOTIENT: 'Returns the integer portion of a division.',
  POWER: 'Raises a number to a power.',
  SQRT: 'Returns the square root of a number.',
  EXP: 'Returns e raised to a power.',
  LN: 'Returns the natural logarithm of a number.',
  LOG: 'Returns the logarithm of a number to a base.',
  LOG10: 'Returns the base-10 logarithm of a number.',
  SIN: 'Returns the sine of an angle.',
  COS: 'Returns the cosine of an angle.',
  TAN: 'Returns the tangent of an angle.',
  DEGREES: 'Converts radians to degrees.',
  RADIANS: 'Converts degrees to radians.',
  PI: 'Returns the value of pi.',
  RAND: 'Returns a random number between 0 and 1.',
  RANDBETWEEN: 'Returns a random integer between two bounds.',
  FACT: 'Returns the factorial of a number.',
  GCD: 'Returns the greatest common divisor.',
  LCM: 'Returns the least common multiple.',
  CEILING: 'Rounds a number up to the nearest multiple.',
  FLOOR: 'Rounds a number down to the nearest multiple.',
  MROUND: 'Rounds a number to the nearest multiple.',
  SIGN: 'Returns the sign of a number.',
  EVEN: 'Rounds a number up to the nearest even integer.',
  ODD: 'Rounds a number up to the nearest odd integer.',
  TODAY: "Returns today's date.",
  NOW: 'Returns the current date and time.',
  DATE: 'Returns the serial number of a date.',
  YEAR: 'Returns the year of a date.',
  MONTH: 'Returns the month of a date.',
  DAY: 'Returns the day of a date.',
  HOUR: 'Returns the hour of a time.',
  MINUTE: 'Returns the minute of a time.',
  SECOND: 'Returns the second of a time.',
  TIME: 'Returns the serial number of a time.',
  DATEDIF: 'Calculates the difference between two dates in a unit.',
  DAYS: 'Returns the number of days between two dates.',
  DAYS360: 'Returns the days between dates on a 360-day year.',
  EDATE: 'Returns the date months before or after a start date.',
  EOMONTH: 'Returns the last day of the month offset from a date.',
  NETWORKDAYS: 'Returns the working days between two dates.',
  WORKDAY: 'Returns the date offset by working days.',
  WEEKDAY: 'Returns the day of the week of a date.',
  WEEKNUM: 'Returns the week number of a date.',
  YEARFRAC: 'Returns the fraction of the year between two dates.',
  DATEVALUE: 'Converts a date in text form to a serial number.',
  TIMEVALUE: 'Converts a time in text form to a serial number.',
  PMT: 'Calculates the periodic payment for a loan.',
  ODDFPRICE: 'Returns the price of a security with an odd (short or long) first period.',
  ODDFYIELD: 'Returns the yield of a security with an odd (short or long) first period.',
  ODDLPRICE: 'Returns the price of a security with an odd (short or long) last period.',
  ODDLYIELD: 'Returns the yield of a security with an odd (short or long) last period.',
  FV: 'Returns the future value of an investment.',
  PV: 'Returns the present value of an investment.',
  RATE: 'Returns the interest rate per period.',
  NPER: 'Returns the number of periods for an investment.',
  NPV: 'Returns the net present value of an investment.',
  IRR: 'Returns the internal rate of return for cash flows.',
  XIRR: 'Returns the internal rate of return for dated cash flows.',
  SORT: 'Sorts the contents of a range or array.',
  SORTBY: 'Sorts a range based on the values in other ranges.',
  UNIQUE: 'Returns the unique values in a range.',
  FILTER: 'Filters a range based on criteria.',
  SEQUENCE: 'Generates a sequence of numbers spilling into cells.',
  RANDARRAY: 'Returns an array of random numbers.',
  LET: 'Assigns names to calculation results for reuse in a formula.',
  LAMBDA: 'Creates a reusable custom function.',
  MAP: 'Applies a LAMBDA to each value and returns the results.',
  TRANSPOSE: 'Swaps the rows and columns of a range.',
  MEDIAN: 'Returns the median of a set of numbers.',
  STDEV: 'Estimates the standard deviation of a sample.',
  'STDEV.P': 'Calculates the standard deviation of a population.',
  VAR: 'Estimates the variance of a sample.',
  LARGE: 'Returns the k-th largest value in a set.',
  SMALL: 'Returns the k-th smallest value in a set.',
  RANK: 'Returns the rank of a number in a list.',
  PERCENTILE: 'Returns the k-th percentile of a set.',
  QUARTILE: 'Returns the quartile of a set.',
  CORREL: 'Returns the correlation coefficient of two data sets.',
  FORECAST: 'Predicts a future value from known values.',
  TREND: 'Returns values along a linear trend.',
  SLOPE: 'Returns the slope of a linear regression line.',
  INTERCEPT: 'Returns the intercept of a linear regression line.',
  ISBLANK: 'Returns TRUE if a cell is empty.',
  ISNUMBER: 'Returns TRUE if a value is a number.',
  ISTEXT: 'Returns TRUE if a value is text.',
  ISERROR: 'Returns TRUE if a value is any error.',
  ISNA: 'Returns TRUE if a value is #N/A.',
  TYPE: 'Returns a number indicating the type of a value.',
  N: 'Converts a value to a number.',
  T: 'Returns text if the value is text, else empty string.',
  NA: 'Returns the #N/A error.',
  CELL: 'Returns information about a cell.',
  INFO: 'Returns information about the operating environment.',
  'ERROR.TYPE': 'Returns a number corresponding to an error type.',
  AGGREGATE: 'Aggregates a list with options to ignore hidden rows and errors.',
  SUBTOTAL: 'Returns a subtotal for a list, ignoring filtered rows.',
};

/**
 * Build the full registry from the actual HyperFormula plugin
 * registrations (built-ins + every engine plugin batch). Sorted by name.
 * Internal functions (ICE*, VERSION) are excluded.
 */
export function getFunctionRegistry(): FunctionRegistryEntry[] {
  const hf = HyperFormula.buildEmpty({ licenseKey: 'gpl-v3' });
  const names = hf.getRegisteredFunctionNames().filter((n) => !isInternalFunctionName(n));
  // HyperFormula 2.7.1 implements OFFSET directly in its interpreter — it
  // is never plugin-registered, so getRegisteredFunctionNames() omits it
  // even though it evaluates (function-coverage audit, 2026-10-21). Surface
  // it explicitly; its category/signature/description are curated above and
  // its version is BUILTIN_FUNCTION_VERSION (plugin lookup returns
  // undefined for it, which versionForPlugin maps to the built-in version).
  for (const hardcoded of ['OFFSET']) {
    if (!names.includes(hardcoded)) names.push(hardcoded);
  }
  return names
    .sort()
    .map((name) => {
      const plugin = hf.getFunctionPlugin(name);
      const category = FUNCTION_CATEGORIES[name] ?? keywordCategory(name);
      return {
        name,
        version: versionForPlugin(plugin),
        category,
        signature: FUNCTION_SIGNATURES[name] ?? synthesizeSignature(plugin, name),
        description: FUNCTION_DESCRIPTIONS[name] ?? `Worksheet function (${category}).`,
      };
    });
}

/**
 * Curated-metadata keys, for the drift test to validate: every key must
 * refer to an actually-registered function (no stale curation).
 */
export function getRegistryMetadataKeys(): {
  categories: string[];
  signatures: string[];
  descriptions: string[];
} {
  return {
    categories: Object.keys(FUNCTION_CATEGORIES),
    signatures: Object.keys(FUNCTION_SIGNATURES),
    descriptions: Object.keys(FUNCTION_DESCRIPTIONS),
  };
}

/**
 * The per-batch version table (plugin class name → version), for the drift
 * test to validate: every entry must correspond to an actually-registered
 * plugin class (no stale version entries after refactors).
 */
export function getRegistryPluginVersions(): Array<{ className: string; version: number }> {
  return [...PLUGIN_VERSIONS.entries()].map(([cls, version]) => ({ className: cls.name, version }));
}
