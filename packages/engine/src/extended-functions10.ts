/**
 * Extended Excel-compatibility functions, batch 10.
 *
 * ENCODEURL, DETECTLANGUAGE, TRANSLATE, Thai locale functions (THAIDIGIT,
 * THAIDAYOFWEEK, THAIMONTHOFYEAR, THAIYEAR, THAINUMSOUND, THAINUMSTRING,
 * THAISTRINGLENGTH, NUMBERSTRING), EUROCONVERT, FILTERXML, FIELDVALUE.
 *
 * Design notes / known limitations:
 * - DETECTLANGUAGE ships with a heuristic default detector (script detection
 *   plus common-word lists for 7 Latin-script languages). Inject a real model
 *   via setLanguageDetectorProvider().
 * - TRANSLATE ships with a bundled phrasebook (~43 common phrases across
 *   en/es/fr/de/it/pt, pivoted through English). Matching is exact on a
 *   normalized form; anything absent is #N/A. Inject a network translator via
 *   setTranslatorProvider() for full translation.
 * - FIELDVALUE uses bundled SAMPLE snapshot data (marked below). Inject a live
 *   connector via setFieldValueDataProvider().
 * - HyperFormula 2.x has no #FIELD! error type, so FIELDVALUE maps Excel's
 *   #FIELD! to #N/A with a descriptive message.
 * - FILTERXML supports a documented XPath subset (see evaluateXPath).
 */
import {
  CellError,
  EmptyValue,
  ErrorType,
  FunctionArgumentType,
  FunctionPlugin,
  HyperFormula,
} from 'hyperformula';
import type { ProcedureAst } from 'hyperformula/typings/parser/Ast.js';
import type { InterpreterState } from 'hyperformula/typings/interpreter/InterpreterState.js';
import type { InterpreterValue } from 'hyperformula/typings/interpreter/InterpreterValue.js';
import { spill } from './dynamic-arrays.js';
import type { ArrayResult } from './dynamic-arrays.js';

/** Cast a 2D array to InterpreterValue (runtime supports it; types don't). */
function asValue(arr: ArrayResult): InterpreterValue {
  return arr as unknown as InterpreterValue;
}

/** Excel serial date (epoch 1899-12-30) to JS Date, UTC-based. */
function serialToDate(s: number): Date {
  return new Date(Math.round((s - 25569) * 86400 * 1000));
}

function numArg(v: InterpreterValue, dflt: number): number {
  if (v === EmptyValue || v === undefined) return dflt;
  return Number(v);
}

function strArg(v: InterpreterValue): string {
  return String(v === EmptyValue || v === undefined ? '' : v);
}

// ---------------------------------------------------------------------------
// 1. ENCODEURL — percent-encode per RFC 3986 (pure computation).
// ---------------------------------------------------------------------------

/**
 * Percent-encode text the way Excel's ENCODEURL does: encodeURIComponent plus
 * encoding of ! ' ( ) * which encodeURIComponent leaves unescaped.
 */
export function encodeUrlComponent(text: string): string {
  return encodeURIComponent(text).replace(/[!'()*]/g,
    (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
}

// ---------------------------------------------------------------------------
// 2. DETECTLANGUAGE — pluggable provider + heuristic default.
// ---------------------------------------------------------------------------

/** Pluggable language detector. Return an ISO 639-1 code, or null if unknown. */
export interface LanguageDetectorProvider {
  detect(text: string): string | null;
}

function inRanges(cp: number, ranges: Array<[number, number]>): boolean {
  return ranges.some(([lo, hi]) => cp >= lo && cp <= hi);
}

/** Heuristic default: script detection first, then common-word scoring. */
export function detectLanguageDefault(text: string): string {
  const cps = Array.from(text, (ch) => ch.codePointAt(0)!);
  const has = (ranges: Array<[number, number]>): boolean =>
    cps.some((cp) => inRanges(cp, ranges));
  // Script detection. Kana is checked before Han because Japanese mixes both.
  if (has([[0x3040, 0x309f], [0x30a0, 0x30ff], [0x31f0, 0x31ff]])) return 'ja';
  if (has([[0x1100, 0x11ff], [0xa960, 0xa97f], [0xac00, 0xd7af], [0xd7b0, 0xd7ff]])) return 'ko';
  if (has([[0x0e00, 0x0e7f]])) return 'th';
  if (has([[0x0900, 0x097f]])) return 'hi';
  if (has([[0x0600, 0x06ff]])) return 'ar';
  if (has([[0x0590, 0x05ff]])) return 'he';
  if (has([[0x0370, 0x03ff]])) return 'el';
  if (has([[0x0400, 0x04ff], [0x0500, 0x052f]])) return 'ru';
  if (has([[0x3400, 0x4dbf], [0x4e00, 0x9fff]])) return 'zh';

  // Latin-script: score common-word lists (diacritics stripped for matching).
  const plain = text.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const tokens = (plain.match(/[a-z]+/g) ?? []);
  if (tokens.length === 0) return 'und';
  const WORDS: Record<string, Set<string>> = {
    en: new Set('the be to of and a in that have i it for not on with he as you do at this but his by from they we say her she or an will my one all would there their hello world is are was were has had'.split(' ')),
    es: new Set('el la los las de del al y e en un una unos unas que es son esta estan por para con sin sobre entre pero porque como mas muy hola mundo mi tu su este gracias estoy'.split(' ')),
    fr: new Set('le la les de du des un une et est sont en dans pour avec sans sur sous par que qui ne pas plus tres bonjour monde mon ton son ce cette merci'.split(' ')),
    de: new Set('der die das den dem des ein eine einen einem einer und ist sind war waren von mit zu zum zur auf fur im in am an nicht aber hallo welt mein dein sein danke'.split(' ')),
    it: new Set('il lo la i gli le un uno una di del della al allo alla e ed sono in per con senza su piu molto ciao mondo mio tuo suo questo questa che non grazie'.split(' ')),
    pt: new Set('o a os as um uma uns umas de do da dos das no na e sao esta estao em para com sem sobre que nao mais muito ola mundo meu teu seu este tudo bem com voce obrigado'.split(' ')),
    nl: new Set('de het een van en is zijn in op aan voor met zonder door over onder dat die dit deze niet maar als te ten ter hallo wereld mijn jouw'.split(' ')),
  };
  let best: string | null = null;
  let bestScore = 0;
  let tied = false;
  for (const [lang, words] of Object.entries(WORDS)) {
    let score = 0;
    for (const t of tokens) if (words.has(t)) score++;
    if (score > bestScore) { bestScore = score; best = lang; tied = false; }
    else if (score === bestScore && score > 0) { tied = true; }
  }
  if (bestScore === 0 || tied) return 'und';
  return best!;
}

let languageDetectorProvider: LanguageDetectorProvider = { detect: detectLanguageDefault };

/** Inject a custom language detector (e.g. a real model or API-backed one). */
export function setLanguageDetectorProvider(p: LanguageDetectorProvider): void {
  languageDetectorProvider = p;
}

/** Restore the built-in heuristic detector. */
export function resetLanguageDetectorProvider(): void {
  languageDetectorProvider = { detect: detectLanguageDefault };
}

// ---------------------------------------------------------------------------
// 3. TRANSLATE — pluggable provider + bundled phrasebook default.
// ---------------------------------------------------------------------------

/**
 * Pluggable translator. `source` is null when the caller asked for
 * auto-detection. Return the translated text, or null when unavailable.
 */
export interface TranslatorProvider {
  translate(text: string, source: string | null, target: string): string | null;
}

type PhraseLangs = 'es' | 'fr' | 'de' | 'it' | 'pt';

/**
 * Bundled phrasebook: English pivot -> translations. Covers ~43 common
 * phrases. Exact match only (after normalization); inject a network provider
 * via setTranslatorProvider() for full translation.
 */
const PHRASEBOOK: Record<string, Record<PhraseLangs, string>> = {
  'hello': { es: 'hola', fr: 'bonjour', de: 'hallo', it: 'ciao', pt: 'olá' },
  'goodbye': { es: 'adiós', fr: 'au revoir', de: 'auf wiedersehen', it: 'addio', pt: 'adeus' },
  'thank you': { es: 'gracias', fr: 'merci', de: 'danke', it: 'grazie', pt: 'obrigado' },
  'please': { es: 'por favor', fr: "s'il vous plaît", de: 'bitte', it: 'per favore', pt: 'por favor' },
  'yes': { es: 'sí', fr: 'oui', de: 'ja', it: 'sì', pt: 'sim' },
  'no': { es: 'no', fr: 'non', de: 'nein', it: 'no', pt: 'não' },
  'good morning': { es: 'buenos días', fr: 'bonjour', de: 'guten morgen', it: 'buongiorno', pt: 'bom dia' },
  'good evening': { es: 'buenas noches', fr: 'bonsoir', de: 'guten abend', it: 'buonasera', pt: 'boa noite' },
  'good night': { es: 'buenas noches', fr: 'bonne nuit', de: 'gute nacht', it: 'buonanotte', pt: 'boa noite' },
  'excuse me': { es: 'perdón', fr: 'excusez-moi', de: 'entschuldigung', it: 'scusi', pt: 'com licença' },
  'sorry': { es: 'lo siento', fr: 'désolé', de: 'es tut mir leid', it: 'mi dispiace', pt: 'desculpe' },
  'how are you': { es: 'cómo estás', fr: 'comment ça va', de: 'wie geht es dir', it: 'come stai', pt: 'como você está' },
  'my name is': { es: 'me llamo', fr: "je m'appelle", de: 'ich heiße', it: 'mi chiamo', pt: 'meu nome é' },
  'where is': { es: 'dónde está', fr: 'où est', de: 'wo ist', it: "dov'è", pt: 'onde fica' },
  'how much': { es: 'cuánto cuesta', fr: 'combien ça coûte', de: 'wie viel kostet', it: 'quanto costa', pt: 'quanto custa' },
  'i love you': { es: 'te amo', fr: "je t'aime", de: 'ich liebe dich', it: 'ti amo', pt: 'eu te amo' },
  'water': { es: 'agua', fr: 'eau', de: 'wasser', it: 'acqua', pt: 'água' },
  'food': { es: 'comida', fr: 'nourriture', de: 'essen', it: 'cibo', pt: 'comida' },
  'bread': { es: 'pan', fr: 'pain', de: 'brot', it: 'pane', pt: 'pão' },
  'coffee': { es: 'café', fr: 'café', de: 'kaffee', it: 'caffè', pt: 'café' },
  'house': { es: 'casa', fr: 'maison', de: 'haus', it: 'casa', pt: 'casa' },
  'dog': { es: 'perro', fr: 'chien', de: 'hund', it: 'cane', pt: 'cachorro' },
  'cat': { es: 'gato', fr: 'chat', de: 'katze', it: 'gatto', pt: 'gato' },
  'book': { es: 'libro', fr: 'livre', de: 'buch', it: 'libro', pt: 'livro' },
  'day': { es: 'día', fr: 'jour', de: 'tag', it: 'giorno', pt: 'dia' },
  'night': { es: 'noche', fr: 'nuit', de: 'nacht', it: 'notte', pt: 'noite' },
  'time': { es: 'tiempo', fr: 'temps', de: 'zeit', it: 'tempo', pt: 'tempo' },
  'money': { es: 'dinero', fr: 'argent', de: 'geld', it: 'soldi', pt: 'dinheiro' },
  'friend': { es: 'amigo', fr: 'ami', de: 'freund', it: 'amico', pt: 'amigo' },
  'family': { es: 'familia', fr: 'famille', de: 'familie', it: 'famiglia', pt: 'família' },
  'love': { es: 'amor', fr: 'amour', de: 'liebe', it: 'amore', pt: 'amor' },
  'happy': { es: 'feliz', fr: 'heureux', de: 'glücklich', it: 'felice', pt: 'feliz' },
  'big': { es: 'grande', fr: 'grand', de: 'groß', it: 'grande', pt: 'grande' },
  'small': { es: 'pequeño', fr: 'petit', de: 'klein', it: 'piccolo', pt: 'pequeno' },
  'one': { es: 'uno', fr: 'un', de: 'eins', it: 'uno', pt: 'um' },
  'two': { es: 'dos', fr: 'deux', de: 'zwei', it: 'due', pt: 'dois' },
  'three': { es: 'tres', fr: 'trois', de: 'drei', it: 'tre', pt: 'três' },
  'red': { es: 'rojo', fr: 'rouge', de: 'rot', it: 'rosso', pt: 'vermelho' },
  'man': { es: 'hombre', fr: 'homme', de: 'mann', it: 'uomo', pt: 'homem' },
  'woman': { es: 'mujer', fr: 'femme', de: 'frau', it: 'donna', pt: 'mulher' },
  'child': { es: 'niño', fr: 'enfant', de: 'kind', it: 'bambino', pt: 'criança' },
  'sun': { es: 'sol', fr: 'soleil', de: 'sonne', it: 'sole', pt: 'sol' },
  'welcome': { es: 'bienvenido', fr: 'bienvenue', de: 'willkommen', it: 'benvenuto', pt: 'bem-vindo' },
};

/** Normalize for exact phrasebook matching. */
function normalizePhrase(s: string): string {
  return s.toLowerCase().trim()
    .replace(/[¿¡«»"“”'‘’.,!?;:\-–—]/g, '')
    .replace(/\s+/g, ' ');
}

const PHRASE_LANGS: PhraseLangs[] = ['es', 'fr', 'de', 'it', 'pt'];

/** Default translator: exact phrasebook lookup pivoted through English. */
export function translatePhrasebook(text: string, source: string | null, target: string): string | null {
  const norm = normalizePhrase(text);
  if (!norm) return null;
  const tgt = (target || 'en').toLowerCase();
  if (tgt !== 'en' && !PHRASE_LANGS.includes(tgt as PhraseLangs)) return null;

  // Find the English pivot key.
  let key: string | null = null;
  if (PHRASEBOOK[norm]) {
    key = norm;
  } else {
    let src = source ? source.toLowerCase() : null;
    if (!src) {
      const detected = languageDetectorProvider.detect(text);
      src = detected && detected !== 'und' ? detected : null;
    }
    const langsToTry: string[] = src && src !== 'en'
      ? [src, ...PHRASE_LANGS.filter((l) => l !== src)]
      : [...PHRASE_LANGS];
    outer: for (const [k, trans] of Object.entries(PHRASEBOOK)) {
      for (const l of langsToTry) {
        if (normalizePhrase(trans[l as PhraseLangs]) === norm) { key = k; break outer; }
      }
    }
  }
  if (!key) return null;
  if (tgt === 'en') return key;
  return PHRASEBOOK[key]![tgt as PhraseLangs] ?? null;
}

let translatorProvider: TranslatorProvider = { translate: translatePhrasebook };

/** Inject a custom translator (e.g. a network-backed translation service). */
export function setTranslatorProvider(p: TranslatorProvider): void {
  translatorProvider = p;
}

/** Restore the bundled phrasebook translator. */
export function resetTranslatorProvider(): void {
  translatorProvider = { translate: translatePhrasebook };
}

// ---------------------------------------------------------------------------
// 4-11. Thai locale functions (pure computation, no external data needed).
// ---------------------------------------------------------------------------

const THAI_DIGITS = ['๐', '๑', '๒', '๓', '๔', '๕', '๖', '๗', '๘', '๙'];
const THAI_DAYS = ['วันอาทิตย์', 'วันจันทร์', 'วันอังคาร', 'วันพุธ', 'วันพฤหัสบดี', 'วันศุกร์', 'วันเสาร์'];
const THAI_MONTHS = ['มกราคม', 'กุมภาพันธ์', 'มีนาคม', 'เมษายน', 'พฤษภาคม', 'มิถุนายน',
  'กรกฎาคม', 'สิงหาคม', 'กันยายน', 'ตุลาคม', 'พฤศจิกายน', 'ธันวาคม'];

/** THAIDIGIT: Arabic digits 0-9 -> Thai digits ๐-๙. */
export function thaiDigit(text: string): string {
  return text.replace(/[0-9]/g, (d) => THAI_DIGITS[Number(d)]!);
}

/** THAIDAYOFWEEK: Thai weekday name for an Excel serial date (Sunday-first). */
export function thaiDayOfWeek(serial: number): string {
  return THAI_DAYS[serialToDate(serial).getUTCDay()]!;
}

/** THAIMONTHOFYEAR: Thai month name for an Excel serial date. */
export function thaiMonthOfYear(serial: number): string {
  return THAI_MONTHS[serialToDate(serial).getUTCMonth()]!;
}

/** THAIYEAR: Buddhist Era year (Gregorian + 543) for an Excel serial date. */
export function thaiYear(serial: number): number {
  return serialToDate(serial).getUTCFullYear() + 543;
}

const THAI_NUM_WORDS = ['', 'หนึ่ง', 'สอง', 'สาม', 'สี่', 'ห้า', 'หก', 'เจ็ด', 'แปด', 'เก้า'];
const THAI_PLACE_WORDS = ['', 'สิบ', 'ร้อย', 'พัน', 'หมื่น', 'แสน'];

/** Thai words for n < 1,000,000. `sound`: colloquial reading (เอ็ด for unit 1). */
function thaiUnderMillion(n: number, sound: boolean): string {
  if (n === 0) return 'ศูนย์';
  const parts: string[] = [];
  const digitAt = (i: number): number => Math.floor(n / 10 ** i) % 10;
  for (let i = 5; i >= 1; i--) {
    const d = digitAt(i);
    if (d === 0) continue;
    if (i === 1) {
      parts.push(d === 1 ? 'สิบ' : d === 2 ? 'ยี่สิบ' : THAI_NUM_WORDS[d]! + 'สิบ');
    } else {
      parts.push(THAI_NUM_WORDS[d]! + THAI_PLACE_WORDS[i]!);
    }
  }
  const u = digitAt(0);
  if (u !== 0) {
    if (u === 1 && n > 9) parts.push(sound ? 'เอ็ด' : 'หนึ่ง');
    else parts.push(THAI_NUM_WORDS[u]!);
  }
  return parts.join('');
}

/**
 * Thai number words. `sound=false` is the formal THAINUMSTRING form
 * (ยี่สิบหนึ่ง), `sound=true` the colloquial THAINUMSOUND reading
 * (ยี่สิบเอ็ด). Grouped by ล้าน (10^6): e.g. 1234567 ->
 * หนึ่งล้านสองแสนสามหมื่นสี่พันห้าร้อยหกสิบเจ็ด.
 */
export function thaiNumberWords(n: number, sound: boolean): string {
  if (!Number.isFinite(n) || n < 0) throw new Error('THAINUMSOUND/THAINUMSTRING need a non-negative number.');
  const int = Math.trunc(n);
  if (int === 0) return 'ศูนย์';
  const millions = Math.floor(int / 1_000_000);
  const rest = int % 1_000_000;
  let out = '';
  if (millions > 0) out += thaiNumberWords(millions, sound) + 'ล้าน';
  if (rest > 0) out += thaiUnderMillion(rest, sound);
  return out;
}

/** Thai combining (non-spacing) marks: attach to the preceding base character. */
const THAI_COMBINING = new Set<number>([
  0x0e31,
  ...Array.from({ length: 0x0e3a - 0x0e34 + 1 }, (_, i) => 0x0e34 + i),
  ...Array.from({ length: 0x0e4e - 0x0e47 + 1 }, (_, i) => 0x0e47 + i),
]);

/**
 * THAISTRINGLENGTH: length in Thai characters. Counts Unicode code points,
 * except Thai non-spacing marks (vowels/tone marks above/below a consonant),
 * which attach to the preceding base character and are not counted separately.
 */
export function thaiStringLength(text: string): number {
  let len = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    if (THAI_COMBINING.has(cp)) continue;
    len++;
  }
  return len;
}

/**
 * NUMBERSTRING(n, type): type 1 -> Thai digits string, type 2 -> Thai number
 * words (formal, like THAINUMSTRING). Defaults to 1.
 */
export function numberString(n: number, type: number): string {
  if (!Number.isFinite(n)) throw new Error('NUMBERSTRING needs a number.');
  if (type === 1) return thaiDigit(String(n));
  if (type === 2) return thaiNumberWords(n, false);
  throw new Error('NUMBERSTRING type must be 1 or 2.');
}

// ---------------------------------------------------------------------------
// 12. EUROCONVERT — official fixed irrevocable conversion rates, via EUR.
// ---------------------------------------------------------------------------

/** Units of national currency per 1 EUR (official irrevocable rates). */
const EURO_RATES: Record<string, number> = {
  EUR: 1,
  ATS: 13.7603,   // Austrian schilling
  BEF: 40.3399,   // Belgian franc
  CYP: 0.585274,  // Cyprus pound
  DEM: 1.95583,   // German mark
  EEK: 15.6466,   // Estonian kroon
  ESP: 166.386,   // Spanish peseta
  FIM: 5.94573,   // Finnish markka
  FRF: 6.55957,   // French franc
  GRD: 340.750,   // Greek drachma
  HRK: 7.53450,   // Croatian kuna
  IEP: 0.787564,  // Irish pound
  ITL: 1936.27,   // Italian lira
  LTL: 3.45280,   // Lithuanian litas
  LUF: 40.3399,   // Luxembourg franc
  LVL: 0.702804,  // Latvian lats
  MTL: 0.429300,  // Maltese lira
  NLG: 2.20371,   // Dutch guilder
  PTE: 200.482,   // Portuguese escudo
  SIT: 239.640,   // Slovenian tolar
  SKK: 30.1260,   // Slovak koruna
};

/** Target currencies with no minor unit: 0 decimals, everything else 2. */
const EURO_ZERO_DECIMAL = new Set(['ITL', 'ESP', 'GRD', 'PTE']);

function roundTo(v: number, decimals: number): number {
  const f = 10 ** decimals;
  return Math.round(v * f + Number.EPSILON) / f;
}

/**
 * Convert between euro-area legacy currencies. Triangulates via EUR; when
 * both legs are non-EUR and triangulation_precision is given, the intermediate
 * EUR value (and the converted value) are rounded to that many decimals.
 * full_precision TRUE skips the final per-currency rounding.
 */
export function euroConvert(
  amount: number,
  source: string,
  target: string,
  fullPrecision = false,
  triangulationPrecision: number | null = null,
): number {
  const src = source.trim().toUpperCase();
  const tgt = target.trim().toUpperCase();
  const srcRate = EURO_RATES[src];
  const tgtRate = EURO_RATES[tgt];
  if (srcRate === undefined || tgtRate === undefined) {
    throw new Error(`Unknown currency code: ${srcRate === undefined ? source : target}.`);
  }
  let eur = src === 'EUR' ? amount : amount / srcRate;
  const triangulate = src !== 'EUR' && tgt !== 'EUR' && triangulationPrecision !== null;
  if (triangulate) eur = roundTo(eur, triangulationPrecision!);
  let result = tgt === 'EUR' ? eur : eur * tgtRate;
  if (triangulate) result = roundTo(result, triangulationPrecision!);
  if (fullPrecision) return result;
  const decimals = EURO_ZERO_DECIMAL.has(tgt) ? 0 : 2;
  return roundTo(result, decimals);
}

// ---------------------------------------------------------------------------
// 13. FILTERXML — minimal built-in XML parser + XPath subset (no new deps).
// ---------------------------------------------------------------------------

/** Tiny DOM node used by FILTERXML. */
export interface XmlNode {
  name: string;
  attrs: Record<string, string>;
  children: XmlNode[];
  /** Direct text content (decoded). */
  text: string;
}

function decodeXmlEntities(s: string): string {
  const named: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
  return s
    .replace(/&(amp|lt|gt|quot|apos);/g, (m, e: string) => named[e] ?? m)
    .replace(/&#(\d+);/g, (m, d: string) => {
      const cp = parseInt(d, 10);
      return Number.isFinite(cp) ? String.fromCodePoint(cp) : m;
    })
    .replace(/&#x([0-9a-fA-F]+);/g, (m, h: string) => {
      const cp = parseInt(h, 16);
      return Number.isFinite(cp) ? String.fromCodePoint(cp) : m;
    });
}

function parseXmlAttrs(body: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const re = /([^\s=/>]+)\s*=\s*("([^"]*)"|'([^']*)')/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    attrs[m[1]!] = decodeXmlEntities(m[3] ?? m[4] ?? '');
  }
  return attrs;
}

/**
 * Parse XML into a pseudo-document node. Handles elements, attributes,
 * self-closing tags, text, CDATA, comments and processing instructions.
 * Throws on malformed XML.
 */
export function parseXml(xmlText: string): XmlNode {
  const doc: XmlNode = { name: '#document', attrs: {}, children: [], text: '' };
  const stack: XmlNode[] = [doc];
  const fail = (msg: string): never => { throw new Error(`Invalid XML: ${msg}`); };
  let i = 0;
  const n = xmlText.length;
  while (i < n) {
    if (xmlText[i] === '<') {
      if (xmlText.startsWith('<!--', i)) {
        const end = xmlText.indexOf('-->', i + 4);
        if (end < 0) fail('unclosed comment');
        i = end + 3;
        continue;
      }
      if (xmlText.startsWith('<?', i)) {
        const end = xmlText.indexOf('?>', i + 2);
        if (end < 0) fail('unclosed processing instruction');
        i = end + 2;
        continue;
      }
      if (xmlText.startsWith('<![CDATA[', i)) {
        const end = xmlText.indexOf(']]>', i + 9);
        if (end < 0) fail('unclosed CDATA');
        stack[stack.length - 1]!.text += xmlText.slice(i + 9, end);
        i = end + 3;
        continue;
      }
      const end = xmlText.indexOf('>', i + 1);
      if (end < 0) fail('unclosed tag');
      const raw = xmlText.slice(i + 1, end).trim();
      i = end + 1;
      if (raw.startsWith('/')) {
        const name = raw.slice(1).trim().split(/\s/)[0]!;
        const top = stack.pop();
        if (!top || top.name !== name) fail(`mismatched close tag </${name}>`);
        continue;
      }
      const selfClosing = raw.endsWith('/');
      const body = (selfClosing ? raw.slice(0, -1) : raw).trim();
      const m = /^([^\s/>]+)([\s\S]*)$/.exec(body);
      if (m === null) throw new Error(`Invalid XML: bad tag <${raw}>`);
      const node: XmlNode = { name: m[1]!, attrs: parseXmlAttrs(m[2] ?? ''), children: [], text: '' };
      stack[stack.length - 1]!.children.push(node);
      if (!selfClosing) stack.push(node);
    } else {
      const next = xmlText.indexOf('<', i);
      const chunk = next < 0 ? xmlText.slice(i) : xmlText.slice(i, next);
      stack[stack.length - 1]!.text += decodeXmlEntities(chunk);
      i = next < 0 ? n : next;
    }
  }
  if (stack.length !== 1) fail('unclosed element');
  return doc;
}

type XPathStep =
  | { kind: 'element'; name: string; index: number | null }
  | { kind: 'attribute'; name: string }
  | { kind: 'text' };

function parseXPath(xpath: string): { descendant: boolean; steps: XPathStep[] } {
  let xp = xpath.trim();
  let descendant = false;
  if (xp.startsWith('//')) { descendant = true; xp = xp.slice(2); }
  else if (xp.startsWith('/')) { xp = xp.slice(1); }
  else throw new Error('Only absolute (/a/b) or descendant (//b) XPath is supported.');
  const steps: XPathStep[] = xp.split('/').map((part): XPathStep => {
    if (part === 'text()') return { kind: 'text' };
    if (part.startsWith('@')) {
      const name = part.slice(1);
      if (!name) throw new Error('Empty attribute name in XPath.');
      return { kind: 'attribute', name };
    }
    const m = /^([A-Za-z_][\w:.-]*)(?:\[(\d+)\])?$/.exec(part);
    if (!m) throw new Error(`Unsupported XPath step: "${part}".`);
    return { kind: 'element', name: m[1]!, index: m[2] ? parseInt(m[2], 10) : null };
  });
  if (steps.length === 0) throw new Error('Empty XPath.');
  return { descendant, steps };
}

function descendantsNamed(node: XmlNode, name: string, out: XmlNode[]): void {
  for (const c of node.children) {
    if (c.name === name) out.push(c);
    descendantsNamed(c, name, out);
  }
}

function applyIndex(nodes: XmlNode[], index: number | null): XmlNode[] {
  if (index === null) return nodes;
  return index >= 1 && index <= nodes.length ? [nodes[index - 1]!] : [];
}

/** Concatenated text of a node and all its descendants. */
function textContent(node: XmlNode): string {
  return node.text + node.children.map(textContent).join('');
}

/**
 * Evaluate the supported XPath subset against a parsed document:
 * - `/a/b` absolute child path
 * - `//b` any descendant named b
 * - `/a/b[1]` 1-based positional predicate
 * - `/a/b/@attr`, `//b/@attr` attribute values ('' when absent)
 * - `.../text()` direct text of matched nodes
 *
 * Element steps return each node's full text content; the final attribute /
 * text() steps return strings. Throws on unsupported XPath.
 */
export function evaluateXPath(doc: XmlNode, xpath: string): string[] {
  const { descendant, steps } = parseXPath(xpath);
  let nodes: XmlNode[] = [doc];
  let stepIdx = 0;
  if (descendant) {
    const first = steps[0]!;
    if (first.kind !== 'element') throw new Error('A descendant search must start with an element name.');
    const found: XmlNode[] = [];
    descendantsNamed(doc, first.name, found);
    nodes = applyIndex(found, first.index);
    stepIdx = 1;
  }
  for (; stepIdx < steps.length; stepIdx++) {
    const st = steps[stepIdx]!;
    if (st.kind === 'text') return nodes.map((nd) => nd.text);
    if (st.kind === 'attribute') return nodes.map((nd) => nd.attrs[st.name] ?? '');
    const next: XmlNode[] = [];
    for (const nd of nodes) {
      for (const c of nd.children) if (c.name === st.name) next.push(c);
    }
    nodes = applyIndex(next, st.index);
  }
  return nodes.map(textContent);
}

/** Parse + evaluate; returns matched strings or a CellError (#N/A: no match, #VALUE!: bad XML/XPath). */
export function filterXmlValues(xmlText: string, xpath: string): string[] | CellError {
  try {
    const values = evaluateXPath(parseXml(xmlText), xpath);
    if (values.length === 0) return new CellError(ErrorType.NA, 'XPath matched no nodes.');
    return values;
  } catch (e) {
    return new CellError(ErrorType.VALUE, e instanceof Error ? e.message : 'Invalid XML or XPath.');
  }
}

/**
 * Host-side spill path for FILTERXML: evaluates and writes a multi-node
 * result through dynamic-arrays' spill() helper (anchor keeps the formula).
 */
export function spillFilterXml(
  anchorRow: number,
  anchorCol: number,
  xmlText: string,
  xpath: string,
  setCell: (row: number, col: number, value: InterpreterValue) => void,
  getCell?: (row: number, col: number) => InterpreterValue | undefined,
): CellError | 'ok' {
  const values = filterXmlValues(xmlText, xpath);
  if (values instanceof CellError) return values;
  const arr: ArrayResult = values.map((v) => [v as InterpreterValue]);
  return spill(anchorRow, anchorCol, arr, setCell, getCell);
}

// ---------------------------------------------------------------------------
// 14. FIELDVALUE — bundled SAMPLE reference data + pluggable provider.
// ---------------------------------------------------------------------------

/** One linked-data entity: match keys plus its named fields. */
export interface FieldValueEntity {
  keys: string[];
  fields: Record<string, string | number | boolean>;
}

/** Pluggable FIELDVALUE data source. Return null when the value is unknown. */
export interface FieldValueDataProvider {
  findEntity(value: string): FieldValueEntity | null;
}

// --- Bundled SAMPLE snapshot data (offline use; inject a live connector
// --- via setFieldValueDataProvider() for real quotes / geography data). ---

function stock(symbol: string, name: string, price: number, pe: number, cap: number, exchange: string): FieldValueEntity {
  return {
    keys: [symbol.toLowerCase(), name.toLowerCase()],
    fields: { symbol, name, price, peratio: pe, marketcap: cap, exchange },
  };
}

function city(name: string, country: string, population: number, lat: number, lon: number): FieldValueEntity {
  return {
    keys: [name.toLowerCase()],
    fields: { name, country, population, latitude: lat, longitude: lon },
  };
}

const FIELDVALUE_SAMPLE: FieldValueEntity[] = [
  stock('AAPL', 'Apple Inc.', 258.40, 38.2, 3940000000000, 'NASDAQ'),
  stock('MSFT', 'Microsoft Corporation', 512.30, 39.5, 3820000000000, 'NASDAQ'),
  stock('GOOGL', 'Alphabet Inc.', 318.75, 27.4, 3870000000000, 'NASDAQ'),
  stock('AMZN', 'Amazon.com Inc.', 244.10, 44.8, 2560000000000, 'NASDAQ'),
  stock('TSLA', 'Tesla Inc.', 342.60, 118.3, 1100000000000, 'NASDAQ'),
  stock('NVDA', 'NVIDIA Corporation', 178.90, 52.6, 4350000000000, 'NASDAQ'),
  stock('META', 'Meta Platforms Inc.', 742.15, 30.1, 1900000000000, 'NASDAQ'),
  stock('NFLX', 'Netflix Inc.', 1180.50, 52.3, 505000000000, 'NASDAQ'),
  stock('AMD', 'Advanced Micro Devices Inc.', 168.20, 48.9, 272000000000, 'NASDAQ'),
  stock('INTC', 'Intel Corporation', 38.75, 92.4, 168000000000, 'NASDAQ'),
  stock('IBM', 'International Business Machines Corporation', 298.40, 28.7, 274000000000, 'NYSE'),
  stock('ORCL', 'Oracle Corporation', 285.60, 42.1, 782000000000, 'NYSE'),
  stock('ADBE', 'Adobe Inc.', 385.20, 24.6, 166000000000, 'NASDAQ'),
  stock('CRM', 'Salesforce Inc.', 248.90, 52.8, 238000000000, 'NYSE'),
  stock('JPM', 'JPMorgan Chase & Co.', 312.75, 14.2, 892000000000, 'NYSE'),
  city('New York', 'United States', 8335000, 40.7128, -74.0060),
  city('London', 'United Kingdom', 8982000, 51.5074, -0.1278),
  city('Tokyo', 'Japan', 13960000, 35.6762, 139.6503),
  city('Paris', 'France', 2103000, 48.8566, 2.3522),
  city('Berlin', 'Germany', 3677000, 52.5200, 13.4050),
  city('Sydney', 'Australia', 5260000, -33.8688, 151.2093),
  city('Mumbai', 'India', 12442000, 19.0760, 72.8777),
  city('São Paulo', 'Brazil', 11451000, -23.5558, -46.6396),
  city('Cairo', 'Egypt', 9606000, 30.0444, 31.2357),
  city('Beijing', 'China', 21893000, 39.9042, 116.4074),
  city('Moscow', 'Russia', 13010000, 55.7558, 37.6173),
  city('Toronto', 'Canada', 2794000, 43.6532, -79.3832),
  city('Mexico City', 'Mexico', 9209000, 19.4326, -99.1332),
  city('Lagos', 'Nigeria', 15388000, 6.5244, 3.3792),
  city('Jakarta', 'Indonesia', 10562000, -6.2088, 106.8456),
];

/** Default provider: case-insensitive lookup over the bundled sample data. */
export function findFieldValueSample(value: string): FieldValueEntity | null {
  const key = value.trim().toLowerCase();
  return FIELDVALUE_SAMPLE.find((e) => e.keys.includes(key)) ?? null;
}

/** Normalize a field name: case-insensitive, ignores spaces/underscores. */
export function normalizeFieldName(field: string): string {
  return field.toLowerCase().replace(/[\s_]+/g, '');
}

let fieldValueDataProvider: FieldValueDataProvider = { findEntity: findFieldValueSample };

/** Inject a custom FIELDVALUE data source (e.g. a live stocks/geography connector). */
export function setFieldValueDataProvider(p: FieldValueDataProvider): void {
  fieldValueDataProvider = p;
}

/** Restore the bundled sample data provider. */
export function resetFieldValueDataProvider(): void {
  fieldValueDataProvider = { findEntity: findFieldValueSample };
}

// ---------------------------------------------------------------------------
// Rich-value FIELDVALUE binding (Phase E piece B, issue #69 item 2).
// ---------------------------------------------------------------------------
//
// An adapter ResolvedRichValue (packages/xlsx-adapter/src/richValues.ts)
// converts to a FieldValueEntity with NO TypedValue change and NO new
// value kind: the entity is keyed by the cell's display text (its
// fallback, plus the _Self field value when present), exactly like the
// sample provider's symbol/name keys. FIELDVALUE's first argument
// evaluates to that display text (the engine stores the cached fallback
// as the cell's value), so a host that registers the file's resolved
// rich values can answer FIELDVALUE(cell, "Price") from the record
// itself. Lookup order in the plugin below is: rich-value registry
// first, then the configured (sample/live) provider — so unregistered
// cells keep the old behaviour, and two records sharing one display
// text resolve to the first registered (documented; Excel-created
// entities have no stronger identity in this model).
//
// Structural input on purpose: the engine must not import the adapter
// package, so hosts pass resolved values through this shape (an adapter
// ResolvedRichValue satisfies it directly).
// ---------------------------------------------------------------------------

/** Structural shape of one adapter ResolvedRichValue, for FIELDVALUE binding. */
export interface RichValueFieldValueInput {
  fields: Array<{ key: string; value: string | number | boolean }>;
  /** Record `<fb>` text, else the cell's cached `<v>` text. */
  fallback?: string;
}

/** Convert one resolved rich value to a FIELDVALUE entity. */
export function richValueToFieldValueEntity(input: RichValueFieldValueInput): FieldValueEntity {
  const fields: Record<string, string | number | boolean> = {};
  for (const f of input.fields) fields[normalizeFieldName(f.key)] = f.value;
  const keys: string[] = [];
  const addKey = (v: string | undefined): void => {
    if (!v) return;
    const k = v.trim().toLowerCase();
    if (k !== '' && !keys.includes(k)) keys.push(k);
  };
  addKey(input.fallback);
  const self = fields['self'];
  if (typeof self === 'string') addKey(self);
  return { keys, fields };
}

/** Rich-value entities registered by the host, keyed by lowercased display text. */
const richValueEntities = new Map<string, FieldValueEntity>();

/**
 * Register resolved rich values for FIELDVALUE lookup (host call: the
 * app registers the file's resolved values on open; the server engine
 * registers them at load). Replaces nothing: later registrations for
 * the same key win, and `clearRichValueFieldValueEntities()` drops all.
 */
export function registerRichValueFieldValueEntities(
  inputs: readonly RichValueFieldValueInput[],
): void {
  for (const input of inputs) {
    const entity = richValueToFieldValueEntity(input);
    for (const key of entity.keys) richValueEntities.set(key, entity);
  }
}

/** Drop all registered rich-value entities (file close / new workbook). */
export function clearRichValueFieldValueEntities(): void {
  richValueEntities.clear();
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

export class ExtendedPlugin10 extends FunctionPlugin {
  public static implementedFunctions = {
    ENCODEURL: { method: 'encodeurl', parameters: [
      { argumentType: FunctionArgumentType.SCALAR },
    ]},
    DETECTLANGUAGE: { method: 'detectlanguage', parameters: [
      { argumentType: FunctionArgumentType.SCALAR },
    ]},
    TRANSLATE: { method: 'translate', parameters: [
      { argumentType: FunctionArgumentType.SCALAR },
      { argumentType: FunctionArgumentType.SCALAR, optionalArg: true },
      { argumentType: FunctionArgumentType.SCALAR, optionalArg: true },
    ]},
    THAIDIGIT: { method: 'thaidigit', parameters: [
      { argumentType: FunctionArgumentType.SCALAR },
    ]},
    THAIDAYOFWEEK: { method: 'thaidayofweek', parameters: [
      { argumentType: FunctionArgumentType.SCALAR },
    ]},
    THAIMONTHOFYEAR: { method: 'thaimonthofyear', parameters: [
      { argumentType: FunctionArgumentType.SCALAR },
    ]},
    THAIYEAR: { method: 'thaiyear', parameters: [
      { argumentType: FunctionArgumentType.SCALAR },
    ]},
    THAINUMSOUND: { method: 'thainumsound', parameters: [
      { argumentType: FunctionArgumentType.SCALAR },
    ]},
    THAINUMSTRING: { method: 'thainumstring', parameters: [
      { argumentType: FunctionArgumentType.SCALAR },
    ]},
    THAISTRINGLENGTH: { method: 'thaistringlength', parameters: [
      { argumentType: FunctionArgumentType.SCALAR },
    ]},
    NUMBERSTRING: { method: 'numberstring', parameters: [
      { argumentType: FunctionArgumentType.SCALAR },
      { argumentType: FunctionArgumentType.SCALAR, optionalArg: true },
    ]},
    EUROCONVERT: { method: 'euroconvert', parameters: [
      { argumentType: FunctionArgumentType.SCALAR },
      { argumentType: FunctionArgumentType.SCALAR },
      { argumentType: FunctionArgumentType.SCALAR },
      { argumentType: FunctionArgumentType.SCALAR, optionalArg: true },
      { argumentType: FunctionArgumentType.SCALAR, optionalArg: true },
    ]},
    FILTERXML: { method: 'filterxml', parameters: [
      { argumentType: FunctionArgumentType.SCALAR },
      { argumentType: FunctionArgumentType.SCALAR },
    ]},
    FIELDVALUE: { method: 'fieldvalue', parameters: [
      { argumentType: FunctionArgumentType.SCALAR },
      { argumentType: FunctionArgumentType.SCALAR },
    ]},
  };

  public encodeurl(ast: ProcedureAst, state: InterpreterState): InterpreterValue {
    return this.runFunction(ast.args, state, this.metadata('ENCODEURL'),
      (arg: InterpreterValue): InterpreterValue => {
        if (arg instanceof CellError) return arg;
        return encodeUrlComponent(strArg(arg));
      });
  }

  public detectlanguage(ast: ProcedureAst, state: InterpreterState): InterpreterValue {
    return this.runFunction(ast.args, state, this.metadata('DETECTLANGUAGE'),
      (arg: InterpreterValue): InterpreterValue => {
        if (arg instanceof CellError) return arg;
        const text = strArg(arg);
        if (!text.trim()) return 'und';
        return languageDetectorProvider.detect(text) ?? 'und';
      });
  }

  public translate(ast: ProcedureAst, state: InterpreterState): InterpreterValue {
    return this.runFunction(ast.args, state, this.metadata('TRANSLATE'),
      (...args: InterpreterValue[]): InterpreterValue => {
        const [textArg, srcArg, tgtArg] = args;
        if (textArg instanceof CellError) return textArg;
        if (srcArg instanceof CellError) return srcArg;
        if (tgtArg instanceof CellError) return tgtArg;
        const text = strArg(textArg);
        const source = srcArg === undefined || srcArg === EmptyValue ? null : strArg(srcArg) || null;
        const target = tgtArg === undefined || tgtArg === EmptyValue ? 'en' : strArg(tgtArg) || 'en';
        const out = translatorProvider.translate(text, source, target);
        if (out === null) return new CellError(ErrorType.NA, 'No translation available for this phrase.');
        return out;
      });
  }

  public thaidigit(ast: ProcedureAst, state: InterpreterState): InterpreterValue {
    return this.runFunction(ast.args, state, this.metadata('THAIDIGIT'),
      (arg: InterpreterValue): InterpreterValue => {
        if (arg instanceof CellError) return arg;
        return thaiDigit(strArg(arg));
      });
  }

  public thaidayofweek(ast: ProcedureAst, state: InterpreterState): InterpreterValue {
    return this.runFunction(ast.args, state, this.metadata('THAIDAYOFWEEK'),
      (arg: InterpreterValue): InterpreterValue => {
        if (arg instanceof CellError) return arg;
        const serial = numArg(arg, NaN);
        if (!Number.isFinite(serial)) return new CellError(ErrorType.VALUE, 'THAIDAYOFWEEK needs a date.');
        return thaiDayOfWeek(serial);
      });
  }

  public thaimonthofyear(ast: ProcedureAst, state: InterpreterState): InterpreterValue {
    return this.runFunction(ast.args, state, this.metadata('THAIMONTHOFYEAR'),
      (arg: InterpreterValue): InterpreterValue => {
        if (arg instanceof CellError) return arg;
        const serial = numArg(arg, NaN);
        if (!Number.isFinite(serial)) return new CellError(ErrorType.VALUE, 'THAIMONTHOFYEAR needs a date.');
        return thaiMonthOfYear(serial);
      });
  }

  public thaiyear(ast: ProcedureAst, state: InterpreterState): InterpreterValue {
    return this.runFunction(ast.args, state, this.metadata('THAIYEAR'),
      (arg: InterpreterValue): InterpreterValue => {
        if (arg instanceof CellError) return arg;
        const serial = numArg(arg, NaN);
        if (!Number.isFinite(serial)) return new CellError(ErrorType.VALUE, 'THAIYEAR needs a date.');
        return thaiYear(serial);
      });
  }

  public thainumsound(ast: ProcedureAst, state: InterpreterState): InterpreterValue {
    return this.runFunction(ast.args, state, this.metadata('THAINUMSOUND'),
      (arg: InterpreterValue): InterpreterValue => {
        if (arg instanceof CellError) return arg;
        const n = numArg(arg, NaN);
        if (!Number.isFinite(n) || n < 0) return new CellError(ErrorType.NUM, 'THAINUMSOUND needs a non-negative number.');
        return thaiNumberWords(n, true);
      });
  }

  public thainumstring(ast: ProcedureAst, state: InterpreterState): InterpreterValue {
    return this.runFunction(ast.args, state, this.metadata('THAINUMSTRING'),
      (arg: InterpreterValue): InterpreterValue => {
        if (arg instanceof CellError) return arg;
        const n = numArg(arg, NaN);
        if (!Number.isFinite(n) || n < 0) return new CellError(ErrorType.NUM, 'THAINUMSTRING needs a non-negative number.');
        return thaiNumberWords(n, false);
      });
  }

  public thaistringlength(ast: ProcedureAst, state: InterpreterState): InterpreterValue {
    return this.runFunction(ast.args, state, this.metadata('THAISTRINGLENGTH'),
      (arg: InterpreterValue): InterpreterValue => {
        if (arg instanceof CellError) return arg;
        return thaiStringLength(strArg(arg));
      });
  }

  public numberstring(ast: ProcedureAst, state: InterpreterState): InterpreterValue {
    return this.runFunction(ast.args, state, this.metadata('NUMBERSTRING'),
      (...args: InterpreterValue[]): InterpreterValue => {
        const [nArg, tArg] = args;
        if (nArg instanceof CellError) return nArg;
        if (tArg instanceof CellError) return tArg;
        const n = numArg(nArg, NaN);
        if (!Number.isFinite(n)) return new CellError(ErrorType.VALUE, 'NUMBERSTRING needs a number.');
        const type = tArg === undefined || tArg === EmptyValue ? 1 : Math.trunc(numArg(tArg, 1));
        try {
          return numberString(n, type);
        } catch (e) {
          return new CellError(ErrorType.VALUE, e instanceof Error ? e.message : 'Invalid NUMBERSTRING type.');
        }
      });
  }

  public euroconvert(ast: ProcedureAst, state: InterpreterState): InterpreterValue {
    return this.runFunction(ast.args, state, this.metadata('EUROCONVERT'),
      (...args: InterpreterValue[]): InterpreterValue => {
        const [nArg, sArg, tArg, fArg, triArg] = args;
        if (nArg instanceof CellError) return nArg;
        if (sArg instanceof CellError) return sArg;
        if (tArg instanceof CellError) return tArg;
        const amount = numArg(nArg, NaN);
        if (!Number.isFinite(amount)) return new CellError(ErrorType.VALUE, 'EUROCONVERT needs a number.');
        const fullPrecision = fArg !== undefined && fArg !== EmptyValue && fArg !== false && fArg !== 0
          ? Boolean(fArg) : false;
        const tri = triArg === undefined || triArg === EmptyValue ? null : Math.trunc(numArg(triArg, 3));
        try {
          return euroConvert(amount, strArg(sArg), strArg(tArg), fullPrecision, tri);
        } catch (e) {
          return new CellError(ErrorType.NA, e instanceof Error ? e.message : 'Unknown currency.');
        }
      });
  }

  public filterxml(ast: ProcedureAst, state: InterpreterState): InterpreterValue {
    return this.runFunction(ast.args, state, this.metadata('FILTERXML'),
      (...args: InterpreterValue[]): InterpreterValue => {
        const [xmlArg, xpArg] = args;
        if (xmlArg instanceof CellError) return xmlArg;
        if (xpArg instanceof CellError) return xpArg;
        const values = filterXmlValues(strArg(xmlArg), strArg(xpArg));
        if (values instanceof CellError) return values;
        if (values.length === 1) return values[0]!;
        return asValue(values.map((v) => [v as InterpreterValue]));
      });
  }

  public fieldvalue(ast: ProcedureAst, state: InterpreterState): InterpreterValue {
    return this.runFunction(ast.args, state, this.metadata('FIELDVALUE'),
      (...args: InterpreterValue[]): InterpreterValue => {
        const [vArg, fArg] = args;
        if (vArg instanceof CellError) return vArg;
        if (fArg instanceof CellError) return fArg;
        const value = strArg(vArg);
        const field = strArg(fArg);
        // Excel would show #FIELD! here; HyperFormula has no FIELD error type.
        // Rich-value entities registered by the host (Phase E piece B)
        // resolve first — the cell's display text is the lookup key —
        // then the configured sample/live provider, as before.
        const entity =
          richValueEntities.get(value.trim().toLowerCase()) ?? fieldValueDataProvider.findEntity(value);
        if (!entity) {
          return new CellError(ErrorType.NA, `Unknown entity "${value}". (Excel shows #FIELD!.)`);
        }
        const fv = entity.fields[normalizeFieldName(field)];
        if (fv === undefined) {
          return new CellError(ErrorType.NA, `Unknown field "${field}". (Excel shows #FIELD!.)`);
        }
        return fv as InterpreterValue;
      });
  }
}

export function registerExtendedFunctions10(): void {
  if (HyperFormula.getFunctionPlugin('ENCODEURL') !== undefined) return;
  const names = {
    ENCODEURL: 'ENCODEURL', DETECTLANGUAGE: 'DETECTLANGUAGE', TRANSLATE: 'TRANSLATE',
    THAIDIGIT: 'THAIDIGIT', THAIDAYOFWEEK: 'THAIDAYOFWEEK', THAIMONTHOFYEAR: 'THAIMONTHOFYEAR',
    THAIYEAR: 'THAIYEAR', THAINUMSOUND: 'THAINUMSOUND', THAINUMSTRING: 'THAINUMSTRING',
    THAISTRINGLENGTH: 'THAISTRINGLENGTH', NUMBERSTRING: 'NUMBERSTRING',
    EUROCONVERT: 'EUROCONVERT', FILTERXML: 'FILTERXML', FIELDVALUE: 'FIELDVALUE',
  };
  HyperFormula.registerFunctionPlugin(ExtendedPlugin10, { enGB: names, enUS: names });
}
