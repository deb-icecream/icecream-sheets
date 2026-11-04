/**
 * #156 enforcement tests: a generated app must demonstrably use the
 * design system, or fail visibly at generation time. Before this fix the
 * DESIGN SYSTEM prompt block was advisory prose with no check, so a
 * model that ignored it shipped a plain white card with native selects
 * — and the stylesheet itself had no `select` component at all, so even
 * a prompt-faithful model could not style a dropdown.
 */
import { describe, expect, it } from 'vitest';
import {
  CANNED_TEST_APP,
  DESIGN_SYSTEM_COMPONENT_CLASSES,
  LlmAppGenerator,
  TestCodeGenBackend,
  validateDesignSystem,
  type AppGenerationInput,
  type CodeGenBackend,
} from '../src/artifacts/llm.js';
import { TemplateAppGenerator } from '../src/artifacts/generator.js';

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

/** The recorded #156 symptom, in miniature: plain divs, a native select
 * and a native button, zero design-system classes. */
const PLAIN_APP = [
  'function App() {',
  "  return h('div', null,",
  "    h('select', null, h('option', null, 'Revenue')),",
  "    h('button', null, 'Go'));",
  '}',
].join('\n');

const STYLED_APP = [
  'function App() {',
  '  return <div className="card bg-base-100 shadow-sm"><div className="card-body">',
  '    <select className="select"><option>Revenue</option></select>',
  '    <button className="btn btn-primary">Go</button>',
  '  </div></div>;',
  '}',
].join('\n');

const CARD_WITH_BARE_SELECT = [
  'function App() {',
  '  return <div className="card bg-base-100"><div className="card-body">',
  '    <select><option>Revenue</option></select>',
  '  </div></div>;',
  '}',
].join('\n');

class QueueBackend implements CodeGenBackend {
  readonly name = 'queue-backend';
  readonly calls: string[] = [];
  constructor(private readonly codes: string[]) {}
  async generateCode(prompt: string): Promise<string> {
    this.calls.push(prompt);
    return this.codes[Math.min(this.calls.length - 1, this.codes.length - 1)] ?? '';
  }
}

describe('validateDesignSystem', () => {
  it('passes a styled JSX app and names its component classes', () => {
    const v = validateDesignSystem(STYLED_APP);
    expect(v.ok).toBe(true);
    expect(v.componentClasses).toContain('card');
    expect(v.componentClasses).toContain('select');
    expect(v.componentClasses).toContain('btn');
  });

  it('passes the canned test app (table component, no bare controls)', () => {
    expect(validateDesignSystem(CANNED_TEST_APP).ok).toBe(true);
  });

  it('fails the plain-app symptom on all three grounds', () => {
    const v = validateDesignSystem(PLAIN_APP);
    expect(v.ok).toBe(false);
    expect(v.errors.join(' ')).toMatch(/no DaisyUI component class/);
    expect(v.errors.join(' ')).toMatch(/bare <select>/);
    expect(v.errors.join(' ')).toMatch(/bare <button>/);
  });

  it('fails a card app with a bare select even though a component is present', () => {
    const v = validateDesignSystem(CARD_WITH_BARE_SELECT);
    expect(v.ok).toBe(false);
    expect(v.errors.join(' ')).toMatch(/bare <select>/);
    expect(v.errors.join(' ')).not.toMatch(/no DaisyUI component class/);
  });

  it('fails a bare h() button without its btn class', () => {
    const v = validateDesignSystem(
      "function App() { return h('div', { className: 'card' }, h('button', null, 'Go')); }",
    );
    expect(v.ok).toBe(false);
    expect(v.errors.join(' ')).toMatch(/bare <button>/);
  });

  it('passes every template generator output', async () => {
    for (const template of ['data-table', 'chart-dashboard', 'data-entry-form'] as const) {
      const out = await new TemplateAppGenerator().generate({ ...INPUT, template });
      expect(validateDesignSystem(out.source).ok, `${template} uses the design system`).toBe(true);
    }
  });
});

describe('design-system vocabulary cannot drift', () => {
  it('every validated component class is named by the buildPrompt', () => {
    const prompt = new LlmAppGenerator({ backend: new TestCodeGenBackend() }).buildPrompt(INPUT);
    const section = prompt.slice(prompt.indexOf('DESIGN SYSTEM'), prompt.indexOf('Return ONLY'));
    const line = section.split('\n').find((l) => l.startsWith('Components:'));
    expect(line).toBeDefined();
    for (const cls of DESIGN_SYSTEM_COMPONENT_CLASSES) {
      expect(line, `prompt names ${cls}`).toContain(cls);
    }
    expect(line).toContain('input, select, badge');
  });
});

describe('LlmAppGenerator design-system repair', () => {
  it('repairs a plain first attempt into a styled app', async () => {
    const backend = new QueueBackend([PLAIN_APP, STYLED_APP]);
    const gen = new LlmAppGenerator({ backend });
    const out = await gen.generate(INPUT);
    expect(backend.calls).toHaveLength(2);
    expect(backend.calls[1]).toMatch(/REPAIR/);
    expect(out.source).toContain('card');
    expect(out.source).toContain('select');
  });

  it('throws visibly when the repair also ignores the design system', async () => {
    const backend = new QueueBackend([PLAIN_APP]);
    const gen = new LlmAppGenerator({ backend });
    await expect(gen.generate(INPUT)).rejects.toThrow(/does not use the design system/);
    expect(backend.calls).toHaveLength(2);
  });

  it('does not spend a repair call when the first attempt is styled', async () => {
    const backend = new TestCodeGenBackend();
    const gen = new LlmAppGenerator({ backend });
    const out = await gen.generate(INPUT);
    expect(out.source).toContain('function App()');
    expect(backend.capturedPrompts).toHaveLength(1);
  });
});

describe('dynamic className forms (#160)', () => {
  /** The v3 toggle-button shape: conditional classes, no static btn token. */
  const TOGGLE_JSX = [
    'function App() {',
    '  const [active, setActive] = useState("Revenue");',
    '  return <div className="card"><div className="card-body">',
    "    <button className={active === 'Revenue' ? 'btn btn-primary' : 'btn'}>Revenue</button>",
    "    <button className={active === 'Gross Profit' ? 'btn btn-primary' : 'btn'}>Gross Profit</button>",
    '  </div></div>;',
    '}',
  ].join('\n');

  const TOGGLE_H =
    "function App() { return h('div', { className: 'card' }, " +
    "h('button', { className: active ? 'btn btn-primary' : 'btn' }, 'Revenue')); }";

  const TEMPLATE_LITERAL =
    'function App() { return <div className="card"><button className={`btn btn-primary`}>Go</button></div>; }';

  const CLASS_ATTR =
    'function App() { return <div className="card"><button class="btn btn-primary">Go</button></div>; }';

  const CARD_WITH_BARE_BUTTON = [
    'function App() {',
    '  return <div className="card bg-base-100"><div className="card-body">',
    '    <button>Go</button>',
    '  </div></div>;',
    '}',
  ].join('\n');

  it('passes a JSX toggle button whose btn lives in conditional branches', () => {
    const v = validateDesignSystem(TOGGLE_JSX);
    expect(v.ok).toBe(true);
    expect(v.componentClasses).toContain('btn');
    expect(v.componentClasses).toContain('btn-primary');
  });

  it('passes an h() toggle button with a conditional className', () => {
    expect(validateDesignSystem(TOGGLE_H).ok).toBe(true);
  });

  it('passes a backtick template-literal className', () => {
    expect(validateDesignSystem(TEMPLATE_LITERAL).ok).toBe(true);
  });

  it('passes a plain class attribute carrying btn', () => {
    expect(validateDesignSystem(CLASS_ATTR).ok).toBe(true);
  });

  it('still fails a genuinely bare button even with a styled card', () => {
    const v = validateDesignSystem(CARD_WITH_BARE_BUTTON);
    expect(v.ok).toBe(false);
    expect(v.errors.join(' ')).toMatch(/bare <button>/);
    expect(v.errors.join(' ')).not.toMatch(/no DaisyUI component class/);
  });

  it('repair succeeds when the repaired source uses the toggle form', async () => {
    const backend = new QueueBackend([PLAIN_APP, TOGGLE_JSX]);
    const gen = new LlmAppGenerator({ backend });
    const out = await gen.generate(INPUT);
    expect(backend.calls).toHaveLength(2);
    expect(backend.calls[1]).toMatch(/REPAIR/);
    expect(out.source).toContain('btn-primary');
  });

  it('the buildPrompt shows the accepted toggle form', () => {
    const prompt = new LlmAppGenerator({ backend: new TestCodeGenBackend() }).buildPrompt(INPUT);
    expect(prompt).toContain('className={active ? "btn btn-primary" : "btn"}');
  });
});
