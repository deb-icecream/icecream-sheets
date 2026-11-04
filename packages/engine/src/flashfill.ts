/**
 * Flash Fill — deterministic inference (track 16, see
 * design-docs/deterministic-inference.md).
 *
 * SERVICE-LAYER component. Pure functions over plain string arrays that the
 * caller read through the typed computational view; imports nothing from
 * workbook.ts, protocol.ts, or storage. Every output is a *proposal*:
 * a description, the proposed values, and the equivalent formula for
 * inspection. Nothing is applied without user confirmation.
 *
 * The analyzer synthesizes a transformation from 2-3 examples. Each pattern
 * detector tries to explain ALL examples; the first detector that does wins.
 * Detectors are ordered from most specific to most general.
 */

export const FLASHFILL_SPEC_VERSION = 1 as const;

export interface FlashFillProposal {
  version: typeof FLASHFILL_SPEC_VERSION;
  /** Human-readable description, e.g. 'Text before first " "'. */
  description: string;
  /** Pattern id, for telemetry/debugging. */
  pattern: string;
  /** Proposed values for the target rows (parallel to inputs). */
  values: string[];
  /** Equivalent Excel formula shown for inspection (uses {input} placeholder for the source cell). */
  formulaTemplate: string;
  /** 0..1 — fraction of examples explained (always 1 for a returned proposal). */
  confidence: number;
}

interface PatternDetector {
  id: string;
  description: (detail: string) => string;
  formulaTemplate: (detail: string) => string;
  /**
   * Try to explain all examples. Returns the detail string on success
   * (e.g. the delimiter), or null.
   */
  detect: (inputs: string[], outputs: string[]) => string | null;
  /** Apply the learned pattern to a new input. */
  apply: (input: string, detail: string) => string;
}

function firstWord(input: string): string {
  const m = input.match(/\S+/);
  return m ? m[0] : '';
}

const DETECTORS: PatternDetector[] = [
  {
    // "Smith, John" -> "John" (text after ", "). Checked before the generic
    // space detectors so an explicit delimiter wins over whitespace splitting.
    id: 'after-delimiter',
    description: (d) => `Text after first "${d}"`,
    formulaTemplate: (d) => `=MID({input},FIND("${d}",{input})+${d.length},LEN({input}))`,
    detect: (ins, outs) => {
      for (const d of [', ', ',', '; ', ';', ' - ', '-', ' | ', '|', ': ', ':']) {
        const ok = ins.every((v, i) => {
          const idx = v.indexOf(d);
          return idx >= 0 ? outs[i] === v.slice(idx + d.length).trim() : outs[i] === '';
        });
        if (ok && outs.some((o) => o !== '')) return d;
      }
      return null;
    },
    apply: (input, d) => {
      const idx = input.indexOf(d);
      return idx >= 0 ? input.slice(idx + d.length).trim() : '';
    },
  },
  {
    // "John Smith" -> "John" via comma etc: text before delimiter
    id: 'before-delimiter',
    description: (d) => `Text before first "${d}"`,
    formulaTemplate: (d) => `=LEFT({input},FIND("${d}",{input}&"${d}")-1)`,
    detect: (ins, outs) => {
      for (const d of [',', ';', '-', '|', ':', '@']) {
        if (d === ' ') continue;
        const ok = ins.every((v, i) => {
          const idx = v.indexOf(d);
          return outs[i] === (idx >= 0 ? v.slice(0, idx).trim() : v.trim());
        });
        if (ok && outs.some((o) => o !== '') && ins.some((v) => v.includes(d))) return d;
      }
      return null;
    },
    apply: (input, d) => {
      const idx = input.indexOf(d);
      return (idx >= 0 ? input.slice(0, idx) : input).trim();
    },
  },
  {
    // "  John  " -> "John". Checked before the space-splitting detectors so
    // leading/trailing whitespace is explained as trimming, not word-splitting.
    id: 'trim',
    description: () => 'Trim spaces',
    formulaTemplate: () => '=TRIM({input})',
    detect: (ins, outs) => {
      const ok = ins.every((v, i) => outs[i] === v.trim().replace(/\s+/g, ' '));
      return ok && ins.some((v) => v !== v.trim().replace(/\s+/g, ' ')) ? 'x' : null;
    },
    apply: (input) => input.trim().replace(/\s+/g, ' '),
  },
  {
    // "John Smith" -> "John"
    id: 'before-first-space',
    description: () => 'Text before first space',
    formulaTemplate: () => '=LEFT({input},FIND(" ",{input}&" ")-1)',
    detect: (ins, outs) =>
      ins.every((v, i) => outs[i] === firstWord(v)) && outs.some((o) => o !== '') ? ' ' : null,
    apply: (input) => firstWord(input),
  },
  {
    // "John Smith" -> "Smith"
    id: 'after-last-space',
    description: () => 'Text after last space',
    formulaTemplate: () => '=TRIM(RIGHT(SUBSTITUTE({input}," ",REPT(" ",99)),99))',
    detect: (ins, outs) => {
      const ok = ins.every((v, i) => {
        const parts = v.trim().split(/\s+/);
        return outs[i] === (parts.length > 1 ? parts[parts.length - 1]! : '');
      });
      return ok && outs.some((o) => o !== '') ? ' ' : null;
    },
    apply: (input) => {
      const parts = input.trim().split(/\s+/);
      return parts.length > 1 ? parts[parts.length - 1]! : '';
    },
  },
  {
    // "john.smith@x.com" -> "jsmith": first letters of dot-separated parts, lowercased
    id: 'initials-concat',
    description: () => 'Initials of each word, joined',
    formulaTemplate: () => '=LOWER(CONCAT(LEFT(TEXTSPLIT({input}," "),1)))',
    detect: (ins, outs) => {
      const ok = ins.every((v, i) => {
        const words = v.split(/[\s._-]+/).filter(Boolean);
        return words.length >= 2 && outs[i] === words.map((w) => w[0]!.toLowerCase()).join('');
      });
      return ok && outs.some((o) => o !== '') ? 'x' : null;
    },
    apply: (input) =>
      input
        .split(/[\s._-]+/)
        .filter(Boolean)
        .map((w) => w[0]!.toLowerCase())
        .join(''),
  },
  {
    // "John" -> "JOHN"
    id: 'uppercase',
    description: () => 'UPPERCASE',
    formulaTemplate: () => '=UPPER({input})',
    detect: (ins, outs) => (ins.every((v, i) => outs[i] === v.toUpperCase()) ? 'x' : null),
    apply: (input) => input.toUpperCase(),
  },
  {
    // "JOHN" -> "john"
    id: 'lowercase',
    description: () => 'lowercase',
    formulaTemplate: () => '=LOWER({input})',
    detect: (ins, outs) =>
      ins.every((v, i) => outs[i] === v.toLowerCase()) && ins.some((v) => v !== v.toLowerCase())
        ? 'x'
        : null,
    apply: (input) => input.toLowerCase(),
  },
  {
    // "john smith" -> "John Smith"
    id: 'proper',
    description: () => 'Proper Case',
    formulaTemplate: () => '=PROPER({input})',
    detect: (ins, outs) => {
      const proper = (v: string) => v.toLowerCase().replace(/(?:^|\s)\S/g, (c) => c.toUpperCase());
      const ok = ins.every((v, i) => outs[i] === proper(v));
      return ok && ins.some((v) => v !== proper(v)) ? 'x' : null;
    },
    apply: (input) => input.toLowerCase().replace(/(?:^|\s)\S/g, (c) => c.toUpperCase()),
  },
  {
    // "(555) 123-4567" -> "5551234567"
    id: 'digits-only',
    description: () => 'Digits only',
    formulaTemplate: () => '=TEXTJOIN("",1,IFERROR(MID({input},SEQUENCE(LEN({input})),1)*1,""))',
    detect: (ins, outs) => {
      const ok = ins.every((v, i) => outs[i] === v.replace(/\D/g, ''));
      return ok && ins.some((v) => /\D/.test(v)) ? 'x' : null;
    },
    apply: (input) => input.replace(/\D/g, ''),
  },
  {
    // "abc123" -> "abc"
    id: 'letters-only',
    description: () => 'Letters only',
    formulaTemplate: () => '=REGEXREPLACE({input},"[0-9]","")',
    detect: (ins, outs) => {
      const ok = ins.every((v, i) => outs[i] === v.replace(/[^a-zA-Z ]/g, '').trim());
      return ok && ins.some((v) => /[^a-zA-Z ]/.test(v)) ? 'x' : null;
    },
    apply: (input) => input.replace(/[^a-zA-Z ]/g, '').trim(),
  },
];

/**
 * Synthesize a Flash Fill pattern from examples.
 * @param inputs source column values for the example rows
 * @param outputs user-typed outputs for the example rows (2-3 examples)
 * @param targets source values for the rows to fill
 * @returns a proposal, or null when no pattern explains all examples
 */
export function analyzeFlashFill(
  inputs: string[],
  outputs: string[],
  targets: string[],
): FlashFillProposal | null {
  if (inputs.length < 1 || inputs.length !== outputs.length) return null;
  // Ignore fully-blank examples.
  const pairs = inputs
    .map((input, i) => ({ input, output: outputs[i] ?? '' }))
    .filter((p) => p.input !== '' || p.output !== '');
  if (pairs.length === 0) return null;
  const ins = pairs.map((p) => p.input);
  const outs = pairs.map((p) => p.output);

  for (const d of DETECTORS) {
    const detail = d.detect(ins, outs);
    if (detail !== null) {
      return {
        version: FLASHFILL_SPEC_VERSION,
        description: d.description(detail),
        pattern: d.id,
        values: targets.map((t) => d.apply(t, detail)),
        formulaTemplate: d.formulaTemplate(detail),
        confidence: 1,
      };
    }
  }
  return null;
}

/**
 * Two-column concat patterns: e.g. first + last name columns -> "John Smith".
 * Tries separator "" / " " / ", " / "-" between the two source columns.
 */
export function analyzeFlashFillTwoCol(
  colA: string[],
  colB: string[],
  outputs: string[],
  targetsA: string[],
  targetsB: string[],
): FlashFillProposal | null {
  if (colA.length !== colB.length || colA.length !== outputs.length || colA.length === 0) return null;
  for (const sep of [' ', ', ', '-', '', '.']) {
    const ok = colA.every((a, i) => outputs[i] === `${a}${sep}${colB[i] ?? ''}`.trim() || (a === '' && (colB[i] ?? '') === '' && outputs[i] === ''));
    if (ok && outputs.some((o) => o !== '')) {
      const formula =
        sep === ' '
          ? '=CONCAT({inputA}," ",{inputB})'
          : `=CONCAT({inputA},"${sep}",{inputB})`;
      return {
        version: FLASHFILL_SPEC_VERSION,
        description: sep === ' ' ? 'Columns joined with space' : `Columns joined with "${sep}"`,
        pattern: 'concat-two-col',
        values: targetsA.map((a, i) => `${a}${sep}${targetsB[i] ?? ''}`.trim()),
        formulaTemplate: formula,
        confidence: 1,
      };
    }
  }
  return null;
}

/** Fill a concrete formula by substituting the source cell reference. */
export function instantiateFormula(template: string, inputRef: string): string {
  return template.replaceAll('{input}', inputRef);
}
