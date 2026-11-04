/**
 * Chat intent router (ai-agent.md §5; user spec 2026-10-18 "INTENT ROUTING").
 *
 * Every chat prompt is classified into exactly one pipeline BEFORE
 * any generation happens:
 *
 *   (a) APP GENERATION — React code ONLY (frontend). MCP is the backend.
 *       The app opens inside/side of the chat next to the spreadsheet with a
 *       fullscreen-expand option, is saved as a persistent chat artifact,
 *       and reads/writes two-way live through MCP tools.
 *   (b) DATA ANALYSIS / VISUALIZATION — routed to the data-analysis
 *       component: AI generates Python from the data schema + intent, the
 *       script runs deterministically, and produces a Chart.js visual spec
 *       which is rendered (100% Excel visual parity).
 *   (c) CONVERSATION — everything else goes to the existing agent runtime.
 *   (d) NATIVE CHART — an explicit request for a chart placed IN the sheet
 *       ("chart Month vs Revenue in this sheet", "add a column chart to
 *       the Sales sheet", "a native chart in the sheet itself"). This is
 *       NOT a fourth generation lane: it dispatches through the existing
 *       conversation port (the agent runtime), whose planner maps the
 *       explicit in-sheet wording to the `create_chart` MCP tool (the
 *       chart-routes contract in openaiBackend.ts) — the chart lands in
 *       the workbook, persists, and saves with the file. It needed its
 *       own route because the analysis lane produces only an ephemeral
 *       Chart.js visual in the chat and the app lane produces a React
 *       app: neither can satisfy an in-sheet chart request, and routing
 *       such a request to either is a dead end (case-4 re-run, W3).
 *   (e) NATIVE DIAGRAM — an explicit request for a diagram placed IN
 *       the sheet ("create a diagram in the sheet", "insert a diagram
 *       into the Sales sheet"). This dispatches to the DiagramPort the
 *       web shell registers: the shell derives a diagram spec from the
 *       prompt (no LLM) and inserts it through the same addPicture path
 *       the Insert > SmartArt dialog uses, so the diagram lands in the
 *       sheet as a picture (#126). It does NOT go through the runtime
 *       turn — no planner tool can create an in-sheet diagram, so a
 *       planner-gated diagram route would dead-end like the old gap.
 *
 * The two pipelines share the chat UI and the MCP substrate, but their
 * generation paths are completely separate: the router enforces the
 * separation at the type level —
 *   - the app path's result type has NO python/backend field
 *     (asserted below by _AppKeepsNoPython), and
 *   - the analysis path's result type has NO reactSource field
 *     (asserted below by _AnalysisKeepsNoReact).
 * If a future change contaminates either path, `npx tsc` fails.
 *
 * The artifact-generation lane (AppGenerationPort) and the analysis lane
 * (AnalysisPort, the `analyze_data` MCP tool) are built by sibling lanes.
 * This module defines the narrow dispatch seams they implement; the router
 * does NOT block on their files. Until a lane registers its port, dispatch
 * returns `{ route: 'unavailable' }` so the chat can say so honestly.
 */
export type IntentKind = 'app' | 'analysis' | 'chart' | 'diagram' | 'conversation';

/** Heuristic classification of a chat prompt, with explainable signals. */
export interface IntentClassification {
  kind: IntentKind;
  /** 0..1. See INTENT_CONFIDENCE_THRESHOLD for the routing semantics. */
  confidence: number;
  /** Matched signal keywords, for explainability/debugging. */
  signals: string[];
}

/**
 * Confidence threshold for routing a prompt without asking.
 *
 * Chosen value: 0.45.
 * Why: with the normalization confidence = winner / (winner + 2 + loser),
 *   - a lone weak signal (score 1) scores 1/3 ≈ 0.33 < 0.45 → never routes
 *     alone; the router asks instead of guessing.
 *   - a lone moderate signal (score 2) scores 2/4 = 0.50 → routes.
 *   - conflicting signals (e.g. "chart this as an app": app 3 vs analysis 3
 *     → 3/8 = 0.375) stay below the bar → disambiguate rather than guess.
 *   - a clear winner against weak opposition (e.g. 7 vs 3 → 7/12 ≈ 0.58)
 *     routes without asking.
 *
 * Zero-signal prompts never disambiguate: "everything else goes to the
 * existing agent runtime" (spec (c)), so the fallback is 'conversation'
 * with confidence 1.0 — disambiguation is reserved for prompts that smell
 * like app/analysis but are too weak or too conflicted to act on.
 */
export const INTENT_CONFIDENCE_THRESHOLD = 0.45;

interface Signal {
  pattern: RegExp;
  /** Canonical keyword reported in `signals` for explainability. */
  label: string;
  /** Match weight. 1 = weak (can never route alone), 2 = moderate, 3 = strong. */
  weight: number;
}

const APP_SIGNALS: Signal[] = [
  { pattern: /\bapps?\b/, label: 'app', weight: 3 },
  { pattern: /\bbuild me\b/, label: 'build me', weight: 2 },
  { pattern: /\bbuild(?:s|ing)?\b/, label: 'build', weight: 1 },
  { pattern: /\bcreat(?:e[sd]?|ing)\b/, label: 'create', weight: 2 },
  { pattern: /\bsortable\b/, label: 'sortable', weight: 2 },
  { pattern: /\bdashboards?\b/, label: 'dashboard', weight: 2 },
  { pattern: /\bforms?\b/, label: 'form', weight: 2 },
  { pattern: /\binterfaces?\b/, label: 'interface', weight: 2 },
  { pattern: /\btools?\b/, label: 'tool', weight: 1 },
  { pattern: /\bmake\b/, label: 'make', weight: 1 },
  { pattern: /\bdesign\b/, label: 'design', weight: 1 },
];

const ANALYSIS_SIGNALS: Signal[] = [
  { pattern: /\banalyz\w*/, label: 'analyze', weight: 2 },
  { pattern: /\bdiagrams?\b/, label: 'diagram', weight: 3 },
  { pattern: /\bcharts?\b/, label: 'chart', weight: 3 },
  { pattern: /\bpivots?\b/, label: 'pivot', weight: 3 },
  { pattern: /\bforecast\w*/, label: 'forecast', weight: 2 },
  { pattern: /\btrends?\b/, label: 'trend', weight: 2 },
  { pattern: /\bcorrelations?\b/, label: 'correlation', weight: 2 },
  { pattern: /\bdistributions?\b/, label: 'distribution', weight: 2 },
  { pattern: /\bvisualiz\w*/, label: 'visualize', weight: 2 },
  { pattern: /\bplots?\b/, label: 'plot', weight: 2 },
  { pattern: /\bgraphs?\b/, label: 'graph', weight: 2 },
  { pattern: /\bshow\b/, label: 'show', weight: 1 },
  // Data-analysis grammar verbs (analysis lane): summarize/describe,
  // aggregate/group-by, distribution, correlation, compare, top-N/ranking.
  // Moderate weight: a lone verb routes (2/4 = 0.50 >= threshold), matching
  // the existing moderate signals above.
  { pattern: /\bhistograms?\b/, label: 'histogram', weight: 2 },
  { pattern: /\btop\s?\d+\b/, label: 'top-N', weight: 2 },
  { pattern: /\brank\w*\b/, label: 'rank', weight: 2 },
  // "summary"/"summaries" are not analysis verbs (e.g. "rename this sheet
  // to Summary"), so only the -ize/-ise verb forms match.
  { pattern: /\bsummari[sz]\w*\b/, label: 'summarize', weight: 2 },
  { pattern: /\bstatistics?\b/, label: 'statistics', weight: 2 },
  { pattern: /\bgroup\s+by\b/, label: 'group by', weight: 2 },
  { pattern: /\bcompar\w*\b/, label: 'compare', weight: 2 },
];

function scoreSignals(prompt: string, signals: Signal[]): { score: number; matched: string[] } {
  const matched: string[] = [];
  let score = 0;
  for (const s of signals) {
    if (s.pattern.test(prompt)) {
      score += s.weight;
      matched.push(s.label);
    }
  }
  return { score, matched };
}

/**
 * Explicit native-chart intent (W3): the prompt names a chart AND places
 * it in the sheet/workbook. The placement cues mirror the planner's own
 * chart-routes contract (openaiBackend.ts: "chart in the sheet" / "add a
 * chart to the sheet" / "insert chart" → create_chart), so the router and
 * the planner agree on what counts as explicit.
 *
 * An explicit app request is NOT a native-chart request even when the app
 * would contain a chart ("build an app with a chart in the sheet"): the
 * app noun is the object of the build verb there, so the app lane keeps
 * it (the disambiguation / app routing decides, as before).
 */
export function hasExplicitNativeChartIntent(prompt: string): boolean {
  const text = prompt.toLowerCase();
  if (!/\b(?:charts?|graphs?|plots?)\b/.test(text)) return false;
  // "build/create/make/design … app" — the app is the requested object.
  if (/\b(?:build|create|make|design|develop)\b[^.?!]{0,40}\bapps?\b/.test(text)) return false;
  // "a native chart" is explicit on its own.
  if (/\bnative\s+(?:\w+\s+)?charts?\b/.test(text)) return true;
  // Placement: chart placed in/into/on/to (the|this) (Name) sheet|workbook.
  if (
    /\b(?:in|into|onto|on|to)\s+(?:the\s+|this\s+|that\s+)?(?:\w+\s+)?(?:sheet|workbook)\b/.test(text)
  ) {
    return true;
  }
  // Insertion verb + chart + a sheet/workbook mention anywhere
  // ("add a column chart of Month vs Revenue to the Sales sheet" is
  // already caught above; this covers "insert a chart for the sheet").
  if (
    /\b(?:add|insert|put|place|create)\b[^.?!]{0,60}\bcharts?\b/.test(text) &&
    /\b(?:sheet|workbook)\b/.test(text)
  ) {
    return true;
  }
  return false;
}

/** True when a prompt mentions a chart-like visual (for disambiguation
 *  option construction — a chart option is offered only when a chart is
 *  actually in play). */
export function mentionsChart(prompt: string): boolean {
  return /\b(?:charts?|graphs?|plots?)\b/.test(prompt.toLowerCase());
}

/**
 * Explicit in-sheet DIAGRAM intent (#126): a request for a diagram placed
 * IN the sheet itself ("create a diagram in the sheet", "insert a diagram
 * into the Sales sheet", "a native diagram in the sheet"). Mirrors
 * hasExplicitNativeChartIntent: the same placement/insertion grammar,
 * the same app-object guard ("build an app with a diagram" stays an app
 * request — the app is the requested object there).
 *
 * A bare "show me a diagram" with no placement is NOT explicit: it stays
 * an analysis request (chat-side visual), exactly as before.
 */
export function hasExplicitNativeDiagramIntent(prompt: string): boolean {
  const text = prompt.toLowerCase();
  if (!/\b(?:diagrams?|smartart)\b/.test(text)) return false;
  // "build/create/make/design … app" — the app is the requested object.
  if (/\b(?:build|create|make|design|develop)\b[^.?!]{0,40}\bapps?\b/.test(text)) return false;
  // "a native diagram" is explicit on its own.
  if (/\bnative\s+(?:\w+\s+)?diagrams?\b/.test(text)) return true;
  // Placement: diagram placed in/into/onto/on/to (the|this) (Name) sheet|workbook.
  if (
    /\b(?:in|into|onto|on|to)\s+(?:the\s+|this\s+|that\s+)?(?:\w+\s+)?(?:sheet|workbook)\b/.test(text)
  ) {
    return true;
  }
  // Insertion verb + diagram + a sheet/workbook mention anywhere.
  if (
    /\b(?:add|insert|put|place|create)\b[^.?!]{0,60}\bdiagrams?\b/.test(text) &&
    /\b(?:sheet|workbook)\b/.test(text)
  ) {
    return true;
  }
  return false;
}

/** True when a prompt mentions a diagram (for disambiguation options). */
export function mentionsDiagram(prompt: string): boolean {
  return /\b(?:diagrams?|smartart)\b/.test(prompt.toLowerCase());
}

/**
 * Heuristic classifier: scores app signals and analysis signals against the
 * lowercased prompt, takes the winner, and reports confidence as
 * winner / (winner + 2 + loser). Matched keywords land in `signals`.
 *
 * Explicit native-chart intent is checked FIRST and is never ambiguous:
 * sheet placement is a strong, unambiguous signal (the same reasoning the
 * header gives the zero-signal fallback) — a prompt that says where the
 * chart goes has nothing to disambiguate, so it routes at confidence 1.
 */
export function classifyIntent(prompt: string): IntentClassification {
  const text = prompt.toLowerCase();
  if (hasExplicitNativeChartIntent(text)) {
    const analysis = scoreSignals(text, ANALYSIS_SIGNALS);
    return { kind: 'chart', confidence: 1, signals: ['native-chart', ...analysis.matched] };
  }
  if (hasExplicitNativeDiagramIntent(text)) {
    const analysis = scoreSignals(text, ANALYSIS_SIGNALS);
    return { kind: 'diagram', confidence: 1, signals: ['native-diagram', ...analysis.matched] };
  }
  const app = scoreSignals(text, APP_SIGNALS);
  const analysis = scoreSignals(text, ANALYSIS_SIGNALS);

  if (app.score === 0 && analysis.score === 0) {
    // Spec (c): no intent smell at all → existing agent runtime, no question.
    return { kind: 'conversation', confidence: 1, signals: [] };
  }
  const appWins = app.score >= analysis.score;
  const winner = appWins ? app : analysis;
  const loser = appWins ? analysis : app;
  const confidence = winner.score / (winner.score + 2 + loser.score);
  return {
    kind: appWins ? 'app' : 'analysis',
    confidence,
    signals: [...winner.matched, ...loser.matched],
  };
}

/** True when the classifier matched something but is too unsure to act. */
export function isAmbiguous(classification: IntentClassification): boolean {
  if (classification.signals.length === 0) return false; // pure-conversation fallback never asks
  return classification.confidence < INTENT_CONFIDENCE_THRESHOLD;
}

/** The clarifying question shown when a prompt is ambiguous (spec step 2). */
export const DISAMBIGUATION_QUESTION =
  'Do you want me to build an app, or analyze the data and show a visual?';

/**
 * The clarifying question for ambiguous prompts that mention a chart:
 * the native-chart outcome is named explicitly, because without it a
 * chart request could only pick lanes that can never produce a chart in
 * the sheet (W3 dead end).
 */
export const DISAMBIGUATION_QUESTION_WITH_CHART =
  'Do you want a native chart in the sheet, an app, or an analysis visual in the chat?';

/** Option buttons for the disambiguation question (existing ask mechanism). */
export const DISAMBIGUATION_OPTIONS = [
  'Build an app',
  'Analyze & visualize',
  'Just answer',
] as const;

/** The native-chart disambiguation option (W3). Offered FIRST whenever
 *  the ambiguous prompt mentions a chart, so the in-sheet outcome the
 *  native chart path serves is always reachable from the question. */
export const NATIVE_CHART_OPTION = 'Native chart in sheet';

/** The native-diagram disambiguation option (#126). Offered whenever an
 *  ambiguous prompt mentions a diagram, so the in-sheet outcome is always
 *  reachable from the question — same rule as the native-chart option. */
export const NATIVE_DIAGRAM_OPTION = 'Diagram in sheet';

/** Option buttons for an ambiguous prompt, given the original prompt.
 *  Chart-mentioning prompts get the native-chart option first, diagram-
 *  mentioning prompts get the native-diagram option; all other ambiguous
 *  prompts keep the original three options. Every option here resolves
 *  through resolveDisambiguation to a live route — no offered branch
 *  may dead-end. */
export function disambiguationOptionsFor(prompt: string): readonly string[] {
  const options: string[] = [];
  if (mentionsChart(prompt)) options.push(NATIVE_CHART_OPTION);
  if (mentionsDiagram(prompt)) options.push(NATIVE_DIAGRAM_OPTION);
  return [...options, ...DISAMBIGUATION_OPTIONS];
}

/** The disambiguation question matching disambiguationOptionsFor(). */
export function disambiguationQuestionFor(prompt: string): string {
  return mentionsChart(prompt) ? DISAMBIGUATION_QUESTION_WITH_CHART : DISAMBIGUATION_QUESTION;
}

export type DisambiguationOption = (typeof DISAMBIGUATION_OPTIONS)[number];

/**
 * Maps a disambiguation answer back to an intent. Returns null for an
 * unrecognized answer (caller should re-ask or fall back to conversation).
 */
export function resolveDisambiguation(answer: string): IntentKind | null {
  const t = answer.trim().toLowerCase();
  if (t === 'build an app') return 'app';
  if (t === 'analyze & visualize') return 'analysis';
  if (t === 'just answer') return 'conversation';
  if (
    t === NATIVE_CHART_OPTION.toLowerCase() ||
    t === 'add a native chart to the sheet' ||
    t === 'native chart'
  ) {
    return 'chart';
  }
  if (
    t === NATIVE_DIAGRAM_OPTION.toLowerCase() ||
    t === 'add a diagram to the sheet' ||
    t === 'native diagram'
  ) {
    return 'diagram';
  }
  return null;
}

/** Extra context handed to a route (active sheet/range for the analysis path). */
export interface RoutingContext {
  sheet?: string;
  range?: string;
}

/** The router's decision for one prompt. Never guesses: ambiguous prompts
 *  come back as 'disambiguate' so the caller can use the existing
 *  human-in-the-loop ask mechanism (ai-agent.md §12). */
export type IntentRoute =
  | { route: 'app'; classification: IntentClassification }
  | {
      route: 'analysis';
      classification: IntentClassification;
      range?: string;
      /**
       * #135: the client's active sheet, carried into the analysis lane
       * so its data read uses the sheet the user is on — never a
       * hardcoded default. Absent = the lane falls back to the
       * workbook's first sheet.
       */
      sheet?: string;
    }
  | { route: 'chart'; classification: IntentClassification }
  | { route: 'diagram'; classification: IntentClassification }
  | { route: 'conversation'; classification: IntentClassification }
  | {
      route: 'disambiguate';
      classification: IntentClassification;
      question: string;
      options: readonly string[];
    };

export function routePrompt(prompt: string, ctx: RoutingContext = {}): IntentRoute {
  const classification = classifyIntent(prompt);
  if (isAmbiguous(classification)) {
    return {
      route: 'disambiguate',
      classification,
      question: disambiguationQuestionFor(prompt),
      options: disambiguationOptionsFor(prompt),
    };
  }
  switch (classification.kind) {
    case 'app':
      return { route: 'app', classification };
    case 'analysis':
      return {
        route: 'analysis',
        classification,
        range: ctx.range,
        // #135: carry the client's active sheet into the analysis lane
        // (previously dropped here, so the lane fell back to a
        // hardcoded default that may not exist in the workbook).
        ...(ctx.sheet ? { sheet: ctx.sheet } : {}),
      };
    case 'chart':
      return { route: 'chart', classification };
    case 'diagram':
      return { route: 'diagram', classification };
    case 'conversation':
      return { route: 'conversation', classification };
  }
}

// ---------------------------------------------------------------------------
// Scope gate (user directive 2026-10-21, BRIEF addendum §2): the agent
// answers ONLY spreadsheet / data / product-related requests. This is the
// deterministic first layer, enforced by AgentRuntime BEFORE any planner
// or tool activity; the planner system prompt carries the same rule as a
// second layer for phrasings that slip this gate.
//
// CONSERVATIVE BY DESIGN: ambiguity resolves to 'in-scope'. Legitimate
// spreadsheet use must never break, so the classifier only returns
// 'off-topic' for prompts that (a) carry NO in-scope anchor at all and
// (b) match a known off-topic family (weather, news, sports, trivia /
// general knowledge, jokes, general writing, translation, general coding
// help unrelated to the sheet). Anything unrecognized is in scope.
//
// TIGHTENED SCOPE (user directive 2026-10-21 17:40 PDT, FIX-J): the agent
// answers ONLY from (1) data in context via its tools and (2)
// icecream-sheets product knowledge. ALL general knowledge therefore
// declines identically — general-fact questions ("Who is Einstein?",
// "What is the capital of France?", "How tall is the Eiffel Tower?"),
// trivia / fun-fact requests, and substantive chit-chat ("How's your
// day going?") are off-topic families below. Bare greetings directed at
// the agent ("hi", "thanks") stay in scope: they are conversation WITH
// the product, not a request for outside knowledge.
// ---------------------------------------------------------------------------

export type ScopeVerdict = 'in-scope' | 'off-topic';

/**
 * Greetings and small talk DIRECTED AT THE AGENT are in scope (the user
 * is talking to the product, not asking a general question): a bare "hi"
 * is handled politely by the backend — an LLM backend answers in kind.
 * This pattern only matches when the prompt is essentially JUST the
 * greeting/acknowledgement, or explicitly asks the agent about itself.
 */
const AGENT_DIRECTED_PATTERN =
  /^(?:hi|hiya|hello|hey|howdy|yo|greetings|good\s+(?:morning|afternoon|evening)|what'?s\s+up|thanks|thank\s+you|thx|bye|goodbye|ok|okay|sure|yes|no|please|help)[\s!.,?]*$/i;
const AGENT_SELF_PATTERN =
  /\b(?:what can you do|who are you|your (?:name|capabilities|abilities)|introduce yourself|what are you able to do|how can you help)\b/i;

/**
 * In-scope anchors, in two tiers. STRONG anchors (concrete spreadsheet /
 * data / product nouns) make the prompt in scope even if it also mentions
 * an off-topic domain ("analyze the weather data in this table" is a data
 * request). WEAK anchors (bare action verbs) also resolve to in-scope,
 * but only AFTER the general-coding check: "sort a list in python" is a
 * coding question, while "sort the Sales column" never reaches that check
 * because its strong anchors matched first.
 */
const STRONG_IN_SCOPE_ANCHORS: RegExp[] = [
  // A1-style cell / range references (A1, B2, Sheet1!A1:B2, Q9, ...).
  /\b[a-z]{1,3}\d{1,7}(?::[a-z]{1,3}\d{1,7})?\b/i,
  // Spreadsheet / workbook vocabulary.
  /\b(?:sheets?|workbooks?|spreadsheets?|cells?|columns?|rows?|ranges?|formulas?|pivots?|charts?|tables?|grids?|tabs?)\b/i,
  // The data itself and its container formats / sources.
  /\b(?:data|dataset|database|csv|xlsx|excel|sql|query|queries|records?|fields?|values?|numbers?|revenue|sales|budget|expenses?|inventory|orders?|products?|customers?|invoices?|prices?|costs?)\b/i,
  // App / report / automation / ETL / add-on lanes (the wider five).
  /\b(?:apps?|dashboards?|reports?|automations?|automat\w+|etl|pipelines?|workflows?|triggers?|add-?ons?|plugins?|extensions?|data sources?|connectors?|app builder|no-?code)\b/i,
  // ETL recipe in data context (a bare cooking "recipe" is handled below).
  /\brecipes?\b[^.?!]{0,60}\b(?:etl|load|run|source|sheet|data|import)\b|\b(?:etl|data|load|import)\b[^.?!]{0,60}\brecipes?\b/i,
  // Memory requests.
  /\b(?:remember|recall|forget|my notes|you (?:remember|saved|noted))\b/i,
  // Product anchors: the product itself, "in this app", product how-to
  // whose object is a spreadsheet feature or the product surface.
  /\b(?:in this (?:app|product|sheet|workbook)|this app|icecream(?:\s+sheets)?)\b/i,
  /\bhow (?:do|can) i\b[^?]{0,80}\b(?:in this|this app|the app|icecream|sheets?|workbook|spreadsheet|grid|cells?|columns?|rows?|formulas?|charts?|pivots?|freeze|print|format|data)\b/i,
  // Follow-ups that lean on prior context ("now do the same for ...").
  /\b(?:the same|same (?:thing|for)|that one|those|these|second one|first one|third one|previous (?:one|result)|earlier (?:one|result)|what about|how about)\b/i,
  /^(?:and|also|now|then|so)\b/i,
];

const WEAK_IN_SCOPE_ANCHORS: RegExp[] = [
  // Core spreadsheet operations.
  /\b(?:sum|total|average|avg|count|recalculat\w*|sort|filter|merge|split|transpose|dedup\w*|import|export|freeze|unfreeze|format|formatting|conditional formatting|data validation|named range|dropdown|protect|unprotect)\b/i,
  // Analysis / visualization verbs.
  /\b(?:analy[sz]\w*|visualiz\w*|forecast|trend|correlat\w*|distribution|histogram|plot|graph|diagram|breakdown|summar\w*|compar\w*|rank\w*|group by)\b/i,
  // Building things (app lane phrasings). Deliberately verb-only: with no
  // object noun they are ambiguous, and ambiguity resolves to in-scope.
  /\b(?:build|create|design|develop|run|install|enable|set up|setup)\b/i,
];

/**
 * Weather is special: it is an off-topic family, but weather DATA in a
 * sheet is a legitimate data request. A weather prompt is off-topic only
 * when it has no sheet/data container anchor and no analysis verb.
 */
const WEATHER_PATTERN = /\b(?:weather|temperature outside|rainfall|snowfall|humidity|wind speed|sunny|cloudy|rain|snow)\b/i;
const WEATHER_DATA_ANCHOR =
  /\b(?:sheets?|workbooks?|spreadsheets?|cells?|columns?|rows?|ranges?|tables?|dataset|database|csv|analy[sz]\w*|chart|plot|graph|trend)\b/i;

/** Off-topic families. Only consulted when NO in-scope anchor matched. */
const OFF_TOPIC_PATTERNS: RegExp[] = [
  // News / current events.
  /\b(?:news|headlines?|current events|breaking news|latest headlines?)\b/i,
  // Sports results.
  /\b(?:who won|won the (?:game|match|championship|world cup|super bowl|series)|score (?:of|in) the (?:game|match)|football|basketball|baseball|soccer|hockey|nba|nfl|nhl|mlb|olympics|world cup|super bowl|grand prix)\b/i,
  // Jokes / creative writing / general prose.
  /\b(?:jokes?|riddles?|make me laugh|essays?|poems?|poetry|short stor\w+|song lyrics|cover letter|write (?:me )?(?:a|an|the) (?:essay|poem|story|song|letter|blog post))\b/i,
  // Translation as a standalone service.
  /\btranslat\w*\b/i,
  // Everyday life services unrelated to a sheet.
  /\b(?:recipe for|how to cook|book a (?:flight|hotel|ticket)|directions to|nearest (?:restaurant|store|pharmacy|cafe))\b/i,
  // General-knowledge factoids (world facts, public figures, history).
  /\b(?:president|prime minister|capital of|population of|currency of|tallest|highest mountain|longest river|who (?:is|was|are|were|invented|discovered|founded|wrote)|when (?:did|was|were)|what year)\b/i,
  // Measurement / attribute trivia about the world ("How tall is the
  // Eiffel Tower?"). Only reached with NO spreadsheet anchor, so a sheet
  // question ("how tall is row 3") never lands here — "rows" is a strong
  // anchor and wins earlier.
  /\bhow (?:tall|high|long|far|big|old|deep|heavy|fast|hot|cold) is (?:the|a|an|that|this)\b/i,
  // Trivia / fun-fact requests (FIX-J tightening).
  /\b(?:fun facts?|trivia|tell me (?:a |an )?(?:fun )?fact|facts? about|did you know)\b/i,
  // Substantive chit-chat about the agent's day/feelings (FIX-J
  // tightening). Distinct from the bare greetings in
  // AGENT_DIRECTED_PATTERN, which stay in scope.
  /\b(?:how(?:'s| is) your day|how are you (?:doing|feeling|today)|how(?:'s| is) it going|how(?:'s| is) your (?:morning|afternoon|evening|life|weekend))\b/i,
  // Time/date trivia.
  /\b(?:what time is it|what day is (?:it|today)|today's date)\b/i,
];

/**
 * General coding help: a programming language PLUS a coding artifact, with
 * no spreadsheet anchor (anchors are checked first, so "run python over
 * this data" never reaches here). "Write a formula ..." is saved by the
 * formula anchor above.
 */
const CODING_LANGUAGE_PATTERN =
  /\b(?:python|javascript|typescript|java|c\+\+|c#|rust|golang|ruby|php|swift|kotlin)\b/i;
const CODING_ARTIFACT_PATTERN =
  /\b(?:function|code|program|script|debug|compile|syntax|algorithm|reverse|sort a (?:list|array|string)|string|array|loop|regex|install|pip)\b/i;
const GENERIC_CODING_PATTERN =
  /\b(?:write|debug|fix|explain)\b[^.?!]{0,50}\b(?:code|function|program|script|bug|algorithm)\b/i;

/**
 * Deterministic scope classifier for the agent guardrail.
 *
 * Returns 'in-scope' for anything spreadsheet/data/product-related —
 * including every prompt family the intent router routes (app/analysis),
 * questions about the workbook's contents, product how-to questions,
 * memory requests, agent-directed greetings/small talk, and follow-ups
 * referencing prior context — and 'off-topic' only for clear
 * general-knowledge / general-service requests with no data or product
 * anchor. Ambiguity resolves to 'in-scope'.
 */
export function classifyScope(prompt: string): ScopeVerdict {
  const text = prompt.trim().toLowerCase();
  if (text.length === 0) return 'in-scope';

  // Greetings / agent-directed small talk: polite product conversation.
  if (AGENT_DIRECTED_PATTERN.test(text) || AGENT_SELF_PATTERN.test(text)) return 'in-scope';

  // Weather questions are off-topic unless they are about weather DATA.
  if (WEATHER_PATTERN.test(text) && !WEATHER_DATA_ANCHOR.test(text)) return 'off-topic';

  // Strong anchors win over every off-topic family below.
  for (const anchor of STRONG_IN_SCOPE_ANCHORS) {
    if (anchor.test(text)) return 'in-scope';
  }

  // General coding help (language + artifact, or a generic write/debug
  // the-code phrasing) is off-topic — checked before the weak verb
  // anchors so "sort a list in python" is not saved by the verb "sort".
  if (CODING_LANGUAGE_PATTERN.test(text) && CODING_ARTIFACT_PATTERN.test(text)) return 'off-topic';
  if (GENERIC_CODING_PATTERN.test(text)) return 'off-topic';

  // Weak verb anchors and any app/analysis intent signal: in scope.
  for (const anchor of WEAK_IN_SCOPE_ANCHORS) {
    if (anchor.test(text)) return 'in-scope';
  }
  if (classifyIntent(text).signals.length > 0) return 'in-scope';

  for (const pattern of OFF_TOPIC_PATTERNS) {
    if (pattern.test(text)) return 'off-topic';
  }

  // Conservative default: unrecognized prompts are treated as legitimate
  // spreadsheet use, never declined on a guess.
  return 'in-scope';
}

// ---------------------------------------------------------------------------
// Dispatch seams for the pipeline lanes (built by sibling lanes).
// ---------------------------------------------------------------------------

/** Persistent chat artifact metadata (AI-GENERATED APP PATTERN, 2026-10-18). */
export interface AppArtifactMeta {
  title: string;
  createdAt: number;
  /**
   * Id of the saved ArtifactSpec in the service metadata store, when the
   * app-artifact lane persisted it. The chat UI uses it to re-open the
   * full spec (source + binding) in the embedded viewer.
   */
  artifactId?: string;
}

export interface AppGenerationRequest {
  prompt: string;
}

export interface AppGenerationResult {
  /**
   * React source, FRONTEND ONLY. MCP is the backend: the generated app reads
   * and writes exclusively through MCP tools. Two-way live binding via MCP.
   *
   * This type deliberately has NO `pythonSource` / `backend` field — the app
   * generation path NEVER produces Python or backend code. The compile-time
   * assertion `_AppKeepsNoPython` below turns contamination into a tsc error.
   */
  reactSource: string;
  /** The saved chat artifact (persistent, expandable side-by-side panel). */
  artifactMeta: AppArtifactMeta;
}

/** Implemented by the app-artifact pipeline lane (the AppGenerator). */
export interface AppGenerationPort {
  generateApp(req: AppGenerationRequest): Promise<AppGenerationResult>;
}

export interface AnalysisRequest {
  prompt: string;
  range?: string;
  /**
   * #135: the client's active sheet. The lane reads this sheet when
   * given; without it (or without a sheet in `range`) it falls back
   * to the workbook's first sheet — never a hardcoded name.
   */
  sheet?: string;
}

/** The Chart.js visual spec the deterministic analysis pipeline produces. */
export interface ChartJsVisualSpec {
  type: string;
  data: Record<string, unknown>;
  options?: Record<string, unknown>;
}

export interface AnalysisResult {
  /** Human-readable summary of what the deterministic run found. */
  analysis: string;
  /**
   * Chart.js visual spec → rendered (100% Excel visual parity).
   *
   * This type deliberately has NO `reactSource` field — the analysis path
   * NEVER generates React apps. The compile-time assertion
   * `_AnalysisKeepsNoReact` below turns contamination into a tsc error.
   */
  chartSpec: ChartJsVisualSpec;
}

/** Implemented by the data-analysis pipeline lane (the `analyze_data` MCP tool). */
export interface AnalysisPort {
  analyze(req: AnalysisRequest): Promise<AnalysisResult>;
}

/**
 * Result of creating one diagram inside the sheet (#126). The diagram
 * itself is a picture in the sheet (same object the Insert > SmartArt
 * dialog inserts); this result only describes it for the chat reply.
 */
export interface DiagramCreationResult {
  /** Human title, e.g. "Process diagram". */
  title: string;
  /** Layout id, e.g. "process". */
  layout: string;
  /** Number of node labels placed. */
  itemCount: number;
}

/**
 * Implemented by the web shell (#126): derives a diagram spec from the
 * prompt (diagramSpec.ts, no LLM) and inserts it through the same
 * addPicture path the Insert > SmartArt dialog uses.
 */
export interface DiagramPort {
  createDiagram(req: { prompt: string }): Promise<DiagramCreationResult>;
}

// ---------------------------------------------------------------------------
// Compile-time pipeline separation (user spec: "The router enforces this
// separation"). If either result type ever gains a forbidden field, tsc
// fails here — the two generation paths can never cross-contaminate.
// ---------------------------------------------------------------------------
type ForbiddenFields<T, Forbidden extends string> = Extract<keyof T, Forbidden> extends never
  ? true
  : false;

type _AppKeepsNoPython = ForbiddenFields<AppGenerationResult, 'pythonSource' | 'python' | 'backend'>;
type _AnalysisKeepsNoReact = ForbiddenFields<AnalysisResult, 'reactSource' | 'react'>;
const _separationCheck1: _AppKeepsNoPython = true;
const _separationCheck2: _AnalysisKeepsNoReact = true;

// ---------------------------------------------------------------------------
// Dispatch.
// ---------------------------------------------------------------------------

/** Ports the router can dispatch to. The conversation port (existing agent
 *  runtime turn) is required; the pipeline ports are optional until their
 *  sibling lanes register implementations. */
export interface IntentPorts {
  appGeneration?: AppGenerationPort;
  analysis?: AnalysisPort;
  diagram?: DiagramPort;
  conversation: (prompt: string) => Promise<string>;
}

/** Registry where the pipeline lanes publish their ports. */
const portRegistry: {
  appGeneration?: AppGenerationPort;
  analysis?: AnalysisPort;
  diagram?: DiagramPort;
} = {};

/**
 * Called by the app-artifact lane (AppGenerator) and the data-analysis lane
 * (`analyze_data`) when they land. The router dispatches to whatever is
 * registered; nothing here changes when a lane lands.
 */
export function registerIntentPorts(ports: {
  appGeneration?: AppGenerationPort;
  analysis?: AnalysisPort;
  diagram?: DiagramPort;
}): void {
  if (ports.appGeneration) portRegistry.appGeneration = ports.appGeneration;
  if (ports.analysis) portRegistry.analysis = ports.analysis;
  if (ports.diagram) portRegistry.diagram = ports.diagram;
}

/**
 * Remove previously registered pipeline ports. #135: the web app
 * unregisters the in-browser analysis port when it enters gateway
 * mode — that port was registered by an in-process MCP server bound
 * to the pre-gateway (blank) engine, and left registered it shadows
 * the service chat turn (which binds the open file's live session).
 * Local mode re-registers on the next createServer call.
 */
export function unregisterIntentPorts(ports: {
  appGeneration?: boolean;
  analysis?: boolean;
  diagram?: boolean;
}): void {
  if (ports.appGeneration) delete portRegistry.appGeneration;
  if (ports.analysis) delete portRegistry.analysis;
  if (ports.diagram) delete portRegistry.diagram;
}

/** Snapshot of the currently registered pipeline ports. */
export function getIntentPorts(): {
  appGeneration?: AppGenerationPort;
  analysis?: AnalysisPort;
  diagram?: DiagramPort;
} {
  return { ...portRegistry };
}

export type IntentDispatchResult =
  | { route: 'app'; result: AppGenerationResult }
  | { route: 'analysis'; result: AnalysisResult }
  | { route: 'chart'; message: string }
  | { route: 'diagram'; result: DiagramCreationResult }
  | { route: 'conversation'; message: string }
  | { route: 'disambiguate'; question: string; options: readonly string[] }
  | { route: 'unavailable'; requested: 'app' | 'analysis' | 'diagram'; reason: string };

/**
 * Executes a route against the given ports.
 *
 * - 'app' → AppGenerationPort.generateApp({ prompt })
 * - 'analysis' → AnalysisPort.analyze({ prompt, range })
 * - 'chart' → existing agent runtime turn (the conversation port): the
 *   planner maps the explicit in-sheet chart wording to the
 *   `create_chart` tool, which creates the native chart in the sheet.
 *   There is deliberately NO separate chart port — the runtime turn IS
 *   the native-chart path (W3).
 * - 'diagram' → DiagramPort.createDiagram({ prompt }): the shell derives
 *   a diagram spec from the prompt (no LLM) and inserts it through the
 *   same addPicture path the Insert > SmartArt dialog uses, so the
 *   diagram lands in the sheet as a picture (#126). Unlike 'chart',
 *   this does NOT go through the runtime turn — the planner cannot
 *   create an in-sheet diagram (no such tool exists), so a planner-
 *   gated diagram route would dead-end exactly like the old gap.
 * - 'conversation' → existing agent runtime turn
 * - 'disambiguate' → passes the clarifying question through (the caller
 *   renders it via the existing human-in-the-loop ask mechanism)
 * - pipeline port missing → 'unavailable' (sibling lane hasn't landed yet)
 */
export async function dispatchIntent(
  route: IntentRoute,
  ports: IntentPorts,
  prompt: string,
): Promise<IntentDispatchResult> {
  switch (route.route) {
    case 'disambiguate':
      return { route: 'disambiguate', question: route.question, options: route.options };
    case 'app': {
      if (!ports.appGeneration) {
        return {
          route: 'unavailable',
          requested: 'app',
          reason:
            'This looks like an app request, but the app-generation pipeline is not wired up yet.',
        };
      }
      const result = await ports.appGeneration.generateApp({ prompt });
      return { route: 'app', result };
    }
    case 'analysis': {
      if (!ports.analysis) {
        return {
          route: 'unavailable',
          requested: 'analysis',
          reason:
            'This looks like a data-analysis request, but the analysis pipeline is not wired up yet.',
        };
      }
      const result = await ports.analysis.analyze({
        prompt,
        range: route.range,
        ...(route.sheet ? { sheet: route.sheet } : {}),
      });
      return { route: 'analysis', result };
    }
    case 'chart': {
      const message = await ports.conversation(prompt);
      return { route: 'chart', message };
    }
    case 'diagram': {
      if (!ports.diagram) {
        return {
          route: 'unavailable',
          requested: 'diagram',
          reason:
            'This looks like an in-sheet diagram request, but the diagram pipeline is not wired up yet.',
        };
      }
      const result = await ports.diagram.createDiagram({ prompt });
      return { route: 'diagram', result };
    }
    case 'conversation': {
      const message = await ports.conversation(prompt);
      return { route: 'conversation', message };
    }
  }
}
