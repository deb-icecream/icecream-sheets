/**
 * Phase 1 design-system tests (service side): every class the generation
 * prompt names must exist in the compiled iframe stylesheet, and the
 * template + canned generators must emit classes, not inline styles.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { TemplateAppGenerator, type AppGenerationInput } from '../src/artifacts/generator.js';
import {
  CANNED_TEST_APP,
  LlmAppGenerator,
  TestCodeGenBackend,
} from '../src/artifacts/llm.js';

const CSS_PATH = new URL(
  '../../../apps/web/src/components/artifact-iframe.compiled.css',
  import.meta.url,
);
const css = readFileSync(CSS_PATH, 'utf-8');

const INPUT: AppGenerationInput = {
  prompt: 'build me a sortable hours app',
  sheet: 'Sheet1',
  binding: { startRow: 0, startCol: 0, endRow: 5, endCol: 2, hasHeaderRow: true },
  columns: [
    { name: 'Month', type: 'text', index: 0 },
    { name: 'Region', type: 'text', index: 1 },
    { name: 'Revenue', type: 'numeric', index: 2 },
  ],
  template: 'data-table',
};

/** Escape a class name for a regex against minified CSS selectors.
 * CSS escaping first ('.' -> '\.', '/' -> '\/'), then regex escaping,
 * and allow a descendant combinator (space) after the class, since
 * DaisyUI emits selectors like `.table-zebra tbody tr`. */
function classSelectorRegex(cls: string): RegExp {
  const cssEscaped = cls.replace(/\\/g, '\\\\').replace(/\./g, '\\.').replace(/\//g, '\\/');
  const regexEscaped = cssEscaped.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\\.${regexEscaped}(?=[{,:\\s])`);
}

/** Classes named by the llm.ts DESIGN SYSTEM vocabulary section. */
function promptVocabulary(): string[] {
  const prompt = new LlmAppGenerator({ backend: new TestCodeGenBackend() }).buildPrompt(INPUT);
  const section = prompt.slice(prompt.indexOf('DESIGN SYSTEM'), prompt.indexOf('Return ONLY'));
  const classes = new Set<string>();
  for (const key of ['Layout:', 'Text:', 'Components:']) {
    const line = section.split('\n').find((l) => l.startsWith(key));
    expect(line, `prompt vocabulary line ${key} present`).toBeDefined();
    for (const token of line!.slice(key.length).split(',')) {
      const cls = token.trim().replace(/\.$/, '');
      if (cls) classes.add(cls);
    }
  }
  for (const m of section.matchAll(/className: '([^']+)'/g)) {
    for (const cls of m[1].split(/\s+/)) if (cls) classes.add(cls);
  }
  return [...classes];
}

describe('prompt vocabulary vs compiled iframe stylesheet', () => {
  it('every class the prompt names exists in the compiled CSS', () => {
    const vocab = promptVocabulary();
    expect(vocab.length).toBeGreaterThan(40);
    const missing = vocab.filter((cls) => !classSelectorRegex(cls).test(css));
    expect(missing).toEqual([]);
  });
});

describe('template generator emits design-system classes', () => {
  it.each(['data-table', 'chart-dashboard', 'data-entry-form'] as const)(
    '%s uses classes, not inline styles',
    async (template) => {
      const out = await new TemplateAppGenerator().generate({ ...INPUT, template });
      expect(out.source).toContain('function App()');
      expect(out.source).toContain('className:');
      expect(out.source).not.toContain('style: S');
      expect(out.source).not.toContain('style: {');
    },
  );
});

describe('canned app emits design-system classes', () => {
  it('uses the table component classes, not inline styles', () => {
    expect(CANNED_TEST_APP).toContain("className: 'table w-full'");
    expect(CANNED_TEST_APP).not.toContain('style: {');
  });
});
