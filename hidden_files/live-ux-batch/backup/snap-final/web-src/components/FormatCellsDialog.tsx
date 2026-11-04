/**
 * Format Cells dialog — Excel parity.
 * Tabbed dialog: Number, Alignment, Font, Border, Fill.
 * Applies directly to the selected cell's format via onFormat callbacks.
 */
import { useState } from 'react';
import {
  FONT_NAMES,
  FONT_SIZES,
  NUMBER_FORMATS,
  BORDER_PRESETS,
  THEME_COLORS,
  type CellFormat,
  type NumberFormat,
} from '../features/formatting';
import A11yDialog from './A11yDialog';

interface FormatCellsDialogProps {
  cellLabel: string;
  format: CellFormat | undefined;
  onClose: () => void;
  onFormat: (update: Partial<CellFormat>) => void;
  onClearFormat: () => void;
}

type TabId = 'Number' | 'Alignment' | 'Font' | 'Border' | 'Fill';

const TABS: TabId[] = ['Number', 'Alignment', 'Font', 'Border', 'Fill'];

export default function FormatCellsDialog({ cellLabel, format: fmt, onClose, onFormat, onClearFormat }: FormatCellsDialogProps) {
  const [tab, setTab] = useState<TabId>('Number');
  const f: CellFormat = fmt ?? {};

  return (
    <A11yDialog title={<>Format Cells — {cellLabel}</>} width={420} onClose={onClose}>
        <div className="dialog-tabs" role="tablist">
          {TABS.map((t) => (
            <button
              key={t}
              type="button"
              role="tab"
              aria-selected={tab === t}
              className={tab === t ? 'dialog-tab active' : 'dialog-tab'}
              onClick={() => setTab(t)}
            >
              {t}
            </button>
          ))}
        </div>

        <div className="dialog-tabpanel" role="tabpanel">
          {tab === 'Number' && (
            <>
              <label className="dialog-row">
                <span>Category:</span>
                <select
                  value={f.numberFormat ?? 'General'}
                  onChange={(e) => onFormat({ numberFormat: e.target.value as NumberFormat })}
                >
                  {NUMBER_FORMATS.map((n) => (
                    <option key={n} value={n}>{n}</option>
                  ))}
                </select>
              </label>
              <p className="dialog-hint">Number formats control how values display. General shows values as entered.</p>
            </>
          )}

          {tab === 'Alignment' && (
            <>
              <div className="dialog-row">
                <span>Horizontal:</span>
                <div className="dialog-btnrow">
                  {(['left', 'center', 'right'] as const).map((a) => (
                    <button
                      key={a}
                      type="button"
                      className={f.hAlign === a ? 'ribbon-btn small active' : 'ribbon-btn small'}
                      onClick={() => onFormat({ hAlign: a })}
                    >
                      {a}
                    </button>
                  ))}
                </div>
              </div>
              <div className="dialog-row">
                <span>Vertical:</span>
                <div className="dialog-btnrow">
                  {(['top', 'middle', 'bottom'] as const).map((a) => (
                    <button
                      key={a}
                      type="button"
                      className={f.vAlign === a ? 'ribbon-btn small active' : 'ribbon-btn small'}
                      onClick={() => onFormat({ vAlign: a })}
                    >
                      {a}
                    </button>
                  ))}
                </div>
              </div>
              <label className="dialog-row">
                <span>Wrap text:</span>
                <input
                  type="checkbox"
                  checked={!!f.wrapText}
                  onChange={(e) => onFormat({ wrapText: e.target.checked })}
                />
              </label>
              <label className="dialog-row">
                <span>Indent:</span>
                <input
                  type="number"
                  min={0}
                  max={6}
                  value={f.indent ?? 0}
                  onChange={(e) => onFormat({ indent: Math.max(0, Math.min(6, Number(e.target.value))) })}
                  style={{ width: 60 }}
                />
              </label>
            </>
          )}

          {tab === 'Font' && (
            <>
              <label className="dialog-row">
                <span>Font:</span>
                <select value={f.fontName ?? 'Calibri'} onChange={(e) => onFormat({ fontName: e.target.value })}>
                  {FONT_NAMES.map((n) => (
                    <option key={n} value={n}>{n}</option>
                  ))}
                </select>
              </label>
              <label className="dialog-row">
                <span>Size:</span>
                <select
                  value={String(f.fontSize ?? 11)}
                  onChange={(e) => onFormat({ fontSize: Number(e.target.value) })}
                >
                  {FONT_SIZES.map((s) => (
                    <option key={s} value={s}>{s}</option>
                  ))}
                </select>
              </label>
              <div className="dialog-row">
                <span>Style:</span>
                <div className="dialog-btnrow">
                  <button
                    type="button"
                    className={f.bold ? 'ribbon-btn small active' : 'ribbon-btn small'}
                    onClick={() => onFormat({ bold: !f.bold })}
                  >Bold</button>
                  <button
                    type="button"
                    className={f.italic ? 'ribbon-btn small active' : 'ribbon-btn small'}
                    onClick={() => onFormat({ italic: !f.italic })}
                  >Italic</button>
                  <button
                    type="button"
                    className={f.underline ? 'ribbon-btn small active' : 'ribbon-btn small'}
                    onClick={() => onFormat({ underline: !f.underline })}
                  >Underline</button>
                  <button
                    type="button"
                    className={f.strikethrough ? 'ribbon-btn small active' : 'ribbon-btn small'}
                    onClick={() => onFormat({ strikethrough: !f.strikethrough })}
                  >Strike</button>
                </div>
              </div>
              <div className="dialog-row">
                <span>Color:</span>
                <div className="dialog-swatches">
                  {THEME_COLORS.slice(0, 16).map((c) => (
                    <button
                      key={c}
                      type="button"
                      className={f.fontColor === c ? 'dialog-swatch active' : 'dialog-swatch'}
                      style={{ backgroundColor: c }}
                      title={c}
                      onClick={() => onFormat({ fontColor: c })}
                    />
                  ))}
                </div>
              </div>
            </>
          )}

          {tab === 'Border' && (
            <>
              <div className="dialog-row">
                <span>Presets:</span>
                <div className="dialog-btnrow" style={{ flexWrap: 'wrap' }}>
                  {BORDER_PRESETS.map((p) => (
                    <button
                      key={p.name}
                      type="button"
                      className="ribbon-btn small"
                      onClick={() => onFormat({ borders: p.apply })}
                      title={p.name}
                    >
                      {p.name}
                    </button>
                  ))}
                </div>
              </div>
              <p className="dialog-hint">Pick a preset, or use the Borders menu on the Home tab for color and line style.</p>
            </>
          )}

          {tab === 'Fill' && (
            <>
              <div className="dialog-row">
                <span>Background:</span>
                <div className="dialog-swatches">
                  {THEME_COLORS.map((c) => (
                    <button
                      key={c}
                      type="button"
                      className={f.fillColor === c ? 'dialog-swatch active' : 'dialog-swatch'}
                      style={{ backgroundColor: c }}
                      title={c}
                      onClick={() => onFormat({ fillColor: c })}
                    />
                  ))}
                  <button
                    type="button"
                    className={!f.fillColor ? 'dialog-swatch active' : 'dialog-swatch'}
                    title="No fill"
                    onClick={() => onFormat({ fillColor: undefined })}
                    style={{ background: 'linear-gradient(45deg, #fff 45%, #f00 45%, #f00 55%, #fff 55%)' }}
                  />
                </div>
              </div>
            </>
          )}
        </div>

        <div className="dialog-actions">
          <button type="button" onClick={onClearFormat}>Clear All</button>
          <button type="button" onClick={onClose}>Done</button>
        </div>
    </A11yDialog>
  );
}
