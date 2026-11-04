/**
 * Function plugin registration for the engine.
 *
 * Side-effectful: importing this module registers every Excel-compat
 * function plugin with HyperFormula. It MUST be imported before any
 * EngineWorkbook is constructed.
 *
 * Extracted from index.ts so the parallel-recalc worker (which must not
 * import the whole index — circularity) can register the identical plugin
 * set in worker threads / Web Workers.
 *
 * IMPORTANT: localization registers the 7 language packs at module-evaluation
 * time and MUST come first — HyperFormula's loadTranslations() only extends
 * languages that are already registered, so a plugin's per-locale function
 * names would be silently dropped if the packs didn't exist yet.
 */
import './localization.js';
import './function-aliases.js';
import './extended-functions.js';
import './extended-functions2.js';
import './extended-functions3.js';
import './extended-functions4.js';
import './extended-functions5.js';
import './financial-functions.js';
import './extended-functions7.js';
// Batch 8 registers explicitly (the module has no self-invoke):
// FORECAST.ETS family, FREQUENCY, MODE.MULT, LENB, TRIMRANGE.
// (T() is a HyperFormula built-in — not re-registered.)
import { registerExtendedFunctions8 } from './extended-functions8.js';
registerExtendedFunctions8();
// Batch 9 registers explicitly (the module has no self-invoke): GETPIVOTDATA,
// CELL, IMAGE, plus the engine-local PivotRegistry.
import { registerExtendedFunctions9 } from './extended-functions9.js';
registerExtendedFunctions9();
// Batch 10 registers explicitly (the module has no self-invoke):
// ENCODEURL, DETECTLANGUAGE, TRANSLATE, Thai locale functions,
// EUROCONVERT, FILTERXML, FIELDVALUE.
import { registerExtendedFunctions10 } from './extended-functions10.js';
registerExtendedFunctions10();
// Batch financial-2 registers explicitly (the module has no self-invoke):
// AMORDEGRC, AMORLINC, COUPDAYBS, COUPDAYSNC, COUPNCD, COUPPCD,
// PRICEMAT, YIELDMAT.
import { registerFinancialFunctions2 } from './financial-functions2.js';
registerFinancialFunctions2();
// Batch financial-3 (function-coverage Phase 2, 2026-10-21): the odd-period
// bond functions ODDFPRICE, ODDFYIELD, ODDLPRICE, ODDLYIELD — Microsoft's
// documented quasi-coupon algorithms, validated against MS examples.
import { registerFinancialFunctions3 } from './financial-functions3.js';
registerFinancialFunctions3();
import './dynamic-arrays.js';
import './lambda-functions.js';
// Batch 11 registers explicitly (the module has no self-invoke):
// STOCKHISTORY, WEBSERVICE, RTD, COPILOT, PY, CALL, REGISTER.ID —
// all real implementations. Zero #N/A stubs remain in the codebase.
import { registerExtendedFunctions11 } from './extended-functions11.js';
registerExtendedFunctions11();
// IMPORTDATA/IMPORTFEED/IMPORTHTML/IMPORTXML — the Fetch-component formula
// functions (design-docs/connector-vs-component.md).
import { registerImportFunctions } from './import-functions.js';
registerImportFunctions();
// IMPORTRANGE/GOOGLEFINANCE — the Google-connector formula functions
// (design-docs/connector-vs-component.md). Hosts supply the Google
// credential via setGoogleApiCredential() (IMPORTRANGE) and pre-feed or
// wire providers via publishMarketHistory()/setMarketDataProvider()
// (GOOGLEFINANCE, shared with STOCKHISTORY).
import { registerGoogleFunctions } from './google-functions.js';
registerGoogleFunctions();
// OLAP cube functions register explicitly (the module has no self-invoke):
// CUBEVALUE, CUBEMEMBER, CUBESET, CUBERANKEDMEMBER, CUBEKPIMEMBER,
// CUBEMEMBERPROPERTY, CUBESETCOUNT.
import { registerCubeFunctions } from './cube-functions.js';
registerCubeFunctions();
// GROUPBY / PIVOTBY dynamic-array aggregation (Microsoft 365;
// function-coverage Phase 2, 2026-10-21).
import { registerGroupByFunctions } from './groupby-functions.js';
registerGroupByFunctions();
// Excel-divergent protected built-ins (CEILING with significance 0):
// rerouted through engine-owned implementations via transparent rewrite.
import { registerDivergentBuiltins } from './divergent-builtins.js';
registerDivergentBuiltins();
// Excel's intersection (space) operator: `A1:B2 C3:D4` rewrites to
// ICEINTERSECT dispatch calls. See intersection-op.ts.
import { registerIntersectionOperator } from './intersection-op.js';
registerIntersectionOperator();
// Direct HyperFormula built-in overrides (registration-proven, no rewrite):
// BETA.DIST (upstream 5x PDF bug), FLOOR.MATH (mode), T.INV/T.INV.2T/
// F.DIST.RT/CONFIDENCE.T (precision). See hf-overrides.ts.
import './hf-overrides.js';
// BUG-2 (formula audit): named empty-cell comparisons. Keeps EmptyValue in
// the named-expression vertex cache so =Name="" is TRUE for a name that
// resolves to an empty cell (Excel parity). See named-empty-fix.ts.
import './named-empty-fix.js';
// External workbook references (=[1]Sheet1!A1): hidden ICEEXTREF dispatcher
// with parse-time rewrite in EngineWorkbook.setFormula. Cached values serve
// reads when the referenced file is unavailable; #REF! with no cached
// value (Excel behavior). See external-refs.ts.
import { registerExternalRefPlugin } from './external-refs.js';
registerExternalRefPlugin();
