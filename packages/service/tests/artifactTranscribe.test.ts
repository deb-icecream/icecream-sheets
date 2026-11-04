/**
 * Dictation transcription tests (voice command palette, user ruling
 * 2026-10-21: cheapest Gemini on Vertex AI). The model constant, the
 * request shape (audio inlineData + instruction, temperature 0), the
 * credentials failure, and the response parsing are all pinned here
 * with a fake fetch — no network.
 */
import { describe, expect, it } from 'vitest';
import {
  TestTranscriber,
  VertexTranscriber,
  VERTEX_STT_MODEL,
} from '../src/artifacts/transcribe.js';

const CLIP = { dataBase64: 'QUJD', mimeType: 'audio/webm' };

function okFetch(captured: { url?: string; init?: RequestInit }) {
  return (async (url: string, init: RequestInit) => {
    captured.url = url;
    captured.init = init;
    return {
      ok: true,
      status: 200,
      json: async () => ({
        candidates: [
          { content: { parts: [{ text: '  some if b2 to b20 greater than 10  ' }] } },
        ],
      }),
      text: async () => '',
    } as unknown as Response;
  }) as typeof fetch;
}

describe('VertexTranscriber', () => {
  it('uses the cheapest Gemini model by default (user ruling)', () => {
    expect(VERTEX_STT_MODEL).toBe('gemini-3.1-flash-lite');
    const t = new VertexTranscriber({
      project: 'dreamscapes-zero',
      getAccessToken: async () => 'tok',
      fetchImpl: okFetch({}),
    });
    expect(t.modelId).toBe('gemini-3.1-flash-lite');
  });

  it('posts the audio clip to Vertex generateContent and returns the transcript', async () => {
    const captured: { url?: string; init?: RequestInit } = {};
    const t = new VertexTranscriber({
      project: 'dreamscapes-zero',
      getAccessToken: async () => 'tok-123',
      fetchImpl: okFetch(captured),
    });
    const text = await t.transcribe(CLIP);
    expect(text).toBe('some if b2 to b20 greater than 10');
    // Default location is 'global' (the default model serves only there);
    // the global endpoint lives on the bare aiplatform.googleapis.com host.
    expect(captured.url).toBe(
      'https://aiplatform.googleapis.com/v1/projects/dreamscapes-zero/' +
        'locations/global/publishers/google/models/gemini-3.1-flash-lite:generateContent',
    );
    const headers = captured.init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer tok-123');
    const body = JSON.parse(String(captured.init?.body)) as {
      contents: { parts: unknown[] }[];
      generationConfig: { temperature: number };
    };
    expect(body.contents[0].parts[0]).toEqual({
      inlineData: { mimeType: 'audio/webm', data: 'QUJD' },
    });
    expect(body.generationConfig.temperature).toBe(0);
  });

  it('an explicit regional location still produces the regional host', async () => {
    const captured: { url?: string; init?: RequestInit } = {};
    const t = new VertexTranscriber({
      project: 'dreamscapes-zero',
      location: 'us-central1',
      getAccessToken: async () => 'tok-123',
      fetchImpl: okFetch(captured),
    });
    await t.transcribe(CLIP);
    expect(captured.url).toBe(
      'https://us-central1-aiplatform.googleapis.com/v1/projects/dreamscapes-zero/' +
        'locations/us-central1/publishers/google/models/gemini-3.1-flash-lite:generateContent',
    );
  });

  it('fails clearly when no credentials are available', async () => {
    const t = new VertexTranscriber({
      project: 'dreamscapes-zero',
      getAccessToken: async () => null,
      fetchImpl: okFetch({}),
    });
    await expect(t.transcribe(CLIP)).rejects.toThrow(/credentials are not configured/);
  });

  it('rejects empty clips and non-audio mime types before any request', async () => {
    let called = false;
    const fetchImpl = (async () => {
      called = true;
      throw new Error('should not be called');
    }) as unknown as typeof fetch;
    const t = new VertexTranscriber({
      project: 'p',
      getAccessToken: async () => 'tok',
      fetchImpl,
    });
    await expect(t.transcribe({ dataBase64: '', mimeType: 'audio/webm' })).rejects.toThrow(/empty/);
    await expect(t.transcribe({ dataBase64: 'QUJD', mimeType: 'video/mp4' })).rejects.toThrow(
      /unsupported mime/,
    );
    expect(called).toBe(false);
  });

  it('surfaces Vertex HTTP errors with the status', async () => {
    const fetchImpl = (async () =>
      ({
        ok: false,
        status: 403,
        json: async () => ({}),
        text: async () => 'permission denied',
      }) as unknown as Response) as unknown as typeof fetch;
    const t = new VertexTranscriber({
      project: 'p',
      getAccessToken: async () => 'tok',
      fetchImpl,
    });
    await expect(t.transcribe(CLIP)).rejects.toThrow(/Vertex AI error 403/);
  });

  it('model is overridable per deployment (config seam)', async () => {
    const captured: { url?: string } = {};
    const t = new VertexTranscriber({
      project: 'p',
      model: 'gemini-3.1-flash-lite',
      getAccessToken: async () => 'tok',
      fetchImpl: okFetch(captured),
    });
    await t.transcribe(CLIP);
    expect(captured.url).toContain('gemini-3.1-flash-lite');
  });
});

describe('TestTranscriber', () => {
  it('returns the canned transcript and records clips, no network surface', async () => {
    const t = new TestTranscriber();
    expect('fetchImpl' in t).toBe(false);
    const text = await t.transcribe(CLIP);
    expect(text).toContain('some if');
    expect(t.clips).toEqual([CLIP]);
  });
});
