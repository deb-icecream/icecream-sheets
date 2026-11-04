import { describe, expect, it } from 'vitest';
import {
  deleteNote,
  getNote,
  listNotes,
  nextNote,
  prevNote,
  setNote,
  type NoteStore,
} from './notes';

function seeded(): NoteStore {
  let s: NoteStore = new Map();
  s = setNote(s, 'Sheet1', 0, 0, 'first', 'alice');
  s = setNote(s, 'Sheet1', 2, 1, 'second', 'bob');
  s = setNote(s, 'Sheet2', 0, 0, 'other sheet', 'alice');
  return s;
}

describe('notes model', () => {
  it('sets and gets a note with author and timestamps', () => {
    const s = setNote(new Map(), 'S', 1, 2, 'hello', 'alice');
    const n = getNote(s, 'S', 1, 2);
    expect(n?.text).toBe('hello');
    expect(n?.author).toBe('alice');
    expect(n?.createdAt).toBeTruthy();
  });
  it('empty text clears the note', () => {
    let s = setNote(new Map(), 'S', 1, 2, 'hello');
    s = setNote(s, 'S', 1, 2, '');
    expect(getNote(s, 'S', 1, 2)).toBeUndefined();
  });
  it('deletes a note', () => {
    let s = setNote(new Map(), 'S', 1, 2, 'hello');
    s = deleteNote(s, 'S', 1, 2);
    expect(getNote(s, 'S', 1, 2)).toBeUndefined();
  });
  it('preserves createdAt on edit', () => {
    let s = setNote(new Map(), 'S', 1, 2, 'hello', 'alice');
    const created = getNote(s, 'S', 1, 2)?.createdAt;
    s = setNote(s, 'S', 1, 2, 'edited', 'alice');
    expect(getNote(s, 'S', 1, 2)?.createdAt).toBe(created);
    expect(getNote(s, 'S', 1, 2)?.text).toBe('edited');
  });
});

describe('navigation', () => {
  it('lists notes in row-major order for one sheet', () => {
    expect(listNotes(seeded(), 'Sheet1').map((n) => [n.row, n.col])).toEqual([[0, 0], [2, 1]]);
  });
  it('nextNote moves forward and wraps', () => {
    expect(nextNote(seeded(), 'Sheet1', 0, 0)).toMatchObject({ row: 2, col: 1 });
    expect(nextNote(seeded(), 'Sheet1', 2, 1)).toMatchObject({ row: 0, col: 0 });
  });
  it('prevNote moves backward and wraps', () => {
    expect(prevNote(seeded(), 'Sheet1', 2, 1)).toMatchObject({ row: 0, col: 0 });
    expect(prevNote(seeded(), 'Sheet1', 0, 0)).toMatchObject({ row: 2, col: 1 });
  });
  it('returns undefined when there are no notes', () => {
    expect(nextNote(new Map(), 'S', 0, 0)).toBeUndefined();
    expect(prevNote(new Map(), 'S', 0, 0)).toBeUndefined();
  });
});
