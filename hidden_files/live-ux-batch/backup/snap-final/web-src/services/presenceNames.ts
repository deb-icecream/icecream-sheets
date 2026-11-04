/**
 * Presence display-name helpers (pure, dependency-free leaf module —
 * Grid imports these, and Grid must not pull the collab-transport
 * module graph into its own initialization path).
 */

/**
 * The label a participant is shown under (D8 ruling): their display
 * name from the presence payload — settings display name → provider
 * profile name → email name part, resolved by the SENDER's client
 * (effectiveDisplayName) and carried on the presence post. A payload
 * "name" that is just the principal (or its bare id) is not a name —
 * engines/clients without a real one leave it absent — and the raw
 * principal/UID must never render as a label, so the fallback is a
 * neutral 'Guest', never the id.
 */
export function participantDisplayName(p: { principal: string; name?: string }): string {
  const raw = typeof p.name === 'string' ? p.name.trim() : '';
  if (raw && raw !== p.principal && raw !== p.principal.replace(/^user:/, '')) return raw;
  return 'Guest';
}

/** Display name initials for the participants avatar row. */
export function participantInitials(principal: string): string {
  const name = principal.replace(/^user:/, '').split('@')[0];
  const parts = name.split(/[\s._-]+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}
