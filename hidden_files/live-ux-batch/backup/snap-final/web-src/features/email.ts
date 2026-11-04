/**
 * Email a workbook (File > Email).
 *
 * Sends the workbook (or the active sheet) as an attachment through the
 * service Mail connector (packages/service/src/connectors/mail.ts):
 * OAuth2 via vault credentialRef — the spec carries only the opaque
 * reference, the token is resolved transiently and never persisted.
 *
 * In the browser the credential resolver is wired by the caller: either a
 * user-pasted OAuth2 access token (kept in memory only, never stored) or
 * the gateway vault when the app runs against deployed services.
 */
import {
  MailConnector,
  resolveDeps,
  type ConnectorSpec,
  type CredentialResolver,
  type MailAttachment,
  type MailMessage,
} from '@icecream-sheets/service/connectors';

export interface WorkbookEmail {
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  body: string;
  from: string;
}

export interface SendWorkbookEmailOptions {
  /** The email fields. */
  email: WorkbookEmail;
  /** Workbook bytes to attach. */
  attachment: { filename: string; mimeType: string; data: Uint8Array };
  /**
   * Vault credentialRef for the sender's OAuth2 token. Omit when
   * `accessToken` is supplied directly (pasted token flow).
   */
  credentialRef?: string;
  /** A user-pasted OAuth2 access token (in-memory only). */
  accessToken?: string;
  /** Resolves credentialRef -> token; required when no accessToken is given. */
  resolveCredential?: CredentialResolver;
  /** Mail provider id. Defaults to 'gmail'. */
  provider?: string;
}

function resolverFor(options: SendWorkbookEmailOptions): CredentialResolver {
  if (options.accessToken && options.accessToken.trim() !== '') {
    const token = options.accessToken;
    return { resolveCredential: async () => token };
  }
  if (!options.resolveCredential) {
    throw new Error(
      'Email needs an OAuth2 token: paste an access token or connect the credential vault.',
    );
  }
  return options.resolveCredential;
}

/**
 * Send the workbook as an email attachment. Returns the provider's
 * message id. The attachment bytes travel inside the MIME message; the
 * OAuth2 token is used transiently in the Authorization header.
 */
export async function sendWorkbookEmail(options: SendWorkbookEmailOptions): Promise<string> {
  const { email, attachment } = options;
  const message: MailMessage = {
    from: email.from,
    to: email.to,
    cc: email.cc,
    bcc: email.bcc,
    subject: email.subject,
    body: email.body,
  };
  const attachments: MailAttachment[] = [
    { filename: attachment.filename, mimeType: attachment.mimeType, data: attachment.data },
  ];
  const spec: ConnectorSpec = {
    version: 1,
    kind: 'mail',
    label: 'Email workbook',
    params: { provider: options.provider ?? 'gmail' },
    // Pasted-token flow: the resolver below returns the token directly;
    // the ref is still required on the spec, so use a local pseudo-ref.
    credentialRef: options.credentialRef ?? 'local-pasted-token',
  };
  const connector = new MailConnector();
  const deps = resolveDeps({ resolveCredential: resolverFor(options) });
  return connector.sendEmail(spec, { ...message, attachments }, deps);
}

/** Split a comma/semicolon-separated recipient line into addresses. */
export function parseRecipients(line: string): string[] {
  return line
    .split(/[;,]/)
    .map((s) => s.trim())
    .filter((s) => s !== '');
}
