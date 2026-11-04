/**
 * Header & Footer dialog (Insert > Text > Header & Footer).
 *
 * Edits HeaderFooterSettings (features/headerFooter.ts): odd/even/first
 * page variants, each with left/center/right text plus one-click field
 * codes (&P page, &N pages, &D date, &T time, &F file, &A sheet). The
 * parent persists the settings (adapter metadata, like pictures) and
 * renders them in print layout via renderHFText().
 */
import { useState } from 'react';
import {
  defaultHeaderFooter,
  emptySection,
  renderHFSectionPreview,
  validateHeaderFooter,
  type HeaderFooterSettings,
  type HFSection,
} from '../features/headerFooter';
import A11yDialog from './A11yDialog';

export interface HeaderFooterDialogProps {
  initial: HeaderFooterSettings;
  onClose: () => void;
  onApply: (settings: HeaderFooterSettings) => void;
}

const FIELDS: { code: string; label: string }[] = [
  { code: '&P', label: 'Page Number' },
  { code: '&N', label: 'Total Pages' },
  { code: '&D', label: 'Date' },
  { code: '&T', label: 'Time' },
  { code: '&F', label: 'File Name' },
  { code: '&A', label: 'Sheet Name' },
];

type SectionKey = 'header' | 'footer' | 'evenHeader' | 'evenFooter' | 'firstHeader' | 'firstFooter';

function SectionEditor({
  title,
  section,
  onChange,
}: {
  title: string;
  section: HFSection;
  onChange: (s: HFSection) => void;
}) {
  const [target, setTarget] = useState<'left' | 'center' | 'right'>('center');

  const insertField = (code: string) => {
    onChange({ ...section, [target]: section[target] + code });
  };

  return (
    <fieldset style={{ border: '1px solid #ddd', padding: 8, marginBottom: 8 }}>
      <legend style={{ fontSize: 12, fontWeight: 600, padding: '0 4px' }}>{title}</legend>
      <div style={{ display: 'flex', gap: 4, marginBottom: 6, flexWrap: 'wrap' }}>
        {FIELDS.map((f) => (
          <button
            key={f.code}
            type="button"
            title={`Insert ${f.label} (${f.code})`}
            onClick={() => insertField(f.code)}
            style={{ fontSize: 11, padding: '2px 6px', cursor: 'pointer' }}
          >
            {f.label}
          </button>
        ))}
      </div>
      {(['left', 'center', 'right'] as const).map((pos) => (
        <label key={pos} style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4, fontSize: 12 }}>
          <span style={{ width: 52, textTransform: 'capitalize' }}>{pos}:</span>
          <input
            value={section[pos]}
            onChange={(e) => onChange({ ...section, [pos]: e.target.value })}
            onFocus={() => setTarget(pos)}
            style={{ flex: 1 }}
          />
        </label>
      ))}
    </fieldset>
  );
}

export function HeaderFooterDialog({ initial, onClose, onApply }: HeaderFooterDialogProps) {
  const [settings, setSettings] = useState<HeaderFooterSettings>(() => ({
    ...defaultHeaderFooter(),
    ...initial,
    header: { ...emptySection(), ...initial.header },
    footer: { ...emptySection(), ...initial.footer },
  }));

  const set = (key: SectionKey, section: HFSection) =>
    setSettings((prev) => ({ ...prev, [key]: section }));

  const submit = () => {
    onApply(settings);
    onClose();
  };

  // Sample context for the live code-expansion preview.
  const previewCtx = {
    page: 1,
    pages: 7,
    date: new Date(),
    fileName: 'Workbook.xlsx',
    sheetName: 'Sheet1',
  };

  return (
    <A11yDialog title={<>Header & Footer</>} width={560} onClose={onClose}>

        <label className="dialog-row" style={{ cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={settings.differentOddEven}
            onChange={(e) => setSettings((p) => ({ ...p, differentOddEven: e.target.checked }))}
            style={{ marginRight: 8 }}
          />
          Different odd & even pages
        </label>
        <label className="dialog-row" style={{ cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={settings.differentFirst}
            onChange={(e) => setSettings((p) => ({ ...p, differentFirst: e.target.checked }))}
            style={{ marginRight: 8 }}
          />
          Different first page
        </label>

        <SectionEditor title="Header (odd pages)" section={settings.header} onChange={(s) => set('header', s)} />
        <SectionEditor title="Footer (odd pages)" section={settings.footer} onChange={(s) => set('footer', s)} />

        {settings.differentOddEven && (
          <>
            <SectionEditor
              title="Header (even pages)"
              section={settings.evenHeader ?? emptySection()}
              onChange={(s) => set('evenHeader', s)}
            />
            <SectionEditor
              title="Footer (even pages)"
              section={settings.evenFooter ?? emptySection()}
              onChange={(s) => set('evenFooter', s)}
            />
          </>
        )}
        {settings.differentFirst && (
          <>
            <SectionEditor
              title="Header (first page)"
              section={settings.firstHeader ?? emptySection()}
              onChange={(s) => set('firstHeader', s)}
            />
            <SectionEditor
              title="Footer (first page)"
              section={settings.firstFooter ?? emptySection()}
              onChange={(s) => set('firstFooter', s)}
            />
          </>
        )}

        <div style={{ border: '1px dashed #cbd5e1', borderRadius: 4, padding: 8, marginBottom: 8, fontSize: 11, color: '#475569' }}>
          <div style={{ fontWeight: 600, marginBottom: 4 }}>Preview (codes expanded)</div>
          <div>Header: {renderHFSectionPreview(settings.header, previewCtx) || <em>—</em>}</div>
          <div>Footer: {renderHFSectionPreview(settings.footer, previewCtx) || <em>—</em>}</div>
        </div>

        <div className="dialog-actions">
          <button onClick={submit}>OK</button>
          <button onClick={onClose}>Cancel</button>
        </div>
      </A11yDialog>
  );
}

/**
 * Workbook-metadata channel for per-sheet header/footer settings.
 * The App owns the settings (RibbonParityContext.hfSettings); this module
 * provides the serialization so settings survive save/reopen through the
 * `icecream.headerfooter.<sheet>` custom property.
 */

/** Metadata key carrying one sheet's header/footer settings. */
export function headerFooterMetadataKey(sheet: string): string {
  return `icecream.headerfooter.${sheet}`;
}

/** Serialize settings for the metadata channel (plain JSON value). */
export function headerFooterToMetadata(settings: HeaderFooterSettings): unknown {
  return JSON.parse(JSON.stringify(settings)) as unknown;
}

/**
 * Restore settings from the metadata channel. Returns null for
 * missing/invalid metadata or an unsupported version — the caller falls
 * back to defaults rather than inventing settings.
 */
export function headerFooterFromMetadata(meta: unknown): HeaderFooterSettings | null {
  if (typeof meta !== 'object' || meta === null) return null;
  const candidate = meta as HeaderFooterSettings;
  if (validateHeaderFooter(candidate).length > 0) return null;
  return candidate;
}
