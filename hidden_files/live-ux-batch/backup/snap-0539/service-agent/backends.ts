/**
 * Default model backend: a deterministic, dependency-free intent router.
 *
 * Per ai-agent.md §8 the product ships a default model and tools/behavior
 * do not change with the model — the backend only *plans* (ReAct loop);
 * the AgentRuntime executes. Users can implement ModelBackend against a
 * real LLM provider and pass it to the runtime instead.
 *
 * Two-phase planning: iteration 1 parses the user intent into tool calls;
 * later iterations receive toolResults and compose the final message
 * (e.g. computing a sum over read_cells data).
 */
import type {
  AgentAction,
  ModelBackend,
  PlannerInput,
  PlannerOutput,
  ToolResultRecord,
} from './types.js';
import { classifyAnalysisIntent, routeChatIntent, type AnalysisPlan } from '../analysis/planner.js';

export interface ParsedRange {
  sheet: string;
  startRow: number;
  startCol: number;
  endRow: number;
  endCol: number;
  label: string;
}

export function colLettersToIndex(letters: string): number {
  let n = 0;
  for (const ch of letters.toUpperCase()) {
    const c = ch.charCodeAt(0);
    if (c < 65 || c > 90) throw new Error(`bad column letters: ${letters}`);
    n = n * 26 + (c - 64);
  }
  return n - 1;
}

export function parseA1Cell(a1: string): { row: number; col: number } {
  const m = /^([A-Za-z]{1,3})(\d{1,7})$/.exec(a1.trim());
  if (!m) throw new Error(`bad A1 cell: ${a1}`);
  return { row: parseInt(m[2]!, 10) - 1, col: colLettersToIndex(m[1]!) };
}

/** Parse an optional `Sheet!A1:B2` (or bare `A1`) range reference. */
export function parseRangeRef(text: string): ParsedRange | null {
  const m = /(?:([\w ]+)!)?([A-Za-z]{1,3}\d{1,7})(?::([A-Za-z]{1,3}\d{1,7}))?/.exec(text);
  if (!m) return null;
  try {
    const a = parseA1Cell(m[2]!);
    const b = m[3] ? parseA1Cell(m[3]) : a;
    return {
      sheet: (m[1] ?? 'Sheet1').trim(),
      startRow: Math.min(a.row, b.row),
      startCol: Math.min(a.col, b.col),
      endRow: Math.max(a.row, b.row),
      endCol: Math.max(a.col, b.col),
      label: `${m[1] ? m[1].trim() + '!' : ''}${m[2]!.toUpperCase()}${m[3] ? ':' + m[3].toUpperCase() : ''}`,
    };
  } catch {
    return null;
  }
}

type JsonCell = number | string | boolean | null | { error: string };

function numbersIn(cells: JsonCell[][]): number[] {
  const out: number[] = [];
  for (const row of cells) {
    for (const v of row) {
      if (typeof v === 'number' && Number.isFinite(v)) out.push(v);
    }
  }
  return out;
}

function nonEmptyCount(cells: JsonCell[][]): number {
  let n = 0;
  for (const row of cells) {
    for (const v of row) {
      if (v !== null && !(typeof v === 'object')) n++;
    }
  }
  return n;
}

function fmt(n: number): string {
  return Number.isInteger(n) ? String(n) : String(Math.round(n * 1000) / 1000);
}

type Intent =
  | { kind: 'aggregate'; op: 'sum' | 'average' | 'count' | 'max' | 'min'; range: ParsedRange }
  | { kind: 'read'; range: ParsedRange }
  | { kind: 'recalc' }
  | { kind: 'write'; range: ParsedRange; value: string }
  | { kind: 'formula'; range: ParsedRange; formula: string }
  | { kind: 'remember'; text: string }
  | { kind: 'recall' }
  | { kind: 'analyze'; plan: AnalysisPlan; range: ParsedRange | null }
  | { kind: 'appgen' }
  | { kind: 'unknown' };

function detectIntent(text: string): Intent {
  const t = text.toLowerCase();
  const range = parseRangeRef(text);

  const remember = /(?:remember|note) that (.+)/i.exec(text);
  if (remember) return { kind: 'remember', text: remember[1]!.trim() };
  if (/remember (.+)/i.test(text) && !range) {
    const m = /remember (.+)/i.exec(text)!;
    return { kind: 'remember', text: m[1]!.trim() };
  }
  if (/(what do you remember|recall|what.*notes)/i.test(t)) return { kind: 'recall' };
  if (/(recalculat|recalc)/i.test(t)) return { kind: 'recalc' };

  // Chat-level intent routing (INTENT ROUTING spec, 2026-10-18):
  // app-generation prompts go to the app lane, never the analysis
  // pipeline; analytical prompts go to the data-analysis component.
  // Checked before the range-based rules so "build an app with a chart"
  // is not misread as an analysis request.
  const route = routeChatIntent(text);
  if (route === 'app-generation') return { kind: 'appgen' };
  if (route === 'analysis') return { kind: 'analyze', plan: classifyAnalysisIntent(text), range };

  if (range) {
    // Set/write BEFORE aggregates: "put =SUM(A1:A3) in B1" contains "sum".
    const setM = /(?:set|write|put)\s+(.+?)\s+(?:in|into|to)\s+([A-Za-z]{1,3}\d{1,7}(?::[A-Za-z]{1,3}\d{1,7})?)/i.exec(text);
    if (setM) {
      const target = parseRangeRef(setM[2]!)!;
      const raw = setM[1]!.trim().replace(/^["']|["']$/g, '');
      if (raw.startsWith('=')) return { kind: 'formula', range: target, formula: raw };
      return { kind: 'write', range: target, value: raw };
    }
    const setM2 = /(?:set|write|put)\s+([A-Za-z]{1,3}\d{1,7}(?::[A-Za-z]{1,3}\d{1,7})?)\s+(?:to|=)\s+(.+)/i.exec(text);
    if (setM2) {
      const target = parseRangeRef(setM2[1]!)!;
      const raw = setM2[2]!.trim().replace(/^["']|["']$/g, '');
      if (raw.startsWith('=')) return { kind: 'formula', range: target, formula: raw };
      return { kind: 'write', range: target, value: raw };
    }

    if (/(sum|total)/i.test(t)) return { kind: 'aggregate', op: 'sum', range };
    if (/(average|avg|mean)/i.test(t)) return { kind: 'aggregate', op: 'average', range };
    if (/(count|how many)/i.test(t)) return { kind: 'aggregate', op: 'count', range };
    if (/(max|maximum|largest)/i.test(t)) return { kind: 'aggregate', op: 'max', range };
    if (/(min|minimum|smallest)/i.test(t)) return { kind: 'aggregate', op: 'min', range };

    return { kind: 'read', range };
  }
  return { kind: 'unknown' };
}

function cellsOf(r: ToolResultRecord): JsonCell[][] | null {
  const d = r.data as { cells?: unknown } | undefined;
  if (d && Array.isArray(d.cells)) return d.cells as JsonCell[][];
  return null;
}

function coerceValue(raw: string): string | number | boolean | null {
  if (/^(true|false)$/i.test(raw)) return raw.toLowerCase() === 'true';
  if (/^-?\d+(\.\d+)?$/.test(raw)) return parseFloat(raw);
  return raw;
}

const APPGEN_QUESTION =
  'That sounds like an app request. Apps are built by the app builder lane — a React UI with the spreadsheet as its live backend — not by the analysis pipeline. What should the app do with your data?';

const HELP_QUESTION =
  'I can sum, average, count, or read ranges (e.g. "sum of A1:A10"), ' +
  'write values ("set B2 to 5"), set formulas ("put =SUM(A1:A3) in B1"), ' +
  'recalculate, remember notes ("remember that the budget is 5000"), and ' +
  'analyze data with charts ("analyze A1:D20 and show me a diagram", ' +
  '"forecast next quarter", "top 10 products by sales"). ' +
  'What would you like to do?';

export class HeuristicModelBackend implements ModelBackend {
  readonly name = 'heuristic-v1';

  async plan(input: PlannerInput): Promise<PlannerOutput> {
    // Phase 2: we have tool results — compose the final message.
    if (input.toolResults.length > 0) {
      return { message: this.compose(input), actions: [{ type: 'done' }] };
    }

    const intent = detectIntent(input.userText);
    const actions: AgentAction[] = [];
    let message = '';

    switch (intent.kind) {
      case 'aggregate':
      case 'read': {
        const r = intent.range;
        actions.push({
          type: 'tool',
          tool: 'read_cells',
          args: {
            sheet: r.sheet,
            startRow: r.startRow,
            startCol: r.startCol,
            endRow: r.endRow,
            endCol: r.endCol,
          },
          rationale: `read ${r.label} to answer`,
        });
        message = `Reading ${r.label}…`;
        break;
      }
      case 'recalc':
        actions.push({ type: 'tool', tool: 'recalculate', args: {} });
        message = 'Recalculating…';
        break;
      case 'write': {
        const r = intent.range;
        actions.push({
          type: 'tool',
          tool: 'write_cells',
          args: {
            cells: [{ sheet: r.sheet, row: r.startRow, col: r.startCol, value: coerceValue(intent.value) }],
          },
          rationale: `write value to ${r.label}`,
        });
        message = `Writing to ${r.label}…`;
        break;
      }
      case 'formula': {
        const r = intent.range;
        actions.push({
          type: 'tool',
          tool: 'set_formulas',
          args: {
            formulas: [{ sheet: r.sheet, row: r.startRow, col: r.startCol, formula: intent.formula }],
          },
          rationale: `set formula on ${r.label}`,
        });
        message = `Setting formula on ${r.label}…`;
        break;
      }
      case 'remember':
        actions.push({
          type: 'tool',
          tool: 'memory_save',
          args: { userId: '__agent__', key: 'note', value: intent.text },
          rationale: 'save user note to long-term memory',
        });
        message = 'Remembering…';
        break;
      case 'recall':
        actions.push({
          type: 'tool',
          tool: 'memory_load',
          args: { userId: '__agent__', key: 'note' },
          rationale: 'load saved note',
        });
        message = 'Checking my notes…';
        break;
      case 'analyze': {
        const r = intent.range;
        actions.push({
          type: 'tool',
          tool: 'analyze_data',
          args: {
            intent: input.userText,
            ...(r
              ? {
                  sheet: r.sheet,
                  startRow: r.startRow,
                  startCol: r.startCol,
                  endRow: r.endRow,
                  endCol: r.endCol,
                }
              : {}),
          },
          rationale: `run data-analysis pipeline (${intent.plan.intentKind})`,
        });
        message = `Analyzing${r ? ` ${r.label}` : ' the data'}…`;
        break;
      }
      case 'appgen':
        return {
          message: APPGEN_QUESTION,
          actions: [
            {
              type: 'ask',
              question: APPGEN_QUESTION,
              options: ['Describe the app', 'Analyze the data instead'],
              // Product-constructed intent choice: exempt from the
              // grounding gate (see AskAction.intentChoice).
              intentChoice: true,
            },
          ],
        };
      case 'unknown':
        return {
          message: HELP_QUESTION,
          actions: [
            {
              type: 'ask',
              question: HELP_QUESTION,
              options: ['Sum a range', 'Read a range', 'Write a value', 'Recalculate'],
              // Product-constructed intent choice: exempt from the
              // grounding gate (see AskAction.intentChoice).
              intentChoice: true,
            },
          ],
        };
    }
    return { message, actions };
  }

  private compose(input: PlannerInput): string {
    const intent = detectIntent(input.userText);
    const read = input.toolResults.find((r) => r.tool === 'read_cells');
    const cells = read ? cellsOf(read) : null;

    if (intent.kind === 'aggregate' && cells) {
      const nums = numbersIn(cells);
      const label = intent.range.label;
      switch (intent.op) {
        case 'sum':
          return `The sum of ${label} is ${fmt(nums.reduce((a, b) => a + b, 0))}.`;
        case 'average':
          return nums.length === 0
            ? `${label} has no numbers to average.`
            : `The average of ${label} is ${fmt(nums.reduce((a, b) => a + b, 0) / nums.length)}.`;
        case 'count':
          return `${label} has ${nonEmptyCount(cells)} non-empty cell(s).`;
        case 'max':
          return nums.length === 0 ? `${label} has no numbers.` : `The maximum of ${label} is ${fmt(Math.max(...nums))}.`;
        case 'min':
          return nums.length === 0 ? `${label} has no numbers.` : `The minimum of ${label} is ${fmt(Math.min(...nums))}.`;
      }
    }
    if (intent.kind === 'read' && cells) {
      const preview = cells
        .slice(0, 5)
        .map((row) =>
          row
            .slice(0, 5)
            .map((v) => (v === null ? '' : typeof v === 'object' ? '#ERR' : String(v)))
            .join(' | '),
        )
        .join('\n');
      return `${intent.range.label}:\n${preview || '(empty)'}`;
    }
    // Generic fallbacks per tool.
    const parts: string[] = [];
    for (const r of input.toolResults) {
      if (r.tool === 'write_cells' || r.tool === 'set_formulas') parts.push('Done.');
      else if (r.tool === 'recalculate') parts.push('Recalculation complete.');
      else if (r.tool === 'memory_save') parts.push('Remembered.');
      else if (r.tool === 'analyze_data') {
        const d = r.data as { summary?: string; ok?: boolean } | undefined;
        parts.push(
          r.ok && typeof d?.summary === 'string'
            ? d.summary
            : `Analysis failed${d && 'error' in (d as object) ? `: ${(d as { error?: string }).error}` : ''}.`,
        );
      } else if (r.tool === 'memory_load') {
        const d = r.data as { found?: boolean; value?: unknown } | undefined;
        parts.push(
          d?.found ? `I remember: ${JSON.stringify(d.value)}` : 'I have nothing saved yet.',
        );
      } else parts.push(r.summary);
    }
    return parts.join(' ') || 'Done.';
  }
}
