/**
 * Email feature tests (features/email.ts). The Gmail HTTP call is faked by
 * stubbing globalThis.fetch — no live HTTP.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseRecipients, sendWorkbookEmail } from './email';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('parseRecipients', () => {
  it('splits on commas and semicolons, trims, drops empties', () => {
    expect(parseRecipients('a@x.com, b@x.com; c@x.com ,')).toEqual(['a@x.com', 'b@x.com', 'c@x.com']);
    expect(parseRecipients('')).toEqual([]);
  });
});

describe('sendWorkbookEmail', () => {
  function fakeFetch() {
    const calls: Array<{ url: string; init: { headers: Record<string, string>; body: string } }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: { headers: Record<string, string>; body: string }) => {
        calls.push({ url, init });
        return { ok: true, status: 200, json: async () => ({ id: 'msg-1' }) };
      }),
    );
    return calls;
  }

  const BASE = {
    email: {
      from: 'me@example.com',
      to: ['you@example.com'],
      subject: 'Workbook',
      body: 'See attached.',
    },
    attachment: {
      filename: 'workbook.xlsx',
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      data: new TextEncoder().encode('bytes'),
    },
  };

  it('sends with a pasted token (no vault needed)', async () => {
    const calls = fakeFetch();
    const id = await sendWorkbookEmail({ ...BASE, accessToken: 'tok-123' });
    expect(id).toBe('msg-1');
    expect(calls[0]!.init.headers['Authorization']).toBe('Bearer tok-123');
    const raw = JSON.parse(calls[0]!.init.body).raw as string;
    const mime = Buffer.from(raw.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    expect(mime).toContain('workbook.xlsx');
  });

  it('resolves a credentialRef through the injected resolver', async () => {
    const calls = fakeFetch();
    const id = await sendWorkbookEmail({
      ...BASE,
      credentialRef: 'gmail-token',
      resolveCredential: { resolveCredential: async (ref: string) => `secret-${ref}` },
    });
    expect(id).toBe('msg-1');
    expect(calls[0]!.init.headers['Authorization']).toBe('Bearer secret-gmail-token');
  });

  it('fails closed with neither token nor resolver', async () => {
    await expect(sendWorkbookEmail({ ...BASE })).rejects.toThrow('OAuth2 token');
  });

  it('validates recipients before sending', async () => {
    const calls = fakeFetch();
    await expect(
      sendWorkbookEmail({ ...BASE, accessToken: 't', email: { ...BASE.email, to: [] } }),
    ).rejects.toThrow('recipient');
    expect(calls.length).toBe(0);
  });
});
