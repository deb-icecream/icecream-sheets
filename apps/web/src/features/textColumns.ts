/**
 * Text-to-columns helpers for the Data tab.
 *
 * splitTextToColumns breaks each input string on a delimiter and trims the
 * resulting cells; detectDelimiter guesses the most likely delimiter from a
 * sample of the data.
 */

export const TEXT_DELIMITERS = ['\t', ',', ';', ' ', '|'] as const;
export type TextDelimiter = (typeof TEXT_DELIMITERS)[number];

/** Split one string on the delimiter, trimming every cell. */
function splitOne(value: string, delimiter: string): string[] {
  if (delimiter === '') return [value.trim()];
  // A bare space means "any run of whitespace".
  const parts = delimiter === ' ' ? value.split(/\s+/) : value.split(delimiter);
  return parts.map((part) => part.trim());
}

/**
 * Split each string in `values` on `delimiter` and trim every cell.
 * Supports '\t', ',', ';', ' ' (whitespace runs) and '|' — any other
 * string is treated as a literal delimiter.
 */
export function splitTextToColumns(values: string[], delimiter: string): string[][] {
  return values.map((value) => splitOne(value, delimiter));
}

/**
 * Guess the delimiter of a sample: the most frequent of tab, comma,
 * semicolon and pipe. Ties resolve to the earliest in that order; samples
 * with none of them default to ','.
 */
export function detectDelimiter(sample: string): string {
  const candidates = ['\t', ',', ';', '|'];
  let best = ',';
  let bestCount = 0;
  for (const d of candidates) {
    const count = sample.split(d).length - 1;
    if (count > bestCount) {
      best = d;
      bestCount = count;
    }
  }
  return best;
}
