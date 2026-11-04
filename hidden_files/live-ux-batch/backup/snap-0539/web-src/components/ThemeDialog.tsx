/**
 * ThemeDialog: Page Layout > Themes gallery with Colors / Fonts / Effects.
 *
 * Pick a built-in theme or customize the active one: edit any of the 12
 * theme colors, swap the heading/body font pair, or change the effect
 * style. Apply hands the finished WorkbookTheme to the parent, which
 * persists it in workbook metadata (`icecream.theme`) and re-renders
 * cell styles / chart palettes from it.
 */
import { useState } from 'react';
import {
  BUILT_IN_THEMES,
  customizeTheme,
  type WorkbookTheme,
} from '../features/themes';
import A11yDialog from './A11yDialog';

export interface ThemeDialogProps {
  current: WorkbookTheme;
  onApply: (theme: WorkbookTheme) => void;
  onClose: () => void;
}

type Tab = 'themes' | 'colors' | 'fonts' | 'effects';

const FONT_CHOICES = [
  'Calibri',
  'Calibri Light',
  'Arial',
  'Trebuchet MS',
  'Garamond',
  'Century Gothic',
  'Georgia',
  'Verdana',
  'Inter',
  'Segoe UI',
];

export default function ThemeDialog({ current, onApply, onClose }: ThemeDialogProps) {
  const [tab, setTab] = useState<Tab>('themes');
  const [draft, setDraft] = useState<WorkbookTheme>(current);

  const pickTheme = (t: WorkbookTheme) => {
    setDraft(t);
    onApply(t);
  };

  const setColor = (index: number, value: string) => {
    const colors = [...draft.colors.colors];
    colors[index] = value;
    setDraft({ ...draft, colors: { ...draft.colors, colors, name: `${draft.colors.name} (custom)` } });
  };

  const applyCustom = () => {
    onApply(customizeTheme(draft, { name: `${draft.name} (custom)` }));
    onClose();
  };

  const colorLabels = [
    'Dark 1', 'Light 1', 'Dark 2', 'Light 2',
    'Accent 1', 'Accent 2', 'Accent 3', 'Accent 4', 'Accent 5', 'Accent 6',
    'Hyperlink', 'Followed link',
  ];

  return (
    <A11yDialog title={<>Themes</>} width={680} onClose={onClose}>
        <div style={{ display: 'flex', gap: 4, padding: '8px 14px 0', borderBottom: '1px solid #eee' }}>
          {(['themes', 'colors', 'fonts', 'effects'] as Tab[]).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              style={{
                padding: '6px 12px',
                border: 'none',
                borderBottom: tab === t ? '2px solid #0b57d0' : '2px solid transparent',
                background: 'none',
                cursor: 'pointer',
                fontWeight: tab === t ? 700 : 400,
                textTransform: 'capitalize',
              }}
            >
              {t}
            </button>
          ))}
        </div>
        <div style={{ padding: 14, overflowY: 'auto', fontSize: 13 }}>
          {tab === 'themes' && (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))', gap: 10 }}>
              {BUILT_IN_THEMES.map((t) => (
                <button
                  key={t.name}
                  onClick={() => pickTheme(t)}
                  title={`Apply the ${t.name} theme`}
                  style={{
                    border: draft.name === t.name ? '2px solid #0b57d0' : '1px solid #ccc',
                    borderRadius: 6,
                    padding: 8,
                    background: '#fff',
                    cursor: 'pointer',
                    textAlign: 'left',
                  }}
                >
                  <div style={{ display: 'flex', gap: 2, marginBottom: 6 }}>
                    {t.colors.colors.slice(4, 10).map((c, i) => (
                      <span key={i} style={{ width: 16, height: 16, background: c, border: '1px solid #999' }} />
                    ))}
                  </div>
                  <div style={{ fontWeight: 600 }}>{t.name}</div>
                  <div style={{ color: '#666', fontSize: 11 }}>{t.fonts.body}</div>
                </button>
              ))}
            </div>
          )}
          {tab === 'colors' && (
            <>
              <p style={{ color: '#666', marginTop: 0 }}>
                Editing colors customizes <strong>{draft.colors.name}</strong>. Apply to save.
              </p>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: 8 }}>
                {draft.colors.colors.map((c, i) => (
                  <label key={i} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <input type="color" value={c} onChange={(e) => setColor(i, e.target.value)} style={{ width: 34, height: 24, padding: 0, border: '1px solid #999' }} />
                    <span>{colorLabels[i]}</span>
                  </label>
                ))}
              </div>
              <div style={{ marginTop: 12 }}>
                <button onClick={applyCustom} title="Save the customized colors as a new theme">Apply customized colors</button>
              </div>
            </>
          )}
          {tab === 'fonts' && (
            <>
              <label style={{ display: 'block', marginBottom: 10 }}>
                Heading font{' '}
                <select
                  value={draft.fonts.heading}
                  onChange={(e) => setDraft({ ...draft, fonts: { ...draft.fonts, heading: e.target.value, name: `${draft.fonts.name} (custom)` } })}
                >
                  {FONT_CHOICES.map((f) => (
                    <option key={f} value={f}>{f}</option>
                  ))}
                </select>
              </label>
              <label style={{ display: 'block', marginBottom: 10 }}>
                Body font{' '}
                <select
                  value={draft.fonts.body}
                  onChange={(e) => setDraft({ ...draft, fonts: { ...draft.fonts, body: e.target.value, name: `${draft.fonts.name} (custom)` } })}
                >
                  {FONT_CHOICES.map((f) => (
                    <option key={f} value={f}>{f}</option>
                  ))}
                </select>
              </label>
              <p style={{ color: '#666' }}>
                Sample heading: <span style={{ fontFamily: draft.fonts.heading, fontSize: 18 }}>Sales Report Q3</span>
                <br />
                Sample body: <span style={{ fontFamily: draft.fonts.body }}>Revenue grew 12% quarter over quarter.</span>
              </p>
              <button onClick={applyCustom} title="Save the customized fonts as a new theme">Apply customized fonts</button>
            </>
          )}
          {tab === 'effects' && (
            <>
              <label style={{ display: 'block', marginBottom: 10 }}>
                Line style{' '}
                <select
                  value={draft.effects.lineStyle}
                  onChange={(e) =>
                    setDraft({ ...draft, effects: { ...draft.effects, lineStyle: e.target.value as WorkbookTheme['effects']['lineStyle'] } })
                  }
                >
                  <option value="subtle">Subtle</option>
                  <option value="moderate">Moderate</option>
                  <option value="intense">Intense</option>
                </select>
              </label>
              <label style={{ display: 'block', marginBottom: 10 }}>
                <input
                  type="checkbox"
                  checked={draft.effects.shadow}
                  onChange={(e) => setDraft({ ...draft, effects: { ...draft.effects, shadow: e.target.checked } })}
                />{' '}
                Drop shadows on shapes and chart elements
              </label>
              <button onClick={applyCustom} title="Save the customized effects as a new theme">Apply customized effects</button>
            </>
          )}
        </div>
        <div style={{ padding: '10px 14px', borderTop: '1px solid #ddd', display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <span style={{ marginRight: 'auto', color: '#666', alignSelf: 'center' }}>Current: {draft.name}</span>
          <button onClick={onClose}>Done</button>
        </div>
      </A11yDialog>
  );
}
