/**
 * AppGenerationPort implementation (the app-artifact pipeline lane).
 *
 * Registered via registerIntentPorts() so the chat intent router can
 * dispatch route 'app' here. generateApp() runs the service-layer
 * generateAndSaveArtifact flow: the React source is generated from the
 * sheet schema read through MCP, validated, and persisted as a chat
 * artifact in the service metadata store. FRONTEND ONLY — no Python, no
 * backend code is ever produced on this path (enforced by the
 * AppGenerationResult type).
 *
 * The port is constructed with getters so it always uses the current
 * sheet, store, and MCP client. Two lanes:
 * - Local: the flow above runs in the browser over the in-process MCP
 *   client (deps.getMcpCall).
 * - Gateway (FIX-E): when deps.gatewayGenerate is provided, generation
 *   runs on the agent service (Vertex AI LLM generator; the browser
 *   holds no GCP credentials) and the returned spec is upserted into
 *   the same web artifact store the local lane saves into, so the
 *   chat's Apps tab and artifact panel behave identically.
 */
import {
  detectTemplate,
  generateAndSaveArtifact,
  type AppGenerationPort,
  type ArtifactSpec,
  type GenerateArtifactResult,
  type McpCallFn,
  type MetadataStore,
} from '@icecream-sheets/service';

export interface AppGenerationPortDeps {
  getMcpCall: () => Promise<McpCallFn>;
  getStore: () => MetadataStore<ArtifactSpec>;
  /**
   * #146: null when the client has not observed the workbook's sheet
   * list yet (an open still in flight). Callers must never substitute
   * a guessed name: the gateway lane forwards null (the service falls
   * back to the workbook's first sheet, #135), and the local lane
   * resolves null through list_sheets below.
   */
  getSheet: () => string | null;
  principal?: string;
  /**
   * Gateway lane (FIX-E): generate on the agent service and resolve
   * with the flow's result. Provided only in gateway mode.
   */
  gatewayGenerate?: (prompt: string, sheet: string | null) => Promise<GenerateArtifactResult>;
}

export function createAppGenerationPort(deps: AppGenerationPortDeps): AppGenerationPort {
  return {
    async generateApp(req) {
      if (deps.gatewayGenerate) {
        const sheet = deps.getSheet();
        const result = await deps.gatewayGenerate(req.prompt, sheet);
        if (result.routed !== 'app') {
          throw new Error(result.reason);
        }
        // Persist into the web artifact store exactly as the local
        // lane does (its flow saves through the injected store).
        const store = deps.getStore();
        store.saveAll([...store.all().filter((a) => a.id !== result.spec.id), result.spec]);
        return {
          reactSource: result.spec.source,
          artifactMeta: {
            title: result.spec.name,
            createdAt: result.spec.createdAt,
            artifactId: result.spec.id,
          },
        };
      }
      const mcpCall = await deps.getMcpCall();
      const store = deps.getStore();
      // #146: a null sheet means the sheet list is unobserved (open in
      // flight). Resolve the first listed sheet through MCP — never a
      // guessed name — or fail honestly if the list is unavailable.
      let sheet = deps.getSheet();
      if (sheet === null) {
        const listed = (await mcpCall('list_sheets', {})) as
          | { sheets?: unknown }
          | undefined;
        const names = Array.isArray(listed?.sheets) ? listed.sheets : [];
        const first = names.find(
          (n): n is string => typeof n === 'string' && n.length > 0,
        );
        if (!first) {
          throw new Error(
            'Workbook sheets are not available yet. Try again once the file has loaded.',
          );
        }
        sheet = first;
      }
      // The router already decided route 'app'; force the template path so
      // the flow does not re-route the prompt.
      const result = await generateAndSaveArtifact(
        { prompt: req.prompt, sheet },
        {
          callTool: mcpCall,
          store,
          principal: deps.principal ?? 'web-user',
          template: detectTemplate(req.prompt),
        },
      );
      if (result.routed !== 'app') {
        // Unreachable with a forced template, but never return a
        // non-artifact from the app port.
        throw new Error(result.reason);
      }
      return {
        reactSource: result.spec.source,
        artifactMeta: {
          title: result.spec.name,
          createdAt: result.spec.createdAt,
          artifactId: result.spec.id,
        },
      };
    },
  };
}
