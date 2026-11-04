/**
 * Thesaurus dialog (Review > Proofing > Thesaurus).
 *
 * Looks up the selected word in the bundled list
 * (features/thesaurus.ts — curated from public-domain Roget's word
 * sets; source documented there). Shows synonyms and antonyms;
 * clicking a synonym replaces the selection via onReplace.
 */
import { useMemo, useState } from 'react';
import { lookupThesaurus, thesaurusHeadwords } from '../features/thesaurus';
import A11yDialog from './A11yDialog';

interface ThesaurusDialogProps {
  /** The word to look up (from the current cell / selection). */
  word: string;
  onClose: () => void;
  /** Replace the looked-up word with the chosen synonym. */
  onReplace?: (replacement: string) => void;
}

export default function ThesaurusDialog({ word, onClose, onReplace }: ThesaurusDialogProps) {
  const [query, setQuery] = useState(word);
  const entry = useMemo(() => lookupThesaurus(query), [query]);
  const headwords = useMemo(() => thesaurusHeadwords(), []);
  const suggestions = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (q.length < 2) return [];
    return headwords.filter((h) => h.startsWith(q) && h !== q).slice(0, 8);
  }, [query, headwords]);

  return (
    <A11yDialog title={<>Thesaurus</>} width={440} onClose={onClose}>
        <div className="dialog-row">
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Word to look up"
            style={{ flex: 1 }}
            spellCheck={false}
            placeholder="Type a word…"
          />
        </div>
        {suggestions.length > 0 && (
          <div style={{ fontSize: 12, marginBottom: 8 }}>
            Did you mean:{' '}
            {suggestions.map((s) => (
              <button key={s} onClick={() => setQuery(s)} style={{ marginRight: 4 }}>{s}</button>
            ))}
          </div>
        )}
        {entry ? (
          <>
            <div style={{ marginBottom: 8 }}>
              <strong>Synonyms for “{entry.word}”</strong>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 4 }}>
                {entry.synonyms.map((s) => (
                  <button key={s} onClick={() => onReplace?.(s)} title={onReplace ? `Replace with "${s}"` : s}>
                    {s}
                  </button>
                ))}
              </div>
            </div>
            {entry.antonyms.length > 0 && (
              <div>
                <strong>Antonyms</strong>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 4 }}>
                  {entry.antonyms.map((a) => (
                    <span key={a} style={{ padding: '2px 8px', border: '1px solid var(--line-soft)', borderRadius: 4, fontSize: 13 }}>{a}</span>
                  ))}
                </div>
              </div>
            )}
          </>
        ) : (
          <p style={{ color: '#888', fontSize: 13 }}>
            No entry for “{query.trim() || '—'}” in the bundled thesaurus.
          </p>
        )}
        <div className="dialog-actions">
          <button onClick={onClose}>Close</button>
        </div>
      </A11yDialog>
  );
}
