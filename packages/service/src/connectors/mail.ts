/**
 * Mail connector — send email from Icecream Sheets
 * (design-docs/connector-vs-component.md: "Email uses the Mail connector").
 *
 * This is a SEND connector, not a data-source connector: registry.fetch()
 * on a 'mail' spec throws a clear error directing callers at sendEmail().
 *
 * Authentication: OAuth2 via the service credential vault — the spec carries
 * only an opaque `credentialRef` (never the token), resolved at send time
 * through CredentialResolver. The token is used transiently in the
 * Authorization header and is never persisted or logged.
 *
 * Providers are pluggable via MailProviders.register(). The built-in 'gmail'
 * provider sends through the Gmail REST API
 * (POST /gmail/v1/users/me/messages/send) with a fully-built RFC 5322 /
 * MIME multipart message (base64url-encoded, as the API requires), so
 * workbooks and any other files travel as real attachments.
 *
 * Everything here is headless and dependency-free (no node builtins), so it
 * runs in the browser, the desktop shell, and the service boundary. The
 * Gmail provider POSTs through globalThis.fetch (the connector FetchText
 * seam is GET-text only); tests stub globalThis.fetch and never hit the
 * network.
 */
import type { ConnectorKind, ConnectorSpec } from './spec.js';
import type { Connector, ResolvedConnectorDeps } from './registry.js';

/** One file attachment. `data` is raw bytes; it is base64-encoded for MIME. */
export interface MailAttachment {
  filename: string;
  /** e.g. 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'. */
  mimeType: string;
  data: Uint8Array;
}

/** The email to send. */
export interface MailMessage {
  /** Sender address (must be the mailbox the OAuth2 token belongs to). */
  from: string;
  /** Recipients (at least one required). */
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  /** Plain-text body. At least one of body / bodyHtml is required. */
  body?: string;
  /** Optional HTML body; sent as a multipart/alternative alongside body. */
  bodyHtml?: string;
  attachments?: MailAttachment[];
}

/** What a provider needs: the message plus a transient OAuth2 bearer token. */
export interface MailSendRequest {
  message: MailMessage;
  /** OAuth2 access token (transient — never persisted by providers). */
  accessToken: string;
}

/** A mail provider: the request -> transport-specific HTTP call. */
export interface MailProvider {
  readonly id: string;
  sendMail(req: MailSendRequest, deps: ResolvedConnectorDeps): Promise<string>;
}

/** Base64url (RFC 4648 §5) without padding — what the Gmail API wants. */
export function base64UrlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i]!);
  }
  const b64 = typeof btoa === 'function'
    ? btoa(binary)
    : Buffer.from(binary, 'binary').toString('base64');
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function utf8Bytes(text: string): Uint8Array {
  if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(text);
  return Buffer.from(text, 'utf8');
}

/** Standard base64 (with padding) of raw bytes. */
function base64OfBytes(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]!);
  return typeof btoa === 'function'
    ? btoa(binary)
    : Buffer.from(binary, 'binary').toString('base64');
}

/** Standard base64 (with padding) of UTF-8 text. */
function base64Of(text: string): string {
  return base64OfBytes(utf8Bytes(text));
}

/** RFC 2047 header encoding: ASCII passes through, the rest is base64. */
function encodeHeader(value: string): string {
  if (/^[\x20-\x7e]*$/.test(value)) return value;
  return `=?UTF-8?B?${base64Of(value)}?=`;
}

const CRLF = '\r\n';

/**
 * Build a complete RFC 5322 / MIME multipart message for the Gmail API.
 * Structure: multipart/mixed → (multipart/alternative: text/plain +
 * text/html) + attachments. Exported for tests and for providers that
 * accept raw MIME.
 */
export function buildMimeMessage(msg: MailMessage): string {
  const boundary = `icecream_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e9).toString(36)}`;
  const alt = `icecream_alt_${Math.floor(Math.random() * 1e9).toString(36)}`;
  const parts: string[] = [];
  parts.push(`From: ${msg.from}`);
  parts.push(`To: ${msg.to.join(', ')}`);
  if (msg.cc && msg.cc.length > 0) parts.push(`Cc: ${msg.cc.join(', ')}`);
  // Bcc is deliberately included in the envelope headers for the API's raw
  // send (Gmail strips it before delivery to visible recipients).
  if (msg.bcc && msg.bcc.length > 0) parts.push(`Bcc: ${msg.bcc.join(', ')}`);
  parts.push(`Subject: ${encodeHeader(msg.subject)}`);
  parts.push('MIME-Version: 1.0');
  parts.push(`Content-Type: multipart/mixed; boundary="${boundary}"`);
  parts.push('');
  parts.push(`--${boundary}`);
  parts.push(`Content-Type: multipart/alternative; boundary="${alt}"`);
  parts.push('');
  if (msg.body !== undefined) {
    parts.push(`--${alt}`);
    parts.push('Content-Type: text/plain; charset="UTF-8"');
    parts.push('Content-Transfer-Encoding: 8bit');
    parts.push('');
    parts.push(msg.body);
    parts.push('');
  }
  if (msg.bodyHtml !== undefined) {
    parts.push(`--${alt}`);
    parts.push('Content-Type: text/html; charset="UTF-8"');
    parts.push('Content-Transfer-Encoding: 8bit');
    parts.push('');
    parts.push(msg.bodyHtml);
    parts.push('');
  }
  parts.push(`--${alt}--`);
  parts.push('');
  for (const att of msg.attachments ?? []) {
    const padded = base64OfBytes(att.data);
    parts.push(`--${boundary}`);
    parts.push(`Content-Type: ${att.mimeType}; name="${encodeHeader(att.filename)}"`);
    parts.push('Content-Transfer-Encoding: base64');
    parts.push(`Content-Disposition: attachment; filename="${encodeHeader(att.filename)}"`);
    parts.push('');
    // MIME line length: 76 chars.
    for (let i = 0; i < padded.length; i += 76) {
      parts.push(padded.slice(i, i + 76));
    }
    parts.push('');
  }
  parts.push(`--${boundary}--`);
  return parts.join(CRLF);
}

/** The built-in Gmail provider (real Gmail REST API, OAuth2 bearer). */
const gmailProvider: MailProvider = {
  id: 'gmail',
  async sendMail(req, deps): Promise<string> {
    const mime = buildMimeMessage(req.message);
    const raw = base64UrlEncode(utf8Bytes(mime));
    const res = await globalThis.fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${req.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ raw }),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(
        `Gmail send failed (HTTP ${res.status})${detail ? `: ${detail.slice(0, 500)}` : ''}`,
      );
    }
    const doc = (await res.json()) as { id?: unknown };
    if (typeof doc.id !== 'string' || doc.id === '') {
      throw new Error('Gmail send returned no message id');
    }
    return doc.id;
  },
};

/** Pluggable provider registry (tests / hosts register more). */
export const MailProviders = {
  _providers: new Map<string, MailProvider>([['gmail', gmailProvider]]),
  register(p: MailProvider): void {
    this._providers.set(p.id.toLowerCase(), p);
  },
  get(id: string): MailProvider | undefined {
    return this._providers.get(id.toLowerCase());
  },
  ids(): string[] {
    return [...this._providers.keys()];
  },
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function validateMessage(msg: MailMessage): string[] {
  const errors: string[] = [];
  if (!EMAIL_RE.test(msg.from.trim())) errors.push('message.from must be an email address');
  if (!msg.to || msg.to.length === 0) errors.push('message.to needs at least one recipient');
  for (const addr of [...(msg.to ?? []), ...(msg.cc ?? []), ...(msg.bcc ?? [])]) {
    if (!EMAIL_RE.test(addr.trim())) errors.push(`invalid recipient address "${addr}"`);
  }
  if (msg.subject.trim() === '') errors.push('message.subject must not be empty');
  if ((msg.body ?? '').trim() === '' && (msg.bodyHtml ?? '').trim() === '') {
    errors.push('message needs a text body and/or an HTML body');
  }
  for (const att of msg.attachments ?? []) {
    if (att.filename.trim() === '') errors.push('attachment filename must not be empty');
    if (att.mimeType.trim() === '') errors.push(`attachment "${att.filename}" needs a MIME type`);
    if (!(att.data instanceof Uint8Array)) errors.push(`attachment "${att.filename}" data must be bytes`);
  }
  return errors;
}

export class MailConnector implements Connector {
  readonly kind: ConnectorKind = 'mail';
  readonly displayName = 'Email (Mail connector)';
  readonly paramHelp =
    'No required params. provider: gmail (default, OAuth2 token via credentialRef). ' +
    'credentialRef: vault reference for the OAuth2 access token of the sender mailbox.';

  /** Mail is send-only: data-source fetch() is not supported. */
  async fetch(): Promise<never> {
    throw new Error(
      'the mail connector is send-only: use sendEmail(spec, message, deps) instead of registry.fetch()',
    );
  }

  /**
   * Send an email through the configured provider. Resolves the OAuth2
   * token from spec.credentialRef via the vault resolver (fails closed),
   * then hands the message + transient token to the provider. Returns the
   * provider's message id.
   */
  async sendEmail(
    spec: ConnectorSpec,
    message: MailMessage,
    deps: ResolvedConnectorDeps,
  ): Promise<string> {
    if (spec.kind !== 'mail') {
      throw new Error(`mail connector needs a "mail" spec (got "${spec.kind}")`);
    }
    const msgErrors = validateMessage(message);
    if (msgErrors.length > 0) {
      throw new Error(`invalid mail message: ${msgErrors.join('; ')}`);
    }
    const providerId = (spec.params['provider'] ?? 'gmail').trim().toLowerCase() || 'gmail';
    const provider = MailProviders.get(providerId);
    if (!provider) {
      throw new Error(
        `unknown mail provider "${providerId}" (known: ${MailProviders.ids().join(', ')})`,
      );
    }
    if (!spec.credentialRef) {
      throw new Error(
        'mail needs an OAuth2 token: put a credentialRef on the spec (the secret lives in the vault, never in the spec)',
      );
    }
    if (!deps.resolveCredential) {
      throw new Error(
        `spec needs credential "${spec.credentialRef}" but no credential resolver is wired`,
      );
    }
    const accessToken = await deps.resolveCredential.resolveCredential(spec.credentialRef);
    if (accessToken.trim() === '') {
      throw new Error('vault returned an empty token for the mail credential');
    }
    return provider.sendMail({ message, accessToken }, deps);
  }
}
