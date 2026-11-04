/**
 * Add-on manager dialog: product-owned catalog, installed add-ons, and
 * per-document capability grants.
 *
 * Per design-docs/add-on-model.md §2, §4 and §6: capabilities are declared
 * in the manifest and shown before install; grants are user-approved per
 * document binding; permissions can be narrowed or revoked at any time.
 *
 * Presentational: the parent wires the callbacks to AddonService
 * (@icecream-sheets/service). Follows the dialog-backdrop/dialog class
 * pattern used by the other web dialogs.
 */
import { useMemo, useState } from 'react';
import A11yDialog from './A11yDialog';
import {
  describeCapabilities,
  type AddonListing,
  type CapabilityGrant,
  type StoredAddon,
} from '@icecream-sheets/service';

export interface AddonRunOutcome {
  ok: boolean;
  value?: unknown;
  error?: string;
}

export interface AddonManagerDialogProps {
  documentId: string;
  currentUser: string;
  catalog: AddonListing[];
  installed: StoredAddon[];
  grants: CapabilityGrant[];
  onInstall: (id: string, version?: string) => void;
  onEnable: (id: string) => void;
  onDisable: (id: string) => void;
  onUninstall: (id: string) => void;
  /** Request the manifest's declared capabilities for this document. */
  onRequestGrant: (addonId: string) => void;
  onApproveGrant: (grantId: string) => void;
  onDenyGrant: (grantId: string) => void;
  onRevokeGrant: (grantId: string) => void;
  /**
   * Run an installed add-on against the currently open workbook
   * (add-on-model.md §5: the invocation binds to this document and carries
   * the installing user's identity through authorize()). Only offered for
   * enabled add-ons with an active grant on this document.
   */
  onRun: (addonId: string) => Promise<AddonRunOutcome>;
  onClose: () => void;
}

type Tab = 'catalog' | 'installed' | 'grants';

const TABS: { id: Tab; label: string }[] = [
  { id: 'catalog', label: 'Catalog' },
  { id: 'installed', label: 'Installed' },
  { id: 'grants', label: 'Grants' },
];

function addonName(
  addonId: string,
  installed: StoredAddon[],
  catalog: AddonListing[],
): string {
  return (
    installed.find((a) => a.manifest.id === addonId)?.manifest.name ??
    catalog.find((l) => l.manifest.id === addonId)?.manifest.name ??
    addonId
  );
}

function StatusBadge({ status }: { status: CapabilityGrant['status'] }) {
  const colors: Record<CapabilityGrant['status'], string> = {
    pending: '#a16207',
    active: '#15803d',
    revoked: '#6b7280',
    denied: '#b91c1c',
  };
  return (
    <span
      style={{
        color: colors[status],
        border: `1px solid ${colors[status]}`,
        borderRadius: 4,
        padding: '0 6px',
        fontSize: 12,
        textTransform: 'capitalize',
      }}
    >
      {status}
    </span>
  );
}

export default function AddonManagerDialog(props: AddonManagerDialogProps) {
  const { catalog, installed, grants, documentId, currentUser, onClose } = props;
  const [tab, setTab] = useState<Tab>('catalog');
  const [runningId, setRunningId] = useState<string | null>(null);
  const [runOutcome, setRunOutcome] = useState<{ addonId: string; outcome: AddonRunOutcome } | null>(
    null,
  );

  const docGrants = useMemo(
    () => grants.filter((g) => g.documentId === documentId),
    [grants, documentId],
  );
  const pendingCount = docGrants.filter((g) => g.status === 'pending').length;

  const runAddon = async (addonId: string) => {
    setRunningId(addonId);
    setRunOutcome(null);
    try {
      const outcome = await props.onRun(addonId);
      setRunOutcome({ addonId, outcome });
    } catch (e) {
      setRunOutcome({ addonId, outcome: { ok: false, error: (e as Error).message } });
    } finally {
      setRunningId(null);
    }
  };

  return (
    <A11yDialog title={<>Add-ons</>} onClose={onClose}>
        <p className="dialog-hint">
          Add-ons run in an isolated worker and can only touch this document
          through capabilities you approve. Signed in as <b>{currentUser}</b> on{' '}
          <b>{documentId}</b>.
        </p>

        <div style={{ display: 'flex', gap: 8, marginBottom: 12 }} role="tablist">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={tab === t.id}
              onClick={() => setTab(t.id)}
              style={{ fontWeight: tab === t.id ? 700 : 400 }}
            >
              {t.label}
              {t.id === 'grants' && pendingCount > 0 ? ` (${pendingCount})` : ''}
            </button>
          ))}
        </div>

        {tab === 'catalog' && (
          <div>
            {catalog.length === 0 && <p className="dialog-hint">The catalog is empty.</p>}
            {catalog.map((listing) => {
              const isInstalled = installed.some((a) => a.manifest.id === listing.manifest.id);
              return (
                <div
                  key={listing.manifest.id}
                  style={{ borderBottom: '1px solid #e5e7eb', padding: '8px 0' }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <div>
                      <b>{listing.manifest.name}</b>{' '}
                      <span className="dialog-hint">v{listing.manifest.version}</span>
                    </div>
                    {isInstalled ? (
                      <span className="dialog-hint">Installed</span>
                    ) : (
                      <button type="button" onClick={() => props.onInstall(listing.manifest.id)}>
                        Install
                      </button>
                    )}
                  </div>
                  {listing.manifest.description && (
                    <div className="dialog-hint">{listing.manifest.description}</div>
                  )}
                  <div className="dialog-hint">
                    By {listing.publisher} · Permissions:{' '}
                    {describeCapabilities(listing.manifest.capabilities)}
                    {!listing.manifest.signature && ' · Unsigned'}
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {tab === 'installed' && (
          <div>
            {installed.length === 0 && (
              <p className="dialog-hint">No add-ons installed. Install one from the Catalog tab.</p>
            )}
            {installed.map((a) => {
              const active = docGrants.some(
                (g) =>
                  g.addonId === a.manifest.id &&
                  g.status === 'active' &&
                  g.manifestVersion === a.manifest.version,
              );
              const pending = docGrants.some(
                (g) => g.addonId === a.manifest.id && g.status === 'pending',
              );
              return (
                <div
                  key={a.manifest.id}
                  style={{ borderBottom: '1px solid #e5e7eb', padding: '8px 0' }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <div>
                      <b>{a.manifest.name}</b>{' '}
                      <span className="dialog-hint">v{a.manifest.version}</span>{' '}
                      {!a.enabled && <span className="dialog-hint">(disabled)</span>}
                    </div>
                    <div style={{ display: 'flex', gap: 6 }}>
                      {active && a.enabled && (
                        <button
                          type="button"
                          onClick={() => runAddon(a.manifest.id)}
                          disabled={runningId === a.manifest.id}
                          title="Run this add-on against the open workbook"
                        >
                          {runningId === a.manifest.id ? 'Running…' : 'Run'}
                        </button>
                      )}
                      {a.enabled ? (
                        <button type="button" onClick={() => props.onDisable(a.manifest.id)}>
                          Disable
                        </button>
                      ) : (
                        <button type="button" onClick={() => props.onEnable(a.manifest.id)}>
                          Enable
                        </button>
                      )}
                      <button type="button" onClick={() => props.onUninstall(a.manifest.id)}>
                        Uninstall
                      </button>
                    </div>
                  </div>
                  <div className="dialog-hint">
                    Permissions: {describeCapabilities(a.manifest.capabilities)}
                  </div>
                  {runOutcome?.addonId === a.manifest.id && (
                    <div
                      className="dialog-hint"
                      role="status"
                      style={{
                        marginTop: 4,
                        padding: 6,
                        borderRadius: 4,
                        background: runOutcome.outcome.ok ? '#f0fdf4' : '#fef2f2',
                        color: runOutcome.outcome.ok ? '#15803d' : '#b91c1c',
                        wordBreak: 'break-word',
                      }}
                    >
                      {runOutcome.outcome.ok
                        ? `Result: ${JSON.stringify(runOutcome.outcome.value)}`
                        : `Run failed: ${runOutcome.outcome.error ?? 'unknown error'}`}
                    </div>
                  )}
                  <div style={{ marginTop: 4 }}>
                    {active ? (
                      <span className="dialog-hint">Granted on this document.</span>
                    ) : pending ? (
                      <span className="dialog-hint">Grant request pending approval.</span>
                    ) : (
                      <button type="button" onClick={() => props.onRequestGrant(a.manifest.id)}>
                        Grant access to this document
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {tab === 'grants' && (
          <div>
            {docGrants.length === 0 && (
              <p className="dialog-hint">No grants for this document yet.</p>
            )}
            {docGrants.map((g) => (
              <div key={g.id} style={{ borderBottom: '1px solid #e5e7eb', padding: '8px 0' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <div>
                    <b>{addonName(g.addonId, installed, catalog)}</b> <StatusBadge status={g.status} />
                  </div>
                  <div style={{ display: 'flex', gap: 6 }}>
                    {g.status === 'pending' && (
                      <>
                        <button type="button" onClick={() => props.onApproveGrant(g.id)}>
                          Approve
                        </button>
                        <button type="button" onClick={() => props.onDenyGrant(g.id)}>
                          Deny
                        </button>
                      </>
                    )}
                    {g.status === 'active' && (
                      <button type="button" onClick={() => props.onRevokeGrant(g.id)}>
                        Revoke
                      </button>
                    )}
                  </div>
                </div>
                <div className="dialog-hint">
                  Permissions: {describeCapabilities(g.capabilities)}
                </div>
                <div className="dialog-hint">
                  Requested by {g.requestedBy} at {new Date(g.requestedAt).toLocaleString()}
                  {g.decidedBy && ` · ${g.status} by ${g.decidedBy}`}
                  {g.supersedes && ' · supersedes an earlier grant'}
                </div>
              </div>
            ))}
          </div>
        )}

        <div className="dialog-actions">
          <button type="button" onClick={onClose}>
            Close
          </button>
        </div>
      </A11yDialog>
  );
}
