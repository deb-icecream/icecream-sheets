/**
 * Mail connector tests (packages/service/src/connectors/mail.ts).
 * The Gmail HTTP call is faked by stubbing globalThis.fetch — no live HTTP.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  MailConnector,
  MailProviders,
  base64UrlEncode,
  buildMimeMessage,
  createConnectorRegistry,
  resolveDeps,
  utf8Bytes,
} from '../src/connectors/index.js';
import type { ConnectorSpec } from '../src/connectors/index.js';
import type { MailMessage } from '../src/connectors/index.js';

const SPEC_VERSION = 1;

function spec(params: Record<string, string> = {}, credentialRef?: string): ConnectorSpec {
  return {
    version: SPEC_VERSION,
    kind: 'mail',
    label: 'email',
    params,
    ...(credentialRef ? { credentialRef } : {}),
  };
}

const MESSAGE: MailMessage = {
  from: 'sender@example.com',
  to: ['a@example.com', 'b@example.com'],
  cc: ['c@example.com'],
  subject: 'Workbook export',
  body: 'Attached is the workbook.',
  attachments: [
    {
      filename: 'workbook.xlsx',
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      data: utf8Bytes('fake-xlsx-bytes'),
    },
  ],
};

const RESOLVER = { resolveCredential: async (ref: string) => `token-for-${ref}` };

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('base64UrlEncode', () => {
  it('produces unpadded base64url', () => {
    expect(base64UrlEncode(utf8Bytes('hello'))).toBe('aGVsbG8');
    expect(base64UrlEncode(new Uint8Array([251, 255, 190]))).toBe('-_--');
  });
});

describe('buildMimeMessage', () => {
  it('builds a multipart/mixed message with headers, body and attachment', () => {
    const mime = buildMimeMessage(MESSAGE);
    expect(mime).toContain('From: sender@example.com');
    expect(mime).toContain('To: a@example.com, b@example.com');
    expect(mime).toContain('Cc: c@example.com');
    expect(mime).toContain('Subject: Workbook export');
    expect(mime).toContain('Content-Type: multipart/mixed;');
    expect(mime).toContain('Content-Type: text/plain; charset="UTF-8"');
    expect(mime).toContain('Attached is the workbook.');
    expect(mime).toContain('Content-Type: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet; name="workbook.xlsx"');
    expect(mime).toContain('Content-Transfer-Encoding: base64');
    // The attachment bytes round-trip through the base64 payload.
    expect(mime.replace(/\r\n/g, '')).toContain(Buffer.from('fake-xlsx-bytes', 'utf8').toString('base64'));
  });

  it('includes an HTML alternative when bodyHtml is given', () => {
    const mime = buildMimeMessage({ ...MESSAGE, bodyHtml: '<b>hi</b>' });
    expect(mime).toContain('Content-Type: multipart/alternative;');
    expect(mime).toContain('Content-Type: text/html; charset="UTF-8"');
    expect(mime).toContain('<b>hi</b>');
  });

  it('encodes non-ASCII subjects with RFC 2047', () => {
    const mime = buildMimeMessage({ ...MESSAGE, subject: 'Rapport août 📊' });
    expect(mime).toContain('Subject: =?UTF-8?B?');
  });
});

describe('MailConnector.sendEmail', () => {
  function fakeFetch(calls: Array<{ url: string; init: unknown }>, ok = true) {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: unknown) => {
        calls.push({ url, init });
        return {
          ok,
          status: ok ? 200 : 401,
          text: async () => (ok ? '{}' : 'invalid token'),
          json: async () => (ok ? { id: 'msg-123' } : {}),
        };
      }),
    );
  }

  it('sends through the Gmail API with a bearer token from the vault', async () => {
    const calls: Array<{ url: string; init: any }> = [];
    fakeFetch(calls);
    const connector = new MailConnector();
    const deps = resolveDeps({ resolveCredential: RESOLVER });
    const id = await connector.sendEmail(spec({}, 'gmail-token'), MESSAGE, deps);
    expect(id).toBe('msg-123');
    expect(calls.length).toBe(1);
    expect(calls[0]!.url).toBe('https://gmail.googleapis.com/gmail/v1/users/me/messages/send');
    const init = calls[0]!.init;
    expect(init.method).toBe('POST');
    expect(init.headers['Authorization']).toBe('Bearer token-for-gmail-token');
    const payload = JSON.parse(init.body);
    expect(typeof payload.raw).toBe('string');
    // raw decodes back to a MIME message carrying the attachment.
    const rawBytes = Buffer.from(payload.raw.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
    expect(rawBytes.toString('utf8')).toContain('workbook.xlsx');
    // The secret never appears in the spec.
    expect(JSON.stringify(spec({}, 'gmail-token'))).not.toContain('token-for-gmail-token');
  });

  it('fails closed without a credentialRef', async () => {
    const connector = new MailConnector();
    await expect(
      connector.sendEmail(spec(), MESSAGE, resolveDeps({ resolveCredential: RESOLVER })),
    ).rejects.toThrow('credentialRef');
  });

  it('fails closed when no credential resolver is wired', async () => {
    const connector = new MailConnector();
    await expect(
      connector.sendEmail(spec({}, 'gmail-token'), MESSAGE, resolveDeps()),
    ).rejects.toThrow('no credential resolver');
  });

  it('rejects invalid messages without touching the network', async () => {
    const calls: Array<unknown> = [];
    fakeFetch(calls as Array<{ url: string; init: unknown }>);
    const connector = new MailConnector();
    const deps = resolveDeps({ resolveCredential: RESOLVER });
    await expect(
      connector.sendEmail(spec({}, 't'), { ...MESSAGE, to: [] }, deps),
    ).rejects.toThrow('at least one recipient');
    await expect(
      connector.sendEmail(spec({}, 't'), { ...MESSAGE, from: 'not-an-email' }, deps),
    ).rejects.toThrow('from');
    expect(calls.length).toBe(0);
  });

  it('surfaces provider HTTP errors', async () => {
    const calls: Array<{ url: string; init: unknown }> = [];
    fakeFetch(calls, false);
    const connector = new MailConnector();
    await expect(
      connector.sendEmail(spec({}, 't'), MESSAGE, resolveDeps({ resolveCredential: RESOLVER })),
    ).rejects.toThrow('HTTP 401');
  });

  it('rejects unknown providers', async () => {
    const connector = new MailConnector();
    await expect(
      connector.sendEmail(
        spec({ provider: 'carrier-pigeon' }, 't'),
        MESSAGE,
        resolveDeps({ resolveCredential: RESOLVER }),
      ),
    ).rejects.toThrow('unknown mail provider');
  });

  it('registry.fetch() on mail fails with a send-only error', async () => {
    const registry = createConnectorRegistry();
    await expect(registry.fetch(spec())).rejects.toThrow('send-only');
  });

  it('custom providers can register', async () => {
    MailProviders.register({
      id: 'test-mail',
      async sendMail() {
        return 'test-id';
      },
    });
    const connector = new MailConnector();
    const id = await connector.sendEmail(
      spec({ provider: 'test-mail' }, 't'),
      MESSAGE,
      resolveDeps({ resolveCredential: RESOLVER }),
    );
    expect(id).toBe('test-id');
    expect(MailProviders.ids()).toContain('test-mail');
  });
});
