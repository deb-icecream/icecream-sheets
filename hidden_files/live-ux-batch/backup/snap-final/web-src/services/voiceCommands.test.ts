/**
 * Voice command matcher tests (idea: voice-tolerant command palette).
 *
 * Covers the real dictation mangle patterns from the brief — including
 * NAME mangles ("some if" → SUMIF, "vee look up" → VLOOKUP,
 * "ex look up" → XLOOKUP) — plus the dictated-range/criteria grammar
 * and the write/read/recalculate commands. A resolution is only a
 * description of an MCP call; these tests assert the exact tool + args
 * each utterance resolves to.
 */
import { describe, expect, it } from 'vitest';
import {
  buildFormulaCall,
  resolveVoiceCommand,
  tokenizeVoiceInput,
  validateFormulaText,
  type VoiceTarget,
} from './voiceCommands';

const TARGET: VoiceTarget = { sheet: 'Sheet1', row: 4, col: 2 }; // C5

describe('tokenizeVoiceInput', () => {
  it('converts spoken numbers and joins split cell refs', () => {
    expect(tokenizeVoiceInput('some if b two to b twenty')).toEqual([
      'some', 'if', 'b2', 'to', 'b20',
    ]);
  });

  it('handles compound spoken numbers', () => {
    expect(tokenizeVoiceInput('set a1 to twenty five')).toEqual(['set', 'a1', 'to', '25']);
  });

  it('strips punctuation and case', () => {
    expect(tokenizeVoiceInput('Sum, of Column B!')).toEqual(['sum', 'of', 'column', 'b']);
  });
});

describe('mangled function names (brief patterns)', () => {
  it('"some if" with a dictated range and criteria resolves to SUMIF via set_formulas', () => {
    const r = resolveVoiceCommand('some if b two to b twenty greater than ten', TARGET);
    expect(r).not.toBeNull();
    expect(r?.kind).toBe('formula');
    expect(r?.name).toBe('SUMIF');
    expect(r?.formula).toBe('=SUMIF(B2:B20, ">10")');
    expect(r?.executable).toBe(true);
    expect(r?.actionLabel).toBe('Insert formula in Sheet1!C5');
    expect(r?.call?.tool).toBe('set_formulas');
    expect(r?.call?.args).toMatchObject({
      formulas: [{ sheet: 'Sheet1', row: 4, col: 2, formula: '=SUMIF(B2:B20, ">10")' }],
    });
  });

  it('"vee look up" resolves to VLOOKUP (name mangle)', () => {
    const r = resolveVoiceCommand('vee look up', TARGET);
    expect(r?.name).toBe('VLOOKUP');
    expect(r?.kind).toBe('formula');
    expect(r?.formula).toContain('=VLOOKUP(');
    // No arguments dictated: shown for completion, not executable as-is.
    expect(r?.executable).toBe(false);
    expect(r?.missing).toBeTruthy();
  });

  it('"ex look up" resolves to XLOOKUP (name mangle)', () => {
    const r = resolveVoiceCommand('ex look up', TARGET);
    expect(r?.name).toBe('XLOOKUP');
    expect(r?.formula).toContain('=XLOOKUP(');
  });

  it('"count if" beats COUNT and builds COUNTIF with equality criteria', () => {
    const r = resolveVoiceCommand('count if b2 to b20 equal to 5', TARGET);
    expect(r?.name).toBe('COUNTIF');
    expect(r?.formula).toBe('=COUNTIF(B2:B20, "5")');
    expect(r?.executable).toBe(true);
  });

  it('"if error" resolves to IFERROR, "text join" to TEXTJOIN', () => {
    expect(resolveVoiceCommand('if error', TARGET)?.name).toBe('IFERROR');
    expect(resolveVoiceCommand('text join', TARGET)?.name).toBe('TEXTJOIN');
  });

  it('"some product" resolves to SUMPRODUCT with its range', () => {
    const r = resolveVoiceCommand('some product b2 to b20', TARGET);
    expect(r?.name).toBe('SUMPRODUCT');
    expect(r?.formula).toBe('=SUMPRODUCT(B2:B20)');
    expect(r?.executable).toBe(true);
  });

  it('"index match" resolves to the INDEX/MATCH combination skeleton', () => {
    const r = resolveVoiceCommand('index match', TARGET);
    expect(r?.name).toBe('INDEX + MATCH');
    expect(r?.formula).toContain('MATCH(');
    expect(r?.executable).toBe(false);
  });

  it('"some" alone is the classic SUM mangle', () => {
    const r = resolveVoiceCommand('some of column b', TARGET);
    expect(r?.name).toBe('SUM');
    expect(r?.formula).toBe('=SUM(B:B)');
  });
});

describe('dictated-range grammar', () => {
  it('typed range with colon', () => {
    const r = resolveVoiceCommand('sum b2:b20', TARGET);
    expect(r?.formula).toBe('=SUM(B2:B20)');
  });

  it('spoken range without "of"', () => {
    const r = resolveVoiceCommand('average b2 to b10', TARGET);
    expect(r?.name).toBe('AVERAGE');
    expect(r?.formula).toBe('=AVERAGE(B2:B10)');
  });

  it('multiple ranges joined by "and"', () => {
    const r = resolveVoiceCommand('sum b2 to b5 and d2 to d5', TARGET);
    expect(r?.formula).toBe('=SUM(B2:B5, D2:D5)');
  });

  it('SUMIF with a separate sum range after the criteria', () => {
    const r = resolveVoiceCommand('sum if a2 to a20 greater than 10 b2 to b20', TARGET);
    expect(r?.formula).toBe('=SUMIF(A2:A20, ">10", B2:B20)');
  });

  it('bare function name resolves to a non-executable skeleton with guidance', () => {
    const r = resolveVoiceCommand('sumif', TARGET);
    expect(r?.name).toBe('SUMIF');
    expect(r?.executable).toBe(false);
    expect(r?.missing).toContain('range');
    expect(r?.call).toBeNull();
  });

  it('alternates surface when another function is close', () => {
    const r = resolveVoiceCommand('count if b2 to b20 greater than 3', TARGET);
    expect(r?.name).toBe('COUNTIF');
    const altNames = (r?.alternates ?? []).map((a) => a.name);
    expect(altNames).toContain('COUNT');
  });

  it('forceFunction re-resolves with the picked alternate', () => {
    const r = resolveVoiceCommand('count if b2 to b20 greater than 3', TARGET, {
      forceFunction: 'COUNT',
    });
    expect(r?.name).toBe('COUNT');
    expect(r?.formula).toBe('=COUNT(B2:B20)');
  });
});

describe('write / read / recalculate commands', () => {
  it('"set C3 to 42" writes a number via write_cells', () => {
    const r = resolveVoiceCommand('set c3 to 42', TARGET);
    expect(r?.kind).toBe('write');
    expect(r?.call?.tool).toBe('write_cells');
    expect(r?.call?.args).toMatchObject({
      cells: [{ sheet: 'Sheet1', row: 2, col: 2, value: 42 }],
    });
    expect(r?.actionLabel).toBe('Set Sheet1!C3 to 42');
  });

  it('"set B3 to hello world" writes text', () => {
    const r = resolveVoiceCommand('set b3 to hello world', TARGET);
    expect(r?.call?.args).toMatchObject({
      cells: [{ sheet: 'Sheet1', row: 2, col: 1, value: 'hello world' }],
    });
  });

  it('"read B2 to B5" reads via read_cells with 0-based bounds', () => {
    const r = resolveVoiceCommand('read b2 to b5', TARGET);
    expect(r?.kind).toBe('read');
    expect(r?.call?.tool).toBe('read_cells');
    expect(r?.call?.args).toMatchObject({
      sheet: 'Sheet1', startRow: 1, startCol: 1, endRow: 4, endCol: 1,
    });
  });

  it('"recalculate" resolves to the recalculate tool', () => {
    const r = resolveVoiceCommand('recalculate', TARGET);
    expect(r?.kind).toBe('recalculate');
    expect(r?.call?.tool).toBe('recalculate');
  });

  it('gibberish resolves to nothing', () => {
    expect(resolveVoiceCommand('flurbo zanz quix', TARGET)).toBeNull();
    expect(resolveVoiceCommand('', TARGET)).toBeNull();
  });

  // #41 regression set: filler-heavy dictation. The owner's verbatim
  // utterance used to resolve to TODAY() at the 0.6 fuzzy floor.
  it('the owner fill utterance resolves to a fill, never TODAY', () => {
    const r = resolveVoiceCommand(
      'Okay, uh, to one thing, fill uh, one to 10. Can you do that?',
      TARGET,
    );
    expect(r?.name).toBe('Fill series');
    expect(r?.score).toBeGreaterThanOrEqual(0.9);
    expect(r?.executable).toBe(true);
    expect(r?.actionLabel).toContain('with 1 to 10');
    const cells = r?.call?.args.cells as { row: number; col: number; value: number }[];
    expect(r?.call?.tool).toBe('write_cells');
    expect(cells).toHaveLength(10);
    expect(cells[0]).toMatchObject({ row: 4, col: 2, value: 1 });
    expect(cells[9]).toMatchObject({ row: 13, col: 2, value: 10 });
  });

  it('fill variants: bare, ranged, descending, word numbers', () => {
    for (const input of [
      'fill 1 to 10',
      'fill one to ten',
      'fill A1 to A10 with 1 to 10',
      'um, fill one to ten please',
      'okay uh can you fill 5 to 8',
      'fill the column with one through ten',
    ]) {
      const r = resolveVoiceCommand(input, TARGET);
      expect(r?.name, input).toBe('Fill series');
      expect(r?.executable, input).toBe(true);
    }
    const down = resolveVoiceCommand('fill 10 down to 1', TARGET);
    const values = (down?.call?.args.cells as { value: number }[]).map((c) => c.value);
    expect(values).toEqual([10, 9, 8, 7, 6, 5, 4, 3, 2, 1]);
  });

  it('fill without numbers is guidance, not a fuzzy function', () => {
    const r = resolveVoiceCommand('fill the column', TARGET);
    expect(r?.name).toBe('Fill series');
    expect(r?.executable).toBe(false);
    expect(r?.missing).toContain('fill 1 to 10');
  });

  it('discourse-only utterances resolve to nothing', () => {
    expect(resolveVoiceCommand('okay uh can you do that thing', TARGET)).toBeNull();
  });

  it('discourse stripping does not break real commands', () => {
    expect(resolveVoiceCommand('to day', TARGET)?.name).toBe('TODAY');
    expect(
      resolveVoiceCommand('some if B2 to B20 greater than 10', TARGET)?.name,
    ).toBe('SUMIF');
    expect(resolveVoiceCommand('okay, sum of column B please', TARGET)?.name).toBe('SUM');
  });
});

describe('formula helpers', () => {
  it('buildFormulaCall stamps the target cell and principal', () => {
    const call = buildFormulaCall(TARGET, '=SUM(B:B)');
    expect(call.tool).toBe('set_formulas');
    expect(call.args).toMatchObject({
      formulas: [{ sheet: 'Sheet1', row: 4, col: 2, formula: '=SUM(B:B)' }],
      principal: 'web-user',
    });
  });

  it('validateFormulaText accepts a complete formula', () => {
    expect(validateFormulaText('=SUMIF(B2:B20, ">10")')).toBeNull();
  });

  it('validateFormulaText rejects missing "=" and unbalanced parens', () => {
    expect(validateFormulaText('SUM(B2)')).toContain('start with');
    expect(validateFormulaText('=SUM(B2')).toContain('unbalanced');
    expect(validateFormulaText('=INDEX(<range>, 1)')).toContain('placeholder');
  });
});
