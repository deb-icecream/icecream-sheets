/** Cycle 10 Phase 2: JSON wire encoding for adapter output (metadata + formats). */
import { describe, expect, it } from 'vitest';
import {
  decodeFormatsWire,
  decodeFromJson,
  decodeMetadataFromJson,
  encodeFormatsRecord,
  encodeForJson,
  encodeMetadataForJson,
} from '../src/metadataJson.js';

describe('encodeForJson / decodeFromJson', () => {
  it('round-trips Uint8Array nested inside metadata (pivot/smartart raw parts)', () => {
    const raw = new Uint8Array([0, 1, 2, 255, 254]);
    const meta = {
      'xlsx.pivotParts': { tables: ['a'], parts: { 'xl/pivotCache/1.xml': raw } },
      'icecream.charts': '[]',
      n: 42,
    };
    const wire = encodeMetadataForJson(meta);
    // The wire form is JSON-safe: no raw bytes survive stringify.
    const json = JSON.stringify(wire);
    const restored = decodeMetadataFromJson(JSON.parse(json));
    const back = (restored['xlsx.pivotParts'] as { parts: Record<string, Uint8Array> }).parts[
      'xl/pivotCache/1.xml'
    ];
    expect(back).toBeInstanceOf(Uint8Array);
    expect([...back]).toEqual([0, 1, 2, 255, 254]);
    expect(restored['icecream.charts']).toBe('[]');
    expect(restored['n']).toBe(42);
  });

  it('round-trips multi-MB parts (522KB real pivot part shape)', () => {
    const raw = new Uint8Array(522_403);
    raw[0] = 7;
    raw[raw.length - 1] = 9;
    const back = decodeFromJson(JSON.parse(JSON.stringify(encodeForJson(raw)))) as Uint8Array;
    expect(back).toBeInstanceOf(Uint8Array);
    expect(back.length).toBe(522_403);
    expect(back[0]).toBe(7);
    expect(back[back.length - 1]).toBe(9);
  });

  it('leaves JSON-clean values untouched', () => {
    const v = { a: [1, 'x', null, true], b: { c: 3.5 } };
    expect(decodeFromJson(JSON.parse(JSON.stringify(encodeForJson(v))))).toEqual(v);
  });
});

describe('formats run-length wire encoding', () => {
  it('collapses whole-column formats into runs and restores the record exactly', () => {
    const formats: Record<string, string> = {};
    for (let r = 0; r < 60000; r++) formats[`${r}:3`] = '#,##0.00';
    for (let r = 0; r < 60000; r++) formats[`${r}:4`] = '0.00%';
    formats['7:9'] = '@';
    const wire = encodeFormatsRecord(formats);
    expect(wire.codes).toContain('#,##0.00');
    // Two full columns collapse to two runs + one singleton.
    expect(wire.columns['3']).toEqual([[0, 59999, wire.codes.indexOf('#,##0.00')]]);
    expect(decodeFormatsWire(JSON.parse(JSON.stringify(wire)))).toEqual(formats);
  });

  it('round-trips scattered (checkerboard) formats', () => {
    const formats: Record<string, string> = {};
    for (let i = 0; i < 200; i++) formats[`${i * 3}:${i * 2}`] = '0';
    expect(decodeFormatsWire(encodeFormatsRecord(formats))).toEqual(formats);
  });

  it('skips malformed entries and returns undefined for empty records', () => {
    const wire = encodeFormatsRecord({ 'x:1': '0', '-1:2': '0', '3': '0' } as Record<string, string>);
    expect(wire.columns).toEqual({});
    expect(decodeFormatsWire(undefined)).toBeUndefined();
    expect(decodeFormatsWire({ codes: [], columns: {} })).toBeUndefined();
  });
});
