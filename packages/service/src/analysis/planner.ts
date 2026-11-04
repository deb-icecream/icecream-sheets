/**
 * Data-analysis intent handling (design-docs: data-analysis component).
 *
 * One general classifier for analytical requests — NOT per-use-case code.
 * The grammar covers the analytical verbs a user can ask about their data:
 * summarize/describe, aggregate/group-by, trend/forecast, distribution,
 * correlation, compare, top-N/ranking. classifyAnalysisIntent turns free
 * text into a structured AnalysisPlan { intentKind, targetColumns, params },
 * which the Python generator consumes together with the DataSchema.
 *
 * routeChatIntent is the chat-level router (user's INTENT ROUTING spec):
 * it distinguishes (a) APP GENERATION prompts — frontend React app with
 * MCP as backend, handled by the app lane — from (b) DATA
 * ANALYSIS/VISUALIZATION prompts, which come here. The router checks app
 * generation FIRST so "build an app that shows a chart" never lands in
 * the analysis pipeline.
 */

/** The analytical intent grammar — one kind per analytical verb. */
export type AnalysisIntentKind =
  | 'summarize'
  | 'aggregate'
  | 'trend'
  | 'distribution'
  | 'correlation'
  | 'compare'
  | 'top-n';

/** Structured plan the Python generator consumes with the DataSchema. */
export interface AnalysisPlan {
  intentKind: AnalysisIntentKind;
  /** Column names (schema names), in role order defined per intent. */
  targetColumns: string[];
  /** Intent-specific parameters (bins, top-N count, forecast horizon...). */
  params: Record<string, unknown>;
  /** One-line human summary for the audit trail and chat. */
  summary: string;
}

export const ANALYSIS_INTENT_KINDS: AnalysisIntentKind[] = [
  'summarize',
  'aggregate',
  'trend',
  'distribution',
  'correlation',
  'compare',
  'top-n',
];

/** (pattern, kind) rules, in priority order. Keep app-generation out of here. */
const INTENT_RULES: { re: RegExp; kind: AnalysisIntentKind }[] = [
  {
    re: /\b(top|bottom|largest|smallest|best|worst)\b[^.\n]{0,40}\b(\d+)\b|\btop\s?(\d+)\b|\btop\b|\brank\b/,
    kind: 'top-n',
  },
  { re: /\b(correlation|correlat\w*|relationship between|related to)\b/, kind: 'correlation' },
  { re: /\b(forecast|predict|projection|trend|over time|growth|next quarter|next month|seasonality)\b/, kind: 'trend' },
  { re: /\b(distribution|histogram|spread|outlier|bell curve|normality)\b/, kind: 'distribution' },
  {
    // Group-by shapes: explicit ("group by", "pivot", "breakdown"),
    // "per <dimension>", and the natural "<measure> by <dimension>"
    // ("revenue by region", "total sales by product") — the bare
    // by-phrasing previously fell through to 'summarize' and produced
    // the generic Column-means chart for a grouped question (case 3a).
    re: /\b(group by|grouped by|pivot|break ?down|by category)\b|\bgroup\b[^.\n]{0,30}\bby\b|\bper\s+[a-z]+\b|\b(total|sum|revenue|sales|amount|count|average|avg|spend|cost|price|units)\b[^.\n]{0,40}\bby\b/,
    kind: 'aggregate',
  },
  { re: /\b(compare|comparison|versus| vs\.? |against|side[- ]by[- ]side|difference between)\b/, kind: 'compare' },
  { re: /\b(summar\w*|describe|overview|stats|statistics|kpi|key metrics|analyze|analy[sz]e|diagram|chart|visual|plot|graph|show me)\b/, kind: 'summarize' },
];

/** Extract "top N" count from text; defaults to 10. */
function topNCount(text: string): number {
  const m = /\btop\s?(\d{1,3})\b/i.exec(text) ?? /\b(\d{1,3})\s?(largest|smallest|biggest)\b/i.exec(text);
  const n = m ? parseInt(m[1]!, 10) : 10;
  return Math.min(Math.max(n, 1), 100);
}

/** Extract a quoted or "by <word>" column hint, e.g. by region / "Sales". */
function columnHints(text: string): string[] {
  const hints: string[] = [];
  const quoted = text.matchAll(/["“”'‘’]([^"“”'‘’]+)["“”'‘’]/g);
  for (const m of quoted) hints.push(m[1]!.trim());
  const byCols = text.matchAll(/\bby\s+([A-Za-z][\w ]{1,40}?)(?=\s+(and|vs\.?|versus|with|for|in|of|over|from)\b|[.,;!?]|$)/gi);
  for (const m of byCols) hints.push(m[1]!.trim());
  return [...new Set(hints)].filter((h) => h.length > 0);
}

/**
 * Classify an analytical request into the intent grammar. This is a
 * heuristic first pass; a future ModelBackend-backed classifier can
 * replace it without changing AnalysisPlan or any downstream consumer.
 */
export function classifyAnalysisIntent(text: string): AnalysisPlan {
  const lowered = text.toLowerCase();
  let kind: AnalysisIntentKind = 'summarize';
  for (const rule of INTENT_RULES) {
    if (rule.re.test(lowered)) {
      kind = rule.kind;
      break;
    }
  }
  const targetColumns = columnHints(text);
  const params: Record<string, unknown> = {};
  if (kind === 'top-n') params.n = topNCount(text);
  if (kind === 'trend' && /\bnext (quarter|month|year)\b/.test(lowered)) {
    params.forecastHorizon = /\bnext quarter\b/.test(lowered) ? 3 : 12;
  }
  if (kind === 'distribution') {
    const bins = /\b(\d{1,2})\s?bins?\b/i.exec(text);
    params.bins = bins ? Math.min(Math.max(parseInt(bins[1]!, 10), 2), 50) : undefined;
  }
  const summary =
    kind === 'top-n'
      ? `Top-${params.n as number} ranking`
      : `${kind[0]!.toUpperCase()}${kind.slice(1)} analysis`;
  return { intentKind: kind, targetColumns, params, summary };
}

// ---------------------------------------------------------------------------
// Chat-level intent routing (INTENT ROUTING spec, 2026-10-18)
// ---------------------------------------------------------------------------

/**
 * Where a chat prompt should be routed.
 *
 * Delegates to the sibling lane's router (agent/intentRouter.ts:
 * classifyIntent with confidence scoring) so there is exactly ONE
 * app-vs-analysis classifier in the product. Below the confidence
 * threshold the router refuses to guess and the prompt is 'other' (the
 * chat falls back to the existing agent runtime / disambiguation flow).
 */
import {
  classifyIntent,
  INTENT_CONFIDENCE_THRESHOLD,
} from '../agent/intentRouter.js';

export type ChatIntentRoute = 'app-generation' | 'analysis' | 'other';

/**
 * Route a chat prompt: 'app-generation' for React-app requests (handled by
 * the app lane — never the analysis pipeline), 'analysis' for
 * data-analysis/visualization requests (this component), 'other' for
 * everything else (including ambiguous prompts the router won't guess on).
 */
export function routeChatIntent(text: string): ChatIntentRoute {
  const c = classifyIntent(text);
  if (c.confidence < INTENT_CONFIDENCE_THRESHOLD) return 'other';
  if (c.kind === 'app') return 'app-generation';
  if (c.kind === 'analysis') return 'analysis';
  return 'other';
}

/** True when the prompt is an analytical request for this component. */
export function isAnalysisPrompt(text: string): boolean {
  return routeChatIntent(text) === 'analysis';
}
