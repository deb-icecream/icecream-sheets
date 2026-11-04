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
import type { AgentReply, AuditEntry, AgentChartAttachment, PendingAskView } from '@icecream-sheets/service';
import {
  ARTIFACT_SPEC_VERSION,
  classifyIntent,
  routePrompt,
  dispatchIntent,
  resolveDisambiguation,
  getIntentPorts,
  type ArtifactSpec,
  type DerivedDiagramSpec,
  type IntentRoute,
  type McpCallFn,
  type MetadataStore,
} from '@icecream-sheets/service';
import type { AgentChatBackend, AgentTurnEvent } from '../services/remoteAgent';
import { AGENT_THREAD_KEY_PREFIX, threadIdForFile } from '../services/remoteAgent';
import { isGatewayMode } from '../engine';
import ChartCanvas from './ChartCanvas';
import { smartArtSvg } from './SmartShapes';
import AgentSettingsDialog from './AgentSettingsDialog';
import Markdown from './ui/Markdown';
import { Button, IconButton, ThinkingWave } from './ui/primitives';
import { useDictation, type VoiceTranscribeFn } from '../services/dictation';
import {
  buildFormulaCall,
  CONFIDENT_MATCH_SCORE,
  resolveVoiceCommand,
  validateFormulaText,
  type VoiceResolution,
  type VoiceTarget,
} from '../services/voiceCommands';
import { ArtifactLibrary } from './ArtifactHost';
import { HostArtifactFrame } from './HostArtifactFrame';
import { AppShareDialog } from '../product/AppShareDialog';
import type { SharesApi } from '../product/sharesApi';
import type { ChartConfiguration } from 'chart.js';

type MsgStep =
  | { kind: 'thought'; text: string }
  | { kind: 'tool'; tool: string; ok?: boolean };

interface ChatMsg {
  id: number;
  role: 'user' | 'agent' | 'notice';
  text: string;
  /** Rendered visual from the data-analysis pipeline (spec + render request). */
  chart?: AgentChartAttachment;
  /**
   * G1 footprint (#122 acceptance): the app created by this chat turn.
   * Rendered as a clickable artifact-icon button that reopens the app
   * in the panel. Lives in messages state, so closing the panel leaves
   * the footprint in place (no minimize button — owner ruling).
   */
  artifact?: { id: string; title: string };
  /**
   * #138: diagram a loop turn built (model-generated spec). Rendered
   * in the message as SmartArt SVG, like the chart attachment.
   */
  diagram?: DerivedDiagramSpec;
  /** #40 streaming: the turn's streamed plan/tool steps (thought region). */
  steps?: MsgStep[];
  /** #40: the turn is still streaming in. */
  streaming?: boolean;
  /** #40: the user stopped this turn mid-stream. */
  stopped?: boolean;
  /** #40: a mid-stream failure, rendered in place (plain language). */
  errorText?: string;
}

/** Fold one streamed turn event into the in-flight message (#40). */
function applyTurnEvent(msg: ChatMsg, e: AgentTurnEvent): ChatMsg {
  // #137 token streaming: append streamed reply text as it arrives.
  // The done payload replaces this text wholesale (runChatTurn), so
  // a failed-then-retried stream can never duplicate it.
  if (e.type === 'token') {
    return { ...msg, text: msg.text + e.text };
  }
  if (e.type === 'thought') {
    const steps = msg.steps ?? [];
    const last = steps[steps.length - 1];
    if (last && last.kind === 'thought' && last.text === e.text) return msg;
    return { ...msg, steps: [...steps, { kind: 'thought', text: e.text }] };
  }
  if (e.type === 'tool' && e.phase === 'start') {
    return { ...msg, steps: [...(msg.steps ?? []), { kind: 'tool', tool: e.tool }] };
  }
  if (e.type === 'tool' && e.phase === 'end') {
    const steps = [...(msg.steps ?? [])];
    for (let i = steps.length - 1; i >= 0; i -= 1) {
      const st = steps[i];
      if (st.kind === 'tool' && st.tool === e.tool && st.ok === undefined) {
        steps[i] = { ...st, ok: e.ok };
        break;
      }
    }
    return { ...msg, steps };
  }
  return msg; // 'thinking': the wave indicator already says it
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
   * Share backend for the chat Apps tab (#124: same instance the
   * Workspace appsSlot uses; null = no gateway client, so the share
   * dialog honestly explains that sign-in is required).
   */
  sharesApi?: SharesApi | null;
  /**
   * A workbook is open in the grid on a gateway-mode tab. When true and
   * the runtime would send a turn with no bound file, the panel says so
   * truthfully instead of letting the service refuse as "no active
   * workbook connection" while the user looks at an open workbook.
   * False on the Workspace and in local mode (genuine no-file behavior
   * there is unchanged).
   */
  workbookOpen?: boolean;
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
  /**
   * Dictation for the composer mic (§7 merge): present only where a
   * dictation route exists for the current session (gateway sessions,
   * including a signed-in desktop shell — see dictationSupported).
   * Dictated text lands in the composer for review; the user sends it
   * themselves.
   */
  transcribe?: VoiceTranscribeFn | null;
  /**
   * Voice fast path (§7.1): the palette matcher/executor re-homed
   * behind the composer mic. When a dictated utterance resolves to a
   * single command at CONFIDENT_MATCH_SCORE or above, the composer
   * offers it for one-tap confirmation (confirm-before-run, exactly
   * like the palette); anything less confident is never offered — the
   * words stay in the composer for the agent. Null when the fast path
   * is unavailable (tier gate, no MCP caller, workbook not loaded).
   */
  voiceCommand?: {
    target: VoiceTarget;
    mcpCall: McpCallFn;
  } | null;
}

let msgSeq = 1;

/** Per-file thread persistence (Task B): one thread per spreadsheet. */
const THREAD_KEY_PREFIX = AGENT_THREAD_KEY_PREFIX;

const GREETING =
  'Hi — I can read ranges, sum or average them, write values and formulas, recalculate, remember notes, and analyze data with charts ("analyze A1:D20 and show me a diagram", "forecast next quarter"). Everything I do goes through the same tools as any other client, and the audit log below shows each step.';

/** Cell-value formatting for voice 'read' results (mirrors the palette's). */
function formatVoiceCellValue(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'object') {
    const rec = v as { value?: unknown };
    if ('value' in rec) return rec.value === null || rec.value === undefined ? '' : String(rec.value);
    return JSON.stringify(v);
  }
  return String(v);
}

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

/**
 * In-panel agent analysis chart (#136) with an expand button.
 *
 * - Inline: the existing 360x250 card, plus an Expand button on the card.
 * - Expanded: a fixed overlay covering the entire window (grid + chat),
 *   same chart config — no page reload, no data refetch. The chart.js
 *   instance is recreated from the same in-memory config at the new size
 *   (key change), so the data shown is identical.
 * - Clicking Restore (or Escape) puts the chart back inline in the panel.
 */
function AgentMsgChart({ chart }: { chart: AgentChartAttachment }) {
  const [expanded, setExpanded] = useState(false);
  const [viewport, setViewport] = useState(() => ({
    w: typeof window === 'undefined' ? 1024 : window.innerWidth,
    h: typeof window === 'undefined' ? 768 : window.innerHeight,
  }));

  useEffect(() => {
    if (!expanded) return;
    const onResize = () =>
      setViewport({ w: window.innerWidth, h: window.innerHeight });
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [expanded]);

  useEffect(() => {
    if (!expanded) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setExpanded(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [expanded]);

  if (expanded) {
    const pad = 16;
    const headerH = 45;
    const w = Math.max(200, viewport.w - pad * 2);
    const h = Math.max(200, viewport.h - headerH - pad * 2);
    return (
      <div
        data-agent-chart-expanded
        style={{
          position: 'fixed',
          inset: 0,
          zIndex: 400,
          background: 'var(--panel)',
          color: 'var(--text)',
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: '8px 12px',
            borderBottom: '1px solid var(--line)',
          }}
        >
          <div style={{ flex: 1, fontSize: 13, fontWeight: 600 }}>{chart.title}</div>
          <button
            type="button"
            className="ds-msg-action"
            data-agent-chart-restore
            aria-label="Restore chart"
            title="Restore"
            onClick={() => setExpanded(false)}
          >
            ⤢ Restore
          </button>
        </div>
        <div
          style={{
            flex: 1,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: pad,
          }}
        >
          <ChartCanvas
            key="expanded"
            config={chart.config}
            width={w}
            height={h}
            title={chart.title}
          />
        </div>
      </div>
    );
  }

  return (
    <div
      className="agent-msg-chart"
      style={{ position: 'relative', width: 360, height: 250, marginTop: 8 }}
    >
      <ChartCanvas
        key="inline"
        config={chart.config}
        width={360}
        height={250}
        title={chart.title}
      />
      <button
        type="button"
        className="ds-msg-action"
        data-agent-chart-expand
        aria-label="Expand chart"
        title="Expand"
        onClick={() => setExpanded(true)}
        style={{
          position: 'absolute',
          top: 4,
          left: 4,
          background: 'var(--panel)',
          border: '1px solid var(--line)',
          borderRadius: 6,
        }}
      >
        ⤢ Expand
      </button>
    </div>
  );
}

/**
 * #138: in-panel diagram rendering for loop-built diagrams. The spec
 * arrives from the model (layout + labels + title); the client only
 * renders it, via the same smartArtSvg the SmartArt dialog uses.
 * The SVG is generated by our own renderer from validated labels —
 * never raw model markup — so innerHTML here carries no model HTML.
 */
function AgentMsgDiagram({ diagram }: { diagram: DerivedDiagramSpec }) {
  const { svg, width, height } = smartArtSvg(diagram.layout, diagram.items);
  return (
    <div
      className="agent-msg-diagram"
      style={{ marginTop: 8, maxWidth: '100%', overflowX: 'auto' }}
      aria-label={`${diagram.title} diagram`}
      title={diagram.title}
    >
      <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 4 }}>{diagram.title}</div>
      <div
        style={{ width, height, maxWidth: '100%' }}
        dangerouslySetInnerHTML={{ __html: svg }}
      />
    </div>
  );
}

export default function AgentChat({
  runtime,
  sheet,
  onClose,
  watchSupported = true,
  artifactStore = null,
  artifactMcpCall = null,
  sharesApi = null,
  workbookOpen = false,
  initialArtifactRequest = null,
  initialDraft = null,
  transcribe = null,
  voiceCommand = null,
}: AgentChatProps) {
  // One persistent thread per fileId (Task B): derived from the
  // bound file, persisted to localStorage per file, restored from
  // the service so a refresh keeps the chat. No cross-spreadsheet
  // leakage — switching files switches threads.
  const getFileId = useCallback(() => runtime.getBoundFileId?.() ?? null, [runtime]);
  const [threadId, setThreadId] = useState<string>(() => {
    const fileId = runtime.getBoundFileId?.() ?? null;
    const next = threadIdForFile(fileId);
    // Persist per file (Task B); the VALUE is the deterministic id
    // itself — never an ephemeral mint — so every browser addresses
    // the same server thread. Stale ephemeral values from older
    // builds are deliberately not reused.
    if (fileId) {
      try {
        localStorage.setItem(`${THREAD_KEY_PREFIX}${fileId}`, next);
      } catch {
        // Private mode: the deterministic id still works for this tab.
      }
    }
    return next;
  });
  const [messages, setMessages] = useState<ChatMsg[]>([
    {
      id: msgSeq++,
      role: 'agent',
      text: GREETING,
    },
  ]);
  const threadIdRef = useRef(threadId);
  const hydratedRef = useRef<string | null>(null);
  useEffect(() => {
    const fileId = getFileId();
    if (!fileId) return;
    const key = `${THREAD_KEY_PREFIX}${fileId}`;
    const next = threadIdForFile(fileId);
    try {
      localStorage.setItem(key, next);
    } catch {
      // Private mode: keep the deterministic id for this tab.
    }
    if (hydratedRef.current === next) return;
    hydratedRef.current = next;
    const switched = next !== threadIdRef.current;
    if (switched) {
      threadIdRef.current = next;
      setThreadId(next);
    }
    const pending = runtime.getThreadHistory?.(next);
    if (!pending) return;
    pending
      .then((hist) => {
        if (hist.length === 0) {
          // Fresh thread for this file: start from the greeting.
          if (switched) setMessages([{ id: msgSeq++, role: 'agent', text: GREETING }]);
        } else {
          setMessages(
            hist.map((m) => ({
              id: msgSeq++,
              role: m.role === 'user' ? ('user' as const) : ('agent' as const),
              text: m.text,
            })),
          );
        }
      })
      .catch(() => {
        /* history unavailable: keep the current panel */
      });
  }, [runtime, sheet, getFileId]);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  /**
   * #112 one-click send: while dictating or transcribing, Send (or the
   * mic toggle's second click) must stop + send in one click. The final
   * transcript lands asynchronously in onFinal, so the click only arms
   * this flag and stops the recorder; onFinal sends the combined text.
   * draftRef mirrors draft for that async callback (the closure alone
   * could predate keystrokes typed during transcription).
   */
  const pendingSendRef = useRef(false);
  const draftRef = useRef(draft);
  draftRef.current = draft;
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
  /** #145 redesign: Share from the opened app view (same dialog as the gallery menu). */
  const [artifactShareOpen, setArtifactShareOpen] = useState(false);
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
  /** Panel root refs. (The #35 --agent-dock-width publisher that used
   * to live here existed only to anchor the standalone voice FAB;
   * §7.1 removed that button, the var lost its only consumer, and the
   * publisher is gone with it. The docked panel itself never read it.) */
  const chatRootRef = useRef<HTMLDivElement>(null);
  const artifactRootRef = useRef<HTMLDivElement>(null);
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
  /** #40 streaming: id of the in-flight streamed message + its abort. */
  const [streamMsgId, setStreamMsgId] = useState<number | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  /** Thought regions the user re-expanded after auto-collapse. */
  const [expandedSteps, setExpandedSteps] = useState<Record<number, boolean>>({});
  /** #40 follow-scroll: only chase the stream while the user is at the
   * bottom; otherwise offer "back to latest" (§3.5). */
  const atBottomRef = useRef(true);
  const [showBackToLatest, setShowBackToLatest] = useState(false);
  const stopStream = useCallback(() => {
    abortRef.current?.abort();
  }, []);
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
    if (atBottomRef.current) {
      listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
    }
  }, [messages, hitlAsks, intentPending]);

  const onMessagesScroll = () => {
    const el = listRef.current;
    if (!el) return;
    const bottom = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
    atBottomRef.current = bottom;
    setShowBackToLatest(!bottom);
  };

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

  /**
   * Voice fast-path offer (§7.1): set when the latest dictated
   * utterance matched ONE command confidently; cleared when the user
   * edits the draft, dismisses it, starts a new dictation, or runs it.
   * The dictated segment is kept so a successful run can remove
   * exactly those words when they are still the whole draft.
   */
  const [voiceOffer, setVoiceOffer] = useState<{
    resolution: VoiceResolution;
    target: VoiceTarget;
    mcpCall: McpCallFn;
    dictatedText: string;
  } | null>(null);
  const [voiceOfferRunning, setVoiceOfferRunning] = useState(false);

  /**
   * Offer the fast path for a dictated utterance — only when it earns
   * it: a resolution at CONFIDENT_MATCH_SCORE or above that is fully
   * specified (formula present and valid, or an executable call).
   * Anything else earns NO offer: the words stay in the composer for
   * the agent, never a forced guess (§7.1's unsure path).
   */
  const maybeOfferVoiceCommand = (text: string) => {
    if (!voiceCommand) return;
    const resolution = resolveVoiceCommand(text, voiceCommand.target);
    if (!resolution || resolution.score < CONFIDENT_MATCH_SCORE) return;
    if (resolution.kind === 'formula') {
      if (!resolution.formula || validateFormulaText(resolution.formula) !== null) return;
    } else if (!resolution.executable || !resolution.call) {
      return;
    }
    setVoiceOffer({
      resolution,
      target: voiceCommand.target,
      mcpCall: voiceCommand.mcpCall,
      dictatedText: text,
    });
  };

  /**
   * Composer dictation (§7): interim transcripts show as a caption;
   * the final transcript lands in the composer as editable text. The
   * user reviews and sends — dictation never sends by itself.
   */
  const dictation = useDictation({
    transcribe,
    onFinal: (text, info) => {
      if (info.error) {
        push('notice', info.error);
        if (!pendingSendRef.current) return;
        // A send was armed while dictating: the live text still stands
        // (#42), but with no final text there is nothing new to send —
        // fall through to the combined-text check below (the pre-existing
        // draft, if any, is what the user asked to send).
      }
      if (pendingSendRef.current) {
        pendingSendRef.current = false;
        const base = draftRef.current;
        const combined = text
          ? (base.trim() ? `${base.replace(/\s+$/, '')} ${text}` : text)
          : base;
        if (combined.trim() && !busy) {
          // The explicit Send tap wins over the fast-path offer: the
          // user chose to send these words as a chat message.
          void send(combined);
        } else if (combined.trim()) {
          // The agent got busy meanwhile: keep the words in the
          // composer instead of dropping the armed send.
          setDraft(combined);
        }
        if (info.capped) {
          push('notice', 'Dictation reached its length limit and stopped — the transcript is in the composer.');
        }
        return;
      }
      if (text) {
        setDraft((d) => (d.trim() ? `${d.replace(/\s+$/, '')} ${text}` : text));
        maybeOfferVoiceCommand(text);
      }
      if (info.capped) {
        push('notice', 'Dictation reached its length limit and stopped — the transcript is in the composer.');
      }
    },
  });

  /**
   * #112: one click from speaking to sent. When idle this is a plain
   * send; while recording it stops the recorder (the final transcript
   * then triggers the armed send in onFinal); while transcribing the
   * recorder is already stopped and the armed send fires on arrival.
   */
  const sendAfterDictation = () => {
    if (dictation.state === 'idle') {
      void send(draft);
      return;
    }
    pendingSendRef.current = true;
    dictation.stop();
  };

  const push = (
    role: ChatMsg['role'],
    text: string,
    chart?: AgentChartAttachment,
    artifact?: { id: string; title: string },
  ) => setMessages((m) => [...m, { id: msgSeq++, role, text, chart, artifact }]);

  /**
   * Execute the offered voice command — the palette's discipline,
   * unchanged: nothing ran while dictating/matching; this tap is the
   * confirmation. The call is rebuilt exactly like the palette builds
   * it and flows through the same MCP layer.
   */
  const runVoiceOffer = async () => {
    if (!voiceOffer || voiceOfferRunning) return;
    const { resolution, target, mcpCall, dictatedText } = voiceOffer;
    const call =
      resolution.kind === 'formula' && resolution.formula
        ? buildFormulaCall(target, resolution.formula)
        : resolution.call;
    if (!call) return;
    setVoiceOfferRunning(true);
    try {
      const data = (await mcpCall(call.tool, call.args)) as
        | { written?: number; errors?: string[]; cells?: unknown[][] }
        | undefined;
      const errors = data?.errors ?? [];
      if (resolution.kind === 'read') {
        const rows = (data?.cells ?? [])
          .map((row) => (row as unknown[]).map(formatVoiceCellValue).join('  '))
          .join('\n');
        push('notice', `Voice command — ${resolution.actionLabel}:${rows ? `\n${rows}` : ' (no values)'}`);
      } else if (errors.length > 0) {
        push('notice', `Voice command — ${resolution.actionLabel} — done with errors: ${errors.join('; ')}`);
      } else {
        push('notice', `Voice command done — ${resolution.actionLabel}.`);
      }
      // The dictated words WERE the command: remove them when they are
      // still the whole draft. A mixed or edited draft is left as-is.
      setDraft((d) => (d.trim() === dictatedText.trim() ? '' : d));
      setVoiceOffer(null);
    } catch (e) {
      push('notice', `Voice command failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setVoiceOfferRunning(false);
    }
  };

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

  // #142: open the Apps tab with server-saved apps merged in. The
  // library mounts fresh from store.all(), so the merge must happen
  // BEFORE setTab('apps') — merging after mount would leave the
  // visible list stale. A failed sync still opens the tab with the
  // local list; the next open retries.
  const openAppsTab = useCallback(async (): Promise<void> => {
    if (artifactStore && runtime.listServerArtifacts) {
      try {
        const server = await runtime.listServerArtifacts();
        const have = new Set(artifactStore.all().map((a) => a.id));
        for (const spec of server) {
          if (!have.has(spec.id)) artifactStore.add(spec);
        }
      } catch {
        // Local list stands; sync retries on the next open.
      }
    }
    setTab('apps');
  }, [artifactStore, runtime]);

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
   * One conversation turn (#40 streaming). With a streaming backend the
   * turn renders live: a pending agent message appears immediately
   * (thinking wave), plan/tool steps stream into its thought region,
   * and the completed reply (text + chart) lands on it atomically.
   * Returns the reply, or null when a stream failure was already
   * rendered in place (callers must not report it twice). Backends
   * without streaming fall back to the one-shot chat().
   */
  const runChatTurn = async (prompt: string): Promise<AgentReply | null> => {
    if (workbookOpen && runtime.getBoundFileId?.() === null) {
      // Workbook open but this turn would carry no fileId: in production
      // the service has no registry to fall back on, so it would refuse
      // writes as "no active workbook connection" while the user looks
      // at an open workbook — and answer reads from an empty scratch
      // workbook. Say so truthfully and do not send the turn;
      // reopening the file re-establishes the binding.
      push(
        'notice',
        "This workbook isn't connected to a server session, so I can't reach it yet. Reopen the file, then ask again.",
      );
      return null;
    }
    if (!runtime.chatStream) {
      return runtime.chat(threadId, prompt);
    }
    const id = msgSeq++;
    setMessages((m) => [...m, { id, role: 'agent', text: '', streaming: true, steps: [] }]);
    setStreamMsgId(id);
    const ac = new AbortController();
    abortRef.current = ac;
    try {
      const reply = await runtime.chatStream(
        threadId,
        prompt,
        (e) => {
          setMessages((m) => m.map((msg) => (msg.id === id ? applyTurnEvent(msg, e) : msg)));
        },
        ac.signal,
      );
      setMessages((m) =>
        m.map((msg) =>
          msg.id === id
            ? {
                ...msg,
                text: reply.message,
                chart: reply.chart,
                // #141: a loop-built app lands in the persistent store
                // (Apps tab) and as this message's clickable footprint.
                ...(reply.artifact
                  ? { artifact: { id: reply.artifact.id, title: reply.artifact.name } }
                  : {}),
                // #138: a loop-built diagram renders in the message.
                ...(reply.diagram ? { diagram: reply.diagram } : {}),
                streaming: false,
              }
            : msg,
        ),
      );
      // #141: persist the full spec BEFORE the message renders its
      // footprint, so clicking the pill reopens from the store.
      if (reply.artifact && artifactStore) {
        if (!artifactStore.all().some((a) => a.id === reply.artifact!.id)) {
          artifactStore.add(reply.artifact);
        }
        // Demo fix (owner 2026-10-25): a loop-generated app opens
        // AUTOMATICALLY in the side panel on completion — no Apps-tab
        // navigation, no row click. The pill stays as the clickable
        // footprint; the store now holds the spec, so this resolves.
        openArtifactById(reply.artifact.id);
      }
      return reply;
    } catch (err) {
      if (ac.signal.aborted) {
        setMessages((m) =>
          m.map((msg) => (msg.id === id ? { ...msg, streaming: false, stopped: true } : msg)),
        );
        return null;
      }
      const raw = err instanceof Error ? err.message : String(err);
      const plain = /^gateway \d+:/.test(raw)
        ? 'The agent could not be reached just now. What you see above is as far as it got — please try again.'
        : raw;
      setMessages((m) =>
        m.map((msg) => (msg.id === id ? { ...msg, streaming: false, errorText: plain } : msg)),
      );
      return null;
    } finally {
      setStreamMsgId(null);
      abortRef.current = null;
    }
  };

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
        // sheet itself (persists + saves with the file). Streamed (#40):
        // the reply renders into the in-flight message directly.
        await runChatTurn(prompt);
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
            undefined,
            // G1 footprint: only when the app was saved (a null id means
            // a transient panel spec with nothing to reopen by id).
            result.result.artifactMeta.artifactId
              ? { id: result.result.artifactMeta.artifactId, title: result.result.artifactMeta.title }
              : undefined,
          );
        } else if (result.route === 'unavailable') {
          push('notice', result.reason);
        }
      } else if (route.route === 'diagram') {
        // Native-diagram route (#126): the shell's DiagramPort derives a
        // spec from the prompt (no LLM) and inserts it through the same
        // addPicture path the Insert > SmartArt dialog uses, so the
        // diagram lands in the sheet as a picture.
        const result = await dispatchIntent(route, ports, prompt);
        if (result.route === 'diagram') {
          push(
            'agent',
            `Created "${result.result.title}" in the sheet — drag it anywhere; its position saves with the file.`,
          );
        } else if (result.route === 'unavailable') {
          push('notice', result.reason);
        }
      } else {
        // Analysis pipeline: dispatch to the registered AnalysisPort when the
        // data-analysis lane has landed; otherwise the existing runtime turn
        // handles it (the analysis lane renders its chart via reply.chart).
        // #137: NEVER in gateway mode. The in-browser port is bound to the
        // pre-gateway blank engine, and a registered port shadows the
        // gateway/LLM turn — a fresh-thread chart prompt proved it: zero
        // gateway POSTs, sheet "Sheet1" is empty. In gateway mode every
        // prompt goes to the gateway turn (the LLM loop), like any other;
        // the port serves local mode only.
        if (ports.analysis && !isGatewayMode()) {
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
          await runChatTurn(prompt);
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
    setVoiceOffer(null);
    setIntentPending(null);
    push('user', trimmed);
    // #137 sweep: in gateway mode there is NO heuristic routing — the
    // prompt goes straight to the LLM loop and the loop's tool
    // selection IS the routing (analyze_data, create_chart, reads,
    // writes, ...). routePrompt is never consulted here, so no prompt
    // can be diverted to the stale in-browser analysis port (or any
    // other local lane) before a model sees it. Local mode keeps
    // intent routing below: no LLM exists offline, so the
    // deterministic lanes are the only agent function there.
    // #141: the loop now HAS a generate_app tool (and #138 a
    // create_diagram tool), so chat-prompted app/diagram creation
    // works in gateway mode through the loop; the lanes still exist
    // for local mode.
    if (isGatewayMode()) {
      setBusy(true);
      try {
        await runChatTurn(trimmed);
      } finally {
        setBusy(false);
      }
      refreshAudit();
      return;
    }
    // Local mode: classify on submit: ambiguous → inline
    // disambiguation, else dispatch.
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
            : kind === 'diagram'
              ? { route: 'diagram', classification }
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
        <Button
          variant="ghost"
          size="s"
          on={tab === 'chat'}
          onClick={() => setTab('chat')}
          title="Chat with the AI Agent"
        >
          Chat
        </Button>
        {artifactStore && (
          <Button
            variant="ghost"
            size="s"
            on={tab === 'apps'}
            onClick={() => void openAppsTab()}
            title="Generated apps (persistent chat artifacts)"
          >
            Apps
          </Button>
        )}
        <Button
          variant="ghost"
          size="s"
          on={showAudit}
          onClick={() => {
            setShowAudit((v) => !v);
            refreshAudit();
          }}
          title="Show the agent's audit trail (ai-agent.md §4)"
        >
          Audit
        </Button>
        {watchSupported && (
          <Button
            variant="ghost"
            size="s"
            on={watching}
            onClick={() => setWatching((w) => !w)}
            title={watching ? 'Stop watching this sheet' : 'Watch this sheet for changes (proactive)'}
          >
            {watching ? 'Watching' : 'Watch'}
          </Button>
        )}
        {watching && (
          <Button
            variant="ghost"
            size="s"
            on={muted}
            onClick={toggleMuted}
            title="Mute proactive notices"
          >
            {muted ? 'Muted' : 'Mute'}
          </Button>
        )}
        <IconButton label="AI Agent settings — model backend and proactive notifications" onClick={() => setSettingsOpen(true)}>
          ⚙
        </IconButton>
        <IconButton label="Close agent chat" onClick={onClose}>
          ×
        </IconButton>
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
              sharesApi={sharesApi}
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
        <div className="agent-messages" ref={listRef} onScroll={onMessagesScroll}>
          {messages.map((m) => {
            if (m.role !== 'agent') {
              return (
                <div key={m.id} className={`ds-msg ds-msg-${m.role}`}>
                  {m.text}
                </div>
              );
            }
            const steps = m.steps ?? [];
            const expanded = m.streaming ? true : (expandedSteps[m.id] ?? false);
            return (
              <div key={m.id} className={m.errorText ? 'ds-msg ds-msg-error' : 'ds-msg ds-msg-agent'}>
                {steps.length > 0 && !m.streaming && (
                  <button
                    type="button"
                    className="ds-thoughts-summary"
                    aria-expanded={expanded}
                    onClick={() =>
                      setExpandedSteps((st) => ({ ...st, [m.id]: !expanded }))
                    }
                  >
                    {expanded ? '▾' : '▸'} Thought for {steps.length} step
                    {steps.length === 1 ? '' : 's'}
                  </button>
                )}
                {steps.length > 0 && expanded && (
                  <div className="ds-thoughts">
                    {steps.map((st, i) =>
                      st.kind === 'thought' ? (
                        <div key={i}>{st.text}</div>
                      ) : (
                        <div
                          key={i}
                          className={
                            st.ok === undefined
                              ? undefined
                              : st.ok
                                ? 'ds-thought-tool-ok'
                                : 'ds-thought-tool-fail'
                          }
                        >
                          {st.ok === undefined ? '• ' : st.ok ? '✓ ' : '✗ '}
                          {st.tool}
                        </div>
                      ),
                    )}
                  </div>
                )}
                {m.streaming && !m.text ? (
                  <ThinkingWave />
                ) : m.text ? (
                  <Markdown text={m.text} />
                ) : null}
                {m.streaming && <span className="ds-caret" aria-hidden />}
                {m.errorText && <div role="alert">{m.errorText}</div>}
                {m.chart && <AgentMsgChart chart={m.chart} />}
                {m.diagram && <AgentMsgDiagram diagram={m.diagram} />}
                {m.artifact && (
                  <button
                    type="button"
                    className="ds-msg-artifact-footprint"
                    data-artifact-footprint={m.artifact.id}
                    aria-label={`Open ${m.artifact.title} app`}
                    title={`Open ${m.artifact.title}`}
                    onClick={() => openArtifactById(m.artifact!.id)}
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 6,
                      marginTop: 8,
                      padding: '4px 10px',
                      border: '1px solid #ccc',
                      borderRadius: 999,
                      background: '#fff',
                      cursor: 'pointer',
                      fontSize: 13,
                    }}
                  >
                    <span aria-hidden>▦</span>
                    <span>{m.artifact.title}</span>
                  </button>
                )}
                {m.stopped && (
                  <div className="ds-msg-stopped">
                    Stopped — the agent ended that request early.
                  </div>
                )}
                {!m.streaming && m.text && (
                  <div className="ds-msg-actions">
                    <button
                      type="button"
                      className="ds-msg-action"
                      onClick={() =>
                        void navigator.clipboard?.writeText(m.text).catch(() => undefined)
                      }
                    >
                      Copy
                    </button>
                  </div>
                )}
              </div>
            );
          })}
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
                    <button key={opt} type="button" className="ds-btn ds-btn-secondary ds-btn-s" onClick={() => void answerHitl(ask, opt)}>
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
                      className="ds-btn ds-btn-secondary ds-btn-s"
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
                    <button type="button" className="ds-btn ds-btn-primary ds-btn-s" onClick={() => void answerHitl(ask, 'yes')}>
                      Approve
                    </button>
                    <button type="button" className="ds-btn ds-btn-danger ds-btn-s" onClick={() => void answerHitl(ask, 'no')}>
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
                  <button key={opt} type="button" className="ds-btn ds-btn-secondary ds-btn-s" onClick={() => void answerIntent(opt)} disabled={busy}>
                    {opt}
                  </button>
                ))}
              </div>
            </div>
          )}
          {busy && streamMsgId === null && (
            <div className="ds-msg ds-msg-agent">
              <ThinkingWave />
            </div>
          )}
          {showBackToLatest && (
            <button
              type="button"
              className="ds-btn ds-btn-secondary ds-btn-s ds-back-to-latest"
              onClick={() => {
                atBottomRef.current = true;
                setShowBackToLatest(false);
                listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
              }}
            >
              ↓ Back to latest
            </button>
          )}
        </div>
      )}

      {tab === 'chat' && (
        <div className="agent-input-row">
          {voiceOffer && (
            <div className="ds-voice-offer" data-testid="voice-offer" role="status">
              <span className="ds-voice-offer-text">
                ⚡ Voice command: {voiceOffer.resolution.actionLabel} ·{' '}
                {voiceOffer.resolution.name} {Math.round(voiceOffer.resolution.score * 100)}%
              </span>
              <Button
                variant="primary"
                size="s"
                data-testid="voice-offer-run"
                onClick={() => void runVoiceOffer()}
                disabled={voiceOfferRunning}
              >
                {voiceOfferRunning ? 'Running…' : 'Run'}
              </Button>
              <Button
                variant="ghost"
                size="s"
                data-testid="voice-offer-dismiss"
                onClick={() => setVoiceOffer(null)}
                disabled={voiceOfferRunning}
              >
                Dismiss
              </Button>
            </div>
          )}
          {/* Gemini-style composer (issue #25): one rounded container,
              borderless auto-growing textarea inside, action buttons
              along the container's bottom row, Send at bottom-right. */}
          <div className="agent-composer">
            <textarea
              ref={composerRef}
              value={draft}
              rows={2}
              onChange={(e) => {
                setDraft(e.target.value);
                // Editing the words retires the offer — the text is no
                // longer the utterance that was matched (§7.1).
                setVoiceOffer(null);
              }}
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
            {dictation.state !== 'idle' && (
              <div className="ds-listening" role="status">
                {dictation.state === 'recording' ? (
                  <>Listening… {dictation.liveText}</>
                ) : (
                  'Transcribing…'
                )}
              </div>
            )}
            <div className="agent-composer-actions">
              {transcribe && (
                <IconButton
                  label={
                    dictation.state === 'recording' ? 'Stop dictation and send' : 'Dictate a message'
                  }
                  onClick={() => {
                    // A new dictation supersedes any pending offer.
                    setVoiceOffer(null);
                    // #112: the mic toggle's second click stops AND sends.
                    if (dictation.state === 'recording') sendAfterDictation();
                    else dictation.toggle();
                  }}
                  disabled={busy || dictation.state === 'transcribing'}
                  className={dictation.state === 'recording' ? 'ds-mic-recording' : undefined}
                >
                  {dictation.state === 'recording' ? '⏹' : '🎤'}
                </IconButton>
              )}
              {busy ? (
                <Button variant="danger" onClick={stopStream} disabled={streamMsgId === null}>
                  Stop
                </Button>
              ) : (
                <Button
                  variant="primary"
                  onClick={() => sendAfterDictation()}
                  // #112: Send stays clickable while dictating or
                  // transcribing (even with an empty draft — the armed
                  // send fires when the transcript lands, and no-ops
                  // if it lands empty). Typed send is unchanged.
                  disabled={!draft.trim() && dictation.state === 'idle'}
                >
                  Send
                </Button>
              )}
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
          <Button
            variant="ghost"
            size="s"
            onClick={() => setArtifactShareOpen(true)}
            title="Share this app with its data"
          >
            Share
          </Button>
          <Button
            variant="ghost"
            size="s"
            onClick={() => setArtifactExpanded((e) => !e)}
            title={artifactExpanded ? 'Dock side-by-side with the chat' : 'Expand to fullscreen'}
          >
            {artifactExpanded ? 'Side-by-side' : 'Fullscreen'}
          </Button>
          <IconButton
            label="Close app panel"
            onClick={() => {
              setAppArtifact(null);
              setArtifactExpanded(false);
            }}
          >
            ×
          </IconButton>
        </div>
        <div className="agent-artifact-body" style={{ display: 'flex', flexDirection: 'column', padding: 0 }}>
          {/* The generated React app, rendered in the host app context
              (owner decision 2026-10-25: iframe skipped FOR NOW;
              sandboxed iframe returns as a later step). Data binding is
              the same scoped MCP bridge semantics, via the host mcp
              object — two-way live binding with the sheet. */}
          <HostArtifactFrame spec={appArtifact} mcpCall={artifactMcpCall} />
        </div>
        {artifactShareOpen && (
          <AppShareDialog
            spec={appArtifact}
            mcpCall={artifactMcpCall}
            sharesApi={sharesApi}
            onClose={() => setArtifactShareOpen(false)}
          />
        )}
      </div>
    )}
    </>
  );
}
