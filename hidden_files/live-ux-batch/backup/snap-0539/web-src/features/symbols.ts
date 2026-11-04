/**
 * Symbol picker data (Insert > Symbols > Symbol).
 *
 * Unicode symbols grouped by category. Pure data + search so the dialog
 * stays thin and the data is unit-testable.
 */

export interface SymbolCategory {
  id: string;
  label: string;
  symbols: string[];
}

export const SYMBOL_CATEGORIES: SymbolCategory[] = [
  {
    id: 'greek',
    label: 'Greek',
    symbols: 'Α Β Γ Δ Ε Ζ Η Θ Ι Κ Λ Μ Ν Ξ Ο Π Ρ Σ Τ Υ Φ Χ Ψ Ω α β γ δ ε ζ η θ ι κ λ μ ν ξ ο π ρ σ ς τ υ φ χ ψ ω'.split(' '),
  },
  {
    id: 'math',
    label: 'Math',
    symbols: ['±', '×', '÷', '≠', '≤', '≥', '≈', '≡', '∞', '∑', '∏', '√', '∂', '∆', '∇', '∈', '∉', '⊂', '⊃', '⊆', '∪', '∩', '∧', '∨', '¬', '∅', '°', '′', '″', '½', '¼', '¾', '⅓', '⅔', '‰', '∴', '∵', '⊥', '∠', '⊕', '⊗'],
  },
  {
    id: 'arrows',
    label: 'Arrows',
    symbols: ['←', '↑', '→', '↓', '↔', '↕', '↨', '⇒', '⇐', '⇔', '↵', '↩', '↪', '↦', '⇧', '▲', '▼', '►', '◄'],
  },
  {
    id: 'currency',
    label: 'Currency',
    symbols: ['$', '€', '£', '¥', '₹', '₩', '¢', '₽', '₺', '₴', '₪', '₫'],
  },
  {
    id: 'misc',
    label: 'Miscellaneous',
    symbols: ['©', '®', '™', '§', '¶', '†', '‡', '•', '…', '★', '☆', '♠', '♥', '♦', '♣', '✓', '✗', '✔', '✘', '⚠', '☀', '☁', '☂', '☃', '⌘', '⏎', '␣'],
  },
];

/** All symbols flattened (for the search-across-categories view). */
export function allSymbols(): { symbol: string; category: string }[] {
  return SYMBOL_CATEGORIES.flatMap((c) => c.symbols.map((symbol) => ({ symbol, category: c.label })));
}

/**
 * Search symbols by a query string. Matches the symbol itself (so pasting
 * a symbol finds it) and category labels.
 */
export function searchSymbols(query: string): { symbol: string; category: string }[] {
  const q = query.trim().toLowerCase();
  if (q === '') return allSymbols();
  return allSymbols().filter(
    (s) => s.symbol.includes(query.trim()) || s.category.toLowerCase().includes(q),
  );
}
