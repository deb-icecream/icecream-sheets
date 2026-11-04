/**
 * AI Agent settings dialog (design-docs/ai-agent.md §§6, 8).
 *
 * Standalone: opened from the AgentChat header, never from App.tsx.
 * Two sections:
 *
 * - Model backend (§8): the product ships a default model; the user can
 *   point the agent at another provider with their own key. The key is
 *   write-only — it goes to the service credential vault and the UI only
 *   ever learns whether one is stored.
 * - Proactive notifications (§6): the whole-thing mute toggle plus
 *   per-category mutes (per user, persisted server-side).
 *
 * Everything goes through the AgentChatBackend's optional config/mute
 * methods; backends that don't implement them show a "not available"
 * note instead of the controls.
 */
import { useEffect, useState } from 'react';
import type { AgentChatBackend, AgentModelConfigView } from '../services/remoteAgent';
import A11yDialog from './A11yDialog';

interface AgentSettingsDialogProps {
  runtime: AgentChatBackend;
  onClose: () => void;
}

const CUSTOM_PROVIDER = {
  id: 'openai-compatible',
  label: 'OpenAI-compatible (custom)',
  hint: 'Any OpenAI chat-completions endpoint (OpenAI, Azure, Ollama, …) with your own key.',
};

const CATEGORIES: { id: string; label: string }[] = [
  { id: 'cells_changed', label: 'Cell changes' },
  { id: 'recalc_complete', label: 'Recalculation finished' },
  { id: 'sheet_added', label: 'Sheets added' },
  { id: 'sheet_removed', label: 'Sheets removed' },
];

const row: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 };
const labelStyle: React.CSSProperties = { fontSize: 13, minWidth: 150 };
const inputStyle: React.CSSProperties = { fontSize: 13, padding: '4px 6px', flex: 1, minWidth: 0 };
const hintStyle: React.CSSProperties = { fontSize: 12, color: '#64748b', margin: '-6px 0 12px 160px' };

export default function AgentSettingsDialog({ runtime, onClose }: AgentSettingsDialogProps) {
  const modelSupported = typeof runtime.getModelConfig === 'function';
  const muteSupported = typeof runtime.getProactiveMute === 'function';

  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [provider, setProvider] = useState('vertex');
  const [defaultBackend, setDefaultBackend] = useState<'vertex' | 'no-model' | undefined>(undefined);
  const [defaultModel, setDefaultModel] = useState<string | undefined>(undefined);
  const [baseUrl, setBaseUrl] = useState('');
  const [model, setModel] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [hasKey, setHasKey] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  const [mutedAll, setMutedAll] = useState(false);
  const [mutedCats, setMutedCats] = useState<Record<string, boolean>>({});
  const [muteError, setMuteError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [cfg, mute] = await Promise.all([
          modelSupported ? runtime.getModelConfig!() : Promise.resolve(null),
          muteSupported ? runtime.getProactiveMute!() : Promise.resolve(null),
        ]);
        if (cancelled) return;
        if (cfg) applyConfig(cfg);
        if (mute) {
          setMutedAll(mute.mutedAll);
          setMutedCats({ ...mute.muted });
        }
      } catch (e) {
        if (!cancelled) setLoadError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function applyConfig(cfg: AgentModelConfigView) {
    setProvider(cfg.provider);
    setDefaultBackend(cfg.defaultBackend);
    setDefaultModel(cfg.defaultModel);
    setBaseUrl(cfg.baseUrl ?? '');
    setModel(cfg.model ?? '');
    setHasKey(cfg.hasKey);
    setApiKey('');
  }

  // The stored default ('vertex') means "the product's default model":
  // on a hosted deployment that is Gemini on Vertex AI served by the app
  // itself (the config view reports it as defaultBackend 'vertex'); a
  // service with no model at all reports 'no-model', and the label must
  // say so honestly — turns fail with a clear error until a model is
  // configured (#32, #137: there is no fallback planner anymore).
  const providers = [
    defaultBackend === 'vertex'
      ? {
          id: 'vertex',
          label: 'Default model (Vertex AI)',
          hint: `Gemini on Vertex AI${defaultModel ? ` (${defaultModel})` : ''} — served by the app, ready to use, no setup needed.`,
        }
      : {
          id: 'vertex',
          label: 'Default model (no model available here)',
          hint: 'No model is configured on this service — the agent will return a clear error until a model is set up.',
        },
    CUSTOM_PROVIDER,
  ];

  async function saveModel() {
    setSaving(true);
    setSaveError(null);
    setSavedAt(null);
    try {
      const cfg = await runtime.setModelConfig!({
        provider,
        ...(provider === 'openai-compatible'
          ? {
              baseUrl: baseUrl.trim() || undefined,
              model: model.trim() || undefined,
            }
          : {}),
        // Empty key field leaves the stored key untouched; the Remove
        // button below revokes it explicitly.
        ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
      });
      applyConfig(cfg);
      setSavedAt(Date.now());
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  async function removeKey() {
    setSaving(true);
    setSaveError(null);
    try {
      const cfg = await runtime.setModelConfig!({ provider, apiKey: null });
      applyConfig(cfg);
      setSavedAt(Date.now());
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  async function patchMute(patch: { mutedAll?: boolean; muted?: Record<string, boolean> }) {
    setMuteError(null);
    try {
      const next = await runtime.setProactiveMute!(patch);
      setMutedAll(next.mutedAll);
      setMutedCats({ ...next.muted });
    } catch (e) {
      setMuteError(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <A11yDialog title={<>AI Agent settings</>} width={560} onClose={onClose}>
      {loading && <p style={{ fontSize: 13 }}>Loading…</p>}
      {loadError && <p style={{ fontSize: 13, color: '#b91c1c' }}>Couldn’t load settings: {loadError}</p>}
      {!loading && !loadError && (
        <>
          <h3 style={{ fontSize: 12, textTransform: 'uppercase', color: '#64748b', margin: '0 0 8px' }}>
            Model backend
          </h3>
          {!modelSupported && (
            <p style={{ fontSize: 13, color: '#64748b' }}>
              Model selection isn’t available with this backend.
            </p>
          )}
          {modelSupported && (
            <>
              <div style={row}>
                <label style={labelStyle} htmlFor="agent-provider">
                  Provider
                </label>
                <select
                  id="agent-provider"
                  value={provider}
                  onChange={(e) => setProvider(e.target.value)}
                  style={{ fontSize: 13, padding: '4px 6px', flex: 1 }}
                >
                  {providers.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.label}
                    </option>
                  ))}
                </select>
              </div>
              <p style={hintStyle}>
                {providers.find((p) => p.id === provider)?.hint}
              </p>
              {provider === 'openai-compatible' && (
                <>
                  <div style={row}>
                    <label style={labelStyle} htmlFor="agent-baseurl">
                      Base URL
                    </label>
                    <input
                      id="agent-baseurl"
                      style={inputStyle}
                      value={baseUrl}
                      onChange={(e) => setBaseUrl(e.target.value)}
                      placeholder="https://api.openai.com/v1"
                      autoComplete="off"
                      spellCheck={false}
                    />
                  </div>
                  <div style={row}>
                    <label style={labelStyle} htmlFor="agent-model">
                      Model
                    </label>
                    <input
                      id="agent-model"
                      style={inputStyle}
                      value={model}
                      onChange={(e) => setModel(e.target.value)}
                      placeholder="gpt-4o-mini"
                      autoComplete="off"
                      spellCheck={false}
                    />
                  </div>
                  <div style={row}>
                    <label style={labelStyle} htmlFor="agent-apikey">
                      API key
                    </label>
                    <input
                      id="agent-apikey"
                      type="password"
                      style={inputStyle}
                      value={apiKey}
                      onChange={(e) => setApiKey(e.target.value)}
                      placeholder={hasKey ? '•••••••• (a key is stored)' : 'paste your key'}
                      autoComplete="off"
                      spellCheck={false}
                    />
                  </div>
                  <p style={hintStyle}>
                    Stored in the service credential vault — never shown again, never logged.
                    {hasKey && ' Leave blank to keep the stored key.'}
                  </p>
                </>
              )}
              {saveError && <p style={{ fontSize: 13, color: '#b91c1c' }}>{saveError}</p>}
              {savedAt && <p style={{ fontSize: 13, color: '#15803d' }}>Saved.</p>}
              <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
                <button type="button" onClick={saveModel} disabled={saving} style={{ fontSize: 13, padding: '6px 12px' }}>
                  {saving ? 'Saving…' : 'Save model backend'}
                </button>
                {provider === 'openai-compatible' && hasKey && (
                  <button
                    type="button"
                    onClick={removeKey}
                    disabled={saving}
                    style={{ fontSize: 13, padding: '6px 12px' }}
                  >
                    Remove stored key
                  </button>
                )}
              </div>
            </>
          )}

          <h3 style={{ fontSize: 12, textTransform: 'uppercase', color: '#64748b', margin: '16px 0 8px' }}>
            Proactive notifications
          </h3>
          {!muteSupported && (
            <p style={{ fontSize: 13, color: '#64748b' }}>
              Proactive mute isn’t available with this backend.
            </p>
          )}
          {muteSupported && (
            <>
              <div style={row}>
                <label style={labelStyle} htmlFor="agent-mute-all">
                  Mute everything
                </label>
                <input
                  id="agent-mute-all"
                  type="checkbox"
                  checked={mutedAll}
                  onChange={(e) => {
                    const next = e.target.checked;
                    setMutedAll(next);
                    void patchMute({ mutedAll: next });
                  }}
                />
              </div>
              {!mutedAll &&
                CATEGORIES.map((c) => (
                  <div style={row} key={c.id}>
                    <label style={labelStyle} htmlFor={`agent-mute-${c.id}`}>
                      {c.label}
                    </label>
                    <input
                      id={`agent-mute-${c.id}`}
                      type="checkbox"
                      checked={!!mutedCats[c.id]}
                      onChange={(e) => {
                        const next = { ...mutedCats, [c.id]: e.target.checked };
                        setMutedCats(next);
                        void patchMute({ muted: next });
                      }}
                    />
                  </div>
                ))}
              {muteError && <p style={{ fontSize: 13, color: '#b91c1c' }}>{muteError}</p>}
              <p style={{ fontSize: 12, color: '#64748b' }}>
                Mutes are per user and persist — muted categories never wake the agent.
              </p>
            </>
          )}
        </>
      )}
    </A11yDialog>
  );
}
