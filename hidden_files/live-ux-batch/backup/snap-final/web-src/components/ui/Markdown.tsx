/**
 * Markdown renderer for agent answers (#40, design doc §3.3): a safe
 * subset renderer — React elements only, never innerHTML, so model
 * output can never inject markup. Supports paragraphs, headings,
 * lists, bold/italic, inline code, fenced code blocks, GFM pipe
 * tables, blockquotes, links (https only), and horizontal rules.
 *
 * Progressive by construction: it renders whatever text has arrived;
 * an unterminated fence renders as a code block in progress and an
 * unfinished table row simply has not appeared yet — rows append as
 * their lines land (no re-layout beyond the append). Charts and app
 * artifacts never come through here (atomic attachments, §3.4).
 */
import { Fragment, type ReactNode } from 'react';

function renderInline(text: string, keyBase: string): ReactNode[] {
  // Tokenize on code spans first (their content is literal), then
  // bold/italic/links inside the remaining text segments.
  const out: ReactNode[] = [];
  const codeSplit = text.split(/(`[^`]+`)/g);
  codeSplit.forEach((seg, i) => {
    if (seg.startsWith('`') && seg.endsWith('`') && seg.length > 2) {
      out.push(<code key={`${keyBase}-c${i}`}>{seg.slice(1, -1)}</code>);
    } else {
      out.push(...renderEmphasis(seg, `${keyBase}-e${i}`));
    }
  });
  return out;
}

function renderEmphasis(text: string, keyBase: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(\*\*[^*]+\*\*|\*[^*]+\*|\[[^\]]+\]\(https?:\/\/[^)\s]+\))/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let k = 0;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push(<Fragment key={`${keyBase}-t${k}`}>{text.slice(last, m.index)}</Fragment>);
    const tok = m[0];
    if (tok.startsWith('**')) {
      out.push(<strong key={`${keyBase}-b${k}`}>{tok.slice(2, -2)}</strong>);
    } else if (tok.startsWith('*')) {
      out.push(<em key={`${keyBase}-i${k}`}>{tok.slice(1, -1)}</em>);
    } else {
      const link = /^\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)$/.exec(tok);
      if (link) {
        out.push(
          <a key={`${keyBase}-a${k}`} href={link[2]} target="_blank" rel="noreferrer">
            {link[1]}
          </a>,
        );
      } else {
        out.push(<Fragment key={`${keyBase}-x${k}`}>{tok}</Fragment>);
      }
    }
    last = m.index + tok.length;
    k += 1;
  }
  if (last < text.length) out.push(<Fragment key={`${keyBase}-tail`}>{text.slice(last)}</Fragment>);
  return out;
}

function splitTableRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((c) => c.trim());
}

function isTableSeparator(line: string): boolean {
  return /^\|?[\s:|-]+\|?$/.test(line.trim()) && line.includes('-');
}

export default function Markdown({ text }: { text: string }) {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const blocks: ReactNode[] = [];
  let i = 0;
  let key = 0;
  const nextKey = () => `md-${key++}`;

  while (i < lines.length) {
    const line = lines[i];
    // Fenced code block (an unterminated fence = stream in progress).
    if (line.trimStart().startsWith('```')) {
      const buf: string[] = [];
      i += 1;
      while (i < lines.length && !lines[i].trimStart().startsWith('```')) {
        buf.push(lines[i]);
        i += 1;
      }
      i += 1; // closing fence (or EOF)
      blocks.push(
        <pre key={nextKey()}>
          <code>{buf.join('\n')}</code>
        </pre>,
      );
      continue;
    }
    // GFM table: header row + separator + body rows.
    if (line.includes('|') && i + 1 < lines.length && isTableSeparator(lines[i + 1])) {
      const header = splitTableRow(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i].includes('|') && lines[i].trim().length > 0) {
        rows.push(splitTableRow(lines[i]));
        i += 1;
      }
      blocks.push(
        <table key={nextKey()}>
          <thead>
            <tr>
              {header.map((h, hi) => (
                <th key={hi}>{renderInline(h, `th${hi}`)}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, ri) => (
              <tr key={ri}>
                {r.map((c, ci) => (
                  <td key={ci}>{renderInline(c, `td${ri}-${ci}`)}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>,
      );
      continue;
    }
    // Headings.
    const heading = /^(#{1,3})\s+(.*)$/.exec(line);
    if (heading) {
      const level = heading[1].length;
      const content = renderInline(heading[2], nextKey());
      blocks.push(
        level === 1 ? (
          <h1 key={nextKey()}>{content}</h1>
        ) : level === 2 ? (
          <h2 key={nextKey()}>{content}</h2>
        ) : (
          <h3 key={nextKey()}>{content}</h3>
        ),
      );
      i += 1;
      continue;
    }
    // Lists (consecutive items group).
    if (/^\s*[-*]\s+/.test(line) || /^\s*\d+[.)]\s+/.test(line)) {
      const ordered = /^\s*\d+[.)]\s+/.test(line);
      const items: string[] = [];
      while (i < lines.length && (/^\s*[-*]\s+/.test(lines[i]) || /^\s*\d+[.)]\s+/.test(lines[i]))) {
        items.push(lines[i].replace(/^\s*(?:[-*]|\d+[.)])\s+/, ''));
        i += 1;
      }
      const listItems = items.map((it, ii) => <li key={ii}>{renderInline(it, `li${ii}`)}</li>);
      blocks.push(ordered ? <ol key={nextKey()}>{listItems}</ol> : <ul key={nextKey()}>{listItems}</ul>);
      continue;
    }
    // Blockquote.
    if (line.trimStart().startsWith('>')) {
      const buf: string[] = [];
      while (i < lines.length && lines[i].trimStart().startsWith('>')) {
        buf.push(lines[i].trimStart().replace(/^>\s?/, ''));
        i += 1;
      }
      blocks.push(<blockquote key={nextKey()}>{renderInline(buf.join(' '), nextKey())}</blockquote>);
      continue;
    }
    // Horizontal rule.
    if (/^\s*(-{3,}|\*{3,})\s*$/.test(line)) {
      blocks.push(<hr key={nextKey()} />);
      i += 1;
      continue;
    }
    // Blank line: block separator.
    if (line.trim().length === 0) {
      i += 1;
      continue;
    }
    // Paragraph: consecutive plain lines join with spaces.
    const buf: string[] = [line];
    i += 1;
    while (
      i < lines.length &&
      lines[i].trim().length > 0 &&
      !lines[i].trimStart().startsWith('```') &&
      !/^(#{1,3})\s+/.test(lines[i]) &&
      !/^\s*[-*]\s+/.test(lines[i]) &&
      !lines[i].trimStart().startsWith('>')
    ) {
      buf.push(lines[i]);
      i += 1;
    }
    blocks.push(<p key={nextKey()}>{renderInline(buf.join(' '), nextKey())}</p>);
  }

  return <div className="ds-md">{blocks}</div>;
}
