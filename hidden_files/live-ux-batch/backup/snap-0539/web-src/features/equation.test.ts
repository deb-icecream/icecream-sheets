/**
 * Unit tests for the equation typesetter.
 */
import { describe, expect, it } from 'vitest';
import {
  equationSvg,
  equationToText,
  fracNode,
  intNode,
  sqrtNode,
  subNode,
  sumNode,
  supNode,
  textNode,
} from './equation';

describe('equationSvg', () => {
  it('renders plain text with positive dimensions', () => {
    const { svg, width, height } = equationSvg([textNode('x+y')]);
    expect(width).toBeGreaterThan(0);
    expect(height).toBeGreaterThan(0);
    expect(svg).toContain('<svg');
    expect(svg).toContain('x+y');
  });

  it('renders a fraction with a rule line', () => {
    const { svg } = equationSvg([fracNode('a', 'b')]);
    expect(svg).toContain('<line');
    expect(svg).toContain('>a<');
    expect(svg).toContain('>b<');
  });

  it('renders superscripts and subscripts', () => {
    const { svg } = equationSvg([supNode('x', '2'), subNode('y', 'i')]);
    expect(svg).toContain('>x<');
    expect(svg).toContain('>2<');
    expect(svg).toContain('>i<');
  });

  it('renders sqrt with a radical and overline', () => {
    const { svg } = equationSvg([sqrtNode('x+1')]);
    expect(svg).toContain('√');
    expect(svg).toContain('<line');
  });

  it('renders sum and integral with limits', () => {
    const sum = equationSvg([sumNode('i=1', 'n', 'a')]);
    expect(sum.svg).toContain('∑');
    expect(sum.svg).toContain('i=1');
    const int = equationSvg([intNode('0', '1', 'f(x)dx')]);
    expect(int.svg).toContain('∫');
    expect(int.svg).toContain('f(x)dx');
  });

  it('escapes XML in text', () => {
    const { svg } = equationSvg([textNode('a<b&c')]);
    expect(svg).toContain('a&lt;b&amp;c');
    expect(svg).not.toContain('a<b&c');
  });

  it('handles an empty equation', () => {
    const { width, height } = equationSvg([]);
    expect(width).toBeGreaterThan(0);
    expect(height).toBeGreaterThan(0);
  });

  it('scales with font size', () => {
    const small = equationSvg([textNode('hello')], 12);
    const big = equationSvg([textNode('hello')], 36);
    expect(big.width).toBeGreaterThan(small.width);
    expect(big.height).toBeGreaterThan(small.height);
  });
});

describe('equationToText', () => {
  it('linearizes structures', () => {
    expect(equationToText([fracNode('a', 'b')])).toBe('(a)/(b)');
    expect(equationToText([supNode('x', '2')])).toBe('x^(2)');
    expect(equationToText([subNode('a', 'i')])).toBe('a_(i)');
    expect(equationToText([sqrtNode('z')])).toBe('√(z)');
    expect(equationToText([sumNode('i=1', 'n', 'x')])).toBe('∑_(i=1)^(n) x');
    expect(equationToText([intNode('a', 'b', 'f')])).toBe('∫_(a)^(b) f');
  });

  it('concatenates top-level nodes', () => {
    expect(equationToText([textNode('E='), fracNode('a', 'b')])).toBe('E=(a)/(b)');
  });
});
