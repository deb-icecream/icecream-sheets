/**
 * BIFF12 record primitives for the .xlsb adapter.
 *
 * Layouts follow the empirical, battle-tested parsing of the pyxlsb library
 * (the de-facto Python .xlsb reader, used by pandas): record headers are a
 * little-endian id (bytes accumulate until one has its high bit clear) plus
 * a 7-bit varint length; cell records carry col/style/value (the row comes
 * from the enclosing BrtRowHdr); strings are u32 char-count + UTF-16LE.
 *
 * One deviation is documented inline: BrtBundleSh (sheet directory entries)
 * carry a second u32 between the tab id and the relationship id — pyxlsb
 * demonstrably parses real Excel files this way, so we mirror it.
 */

// -- Record type ids (workbook / worksheet / SST / styles) --------------------

export const RT = {
  // Row / cell records
  RowHdr: 0x0000,
  CellBlank: 0x0001,
  CellRk: 0x0002,
  CellError: 0x0003,
  CellBool: 0x0004,
  CellReal: 0x0005,
  // 0x0006 = BrtCellSt: INLINE string (col+style+cch+UTF-16 chars).
  // 0x0007 = BrtCellIsst: SST index (col+style+u32 isst) — this is what
  // Excel writes for shared strings, verified by pyxlsb's parser.
  CellSt: 0x0006, // inline string
  CellIsst: 0x0007, // shared-string table index
  FmlaString: 0x0008,
  FmlaNum: 0x0009,
  FmlaBool: 0x000a,
  FmlaError: 0x000b,
  // Worksheet part (ids verified against pyxlsb's record table)
  BeginSheet: 0x0181,
  EndSheet: 0x0182,
  // BrtWsDim: pyxlsb-verified as 0x0194 (not 0x008f).
  WsDim: 0x0194,
  BeginSheetData: 0x0191,
  EndSheetData: 0x0192,
  // Workbook part
  BeginBook: 0x0183,
  EndBook: 0x0184,
  FileVersion: 0x0180,
  BeginBundleShs: 0x018f,
  EndBundleShs: 0x0190,
  BundleSh: 0x019c,
  // Shared strings part
  BeginSst: 0x019f,
  EndSst: 0x01a0,
  SstItem: 0x0013,
  // Styles part
  BeginStyleSheet: 0x0296,
  EndStyleSheet: 0x0297,
  BeginFonts: 0x04e3,
  EndFonts: 0x04e4,
  Font: 0x002b,
  BeginFills: 0x04db,
  EndFills: 0x04dc,
  Fill: 0x002d,
  BeginBorders: 0x04e5,
  EndBorders: 0x04e6,
  Border: 0x002e,
  BeginCellStyleXfs: 0x04f2,
  EndCellStyleXfs: 0x04f3,
  BeginCellXfs: 0x04e9,
  EndCellXfs: 0x04ea,
  Xf: 0x002f,
  BeginCellStyles: 0x04eb,
  EndCellStyles: 0x04ec,
  CellStyle: 0x0030,
  // NOTE: the BrtNumFmt family is intentionally absent — neither pyxlsb nor
  // pyxlsb2 documents those record ids, and emitting guessed ids risks
  // colliding with real record types. styles.bin is written with a valid
  // minimal structure; number formats are not preserved (documented).
} as const;

/** BIFF error byte -> Excel error text. */
export const BIFF_ERRORS: Record<number, string> = {
  0x00: '#NULL!',
  0x07: '#DIV/0!',
  0x0f: '#VALUE!',
  0x17: '#REF!',
  0x1d: '#NAME?',
  0x24: '#NUM!',
  0x2a: '#N/A',
  0x2b: '#GETTING_DATA',
};

export function errorText(code: number): string {
  return BIFF_ERRORS[code] ?? '#VALUE!';
}

export function errorCode(text: string): number {
  for (const [code, name] of Object.entries(BIFF_ERRORS)) {
    if (name === text) return Number(code);
  }
  return 0x0f; // #VALUE!
}

// -- Record header encoding ---------------------------------------------------

/**
 * Encode a record id. BIFF12 ids are little-endian bytes; the decoder adds
 * each raw byte (high bit included) and stops at the first byte with the
 * high bit clear. So every byte but the last must have its high bit set —
 * which means ids like 0x100-0x17F are unrepresentable (MS-XLSB simply
 * never assigned them). All ids this adapter uses are encodable.
 */
export function encodeId(id: number): number[] {
  if (!Number.isInteger(id) || id < 0) throw new Error('xlsb: bad record id');
  if (id < 0x80) return [id];
  const out: number[] = [];
  let v = id;
  for (;;) {
    if (v < 0x80) {
      out.push(v);
      return out;
    }
    const b = (v & 0x7f) | 0x80;
    const rest = (v - b) / 256;
    if (!Number.isInteger(rest) || rest < 0) {
      throw new Error(`xlsb: record id 0x${id.toString(16)} is not BIFF12-encodable`);
    }
    out.push(b);
    v = rest;
  }
}

/** Encode a record length as a 7-bit varint. */
export function encodeLen(len: number): number[] {
  const out: number[] = [];
  let v = len;
  while (v >= 0x80) {
    out.push(0x80 | (v & 0x7f));
    v >>>= 7;
  }
  out.push(v & 0x7f);
  return out;
}

/** Wrap a payload in a BIFF12 record header. */
export function record(type: number, payload: Uint8Array): Uint8Array {
  const head = [...encodeId(type), ...encodeLen(payload.length)];
  const out = new Uint8Array(head.length + payload.length);
  out.set(head, 0);
  out.set(payload, head.length);
  return out;
}

export interface RawRecord {
  type: number;
  payload: Uint8Array;
}

/** Split a BIFF12 part into records. Throws on truncation. */
export function parseRecords(buf: Uint8Array): RawRecord[] {
  const out: RawRecord[] = [];
  let p = 0;
  const readId = (): number => {
    let v = 0;
    let shift = 0;
    for (let i = 0; i < 4; i++) {
      if (p >= buf.length) throw new Error('xlsb: truncated record id');
      const b = buf[p++];
      v += b << shift;
      shift += 8;
      if ((b & 0x80) === 0) return v;
    }
    throw new Error('xlsb: record id too long');
  };
  const readLen = (): number => {
    let v = 0;
    for (let i = 0; i < 4; i++) {
      if (p >= buf.length) throw new Error('xlsb: truncated record length');
      const b = buf[p++];
      v += (b & 0x7f) << (7 * i);
      if ((b & 0x80) === 0) return v;
    }
    throw new Error('xlsb: record length too long');
  };
  while (p < buf.length) {
    const type = readId();
    const len = readLen();
    if (p + len > buf.length) throw new Error(`xlsb: record 0x${type.toString(16)} truncated (need ${len})`);
    out.push({ type, payload: buf.slice(p, p + len) });
    p += len;
  }
  return out;
}

// -- Little-endian reader ------------------------------------------------------

export class Reader {
  private p = 0;
  constructor(private readonly buf: Uint8Array) {}

  get pos(): number {
    return this.p;
  }

  get remaining(): number {
    return this.buf.length - this.p;
  }

  u8(): number {
    if (this.p + 1 > this.buf.length) throw new Error('xlsb: unexpected end of record');
    return this.buf[this.p++];
  }

  u16(): number {
    if (this.p + 2 > this.buf.length) throw new Error('xlsb: unexpected end of record');
    const v = this.buf[this.p] | (this.buf[this.p + 1] << 8);
    this.p += 2;
    return v;
  }

  u32(): number {
    if (this.p + 4 > this.buf.length) throw new Error('xlsb: unexpected end of record');
    const v =
      this.buf[this.p] |
      (this.buf[this.p + 1] << 8) |
      (this.buf[this.p + 2] << 16) |
      (this.buf[this.p + 3] * 0x1000000);
    this.p += 4;
    return v >>> 0;
  }

  f64(): number {
    if (this.p + 8 > this.buf.length) throw new Error('xlsb: unexpected end of record');
    const v = new DataView(this.buf.buffer, this.buf.byteOffset + this.p, 8).getFloat64(0, true);
    this.p += 8;
    return v;
  }

  /** BIFF12 string: u32 char count + UTF-16LE. */
  str(): string {
    const cch = this.u32();
    if (this.p + cch * 2 > this.buf.length) throw new Error('xlsb: truncated string');
    const bytes = this.buf.slice(this.p, this.p + cch * 2);
    this.p += cch * 2;
    return new TextDecoder('utf-16le').decode(bytes);
  }

  skip(n: number): void {
    if (this.p + n > this.buf.length) throw new Error('xlsb: skip past end of record');
    this.p += n;
  }
}

// -- Little-endian writer -------------------------------------------------------

export class Writer {
  private parts: Uint8Array[] = [];

  u8(v: number): this {
    this.parts.push(new Uint8Array([v & 0xff]));
    return this;
  }

  u16(v: number): this {
    this.parts.push(new Uint8Array([v & 0xff, (v >>> 8) & 0xff]));
    return this;
  }

  u32(v: number): this {
    this.parts.push(
      new Uint8Array([v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff]),
    );
    return this;
  }

  f64(v: number): this {
    const b = new Uint8Array(8);
    new DataView(b.buffer).setFloat64(0, v, true);
    this.parts.push(b);
    return this;
  }

  /** BIFF12 string: u32 char count + UTF-16LE. */
  str(s: string): this {
    // Encode as UTF-16LE manually (charCodeAt units) to avoid depending on
    // TextEncoder('utf-16le') availability.
    const utf16 = new Uint8Array(s.length * 2);
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      utf16[i * 2] = c & 0xff;
      utf16[i * 2 + 1] = (c >>> 8) & 0xff;
    }
    this.u32(s.length);
    this.parts.push(utf16);
    return this;
  }

  bytes(b: Uint8Array): this {
    this.parts.push(b);
    return this;
  }

  build(): Uint8Array {
    let total = 0;
    for (const p of this.parts) total += p.length;
    const out = new Uint8Array(total);
    let o = 0;
    for (const p of this.parts) {
      out.set(p, o);
      o += p.length;
    }
    return out;
  }
}

/** Decode an RK number (BrtCellRk) per the BIFF12 RK encoding. */
export function decodeRk(intval: number): number {
  let v: number;
  if (intval & 0x02) {
    v = intval >> 2; // 30-bit signed int (>> is arithmetic)
  } else {
    const b = new Uint8Array(8);
    const u = intval & 0xfffffffc;
    b[0] = 0; b[1] = 0; b[2] = 0; b[3] = 0;
    b[4] = u & 0xff; b[5] = (u >>> 8) & 0xff; b[6] = (u >>> 16) & 0xff; b[7] = (u >>> 24) & 0xff;
    v = new DataView(b.buffer).getFloat64(0, true);
  }
  if (intval & 0x01) v /= 100;
  return v;
}
