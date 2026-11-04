/**
 * New Rule… and Manage Rules… dialogs (Home > Styles > Conditional
 * Formatting).
 *
 * New Rule covers every rule type Excel offers in this app: cell-value
 * ("Format only cells that contain"), top/bottom/above-average, formula
 * ("Use a formula to determine which cells to format"), data bars, color
 * scales, and icon sets. Manage Rules lists the rules for the selection or
 * the whole sheet with edit / delete / move-up / move-down (rule order is
 * evaluation priority: the first matching rule wins).
 *
 * Both dialogs are pure UI: they build rule payloads and hand them to the
 * parent, which owns the CFRule[] / ExtCFRule[] state (see features/
 * models.ts and features/cfExtended.ts).
 */
import { useState } from 'react';
import type { CFOperator, CFRule } from '../features/models';
import { type ExtCFRule } from '../features/cfExtended';
import A11yDialog from './A11yDialog';

export type NewRuleType =
  | 'cellValue'
  | 'topBottom'
  | 'formula'
  | 'dataBar'
  | 'colorScale'
  | 'iconSet';

export interface CellRulePayload {
  operator: CFOperator;
  operands: string[];
  color: string;
}

export type ExtRulePayload = Omit<
  ExtCFRule,
  'id' | 'sheet' | 'startRow' | 'startCol' | 'endRow' | 'endCol'
>;

const RULE_TYPES: { id: NewRuleType; label: string }[] = [
  { id: 'cellValue', label: 'Format only cells that contain' },
  { id: 'topBottom', label: 'Format only top or bottom ranked values' },
  { id: 'formula', label: 'Use a formula to determine which cells to format' },
  { id: 'dataBar', label: 'Format all cells based on their values — Data Bar' },
  { id: 'colorScale', label: 'Format all cells based on their values — Color Scale' },
  { id: 'iconSet', label: 'Format all cells based on their values — Icon Set' },
];

const OPERATORS: { id: CFOperator; label: string; operands: number }[] = [
  { id: 'gt', label: 'greater than', operands: 1 },
  { id: 'lt', label: 'less than', operands: 1 },
  { id: 'eq', label: 'equal to', operands: 1 },
  { id: 'between', label: 'between', operands: 2 },
  { id: 'contains', label: 'text contains', operands: 1 },
];

const FORMAT_COLORS = [
  { name: 'Light red fill', value: '#ffc7ce' },
  { name: 'Light yellow fill', value: '#ffeb9c' },
  { name: 'Light green fill', value: '#c6efce' },
  { name: 'Red text', value: '#9c0006' },
  { name: 'Blue fill', value: '#bdd7ee' },
];

const DATA_BAR_COLORS = ['#638EC6', '#63C384', '#F8696B', '#FFB628', '#9B6BCE'];
const COLOR_SCALE_PRESETS = [
  { name: 'Green → Red', low: '#63C384', high: '#F8696B' },
  { name: 'Red → Green', low: '#F8696B', high: '#63C384' },
  { name: 'Blue → Red', low: '#638EC6', high: '#F8696B' },
  { name: 'White → Blue', low: '#FFFFFF', high: '#638EC6' },
];

// ---------------------------------------------------------------------------
// Rule descriptions (shared by Manage Rules)
// ---------------------------------------------------------------------------

export function describeCFRule(rule: CFRule): string {
  const op = OPERATORS.find((o) => o.id === rule.operator)?.label ?? rule.operator;
  const vals = rule.operands.join(' and ');
  return `Cell value ${op} ${vals}`;
}

export function describeExtCFRule(rule: ExtCFRule): string {
  switch (rule.kind) {
    case 'topN':
      if (rule.aboveAverage) return 'Above average';
      return `${rule.topBottom === 'bottom' ? 'Bottom' : 'Top'} ${rule.n ?? 10}`;
    case 'dataBar':
      return `Data Bar (${rule.color ?? 'default'})`;
    case 'colorScale':
      return `Color Scale (${rule.color ?? '?'} → ${rule.color2 ?? '?'})`;
    case 'iconSet':
      return 'Icon Set (3 Arrows)';
    case 'formula':
      return `Formula: ${rule.formula ?? ''}`;
    case 'cell':
      return 'Cell rule';
  }
}

// ---------------------------------------------------------------------------
// New Rule…
// ---------------------------------------------------------------------------

export interface CFNewRuleDialogProps {
  cellLabel: string;
  onClose: () => void;
  onAddCellRule: (payload: CellRulePayload) => void;
  onAddExtRule: (payload: ExtRulePayload) => void;
  /** Edit mode: prefill from an existing cell-value rule. */
  editingCell?: CFRule | null;
  /** Edit mode: prefill from an existing extended rule. */
  editingExt?: ExtCFRule | null;
  onSaveCellRule?: (id: number, payload: CellRulePayload) => void;
  onSaveExtRule?: (id: number, payload: ExtRulePayload) => void;
}

function initialType(editingExt?: ExtCFRule | null): NewRuleType {
  if (!editingExt) return 'cellValue';
  switch (editingExt.kind) {
    case 'topN': return 'topBottom';
    case 'dataBar': return 'dataBar';
    case 'colorScale': return 'colorScale';
    case 'iconSet': return 'iconSet';
    case 'formula': return 'formula';
    default: return 'cellValue';
  }
}

export function CFNewRuleDialog({
  cellLabel,
  onClose,
  onAddCellRule,
  onAddExtRule,
  editingCell,
  editingExt,
  onSaveCellRule,
  onSaveExtRule,
}: CFNewRuleDialogProps) {
  const editing = editingCell ?? editingExt ?? null;
  const [ruleType, setRuleType] = useState<NewRuleType>(() =>
    editingCell ? 'cellValue' : initialType(editingExt),
  );
  const [operator, setOperator] = useState<CFOperator>(editingCell?.operator ?? 'gt');
  const [op1, setOp1] = useState(editingCell?.operands[0] ?? '');
  const [op2, setOp2] = useState(editingCell?.operands[1] ?? '');
  const [color, setColor] = useState(
    editingCell?.color ?? editingExt?.color ?? FORMAT_COLORS[0].value,
  );
  const [tbMode, setTbMode] = useState<'top' | 'bottom' | 'above'>(
    editingExt?.aboveAverage ? 'above' : (editingExt?.topBottom ?? 'top'),
  );
  const [nText, setNText] = useState(String(editingExt?.n ?? 10));
  const [formula, setFormula] = useState(editingExt?.formula ?? '');
  const [barColor, setBarColor] = useState(editingExt?.color ?? DATA_BAR_COLORS[0]);
  const [scaleIdx, setScaleIdx] = useState(0);

  const opDef = OPERATORS.find((o) => o.id === operator) ?? OPERATORS[0];
  const cellValid = opDef.operands === 2 ? op1.trim() !== '' && op2.trim() !== '' : op1.trim() !== '';
  const formulaValid = formula.trim() !== '';
  const valid =
    ruleType === 'cellValue' ? cellValid : ruleType === 'formula' ? formulaValid : true;

  const submit = () => {
    if (!valid) return;
    if (ruleType === 'cellValue') {
      const payload: CellRulePayload = {
        operator,
        operands: opDef.operands === 2 ? [op1.trim(), op2.trim()] : [op1.trim()],
        color,
      };
      if (editingCell && onSaveCellRule) onSaveCellRule(editingCell.id, payload);
      else onAddCellRule(payload);
    } else {
      let payload: ExtRulePayload;
      if (ruleType === 'topBottom') {
        payload =
          tbMode === 'above'
            ? { kind: 'topN', aboveAverage: true, color }
            : { kind: 'topN', topBottom: tbMode, n: Math.max(1, Math.floor(Number(nText) || 10)), color };
      } else if (ruleType === 'formula') {
        const f = formula.trim();
        payload = { kind: 'formula', formula: f.startsWith('=') ? f : `=${f}`, color };
      } else if (ruleType === 'dataBar') {
        payload = { kind: 'dataBar', color: barColor };
      } else if (ruleType === 'colorScale') {
        const p = COLOR_SCALE_PRESETS[scaleIdx];
        payload = { kind: 'colorScale', color: p.low, color2: p.high };
      } else {
        payload = { kind: 'iconSet', iconSet: 'arrows3' };
      }
      if (editingExt && onSaveExtRule) onSaveExtRule(editingExt.id, payload);
      else onAddExtRule(payload);
    }
    onClose();
  };

  return (
    <A11yDialog title={<>{editing ? 'Edit Formatting Rule' : 'New Formatting Rule'} {cellLabel}</>} width={480} onClose={onClose}>

        <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 4 }}>Select a rule type:</div>
        <div style={{ border: '1px solid #ccc', maxHeight: 150, overflowY: 'auto', marginBottom: 12 }}>
          {RULE_TYPES.map((t) => (
            <label
              key={t.id}
              style={{
                display: 'block',
                padding: '5px 8px',
                cursor: 'pointer',
                background: ruleType === t.id ? '#e8f0fe' : undefined,
                fontSize: 13,
              }}
            >
              <input
                type="radio"
                name="cf-rule-type"
                checked={ruleType === t.id}
                onChange={() => setRuleType(t.id)}
                style={{ marginRight: 8 }}
              />
              {t.label}
            </label>
          ))}
        </div>

        <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 4 }}>Edit the rule description:</div>
        <div style={{ border: '1px solid #ddd', padding: 10, marginBottom: 8, fontSize: 13 }}>
          {ruleType === 'cellValue' && (
            <div className="dialog-row" style={{ flexWrap: 'wrap', gap: 6 }}>
              <span>Format only cells with a cell value</span>
              <select value={operator} onChange={(e) => setOperator(e.target.value as CFOperator)}>
                {OPERATORS.map((o) => (
                  <option key={o.id} value={o.id}>{o.label}</option>
                ))}
              </select>
              <input value={op1} onChange={(e) => setOp1(e.target.value)} placeholder="value" style={{ width: 90 }} />
              {opDef.operands === 2 && (
                <>
                  <span>and</span>
                  <input value={op2} onChange={(e) => setOp2(e.target.value)} placeholder="value" style={{ width: 90 }} />
                </>
              )}
            </div>
          )}
          {ruleType === 'topBottom' && (
            <div className="dialog-row" style={{ gap: 8 }}>
              <select value={tbMode} onChange={(e) => setTbMode(e.target.value as 'top' | 'bottom' | 'above')}>
                <option value="top">Top</option>
                <option value="bottom">Bottom</option>
                <option value="above">Above average</option>
              </select>
              {tbMode !== 'above' && (
                <input
                  type="number"
                  min={1}
                  value={nText}
                  onChange={(e) => setNText(e.target.value)}
                  style={{ width: 70 }}
                  aria-label="N"
                />
              )}
              <span>values in the range</span>
            </div>
          )}
          {ruleType === 'formula' && (
            <label className="dialog-row" style={{ flexDirection: 'column', alignItems: 'stretch' }}>
              <span style={{ marginBottom: 4 }}>
                Format values where this formula is true (relative to the top-left cell):
              </span>
              <input
                value={formula}
                onChange={(e) => setFormula(e.target.value)}
                placeholder="=A1>100"
                style={{ fontFamily: 'monospace' }}
              />
            </label>
          )}
          {ruleType === 'dataBar' && (
            <div className="dialog-row" style={{ gap: 6 }}>
              <span>Bar color:</span>
              {DATA_BAR_COLORS.map((c) => (
                <button
                  key={c}
                  type="button"
                  onClick={() => setBarColor(c)}
                  title={c}
                  style={{
                    width: 28,
                    height: 18,
                    background: c,
                    border: barColor === c ? '2px solid #000' : '1px solid #999',
                    cursor: 'pointer',
                  }}
                />
              ))}
            </div>
          )}
          {ruleType === 'colorScale' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              {COLOR_SCALE_PRESETS.map((p, i) => (
                <label key={p.name} style={{ cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 8 }}>
                  <input type="radio" name="cf-scale" checked={scaleIdx === i} onChange={() => setScaleIdx(i)} />
                  <span
                    style={{
                      display: 'inline-block',
                      width: 96,
                      height: 14,
                      background: `linear-gradient(to right, ${p.low}, ${p.high})`,
                      border: '1px solid #ccc',
                    }}
                  />
                  {p.name}
                </label>
              ))}
            </div>
          )}
          {ruleType === 'iconSet' && (
            <div className="dialog-row">
              <span style={{ fontSize: 20 }} aria-hidden>
                <span style={{ color: '#2e7d32' }}>▲</span>{' '}
                <span style={{ color: '#c8a415' }}>►</span>{' '}
                <span style={{ color: '#c62828' }}>▼</span>
              </span>
              <span style={{ marginLeft: 8 }}>3 Arrows — thirds of the value range</span>
            </div>
          )}
        </div>

        {(ruleType === 'cellValue' || ruleType === 'topBottom' || ruleType === 'formula') && (
          <label className="dialog-row">
            <span>Fill color:</span>
            <select value={color} onChange={(e) => setColor(e.target.value)} style={{ marginLeft: 8 }}>
              {FORMAT_COLORS.map((c) => (
                <option key={c.value} value={c.value}>{c.name}</option>
              ))}
            </select>
            <span
              style={{
                display: 'inline-block',
                width: 40,
                height: 16,
                background: color,
                border: '1px solid #999',
                marginLeft: 8,
              }}
            />
          </label>
        )}

        <div className="dialog-actions">
          <button onClick={submit} disabled={!valid}>
            {editing ? 'Save Rule' : 'Add Rule'}
          </button>
          <button onClick={onClose}>Cancel</button>
        </div>
      </A11yDialog>
  );
}

// ---------------------------------------------------------------------------
// Manage Rules…
// ---------------------------------------------------------------------------

export interface RuleListItem {
  key: string;
  description: string;
  range: string;
  isCell: boolean;
  id: number;
}

export interface CFManageRulesDialogProps {
  sheet: string;
  /** Rules already filtered to the requested scope by the parent. */
  cellRules: CFRule[];
  extRules: ExtCFRule[];
  scope: 'selection' | 'sheet';
  onScopeChange: (scope: 'selection' | 'sheet') => void;
  selectionLabel: string;
  onDeleteCellRule: (id: number) => void;
  onDeleteExtRule: (id: number) => void;
  onMoveCellRule: (id: number, dir: -1 | 1) => void;
  onMoveExtRule: (id: number, dir: -1 | 1) => void;
  onEditCellRule: (rule: CFRule) => void;
  onEditExtRule: (rule: ExtCFRule) => void;
  onNewRule: () => void;
  onClose: () => void;
}

function rangeLabel(r: { startRow: number; startCol: number; endRow: number; endCol: number }): string {
  const col = (c: number): string => {
    let label = '';
    let n = c;
    do {
      label = String.fromCharCode(65 + (n % 26)) + label;
      n = Math.floor(n / 26) - 1;
    } while (n >= 0);
    return label;
  };
  const tl = `${col(r.startCol)}${r.startRow + 1}`;
  const br = `${col(r.endCol)}${r.endRow + 1}`;
  return tl === br ? `$${tl}` : `$${tl}:$${br}`;
}

/**
 * Merge both rule lists into display order. Evaluation priority follows
 * array order: cell rules first (in their order), then extended rules.
 */
export function mergeRuleLists(cellRules: CFRule[], extRules: ExtCFRule[]): RuleListItem[] {
  return [
    ...cellRules.map((r) => ({
      key: `cell-${r.id}`,
      description: describeCFRule(r),
      range: rangeLabel(r),
      isCell: true,
      id: r.id,
    })),
    ...extRules.map((r) => ({
      key: `ext-${r.id}`,
      description: describeExtCFRule(r),
      range: rangeLabel(r),
      isCell: false,
      id: r.id,
    })),
  ];
}

export function CFManageRulesDialog({
  sheet,
  cellRules,
  extRules,
  scope,
  onScopeChange,
  selectionLabel,
  onDeleteCellRule,
  onDeleteExtRule,
  onMoveCellRule,
  onMoveExtRule,
  onEditCellRule,
  onEditExtRule,
  onNewRule,
  onClose,
}: CFManageRulesDialogProps) {
  const items = mergeRuleLists(cellRules, extRules);
  const findCell = (id: number) => cellRules.find((r) => r.id === id);
  const findExt = (id: number) => extRules.find((r) => r.id === id);

  return (
    <A11yDialog title={<>Conditional Formatting Rules Manager</>} width={560} onClose={onClose}>
        <label className="dialog-row">
          <span>Show formatting rules for:</span>
          <select
            value={scope}
            onChange={(e) => onScopeChange(e.target.value as 'selection' | 'sheet')}
            style={{ marginLeft: 8 }}
          >
            <option value="selection">Current Selection ({selectionLabel})</option>
            <option value="sheet">This Worksheet ({sheet})</option>
          </select>
        </label>

        <div style={{ border: '1px solid #ccc', maxHeight: 260, overflowY: 'auto', marginBottom: 8 }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
            <thead>
              <tr style={{ background: '#f0f0f0', textAlign: 'left' }}>
                <th style={{ padding: '6px 8px' }}>Rule (in evaluation order)</th>
                <th style={{ padding: '6px 8px' }}>Applies to</th>
                <th style={{ padding: '6px 8px' }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr key={item.key} style={{ borderTop: '1px solid #eee' }}>
                  <td style={{ padding: '6px 8px' }}>{item.description}</td>
                  <td style={{ padding: '6px 8px', fontFamily: 'monospace' }}>{item.range}</td>
                  <td style={{ padding: '6px 8px', whiteSpace: 'nowrap' }}>
                    <button
                      type="button"
                      title="Edit rule"
                      onClick={() => {
                        const r = item.isCell ? findCell(item.id) : findExt(item.id);
                        if (!r) return;
                        if (item.isCell) onEditCellRule(r as CFRule);
                        else onEditExtRule(r as ExtCFRule);
                      }}
                      style={{ marginRight: 4 }}
                    >
                      Edit…
                    </button>
                    <button
                      type="button"
                      title="Delete rule"
                      onClick={() => (item.isCell ? onDeleteCellRule(item.id) : onDeleteExtRule(item.id))}
                      style={{ marginRight: 4 }}
                    >
                      Delete
                    </button>
                    <button
                      type="button"
                      title="Move up (higher priority)"
                      onClick={() => (item.isCell ? onMoveCellRule(item.id, -1) : onMoveExtRule(item.id, -1))}
                      style={{ marginRight: 4 }}
                    >
                      ↑
                    </button>
                    <button
                      type="button"
                      title="Move down (lower priority)"
                      onClick={() => (item.isCell ? onMoveCellRule(item.id, 1) : onMoveExtRule(item.id, 1))}
                    >
                      ↓
                    </button>
                  </td>
                </tr>
              ))}
              {items.length === 0 && (
                <tr>
                  <td colSpan={3} style={{ padding: 16, textAlign: 'center', color: '#888' }}>
                    No conditional formatting rules here yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        <div className="dialog-hint">
          Rules are evaluated top-down; the first matching rule wins.
        </div>

        <div className="dialog-actions">
          <button onClick={onNewRule}>New Rule…</button>
          <button onClick={onClose}>Close</button>
        </div>
      </A11yDialog>
  );
}
