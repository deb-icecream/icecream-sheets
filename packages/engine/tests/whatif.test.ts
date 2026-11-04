import { describe, expect, it } from 'vitest';
import {
  addScenario,
  captureScenario,
  createScenarioSet,
  deleteScenario,
  editScenario,
  scenarioSummary,
  scenarioWrites,
} from '../src/index.js';

describe('scenario manager', () => {
  it('creates an empty set', () => {
    const set = createScenarioSet();
    expect(set.version).toBe(1);
    expect(set.scenarios).toEqual([]);
  });

  it('adds scenarios', () => {
    let set = createScenarioSet();
    set = addScenario(set, { name: 'Best', changingCells: ['A1'], values: [100] });
    set = addScenario(set, { name: 'Worst', changingCells: ['A1'], values: [10] });
    expect(set.scenarios.map((s) => s.name)).toEqual(['Best', 'Worst']);
  });

  it('rejects duplicate names (case-insensitive)', () => {
    let set = createScenarioSet();
    set = addScenario(set, { name: 'Best', changingCells: ['A1'], values: [100] });
    expect(() => addScenario(set, { name: 'best', changingCells: ['A1'], values: [1] })).toThrow(
      /already exists/,
    );
  });

  it('rejects mismatched cells/values', () => {
    const set = createScenarioSet();
    expect(() =>
      addScenario(set, { name: 'X', changingCells: ['A1', 'B1'], values: [1] }),
    ).toThrow(/same length/);
  });

  it('deletes scenarios', () => {
    let set = createScenarioSet();
    set = addScenario(set, { name: 'A', changingCells: ['A1'], values: [1] });
    set = addScenario(set, { name: 'B', changingCells: ['A1'], values: [2] });
    set = deleteScenario(set, 'A');
    expect(set.scenarios.map((s) => s.name)).toEqual(['B']);
  });

  it('edits scenario values and comment', () => {
    let set = createScenarioSet();
    set = addScenario(set, { name: 'A', changingCells: ['A1'], values: [1] });
    set = editScenario(set, 'A', { values: [99], comment: 'updated' });
    expect(set.scenarios[0]!.values).toEqual([99]);
    expect(set.scenarios[0]!.comment).toBe('updated');
  });

  it('produces cell writes', () => {
    const writes = scenarioWrites({ name: 'S', changingCells: ['A1', 'B2'], values: [5, 'x'] });
    expect(writes).toEqual([
      { cell: 'A1', value: 5 },
      { cell: 'B2', value: 'x' },
    ]);
  });

  it('captures current values', () => {
    const s = captureScenario('Snap', ['A1', 'B1'], (c) => (c === 'A1' ? 42 : null), 'note');
    expect(s.values).toEqual([42, '']);
    expect(s.comment).toBe('note');
  });

  it('builds a summary table', () => {
    let set = createScenarioSet();
    set = addScenario(set, { name: 'Best', changingCells: ['A1', 'B1'], values: [100, 200] });
    set = addScenario(set, { name: 'Worst', changingCells: ['A1'], values: [10] });
    const { headers, rows } = scenarioSummary(set);
    expect(headers).toEqual(['Scenario', 'A1', 'B1']);
    expect(rows).toEqual([
      ['Best', 100, 200],
      ['Worst', 10, ''],
    ]);
  });
});
