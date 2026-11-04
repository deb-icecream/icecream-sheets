// @vitest-environment jsdom
/** Markdown renderer tests (#40 §3.3): safe subset, tables, fences. */
import { describe, expect, it } from 'vitest';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import Markdown from './Markdown';

describe('Markdown', () => {
  it('renders paragraphs, emphasis and inline code as elements', () => {
    const html = renderToStaticMarkup(h(Markdown, { text: 'Total is **60** and `SUM` ran.' }));
    expect(html).toContain('<strong>60</strong>');
    expect(html).toContain('<code>SUM</code>');
    expect(html).toContain('<p>');
  });

  it('renders a GFM table with header and rows', () => {
    const md = '| Region | Revenue |\n| --- | --- |\n| North | 100 |\n| South | 200 |';
    const html = renderToStaticMarkup(h(Markdown, { text: md }));
    expect(html).toContain('<table>');
    expect(html).toContain('<th>Region</th>');
    expect(html).toContain('<td>South</td>');
    expect(html).toContain('<td>200</td>');
  });

  it('renders fenced code literally and never injects markup', () => {
    const md = '```\n<script>alert(1)</script>\n```\n\nAfter <b>text</b>';
    const html = renderToStaticMarkup(h(Markdown, { text: md }));
    expect(html).toContain('<pre>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;b&gt;text&lt;/b&gt;');
  });

  it('an unterminated fence still renders as a code block in progress', () => {
    const html = renderToStaticMarkup(h(Markdown, { text: '```\npartial code' }));
    expect(html).toContain('<pre>');
    expect(html).toContain('partial code');
  });
});
