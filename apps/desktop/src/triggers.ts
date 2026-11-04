/**
 * Trigger hosting for desktop local mode (automation-lane.md §1, §3, §5;
 * hosting design in hidden_files/triggers/REPORT.md).
 *
 * Electron main hosts a SessionTriggerHost (service package,
 * '@icecream-sheets/service/automation-node') against the singleton
 * in-process EngineHost: trigger writes mutate the live model through
 * the permissioned automation API and persist via the normal
 * direct-save/checkpoint path. One SessionTriggerHost serves the
 * CURRENT workbook at a time:
 *
 *  - Scope = the open file's absolute path, or 'untitled' before any
 *    save/open (and for a brand-new workbook). Trigger specs + grant
 *    records persist per scope, so different files never see each
 *    other's triggers.
 *  - setScope() runs at startup (untitled), on every workbook open
 *    (engine:load) and on every New (engine:new / menu New): it
 *    detaches the previous host, creates a new one for the new scope,
 *    attaches it to the SAME engine host and fires onOpen.
 *
 * This module is Electron-free (unit-testable): the persistence is a
 * small file-backed adapter rooted at an injected directory (the app
 * data dir's `triggers` subdir in main.ts), mirroring the gateway's
 * filePersistence.ts semantics — the desktop cannot import the gateway
 * package, so the adapter is implemented locally here.
 *
 * Events offered: onOpen, onEdit, onInterval, onAtTime. onSelectionChange
 * is NOT offered: selection is renderer-local and no trigger host can
 * observe it (named follow-up in the hosting design).
 */

import { createHash } from 'node:crypto';
import {
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import type { EngineHost } from '@icecream-sheets/engine';
import type { Persistence, TriggerSpecInit } from '@icecream-sheets/service';
import {
  SessionTriggerHost,
  type TriggerStatus,
} from '@icecream-sheets/service/automation-node';

export type { TriggerStatus };

/** Events the desktop topology can actually fire (the UI offers only these). */
export const DESKTOP_TRIGGER_EVENTS: readonly string[] = [
  'onOpen',
  'onEdit',
  'onInterval',
  'onAtTime',
];

/** Scope for a workbook that has no file path yet (startup / New). */
export const UNTITLED_TRIGGER_SCOPE = 'untitled';

/** list() result shape — the desktop bridge contract (gateway contract minus fileId). */
export interface TriggerListResult {
  events: string[];
  triggers: TriggerStatus[];
}

// ---------------------------------------------------------------------------
// File-backed Persistence (mirrors packages/gateway/src/filePersistence.ts)
//
// One file per metadata-store key under the root directory. Filenames are
// sanitized (keys embed the scope — a file path) with a hash suffix so
// distinct keys never collide. Writes are atomic (temp file + rename);
// load() returns null for a missing key. The interface is synchronous,
// matching Persistence.
// ---------------------------------------------------------------------------

/** One file per key: sanitized name + hash suffix (no collisions). */
export function triggerPersistenceFileFor(dir: string, key: string): string {
  const safe = key
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .slice(0, 120)
    .replace(/^\.+/, '');
  const hash = createHash('sha256').update(key, 'utf8').digest('hex').slice(0, 16);
  return join(dir, `${safe === '' ? 'key' : safe}.${hash}.json`);
}

/**
 * Build a file-backed Persistence rooted at `dir` (created on demand).
 * Each save() rewrites the whole key file atomically.
 */
export function createTriggerFilePersistence(dir: string): Persistence {
  mkdirSync(dir, { recursive: true });
  return {
    load: (key: string): string | null => {
      try {
        return readFileSync(triggerPersistenceFileFor(dir, key), 'utf8');
      } catch (e) {
        if ((e as NodeJS.ErrnoException)?.code === 'ENOENT') return null;
        throw e;
      }
    },
    save: (key: string, value: string): void => {
      const target = triggerPersistenceFileFor(dir, key);
      const tmp = `${target}.${process.pid}.tmp`;
      writeFileSync(tmp, value, 'utf8');
      renameSync(tmp, target);
    },
    clear: (key: string): void => {
      try {
        unlinkSync(triggerPersistenceFileFor(dir, key));
      } catch (e) {
        if ((e as NodeJS.ErrnoException)?.code !== 'ENOENT') throw e;
      }
    },
  };
}

// ---------------------------------------------------------------------------
// TriggerHostManager
// ---------------------------------------------------------------------------

export interface TriggerHostManagerDeps {
  /** The singleton main-process engine host (stable for the app lifetime). */
  host: EngineHost;
  /** Directory the file-backed trigger persistence is rooted at. */
  dir: string;
  /**
   * The local user principal: recorded as `grantedBy` on grants and
   * passed to the SessionTriggerHost as its management principal.
   * Defaults to 'user' (the desktop local user, engine default auth).
   */
  principal?: string;
  /** Timed-trigger polling cadence passed through to the runtime. */
  pollMs?: number;
}

export class TriggerHostManager {
  private readonly engineHost: EngineHost;
  private readonly persistence: Persistence;
  private readonly principal: string;
  private readonly pollMs: number | undefined;
  private session: SessionTriggerHost | null = null;
  private currentScope: string = UNTITLED_TRIGGER_SCOPE;

  constructor(deps: TriggerHostManagerDeps) {
    if (!deps.host) throw new Error('TriggerHostManager requires an engine host');
    if (typeof deps.dir !== 'string' || deps.dir === '') {
      throw new Error('TriggerHostManager requires a persistence directory');
    }
    this.engineHost = deps.host;
    this.persistence = createTriggerFilePersistence(deps.dir);
    this.principal = deps.principal ?? 'user';
    this.pollMs = deps.pollMs;
    // Startup scope: no file is open yet.
    this.setScope(null);
  }

  /** The current workbook scope (file path, or 'untitled'). */
  get scope(): string {
    return this.currentScope;
  }

  /** The SessionTriggerHost serving the current scope (for tests/diagnostics). */
  get currentSession(): SessionTriggerHost | null {
    return this.session;
  }

  /**
   * Re-scope to a newly current workbook: detach the previous scope's
   * host, create a new SessionTriggerHost for the scope, attach it to
   * the SAME engine host and fire onOpen. `pathOrNull` is the open
   * file's absolute path; null (or empty) means the untitled scope.
   * Runs on every open/new even when the scope string is unchanged —
   * the workbook was replaced, so its onOpen triggers fire afresh.
   */
  setScope(pathOrNull: string | null): void {
    const scope =
      typeof pathOrNull === 'string' && pathOrNull.trim() !== ''
        ? pathOrNull
        : UNTITLED_TRIGGER_SCOPE;
    this.session?.detach();
    const session = new SessionTriggerHost({
      persistence: this.persistence,
      scope,
      principal: this.principal,
      ...(this.pollMs !== undefined ? { pollMs: this.pollMs } : {}),
    });
    this.session = session;
    this.currentScope = scope;
    session.attach(this.engineHost);
    session.fireOpen();
  }

  private requireSession(): SessionTriggerHost {
    if (!this.session) throw new Error('triggers: no active trigger host (disposed)');
    return this.session;
  }

  // ------------------------------------------------------------------
  // Management passthroughs (the desktop bridge contract)
  // ------------------------------------------------------------------

  list(): TriggerListResult {
    return {
      events: [...DESKTOP_TRIGGER_EVENTS],
      triggers: this.requireSession().list(),
    };
  }

  create(init: TriggerSpecInit): TriggerStatus {
    return this.requireSession().create(init);
  }

  remove(id: string): boolean {
    return this.requireSession().remove(id);
  }

  setEnabled(id: string, enabled: boolean): void {
    this.requireSession().setEnabled(id, enabled);
  }

  /** Grant a trigger's declared permissions, recorded as the local user. */
  grant(id: string): void {
    this.requireSession().grant(id, this.principal);
  }

  /** Detach the current host (app shutdown). Management calls fail after this. */
  dispose(): void {
    this.session?.detach();
    this.session = null;
  }
}
