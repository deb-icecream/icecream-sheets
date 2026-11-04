/**
 * LLM-generated app names (owner directive 2026-10-25): a generated app's
 * displayed name must be a proper short name from the model, not the user's
 * prompt text. Before this change generateAndSaveArtifact set spec.name to
 * the prompt itself (truncated at 60 chars) — the rich-demo lane header
 * literally showed the full prompt.
 *
 * - cleanArtifactName / fallbackArtifactName: pure cleaning + fallback rules.
 * - generateAndSaveArtifact: a generator-provided model name wins (cleaned);
 *   without one the prompt-derived fallback applies unchanged (template lane).
 * - LlmAppGenerator: the dedicated post-generation naming call; naming
 *   NEVER fails generation (absence/error/empty -> name omitted -> fallback).
 * - TestCodeGenBackend: naming records into capturedNamePrompts, never into
 *   capturedPrompts (an existing test asserts that array's length).
 */
import { describe, expect, it } from 'vitest';
import {
  CANNED_TEST_APP,
  LlmAppGenerator,
  TestCodeGenBackend,
  cleanArtifactName,
  fallbackArtifactName,
  generateAndSaveArtifact,
  type AppGenerationOutput,
  type AppGenerator,
  type ArtifactSpec,
  type CodeGenBackend,
  type GenerateArtifactInput,
} from '../src/index.js';

const SHEET_CELLS = [
  ['Name', 'Hours'],
  ['Alice', 8],
  ['Bob', 6],
];

function saveDeps(generator?: AppGenerator) {
  const specs: ArtifactSpec[] = [];
  return {
    deps: {
      callTool: async (tool: string) => {
        if (tool === 'list_sheets') return { sheets: ['Sheet1'] };
        if (tool === 'get_results') return { cells: SHEET_CELLS };
        throw new Error(`unexpected tool ${tool}`);
      },
      store: { add: (s: ArtifactSpec) => specs.push(s) },
      ...(generator ? { generator } : {}),
      principal: 'test-user',
      template: 'data-table' as const,
    },
    specs,
  };
}

function stubGenerator(name?: string): AppGenerator {
  return {
    name: 'stub',
    generate: async (): Promise<AppGenerationOutput> => ({
      source: 'function App() { return h("div", null, "stub"); }',
      template: 'custom' as AppGenerationOutput['template'],
      ...(name !== undefined ? { name } : {}),
    }),
  };
}

class StubBackend implements CodeGenBackend {
  readonly name = 'stub-backend';
  constructor(
    private readonly code: string,
    private readonly text?: string | Error,
    private readonly hasText = true,
  ) {}

  async generateCode(): Promise<string> {
    return this.code;
  }

  async generateText(): Promise<string> {
    if (!this.hasText) throw new Error('generateText not implemented');
    if (this.text instanceof Error) throw this.text;
    return this.text ?? '';
  }
}

const GEN_INPUT: GenerateArtifactInput = {
  prompt: 'build me a sortable hours app',
  sheet: 'Sheet1',
};

function llmInput(prompt: string) {
  return {
    prompt,
    sheet: 'Sheet1',
    binding: { startRow: 0, startCol: 0, endRow: 2, endCol: 1, hasHeaderRow: true },
    columns: [{ name: 'Name', type: 'text', index: 0 }],
    template: 'data-table' as const,
  };
}

describe('cleanArtifactName', () => {
  it('strips surrounding quotes and whitespace', () => {
    expect(cleanArtifactName('  "Sales Dashboard"  ')).toBe('Sales Dashboard');
  });

  it('takes the first line only', () => {
    expect(cleanArtifactName('Sales Dashboard\nHere is a longer description')).toBe(
      'Sales Dashboard',
    );
  });

  it('strips fence markers and markdown bullets', () => {
    expect(cleanArtifactName('```Sales Dashboard```')).toBe('Sales Dashboard');
    expect(cleanArtifactName('- Sales Dashboard')).toBe('Sales Dashboard');
  });

  it('returns null when nothing usable remains', () => {
    expect(cleanArtifactName(undefined)).toBeNull();
    expect(cleanArtifactName('')).toBeNull();
    expect(cleanArtifactName('   ')).toBeNull();
    expect(cleanArtifactName('"""')).toBeNull();
  });

  it('caps long names at 60 chars like the prompt fallback', () => {
    const long = 'A'.repeat(100);
    expect(cleanArtifactName(long)).toBe('A'.repeat(57) + '…');
    expect(cleanArtifactName(long)!.length).toBe(58);
  });
});

describe('fallbackArtifactName', () => {
  it('keeps short prompts unchanged and truncates long ones', () => {
    expect(fallbackArtifactName('build an app')).toBe('build an app');
    const long = 'x'.repeat(100);
    expect(fallbackArtifactName(long)).toBe('x'.repeat(57) + '…');
  });
});

describe('generateAndSaveArtifact naming', () => {
  it('prefers the cleaned model name over the prompt', async () => {
    const { deps, specs } = saveDeps(stubGenerator('  "Sales Dashboard" \nExtra line'));
    const result = await generateAndSaveArtifact(GEN_INPUT, deps);
    expect(result.routed).toBe('app');
    expect(specs[0]!.name).toBe('Sales Dashboard');
    expect(specs[0]!.name).not.toContain('sortable hours');
  });

  it('falls back to the prompt when the generator provides no name', async () => {
    const { deps, specs } = saveDeps(stubGenerator());
    const result = await generateAndSaveArtifact(GEN_INPUT, deps);
    expect(result.routed).toBe('app');
    expect(specs[0]!.name).toBe('build me a sortable hours app');
  });

  it('falls back to the truncated prompt for long prompts without a model name', async () => {
    const longPrompt = 'build me a very long sortable hours app with many words in it please';
    const { deps, specs } = saveDeps(stubGenerator());
    await generateAndSaveArtifact({ prompt: longPrompt, sheet: 'Sheet1' }, deps);
    expect(specs[0]!.name).toBe(longPrompt.slice(0, 57) + '…');
  });
});

describe('LlmAppGenerator naming call', () => {
  it('returns the model name and keeps code generation intact', async () => {
    const gen = new LlmAppGenerator({
      backend: new StubBackend(CANNED_TEST_APP, '  "Revenue Tracker" \nMore text'),
    });
    const out = await gen.generate(llmInput('build a revenue app'));
    expect(out.name).toContain('Revenue Tracker');
    expect(out.source).toContain('function App()');
  });

  it('omits the name (never fails) when the naming call throws', async () => {
    const gen = new LlmAppGenerator({
      backend: new StubBackend(CANNED_TEST_APP, new Error('model down')),
    });
    const out = await gen.generate(llmInput('build a revenue app'));
    expect(out.name).toBeUndefined();
    expect(out.source).toContain('function App()');
  });

  it('omits the name when the backend has no generateText', async () => {
    const backend = new StubBackend(CANNED_TEST_APP, undefined, false);
    // Simulate a backend without the optional method entirely.
    const gen = new LlmAppGenerator({
      backend: { generateCode: () => backend.generateCode() } as CodeGenBackend,
    });
    const out = await gen.generate(llmInput('build a revenue app'));
    expect(out.name).toBeUndefined();
  });

  it('names through the test backend without disturbing capturedPrompts', async () => {
    const backend = new TestCodeGenBackend();
    const gen = new LlmAppGenerator({ backend });
    const out = await gen.generate(llmInput('build an app'));
    expect(out.name).toBe('Test App');
    expect(backend.capturedPrompts).toHaveLength(1);
    expect(backend.capturedNamePrompts).toHaveLength(1);
    expect(backend.capturedNamePrompts[0]).toContain('short name');
  });

  it('buildNamePrompt carries the request and the columns', () => {
    const gen = new LlmAppGenerator({ backend: new TestCodeGenBackend() });
    const prompt = gen.buildNamePrompt(llmInput('build a revenue app'));
    expect(prompt).toContain('build a revenue app');
    expect(prompt).toContain('Name');
    expect(prompt).toContain('Return ONLY the name');
  });
});
