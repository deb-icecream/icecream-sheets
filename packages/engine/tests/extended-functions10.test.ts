/**
 * Tests for batch-10 functions (extended-functions10.ts).
 *
 * Imports ONLY the new module under test (plus vitest and the hyperformula
 * npm package used to build throwaway instances). Never the engine index,
 * so other registrations for these names cannot interfere.
 */
import { describe, expect, it } from 'vitest';
import { CellError, HyperFormula } from 'hyperformula';
import {
  registerExtendedFunctions10,
  encodeUrlComponent,
  detectLanguageDefault,
  translatePhrasebook,
  thaiDigit,
  thaiDayOfWeek,
  thaiMonthOfYear,
  thaiYear,
  thaiNumberWords,
  thaiStringLength,
  numberString,
  euroConvert,
  parseXml,
  evaluateXPath,
  filterXmlValues,
  spillFilterXml,
  setLanguageDetectorProvider,
  resetLanguageDetectorProvider,
  setTranslatorProvider,
  resetTranslatorProvider,
  setFieldValueDataProvider,
  resetFieldValueDataProvider,
} from '../src/extended-functions10.js';

registerExtendedFunctions10();

/** Evaluate a single formula in a fresh HyperFormula instance. */
function calc(formula: string): unknown {
  const hf = HyperFormula.buildFromArray([[formula]], { licenseKey: 'gpl-v3' });
  return hf.getCellValue({ sheet: 0, row: 0, col: 0 });
}

function calcErr(formula: string): string {
  // getCellValue surfaces errors as HyperFormula's DetailedCellError
  // ({ value: '#N/A', type: 'NA', ... }), not a CellError instance.
  const v = calc(formula) as { type?: string; value?: string } | null;
  expect(v).not.toBeNull();
  expect(typeof v).toBe('object');
  expect(typeof v!.value).toBe('string');
  expect(v!.value!.startsWith('#')).toBe(true);
  return v!.type!;
}

describe('ENCODEURL', () => {
  it('encodes a space as %20', () => {
    expect(calc('=ENCODEURL("hello world")')).toBe('hello%20world');
  });
  it('encodes characters encodeURIComponent leaves alone (!\'()*)', () => {
    expect(calc('=ENCODEURL("a!b")')).toBe('a%21b');
    expect(encodeUrlComponent("it's (fine)*")).toBe("it%27s%20%28fine%29%2A");
  });
  it('leaves unreserved characters alone', () => {
    expect(calc('=ENCODEURL("abc-_.~123")')).toBe('abc-_.~123');
  });
});

describe('DETECTLANGUAGE', () => {
  const cases: Array<[string, string]> = [
    ['the quick brown fox jumps over the lazy dog', 'en'],
    ['el perro y la casa son grandes', 'es'],
    ['le chat et le chien sont amis', 'fr'],
    ['der Hund und die Katze sind Freunde', 'de'],
    ['ciao mondo come stai oggi', 'it'],
    ['olá meu amigo, tudo bem com você', 'pt'],
    ['de kat en de hond zijn vrienden', 'nl'],
    ['こんにちは世界', 'ja'],
    ['日本語のテスト', 'ja'], // kanji + kana still Japanese
    ['你好世界', 'zh'],
    ['Привет мир', 'ru'],
    ['مرحبا بالعالم', 'ar'],
    ['नमस्ते दुनिया', 'hi'],
    ['สวัสดีชาวโลก', 'th'],
    ['Γεια σου κόσμε', 'el'],
    ['שלום עולם', 'he'],
  ];
  for (const [text, lang] of cases) {
    it(`detects ${lang} via formula`, () => {
      expect(calc(`=DETECTLANGUAGE("${text}")`)).toBe(lang);
    });
  }
  it('detects the same via the pure default detector', () => {
    for (const [text, lang] of cases) expect(detectLanguageDefault(text)).toBe(lang);
  });
  it('returns und when indeterminable', () => {
    expect(calc('=DETECTLANGUAGE("xyzzy qqq 123")')).toBe('und');
    expect(calc('=DETECTLANGUAGE("")')).toBe('und');
  });
  it('a custom provider overrides the default', () => {
    setLanguageDetectorProvider({ detect: () => 'xx' });
    try {
      expect(calc('=DETECTLANGUAGE("hello")')).toBe('xx');
    } finally {
      resetLanguageDetectorProvider();
    }
    expect(calc('=DETECTLANGUAGE("hello")')).toBe('en');
  });
});

describe('TRANSLATE', () => {
  it('translates hello en->es', () => {
    expect(calc('=TRANSLATE("hello","en","es")')).toBe('hola');
  });
  it('translates bonjour fr->en', () => {
    expect(calc('=TRANSLATE("bonjour","fr","en")')).toBe('hello');
  });
  it('pivots through English (de->it)', () => {
    expect(calc('=TRANSLATE("hallo","de","it")')).toBe('ciao');
  });
  it('translates a multi-word phrase', () => {
    expect(calc('=TRANSLATE("good night","en","de")')).toBe('gute nacht');
  });
  it('auto-detects the source language when omitted', () => {
    expect(calc('=TRANSLATE("hola","","en")')).toBe('hello');
  });
  it('defaults the target to English', () => {
    expect(calc('=TRANSLATE("gracias","es")')).toBe('thank you');
  });
  it('returns #N/A for phrases outside the phrasebook', () => {
    expect(calcErr('=TRANSLATE("supercalifragilistic","en","es")')).toBe('NA');
  });
  it('pure phrasebook helper matches the formula path', () => {
    expect(translatePhrasebook('hello', 'en', 'es')).toBe('hola');
    expect(translatePhrasebook('xyzzy', 'en', 'es')).toBeNull();
  });
  it('a custom provider overrides the default', () => {
    setTranslatorProvider({ translate: () => 'CUSTOM' });
    try {
      expect(calc('=TRANSLATE("hello","en","es")')).toBe('CUSTOM');
    } finally {
      resetTranslatorProvider();
    }
    expect(calc('=TRANSLATE("hello","en","es")')).toBe('hola');
  });
});

describe('THAIDIGIT', () => {
  it('converts "123" to Thai digits', () => {
    expect(calc('=THAIDIGIT("123")')).toBe('๑๒๓');
  });
  it('accepts a numeric argument', () => {
    expect(calc('=THAIDIGIT(123)')).toBe('๑๒๓');
  });
  it('leaves non-digits alone (pure helper)', () => {
    expect(thaiDigit('abc 4.5')).toBe('abc ๔.๕');
  });
});

describe('THAIDAYOFWEEK', () => {
  it('2026-01-04 (Sunday) -> วันอาทิตย์', () => {
    expect(calc('=THAIDAYOFWEEK(DATE(2026,1,4))')).toBe('วันอาทิตย์');
  });
  it('2026-01-05 (Monday) -> วันจันทร์', () => {
    expect(calc('=THAIDAYOFWEEK(DATE(2026,1,5))')).toBe('วันจันทร์');
  });
  it('pure helper matches', () => {
    expect(thaiDayOfWeek(46023)).toBe('วันพฤหัสบดี'); // 2026-01-01 is Thursday
  });
});

describe('THAIMONTHOFYEAR', () => {
  it('March -> มีนาคม', () => {
    expect(calc('=THAIMONTHOFYEAR(DATE(2026,3,15))')).toBe('มีนาคม');
  });
  it('January -> มกราคม', () => {
    expect(calc('=THAIMONTHOFYEAR(DATE(2026,1,1))')).toBe('มกราคม');
  });
  it('pure helper matches', () => {
    expect(thaiMonthOfYear(46023)).toBe('มกราคม');
  });
});

describe('THAIYEAR', () => {
  it('DATE(2026,1,1) -> 2569 (Buddhist Era)', () => {
    expect(calc('=THAIYEAR(DATE(2026,1,1))')).toBe(2569);
  });
  it('DATE(2000,6,1) -> 2543', () => {
    expect(calc('=THAIYEAR(DATE(2000,6,1))')).toBe(2543);
  });
  it('pure helper matches', () => {
    expect(thaiYear(46023)).toBe(2569);
  });
});

describe('THAINUMSOUND / THAINUMSTRING', () => {
  it('THAINUMSOUND(21) uses colloquial เอ็ด', () => {
    expect(calc('=THAINUMSOUND(21)')).toBe('ยี่สิบเอ็ด');
  });
  it('THAINUMSTRING(21) uses formal หนึ่ง', () => {
    expect(calc('=THAINUMSTRING(21)')).toBe('ยี่สิบหนึ่ง');
  });
  it('11: สิบเอ็ด vs สิบหนึ่ง', () => {
    expect(calc('=THAINUMSOUND(11)')).toBe('สิบเอ็ด');
    expect(calc('=THAINUMSTRING(11)')).toBe('สิบหนึ่ง');
  });
  it('ล้าน grouping: 1234567', () => {
    expect(thaiNumberWords(1234567, false)).toBe('หนึ่งล้านสองแสนสามหมื่นสี่พันห้าร้อยหกสิบเจ็ด');
  });
  it('zero -> ศูนย์', () => {
    expect(calc('=THAINUMSTRING(0)')).toBe('ศูนย์');
  });
  it('negative input is #NUM!', () => {
    expect(calcErr('=THAINUMSOUND(-5)')).toBe('NUM');
  });
});

describe('THAISTRINGLENGTH', () => {
  it('สวัสดี -> 4 (combining marks not counted)', () => {
    expect(calc('=THAISTRINGLENGTH("สวัสดี")')).toBe(4);
  });
  it('plain consonants count one each', () => {
    expect(calc('=THAISTRINGLENGTH("กขค")')).toBe(3);
  });
  it('base + tone mark counts as one Thai character', () => {
    expect(thaiStringLength('ก่')).toBe(1); // U+0E01 U+0E48
  });
  it('latin text counts code points', () => {
    expect(calc('=THAISTRINGLENGTH("hello")')).toBe(5);
  });
});

describe('NUMBERSTRING', () => {
  it('type 1 -> Thai digits', () => {
    expect(calc('=NUMBERSTRING(123,1)')).toBe('๑๒๓');
  });
  it('type 2 -> Thai number words', () => {
    expect(calc('=NUMBERSTRING(123,2)')).toBe('หนึ่งร้อยยี่สิบสาม');
  });
  it('defaults to type 1', () => {
    expect(calc('=NUMBERSTRING(123)')).toBe('๑๒๓');
  });
  it('invalid type is #VALUE!', () => {
    expect(calcErr('=NUMBERSTRING(5,3)')).toBe('VALUE');
  });
  it('pure helper matches', () => {
    expect(numberString(123, 1)).toBe('๑๒๓');
    expect(numberString(21, 2)).toBe('ยี่สิบหนึ่ง');
  });
});

describe('EUROCONVERT', () => {
  it('100 DEM -> EUR = 51.13', () => {
    expect(calc('=EUROCONVERT(100,"DEM","EUR")')).toBe(51.13);
  });
  it('100 EUR -> DEM = 195.58 (2 decimals)', () => {
    expect(calc('=EUROCONVERT(100,"EUR","DEM")')).toBe(195.58);
  });
  it('lira has no minor unit: 1 EUR -> ITL = 1936', () => {
    expect(calc('=EUROCONVERT(1,"EUR","ITL")')).toBe(1936);
  });
  it('full_precision TRUE skips rounding', () => {
    expect(calc('=EUROCONVERT(100,"EUR","DEM",TRUE)')).toBe(195.583);
  });
  it('triangulates DEM->FRF via EUR', () => {
    expect(calc('=EUROCONVERT(100,"DEM","FRF")')).toBe(335.39);
  });
  it('codes are case-insensitive', () => {
    expect(calc('=EUROCONVERT(100,"dem","eur")')).toBe(51.13);
  });
  it('unknown currency is #N/A', () => {
    expect(calcErr('=EUROCONVERT(100,"DEM","USD")')).toBe('NA');
  });
  it('pure helper matches (incl. explicit triangulation precision)', () => {
    expect(euroConvert(100, 'DEM', 'EUR')).toBe(51.13);
    expect(euroConvert(100, 'DEM', 'FRF', false, 2)).toBe(335.39);
  });
});

describe('FILTERXML', () => {
  const xml = '<a><b>foo</b><b>bar</b></a>';
  it('Excel documented example: //b spills {"foo";"bar"}', () => {
    expect(calc(`=FILTERXML("${xml}","//b")`)).toEqual([['foo'], ['bar']]);
  });
  it('indexed step returns a scalar', () => {
    expect(calc(`=FILTERXML("${xml}","/a/b[2]")`)).toBe('bar');
    expect(calc(`=FILTERXML("${xml}","/a/b[1]")`)).toBe('foo');
  });
  it('attribute selection', () => {
    // NB: HyperFormula's formula lexer rejects "" escapes inside string
    // literals, so the test XML uses single-quoted attributes (supported).
    expect(calc('=FILTERXML("<a><b id=\'x\'>foo</b></a>","/a/b/@id")')).toBe('x');
  });
  it('text() selection', () => {
    expect(calc('=FILTERXML("<a><b>foo</b></a>","//b/text()")')).toBe('foo');
  });
  it('no match is #N/A', () => {
    expect(calcErr('=FILTERXML("<a/>","//zzz")')).toBe('NA');
  });
  it('malformed XML is #VALUE!', () => {
    expect(calcErr('=FILTERXML("<a><b>foo</b>","//b")')).toBe('VALUE');
  });
  it('pure parser/evaluator agree with the formula path', () => {
    const doc = parseXml(xml);
    expect(evaluateXPath(doc, '//b')).toEqual(['foo', 'bar']);
    expect(filterXmlValues(xml, '//b')).toEqual(['foo', 'bar']);
  });
  it('spillFilterXml writes through the dynamic-arrays spill() helper', () => {
    const writes: Array<[number, number, unknown]> = [];
    const res = spillFilterXml(0, 0, xml, '//b', (r, c, v) => writes.push([r, c, v]));
    expect(res).toBe('ok');
    // anchor keeps the formula; only the second value is written
    expect(writes).toEqual([[1, 0, 'bar']]);
  });
  it('spillFilterXml reports #SPILL! when blocked', () => {
    const res = spillFilterXml(0, 0, xml, '//b',
      () => undefined,
      (r, c) => (r === 1 && c === 0 ? 'blocked' : undefined));
    expect(res).toBeInstanceOf(CellError);
    expect((res as CellError).type).toBe('SPILL');
  });
});

describe('FIELDVALUE', () => {
  it('FIELDVALUE("AAPL","price") is a number', () => {
    const v = calc('=FIELDVALUE("AAPL","price")');
    expect(typeof v).toBe('number');
    expect(v).toBe(258.4);
  });
  it('matching is case-insensitive', () => {
    expect(calc('=FIELDVALUE("aapl","Name")')).toBe('Apple Inc.');
  });
  it('field names ignore case/spacing', () => {
    expect(calc('=FIELDVALUE("AAPL","PE Ratio")')).toBe(38.2);
    expect(calc('=FIELDVALUE("AAPL","market_cap")')).toBe(3940000000000);
  });
  it('city data: Tokyo population and country', () => {
    expect(calc('=FIELDVALUE("Tokyo","population")')).toBe(13960000);
    expect(calc('=FIELDVALUE("Tokyo","country")')).toBe('Japan');
  });
  it('matches by full company name', () => {
    expect(calc('=FIELDVALUE("Tesla Inc.","price")')).toBe(342.6);
  });
  it('unknown field is an error (Excel: #FIELD!)', () => {
    expect(calcErr('=FIELDVALUE("AAPL","bogus")')).toBe('NA');
  });
  it('unknown entity is an error (Excel: #FIELD!)', () => {
    expect(calcErr('=FIELDVALUE("ZZZZ","price")')).toBe('NA');
  });
  it('a custom data provider overrides the bundled sample data', () => {
    setFieldValueDataProvider({
      findEntity: (value: string) =>
        value === 'X' ? { keys: ['x'], fields: { price: 42 } } : null,
    });
    try {
      expect(calc('=FIELDVALUE("X","price")')).toBe(42);
      expect(calcErr('=FIELDVALUE("AAPL","price")')).toBe('NA');
    } finally {
      resetFieldValueDataProvider();
    }
    expect(calc('=FIELDVALUE("AAPL","price")')).toBe(258.4);
  });
});
