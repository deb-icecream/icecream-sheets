/**
 * Regression tests for rewriteDefinedNames string-literal handling.
 *
 * The old implementation skipped string literals with a naive
 * formula.split('"'), which breaks when a literal contains the ""
 * escape: ="say ""MyName"" hi" was tokenized so that MyName landed in a
 * "code" token and got clobbered. The fix scans with an inString flag and
 * treats "" inside a string as an escaped quote (string stays open).
 */
import { describe, expect, it } from 'vitest';
import { rewriteDefinedNames, type DefinedNameInfo } from '../src/names.js';

const NAMES: DefinedNameInfo[] = [{ name: 'MyName', ref: 'Sheet1!$A$1' }];

function rewrite(formula: string): string {
  return rewriteDefinedNames(formula, 'Sheet1', 0, ['Sheet1'], NAMES);
}

describe('rewriteDefinedNames string-literal boundaries', () => {
  it('rewrites a name used outside string literals', () => {
    expect(rewrite('=SUM(MyName)+1')).toBe('=SUM(Sheet1!$A$1)+1');
  });

  it('preserves a name inside a plain string literal', () => {
    expect(rewrite('="MyName is here"')).toBe('="MyName is here"');
  });

  it('preserves a name inside a string with "" escaped quotes', () => {
    // The regression: the name sits between two escaped quotes.
    expect(rewrite('="say ""MyName"" hi"')).toBe('="say ""MyName"" hi"');
  });

  it('rewrites outside the string but not inside the same formula', () => {
    expect(rewrite('="x ""MyName"" y"&MyName')).toBe(
      '="x ""MyName"" y"&Sheet1!$A$1',
    );
  });

  it('handles multiple strings and names interleaved', () => {
    expect(rewrite('=MyName&"a"&MyName&"b""c"&MyName')).toBe(
      '=Sheet1!$A$1&"a"&Sheet1!$A$1&"b""c"&Sheet1!$A$1',
    );
  });

  it('keeps a string open through consecutive escaped quotes', () => {
    // "a""""MyName""" is one literal: a" + "MyName" + " — the name is
    // inside the string the whole time.
    expect(rewrite('="a""""MyName"""')).toBe('="a""""MyName"""');
  });

  it('treats a name after an unterminated string as string text', () => {
    // Excel strings run to end of formula when the quote never closes.
    expect(rewrite('="abc&MyName')).toBe('="abc&MyName');
    expect(rewrite('=MyName&"def')).toBe('=Sheet1!$A$1&"def');
  });

  it('rewrites a name adjacent to string boundaries', () => {
    expect(rewrite('=MyName&""&MyName')).toBe('=Sheet1!$A$1&""&Sheet1!$A$1');
  });

  it('is case-insensitive for names outside strings', () => {
    expect(rewrite('=myname+MYNAME')).toBe('=Sheet1!$A$1+Sheet1!$A$1');
  });

  it('returns the formula unchanged when there are no names', () => {
    expect(rewriteDefinedNames('=1+1', 'Sheet1', 0, ['Sheet1'], [])).toBe('=1+1');
  });
});
