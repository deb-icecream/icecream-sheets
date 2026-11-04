/**
 * Chart-route regression guard (demo fix, owner 2026-10-25).
 *
 * A bare chart request that names a sheet as the DATA SOURCE
 * ("Create a small chart of revenue by year from the Income sheet")
 * was routed to create_chart (native, in-sheet) instead of
 * analyze_data (ephemeral, rendered in the chat reply) — so the chat
 * panel showed only a prose claim and no chart visual, while the
 * native chart landed invisibly on another sheet (diag-chart.json).
 * The prompt must state that data-source wording is NOT placement
 * wording, and create_chart requires explicit placement wording.
 */
import { describe, expect, it } from 'vitest';
import { SYSTEM_PROMPT, SYSTEM_PROMPT_MAX_CHARS } from '../src/agent/openaiBackend.js';

describe('chart routes (demo fix)', () => {
  it('requires explicit placement wording for create_chart', () => {
    expect(SYSTEM_PROMPT).toContain('create_chart cues');
    expect(SYSTEM_PROMPT).toContain('chart in the sheet');
    expect(SYSTEM_PROMPT).toContain('"add a chart to the sheet"');
    expect(SYSTEM_PROMPT).toContain('"insert chart"');
  });

  it('treats naming a sheet as the data source as analyze_data, not placement', () => {
    expect(SYSTEM_PROMPT).toContain('Naming a sheet as the DATA SOURCE');
    expect(SYSTEM_PROMPT).toContain('"chart of revenue by year from the Income sheet"');
    expect(SYSTEM_PROMPT).toContain('is NOT placement');
    expect(SYSTEM_PROMPT).toContain('use analyze_data');
  });

  it('keeps the prompt within its enforced size budget', () => {
    expect(SYSTEM_PROMPT.length).toBeLessThanOrEqual(SYSTEM_PROMPT_MAX_CHARS);
  });

  it('offers create_chart 0-based bounds and states A1 is 1-based (chart-range frame fix)', () => {
    expect(SYSTEM_PROMPT).toContain('"startRow"/"startCol"/"endRow"/"endCol"');
    expect(SYSTEM_PROMPT).toContain('preferred for schema-mapped charts');
    expect(SYSTEM_PROMPT).toContain('1-based A1 string (A1 = row 0)');
    expect(SYSTEM_PROMPT).toContain('Never copy 0-based rows into A1');
    expect(SYSTEM_PROMPT).toContain('win over "range"');
  });
});
