/**
 * Voice command palette (Ctrl+Shift+P) — a Pro-tier feature.
 *
 * Treats mangled dictated text as a normal input mode: the user types
 * or dictates a command, the palette fuzzy-matches it against the
 * function catalog and sheet commands (services/voiceCommands.ts),
 * SHOWS the interpreted match as a preview, and executes it ONLY when
 * the user explicitly confirms with Run — through the product's MCP
 * tool layer (the same McpCallFn the AI agent and generated apps use).
 * Nothing runs while typing, matching, or previewing.
 *
 * Tier gate: Default-tier sessions (tier claim in our gateway JWT) see
 * a labeled Pro-only state — never a silent absence. Standalone local
 * sessions (no gateway login) are not tier-gated.
 *
 * Execution availability mirrors the product's v1 boundary for
 * client-side MCP (same as generated apps): an McpCallFn exists for
 * local/desktop engine modes; in hosted (gateway) sessions the palette
 * still matches and previews, and says plainly why Run is unavailable.
 *
 * Live transcript (user requirement, 2026-10-21): while dictating, the
 * audio-so-far is re-transcribed on a short poll over the same Vertex
 * route, and the words appear as text in real time — in a labeled live
 * panel and in the command input itself — so the user can SEE what was
 * heard and correct it before anything runs. If the user edits the
 * input mid-dictation, their correction wins: later polls keep updating
 * the live panel but never overwrite the corrected text. Stopping runs
 * one final full-clip pass under the same rule. Nothing executes from
 * a transcript; the corrected text still needs the explicit Run
 * confirm, exactly like typed input.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { McpCallFn } from '@icecream-sheets/service';
import A11yDialog from './A11yDialog';
import {
  buildFormulaCall,
  resolveVoiceCommand,
  toA1,
  validateFormulaText,
  VOICE_EXAMPLES,
  type VoiceResolution,
  type VoiceTarget,
} from '../services/voiceCommands';
import type { PaletteTier } from '../services/voiceTier';

/** Dictation backend: one recorded clip → transcript text. */
export type VoiceTranscribeFn = (clip: {
  dataBase64: string;
  mimeType: string;
}) => Promise<string>;

interface VoiceCommandPaletteProps {
  sheet: string;
  selection: { row: number; col: number };
  tier: PaletteTier;
  /** MCP tool caller (the product MCP layer; executes confirmed runs). */
  mcpCall: McpCallFn | null;
  /** Workbook fully loaded; mutation stays gated until then. */
  ready: boolean;
  /** Present only where a dictation route exists (gateway sessions). */
  transcribe?: VoiceTranscribeFn | null;
  /** Live-transcript poll interval (ms). Test seam; default 2000. */
  livePollMs?: number;
  /**
   * Voice/chat merge (design doc §7, #41): when the palette cannot
   * match confidently it must NOT force a best guess — it hands the
   * utterance to the agent (panel opens with the words in the
   * composer). Absent → the handoff action is not offered.
   */
  onAskAgent?: (text: string) => void;
  onClose: () => void;
}

const DEFAULT_LIVE_POLL_MS = 2000;
/**
 * A match at or above this score is presented as the command. Below it
 * the palette must not push a best guess (#41 / design doc §7): the
 * match stays visible for what it is, and the agent handoff is offered
 * alongside — the agent can do anything the palette cannot.
 */
const CONFIDENT_MATCH_SCORE = 0.85;
/** Dictation is capped so rolling re-transcription stays bounded. */
const MAX_DICTATION_MS = 60_000;
/**
 * #42: dictation audio is SPEECH for server-side STT — 32 kbps Opus is
 * ample. The browser default (~121 kbps, measured) makes the base64 JSON
 * body cross the gateway's 1 MiB request cap at ~51 s of the allowed
 * 60 s, so long dictations died with a raw "gateway 413" on the final
 * pass. At 32 kbps the full 60 s is ~290 KiB — comfortably inside.
 */
const DICTATION_AUDIO_BITS_PER_SECOND = 32_000;
/**
 * Hard byte ceiling as a second line of defense (a browser that ignores
 * the bitrate hint): 600 KB of audio is ~800 KB of base64 JSON, still
 * under the 1 MiB cap. Reaching it stops dictation cleanly and the
 * final pass transcribes what was recorded.
 */
const MAX_DICTATION_BYTES = 600_000;

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const s = String(reader.result ?? '');
      resolve(s.slice(s.indexOf(',') + 1));
    };
    reader.onerror = () => reject(reader.error ?? new Error('audio read failed'));
    reader.readAsDataURL(blob);
  });
}

function baseMime(recorder: MediaRecorder | null): string {
  return (recorder?.mimeType || 'audio/webm').split(';')[0] || 'audio/webm';
}

type RunState =
  | { phase: 'idle' }
  | { phase: 'running' }
  | { phase: 'done'; message: string }
  | { phase: 'error'; message: string };

function formatCellValue(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'object') {
    const rec = v as { value?: unknown; kind?: string };
    if ('value' in rec) return rec.value === null || rec.value === undefined ? '' : String(rec.value);
    return JSON.stringify(v);
  }
  return String(v);
}

export default function VoiceCommandPalette({
  sheet,
  selection,
  tier,
  mcpCall,
  ready,
  transcribe,
  livePollMs = DEFAULT_LIVE_POLL_MS,
  onAskAgent,
  onClose,
}: VoiceCommandPaletteProps) {
  const [text, setText] = useState('');
  const [forced, setForced] = useState<string | null>(null);
  const [editedFormula, setEditedFormula] = useState<string | null>(null);
  const [runState, setRunState] = useState<RunState>({ phase: 'idle' });
  const [readResult, setReadResult] = useState<unknown[][] | null>(null);
  const [recording, setRecording] = useState<'idle' | 'recording' | 'transcribing'>('idle');
  /** Latest heard words, shown live while dictating (and kept after). */
  const [liveText, setLiveText] = useState('');
  /** The user edited the input during this dictation — their text wins. */
  const [corrected, setCorrected] = useState(false);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const sessionRef = useRef(0);
  const pollTimerRef = useRef<number | null>(null);
  const pollBusyRef = useRef(false);
  const correctedRef = useRef(false);
  const byteCappedRef = useRef(false);
  const startedAtRef = useRef(0);

  const target: VoiceTarget = useMemo(
    () => ({ sheet, row: selection.row, col: selection.col }),
    [sheet, selection],
  );

  const resolution: VoiceResolution | null = useMemo(() => {
    if (!text.trim()) return null;
    return resolveVoiceCommand(text, target, forced ? { forceFunction: forced } : {});
  }, [text, target, forced]);

  const gated = tier === 'default';
  const effectiveFormula = editedFormula ?? resolution?.formula ?? '';
  const formulaError =
    resolution?.kind === 'formula' && effectiveFormula
      ? validateFormulaText(effectiveFormula)
      : null;

  const canRun = ((): boolean => {
    if (gated || !resolution || !mcpCall || !ready) return false;
    if (runState.phase === 'running') return false;
    if (resolution.kind === 'formula') {
      return effectiveFormula.length > 0 && formulaError === null;
    }
    return resolution.executable;
  })();

  const onTextChange = (value: string) => {
    setText(value);
    setForced(null);
    setEditedFormula(null);
    setRunState({ phase: 'idle' });
    setReadResult(null);
  };

  const pickAlternate = (name: string) => {
    setForced(name);
    setEditedFormula(null);
    setRunState({ phase: 'idle' });
    setReadResult(null);
  };

  const run = async () => {
    if (!resolution || !mcpCall || !canRun) return;
    const call =
      resolution.kind === 'formula'
        ? buildFormulaCall(target, effectiveFormula)
        : resolution.call;
    if (!call) return;
    setRunState({ phase: 'running' });
    try {
      const data = (await mcpCall(call.tool, call.args)) as
        | { written?: number; errors?: string[]; cells?: unknown[][] }
        | undefined;
      if (resolution.kind === 'read') {
        setReadResult(data?.cells ?? []);
        setRunState({ phase: 'done', message: `${resolution.actionLabel} — values below.` });
      } else {
        const errors = data?.errors ?? [];
        if (errors.length > 0) {
          setRunState({
            phase: 'done',
            message: `${resolution.actionLabel} — done with errors: ${errors.join('; ')}`,
          });
        } else {
          setRunState({ phase: 'done', message: `Done — ${resolution.actionLabel}.` });
        }
      }
    } catch (e) {
      setRunState({
        phase: 'error',
        message: e instanceof Error ? e.message : String(e),
      });
    }
  };

  /**
   * Land a transcript (interim poll or final pass): the live panel
   * always shows what was heard; the input follows ONLY when the user
   * hasn't corrected it during this dictation.
   */
  const applyTranscript = (t: string) => {
    if (!t) return;
    setLiveText(t);
    if (!correctedRef.current) {
      setText(t);
      setForced(null);
      setEditedFormula(null);
      setRunState({ phase: 'idle' });
      setReadResult(null);
    }
  };

  const clearPollTimer = () => {
    if (pollTimerRef.current !== null) {
      window.clearInterval(pollTimerRef.current);
      pollTimerRef.current = null;
    }
  };

  /** One rolling pass over the audio recorded so far. */
  const pollOnce = async (session: number) => {
    if (!transcribe || pollBusyRef.current) return;
    const total = chunksRef.current.reduce((n, c) => n + c.size, 0);
    if (total === 0) return;
    pollBusyRef.current = true;
    try {
      const mime = baseMime(recorderRef.current);
      const blob = new Blob(chunksRef.current, { type: mime });
      const dataBase64 = await blobToBase64(blob);
      const t = await transcribe({ dataBase64, mimeType: mime });
      if (sessionRef.current === session && t) applyTranscript(t);
    } catch {
      // An interim failure isn't fatal — the next poll (or the final
      // pass on stop) retries with the full audio.
    } finally {
      pollBusyRef.current = false;
    }
  };

  const stopDictation = () => {
    clearPollTimer();
    recorderRef.current?.stop();
  };

  // Unmount (palette closed mid-dictation): stop polling and the mic.
  useEffect(
    () => () => {
      sessionRef.current += 1;
      if (pollTimerRef.current !== null) window.clearInterval(pollTimerRef.current);
      streamRef.current?.getTracks().forEach((t) => t.stop());
    },
    [],
  );

  const toggleMic = async () => {
    if (!transcribe) return;
    if (recording === 'recording') {
      stopDictation();
      return;
    }
    if (recording !== 'idle') return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const session = ++sessionRef.current;
      correctedRef.current = false;
      byteCappedRef.current = false;
      setCorrected(false);
      setLiveText('');
      chunksRef.current = [];
      let recorder: MediaRecorder;
      try {
        recorder = new MediaRecorder(stream, {
          audioBitsPerSecond: DICTATION_AUDIO_BITS_PER_SECOND,
        });
      } catch {
        // A browser that rejects recorder options still records; the
        // byte ceiling below keeps the payload sendable.
        recorder = new MediaRecorder(stream);
      }
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };
      recorder.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        streamRef.current = null;
        void (async () => {
          setRecording('transcribing');
          try {
            const mime = baseMime(recorder);
            const blob = new Blob(chunksRef.current, { type: mime });
            if (blob.size > 0) {
              const dataBase64 = await blobToBase64(blob);
              const t = await transcribe({ dataBase64, mimeType: mime });
              if (sessionRef.current === session && t) applyTranscript(t);
              if (sessionRef.current === session && byteCappedRef.current) {
                byteCappedRef.current = false;
                setRunState({
                  phase: 'done',
                  message: 'Dictation reached its length limit and stopped — the transcript is in the box.',
                });
              }
            }
          } catch (e) {
            // #42: never surface raw gateway text (the owner was shown
            // "gateway 413: request body exceeds 1048576 bytes"). Plain
            // language only; the live transcript still stands.
            const raw = e instanceof Error ? e.message : String(e);
            const tooLarge = /413|exceeds|too large|BODY_TOO_LARGE/i.test(raw);
            setRunState({
              phase: 'error',
              message: tooLarge
                ? 'That recording was too long to send for a final check — the live transcript above still stands; correct it in the box if it isn’t what you said.'
                : 'Dictation’s final pass failed — the live transcript above still stands; correct it in the box if it isn’t what you said.',
            });
          } finally {
            if (sessionRef.current === session) setRecording('idle');
          }
        })();
      };
      recorderRef.current = recorder;
      recorder.start(250);
      startedAtRef.current = Date.now();
      setRecording('recording');
      pollTimerRef.current = window.setInterval(() => {
        if (Date.now() - startedAtRef.current >= MAX_DICTATION_MS) {
          stopDictation();
          return;
        }
        if (chunksRef.current.reduce((n, c) => n + c.size, 0) >= MAX_DICTATION_BYTES) {
          byteCappedRef.current = true;
          stopDictation();
          return;
        }
        void pollOnce(session);
      }, livePollMs);
    } catch (e) {
      setRunState({
        phase: 'error',
        message: `Microphone unavailable: ${e instanceof Error ? e.message : String(e)}`,
      });
    }
  };

  return (
    <A11yDialog title="Voice commands" width={620} onClose={onClose}>
      {gated ? (
        <div data-testid="voice-gate" style={{ padding: '8px 4px' }}>
          <p style={{ fontSize: 28, margin: '4px 0' }} aria-hidden>
            🎙️
          </p>
          <p style={{ fontSize: 15, fontWeight: 600, margin: '4px 0' }}>
            Voice Commands are a Pro feature
          </p>
          <p style={{ fontSize: 13, color: '#475569', lineHeight: 1.55 }}>
            Your account is on the Default tier. The voice command palette — dictate or
            type a command in your own words, see the match, confirm it, and it runs —
            is included with Pro. Everything else in your workspace works as usual.
          </p>
          <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 12 }}>
            <button type="button" onClick={onClose} style={{ padding: '7px 16px' }}>
              Close
            </button>
          </div>
        </div>
      ) : (
        <div>
          <p style={{ fontSize: 12, color: '#64748b', margin: '0 0 8px' }}>
            Pro feature · Speak or type a command in your own words — mangled is fine.
            Nothing runs until you confirm the match.
          </p>
          <div style={{ display: 'flex', gap: 8 }}>
            <input
              data-testid="voice-input"
              value={text}
              onChange={(e) => {
                // Typing during dictation = the user correcting what
                // was heard. Their text wins: live polls stop writing
                // to this box (the panel keeps showing what's heard).
                if (recording === 'recording') {
                  correctedRef.current = true;
                  setCorrected(true);
                }
                onTextChange(e.target.value);
              }}
              onKeyDown={(e) => {
                if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
                  e.preventDefault();
                  void run();
                }
              }}
              placeholder={`e.g. ${VOICE_EXAMPLES[0]}`}
              aria-label="Command in your own words"
              style={{
                flex: 1,
                padding: '10px 12px',
                fontSize: 15,
                boxSizing: 'border-box',
              }}
            />
            {transcribe && (
              <button
                type="button"
                data-testid="voice-mic"
                onClick={() => void toggleMic()}
                aria-label={recording === 'recording' ? 'Stop dictation' : 'Dictate a command'}
                style={{
                  padding: '0 14px',
                  fontSize: 15,
                  background: recording === 'recording' ? '#fee2e2' : undefined,
                }}
              >
                {recording === 'recording' ? '⏹' : recording === 'transcribing' ? '…' : '🎙️'}
              </button>
            )}
          </div>
          <p style={{ fontSize: 12, color: '#94a3b8', margin: '6px 0 0' }}>
            Try: {VOICE_EXAMPLES.slice(0, 4).join('  ·  ')}
          </p>

          {(recording !== 'idle' || liveText) && (
            <div
              data-testid="voice-live"
              style={{
                border: '1px solid #99f6e4',
                background: recording === 'recording' ? '#f0fdfa' : '#f8fafc',
                borderRadius: 8,
                padding: '8px 12px',
                marginTop: 10,
              }}
            >
              <span
                style={{
                  fontSize: 11,
                  fontWeight: 700,
                  letterSpacing: 0.4,
                  color: recording === 'recording' ? '#0f766e' : '#475569',
                }}
              >
                {recording === 'recording'
                  ? '● LISTENING — LIVE TRANSCRIPT'
                  : recording === 'transcribing'
                    ? 'HEARD — FINAL PASS…'
                    : 'HEARD'}
              </span>
              <p data-testid="voice-live-text" style={{ fontSize: 14, margin: '4px 0 0' }}>
                {liveText || '…'}
              </p>
              <p style={{ fontSize: 11, color: '#64748b', margin: '4px 0 0' }}>
                {corrected
                  ? 'You corrected the text — the box above is what gets matched, not this transcript.'
                  : 'Words appear here as they’re heard. If this isn’t what you said, type the correction in the box — your edit wins.'}
              </p>
            </div>
          )}

          {text.trim() && !resolution && (
            <>
              <p data-testid="voice-nomatch" style={{ fontSize: 13, color: '#b45309' }}>
                No command matches “{text}”. Try one of the examples above.
              </p>
              {onAskAgent && (
                <button
                  type="button"
                  data-testid="voice-ask-agent"
                  onClick={() => onAskAgent(text.trim())}
                  style={{
                    padding: '7px 14px',
                    fontSize: 13,
                    fontWeight: 600,
                    borderRadius: 8,
                    border: '1px solid #cbd5e1',
                    background: '#f8fafc',
                    cursor: 'pointer',
                  }}
                >
                  Ask the agent instead
                </button>
              )}
            </>
          )}

          {resolution && (
            <div
              data-testid="voice-preview"
              style={{
                border: '1px solid #cbd5e1',
                borderRadius: 8,
                padding: '10px 12px',
                marginTop: 10,
              }}
            >
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
                <span data-testid="voice-match-name" style={{ fontSize: 15, fontWeight: 700 }}>
                  {resolution.name}
                </span>
                <span style={{ fontSize: 11, color: '#94a3b8' }}>
                  match {Math.round(resolution.score * 100)}%
                </span>
                <span style={{ flex: 1 }} />
                <span style={{ fontSize: 12, color: '#475569' }}>
                  target {sheet}!{toA1(selection.row, selection.col)}
                </span>
              </div>
              <p data-testid="voice-action" style={{ fontSize: 13, margin: '6px 0 0' }}>
                {resolution.actionLabel}
              </p>

              {onAskAgent && resolution.score < CONFIDENT_MATCH_SCORE && (
                <p style={{ fontSize: 12, color: '#64748b', margin: '6px 0 0' }}>
                  Not sure this is the right match.{' '}
                  <button
                    type="button"
                    data-testid="voice-ask-agent"
                    onClick={() => onAskAgent(text.trim())}
                    style={{
                      padding: '2px 8px',
                      fontSize: 12,
                      borderRadius: 999,
                      border: '1px solid #cbd5e1',
                      background: '#f8fafc',
                      cursor: 'pointer',
                    }}
                  >
                    Ask the agent instead
                  </button>
                </p>
              )}

              {resolution.kind === 'formula' && (
                <div style={{ marginTop: 8 }}>
                  <input
                    data-testid="voice-formula-edit"
                    value={effectiveFormula}
                    onChange={(e) => {
                      setEditedFormula(e.target.value);
                      setRunState({ phase: 'idle' });
                    }}
                    aria-label="Formula to insert (editable)"
                    spellCheck={false}
                    style={{
                      width: '100%',
                      boxSizing: 'border-box',
                      padding: '8px 10px',
                      fontSize: 14,
                      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                    }}
                  />
                  {formulaError && (
                    <p style={{ fontSize: 12, color: '#b45309', margin: '4px 0 0' }}>
                      {formulaError}
                    </p>
                  )}
                </div>
              )}

              {resolution.missing && resolution.kind !== 'formula' && (
                <p style={{ fontSize: 12, color: '#b45309', margin: '6px 0 0' }}>
                  {resolution.missing}
                </p>
              )}
              {resolution.missing && resolution.kind === 'formula' && !editedFormula && (
                <p style={{ fontSize: 12, color: '#64748b', margin: '6px 0 0' }}>
                  {resolution.missing}
                </p>
              )}

              {resolution.alternates.length > 0 && (
                <div data-testid="voice-alternates" style={{ marginTop: 8, fontSize: 12 }}>
                  <span style={{ color: '#64748b' }}>Did you mean: </span>
                  {resolution.alternates.map((alt) => (
                    <button
                      key={alt.name}
                      type="button"
                      onClick={() => pickAlternate(alt.name)}
                      style={{
                        marginLeft: 6,
                        padding: '2px 8px',
                        fontSize: 12,
                        borderRadius: 999,
                        border: '1px solid #cbd5e1',
                        background: '#f8fafc',
                        cursor: 'pointer',
                      }}
                    >
                      {alt.name}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          {!ready && (
            <p style={{ fontSize: 12, color: '#b45309', marginTop: 8 }}>
              Workbook is still loading — commands unlock when it finishes.
            </p>
          )}
          {ready && !mcpCall && (
            <p data-testid="voice-boundary" style={{ fontSize: 12, color: '#b45309', marginTop: 8 }}>
              Execution is unavailable in hosted sessions (v1): voice commands run
              through the local engine, like generated apps. Matching and preview
              still work here.
            </p>
          )}

          {readResult && (
            <div data-testid="voice-read-result" style={{ marginTop: 10, overflowX: 'auto' }}>
              <table style={{ borderCollapse: 'collapse', fontSize: 13 }}>
                <tbody>
                  {readResult.map((row, ri) => (
                    <tr key={ri}>
                      {(row as unknown[]).map((cell, ci) => (
                        <td
                          key={ci}
                          style={{ border: '1px solid #e2e8f0', padding: '3px 8px' }}
                        >
                          {formatCellValue(cell)}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {runState.phase === 'done' && (
            <p data-testid="voice-result" role="status" style={{ fontSize: 13, color: '#15803d', marginTop: 8 }}>
              ✓ {runState.message}
            </p>
          )}
          {runState.phase === 'error' && (
            <p data-testid="voice-error" role="alert" style={{ fontSize: 13, color: '#b91c1c', marginTop: 8 }}>
              {runState.message}
            </p>
          )}

          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 12 }}>
            <button type="button" onClick={onClose} style={{ padding: '7px 14px' }}>
              Close
            </button>
            <button
              type="button"
              data-testid="voice-run"
              disabled={!canRun}
              onClick={() => void run()}
              style={{
                padding: '7px 16px',
                fontWeight: 600,
                opacity: canRun ? 1 : 0.45,
                cursor: canRun ? 'pointer' : 'not-allowed',
              }}
            >
              {runState.phase === 'running' ? 'Running…' : 'Run command'}
            </button>
          </div>
          <p style={{ fontSize: 11, color: '#94a3b8', margin: '6px 0 0', textAlign: 'right' }}>
            Ctrl+Enter runs the shown match — nothing runs before you confirm.
          </p>
        </div>
      )}
    </A11yDialog>
  );
}
