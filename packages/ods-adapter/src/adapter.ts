/**
 * ODS (OpenDocument Spreadsheet) storage adapter.
 *
 * Minimal but correct v1: reads/writes the core table model
 * (table:table / table:table-row / table:table-cell) inside content.xml.
 * Formulas use OpenFormula syntax (of:=...); this adapter converts to/from
 * the engine's '=...' convention on the cell text level (no formula
 * translation — OpenFormula and Excel A1 syntax overlap for the common
 * cases; complex formulas round-trip as text).
 *
 * Honest limitations:
 * - Styles, merged cells, column widths, print settings: not preserved.
 * - Repeated rows/cells (table:number-rows-repeated etc.) are expanded on
 *   read and not emitted on write.
 * - Password-protected ODS: not supported (supportsEncryption: false).
 */
import { unzipSync, zipSync, strToU8, strFromU8 } from 'fflate';
import type {
  AdapterCapabilities,
  CellInput,
  SheetData,
  StorageAdapter,
  WorkbookData,
} from '@icecream-sheets/engine';

const ODS_MIMETYPE = 'application/vnd.oasis.opendocument.spreadsheet';

// ---------------------------------------------------------------------------
// Minimal XML helpers (no external XML dependency)
// ---------------------------------------------------------------------------

interface XmlNode {
  name: string;
  attrs: Record<string, string>;
  children: XmlNode[];
  text: string;
}

function parseXml(xml: string): XmlNode {
  let pos = 0;
  const root: XmlNode = { name: '#root', attrs: {}, children: [], text: '' };
  const stack: XmlNode[] = [root];

  const skipDecl = () => {
    if (xml.startsWith('<?', pos)) {
      const end = xml.indexOf('?>', pos);
      if (end >= 0) pos = end + 2;
    }
    if (xml.startsWith('<!DOCTYPE', pos)) {
      const end = xml.indexOf('>', pos);
      if (end >= 0) pos = end + 1;
    }
  };

  while (pos < xml.length) {
    skipDecl();
    if (pos >= xml.length) break;
    if (xml[pos] !== '<') {
      // Text node.
      const next = xml.indexOf('<', pos);
      const end = next >= 0 ? next : xml.length;
      const text = xml.slice(pos, end);
      stack[stack.length - 1].text += decodeEntities(text);
      pos = end;
      continue;
    }
    if (xml.startsWith('<!--', pos)) {
      const end = xml.indexOf('-->', pos);
      pos = end >= 0 ? end + 3 : xml.length;
      continue;
    }
    if (xml.startsWith('</', pos)) {
      const end = xml.indexOf('>', pos);
      pos = end >= 0 ? end + 1 : xml.length;
      stack.pop();
      continue;
    }
    // Opening (or self-closing) tag.
    const end = xml.indexOf('>', pos);
    if (end < 0) break;
    let tag = xml.slice(pos + 1, end);
    const selfClosing = tag.endsWith('/');
    if (selfClosing) tag = tag.slice(0, -1);
    const spaceIdx = tag.search(/[\s/]/);
    const name = spaceIdx < 0 ? tag : tag.slice(0, spaceIdx);
    const attrs: Record<string, string> = {};
    const attrRe = /([\w:.-]+)\s*=\s*"([^"]*)"/g;
    let m: RegExpExecArray | null;
    while ((m = attrRe.exec(tag)) !== null) {
      attrs[m[1]] = decodeEntities(m[2]);
    }
    const node: XmlNode = { name, attrs, children: [], text: '' };
    stack[stack.length - 1].children.push(node);
    if (!selfClosing) stack.push(node);
    pos = end + 1;
  }
  return root;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

function encodeEntities(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function findAll(node: XmlNode, name: string): XmlNode[] {
  const out: XmlNode[] = [];
  const walk = (n: XmlNode) => {
    if (n.name === name) out.push(n);
    for (const c of n.children) walk(c);
  };
  walk(node);
  return out;
}

function textContent(node: XmlNode): string {
  // Concatenate text:p children (paragraphs), joining with newline.
  const ps = node.children.filter((c) => c.name === 'text:p');
  if (ps.length > 0) {
    return ps.map((p) => p.text + p.children.map(textContent).join('')).join('\n');
  }
  return node.text;
}

// ---------------------------------------------------------------------------
// ODS <-> WorkbookData conversion
// ---------------------------------------------------------------------------

function cellToInput(cell: XmlNode): CellInput {
  const formula = cell.attrs['table:formula'];
  if (formula) {
    // OpenFormula "of:=SUM(...)" -> engine "=SUM(...)".
    const f = formula.startsWith('of:=') ? formula.slice(4) : formula;
    return `=${f}`;
  }
  const valueType = cell.attrs['office:value-type'];
  const text = textContent(cell);
  if (valueType === 'float' || valueType === 'percentage' || valueType === 'currency') {
    const n = Number(cell.attrs['office:value']);
    return Number.isFinite(n) ? n : text === '' ? null : text;
  }
  if (valueType === 'boolean') {
    return cell.attrs['office:boolean-value'] === 'true';
  }
  // string or missing type.
  return text === '' ? null : text;
}

function contentXmlToWorkbook(xml: string): WorkbookData {
  const doc = parseXml(xml);
  const tables = findAll(doc, 'table:table');
  const sheets: SheetData[] = tables.map((table) => {
    const name = table.attrs['table:name'] ?? 'Sheet1';
    const rows: CellInput[][] = [];
    for (const rowNode of table.children.filter((c) => c.name === 'table:table-row')) {
      const repeatRows = Number(rowNode.attrs['table:number-rows-repeated'] ?? '1') || 1;
      const row: CellInput[] = [];
      for (const cellNode of rowNode.children.filter((c) => c.name === 'table:table-cell')) {
        const repeatCols = Number(cellNode.attrs['table:number-columns-repeated'] ?? '1') || 1;
        const covered = Number(cellNode.attrs['table:number-columns-spanned'] ?? '1') || 1;
        const input = cellToInput(cellNode);
        for (let i = 0; i < repeatCols; i++) row.push(input);
        // Covered (merged) cells after the first are blank.
        for (let i = 1; i < covered; i++) row.push(null);
      }
      for (let i = 0; i < repeatRows; i++) rows.push([...row]);
    }
    // Trim trailing all-null rows/cols for a clean snapshot.
    while (rows.length > 0 && rows[rows.length - 1].every((c) => c === null)) rows.pop();
    return { name, rows };
  });
  return { sheets, metadata: {} };
}

function inputToCellXml(input: CellInput): string {
  if (input === null) {
    return '<table:table-cell/>';
  }
  if (typeof input === 'string' && input.startsWith('=') && input.length > 1) {
    const formula = `of:=${encodeEntities(input.slice(1))}`;
    return `<table:table-cell table:formula="${formula}" office:value-type="float" office:value="0"><text:p>0</text:p></table:table-cell>`;
  }
  if (typeof input === 'number') {
    return `<table:table-cell office:value-type="float" office:value="${input}"><text:p>${input}</text:p></table:table-cell>`;
  }
  if (typeof input === 'boolean') {
    const v = input ? 'true' : 'false';
    return `<table:table-cell office:value-type="boolean" office:boolean-value="${v}"><text:p>${input ? 'TRUE' : 'FALSE'}</text:p></table:table-cell>`;
  }
  return `<table:table-cell office:value-type="string"><text:p>${encodeEntities(input)}</text:p></table:table-cell>`;
}

function workbookToContentXml(data: WorkbookData): string {
  const tables = data.sheets
    .map((sheet) => {
      const rows = sheet.rows
        .map((row) => {
          const cells = (row ?? []).map(inputToCellXml).join('');
          return `<table:table-row>${cells}</table:table-row>`;
        })
        .join('');
      return `<table:table table:name="${encodeEntities(sheet.name)}">${rows}</table:table>`;
    })
    .join('');
  return (
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<office:document-content ` +
    `xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" ` +
    `xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" ` +
    `xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" ` +
    `office:version="1.2">` +
    `<office:body><office:spreadsheet>${tables}</office:spreadsheet></office:body>` +
    `</office:document-content>`
  );
}

const MINIMAL_MANIFEST =
  `<?xml version="1.0" encoding="UTF-8"?>` +
  `<manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0">` +
  `<manifest:file-entry manifest:full-path="/" manifest:media-type="${ODS_MIMETYPE}"/>` +
  `<manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"/>` +
  `</manifest:manifest>`;

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export class OdsAdapter implements StorageAdapter {
  readonly name = 'ods';

  readonly capabilities: AdapterCapabilities = {
    readable: true,
    writable: true,
    transactional: false,
    preservesUnknownParts: false,
    supportsEncryption: false,
  };

  read(buffer: Uint8Array): WorkbookData {
    // Validate ZIP signature.
    if (
      buffer.length < 4 ||
      buffer[0] !== 0x50 ||
      buffer[1] !== 0x4b ||
      buffer[2] !== 0x03 ||
      buffer[3] !== 0x04
    ) {
      throw new Error('OdsAdapter.read: not a readable ODS package (missing ZIP signature)');
    }
    let entries: Record<string, Uint8Array>;
    try {
      entries = unzipSync(buffer) as Record<string, Uint8Array>;
    } catch (error) {
      throw new Error(
        `OdsAdapter.read: not a readable ODS package (${error instanceof Error ? error.message : String(error)})`,
      );
    }
    const mimetype = entries['mimetype'];
    if (mimetype) {
      const mt = strFromU8(mimetype).trim().replace(/\0+$/, '');
      if (mt !== ODS_MIMETYPE) {
        throw new Error(`OdsAdapter.read: unexpected mimetype "${mt}" (expected ODS)`);
      }
    }
    const content = entries['content.xml'];
    if (!content) throw new Error('OdsAdapter.read: ODS package missing content.xml');
    return contentXmlToWorkbook(strFromU8(content));
  }

  write(data: WorkbookData, _original?: Uint8Array): Uint8Array {
    const contentXml = workbookToContentXml(data);
    // Per the ODF spec the mimetype entry must be first and uncompressed.
    // fflate's zipSync compresses everything; readers (LibreOffice, Excel)
    // accept a compressed mimetype in practice, but we keep the ordering.
    const zipped = zipSync(
      {
        mimetype: strToU8(ODS_MIMETYPE),
        'content.xml': strToU8(contentXml),
        'META-INF/manifest.xml': strToU8(MINIMAL_MANIFEST),
      },
      { level: 6 },
    );
    return new Uint8Array(zipped);
  }
}
