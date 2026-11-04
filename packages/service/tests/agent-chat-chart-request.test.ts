/**
 * Wave-5 downstream (a), leg 2a: the plain-loop chart guard fires on the
 * leg prompt, so create_chart is refused pre-MCP and the panel shows
 * "✗ create_chart". This pins the classification mechanically: the leg
 * prompt has chart language but no placement wording the regex
 * recognizes ("on Sheet1" does not count — "Sheet1" fails the
 * \bsheets?\b boundary because of the "1" suffix), while the native
 * prompt ("Add a chart to the Income sheet ...") classifies as placed
 * and is unaffected.
 */
import { describe, expect, it } from 'vitest';
import { isChatChartRequest } from '../src/agent/runtime.js';

describe('isChatChartRequest on wave-5 leg prompts', () => {
  it('leg 2a prompt classifies as a chat-chart request (guard refuses create_chart)', () => {
    expect(
      isChatChartRequest('Create a bar chart from cells A1:B3 on Sheet1, then confirm with the word DONE.'),
    ).toBe(true);
  });

  it('leg 2b prompt classifies the same way', () => {
    expect(
      isChatChartRequest('Create a bar chart from cells A1:B3 on Sheet1, then reply with the single word DONE.'),
    ).toBe(true);
  });

  it('native placement prompt does not classify as chat-chart', () => {
    expect(
      isChatChartRequest(
        'Add a chart to the Income sheet showing revenue by year, using the real numbers from the file.',
      ),
    ).toBe(false);
  });

  it('R3 panel-chart prompt classifies as chat-chart', () => {
    expect(
      isChatChartRequest(
        'Create a small chart of revenue by year from the Income sheet, using the real numbers from the file.',
      ),
    ).toBe(true);
  });
});
