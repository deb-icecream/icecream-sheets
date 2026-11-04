/**
 * Workbook connections (xl/connections.xml) support for the XLSX adapter.
 *
 * Excel serializes data connections in xl/connections.xml. Two shapes
 * matter for the CUBE* functions:
 *
 * - Data-model connections (e.g. name="ThisWorkbookDataModel", a <dbPr>
 *   with command="Model" and/or an x15:connection with model="1"): the
 *   connection name that CUBEVALUE/CUBEMEMBER formulas reference. The
 *   model itself is not in the file (it lives in xl/model/item.data), so
 *   the host rebuilds a local OLAP cube from the source range instead.
 * - Range connections (e.g. name="WorksheetConnection_Sheet1!$A$1:$C$4",
 *   an x15:connection with id="Range" and an x15:rangePr whose sourceName
 *   points at a hidden _xlcn.* defined name): the worksheet range that
 *   feeds the model. The defined name resolves to an A1 ref such as
 *   "Data!$A$1:$C$4".
 *
 * Read: parse every <connection> into ImportedConnection records and stash
 * them in WorkbookData metadata under CONNECTIONS_METADATA_KEY. The web
 * app's open flow (features/cubeDataModels.ts) rebuilds a cube per
 * referenced connection via cubeFromPivot() + registerCube().
 *
 * Never throws: a missing/corrupt part yields [], never an error.
 */
import { strFromU8, unzipSync } from 'fflate';
import { decodeXmlEntities } from './externalLinks.js';

/** WorkbookData metadata key carrying the parsed connections. */
export const CONNECTIONS_METADATA_KEY = 'xlsx.connections';

export interface ImportedConnection {
  /** Connection name — the first argument of the CUBE* functions. */
  name: string;
  /**
   * True for data-model/OLAP connections (<dbPr command="Model">,
   * x15:connection model="1", <olapPr>, or type="5"). Their data is not
   * in the file; the host rebuilds the cube from a range connection.
   */
  isDataModel: boolean;
  /**
   * Resolved A1 range of a range connection, e.g. "Data!$A$1:$C$4".
   * Present only when the connection's x15:rangePr sourceName resolved
   * through a workbook defined name.
   */
  rangeRef?: string;
}

function textOf(data: Uint8Array | undefined): string | undefined {
  if (!data) return undefined;
  try {
    return strFromU8(data);
  } catch {
    return undefined;
  }
}

function attr(attrs: string, name: string): string | undefined {
  const m = new RegExp(`\\b${name}="([^"]*)"`).exec(attrs);
  return m ? decodeXmlEntities(m[1]!) : undefined;
}

/**
 * Parse xl/connections.xml from the package bytes. Returns [] when the
 * part is missing or unparseable. Connections that are neither data
 * models nor resolvable range connections are dropped — they carry no
 * data the host can rebuild a cube from.
 */
export function readConnections(
  buffer: Uint8Array,
  preunzipped?: Record<string, Uint8Array>,
): ImportedConnection[] {
  try {
    const files = (preunzipped ?? unzipSync(buffer.slice())) as Record<string, Uint8Array>;
    const xml = textOf(files['xl/connections.xml']);
    if (!xml) return [];
    // Hidden _xlcn.* defined names map a range connection's sourceName to
    // its A1 ref (e.g. _xlcn.WorksheetConnection_Sheet1A1C4 ->
    // "Data!$A$1:$C$4"). Parsed from xl/workbook.xml directly so this
    // module stays independent of the SheetJS defined-name pass.
    const definedRefs = new Map<string, string>();
    const wbXml = textOf(files['xl/workbook.xml']) ?? '';
    // Prefix-tolerant: ClosedXML writes <x:definedName>.
    const dnRe = /<(?:\w+:)?definedName\b([^>]*)>([^<]*)<\/(?:\w+:)?definedName>/g;
    let dn: RegExpExecArray | null;
    while ((dn = dnRe.exec(wbXml)) !== null) {
      const name = attr(dn[1] ?? '', 'name');
      if (name) definedRefs.set(name, decodeXmlEntities(dn[2] ?? '').trim());
    }
    const out: ImportedConnection[] = [];
    const connRe = /<connection\b([^>]*)>([\s\S]*?)<\/connection>/g;
    let m: RegExpExecArray | null;
    while ((m = connRe.exec(xml)) !== null) {
      const attrs = m[1] ?? '';
      const inner = m[2] ?? '';
      const name = attr(attrs, 'name');
      if (!name) continue;
      const dbPrCommand = /<dbPr\b[^>]*\bcommand="([^"]*)"/.exec(inner)?.[1];
      const x15 = /<x15:connection\b([^>]*?)(?:\/>|>)/.exec(inner)?.[1] ?? '';
      const x15Model = attr(x15, 'model');
      const isDataModel =
        attr(attrs, 'type') === '5' ||
        (dbPrCommand ?? '').toLowerCase() === 'model' ||
        x15Model === '1' ||
        /<olapPr\b/.test(inner);
      let rangeRef: string | undefined;
      const sourceName = /<x15:rangePr\b[^>]*\bsourceName="([^"]*)"/.exec(inner)?.[1];
      if (sourceName) {
        const ref = definedRefs.get(decodeXmlEntities(sourceName));
        if (ref) rangeRef = ref;
      }
      if (!isDataModel && !rangeRef) continue;
      out.push({ name, isDataModel, ...(rangeRef ? { rangeRef } : {}) });
    }
    // Fallback: a data model built from a worksheet range (ClosedXML
    // "CubeFromRange", Excel "Add this data to the Data Model") does not
    // always carry a range connection — the only trace of the source range
    // is the hidden _xlcn.* defined name. Synthesize a range connection
    // for each such name so hosts can rebuild the cube from the range.
    // Skipped when a real connection already resolves the same ref.
    const knownRefs = new Set(
      out.map((c) => c.rangeRef).filter((r): r is string => !!r),
    );
    for (const [name, ref] of definedRefs) {
      if (!/^_xlcn\./i.test(name) || !ref.includes('!')) continue;
      if (knownRefs.has(ref)) continue;
      out.push({ name, isDataModel: false, rangeRef: ref });
      knownRefs.add(ref);
    }
    return out;
  } catch {
    return [];
  }
}
