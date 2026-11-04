/**
 * Command registry (design-docs/platform-shell.md §6).
 *
 * Menu search (Alt+/) and the keyboard-shortcuts dialog (Ctrl+/) resolve
 * against the same registry on every host, so shortcuts behave identically
 * on web and desktop. Each command is a stable id + human label + category
 * + optional shortcut, with a run() closure the owning host wires up and an
 * optional enabled() gate (disabled commands show but don't run).
 */

export interface AppCommand {
  /** Stable id, e.g. 'file.open'. Never changes; safe for shortcuts docs. */
  id: string;
  /** Human label shown in menu search and the shortcuts dialog. */
  label: string;
  /** Grouping section, e.g. 'File', 'Edit', 'View', 'Insert', 'Data'. */
  category: string;
  /** Display shortcut, e.g. 'Ctrl+Z', 'Alt+/', 'F2'. */
  shortcut?: string;
  /** Longer hint shown as a tooltip / description line. */
  description?: string;
  /** Execute the command. */
  run: () => void;
  /** When false the command is listed but grayed out. */
  enabled?: () => boolean;
}

import type { KeyboardEvent as ReactKeyboardEvent } from 'react';

/** Normalize a keyboard event into a 'Ctrl+Shift+Z'-style chord string. */
export function chordOf(e: KeyboardEvent | ReactKeyboardEvent): string {
  const parts: string[] = [];
  if (e.ctrlKey || e.metaKey) parts.push('Ctrl');
  if (e.altKey) parts.push('Alt');
  if (e.shiftKey) parts.push('Shift');
  const key = e.key === ' ' ? 'Space' : e.key.length === 1 ? e.key.toUpperCase() : e.key;
  parts.push(key);
  return parts.join('+');
}

/** Case-insensitive substring match used by the shortcuts dialog filter. */
export function matchesQuery(cmd: AppCommand, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return (
    cmd.label.toLowerCase().includes(q) ||
    cmd.category.toLowerCase().includes(q) ||
    cmd.id.toLowerCase().includes(q) ||
    (cmd.shortcut ?? '').toLowerCase().includes(q) ||
    (cmd.description ?? '').toLowerCase().includes(q)
  );
}

/** Score for menu-search ranking: label-prefix > label-word > other. */
export function rankCommand(cmd: AppCommand, query: string): number {
  const q = query.trim().toLowerCase();
  if (!q) return 1;
  const label = cmd.label.toLowerCase();
  if (label.startsWith(q)) return 0;
  if (label.split(/\s+/).some((w) => w.startsWith(q))) return 1;
  if (label.includes(q)) return 2;
  return 3;
}
