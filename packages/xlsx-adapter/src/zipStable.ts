/**
 * Deterministic re-zipping for the native XML injection helpers
 * (pageSetupXml, pageBreaksXml, protectionXml, macroProject).
 *
 * fflate's zipSync stamps every entry with the *current* time when no mtime
 * is given (DOS timestamps have 2-second granularity). A write → read →
 * write cycle then produces different bytes whenever that 2-second boundary
 * ticks over between the two writes — the injected XML is identical, but
 * the zip container headers differ, breaking byte-idempotency of
 * adapter.write(). All re-zip sites in this package therefore go through
 * zipSyncStable, which pins every entry to a fixed, spec-valid timestamp.
 */
import { zipSync, type Zippable } from 'fflate';

/**
 * Fixed zip entry timestamp (1980-01-02T00:00:00Z). fflate rejects years
 * outside 1980–2099 and formats the DOS timestamp in LOCAL time, so the
 * date sits a day past the DOS epoch to stay valid in every real timezone
 * (UTC−12 … UTC+14).
 */
export const ZIP_STABLE_MTIME = new Date(Date.UTC(1980, 0, 2));

/** zipSync with a fixed entry mtime so repeated writes are byte-identical. */
export function zipSyncStable(files: Zippable): Uint8Array {
  return zipSync(files, { mtime: ZIP_STABLE_MTIME });
}
