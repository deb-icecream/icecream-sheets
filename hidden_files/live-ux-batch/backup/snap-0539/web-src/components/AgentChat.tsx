/**
 * AI Agent chat panel (ai-agent.md §5: chat is one surface to the agent).
 *
 * - Converses with the AgentRuntime (which acts only through MCP tools).
 * - Renders human-in-the-loop questions with option buttons; the agent
 *   cannot proceed until the user answers (§12).
 * - "Audit" view exposes the agent's audit trail (§4: the log is visible
 *   to the user).
 * - "Watch" toggle: proactive event subscription on the active sheet.
 *   Fired events are rate-limited into a single notice (§6); the user can
 *   mute by toggling off. In gateway mode the watch runs through the agent
 *   service's wake loop and mute persists per user (see the settings gear).
 * - Settings gear: AI Agent settings dialog — model backend selection
 *   (§8) and proactive mute controls (§6).
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { AuditEntry, AgentChartAttachment, PendingAskView } from '@icecream-sheets/service';
import {
  ARTIFACT_SPEC_VERSION,
  classifyIntent,
  routePrompt,
  dispatchIntent,
  resolveDisambiguation,
  getIntentPorts,
  type ArtifactSpec,
  type IntentRoute,
  type McpCallFn,
  type MetadataStore,
} from '@icecream-sheets/service';
import type { AgentChatBackend } from '../services/remoteAgent';
import ChartCanvas from './ChartCanvas';
import AgentSettingsDialog from './AgentSettingsDialog';
import { ArtifactFrame, ArtifactLibrary } from './ArtifactHost';
import type { ChartConfiguration } from 'chart.js';

interface ChatMsg {
  id: number;
  role: 'user' | 'agent' | 'notice';
  text: string;
  /** Rendered visual from the data-analysis pipeline (spec + render request). */
  chart?: AgentChartAttachment;
}

interface AgentChatProps {
  /** Local AgentRuntime or the gateway-backed RemoteAgentBackend. */
  runtime: AgentChatBackend;
  sheet: string;
  onClose: () => void;
  /** Hide the Watch toggle. The gateway backend supports watch (§6); the host decides visibility. */
  watchSupported?: boolean;
  /** Chat-artifact store for generated apps (null hides the Apps tab). */
  artifactStore?: MetadataStore<ArtifactSpec> | null;
  /** MCP call fn for generated apps (null = local engine unavailable). */
  artifactMcpCall?: McpCallFn | null;
  /**
   * Shell integration: an external request to open an artifact in the
   * panel (the share recipient flow's Restore → working view). `seq`
   * makes repeat requests for the same artifact re-fire.
   */
  initialArtifactRequest?: { id: string; seq: number } | null;
  /**
   * Voice/chat merge (#41, design doc §7): the voice palette hands an
   * unmatched utterance to the agent — the panel opens with the words
   * already in the composer for the user to review and send. Seq-guarded
   * like the artifact request so repeat handoffs re-fire.
   */
  initialDraft?: { text: string; seq: number } | null;
}

let msgSeq = 1;

/** Proactive poll cadence (ai-agent.md §6: pings are rate-limited). */
const WATCH_POLL_MS = 5000;

/** Docked agent panel sizing (D5): min 280 px, max 60 vw; persisted. */
const AGENT_PANEL_MIN = 280;
const AGENT_PANEL_WIDTH_KEY = 'icecream.agentPanelWidth';

/**
 * The largest panel width the current viewport allows. The panel docks
 * at EVERY width (#39): on a phone the old formula (max(280, 60vw))
 * let a 340 px default — wider than the formula's own max — crush the
 * grid to a ~50 px sliver, which reads as the panel floating over the
 * sheet. The cap now also reserves a visible strip of grid (at least
 * ~150 px) so the sheet is always seen shrunk BESIDE the panel.
 */
function agentPanelMax(): number {
  if (typeof window === 'undefined') return 720;
  const vw = window.innerWidth;
  return Math.max(200, Math.min(Math.floor(vw * 0.6), vw - 150));
}

function clampAgentPanelWidth(w: number, toMax = false): number {
  const max = agentPanelMax();
  if (toMax) return max;
  const min = Math.min(AGENT_PANEL_MIN, max);
  return Math.min(Math.max(Math.round(w), min), max);
}

export default function AgentChat({
  runtime,
  sheet,
  onClose,
  watchSupported = true,
  artifactStore = null,
  artifactMcpCall = null,
  initialArtifactRequest = null,
  initialDraft = null,
}: AgentChatProps) {
  const [threadId] = useState(() => `web-${Date.now()}`);
  const [messages, setMessages] = useState<ChatMsg[]>([
    {
      id: msgSeq++,
      role: 'agent',
      text: 'Hi — I can read ranges, sum or average them, write values and formulas, recalculate, remember notes, and analyze data with charts ("analyze A1:D20 and show me a diagram", "forecast next quarter"). Everything I do goes through the same tools as any other client, and the audit log below shows each step.',
    },
  ]);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  /**
   * Human-in-the-loop asks (ai-agent.md §12): the agent's turn is parked
   * on an agent.ask_question / agent.offer_options / agent.request_approval
   * tool call until these are answered. Polled from the backend (the
   * agent.* MCP tools); answering unblocks the paused turn.
   */
  const [hitlAsks, setHitlAsks] = useState<PendingAskView[]>([]);
  /** Free-text answers and approval notes, keyed by ask id. */
  const [hitlText, setHitlText] = useState<Record<string, string>>({});
  const [hitlNote, setHitlNote] = useState<Record<string, string>>({});
  /** Router disambiguation (intentRouter.ts): shown inline, answered via option buttons. */
  const [intentPending, setIntentPending] = useState<{
    question: string;
    options: string[];
    prompt: string;
  } | null>(null);
  /** Generated-app artifact panel (the app-artifact lane mounts the real
   *  sandboxed React app here; the spec is resolved from the artifact
   *  store so the app is re-openable across sessions). */
  const [appArtifact, setAppArtifact] = useState<ArtifactSpec | null>(null);
  const [artifactExpanded, setArtifactExpanded] = useState(false);
  /** Chat | Apps tab. The Apps tab lists persistent chat artifacts. */
  // D5 (user ruling, 2026-10-22): the panel DOCKS in the layout — the
  // grid shrinks to make room, nothing floats over cells. The divider
  // is draggable (pointer) and keyboard-operable (separator role);
  // the chosen width persists across opens.
  const [panelWidth, setPanelWidth] = useState<number>(() => {
    try {
      const v = Number(localStorage.getItem(AGENT_PANEL_WIDTH_KEY));
      if (Number.isFinite(v) && v > 0) return clampAgentPanelWidth(v);
    } catch {
      /* storage unavailable */
    }
    // The default goes through the clamp too: an unclamped 340 px on a
    // phone viewport exceeds the panel max and swallows the grid (#39).
    return clampAgentPanelWidth(340);
  });
  useEffect(() => {
    try {
      localStorage.setItem(AGENT_PANEL_WIDTH_KEY, String(Math.round(panelWidth)));
    } catch {
      /* storage unavailable */
    }
  }, [panelWidth]);
  const panelMax = agentPanelMax();
  /** #35: the voice FAB is viewport-fixed (App-level); when this panel is
   * open it must anchor to the SPREADSHEET area's bottom-right — i.e.
   * immediately left of the docked footprint (chat + artifact panel).
   * Publish the rendered footprint as a CSS var the FAB offsets by; the
   * layout effect re-runs on every render (incl. each divider-drag
   * frame, via panelWidth) so the bubble tracks the drag exactly. */
  const chatRootRef = useRef<HTMLDivElement>(null);
  const artifactRootRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const root = document.documentElement;
    const w = (chatRootRef.current?.offsetWidth ?? 0) + (artifactRootRef.current?.offsetWidth ?? 0);
    const next = `${w}px`;
    if (root.style.getPropertyValue('--agent-dock-width') !== next) {
      root.style.setProperty('--agent-dock-width', next);
    }
  });
  useEffect(() => {
    return () => {
      document.documentElement.style.removeProperty('--agent-dock-width');
    };
  }, []);
  /** Gemini-style auto-grow composer (issue #25): the textarea grows with
      the draft up to the CSS max-height; beyond that it scrolls internally.
      A layout effect avoids a flash of the collapsed size; panelWidth in
      deps re-fits after the resizable divider moves. */
  const composerRef = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const el = composerRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [draft, panelWidth]);
  const onResizePointerDown = (e: React.PointerEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = panelWidth;
    document.body.classList.add('agent-resizing');
    const move = (ev: PointerEvent) => {
      setPanelWidth(clampAgentPanelWidth(startWidth + (startX - ev.clientX)));
    };
    const up = () => {
      document.body.classList.remove('agent-resizing');
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  const onResizeKeyDown = (e: React.KeyboardEvent) => {
    const step = e.shiftKey ? 64 : 16;
    if (e.key === 'ArrowLeft') {
      e.preventDefault();
      setPanelWidth((w) => clampAgentPanelWidth(w + step));
    } else if (e.key === 'ArrowRight') {
      e.preventDefault();
      setPanelWidth((w) => clampAgentPanelWidth(w - step));
    } else if (e.key === 'Home') {
      e.preventDefault();
      setPanelWidth(AGENT_PANEL_MIN);
    } else if (e.key === 'End') {
      e.preventDefault();
      setPanelWidth((w) => clampAgentPanelWidth(w, true));
    }
  };
  const [tab, setTab] = useState<'chat' | 'apps'>('chat');
  const [showAudit, setShowAudit] = useState(false);
  const [audit, setAudit] = useState<AuditEntry[]>([]);
  const [watching, setWatching] = useState(false);
  const [muted, setMuted] = useState(false);
  /** AI Agent settings dialog (model backend §8, proactive mute §6). */
  const [settingsOpen, setSettingsOpen] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const watchRef = useRef<{ subId: string | null; lastNotice: number }>({ subId: null, lastNotice: 0 });

  // Proactive mute (ai-agent.md §6): when the backend supports it, the
  // toggle persists per user server-side; the local flag still gates
  // notices in this session.
  useEffect(() => {
    if (!runtime.getProactiveMute) return;
    runtime
      .getProactiveMute()
      .then((m) => setMuted(m.mutedAll))
      .catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const toggleMuted = useCallback(() => {
    setMuted((m) => {
      const next = !m;
      if (runtime.setProactiveMute) {
        runtime.setProactiveMute({ mutedAll: next }).catch(() => undefined);
      }
      return next;
    });
  }, [runtime]);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [messages, hitlAsks, intentPending]);

  const refreshHitlAsks = useCallback(async () => {
    if (!runtime.listPendingAsks) return;
    try {
      setHitlAsks(await runtime.listPendingAsks());
    } catch {
      // Transient poll failure: keep the last known list.
    }
  }, [runtime]);

  // Poll the pending asks while the panel is open: a parked turn shows up
  // here and the user answers it inline (ai-agent.md §12).
  useEffect(() => {
    if (!runtime.listPendingAsks) return;
    void refreshHitlAsks();
    const timer = setInterval(() => void refreshHitlAsks(), 2000);
    return () => clearInterval(timer);
  }, [runtime, refreshHitlAsks]);

  /**
   * Answer a human-in-the-loop ask. Not gated on `busy`: the turn is
   * parked (busy) exactly while an ask is pending, and answering is what
   * unblocks it.
   */
  const answerHitl = async (ask: PendingAskView, answer: string) => {
    const note = hitlNote[ask.id]?.trim() || undefined;
    push(
      'user',
      ask.kind === 'approval' ? `${answer}${note ? ` — ${note}` : ''}` : answer,
    );
    try {
      await runtime.answerPendingAsk?.(ask.id, answer, note);
      setHitlText((m) => {
        const n = { ...m };
        delete n[ask.id];
        return n;
      });
      setHitlNote((m) => {
        const n = { ...m };
        delete n[ask.id];
        return n;
      });
      await refreshHitlAsks();
    } catch (e) {
      push('agent', `Couldn't record that answer: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const push = (role: ChatMsg['role'], text: string, chart?: AgentChartAttachment) =>
    setMessages((m) => [...m, { id: msgSeq++, role, text, chart }]);

  const refreshAudit = () => setAudit(runtime.getAuditLog(threadId));

  /**
   * Open an artifact in the embedded panel. The spec is resolved from the
   * persistent artifact store (re-openable across sessions); when the
   * store has no record (e.g. transient generation), a fallback spec is
   * built from the returned React source so the panel still renders.
   */
  const openArtifactById = (
    id: string | null,
    fallback?: { fallbackSource: string; fallbackTitle: string; fallbackCreatedAt: number },
  ): void => {
    const spec = id ? (artifactStore?.all().find((a) => a.id === id) ?? null) : null;
    if (spec) {
      setAppArtifact(spec);
      return;
    }
    if (fallback) {
      const now = Date.now();
      setAppArtifact({
        id: `transient_${now}`,
        version: ARTIFACT_SPEC_VERSION,
        kind: 'react-app',
        name: fallback.fallbackTitle,
        prompt: '',
        template: 'custom',
        source: fallback.fallbackSource,
        binding: {
          sheet,
          startRow: 0,
          startCol: 0,
          endRow: 0,
          endCol: 0,
          hasHeaderRow: true,
          columns: [],
        },
        principal: 'web-user',
        createdAt: fallback.fallbackCreatedAt,
        updatedAt: now,
      });
    }
  };

  // Shell integration: honor external open-artifact requests (share
  // Restore → working view). Each seq is handled once.
  const initialArtifactHandledRef = useRef<number>(0);
  useEffect(() => {
    if (!initialArtifactRequest) return;
    if (initialArtifactHandledRef.current === initialArtifactRequest.seq) return;
    initialArtifactHandledRef.current = initialArtifactRequest.seq;
    openArtifactById(initialArtifactRequest.id);
    // openArtifactById is a stable render-body closure over the store.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialArtifactRequest]);

  // Voice handoff (#41): seed the composer with the palette's unmatched
  // utterance. Each seq is handled once; the user reviews and sends —
  // nothing is ever auto-sent.
  const initialDraftHandledRef = useRef<number>(0);
  useEffect(() => {
    if (!initialDraft) return;
    if (initialDraftHandledRef.current === initialDraft.seq) return;
    initialDraftHandledRef.current = initialDraft.seq;
    setDraft(initialDraft.text);
    composerRef.current?.focus();
  }, [initialDraft]);

  /**
   * Intent-routed dispatch (intentRouter.ts, user spec 2026-10-18).
   * Every prompt is classified first; ambiguous prompts are never guessed —
   * they surface as an inline disambiguation question with option buttons.
   */
  const handleRoute = async (route: IntentRoute, prompt: string) => {
    if (route.route === 'disambiguate') {
      setIntentPending({ question: route.question, options: [...route.options], prompt });
      return;
    }
    setBusy(true);
    try {
      const ports = {
        ...getIntentPorts(),
        conversation: async (p: string) => (await runtime.chat(threadId, p)).message,
      };
      if (route.route === 'conversation' || route.route === 'chart') {
        // Native-chart route (W3): no separate lane — the existing runtime
        // turn is the path; its planner maps the explicit in-sheet chart
        // wording to the create_chart tool, so the chart lands in the
        // sheet itself (persists + saves with the file).
        const reply = await runtime.chat(threadId, prompt);
        push('agent', reply.message, reply.chart);
      } else if (route.route === 'app') {
        // App pipeline: React only, MCP as the backend. The app-artifact
        // lane registers its AppGenerationPort via registerIntentPorts().
        const result = await dispatchIntent(route, ports, prompt);
        if (result.route === 'app') {
          openArtifactById(result.result.artifactMeta.artifactId ?? null, {
            fallbackSource: result.result.reactSource,
            fallbackTitle: result.result.artifactMeta.title,
            fallbackCreatedAt: result.result.artifactMeta.createdAt,
          });
          push(
            'agent',
            `Built "${result.result.artifactMeta.title}" — it's open in the panel beside the chat. Edits in the app write back to the sheet live through MCP.`,
          );
        } else if (result.route === 'unavailable') {
          push('notice', result.reason);
        }
      } else {
        // Analysis pipeline: dispatch to the registered AnalysisPort when the
        // data-analysis lane has landed; otherwise the existing runtime turn
        // handles it (the analysis lane renders its chart via reply.chart).
        if (ports.analysis) {
          const result = await dispatchIntent(route, ports, prompt);
          if (result.route === 'analysis') {
            push('agent', result.result.analysis, {
              title: 'Analysis',
              config: result.result.chartSpec as unknown as ChartConfiguration,
            });
          } else if (result.route === 'unavailable') {
            push('notice', result.reason);
          }
        } else {
          const reply = await runtime.chat(threadId, prompt);
          push('agent', reply.message, reply.chart);
        }
      }
      refreshAudit();
    } catch (e) {
      push('agent', `Something went wrong: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  const send = async (text: string) => {
    const trimmed = text.trim();
    if (!trimmed || busy) return;
    setDraft('');
    setIntentPending(null);
    push('user', trimmed);
    // Classify on submit: ambiguous → inline disambiguation, else dispatch.
    const route = routePrompt(trimmed, { sheet });
    await handleRoute(route, trimmed);
  };

  /** Answer the router's disambiguation question: re-dispatch the ORIGINAL
   *  prompt with the user's chosen intent (never re-classified). */
  const answerIntent = async (opt: string) => {
    const pend = intentPending;
    if (!pend || busy) return;
    const kind = resolveDisambiguation(opt);
    setIntentPending(null);
    push('user', opt);
    if (!kind) {
      push('agent', "I didn't recognize that choice — please pick one of the options.");
      return;
    }
    const classification = classifyIntent(pend.prompt);
    const forced: IntentRoute =
      kind === 'app'
        ? { route: 'app', classification }
        : kind === 'analysis'
          ? { route: 'analysis', classification }
          : kind === 'chart'
            ? { route: 'chart', classification }
            : { route: 'conversation', classification };
    await handleRoute(forced, pend.prompt);
  };

  // Proactive watch: subscribe on toggle, poll on an interval, collapse
  // bursts into one rate-limited notice.
  useEffect(() => {
    if (!watching) return;
    let cancelled = false;
    let timer: ReturnType<typeof setInterval> | null = null;
    (async () => {
      try {
        const subId = await runtime.watch(['cells_changed', 'recalc_complete'], sheet);
        if (cancelled) {
          await runtime.unwatch(subId).catch(() => undefined);
          return;
        }
        watchRef.current.subId = subId;
        timer = setInterval(async () => {
          try {
            const events = await runtime.pollWatch(subId, 50);
            if (events.length === 0 || muted) return;
            const now = Date.now();
            if (now - watchRef.current.lastNotice < WATCH_POLL_MS) return;
            watchRef.current.lastNotice = now;
            const cells = events.filter((e) => e.type === 'cells_changed').length;
            const recalcs = events.filter((e) => e.type === 'recalc_complete').length;
            const bits: string[] = [];
            if (cells > 0) bits.push(`${cells} cell change${cells === 1 ? '' : 's'}`);
            if (recalcs > 0) bits.push('recalculation finished');
            push('notice', `Heads up: ${bits.join(', ')} on ${sheet}.`);
          } catch {
            /* transient poll failure: keep watching */
          }
        }, WATCH_POLL_MS);
      } catch {
        if (!cancelled) setWatching(false);
      }
    })();
    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
      const subId = watchRef.current.subId;
      watchRef.current.subId = null;
      if (subId) void runtime.unwatch(subId).catch(() => undefined);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [watching, sheet]);

  return (
    <>
    <div
      ref={chatRootRef}
      className="agent-chat"
      role="complementary"
      aria-label="AI Agent chat"
      style={{ width: clampAgentPanelWidth(panelWidth) }}
    >
      <div
        className="agent-resize-handle"
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize AI Agent panel"
        title="Drag to resize the agent panel (arrow keys work too)"
        aria-valuemin={Math.min(AGENT_PANEL_MIN, panelMax)}
        aria-valuemax={panelMax}
        aria-valuenow={Math.round(clampAgentPanelWidth(panelWidth))}
        tabIndex={0}
        onPointerDown={onResizePointerDown}
        onKeyDown={onResizeKeyDown}
      />
      <div className="agent-chat-header">
        <span className="agent-chat-title">AI Agent</span>
        <button
          type="button"
          className={tab === 'chat' ? 'agent-chip agent-chip-on' : 'agent-chip'}
          onClick={() => setTab('chat')}
          title="Chat with the AI Agent"
        >
          Chat
        </button>
        {artifactStore && (
          <button
            type="button"
            className={tab === 'apps' ? 'agent-chip agent-chip-on' : 'agent-chip'}
            onClick={() => setTab('apps')}
            title="Generated apps (persistent chat artifacts)"
          >
            Apps
          </button>
        )}
        <button
          type="button"
          className={showAudit ? 'agent-chip agent-chip-on' : 'agent-chip'}
          onClick={() => {
            setShowAudit((s) => !s);
            refreshAudit();
          }}
          title="Show the agent's audit trail (ai-agent.md §4)"
        >
          Audit
        </button>
        {watchSupported && (
          <button
            type="button"
            className={watching ? 'agent-chip agent-chip-on' : 'agent-chip'}
            onClick={() => setWatching((w) => !w)}
            title={watching ? 'Stop watching this sheet' : 'Watch this sheet for changes (proactive)'}
          >
            {watching ? 'Watching' : 'Watch'}
          </button>
        )}
        {watching && (
          <button
            type="button"
            className={muted ? 'agent-chip agent-chip-on' : 'agent-chip'}
            onClick={toggleMuted}
            title="Mute proactive notices"
          >
            {muted ? 'Muted' : 'Mute'}
          </button>
        )}
        <button
          type="button"
          className="agent-chip"
          onClick={() => setSettingsOpen(true)}
          title="AI Agent settings — model backend and proactive notifications"
          aria-label="AI Agent settings"
        >
          ⚙
        </button>
        <button type="button" className="agent-chip" onClick={onClose} aria-label="Close agent chat">
          ×
        </button>
      </div>
      {settingsOpen && <AgentSettingsDialog runtime={runtime} onClose={() => setSettingsOpen(false)} />}

      {showAudit ? (
        <div className="agent-audit" ref={listRef}>
          {audit.length === 0 && <div className="agent-audit-empty">No agent actions yet.</div>}
          {audit.map((e) => (
            <div key={e.seq} className="agent-audit-row">
              <span className="agent-audit-seq">#{e.seq}</span>
              <span className="agent-audit-kind">{e.kind}</span>
              <span className="agent-audit-text">
                {e.tool ? `${e.tool} — ` : ''}
                {e.summary ?? e.text ?? ''}
              </span>
            </div>
          ))}
        </div>
      ) : tab === 'apps' && artifactStore ? (
        <div className="agent-apps" ref={listRef} style={{ flex: 1, overflowY: 'auto' }}>
          {artifactMcpCall ? (
            <ArtifactLibrary
              store={artifactStore}
              sheet={sheet}
              mcpCall={artifactMcpCall}
              onOpen={(id) => {
                openArtifactById(id);
                setTab('chat');
              }}
            />
          ) : (
            <div style={{ padding: 16, fontSize: 13, color: 'var(--muted)' }}>
              Generated apps need the local engine — they are not available through the gateway in v1.
            </div>
          )}
        </div>
      ) : (
        <div className="agent-messages" ref={listRef}>
          {messages.map((m) => (
            <div key={m.id} className={`agent-msg agent-msg-${m.role}`}>
              {m.text}
              {m.chart && (
                <div className="agent-msg-chart" style={{ width: 360, height: 250, marginTop: 8 }}>
                  <ChartCanvas
                    config={m.chart.config}
                    width={360}
                    height={250}
                    title={m.chart.title}
                  />
                </div>
              )}
            </div>
          ))}
          {hitlAsks.map((ask) => (
            <div key={ask.id} className="agent-pending">
              <div className="agent-pending-q">
                {ask.kind === 'approval' ? (
                  <>
                    <strong>Approval needed — {ask.action}</strong>
                    <br />
                    {ask.detail}
                  </>
                ) : (
                  ask.question
                )}
              </div>
              <div className="agent-pending-options">
                {ask.kind === 'options' &&
                  (ask.options ?? []).map((opt) => (
                    <button key={opt} type="button" onClick={() => void answerHitl(ask, opt)}>
                      {opt}
                    </button>
                  ))}
                {ask.kind === 'question' && (
                  <>
                    <input
                      value={hitlText[ask.id] ?? ''}
                      onChange={(e) => setHitlText((m) => ({ ...m, [ask.id]: e.target.value }))}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          const v = hitlText[ask.id]?.trim();
                          if (v) void answerHitl(ask, v);
                        }
                      }}
                      placeholder="Type your answer"
                      aria-label="Answer the agent's question"
                    />
                    <button
                      type="button"
                      onClick={() => {
                        const v = hitlText[ask.id]?.trim();
                        if (v) void answerHitl(ask, v);
                      }}
                    >
                      Send
                    </button>
                  </>
                )}
                {ask.kind === 'approval' && (
                  <>
                    <button type="button" onClick={() => void answerHitl(ask, 'yes')}>
                      Approve
                    </button>
                    <button type="button" onClick={() => void answerHitl(ask, 'no')}>
                      Deny
                    </button>
                    <input
                      value={hitlNote[ask.id] ?? ''}
                      onChange={(e) => setHitlNote((m) => ({ ...m, [ask.id]: e.target.value }))}
                      placeholder="Note (optional)"
                      aria-label="Approval note"
                    />
                  </>
                )}
              </div>
            </div>
          ))}
          {intentPending && (
            <div className="agent-pending">
              <div className="agent-pending-q">{intentPending.question}</div>
              <div className="agent-pending-options">
                {intentPending.options.map((opt) => (
                  <button key={opt} type="button" onClick={() => void answerIntent(opt)} disabled={busy}>
                    {opt}
                  </button>
                ))}
              </div>
            </div>
          )}
          {busy && <div className="agent-msg agent-msg-agent agent-typing">…</div>}
        </div>
      )}

      {tab === 'chat' && (
        <div className="agent-input-row">
          {/* Gemini-style composer (issue #25): one rounded container,
              borderless auto-growing textarea inside, action buttons
              along the container's bottom row, Send at bottom-right. */}
          <div className="agent-composer">
            <textarea
              ref={composerRef}
              value={draft}
              rows={2}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                // Enter sends (not during IME composition); Shift+Enter is
                // a newline; Escape closes the panel (long-standing behavior).
                if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  void send(draft);
                }
                if (e.key === 'Escape') onClose();
              }}
              placeholder='Ask, e.g. "sum of A1:A10" or "analyze A1:D20 and show a diagram"'
              aria-label="Message the AI Agent"
              disabled={busy}
            />
            <div className="agent-composer-actions">
              <button type="button" onClick={() => void send(draft)} disabled={busy || !draft.trim()}>
                Send
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
    {appArtifact && (
      <div
        ref={artifactRootRef}
        className={`agent-artifact${artifactExpanded ? ' agent-artifact-expanded' : ''}`}
        role="complementary"
        aria-label="Generated app"
      >
        <div className="agent-artifact-header">
          <span className="agent-artifact-title">{appArtifact.name}</span>
          <button
            type="button"
            className="agent-chip"
            onClick={() => setArtifactExpanded((e) => !e)}
            title={artifactExpanded ? 'Dock side-by-side with the chat' : 'Expand to fullscreen'}
          >
            {artifactExpanded ? 'Side-by-side' : 'Fullscreen'}
          </button>
          <button
            type="button"
            className="agent-chip"
            onClick={() => {
              setAppArtifact(null);
              setArtifactExpanded(false);
            }}
            aria-label="Close app panel"
          >
            ×
          </button>
        </div>
        <div className="agent-artifact-body" style={{ display: 'flex', flexDirection: 'column', padding: 0 }}>
          {/* The generated React app, embedded: sandboxed iframe, MCP-only
              data binding, two-way live binding with the sheet. */}
          <ArtifactFrame spec={appArtifact} mcpCall={artifactMcpCall} />
        </div>
      </div>
    )}
    </>
  );
}
