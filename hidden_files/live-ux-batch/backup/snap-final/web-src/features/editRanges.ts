/**
 * Allow Edit Ranges (Review > Protect > Allow Edit Ranges).
 *
 * On a protected sheet, ranges listed here can be edited by anyone who
 * knows the range password — Excel's per-range password model. The engine
 * ProtectionManager owns the sheet-level lock; this module owns the
 * per-range password registry (salted SHA-256 hashes, never plaintext),
 * persisted to the service metadata store. Enforcement hook: before
 * writing to a protected sheet, the host checks
 * isRangeUnlockedForSession() — a successful password entry unlocks the
 * range for the session (in-memory set, not persisted).
 */
import { sha256Hex } from '@icecream-sheets/engine';

export interface EditRangeEntry {
  id: string;
  sheet: string;
  /** A1 range, e.g. "B2:D10". */
  range: string;
  title: string;
  passwordHash: string;
  salt: string;
  createdAt: string;
}

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const STORAGE_KEY = 'icecream.editRanges.v1';

function defaultStorage(): StorageLike | null {
  try {
    if (typeof localStorage === 'undefined') return null;
    return {
      getItem: (k) => localStorage.getItem(k),
      setItem: (k, v) => localStorage.setItem(k, v),
    };
  } catch {
    return null;
  }
}

function randomSalt(): string {
  const bytes = new Uint8Array(16);
  for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Hash a range password with its salt. */
export function hashRangePassword(password: string, salt: string): string {
  return sha256Hex(`${salt}:${password}`);
}

/** Create an entry, hashing the password. Throws on blank range/password. */
export function createEditRange(sheet: string, range: string, title: string, password: string): EditRangeEntry {
  if (!range.trim()) throw new Error('Allow Edit Ranges: range is required.');
  if (!password) throw new Error('Allow Edit Ranges: a password is required.');
  const salt = randomSalt();
  return {
    id: `er_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`,
    sheet,
    range: range.trim(),
    title: title.trim() || range.trim(),
    passwordHash: hashRangePassword(password, salt),
    salt,
    createdAt: new Date().toISOString(),
  };
}

/** True when the password unlocks the entry. */
export function verifyEditRangePassword(entry: EditRangeEntry, password: string): boolean {
  return hashRangePassword(password, entry.salt) === entry.passwordHash;
}

export function loadEditRanges(store?: StorageLike): EditRangeEntry[] {
  const s = store ?? defaultStorage();
  if (!s) return [];
  try {
    const raw = s.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as EditRangeEntry[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function persistEditRanges(entries: EditRangeEntry[], store?: StorageLike): void {
  const s = store ?? defaultStorage();
  if (!s) return;
  try { s.setItem(STORAGE_KEY, JSON.stringify(entries)); } catch { /* storage full */ }
}

export function addEditRange(entry: EditRangeEntry, store?: StorageLike): EditRangeEntry[] {
  const next = [...loadEditRanges(store), entry];
  persistEditRanges(next, store);
  return next;
}

export function removeEditRange(id: string, store?: StorageLike): EditRangeEntry[] {
  const next = loadEditRanges(store).filter((e) => e.id !== id);
  persistEditRanges(next, store);
  return next;
}

// -- Session unlocks (in-memory; never persisted) ----------------------------

/** Range ids unlocked for this session via password entry. */
const sessionUnlocked = new Set<string>();

/** Record a successful password entry for the session. */
export function unlockRangeForSession(id: string): void {
  sessionUnlocked.add(id);
}

/** True when the range was unlocked this session. */
export function isRangeUnlockedForSession(id: string): boolean {
  return sessionUnlocked.has(id);
}

/** Clear all session unlocks (e.g. on workbook close). */
export function clearSessionUnlocks(): void {
  sessionUnlocked.clear();
}
