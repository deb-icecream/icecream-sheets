import { describe, expect, it } from 'vitest';
import {
  headerFooterFromMetadata,
  headerFooterMetadataKey,
  headerFooterToMetadata,
} from './HeaderFooterDialog';
import { defaultHeaderFooter } from '../features/headerFooter';

describe('header/footer metadata channel', () => {
  it('builds a per-sheet metadata key', () => {
    expect(headerFooterMetadataKey('Sheet1')).toBe('icecream.headerfooter.Sheet1');
  });

  it('round-trips settings through metadata', () => {
    const settings = { ...defaultHeaderFooter(), differentFirst: true };
    const back = headerFooterFromMetadata(headerFooterToMetadata(settings));
    expect(back).toEqual(settings);
  });

  it('returns null for missing or invalid metadata', () => {
    expect(headerFooterFromMetadata(undefined)).toBeNull();
    expect(headerFooterFromMetadata(null)).toBeNull();
    expect(headerFooterFromMetadata('junk')).toBeNull();
    // Wrong version is rejected by validation.
    const bad = headerFooterToMetadata(defaultHeaderFooter()) as Record<string, unknown>;
    bad.version = 999;
    expect(headerFooterFromMetadata(bad)).toBeNull();
  });
});
