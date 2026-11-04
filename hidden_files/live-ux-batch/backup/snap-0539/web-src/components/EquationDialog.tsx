/**
 * Equation editor (Insert > Symbols > Equation > Insert New Equation).
 *
 * Builds an equation from common structures (fraction, superscript,
 * subscript, square root, sum, integral) with editable fields, shows a
 * live SVG preview (features/equation.ts), and inserts the result as a
 * picture-like overlay via onInsert.
 */
import { useState } from 'react';
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
  type EqNode,
} from '../features/equation';
import A11yDialog from './A11yDialog';

export interface EquationDialogProps {
  onClose: () => void;
  onInsert: (svg: string, width: number, height: number, altText: string) => void;
}

interface Field {
  key: string;
  label: string;
  value: string;
}

interface Block {
  id: number;
  kind: 'text' | 'frac' | 'sup' | 'sub' | 'sqrt' | 'sum' | 'int';
  fields: Field[];
}

let blockId = 1;

function makeBlock(kind: Block['kind']): Block {
  const id = blockId++;
  const f = (key: string, label: string, value = ''): Field => ({ key, label, value });
  switch (kind) {
    case 'text': return { id, kind, fields: [f('text', 'Text', 'x')] };
    case 'frac': return { id, kind, fields: [f('num', 'Numerator', 'a'), f('den', 'Denominator', 'b')] };
    case 'sup': return { id, kind, fields: [f('base', 'Base', 'x'), f('exp', 'Exponent', '2')] };
    case 'sub': return { id, kind, fields: [f('base', 'Base', 'a'), f('sub', 'Subscript', 'i')] };
    case 'sqrt': return { id, kind, fields: [f('body', 'Radicand', 'x')] };
    case 'sum': return { id, kind, fields: [f('lower', 'Lower limit', 'i=1'), f('upper', 'Upper limit', 'n'), f('body', 'Body', 'aᵢ')] };
    case 'int': return { id, kind, fields: [f('lower', 'Lower limit', '0'), f('upper', 'Upper limit', '1'), f('body', 'Integrand', 'f(x)')] };
  }
}

function blockToNode(block: Block): EqNode {
  const v = (key: string): string => block.fields.find((f) => f.key === key)?.value ?? '';
  switch (block.kind) {
    case 'text': return textNode(v('text'));
    case 'frac': return fracNode(v('num'), v('den'));
    case 'sup': return supNode(v('base'), v('exp'));
    case 'sub': return subNode(v('base'), v('sub'));
    case 'sqrt': return sqrtNode(v('body'));
    case 'sum': return sumNode(v('lower'), v('upper'), v('body'));
    case 'int': return intNode(v('lower'), v('upper'), v('body'));
  }
}

const STRUCTURES: { kind: Block['kind']; label: string; glyph: string }[] = [
  { kind: 'frac', label: 'Fraction', glyph: 'a⁄b' },
  { kind: 'sup', label: 'Superscript', glyph: 'x²' },
  { kind: 'sub', label: 'Subscript', glyph: 'aᵢ' },
  { kind: 'sqrt', label: 'Square root', glyph: '√' },
  { kind: 'sum', label: 'Sum', glyph: '∑' },
  { kind: 'int', label: 'Integral', glyph: '∫' },
  { kind: 'text', label: 'Text', glyph: 'T' },
];

export function EquationDialog({ onClose, onInsert }: EquationDialogProps) {
  const [blocks, setBlocks] = useState<Block[]>([makeBlock('frac')]);
  const [fontSize, setFontSize] = useState(22);

  const nodes = blocks.map(blockToNode);
  const { svg, width, height } = equationSvg(nodes, fontSize);
  const previewUrl = `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;

  const setField = (id: number, key: string, value: string) =>
    setBlocks((prev) =>
      prev.map((b) =>
        b.id === id ? { ...b, fields: b.fields.map((f) => (f.key === key ? { ...f, value } : f)) } : b,
      ),
    );

  const removeBlock = (id: number) => setBlocks((prev) => prev.filter((b) => b.id !== id));

  return (
    <A11yDialog title={<>Equation</>} width={560} onClose={onClose}>

        <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 4 }}>Insert structure:</div>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 12 }}>
          {STRUCTURES.map((s) => (
            <button
              key={s.kind}
              type="button"
              title={s.label}
              onClick={() => setBlocks((prev) => [...prev, makeBlock(s.kind)])}
              style={{ fontSize: 16, padding: '4px 10px', cursor: 'pointer' }}
            >
              {s.glyph}
            </button>
          ))}
        </div>

        {blocks.map((b, i) => (
          <div
            key={b.id}
            style={{ border: '1px solid #ddd', padding: 8, marginBottom: 8 }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
              <strong style={{ fontSize: 12 }}>
                {i + 1}. {STRUCTURES.find((s) => s.kind === b.kind)?.label}
              </strong>
              <button type="button" onClick={() => removeBlock(b.id)} title="Remove structure" style={{ fontSize: 11 }}>
                Remove
              </button>
            </div>
            {b.fields.map((f) => (
              <label key={f.key} style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4, fontSize: 12 }}>
                <span style={{ width: 90 }}>{f.label}:</span>
                <input value={f.value} onChange={(e) => setField(b.id, f.key, e.target.value)} style={{ flex: 1 }} />
              </label>
            ))}
          </div>
        ))}
        {blocks.length === 0 && (
          <div className="dialog-hint">Add a structure above to start building the equation.</div>
        )}

        <label className="dialog-row">
          <span>Size:</span>
          <input
            type="range"
            min={12}
            max={48}
            value={fontSize}
            onChange={(e) => setFontSize(Number(e.target.value))}
            style={{ margin: '0 8px', flex: 1 }}
          />
          <span>{fontSize}px</span>
        </label>

        <div style={{ fontSize: 12, fontWeight: 600, margin: '8px 0 4px' }}>Preview:</div>
        <div style={{ border: '1px solid #ddd', padding: 16, textAlign: 'center', marginBottom: 8, background: '#fff' }}>
          <img src={previewUrl} alt={equationToText(nodes)} style={{ maxWidth: '100%' }} />
        </div>

        <div className="dialog-actions">
          <button
            onClick={() => {
              onInsert(svg, width, height, equationToText(nodes));
              onClose();
            }}
            disabled={blocks.length === 0}
          >
            Insert Equation
          </button>
          <button onClick={onClose}>Cancel</button>
        </div>
      </A11yDialog>
  );
}
