/**
 * Unit tests for extended Clear commands (comments/notes, hyperlinks).
 */
import { describe, expect, it } from 'vitest';
import { setComment, type CommentStore } from './comments';
import { setHyperlink } from './links';
import { clearCommentsInRange, clearHyperlinks } from './clearExt';

const RANGE = { startRow: 0, startCol: 0, endRow: 1, endCol: 1 };

describe('clearCommentsInRange', () => {
  it('removes comments inside the range and reports the count', () => {
    let store: CommentStore = new Map();
    store = setComment(store, 'Sheet1', 0, 0, 'a');
    store = setComment(store, 'Sheet1', 1, 1, 'b');
    store = setComment(store, 'Sheet1', 5, 5, 'keep');
    const { store: next, cleared } = clearCommentsInRange(store, 'Sheet1', RANGE);
    expect(cleared).toBe(2);
    expect(next.has('Sheet1:0:0')).toBe(false);
    expect(next.has('Sheet1:1:1')).toBe(false);
    expect(next.has('Sheet1:5:5')).toBe(true);
  });

  it('does not mutate the input store', () => {
    let store: CommentStore = new Map();
    store = setComment(store, 'Sheet1', 0, 0, 'a');
    clearCommentsInRange(store, 'Sheet1', RANGE);
    expect(store.has('Sheet1:0:0')).toBe(true);
  });

  it('reports zero when nothing is in range', () => {
    const { cleared } = clearCommentsInRange(new Map(), 'Sheet1', RANGE);
    expect(cleared).toBe(0);
  });

  it('is sheet-scoped', () => {
    let store: CommentStore = new Map();
    store = setComment(store, 'Other', 0, 0, 'a');
    const { cleared, store: next } = clearCommentsInRange(store, 'Sheet1', RANGE);
    expect(cleared).toBe(0);
    expect(next.has('Other:0:0')).toBe(true);
  });
});

describe('clearHyperlinks', () => {
  it('removes hyperlinks inside the range and reports the count', () => {
    let store = setHyperlink(new Map(), 'Sheet1', 0, 0, {
      target: { kind: 'url', url: 'https://a.example' },
    });
    store = setHyperlink(store, 'Sheet1', 0, 1, {
      target: { kind: 'url', url: 'https://b.example' },
    });
    store = setHyperlink(store, 'Sheet1', 9, 9, {
      target: { kind: 'url', url: 'https://keep.example' },
    });
    const { store: next, cleared } = clearHyperlinks(store, 'Sheet1', RANGE);
    expect(cleared).toBe(2);
    expect(next.has('Sheet1:0:0')).toBe(false);
    expect(next.has('Sheet1:0:1')).toBe(false);
    expect(next.has('Sheet1:9:9')).toBe(true);
  });

  it('does not mutate the input store', () => {
    const store = setHyperlink(new Map(), 'Sheet1', 0, 0, {
      target: { kind: 'url', url: 'https://a.example' },
    });
    clearHyperlinks(store, 'Sheet1', RANGE);
    expect(store.has('Sheet1:0:0')).toBe(true);
  });
});
