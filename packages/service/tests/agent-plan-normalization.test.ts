/**
 * Wave-5 downstream (a): plan-action normalization.
 *
 * Prod leg 2b failed with "openai-compatible backend: action 1 has unknown
 * type" — the model emitted a second action whose `type` is outside the
 * {done, ask, tool} contract, and the retry loop replays the same prompt at
 * temperature 0, so the same malformed plan recurs deterministically until
 * the turn dies. These tests pin the mechanical fix in validateAction:
 * tool-shaped actions with a nonstandard/missing type coerce to tool
 * (allowlist still enforced); narration-shaped actions (text/message/
 * reply) drop, because the plan's message already carries user-facing
 * text and they encode no effect; anything else still fails, but the
 * error names the offending type so the next diagnosis is not blind.
 */
import { describe, expect, it } from 'vitest';
import { validatePlan } from '../src/agent/openaiBackend.js';

const ALLOWED = new Set(['read_cells', 'create_chart']);

function planWith(actions: unknown[]) {
  return { message: 'Working on it.', actions };
}

const TOOL = {
  type: 'tool',
  tool: 'read_cells',
  args: { sheet: 'Sheet1', startRow: 0, startCol: 0, endRow: 0, endCol: 0 },
};

describe('plan-action normalization (wave-5 downstream)', () => {
  it('drops a narration text action after a tool action', () => {
    const out = validatePlan(planWith([TOOL, { type: 'text', text: 'DONE' }]), ALLOWED);
    expect(out.actions).toHaveLength(1);
    expect(out.actions[0]).toMatchObject({ type: 'tool', tool: 'read_cells' });
  });

  it('drops reply/message narration actions', () => {
    const out = validatePlan(
      planWith([TOOL, { type: 'reply', text: 'DONE' }, { type: 'message', content: 'done' }]),
      ALLOWED,
    );
    expect(out.actions).toHaveLength(1);
  });

  it('coerces a tool-shaped action with a missing type', () => {
    const out = validatePlan(
      planWith([{ tool: 'read_cells', args: { sheet: 'Sheet1' } }]),
      ALLOWED,
    );
    expect(out.actions).toHaveLength(1);
    expect(out.actions[0]).toMatchObject({ type: 'tool', tool: 'read_cells' });
  });

  it('coerces a tool-shaped action with a nonstandard type', () => {
    const out = validatePlan(
      planWith([{ type: 'function_call', tool: 'create_chart', args: { sheet: 'Sheet1' } }]),
      ALLOWED,
    );
    expect(out.actions).toMatchObject([{ type: 'tool', tool: 'create_chart' }]);
  });

  it('coerces a question-shaped action with a missing type to ask', () => {
    const out = validatePlan(planWith([{ question: 'Which sheet?' }]), ALLOWED);
    expect(out.actions).toMatchObject([{ type: 'ask', question: 'Which sheet?' }]);
  });

  it('an only-narration plan ends with zero actions (message carries the answer)', () => {
    const out = validatePlan(planWith([{ type: 'text', text: 'DONE' }]), ALLOWED);
    expect(out.actions).toHaveLength(0);
    expect(out.message).toBe('Working on it.');
  });

  it('still rejects a disallowed tool even when coerced', () => {
    expect(() =>
      validatePlan(planWith([{ type: 'tool_call', tool: 'drop_table', args: {} }]), ALLOWED),
    ).toThrow(/disallowed tool/);
  });

  it('still rejects bad args on a coerced tool action', () => {
    expect(() =>
      validatePlan(planWith([{ tool: 'read_cells', args: [1, 2] }]), ALLOWED),
    ).toThrow(/args must be an object/);
  });

  it('names the offending type for a truly unknown action', () => {
    expect(() => validatePlan(planWith([TOOL, { type: 'bogus', foo: 1 }]), ALLOWED)).toThrow(
      /action 1 has unknown type 'bogus'/,
    );
  });

  it('keeps the contract actions untouched', () => {
    const out = validatePlan(planWith([TOOL, { type: 'done' }]), ALLOWED);
    expect(out.actions).toHaveLength(2);
  });
});
