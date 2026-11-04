/**
 * Settings & profile dialog.
 *
 * Per-user preferences (platform-shell.md §4): theme, formula language
 * (wired to localization), calculation mode, and grid defaults. Saved to
 * the per-user profile store (localStorage in local mode) — never into
 * workbook bytes.
 */
import { useEffect, useState } from 'react';
import { SUPPORTED_LOCALES, type SupportedLocale, type CalculationMode } from '@icecream-sheets/engine';
import { DEFAULT_SETTINGS, type ThemeChoice, type UserSettings } from '../settings';
import A11yDialog from './A11yDialog';

interface SettingsDialogProps {
  settings: UserSettings;
  onSave: (settings: UserSettings) => void;
  onClose: () => void;
}

const CALC_MODES: { id: CalculationMode; label: string; hint: string }[] = [
  { id: 'automatic', label: 'Automatic', hint: 'Recalculate on every change' },
  { id: 'manual', label: 'Manual', hint: 'Recalculate only on demand' },
];

export default function SettingsDialog({ settings, onSave, onClose }: SettingsDialogProps) {
  const [draft, setDraft] = useState<UserSettings>({ ...settings });
  const set = <K extends keyof UserSettings>(key: K, value: UserSettings[K]) =>
    setDraft((d) => ({ ...d, [key]: value }));

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const row: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 };
  const labelStyle: React.CSSProperties = { fontSize: 13, minWidth: 150 };

  return (
    <A11yDialog title={<>Settings</>} width={520} onClose={onClose}>
        <p style={{ fontSize: 12, color: '#64748b', marginTop: -8, marginBottom: 16 }}>
          Per-user preferences — stored in your profile, never in workbook bytes.
        </p>

        <h3 style={{ fontSize: 12, textTransform: 'uppercase', color: '#64748b', margin: '0 0 8px' }}>
          Appearance
        </h3>
        <div style={row}>
          <label style={labelStyle} htmlFor="set-theme">
            Theme
          </label>
          <select
            id="set-theme"
            value={draft.theme}
            onChange={(e) => set('theme', e.target.value as ThemeChoice)}
            style={{ fontSize: 13, padding: '4px 6px' }}
          >
            <option value="light">Light</option>
            <option value="dark">Dark</option>
            <option value="system">System</option>
          </select>
        </div>

        <h3 style={{ fontSize: 12, textTransform: 'uppercase', color: '#64748b', margin: '16px 0 8px' }}>
          Formulas
        </h3>
        <div style={row}>
          <label style={labelStyle} htmlFor="set-lang">
            Formula language
          </label>
          <select
            id="set-lang"
            value={draft.formulaLanguage}
            onChange={(e) => set('formulaLanguage', e.target.value as SupportedLocale)}
            title="Function names render and parse in this locale"
            style={{ fontSize: 13, padding: '4px 6px' }}
          >
            {SUPPORTED_LOCALES.map((l) => (
              <option key={l.id} value={l.id}>
                {l.label}
              </option>
            ))}
          </select>
        </div>
        <div style={row}>
          <label style={labelStyle} htmlFor="set-calc">
            Calculation mode
          </label>
          <select
            id="set-calc"
            value={draft.calculationMode}
            onChange={(e) => set('calculationMode', e.target.value as CalculationMode)}
            style={{ fontSize: 13, padding: '4px 6px' }}
          >
            {CALC_MODES.map((m) => (
              <option key={m.id} value={m.id} title={m.hint}>
                {m.label}
              </option>
            ))}
          </select>
        </div>
        <div style={row}>
          <label style={labelStyle} htmlFor="set-mt-threshold">
            Multithreading threshold (cells)
          </label>
          <input
            id="set-mt-threshold"
            type="number"
            min={1}
            step={100}
            value={draft.mtCellCountThreshold}
            onChange={(e) => {
              const n = Math.floor(Number(e.target.value));
              if (Number.isFinite(n) && n >= 1) set('mtCellCountThreshold', n);
            }}
            style={{ fontSize: 13, padding: '4px 6px', width: 110 }}
          />
        </div>
        <p style={{ fontSize: 12, color: '#64748b', margin: '-4px 0 12px' }}>
          One flag, two consequences: workbooks with more cells than this keep no local copy —
          every edit calculates on the server, which may use multiple threads. At or below it, a
          full local mirror is kept and short calculations run locally. The
          ICECREAM_MT_CELL_COUNT_THRESHOLD environment variable overrides this field when set.
        </p>

        <h3 style={{ fontSize: 12, textTransform: 'uppercase', color: '#64748b', margin: '16px 0 8px' }}>
          Grid
        </h3>
        <div style={row}>
          <label style={labelStyle} htmlFor="set-zoom">
            Default zoom
          </label>
          <select
            id="set-zoom"
            value={String(draft.defaultZoom)}
            onChange={(e) => set('defaultZoom', Number(e.target.value))}
            style={{ fontSize: 13, padding: '4px 6px' }}
          >
            {[0.5, 0.75, 1, 1.25, 1.5, 2].map((z) => (
              <option key={z} value={String(z)}>
                {Math.round(z * 100)}%
              </option>
            ))}
          </select>
        </div>
        <div style={row}>
          <input
            id="set-gridlines"
            type="checkbox"
            checked={draft.showGridlines}
            onChange={(e) => set('showGridlines', e.target.checked)}
          />
          <label style={labelStyle} htmlFor="set-gridlines">
            Show gridlines
          </label>
        </div>
        <div style={row}>
          <input
            id="set-formulabar"
            type="checkbox"
            checked={draft.showFormulaBar}
            onChange={(e) => set('showFormulaBar', e.target.checked)}
          />
          <label style={labelStyle} htmlFor="set-formulabar">
            Show formula bar
          </label>
        </div>

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 20 }}>
          <button type="button" onClick={() => setDraft({ ...DEFAULT_SETTINGS })}>
            Reset to defaults
          </button>
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            onClick={() => {
              onSave(draft);
              onClose();
            }}
            style={{ fontWeight: 600 }}
          >
            Save
          </button>
        </div>
      </A11yDialog>
  );
}
