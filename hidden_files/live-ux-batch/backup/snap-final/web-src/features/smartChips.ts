/**
 * Smart chips (track 15 extension): rich cell values for people, files,
 * calendar events, finance metrics and star ratings — the same pattern as
 * the stock/geography linked data types in dataTypes.ts (bundled sample
 * datasets so the feature works offline; a real deployment swaps the
 * resolvers for provider adapters).
 *
 * Chip syntax: a cell whose text is `=CHIP("person","Ada Lovelace")` is
 * converted on commit into a smart chip showing the person's display name.
 */

import type { DataTypeField } from './dataTypes';

export type SmartChipKind = 'person' | 'file' | 'calendar' | 'finance' | 'rating';

export const SMART_CHIP_KINDS: SmartChipKind[] = ['person', 'file', 'calendar', 'finance', 'rating'];

export interface SmartChipValue {
  kind: SmartChipKind;
  key: string;
  display: string;
  emoji: string;
  fields: DataTypeField[];
  refreshedAt: number;
}

export function chipEmoji(kind: SmartChipKind): string {
  switch (kind) {
    case 'person': return '🧑';
    case 'file': return '📄';
    case 'calendar': return '📅';
    case 'finance': return '💹';
    case 'rating': return '⭐';
  }
}

export function chipKindLabel(kind: SmartChipKind): string {
  switch (kind) {
    case 'person': return 'Person';
    case 'file': return 'File';
    case 'calendar': return 'Calendar';
    case 'finance': return 'Finance';
    case 'rating': return 'Rating';
  }
}

// ---------------------------------------------------------------------------
// Sample datasets
// ---------------------------------------------------------------------------

interface Person {
  name: string;
  email: string;
  title: string;
  department: string;
}

const PEOPLE: Person[] = [
  { name: 'Ada Lovelace', email: 'ada@example.com', title: 'Principal Engineer', department: 'R&D' },
  { name: 'Grace Hopper', email: 'grace@example.com', title: 'Engineering Manager', department: 'Platform' },
  { name: 'Alan Turing', email: 'alan@example.com', title: 'Research Scientist', department: 'AI Lab' },
  { name: 'Katherine Johnson', email: 'katherine@example.com', title: 'Data Analyst', department: 'Analytics' },
  { name: 'Margaret Hamilton', email: 'margaret@example.com', title: 'Staff Engineer', department: 'Infrastructure' },
  { name: 'Tim Berners-Lee', email: 'tim@example.com', title: 'Distinguished Engineer', department: 'Web Standards' },
  { name: 'Linus Torvalds', email: 'linus@example.com', title: 'Kernel Maintainer', department: 'Open Source' },
  { name: 'Barbara Liskov', email: 'barbara@example.com', title: 'Principal Scientist', department: 'R&D' },
];

interface ChipFile {
  name: string;
  type: string;
  size: string;
  modified: string;
}

const FILES: ChipFile[] = [
  { name: 'Q3 Board Deck.pptx', type: 'Presentation', size: '4.2 MB', modified: '2026-10-02' },
  { name: 'budget-2026.xlsx', type: 'Spreadsheet', size: '812 KB', modified: '2026-10-15' },
  { name: 'hiring-plan.docx', type: 'Document', size: '96 KB', modified: '2026-09-28' },
  { name: 'launch-video.mp4', type: 'Video', size: '248 MB', modified: '2026-08-30' },
  { name: 'api-spec.yaml', type: 'Code', size: '38 KB', modified: '2026-10-17' },
  { name: 'team-photo.png', type: 'Image', size: '2.1 MB', modified: '2026-07-04' },
];

interface CalendarEvent {
  title: string;
  date: string;
  attendees: string;
}

const EVENTS: CalendarEvent[] = [
  { title: 'Sprint Planning', date: '2026-10-19 10:00', attendees: 'Ada, Grace, Alan' },
  { title: 'Design Review', date: '2026-10-20 14:00', attendees: 'Katherine, Margaret' },
  { title: 'Board Meeting', date: '2026-10-21 09:00', attendees: 'Tim, Barbara, +4' },
  { title: 'Launch Retro', date: '2026-10-22 16:00', attendees: 'Whole team' },
  { title: '1:1 with Grace', date: '2026-10-23 11:30', attendees: 'Grace Hopper' },
  { title: 'Hack Day', date: '2026-10-24 09:00', attendees: 'Engineering' },
];

interface FinanceMetric {
  name: string;
  value: string;
  currency: string;
  change: string;
}

const FINANCE: FinanceMetric[] = [
  { name: 'Revenue (Q3)', value: '1,284,500', currency: 'USD', change: '+8.2%' },
  { name: 'Gross Margin', value: '72.4', currency: '%', change: '+1.1 pts' },
  { name: 'Operating Cost', value: '486,200', currency: 'USD', change: '-2.3%' },
  { name: 'Cash on Hand', value: '3,910,000', currency: 'USD', change: '+5.0%' },
  { name: 'ARR', value: '5,140,000', currency: 'USD', change: '+12.6%' },
];

// ---------------------------------------------------------------------------
// Resolvers
// ---------------------------------------------------------------------------

export function personNames(): string[] {
  return PEOPLE.map((p) => p.name);
}

export function fileNames(): string[] {
  return FILES.map((f) => f.name);
}

export function eventTitles(): string[] {
  return EVENTS.map((e) => e.title);
}

export function financeNames(): string[] {
  return FINANCE.map((f) => f.name);
}

function makeChip(kind: SmartChipKind, key: string, display: string, fields: DataTypeField[]): SmartChipValue {
  return { kind, key, display, emoji: chipEmoji(kind), fields, refreshedAt: Date.now() };
}

export function resolvePerson(name: string): SmartChipValue | null {
  const p = PEOPLE.find((x) => x.name.toLowerCase() === name.trim().toLowerCase());
  if (!p) return null;
  return makeChip('person', p.name, p.name, [
    { label: 'Name', value: p.name },
    { label: 'Email', value: p.email },
    { label: 'Title', value: p.title },
    { label: 'Department', value: p.department },
  ]);
}

export function resolveFile(name: string): SmartChipValue | null {
  const f = FILES.find((x) => x.name.toLowerCase() === name.trim().toLowerCase());
  if (!f) return null;
  return makeChip('file', f.name, f.name, [
    { label: 'Name', value: f.name },
    { label: 'Type', value: f.type },
    { label: 'Size', value: f.size },
    { label: 'Modified', value: f.modified },
  ]);
}

export function resolveCalendarEvent(title: string): SmartChipValue | null {
  const e = EVENTS.find((x) => x.title.toLowerCase() === title.trim().toLowerCase());
  if (!e) return null;
  return makeChip('calendar', e.title, e.title, [
    { label: 'Title', value: e.title },
    { label: 'When', value: e.date },
    { label: 'Attendees', value: e.attendees },
  ]);
}

export function resolveFinance(name: string): SmartChipValue | null {
  const f = FINANCE.find((x) => x.name.toLowerCase() === name.trim().toLowerCase());
  if (!f) return null;
  return makeChip('finance', f.name, `${f.name}: ${f.value} ${f.currency}`, [
    { label: 'Metric', value: f.name },
    { label: 'Value', value: `${f.value} ${f.currency}` },
    { label: 'Change', value: f.change },
  ]);
}

export function resolveRating(n: number | string): SmartChipValue | null {
  const v = typeof n === 'string' ? Number(n.trim()) : n;
  if (!Number.isInteger(v) || v < 1 || v > 5) return null;
  const stars = '★'.repeat(v) + '☆'.repeat(5 - v);
  return makeChip('rating', String(v), stars, [
    { label: 'Score', value: `${v} / 5` },
    { label: 'Stars', value: stars },
    { label: 'Percent', value: `${v * 20}%` },
  ]);
}

/** Resolve any smart chip by kind + key (mirrors resolveStock/resolveGeography). */
export function resolveSmartChip(kind: SmartChipKind, key: string): SmartChipValue | null {
  switch (kind) {
    case 'person': return resolvePerson(key);
    case 'file': return resolveFile(key);
    case 'calendar': return resolveCalendarEvent(key);
    case 'finance': return resolveFinance(key);
    case 'rating': return resolveRating(key);
  }
}

export function isSmartChipKind(v: string): v is SmartChipKind {
  return (SMART_CHIP_KINDS as string[]).includes(v);
}

/** Cell key for the smart-chip map. */
export function smartChipCellKey(sheet: string, row: number, col: number): string {
  return `${sheet}:${row}:${col}`;
}

/**
 * Parse chip syntax `=CHIP("person","Ada Lovelace")` / `=CHIP("rating",4)`.
 * Returns the kind + key, or null when the text is not chip syntax.
 */
export function parseChipFormula(text: string): { kind: SmartChipKind; key: string } | null {
  const m = /^=CHIP\(\s*"([^"]+)"\s*,\s*(?:"([^"]*)"|(\d+))\s*\)$/i.exec(text.trim());
  if (!m) return null;
  const kind = m[1].toLowerCase();
  if (!isSmartChipKind(kind)) return null;
  const key = m[2] !== undefined ? m[2] : (m[3] ?? '');
  return { kind, key };
}

/** All insertable options for a kind (for the insert dialog). */
export function chipOptions(kind: SmartChipKind): string[] {
  switch (kind) {
    case 'person': return personNames();
    case 'file': return fileNames();
    case 'calendar': return eventTitles();
    case 'finance': return financeNames();
    case 'rating': return ['1', '2', '3', '4', '5'];
  }
}
