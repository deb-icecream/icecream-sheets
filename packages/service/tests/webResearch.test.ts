/**
 * Web research contracts (Task A — internet data gathering):
 * service-boundary URL/bound helpers. The engine keeps no ambient
 * network; providers live server-side (gateway).
 */
import { describe, expect, it } from 'vitest';
import {
  WEB_RESEARCH_PROTOCOL_VERSION,
  DEFAULT_WEB_SEARCH_MAX_RESULTS,
  MAX_WEB_SEARCH_MAX_RESULTS,
  DEFAULT_WEB_PAGE_MAX_CHARS,
  MAX_WEB_PAGE_MAX_CHARS,
  boundedSearchResultCount,
  boundedWebPageChars,
  normalizePublicWebUrl,
  isObviouslyPrivateHost,
  normalizeWebSearchResults,
  cleanText,
  cleanWebText,
} from '../src/webResearch.js';
import { DEFAULT_ALLOWED_TOOLS, SYSTEM_PROMPT } from '../src/agent/openaiBackend.js';

describe('web research protocol constants', () => {
  it('pins the protocol version and bounds', () => {
    expect(WEB_RESEARCH_PROTOCOL_VERSION).toBe(1);
    expect(DEFAULT_WEB_SEARCH_MAX_RESULTS).toBe(8);
    expect(MAX_WEB_SEARCH_MAX_RESULTS).toBe(10);
    expect(DEFAULT_WEB_PAGE_MAX_CHARS).toBe(24000);
    expect(MAX_WEB_PAGE_MAX_CHARS).toBe(48000);
    expect(MAX_WEB_PAGE_MAX_CHARS).toBeGreaterThan(DEFAULT_WEB_PAGE_MAX_CHARS);
  });
});

describe('bounded helpers', () => {
  it('defaults search count to 8 and clamps to 1..10', () => {
    expect(boundedSearchResultCount(undefined)).toBe(8);
    expect(boundedSearchResultCount(0)).toBe(1);
    expect(boundedSearchResultCount(5)).toBe(5);
    expect(boundedSearchResultCount(99)).toBe(10);
  });
  it('defaults page chars to 24000 and clamps to 1..48000', () => {
    expect(boundedWebPageChars(undefined)).toBe(24000);
    expect(boundedWebPageChars(-3)).toBe(1);
    expect(boundedWebPageChars(1000)).toBe(1000);
    expect(boundedWebPageChars(10_000_000)).toBe(48000);
  });
});

describe('normalizePublicWebUrl', () => {
  it('accepts public HTTPS and strips the fragment', () => {
    expect(normalizePublicWebUrl('https://www.census.gov/pop#frag')).toBe(
      'https://www.census.gov/pop',
    );
  });
  it('rejects non-HTTPS, userinfo, and private hosts', () => {
    expect(() => normalizePublicWebUrl('http://www.census.gov/')).toThrow(/HTTPS/);
    expect(() => normalizePublicWebUrl('https://user:pass@example.com/')).toThrow(
      /credentials/,
    );
    expect(() => normalizePublicWebUrl('https://localhost/x')).toThrow(/private/);
    expect(() => normalizePublicWebUrl('https://192.168.1.5/x')).toThrow(/private/);
    expect(() => normalizePublicWebUrl('not a url')).toThrow();
  });
});

describe('isObviouslyPrivateHost', () => {
  it('flags loopback, RFC1918, link-local, and internal names', () => {
    for (const h of [
      'localhost',
      '127.0.0.1',
      '10.0.0.9',
      '192.168.0.1',
      '172.16.4.2',
      '169.254.9.9',
      'db.internal',
      'printer.local',
      'singlename',
    ]) {
      expect(isObviouslyPrivateHost(h)).toBe(true);
    }
    expect(isObviouslyPrivateHost('www.census.gov')).toBe(false);
  });
});

describe('normalizeWebSearchResults', () => {
  it('keeps public hits, drops private/non-https/missing fields', () => {
    const out = normalizeWebSearchResults([
      { title: 'Census', url: 'https://www.census.gov/pop', snippet: 'pop data', score: 0.9 },
      { title: 'Local', url: 'http://intranet/x', snippet: 's' },
      { title: 'Secret', url: 'https://192.168.1.5/x', snippet: 's' },
      { title: '', url: 'https://example.com/', snippet: 'no title' },
      { title: 'Desc', url: 'https://example.com/d', description: 'from description' },
      'junk',
    ]);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ title: 'Census', score: 0.9 });
    expect(out[1]).toMatchObject({ title: 'Desc', snippet: 'from description' });
  });
});

describe('cleanText / cleanWebText', () => {
  it('collapses whitespace and strips tags/scripts', () => {
    expect(cleanText('a  b\t\tc\n\n\n\nd')).toBe('a b c\n\nd');
    const cleaned = cleanWebText(
      '<html><head><style>.x{}</style><script>evil()</script></head><body><h1>Pop &amp; Growth</h1><p>1900&nbsp;76M</p></body></html>',
    );
    expect(cleaned).toContain('Pop & Growth');
    expect(cleaned).toContain('1900 76M');
    expect(cleaned).not.toContain('evil()');
    expect(cleaned).not.toContain('<h1>');
  });
});

describe('planner wiring for web research', () => {
  it('allowlist carries search_web + fetch_web_page (~23 tools)', () => {
    expect(DEFAULT_ALLOWED_TOOLS).toContain('search_web');
    expect(DEFAULT_ALLOWED_TOOLS).toContain('fetch_web_page');
    expect(DEFAULT_ALLOWED_TOOLS.length).toBeGreaterThanOrEqual(23);
  });
  it('SYSTEM_PROMPT teaches THREE-SOURCE scope with the web schemas', () => {
    expect(SYSTEM_PROMPT).toContain('THREE-SOURCE SCOPE');
    expect(SYSTEM_PROMPT).not.toContain('TWO-SOURCE SCOPE');
    expect(SYSTEM_PROMPT).toContain('search_web');
    expect(SYSTEM_PROMPT).toContain('fetch_web_page');
  });
});
