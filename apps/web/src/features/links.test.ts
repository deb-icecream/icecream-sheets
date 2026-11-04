/**
 * Unit tests for the hyperlink store.
 */
import { describe, expect, it } from 'vitest';
import {
  clearHyperlinksInRange,
  getHyperlink,
  hyperlinkKey,
  hyperlinksInRange,
  linkDestination,
  removeHyperlink,
  setHyperlink,
  validateLinkTarget,
  type HyperlinkStore,
} from './links';

const URL_LINK = { target: { kind: 'url' as const, url: 'https://example.com' } };

describe('hyperlinkKey / getHyperlink / setHyperlink', () => {
  it('round-trips a hyperlink', () => {
    const store = setHyperlink(new Map(), 'Sheet1', 0, 0, URL_LINK);
    expect(getHyperlink(store, 'Sheet1', 0, 0)).toEqual(URL_LINK);
    expect(getHyperlink(store, 'Sheet1', 0, 1)).toBeUndefined();
  });

  it('does not mutate the input store', () => {
    const store: HyperlinkStore = new Map();
    setHyperlink(store, 'Sheet1', 0, 0, URL_LINK);
    expect(store.size).toBe(0);
  });

  it('keys are sheet-qualified', () => {
    expect(hyperlinkKey('Sheet1', 1, 2)).toBe('Sheet1:1:2');
    const store = setHyperlink(new Map(), 'Sheet1', 0, 0, URL_LINK);
    expect(getHyperlink(store, 'Sheet2', 0, 0)).toBeUndefined();
  });
});

describe('removeHyperlink', () => {
  it('removes the link', () => {
    const store = setHyperlink(new Map(), 'Sheet1', 0, 0, URL_LINK);
    const next = removeHyperlink(store, 'Sheet1', 0, 0);
    expect(getHyperlink(next, 'Sheet1', 0, 0)).toBeUndefined();
    expect(getHyperlink(store, 'Sheet1', 0, 0)).toEqual(URL_LINK);
  });
});

describe('hyperlinksInRange / clearHyperlinksInRange', () => {
  const range = { startRow: 0, startCol: 0, endRow: 1, endCol: 1 };
  const store = setHyperlink(
    setHyperlink(new Map(), 'Sheet1', 0, 0, URL_LINK),
    'Sheet1', 5, 5, { target: { kind: 'email', email: 'a@b.c' } },
  );

  it('lists links inside the range only', () => {
    const found = hyperlinksInRange(store, 'Sheet1', range);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ row: 0, col: 0 });
  });

  it('clears links inside the range only', () => {
    const next = clearHyperlinksInRange(store, 'Sheet1', range);
    expect(getHyperlink(next, 'Sheet1', 0, 0)).toBeUndefined();
    expect(getHyperlink(next, 'Sheet1', 5, 5)).toBeDefined();
  });
});

describe('linkDestination', () => {
  it('formats url, email, and place destinations', () => {
    expect(linkDestination(URL_LINK)).toBe('https://example.com');
    expect(linkDestination({ target: { kind: 'email', email: 'a@b.c' } })).toBe('mailto:a@b.c');
    expect(linkDestination({ target: { kind: 'place', sheet: 'S2', ref: 'B3' } })).toBe('S2!B3');
  });
});

describe('validateLinkTarget', () => {
  it('requires http(s) for urls', () => {
    expect(validateLinkTarget({ kind: 'url', url: 'example.com' })).not.toBeNull();
    expect(validateLinkTarget({ kind: 'url', url: 'https://example.com' })).toBeNull();
  });

  it('validates email shape', () => {
    expect(validateLinkTarget({ kind: 'email', email: 'nope' })).not.toBeNull();
    expect(validateLinkTarget({ kind: 'email', email: 'a@b.c' })).toBeNull();
  });

  it('requires a ref for places', () => {
    expect(validateLinkTarget({ kind: 'place', sheet: 'S1', ref: '  ' })).not.toBeNull();
    expect(validateLinkTarget({ kind: 'place', sheet: 'S1', ref: 'A1' })).toBeNull();
  });
});
