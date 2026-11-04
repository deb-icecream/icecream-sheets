/**
 * What-If Analysis: Scenario Manager (track 7, data-tools).
 *
 * Pure service-layer helpers. Scenarios are plain serializable data owned by
 * the client (App state / service metadata store); applying a scenario is a
 * list of cell writes the caller performs through authorize().
 */

export const SCENARIO_SPEC_VERSION = 1 as const;

export interface Scenario {
  name: string;
  /** A1 references of the changing cells. */
  changingCells: string[];
  /** Values parallel to changingCells. */
  values: (number | string)[];
  comment?: string;
}

export interface ScenarioSet {
  version: typeof SCENARIO_SPEC_VERSION;
  scenarios: Scenario[];
}

/** Create an empty scenario set. */
export function createScenarioSet(): ScenarioSet {
  return { version: SCENARIO_SPEC_VERSION, scenarios: [] };
}

/** Add a scenario; names must be unique (case-insensitive). */
export function addScenario(set: ScenarioSet, scenario: Scenario): ScenarioSet {
  if (set.scenarios.some((s) => s.name.toLowerCase() === scenario.name.toLowerCase())) {
    throw new Error(`A scenario named "${scenario.name}" already exists.`);
  }
  if (scenario.changingCells.length !== scenario.values.length) {
    throw new Error('changingCells and values must have the same length.');
  }
  return { ...set, scenarios: [...set.scenarios, { ...scenario }] };
}

/** Remove a scenario by name. */
export function deleteScenario(set: ScenarioSet, name: string): ScenarioSet {
  return { ...set, scenarios: set.scenarios.filter((s) => s.name !== name) };
}

/** Rename / edit a scenario's values. */
export function editScenario(
  set: ScenarioSet,
  name: string,
  update: Partial<Pick<Scenario, 'values' | 'comment'>>,
): ScenarioSet {
  return {
    ...set,
    scenarios: set.scenarios.map((s) => (s.name === name ? { ...s, ...update } : s)),
  };
}

/** Cell writes that apply the scenario (caller executes through authorize()). */
export function scenarioWrites(scenario: Scenario): { cell: string; value: number | string }[] {
  return scenario.changingCells.map((cell, i) => ({ cell, value: scenario.values[i] ?? '' }));
}

/**
 * Capture the current values of cells as a new scenario.
 * @param readCell A1 -> current display value
 */
export function captureScenario(
  name: string,
  changingCells: string[],
  readCell: (cell: string) => number | string | null,
  comment?: string,
): Scenario {
  return {
    name,
    changingCells: [...changingCells],
    values: changingCells.map((c) => readCell(c) ?? ''),
    comment,
  };
}

/** Summary table: rows of [scenarioName, ...changingValues]. */
export function scenarioSummary(
  set: ScenarioSet,
): { headers: string[]; rows: (string | number)[][] } {
  const headers = ['Scenario', ...set.scenarios.flatMap((s) => s.changingCells).filter((c, i, a) => a.indexOf(c) === i)];
  const rows = set.scenarios.map((s) => {
    const byCell = new Map(s.changingCells.map((c, i) => [c, s.values[i] ?? ''] as const));
    return [s.name, ...headers.slice(1).map((h) => byCell.get(h) ?? '')];
  });
  return { headers, rows };
}
