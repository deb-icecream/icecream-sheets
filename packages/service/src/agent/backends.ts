/**
 * #137 model backends: the no-model backend (fail clearly when no LLM
 * is configured) plus pure cell-reference parsers (parseRangeRef,
 * parseA1Cell) used by the analysis lane. There is NO heuristic or
 * deterministic planner here anymore — the regex backend that guessed
 * tool calls from prompt text was DELETED by owner ruling 2026-10-25.
 * Every turn goes to a real LLM backend (Vertex by default, an
 * OpenAI-compatible endpoint when configured); with no model
 * configured the turn fails with NoModelConfiguredError, never a
 * guessed write.
 */
import type { ModelBackend, PlannerOutput } from './types.js';

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

/**
 * Parse an optional `Sheet!A1:B2` (or bare `A1`) range reference.
 * A bare reference resolves to `defaultSheet`: callers that know the
 * user's active sheet pass it (#135); the 'Sheet1' default here is
 * only the legacy fallback for callers with no sheet context at all,
 * and the runtime's sheetContext supersedes it whenever present.
 */
export function parseRangeRef(text: string, defaultSheet = 'Sheet1'): ParsedRange | null {
  const m = /(?:([\w ]+)!)?([A-Za-z]{1,3}\d{1,7})(?::([A-Za-z]{1,3}\d{1,7}))?/.exec(text);
  if (!m) return null;
  try {
    const a = parseA1Cell(m[2]!);
    const b = m[3] ? parseA1Cell(m[3]) : a;
    return {
      sheet: (m[1] ?? defaultSheet).trim(),
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

/**
 * #137: the agent has no model backend at all. Every turn goes to the
 * LLM; when no LLM is configured the turn must fail CLEARLY instead of
 * being guessed by a parser. This backend is the only thing the request
 * path may resolve to when no model is available: plan() always throws
 * NoModelConfiguredError, and the runtime surfaces its message verbatim
 * (never the generic "model service is busy" text) with zero tool calls.
 */
export const NO_MODEL_CONFIGURED_MESSAGE =
  'The agent has no model configured (no model configured on this service), ' +
  'so it cannot run this request — and it will not guess. Configure a model ' +
  'provider, or use a deployment with a model, and try again.';

/** Thrown by NoModelConfiguredBackend; the runtime renders it verbatim. */
export class NoModelConfiguredError extends Error {
  constructor(message: string = NO_MODEL_CONFIGURED_MESSAGE) {
    super(message);
    this.name = 'NoModelConfiguredError';
  }
}

/**
 * #137: the no-model backend. plan() and planJob() always throw
 * NoModelConfiguredError. It performs no parsing, emits no tool calls,
 * and writes nothing — the request path resolves here (never to the
 * heuristic backend) whenever no LLM is configured.
 */
export class NoModelConfiguredBackend implements ModelBackend {
  readonly name = 'no-model';

  async plan(): Promise<PlannerOutput> {
    throw new NoModelConfiguredError();
  }

  async planJob(): Promise<null> {
    throw new NoModelConfiguredError();
  }
}

/**
 * #137 (owner ruling 2026-10-25): the heuristic regex backend was
 * DELETED, not gated. It guessed tool calls from prompt text (and
 * guessed wrong — "put Debajyoti Saikia on cell B2" wrote "Debajyoti
 * Saikia on cell"). There is no fallback model: every turn goes to a
 * real LLM backend, and with no model configured the turn fails with
 * NoModelConfiguredError above. Nothing in this file plans from
 * prompt text anymore; the parsing helpers below (parseRangeRef,
 * parseA1Cell) are pure reference parsers used by the analysis lane.
 */
