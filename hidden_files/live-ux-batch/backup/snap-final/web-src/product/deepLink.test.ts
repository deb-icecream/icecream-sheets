// @vitest-environment jsdom
/**
 * Deep-link helpers (CONTRACT.md §Web): `?file=` parsing with the
 * search parameter winning over the legacy `#file=` hash, canonical
 * URL building, and the read-once return-file stash used across the
 * logged-out → login round trip.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  RETURN_FILE_KEY,
  buildFileUrl,
  fileIdFromHash,
  fileIdFromSearch,
  fileIdFromUrl,
  stashReturnFile,
  takeReturnFile,
} from './deepLink';

describe('fileIdFromSearch', () => {
  it('reads the file parameter', () => {
    expect(fileIdFromSearch('?file=file-1')).toBe('file-1');
    expect(fileIdFromSearch('?x=1&file=file-2&y=2')).toBe('file-2');
    expect(fileIdFromSearch('file=file-3')).toBe('file-3');
  });

  it('returns null when absent or empty', () => {
    expect(fileIdFromSearch('')).toBeNull();
    expect(fileIdFromSearch('?x=1')).toBeNull();
    expect(fileIdFromSearch('?file=')).toBeNull();
  });
});

describe('fileIdFromHash', () => {
  it('reads the legacy #file= form', () => {
    expect(fileIdFromHash('#file=file-7')).toBe('file-7');
  });

  it('returns null for other hashes', () => {
    expect(fileIdFromHash('')).toBeNull();
    expect(fileIdFromHash('#')).toBeNull();
    expect(fileIdFromHash('#/sheet/2')).toBeNull();
  });
});

describe('fileIdFromUrl', () => {
  it('the search parameter wins over the legacy hash', () => {
    expect(fileIdFromUrl({ search: '?file=from-search', hash: '#file=from-hash' })).toBe(
      'from-search',
    );
  });

  it('falls back to the hash when search has no file', () => {
    expect(fileIdFromUrl({ search: '?x=1', hash: '#file=from-hash' })).toBe('from-hash');
    expect(fileIdFromUrl({ search: '', hash: '#file=from-hash' })).toBe('from-hash');
  });

  it('returns null when neither carries a file', () => {
    expect(fileIdFromUrl({ search: '', hash: '' })).toBeNull();
    expect(fileIdFromUrl({})).toBeNull();
  });
});

describe('buildFileUrl', () => {
  it('builds origin + pathname + ?file=', () => {
    const url = buildFileUrl('file-42');
    expect(url).toBe(`${window.location.origin}${window.location.pathname}?file=file-42`);
    expect(url).toContain('?file=file-42');
  });

  it('round-trips through fileIdFromSearch', () => {
    const url = buildFileUrl('file-abc');
    expect(fileIdFromSearch(url.slice(url.indexOf('?')))).toBe('file-abc');
  });
});

describe('return-file stash', () => {
  beforeEach(() => {
    sessionStorage.clear();
  });

  it('take returns the stashed id exactly once (read-once)', () => {
    stashReturnFile('file-5');
    expect(sessionStorage.getItem(RETURN_FILE_KEY)).toBe('file-5');
    expect(takeReturnFile()).toBe('file-5');
    expect(sessionStorage.getItem(RETURN_FILE_KEY)).toBeNull();
    expect(takeReturnFile()).toBeNull();
  });

  it('take with nothing stashed returns null', () => {
    expect(takeReturnFile()).toBeNull();
  });
});
