/**
 * Tests for the cell comment store (Review tab).
 */
import { describe, expect, it } from 'vitest';
import {
  commentKey,
  getComment,
  setComment,
  deleteComment,
  listComments,
  nextComment,
  prevComment,
  deleteAllComments,
  countComments,
  type CommentStore,
} from './comments';

describe('commentKey', () => {
  it('builds sheet:row:col keys', () => {
    expect(commentKey('Sheet1', 2, 3)).toBe('Sheet1:2:3');
  });

  it('distinguishes sheets', () => {
    expect(commentKey('A', 0, 0)).not.toBe(commentKey('B', 0, 0));
  });
});

describe('comment store', () => {
  it('returns undefined for cells without comments', () => {
    const store: CommentStore = new Map();
    expect(getComment(store, 'S', 0, 0)).toBeUndefined();
  });

  it('sets and gets a comment', () => {
    const store = setComment(new Map(), 'S', 1, 2, 'Review this');
    expect(getComment(store, 'S', 1, 2)).toBe('Review this');
  });

  it('overwrites an existing comment', () => {
    let store = setComment(new Map(), 'S', 0, 0, 'first');
    store = setComment(store, 'S', 0, 0, 'second');
    expect(getComment(store, 'S', 0, 0)).toBe('second');
    expect(store.size).toBe(1);
  });

  it('is immutable: setComment leaves the original store alone', () => {
    const before: CommentStore = new Map();
    const after = setComment(before, 'S', 0, 0, 'hi');
    expect(before.size).toBe(0);
    expect(after.size).toBe(1);
  });

  it('deletes a comment and is immutable', () => {
    const store = setComment(new Map(), 'S', 0, 0, 'hi');
    const after = deleteComment(store, 'S', 0, 0);
    expect(getComment(after, 'S', 0, 0)).toBeUndefined();
    expect(getComment(store, 'S', 0, 0)).toBe('hi');
  });

  it('treats empty text as a delete', () => {
    const store = setComment(new Map(), 'S', 0, 0, 'hi');
    const after = setComment(store, 'S', 0, 0, '');
    expect(getComment(after, 'S', 0, 0)).toBeUndefined();
  });

  it('deleteComment is a no-op for missing comments', () => {
    const store: CommentStore = new Map();
    const after = deleteComment(store, 'S', 9, 9);
    expect(after.size).toBe(0);
  });
});

describe('comment navigation', () => {
  function seeded(): CommentStore {
    let s: CommentStore = new Map();
    s = setComment(s, 'Sheet1', 0, 0, 'first');
    s = setComment(s, 'Sheet1', 2, 1, 'second');
    s = setComment(s, 'Sheet2', 0, 0, 'other');
    return s;
  }

  it('lists comments in row-major order for one sheet', () => {
    expect(listComments(seeded(), 'Sheet1').map((c) => [c.row, c.col])).toEqual([[0, 0], [2, 1]]);
  });

  it('nextComment moves forward and wraps', () => {
    expect(nextComment(seeded(), 'Sheet1', 0, 0)).toMatchObject({ row: 2, col: 1, text: 'second' });
    expect(nextComment(seeded(), 'Sheet1', 2, 1)).toMatchObject({ row: 0, col: 0, text: 'first' });
  });

  it('prevComment moves backward and wraps', () => {
    expect(prevComment(seeded(), 'Sheet1', 2, 1)).toMatchObject({ row: 0, col: 0 });
    expect(prevComment(seeded(), 'Sheet1', 0, 0)).toMatchObject({ row: 2, col: 1 });
  });

  it('returns undefined when there are no comments', () => {
    expect(nextComment(new Map(), 'S', 0, 0)).toBeUndefined();
    expect(prevComment(new Map(), 'S', 0, 0)).toBeUndefined();
  });

  it('deleteAllComments removes only that sheet’s comments', () => {
    const after = deleteAllComments(seeded(), 'Sheet1');
    expect(countComments(after, 'Sheet1')).toBe(0);
    expect(countComments(after, 'Sheet2')).toBe(1);
  });

  it('countComments counts per sheet', () => {
    expect(countComments(seeded(), 'Sheet1')).toBe(2);
    expect(countComments(seeded(), 'Sheet2')).toBe(1);
    expect(countComments(seeded(), 'Nope')).toBe(0);
  });
});
