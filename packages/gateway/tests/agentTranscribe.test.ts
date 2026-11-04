/**
 * POST /transcribe on the agent service (voice command palette
 * dictation). The route delegates to an injected Transcriber — here a
 * fake — so the HTTP contract (200/400/413/502/503) is pinned without
 * any network. The production transcriber is the service package's
 * VertexTranscriber on the cheapest Gemini (VERTEX_STT_MODEL).
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { Transcriber } from '@icecream-sheets/service';
import { createAgentListener } from '../src/services/agentSvc.js';
import { httpJson, startServer, stop, type Started } from './helpers.js';

const ALICE = { 'x-principal': 'user:alice' };

const fakeTranscriber: Transcriber = {
  name: 'fake',
  modelId: 'gemini-2.5-flash-lite',
  transcribe: async (clip) => {
    if (clip.dataBase64 === 'BAD') throw new Error('Vertex AI error 500: boom');
    return 'some if b2 to b20 greater than 10';
  },
};

describe('agent /transcribe', () => {
  let svc: Started | null = null;
  afterEach(async () => {
    if (svc) await stop(svc);
    svc = null;
  });

  async function setup(transcriber: Transcriber | null) {
    svc = await startServer(createAgentListener({ transcriber }));
  }
  const post = (path: string, body: unknown) =>
    httpJson('POST', `${svc!.url}${path}`, { headers: ALICE, body });

  it('transcribes a clip and reports the model', async () => {
    await setup(fakeTranscriber);
    const r = await post('/transcribe', { audioBase64: 'QUJD', mimeType: 'audio/webm' });
    expect(r.status).toBe(200);
    const json = r.json as { ok: boolean; text: string; model: string };
    expect(json.ok).toBe(true);
    expect(json.text).toBe('some if b2 to b20 greater than 10');
    expect(json.model).toBe('gemini-2.5-flash-lite');
  });

  it('503 when dictation is not configured', async () => {
    await setup(null);
    const r = await post('/transcribe', { audioBase64: 'QUJD', mimeType: 'audio/webm' });
    expect(r.status).toBe(503);
    expect(JSON.stringify(r.json)).toContain('not configured');
  });

  it('400 on a malformed body', async () => {
    await setup(fakeTranscriber);
    const r1 = await post('/transcribe', { mimeType: 'audio/webm' });
    expect(r1.status).toBe(400);
    const r2 = await post('/transcribe', { audioBase64: 'QUJD', mimeType: 'video/mp4' });
    expect(r2.status).toBe(400);
  });

  it('502 when the transcriber fails', async () => {
    await setup(fakeTranscriber);
    const r = await post('/transcribe', { audioBase64: 'BAD', mimeType: 'audio/webm' });
    expect(r.status).toBe(502);
    expect(JSON.stringify(r.json)).toContain('Vertex AI error 500');
  });
});
