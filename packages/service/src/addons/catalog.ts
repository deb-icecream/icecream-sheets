/**
 * Product-owned add-on catalog.
 *
 * Per design-docs/add-on-model.md §6: "Get add-ons opens the product-owned
 * catalog. Listings show the declared capabilities, the publisher and the
 * permission footprint. There is no sideloading outside the catalog in v1."
 *
 * The registry only installs manifests that exist in this catalog unless
 * the caller explicitly opts into sideloading (tests/dev).
 */

import { validateManifest, type AddonManifest } from './manifest.js';

export interface AddonListing {
  manifest: AddonManifest;
  publisher: string;
  publisherUrl?: string;
  /**
   * v1 distribution: the catalog carries the add-on's JS source. In a
   * deployed service this would be fetched from the catalog service;
   * here the product-owned catalog is seeded in-process.
   */
  code: string;
  listedAt: string;
}

export class CatalogError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CatalogError';
  }
}

export class AddonCatalog {
  private readonly listings = new Map<string, AddonListing[]>();

  /** Seed one listing. Validates the manifest; keeps versions sorted. */
  addListing(listing: AddonListing): void {
    const v = validateManifest(listing.manifest);
    if (!v.ok) throw new CatalogError(`invalid listing manifest: ${v.errors.join('; ')}`);
    if (typeof listing.code !== 'string' || listing.code.length === 0) {
      throw new CatalogError('listing code must be a non-empty string');
    }
    const arr = this.listings.get(v.manifest.id) ?? [];
    if (arr.some((l) => l.manifest.version === v.manifest.version)) {
      throw new CatalogError(
        `duplicate listing ${v.manifest.id}@${v.manifest.version}`,
      );
    }
    arr.push({ ...listing, manifest: v.manifest });
    arr.sort((a, b) => (a.manifest.version < b.manifest.version ? -1 : 1));
    this.listings.set(v.manifest.id, arr);
  }

  /** Latest listing per add-on id. */
  list(): AddonListing[] {
    return [...this.listings.values()].map((arr) => arr[arr.length - 1]);
  }

  /** All versions of one add-on, oldest first. */
  versions(id: string): AddonListing[] {
    return [...(this.listings.get(id) ?? [])];
  }

  get(id: string, version?: string): AddonListing | undefined {
    const arr = this.listings.get(id);
    if (!arr || arr.length === 0) return undefined;
    if (version === undefined) return arr[arr.length - 1];
    return arr.find((l) => l.manifest.version === version);
  }

  has(id: string, version: string): boolean {
    return this.get(id, version) !== undefined;
  }

  get size(): number {
    return this.listings.size;
  }
}

// ---------------------------------------------------------------------------
// Seed catalog (v1)
// ---------------------------------------------------------------------------

const SUM_REPORTER_CODE = `// Sample add-on: sums a rectangular range and returns a small report.
function main(args) {
  const ref = args && args.ref ? args.ref : { sheet: 'Sheet1', startRow: 0, startCol: 0, endRow: 9, endCol: 0 };
  const values = addon.sheets.getRange(ref);
  let sum = 0;
  let count = 0;
  for (const row of values) {
    for (const v of row) {
      if (typeof v === 'number') { sum += v; count += 1; }
    }
  }
  addon.log('summed ' + count + ' numeric cells');
  return { sum: sum, count: count };
}
`;

const CELL_STAMPER_CODE = `// Sample add-on: writes a marker value into a single cell (needs write).
function main(args) {
  const ref = args && args.ref ? args.ref : { sheet: 'Sheet1', row: 0, col: 0 };
  const before = addon.sheets.getCell(ref);
  addon.sheets.setCell(ref, args && args.value !== undefined ? args.value : 'stamped');
  return { before: before, sheet: ref.sheet, row: ref.row, col: ref.col };
}
`;

/** Seed the product-owned catalog with sample add-ons for v1.
 *
 * RESOLVED 2026-10-18 (add-on-model.md): catalog listings always carry a
 * signature. The two seed manifests below are signed with the product
 * catalog Ed25519 key (public key in production.ts); the signatures cover
 * the canonical manifest JSON + NUL + code bytes, exactly as the registry
 * verifier checks at install time.
 */
export function createSeedCatalog(): AddonCatalog {
  const catalog = new AddonCatalog();
  catalog.addListing({
    manifest: {
      id: 'com.icecream.sample-sum-reporter',
      name: 'Sum Reporter (sample)',
      version: '1.0.0',
      description: 'Reads a range and reports the sum of its numeric cells.',
      publisher: 'Icecream Sheets',
      capabilities: [{ kind: 'read' }],
      entrypoint: 'main',
      // Signed 2026-10-18 with the product catalog key. Do NOT edit the
      // manifest or code without re-signing (see production.ts).
      signature:
        'ed25519:x7Uz5gFAlua5288Yrb+vyVz70OzVo+Qy/Zzg2g7ey96MdN98d+ygUZtXJy6vEpdQkkp+Mirw9FZaI9NJQC1hDQ==',
    },
    publisher: 'Icecream Sheets',
    code: SUM_REPORTER_CODE,
    listedAt: '2026-10-18T00:00:00.000Z',
  });
  catalog.addListing({
    manifest: {
      id: 'com.icecream.sample-cell-stamper',
      name: 'Cell Stamper (sample)',
      version: '1.0.0',
      description: 'Writes a marker value into one cell. Demonstrates the write capability.',
      publisher: 'Icecream Sheets',
      capabilities: [{ kind: 'read' }, { kind: 'write' }],
      entrypoint: 'main',
      // Signed 2026-10-18 with the product catalog key. Do NOT edit the
      // manifest or code without re-signing (see production.ts).
      signature:
        'ed25519:TQfNJ+NGWCi7w+t6iPreHDT7hsFQm8olCIScnPFqoAHgZ3r3ZxI8YlCRSjVgjhyP+HSW4sMKoIngYGWNty+NBA==',
    },
    publisher: 'Icecream Sheets',
    code: CELL_STAMPER_CODE,
    listedAt: '2026-10-18T00:00:00.000Z',
  });
  return catalog;
}
