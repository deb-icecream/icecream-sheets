/**
 * Tiny built-in spell checker for the Review tab.
 *
 * A compact word list (~200 common English words plus months, days and
 * number words) backs isCorrect; suggest() generates edit-distance-1
 * candidates (deletions, transpositions, substitutions) and keeps the
 * ones present in the list.
 */

const WORD_LIST = `
a about above after again against all almost along already also although always
am an and another any are around as at away back be because become began been
before behind being below best better between big body book both bottom bring
build but by call came can cannot change children city close come could country
course day did do does done door down during each even every everything far fast
feel few find first for found from get give given go goes going good got great
group had hand hard has have he head help her here high him his home house how
however idea if important in into is it its just keep kind knew know known large
last later learn least leave left less let letter life light like little live
long look love low machine made make many me mean might mile money month more
morning most mother move much music must my myself near never new next night no
none north not nothing now number of off often oil old on once one only open or
order other ought our out over own page paper part people picture place plain
plane plant point pound press print pulled push put rain read ready red rest
right river road rock room round rule run said same say school sea second seem
seen self sentence serve set several shall shape short should show side since six
size sleep small snow so some song soon sound south space spell spreadsheet still
story such sure table take talk tell ten test than that the their them then there
these they thick thin thing think third those though thought three through time
times to together told too took top toward town tree true try turn two under unit
until up upon use usual very voice walk want warm was wash water wave way week
weight well went were what when where whether which while white who whole whose
why will wind with within without woman women word words work world would write
year years yes yet you young your cell formula
brown cat fox hello quick rate receive sat
january february march april may june july august september october november
december monday tuesday wednesday thursday friday saturday sunday zero four five
six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen
seventeen eighteen nineteen twenty thirty forty fifty sixty seventy eighty
ninety hundred thousand million billion fourth fifth
`;

const WORDS: ReadonlySet<string> = new Set(
  WORD_LIST.split(/\s+/).filter((w) => w.length > 0),
);

/** Number of distinct words in the built-in list. */
export function wordListSize(): number {
  return WORDS.size;
}

/**
 * True when `word` is spelled correctly — or should be skipped:
 * words containing digits, single letters, and ALL-CAPS acronyms of
 * length <= 4 are always accepted.
 */
export function isCorrect(word: string): boolean {
  if (word.length === 0) return true;
  if (/\d/.test(word)) return true;
  if (word.length === 1) return true;
  if (word.length <= 4 && word === word.toUpperCase() && /[A-Z]/.test(word)) return true;
  return WORDS.has(word.toLowerCase());
}

export interface Misspelling {
  word: string;
  index: number;
}

/**
 * Tokenize `text` on non-letters and return each misspelled word with its
 * offset in the original text.
 */
export function checkText(text: string): Misspelling[] {
  const out: Misspelling[] = [];
  const re = /[A-Za-z]+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (!isCorrect(m[0])) out.push({ word: m[0], index: m.index });
  }
  return out;
}

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz';

/**
 * Up to 3 spelling suggestions for `word`, from edit distance 1
 * (deletions, adjacent transpositions, single-letter substitutions)
 * that exist in the word list. Very long words are not attempted.
 */
export function suggest(word: string): string[] {
  const lower = word.toLowerCase();
  if (lower.length === 0 || lower.length > 15) return [];
  const found = new Set<string>();
  const consider = (candidate: string): void => {
    if (found.size < 3 && candidate !== lower && WORDS.has(candidate)) {
      found.add(candidate);
    }
  };
  // Deletions.
  for (let i = 0; i < lower.length; i++) {
    consider(lower.slice(0, i) + lower.slice(i + 1));
  }
  // Adjacent transpositions.
  for (let i = 0; i + 1 < lower.length; i++) {
    consider(lower.slice(0, i) + lower[i + 1] + lower[i] + lower.slice(i + 2));
  }
  // Single-letter substitutions.
  for (let i = 0; i < lower.length && found.size < 3; i++) {
    for (const ch of ALPHABET) {
      if (found.size >= 3) break;
      if (ch !== lower[i]) consider(lower.slice(0, i) + ch + lower.slice(i + 1));
    }
  }
  return [...found];
}
