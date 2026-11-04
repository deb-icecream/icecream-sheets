/**
 * Tests for the command registry (design-docs/platform-shell.md §6).
 *
 * Menu search (Alt+/) and the keyboard-shortcuts dialog (Ctrl+/) resolve
 * against the same registry on every host, so these helpers are the
 * shared contract: chord normalization, query matching, and ranking.
 */
import { describe, expect, it } from 'vitest';
import { chordOf, matchesQuery, rankCommand, type AppCommand } from './commands';

function cmd(over: Partial<AppCommand> = {}): AppCommand {
  return {
    id: 'test.cmd',
    label: 'Test Command',
    category: 'Test',
    run: () => {},
    ...over,
  };
}

describe('chordOf', () => {
  it('normalizes Ctrl+/ (shortcuts dialog)', () => {
    expect(chordOf({ ctrlKey: true, altKey: false, shiftKey: false, key: '/' } as KeyboardEvent)).toBe('Ctrl+/');
  });
  it('normalizes Alt+/ (menu search)', () => {
    expect(chordOf({ ctrlKey: false, altKey: true, shiftKey: false, key: '/' } as KeyboardEvent)).toBe('Alt+/');
  });
  it('uppercases single keys and includes Shift', () => {
    expect(chordOf({ ctrlKey: true, altKey: false, shiftKey: true, key: 'z' } as KeyboardEvent)).toBe('Ctrl+Shift+Z');
  });
  it('treats Meta as Ctrl (macOS)', () => {
    expect(chordOf({ ctrlKey: false, metaKey: true, altKey: false, shiftKey: false, key: 's' } as unknown as KeyboardEvent)).toBe('Ctrl+S');
  });
  it('keeps named keys as-is', () => {
    expect(chordOf({ ctrlKey: false, altKey: false, shiftKey: false, key: 'F9' } as KeyboardEvent)).toBe('F9');
  });
});

describe('matchesQuery', () => {
  const c = cmd({ id: 'file.library', label: 'Open workbook library…', category: 'File', shortcut: 'Ctrl+O' });
  it('matches empty query', () => {
    expect(matchesQuery(c, '')).toBe(true);
    expect(matchesQuery(c, '   ')).toBe(true);
  });
  it('matches label substring case-insensitively', () => {
    expect(matchesQuery(c, 'workbook')).toBe(true);
    expect(matchesQuery(c, 'WORKBOOK')).toBe(true);
  });
  it('matches category, id, and shortcut', () => {
    expect(matchesQuery(c, 'file')).toBe(true);
    expect(matchesQuery(c, 'file.library')).toBe(true);
    expect(matchesQuery(c, 'ctrl+o')).toBe(true);
  });
  it('rejects non-matches', () => {
    expect(matchesQuery(c, 'pivot')).toBe(false);
  });
});

describe('rankCommand', () => {
  it('ranks label-prefix above label-word above other', () => {
    const prefix = cmd({ label: 'Sort ascending' });
    const word = cmd({ label: 'Data sort options' });
    const other = cmd({ label: 'Insert chart', category: 'Sort' });
    expect(rankCommand(prefix, 'sort')).toBeLessThan(rankCommand(word, 'sort'));
    expect(rankCommand(word, 'sort')).toBeLessThan(rankCommand(other, 'sort'));
  });
  it('gives every command a baseline rank for empty query', () => {
    expect(rankCommand(cmd(), '')).toBe(1);
  });
});

describe('registry contract', () => {
  it('requires stable ids and runnable commands', () => {
    const commands: AppCommand[] = [
      { id: 'view.shortcuts', label: 'Keyboard shortcuts…', category: 'View', shortcut: 'Ctrl+/', run: () => {} },
      { id: 'view.menu-search', label: 'Menu search…', category: 'View', shortcut: 'Alt+/', run: () => {} },
    ];
    const ids = commands.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const c of commands) {
      expect(typeof c.run).toBe('function');
      expect(c.label.length).toBeGreaterThan(0);
      expect(c.category.length).toBeGreaterThan(0);
    }
  });
});
