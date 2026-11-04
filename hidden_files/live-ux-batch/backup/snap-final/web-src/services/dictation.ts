/**
 * Shared dictation plumbing (#40 §7 / #42): ONE recorder configuration
 * and payload discipline for both dictation surfaces — the voice
 * command palette and the agent chat composer mic. Dictation lands as
 * editable text; nothing is ever sent or executed by dictation itself.
 *
 * #42 discipline: speech-grade 32 kbps Opus (the browser default
 * ~121 kbps crosses the gateway's 1 MiB body cap at ~51 s of the
 * allowed 60 s), a hard byte ceiling as the second line of defense,
 * and plain-language errors — raw gateway text never reaches the user.
 */
import { useEffect, useRef, useState } from 'react';
import type { VoiceTranscribeFn } from '../components/VoiceCommandPalette';

export type { VoiceTranscribeFn };

/** Dictation is capped so rolling re-transcription stays bounded. */
export const MAX_DICTATION_MS = 60_000;
/** Speech for server-side STT: 32 kbps is ample (see #42). */
export const DICTATION_AUDIO_BITS_PER_SECOND = 32_000;
/**
 * Hard byte ceiling: 600 KB of audio is ~800 KB of base64 JSON, still
 * under the gateway's 1 MiB cap. Reaching it stops dictation cleanly
 * and the final pass transcribes what was recorded.
 */
export const MAX_DICTATION_BYTES = 600_000;
/** Interim (live) transcript poll cadence. */
export const DICTATION_POLL_MS = 2000;

export function blobToBase64(blob: Blob): Promise<string> {
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

export function baseMime(recorder: MediaRecorder | null): string {
  return (recorder?.mimeType ?? 'audio/webm').split(';')[0];
}

/** Map a final-pass failure to plain language (#42: no raw gateway text). */
export function dictationFinalError(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e);
  const tooLarge = /413|exceeds|too large|BODY_TOO_LARGE/i.test(raw);
  return tooLarge
    ? 'That recording was too long to send for a final check — the live transcript above still stands; correct it if it isn’t what you said.'
    : 'Dictation’s final pass failed — the live transcript above still stands; correct it if it isn’t what you said.';
}

export type DictationState = 'idle' | 'recording' | 'transcribing';

export interface UseDictation {
  state: DictationState;
  /** Latest interim transcript while recording. */
  liveText: string;
  /** True when dictation stopped at the byte ceiling. */
  capped: boolean;
  start: () => Promise<void>;
  stop: () => void;
  toggle: () => void;
}

/**
 * The recorder hook. onFinal fires once per stopped dictation with the
 * final transcript (or ''), whether it was capped, and a plain-language
 * error when the final pass failed (the live text still stands then).
 * Interim polls re-transcribe the audio so far and their failures are
 * silent by design (the final pass is the one that counts).
 */
export function useDictation(opts: {
  transcribe: VoiceTranscribeFn | null | undefined;
  onFinal: (text: string, info: { capped: boolean; error?: string }) => void;
  onLive?: (text: string) => void;
}): UseDictation {
  const [state, setState] = useState<DictationState>('idle');
  const [liveText, setLiveText] = useState('');
  const [capped, setCapped] = useState(false);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const pollRef = useRef<number | null>(null);
  const startedRef = useRef(0);
  const sessionRef = useRef(0);
  const cappedRef = useRef(false);
  const optsRef = useRef(opts);
  optsRef.current = opts;

  const stop = (): void => {
    if (pollRef.current !== null) window.clearInterval(pollRef.current);
    pollRef.current = null;
    if (recorderRef.current && recorderRef.current.state !== 'inactive') {
      recorderRef.current.stop();
    }
  };

  useEffect(
    () => () => {
      sessionRef.current += 1;
      if (pollRef.current !== null) window.clearInterval(pollRef.current);
      streamRef.current?.getTracks().forEach((t) => t.stop());
    },
    [],
  );

  const start = async (): Promise<void> => {
    const transcribe = optsRef.current.transcribe;
    if (!transcribe || state !== 'idle') return;
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (e) {
      optsRef.current.onFinal('', {
        capped: false,
        error: `Microphone unavailable: ${e instanceof Error ? e.message : String(e)}`,
      });
      return;
    }
    streamRef.current = stream;
    const session = ++sessionRef.current;
    cappedRef.current = false;
    setCapped(false);
    setLiveText('');
    chunksRef.current = [];
    let recorder: MediaRecorder;
    try {
      recorder = new MediaRecorder(stream, { audioBitsPerSecond: DICTATION_AUDIO_BITS_PER_SECOND });
    } catch {
      recorder = new MediaRecorder(stream);
    }
    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) chunksRef.current.push(e.data);
    };
    recorder.onstop = () => {
      stream.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
      void (async () => {
        setState('transcribing');
        try {
          const mime = baseMime(recorder);
          const blob = new Blob(chunksRef.current, { type: mime });
          let text = '';
          if (blob.size > 0) {
            const dataBase64 = await blobToBase64(blob);
            text = await transcribe({ dataBase64, mimeType: mime });
          }
          if (sessionRef.current === session) {
            optsRef.current.onFinal(text, { capped: cappedRef.current });
          }
        } catch (e) {
          if (sessionRef.current === session) {
            optsRef.current.onFinal('', { capped: cappedRef.current, error: dictationFinalError(e) });
          }
        } finally {
          if (sessionRef.current === session) setState('idle');
        }
      })();
    };
    recorderRef.current = recorder;
    recorder.start(250);
    startedRef.current = Date.now();
    setState('recording');
    pollRef.current = window.setInterval(() => {
      if (Date.now() - startedRef.current >= MAX_DICTATION_MS) {
        stop();
        return;
      }
      if (chunksRef.current.reduce((n, c) => n + c.size, 0) >= MAX_DICTATION_BYTES) {
        cappedRef.current = true;
        setCapped(true);
        stop();
        return;
      }
      // Interim pass: transcribe what exists so far; failures silent.
      void (async () => {
        try {
          const mime = baseMime(recorder);
          const blob = new Blob(chunksRef.current, { type: mime });
          if (blob.size === 0) return;
          const dataBase64 = await blobToBase64(blob);
          const t = await transcribe({ dataBase64, mimeType: mime });
          if (sessionRef.current === session && t) {
            setLiveText(t);
            optsRef.current.onLive?.(t);
          }
        } catch {
          /* interim failures are silent by design */
        }
      })();
    }, DICTATION_POLL_MS);
  };

  return {
    state,
    liveText,
    capped,
    start,
    stop,
    toggle: () => {
      if (state === 'recording') stop();
      else void start();
    },
  };
}
