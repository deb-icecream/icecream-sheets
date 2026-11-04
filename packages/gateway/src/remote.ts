/**
 * Remote engine access surface — the registry, the signed engine-token
 * format, and the Node remote engine host, WITHOUT the rest of the
 * gateway.
 *
 * Why a separate barrel: the gateway index re-exports agentSvc, which
 * imports createServer from @icecream-sheets/mcp-server. Any package
 * that imports the gateway index AND is itself imported by the gateway
 * (today: mcp-server) would pull its own dist declarations into its
 * own tsc program as inputs and fail the build with TS5055
 * ("would overwrite input file"). This barrel re-exports only modules
 * that never import mcp-server (fileRegistry, engineAccess,
 * remoteEngineHost — plus their engine/node-only dependencies), so it
 * is safe to import from both sides of that boundary.
 *
 * No behavior lives here; it is a re-export list. Keep it minimal:
 * only add a module after verifying it does not import mcp-server
 * (directly or through another gateway module).
 */
export {
  createFileRegistry,
  createLocalFileRegistry,
  fileRegistryDir,
  fileRegistryProvider,
  isLiveOwner,
  ownershipHeartbeatMs,
  ownershipLeaseMs,
  FirestoreFileRegistry,
  LocalFileRegistry,
  MemoryFileRegistry,
  type FileRegistry,
  type FileRegistryRecord,
} from './deploy/fileRegistry.js';
export {
  issueEngineAccessToken,
  verifyEngineAccessToken,
  engineAccessSecret,
  engineAccessMode,
  engineAccessTtlSeconds,
  type EngineAccessClaims,
  type EngineAccessRole,
} from './deploy/engineAccess.js';
export {
  NodeRemoteEngineHost,
  type NodeRemoteEngineHostOptions,
  type RemoteEngineFetch,
} from './services/remoteEngineHost.js';
