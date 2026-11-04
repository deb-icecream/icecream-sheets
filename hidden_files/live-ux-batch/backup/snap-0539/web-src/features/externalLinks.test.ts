import { describe, expect, it } from 'vitest';
import { parseExternalRef, findExternalRefs, ExternalLinkRegistry } from './externalLinks';

describe('parseExternalRef', () => {
  it('parses [1]Sheet!A1', () => {
    expect(parseExternalRef('=[1]Summary!B4')).toEqual({ index: 1, sheet: 'Summary', cell: 'B4' });
  });
  it('parses quoted sheet names', () => {
    expect(parseExternalRef("='[2]My Sheet'!A1")).toEqual({ index: 2, sheet: 'My Sheet', cell: 'A1' });
  });
  it('returns null for plain refs', () => {
    expect(parseExternalRef('=SUM(A1:A5)')).toBeNull();
  });
  it('finds multiple refs', () => {
    expect(findExternalRefs('=[1]A!A1+[2]B!C3')).toHaveLength(2);
  });
});

describe('ExternalLinkRegistry', () => {
  it('adds sources with incrementing indexes', () => {
    const r = new ExternalLinkRegistry();
    expect(r.addSource('a.xlsx')).toBe(1);
    expect(r.addSource('b.xlsx')).toBe(2);
  });
  it('resolves stored values', () => {
    const r = new ExternalLinkRegistry();
    const i = r.addSource('x.xlsx');
    r.setValue(i, 'Sheet1', 'A1', '42');
    expect(r.resolve({ index: i, sheet: 'Sheet1', cell: 'A1' })).toBe('42');
  });
  it('returns #REF! for missing source or cell', () => {
    const r = new ExternalLinkRegistry();
    expect(r.resolve({ index: 9, sheet: 'S', cell: 'A1' })).toBe('#REF!');
    const i = r.addSource('x.xlsx');
    expect(r.resolve({ index: i, sheet: 'S', cell: 'Z9' })).toBe('#REF!');
  });
  it('renames and removes sources', () => {
    const r = new ExternalLinkRegistry();
    const i = r.addSource('old.xlsx');
    r.rename(i, 'new.xlsx');
    expect(r.getSource(i)!.name).toBe('new.xlsx');
    expect(r.removeSource(i)).toBe(true);
    expect(r.getSource(i)).toBeUndefined();
  });
  it('throws when setting a value on an unknown source', () => {
    const r = new ExternalLinkRegistry();
    expect(() => r.setValue(7, 'S', 'A1', 'x')).toThrow('Unknown external source');
  });
});

describe('DDE links (transport impossible on web; syntax fully supported)', () => {
  // NOTE: per the decision documented in externalLinks.ts, the DDE *transport*
  // is Windows-IPC-only and cannot exist in this app. These tests cover the
  // supported surface: DDE *syntax* parsed into the external-link registry.
  const dde = () =>
    import('./externalLinks').then((m) => ({
      parseDDELink: m.parseDDELink,
      findDDELinks: m.findDDELinks,
      registerDDELinks: m.registerDDELinks,
      resolveDDELink: m.resolveDDELink,
      ExternalLinkRegistry: m.ExternalLinkRegistry,
    }));

  it('parseDDELink: parses =App|Topic!Item', async () => {
    const { parseDDELink } = await dde();
    expect(parseDDELink('=Bloomberg|MKT!AAPL')).toEqual({ app: 'Bloomberg', topic: 'MKT', item: 'AAPL' });
  });

  it('parseDDELink: parses App|Topic!Range', async () => {
    const { parseDDELink } = await dde();
    expect(parseDDELink('Excel|Sheet1!A1:B2')).toEqual({ app: 'Excel', topic: 'Sheet1', item: 'A1:B2' });
    expect(parseDDELink('Excel|Sheet1!$A$1')).toEqual({ app: 'Excel', topic: 'Sheet1', item: '$A$1' });
  });

  it('parseDDELink: rejects [n] external refs and garbage', async () => {
    const { parseDDELink } = await dde();
    expect(parseDDELink('=[1]Summary!B4')).toBeNull();
    expect(parseDDELink('=SUM(A1:A2)')).toBeNull();
    expect(parseDDELink('not a link')).toBeNull();
    expect(parseDDELink('=App|!Item')).toBeNull();
  });

  it('findDDELinks: finds multiple links in one formula', async () => {
    const { findDDELinks } = await dde();
    const links = findDDELinks('=Bloomberg|MKT!AAPL+Reuters|FX!EURUSD');
    expect(links).toHaveLength(2);
    expect(links[0]).toEqual({ app: 'Bloomberg', topic: 'MKT', item: 'AAPL' });
    expect(links[1]).toEqual({ app: 'Reuters', topic: 'FX', item: 'EURUSD' });
  });

  it('registerDDELinks: creates a DDE source in the registry (deduped)', async () => {
    const { registerDDELinks, ExternalLinkRegistry } = await dde();
    const r = new ExternalLinkRegistry();
    const links = registerDDELinks('=Bloomberg|MKT!AAPL', r);
    expect(links).toHaveLength(1);
    const src = r.findByName('DDE Bloomberg|MKT');
    expect(src).toBeDefined();
    // Registering again reuses the source rather than duplicating it.
    registerDDELinks('=Bloomberg|MKT!MSFT', r);
    expect(r.listSources().filter((s) => s.name === 'DDE Bloomberg|MKT')).toHaveLength(1);
  });

  it('resolveDDELink: resolves supplied values, #REF! otherwise', async () => {
    const { parseDDELink, registerDDELinks, resolveDDELink, ExternalLinkRegistry } = await dde();
    const r = new ExternalLinkRegistry();
    const [link] = registerDDELinks('=Bloomberg|MKT!AAPL', r);
    expect(resolveDDELink(link!, r)).toBe('#REF!');
    const src = r.findByName('DDE Bloomberg|MKT')!;
    r.setValue(src.index, 'MKT', 'AAPL', '232.87');
    expect(resolveDDELink(parseDDELink('=Bloomberg|MKT!AAPL')!, r)).toBe('232.87');
  });
});
