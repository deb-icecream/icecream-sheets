/**
 * User directory (issue #84a): email -> principal lookup for
 * invite-by-email in the Share dialog.
 *
 * The gateway verifies Firebase ID tokens itself and mints gateway
 * JWTs without ever persisting the user — so before this file there
 * was no email->principal directory anywhere, and the dialog could
 * only invite by bare account ID (a uid nobody knows). The directory
 * is filled from sign-ins: every successful /auth/firebase exchange
 * records { uid, email, name } best-effort (a directory write failure
 * must never fail a login). Lookup is deliberately owner-scoped at
 * the HTTP layer (GET /api/users/by-email requires the caller to own
 * the file being shared), so the directory cannot be scraped by
 * strangers probing emails.
 *
 * HONEST LIMIT: only people who have signed in at least once are
 * resolvable. Inviting an email with no sign-in yet answers 404
 * ('no account found for that email'), and the dialog says plainly
 * that the person must sign in once first. No Firebase Admin SDK is
 * involved (it would need new IAM + a dependency, unverifiable from
 * here); the sign-in record IS the directory.
 *
 * Adapters mirror the userStore posture: local JSON (gateway-only
 * writer, so an in-process promise-chain mutex + atomic tmp+rename
 * is sufficient — unlike the file registry, no engine process ever
 * writes this store), memory (tests), prod (Firestore, one document
 * per normalized email in `icecream_user_directory`).
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sessionDataDir, type FirestoreLike } from './sessionStore.js';

/** A directory entry: the principal the Share dialog grants to. */
export interface DirectoryEntry {
  principal: string;
  email: string;
  name?: string;
}

export interface UserDirectory {
  /** Best-effort sign-in record; no email -> no-op (dev logins). */
  recordSignIn(userId: string, email?: string, name?: string): Promise<void>;
  /** Exact normalized-email match, or null. */
  lookupByEmail(email: string): Promise<DirectoryEntry | null>;
}

/** Trim + lowercase: the directory keys on exactly this form. */
export function normalizeDirectoryEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** Minimal email shape check (no spaces, one @, nonempty sides). */
export function isDirectoryEmail(email: string): boolean {
  const t = email.trim();
  if (t.length === 0 || t.length > 254) return false;
  if (/\s/.test(t)) return false;
  const parts = t.split('@');
  return parts.length === 2 && parts[0].length > 0 && parts[1].length > 0;
}

function toPrincipal(userId: string): string {
  return `user:${userId}`;
}

/** USER_DIRECTORY_STORE: 'local' (default) | 'prod' (Firestore). */
export function userDirectoryProvider(env: NodeJS.ProcessEnv = process.env): 'local' | 'prod' {
  const v = (env.USER_DIRECTORY_STORE ?? '').trim().toLowerCase();
  if (v === 'prod' || v === 'firestore') return 'prod';
  if (v === 'local') return 'local';
  // The hosted gateway runs USER_STORE=prod; the directory rides the
  // same database as the tier store + catalog in that mode.
  return (env.USER_STORE ?? '').trim().toLowerCase() === 'prod' ? 'prod' : 'local';
}

export function userDirectoryDir(env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = (env.USER_DIRECTORY_DIR ?? '').trim();
  return fromEnv !== '' ? fromEnv : join(sessionDataDir(env), 'user-directory');
}

export class MemoryUserDirectory implements UserDirectory {
  private readonly byEmail = new Map<string, DirectoryEntry>();

  async recordSignIn(userId: string, email?: string, name?: string): Promise<void> {
    if (!email) return;
    const key = normalizeDirectoryEmail(email);
    if (!isDirectoryEmail(key)) return;
    this.byEmail.set(key, {
      principal: toPrincipal(userId),
      email: key,
      ...(name ? { name } : {}),
    });
  }

  async lookupByEmail(email: string): Promise<DirectoryEntry | null> {
    return this.byEmail.get(normalizeDirectoryEmail(email)) ?? null;
  }
}

type DirectoryFileShape = Record<string, DirectoryEntry>;

export class LocalUserDirectory implements UserDirectory {
  private readonly file: string;
  /** In-process write serialization (gateway is the sole writer). */
  private queue: Promise<void> = Promise.resolve();

  constructor(dir: string) {
    mkdirSync(dir, { recursive: true });
    this.file = join(dir, 'user-directory.json');
  }

  private readAll(): DirectoryFileShape {
    try {
      const parsed = JSON.parse(readFileSync(this.file, 'utf8')) as DirectoryFileShape;
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }

  private writeAll(all: DirectoryFileShape): void {
    const tmp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(all), 'utf8');
    renameSync(tmp, this.file);
  }

  async recordSignIn(userId: string, email?: string, name?: string): Promise<void> {
    if (!email) return;
    const key = normalizeDirectoryEmail(email);
    if (!isDirectoryEmail(key)) return;
    const entry: DirectoryEntry = {
      principal: toPrincipal(userId),
      email: key,
      ...(name ? { name } : {}),
    };
    const run = this.queue.then(() => {
      const all = this.readAll();
      all[key] = entry;
      this.writeAll(all);
    });
    this.queue = run.catch(() => undefined);
    await run;
  }

  async lookupByEmail(email: string): Promise<DirectoryEntry | null> {
    return this.readAll()[normalizeDirectoryEmail(email)] ?? null;
  }
}

const USER_DIRECTORY_COLLECTION = 'icecream_user_directory';

export class FirestoreUserDirectory implements UserDirectory {
  constructor(private readonly db: FirestoreLike) {}

  private doc(email: string) {
    return this.db.collection(USER_DIRECTORY_COLLECTION).doc(normalizeDirectoryEmail(email));
  }

  async recordSignIn(userId: string, email?: string, name?: string): Promise<void> {
    if (!email) return;
    const key = normalizeDirectoryEmail(email);
    if (!isDirectoryEmail(key)) return;
    const entry: DirectoryEntry = {
      principal: toPrincipal(userId),
      email: key,
      ...(name ? { name } : {}),
    };
    await this.doc(key).set(entry as unknown as Record<string, unknown>);
  }

  async lookupByEmail(email: string): Promise<DirectoryEntry | null> {
    const snap = await this.doc(email).get();
    if (!snap.exists) return null;
    const data = snap.data();
    if (!data || typeof (data as { principal?: unknown }).principal !== 'string') return null;
    return data as unknown as DirectoryEntry;
  }
}

export function createUserDirectory(
  env: NodeJS.ProcessEnv = process.env,
  opts: { firestoreDb?: FirestoreLike; dir?: string } = {},
): UserDirectory {
  if (userDirectoryProvider(env) === 'prod') {
    if (!opts.firestoreDb) {
      throw new Error(
        'user directory: prod mode requires a Firestore client (credentials) — refusing to fall back to a local store (fail closed)',
      );
    }
    return new FirestoreUserDirectory(opts.firestoreDb);
  }
  return new LocalUserDirectory(opts.dir ?? userDirectoryDir(env));
}
