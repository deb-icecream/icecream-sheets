/**
 * Embedded artifact hosting surface (AI-GENERATED APP PATTERN spec).
 *
 * - ArtifactLibrary: the "Apps" tab inside the chat panel. Lists the
 *   persistent chat artifacts (service metadata store), creates new ones
 *   from a prompt (intent-routed: app / data-analysis handoff /
 *   disambiguation), and opens them in the chat's app-artifact panel.
 *   Re-openable across sessions because the store is localStorage-backed.
 * - ArtifactFrame: the embedded app renderer mounted in the chat's
 *   app-artifact panel body (AgentChat owns the side-by-side / fullscreen
 *   chrome). Renders one generated React app in a sandboxed iframe
 *   (sandbox="allow-scripts", opaque origin). The iframe NEVER touches the
 *   engine: it posts {tool, args} bridge messages to the host, the host
 *   executes them through the real MCP client (ArtifactBridgeHost), and
 *   posts results back. Two-way live binding: app writes go through
 *   write_cells/set_formulas in real time; sheet changes arrive via the MCP
 *   subscribe/poll_events protocol and the generated app re-renders.
 *
 * Embedded only: there is deliberately no export/deploy-as-standalone
 * path. The app lives and dies inside Icecream Sheets.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArtifactBridgeHost,
  generateAndSaveArtifact,
  isBridgeMessage,
  type AppTemplateKind,
  type ArtifactSpec,
  type McpCallFn,
  type MetadataStore,
} from '@icecream-sheets/service';
import { buildArtifactSrcDoc } from './artifactFrame';
import { AppsGallery } from '../product/AppsGallery';
// React UMD inlined into the iframe document so generated apps run
// offline (no CDN) and need no build step.
// NOTE (build fix): bare 'react/umd/...' specifiers are blocked by react's
// package exports map under vite's resolver; the relative path bypasses the
// exports map. Sibling owner: feel free to replace with a cleaner approach.
import reactUmd from '../../../../node_modules/react/umd/react.production.min.js?raw';
import reactDomUmd from '../../../../node_modules/react-dom/umd/react-dom.production.min.js?raw';

/* ------------------------------------------------------------------ */
/* ArtifactLibrary                                                     */
/* ------------------------------------------------------------------ */

interface ArtifactLibraryProps {
  store: MetadataStore<ArtifactSpec>;
  sheet: string;
  mcpCall: McpCallFn;
  onOpen: (id: string) => void;
}

type Notice = { kind: 'info' | 'error'; text: string } | null;

export function ArtifactLibrary({ store, sheet, mcpCall, onOpen }: ArtifactLibraryProps) {
  const [artifacts, setArtifacts] = useState<ArtifactSpec[]>(() => store.all());
  const [prompt, setPrompt] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const [disamb, setDisamb] = useState<{
    prompt: string;
    question: string;
    options: readonly string[];
    suggestedTemplate: AppTemplateKind;
  } | null>(null);

  const refresh = (): void => setArtifacts(store.all());

  const runGenerate = async (text: string, template?: AppTemplateKind): Promise<void> => {
    const trimmed = text.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    setNotice(null);
    setDisamb(null);
    try {
      const result = await generateAndSaveArtifact(
        { prompt: trimmed, sheet },
        { callTool: mcpCall, store, principal: 'web-user', template },
      );
      if (result.routed === 'app') {
        setPrompt('');
        refresh();
        onOpen(result.spec.id);
      } else if (result.routed === 'analysis' || result.routed === 'not-artifact') {
        setNotice({ kind: 'info', text: result.reason });
      } else {
        setDisamb({
          prompt: trimmed,
          question: result.question,
          options: result.options,
          suggestedTemplate: result.suggestedTemplate,
        });
      }
    } catch (e) {
      setNotice({ kind: 'error', text: `Could not generate the app: ${e instanceof Error ? e.message : String(e)}` });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="artifact-library" aria-label="Generated apps">
      <div style={{ padding: '8px 10px', borderBottom: '1px solid #e0e0e0' }}>
        <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 6 }}>New app from this sheet</div>
        <div style={{ display: 'flex', gap: 6 }}>
          <input
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void runGenerate(prompt);
            }}
            placeholder='e.g. "show me the schedule times, sortable"'
            aria-label="Describe the app to generate"
            disabled={busy}
            style={{ flex: 1, padding: '6px 8px', border: '1px solid #ccc', borderRadius: 4, fontSize: 13 }}
          />
          <button
            type="button"
            onClick={() => void runGenerate(prompt)}
            disabled={busy || !prompt.trim()}
            style={{ padding: '6px 12px' }}
          >
            {busy ? '…' : 'Generate'}
          </button>
        </div>
        <div style={{ fontSize: 11, color: '#777', marginTop: 4 }}>
          Sortable tables, chart dashboards, data-entry forms. Analysis requests route to data analysis instead.
        </div>
      </div>

      {notice && (
        <div
          role="status"
          style={{
            margin: '8px 10px',
            padding: 8,
            borderRadius: 4,
            fontSize: 12,
            background: notice.kind === 'error' ? '#fee' : '#eef4ff',
            color: notice.kind === 'error' ? '#a00' : '#244',
            border: `1px solid ${notice.kind === 'error' ? '#eaa' : '#bcd'}`,
          }}
        >
          {notice.text}
        </div>
      )}

      {disamb && (
        <div style={{ margin: '8px 10px', padding: 8, border: '1px solid #ddd', borderRadius: 4, fontSize: 12 }}>
          <div style={{ marginBottom: 6 }}>{disamb.question}</div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {disamb.options.map((opt) => (
              <button
                key={opt}
                type="button"
                disabled={busy}
                onClick={() =>
                  /app/i.test(opt)
                    ? void runGenerate(disamb.prompt, disamb.suggestedTemplate)
                    : setNotice({ kind: 'info', text: 'Routed to the data-analysis component instead — no app was generated.' })
                }
                style={{ padding: '4px 10px' }}
              >
                {opt}
              </button>
            ))}
          </div>
        </div>
      )}

      <div style={{ padding: '8px 10px', fontSize: 12, fontWeight: 600 }}>
        Saved apps ({artifacts.length})
      </div>
      <div style={{ overflowY: 'auto' }}>
        {/* The gallery (idea-app-gallery): live preview + Reopen /
            Duplicate / Share per entry. Same component as the
            Workspace "Apps" section. */}
        <AppsGallery
          store={store}
          mcpCall={mcpCall}
          onOpen={onOpen}
          sheets={[sheet]}
          onStoreChange={refresh}
        />
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* ArtifactFrame                                                     */
/* ------------------------------------------------------------------ */

/**
 * The embedded app renderer: mounts one generated React app in a
 * sandboxed iframe (sandbox="allow-scripts", opaque origin) and wires the
 * MCP bridge. This is what the chat's app-artifact panel mounts in its
 * body — the panel chrome (side-by-side / fullscreen toggle) lives in
 * AgentChat.
 */
export function ArtifactFrame({
  spec,
  mcpCall,
}: {
  spec: ArtifactSpec;
  mcpCall: McpCallFn | null;
}) {
  const iframeRef = useRef<HTMLIFrameElement | null>(null);

  const srcDoc = useMemo(
    // Pass the spec binding: the frame host defines the BINDING global
    // the generation contract promises generated apps (LLM-generated
    // sources rely on it; without it their data reads never fire —
    // wave-c W2 / case 3b).
    () => buildArtifactSrcDoc(spec.source, { reactUmd, reactDomUmd }, spec.name, spec.binding),
    [spec.source, spec.name, spec.binding],
  );

  // Wire the bridge host to the iframe for this artifact.
  useEffect(() => {
    if (!mcpCall) return;
    const iframe = iframeRef.current;
    const host = new ArtifactBridgeHost({
      callTool: mcpCall,
      postToFrame: (msg) => {
        iframe?.contentWindow?.postMessage(msg, '*');
      },
      principal: 'web-user',
    });
    const onMessage = (ev: MessageEvent): void => {
      if (!isBridgeMessage(ev.data)) return;
      host.handleFrameMessage(ev.data);
    };
    window.addEventListener('message', onMessage);
    return () => {
      window.removeEventListener('message', onMessage);
      host.dispose();
    };
  }, [spec.id, mcpCall]);

  if (!mcpCall) {
    return (
      <div style={{ padding: 16, fontSize: 13, color: '#555' }}>
        Generated apps need the local engine — they are not available through the gateway in v1.
      </div>
    );
  }

  return (
    <iframe
      ref={iframeRef}
      key={spec.id}
      title={spec.name}
      sandbox="allow-scripts"
      srcDoc={srcDoc}
      style={{ width: '100%', height: '100%', border: 'none', background: '#fff', flex: 1 }}
    />
  );
}
