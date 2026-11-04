/**
 * User script library for the Extensions > Apps Script editor
 * (design-docs/automation-lane.md §1, §5).
 *
 * Scripts are hand-written or translator-migrated TypeScript that runs
 * through the permissioned automation API. The library persists to
 * browser localStorage; each script records its declared permissions
 * and the user's grant (automation-lane.md §1: "the grant is recorded").
 */
import type { DeclaredPermission } from '@icecream-sheets/service';

export type ScriptLanguage = 'typescript' | 'javascript';

export interface UserScript {
  /** Stable id, e.g. 'script-3f9a2c'. */
  id: string;
  name: string;
  language: ScriptLanguage;
  source: string;
  /** Permissions the script declares it needs (automation-lane.md §1). */
  permissions: DeclaredPermission[];
  /** True once the user has granted the declared permissions. */
  granted: boolean;
  grantedAt: string | null;
  createdAt: string;
  updatedAt: string;
  lastRunAt: string | null;
  lastRunOk: boolean | null;
}

export const SCRIPT_STORAGE_KEY = 'icecream-sheets.user-scripts.v1';

const TEMPLATE_TYPESCRIPT = `// Icecream Sheets automation script (TypeScript).
// Declare the permissions your script needs; the user grants them once.
export const PERMISSIONS = [
  { action: 'cell.write', target: 'Sheet1!0,0:9,9', reason: 'Fill the report block' },
];

export function main(api) {
  api.setCell({ sheet: 'Sheet1', row: 0, col: 0 }, 'Hello from Apps Script');
  api.notify('Script finished');
}
`;

const TEMPLATE_JAVASCRIPT = `// Icecream Sheets automation script (JavaScript).
export const PERMISSIONS = [
  { action: 'cell.write', target: 'Sheet1!0,0:9,9', reason: 'Fill the report block' },
];

export function main(api) {
  api.setCell({ sheet: 'Sheet1', row: 0, col: 0 }, 'Hello from Apps Script');
  api.notify('Script finished');
}
`;

function uid(): string {
  return `script-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function nowIso(): string {
  return new Date().toISOString();
}

export function scriptTemplate(language: ScriptLanguage): string {
  return language === 'javascript' ? TEMPLATE_JAVASCRIPT : TEMPLATE_TYPESCRIPT;
}

export function createScript(name: string, language: ScriptLanguage = 'typescript'): UserScript {
  const at = nowIso();
  return {
    id: uid(),
    name: name.trim() || 'Untitled script',
    language,
    source: scriptTemplate(language),
    permissions: [],
    granted: false,
    grantedAt: null,
    createdAt: at,
    updatedAt: at,
    lastRunAt: null,
    lastRunOk: null,
  };
}

/** Extract `PERMISSIONS` declared in the script source (best effort). */
export function extractDeclaredPermissions(source: string): DeclaredPermission[] {
  const out: DeclaredPermission[] = [];
  // Match `PERMISSIONS = [ ... ]` (export or plain const).
  const m = /PERMISSIONS\s*=\s*\[([\s\S]*?)\];/.exec(source);
  if (!m) return out;
  const body = m[1]!;
  const objRe = /\{([^}]*)\}/g;
  let o: RegExpExecArray | null;
  while ((o = objRe.exec(body)) !== null) {
    const entry = o[1]!;
    const action = /action\s*:\s*['"]([^'"]+)['"]/.exec(entry)?.[1];
    const target = /target\s*:\s*['"]([^'"]+)['"]/.exec(entry)?.[1];
    const reason = /reason\s*:\s*['"]([^'"]+)['"]/.exec(entry)?.[1];
    if (action && target) out.push({ action, target, reason });
  }
  return out;
}

function sanitizePermission(p: unknown): DeclaredPermission | null {
  if (typeof p !== 'object' || p === null) return null;
  const o = p as Record<string, unknown>;
  if (typeof o.action !== 'string' || typeof o.target !== 'string') return null;
  const out: DeclaredPermission = { action: o.action, target: o.target };
  if (typeof o.reason === 'string') out.reason = o.reason;
  return out;
}

function sanitizeScript(raw: unknown): UserScript | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.id !== 'string' || typeof o.name !== 'string' || typeof o.source !== 'string') return null;
  const at = nowIso();
  return {
    id: o.id,
    name: o.name,
    language: o.language === 'javascript' ? 'javascript' : 'typescript',
    source: o.source,
    permissions: Array.isArray(o.permissions)
      ? o.permissions.map(sanitizePermission).filter((p): p is DeclaredPermission => p !== null)
      : [],
    granted: o.granted === true,
    grantedAt: typeof o.grantedAt === 'string' ? o.grantedAt : null,
    createdAt: typeof o.createdAt === 'string' ? o.createdAt : at,
    updatedAt: typeof o.updatedAt === 'string' ? o.updatedAt : at,
    lastRunAt: typeof o.lastRunAt === 'string' ? o.lastRunAt : null,
    lastRunOk: typeof o.lastRunOk === 'boolean' ? o.lastRunOk : null,
  };
}

/** Load the script library from a storage backend (defaults to localStorage). */
export function loadScripts(
  storage: Pick<Storage, 'getItem'> = typeof localStorage !== 'undefined' ? localStorage : ({} as Storage),
): UserScript[] {
  try {
    const raw = storage.getItem(SCRIPT_STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.map(sanitizeScript).filter((s): s is UserScript => s !== null);
  } catch {
    return [];
  }
}

/** Persist the script library. */
export function saveScripts(
  scripts: UserScript[],
  storage: Pick<Storage, 'setItem'> = typeof localStorage !== 'undefined' ? localStorage : ({} as Storage),
): void {
  try {
    storage.setItem(SCRIPT_STORAGE_KEY, JSON.stringify(scripts));
  } catch {
    // Storage full or unavailable — the library stays in memory.
  }
}

/** Mark a script's declared permissions as granted by the user (§1). */
export function grantScript(script: UserScript, permissions: DeclaredPermission[]): UserScript {
  return { ...script, permissions, granted: true, grantedAt: nowIso(), updatedAt: nowIso() };
}

/** Revoke a script's grant (e.g. its declared permissions changed). */
export function revokeGrant(script: UserScript): UserScript {
  return { ...script, granted: false, grantedAt: null, updatedAt: nowIso() };
}

/** Record a run outcome on the script. */
export function recordRun(script: UserScript, ok: boolean): UserScript {
  return { ...script, lastRunAt: nowIso(), lastRunOk: ok, updatedAt: nowIso() };
}
