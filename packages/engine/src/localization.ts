/**
 * Formula localization (track 22: formula-localization).
 *
 * Provides function-name translations for 7 locales so users can write
 * formulas in their locale (e.g., =SUMA(A1:A10) in Spanish).
 *
 * HyperFormula pre-registers only enGB; the esES/frFR/deDE/enUS packs ship
 * in the hyperformula package but must be registered explicitly. They cover
 * HyperFormula's native functions — our custom plugin functions are NOT in
 * them, so CUSTOM_TRANSLATIONS are overlaid on top.
 *
 * jaJP/zhCN limitation (upstream HyperFormula): the formula lexer only
 * accepts Latin letters for procedure names
 * (parser-consts UNICODE_LETTER_PATTERN = 'A-Za-z\u00C0-\u02AF'), so CJK
 * function names can never be parsed. Registering CJK names in the pack
 * would corrupt workbooks: HyperFormula's updateConfig() serializes
 * formulas in the NEW language and re-parses them, so switching to a CJK
 * locale would turn every formula into #ERROR. These packs therefore keep
 * English function names (formulas stay parseable; English input keeps
 * working); localizeFunctionName() still provides CJK display names for UI
 * chrome such as the function gallery.
 *
 * Registration runs at module-evaluation time (like the function plugins'
 * self-registration) so the packs exist before any plugin's
 * registerFunctionPlugin() call — HyperFormula's loadTranslations() only
 * extends languages that are already registered, and the plugins'
 * per-locale translations would otherwise be silently dropped.
 *
 * Usage:
 *   import { setEngineLanguage } from './localization.js'; // (via EngineWorkbook)
 *   const wb = new EngineWorkbook(initial, { language: 'esES' });
 *   wb.setFormulaLanguage('frFR');
 */

import { HyperFormula } from 'hyperformula';
// @ts-expect-error — internal language pack, no types.
import enGBPack from 'hyperformula/commonjs/i18n/languages/enGB.js';
// @ts-expect-error — internal language pack, no types.
import enUSPack from 'hyperformula/commonjs/i18n/languages/enUS.js';
// @ts-expect-error — internal language pack, no types.
import esESPack from 'hyperformula/commonjs/i18n/languages/esES.js';
// @ts-expect-error — internal language pack, no types.
import frFRPack from 'hyperformula/commonjs/i18n/languages/frFR.js';
// @ts-expect-error — internal language pack, no types.
import deDEPack from 'hyperformula/commonjs/i18n/languages/deDE.js';

export type SupportedLocale = 'enGB' | 'enUS' | 'esES' | 'frFR' | 'deDE' | 'jaJP' | 'zhCN';

export const DEFAULT_LOCALE: SupportedLocale = 'enUS';

export const SUPPORTED_LOCALES: { id: SupportedLocale; label: string }[] = [
  { id: 'enUS', label: 'English (US)' },
  { id: 'enGB', label: 'English (UK)' },
  { id: 'esES', label: 'Español' },
  { id: 'frFR', label: 'Français' },
  { id: 'deDE', label: 'Deutsch' },
  { id: 'jaJP', label: '日本語' },
  { id: 'zhCN', label: '中文' },
];

/**
 * Translations for custom plugin functions.
 * Maps English name -> localized name per locale.
 * Covers the 120 custom functions (extended-functions, financial, dynamic arrays, lambda).
 */
const CUSTOM_TRANSLATIONS: Record<string, Partial<Record<SupportedLocale, string>>> = {
  // Lookup
  XLOOKUP: { esES: 'BUSCARX', frFR: 'RECHERCHEX', deDE: 'XVERWEIS', jaJP: 'XLOOKUP', zhCN: 'XLOOKUP' },
  // Text
  TEXTJOIN: { esES: 'UNIRTEXTO', frFR: 'JOINDRE.TEXTE', deDE: 'TEXTVERKETTEN', jaJP: 'TEXTJOIN', zhCN: 'TEXTJOIN' },
  TEXTBEFORE: { esES: 'ANTESDETEXTO', frFR: 'AVANTTEXTE', deDE: 'TEXTVOR', jaJP: 'TEXTBEFORE', zhCN: 'TEXTBEFORE' },
  TEXTAFTER: { esES: 'DESPUESDETEXTO', frFR: 'APRESTEXTE', deDE: 'TEXTNACH', jaJP: 'TEXTAFTER', zhCN: 'TEXTAFTER' },
  TEXTSPLIT: { esES: 'DIVIDIRTEXTO', frFR: 'FRACTIONNER.TEXTE', deDE: 'TEXTTRENNEN', jaJP: 'TEXTSPLIT', zhCN: 'TEXTSPLIT' },
  ARRAYTOTEXT: { esES: 'MATRIZATEXTO', frFR: 'MATRICEENTEXTE', deDE: 'MATRIXZUTEXT', jaJP: 'ARRAYTOTEXT', zhCN: 'ARRAYTOTEXT' },
  VALUETOTEXT: { esES: 'VALORATEXTO', frFR: 'VALEURENTEXTE', deDE: 'WERTZUTEXT', jaJP: 'VALUETOTEXT', zhCN: 'VALUETOTEXT' },
  REGEXTEST: { esES: 'PROBARREGEX', frFR: 'TESTERREGEX', deDE: 'REGEXTEST', jaJP: 'REGEXTEST', zhCN: 'REGEXTEST' },
  REGEXEXTRACT: { esES: 'EXTRAERREGEX', frFR: 'EXTRAIREREGEX', deDE: 'REGEXEXTRAKT', jaJP: 'REGEXEXTRACT', zhCN: 'REGEXEXTRACT' },
  REGEXREPLACE: { esES: 'REEMPLAZARREGEX', frFR: 'REMPLACERREGEX', deDE: 'REGEXERSETZEN', jaJP: 'REGEXREPLACE', zhCN: 'REGEXREPLACE' },
  // Dynamic arrays
  SEQUENCE: { esES: 'SECUENCIA', frFR: 'SEQUENCE', deDE: 'SEQUENZ', jaJP: 'SEQUENCE', zhCN: 'SEQUENCE' },
  SORT: { esES: 'ORDENAR', frFR: 'TRIER', deDE: 'SORTIEREN', jaJP: 'SORT', zhCN: 'SORT' },
  SORTBY: { esES: 'ORDENARPOR', frFR: 'TRIERPAR', deDE: 'SORTIERENNACH', jaJP: 'SORTBY', zhCN: 'SORTBY' },
  UNIQUE: { esES: 'UNICOS', frFR: 'UNIQUE', deDE: 'EINDEUTIG', jaJP: 'UNIQUE', zhCN: 'UNIQUE' },
  RANDARRAY: { esES: 'MATRIZALEATORIA', frFR: 'TABLEAU.ALEAT', deDE: 'ZUFALLSMATRIX', jaJP: 'RANDARRAY', zhCN: 'RANDARRAY' },
  // Lambda
  LET: { esES: 'LET', frFR: 'LETTRE', deDE: 'LET', jaJP: 'LET', zhCN: 'LET' },
  LAMBDA: { esES: 'LAMBDA', frFR: 'LAMBDA', deDE: 'LAMBDA', jaJP: 'LAMBDA', zhCN: 'LAMBDA' },
  MAP: { esES: 'MAPEAR', frFR: 'MAPPER', deDE: 'ZUORDNEN', jaJP: 'MAP', zhCN: 'MAP' },
  REDUCE: { esES: 'REDUCIR', frFR: 'REDUIRE', deDE: 'REDUZIEREN', jaJP: 'REDUCE', zhCN: 'REDUCE' },
  SCAN: { esES: 'EXAMINAR', frFR: 'ANALYSER', deDE: 'PRÜFEN', jaJP: 'SCAN', zhCN: 'SCAN' },
  // Financial (bond)
  PRICE: { esES: 'PRECIO', frFR: 'PRIX', deDE: 'KURS', jaJP: 'PRICE', zhCN: 'PRICE' },
  YIELD: { esES: 'RENDIMIENTO', frFR: 'RENDEMENT', deDE: 'RENDITE', jaJP: 'YIELD', zhCN: 'YIELD' },
  DURATION: { esES: 'DURACION', frFR: 'DUREE', deDE: 'DAUER', jaJP: 'DURATION', zhCN: 'DURATION' },
  // Stats
  AVERAGEIFS: { esES: 'PROMEDIO.SI.CONJUNTO', frFR: 'MOYENNE.SI.ENS', deDE: 'MITTELWERTWENNS', jaJP: 'AVERAGEIFS', zhCN: 'AVERAGEIFS' },
  // Database
  DSUM: { esES: 'BDSUMA', frFR: 'BDSOMME', deDE: 'DBSUMME', jaJP: 'DSUM', zhCN: 'DSUM' },
  DAVERAGE: { esES: 'BDPROMEDIO', frFR: 'BDMOYENNE', deDE: 'DBMITTELWERT', jaJP: 'DAVERAGE', zhCN: 'DAVERAGE' },
  DCOUNT: { esES: 'BDCONTAR', frFR: 'BDNB', deDE: 'DBANZAHL', jaJP: 'DCOUNT', zhCN: 'DCOUNT' },
  // Math
  GESTEP: { esES: 'ESMAYOROIGUAL', frFR: 'SUP.OU.EGAL', deDE: 'GROESSERGLEICH', jaJP: 'GESTEP', zhCN: 'GESTEP' },
};

/** Common Excel functions translated for jaJP/zhCN (HyperFormula has no built-in packs). */
const CORE_JA_ZH: Record<string, { jaJP: string; zhCN: string }> = {
  SUM: { jaJP: '合計', zhCN: '求和' },
  AVERAGE: { jaJP: '平均', zhCN: '平均值' },
  COUNT: { jaJP: 'カウント', zhCN: '计数' },
  MAX: { jaJP: '最大値', zhCN: '最大值' },
  MIN: { jaJP: '最小値', zhCN: '最小值' },
  IF: { jaJP: 'IF', zhCN: '如果' },
  VLOOKUP: { jaJP: 'VLOOKUP', zhCN: '垂直查找' },
  SUMIF: { jaJP: 'SUMIF', zhCN: '条件求和' },
};

let registered = false;

/**
 * True when the locale is already in HyperFormula's registry. The module
 * `registered` flag below only guards a single module instance — tests load
 * both src and dist copies of this module against one shared HyperFormula,
 * so each locale is also checked against the real registry.
 */
function isRegistered(locale: string): boolean {
  try {
    HyperFormula.getLanguage(locale);
    return true;
  } catch {
    return false;
  }
}

interface RawPack {
  functions: Record<string, string>;
  errors: Record<string, string>;
  ui: Record<string, string>;
}

function rawPack(pack: unknown): RawPack {
  const p = (pack as { default?: RawPack }).default ?? (pack as RawPack);
  return { functions: { ...p.functions }, errors: { ...p.errors }, ui: { ...p.ui } };
}

/**
 * Register locale packs with HyperFormula. Call once at startup.
 *
 * HyperFormula pre-registers only enGB; the esES/frFR/deDE/enUS packs ship
 * in the hyperformula package but must be registered explicitly. They cover
 * HyperFormula's native functions — our custom plugin functions are NOT in
 * them, so CUSTOM_TRANSLATIONS are overlaid on top. For jaJP/zhCN (no
 * built-in pack) we clone enGB's full pack and overlay translations.
 */
export function registerLocales(): void {
  if (registered) return;
  registered = true;

  const enGB = rawPack(enGBPack);

  // Overlay custom-function translations onto a base pack's function dict.
  const withCustom = (base: RawPack, locale: SupportedLocale): RawPack => {
    const functions = { ...base.functions };
    for (const [en, map] of Object.entries(CUSTOM_TRANSLATIONS)) {
      const t = map[locale];
      if (t && t !== en) functions[en] = t;
    }
    return { functions, errors: { ...base.errors }, ui: { ...base.ui } };
  };

  // Built-in packs for esES/frFR/deDE (+enUS for completeness).
  const builtins: { locale: SupportedLocale; pack: unknown }[] = [
    { locale: 'enUS', pack: enUSPack },
    { locale: 'esES', pack: esESPack },
    { locale: 'frFR', pack: frFRPack },
    { locale: 'deDE', pack: deDEPack },
  ];
  for (const { locale, pack } of builtins) {
    if (!isRegistered(locale)) {
      HyperFormula.registerLanguage(locale, withCustom(rawPack(pack), locale) as never);
    }
  }

  // jaJP/zhCN: no built-in pack, and CJK function names are unparseable
  // (see module docstring) — clone enGB so formulas stay English and
  // parseable. Only errors/ui are carried over.
  for (const locale of ['jaJP', 'zhCN'] as const) {
    if (isRegistered(locale)) continue;
    HyperFormula.registerLanguage(locale, {
      functions: { ...enGB.functions },
      errors: { ...enGB.errors },
      ui: { ...enGB.ui },
    } as never);
  }
}

// Register at module-evaluation time so the packs exist before the function
// plugins self-register (see module docstring). Idempotent.
registerLocales();

/**
 * HyperFormula's built-in error vocabulary has no #NULL! (ErrorType lacks
 * NULL), so the formula parser rejects the =#NULL! error literal with
 * "Unknown error literal". Excel files do contain =#NULL! (e.g. xlsxwriter's
 * formula_results01). Extend ALL registered locale packs' error tables so
 * the parser maps '#NULL!' -> 'NULL' in every language; the engine's
 * HF_ERROR_MAP already translates 'NULL' back to the '#NULL!' typed-view
 * code. Must run before any HyperFormula instance is built (Config snapshots
 * the mapping). Without this, HF's exporter throws MissingTranslationError
 * for the NULL error key under non-English locales.
 */
export function registerNullErrorLiteral(): void {
  const locales: string[] = ['enGB', 'enUS', 'esES', 'frFR', 'deDE', 'jaJP', 'zhCN'];
  for (const locale of locales) {
    try {
      const pack = HyperFormula.getLanguage(locale) as unknown as {
        errors: Record<string, string>;
      };
      if (pack && pack.errors && pack.errors['NULL'] === undefined) {
        pack.errors['NULL'] = '#NULL!';
      }
    } catch {
      // Locale not registered: nothing to extend.
    }
  }
}

registerNullErrorLiteral();

/** Get the localized name for a function, or the English name if untranslated. */
export function localizeFunctionName(en: string, locale: SupportedLocale): string {
  if (locale === 'enGB' || locale === 'enUS') return en;
  const custom = CUSTOM_TRANSLATIONS[en]?.[locale as 'esES' | 'frFR' | 'deDE' | 'jaJP' | 'zhCN'];
  if (custom) return custom;
  if (locale === 'jaJP' || locale === 'zhCN') {
    return CORE_JA_ZH[en]?.[locale] ?? en;
  }
  return en;
}
