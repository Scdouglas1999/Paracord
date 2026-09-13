import { useState, useEffect } from 'react';
import { Loader2, Plus, RotateCcw, Trash2, Search, ShieldCheck, ShieldAlert, Globe2 } from 'lucide-react';
import {
  adminApi,
  type FederatedServer,
  type FederationPeerTrustState,
  type FederationModerationSubscription,
} from '../../api/admin';
import { extractApiError } from '../../api/client';
import { toast } from '../../stores/toastStore';
import {
  Button,
  Chip,
  Divider,
  EmptyState,
  ErrorBanner,
  LoadingSpinner,
  SettingsSectionHeader,
  TextField,
  ToggleRow,
  Well,
} from '../../components/ui';
import { Select, Textarea } from '../../components/ui/Input';
import { confirm } from '../../stores/confirmStore';

/** A federation endpoint refusing because the deployment has federation off. */
function isFederationDisabled(err: unknown): boolean {
  const status = (err as { response?: { status?: number } })?.response?.status;
  return status === 400 && /federation is disabled/i.test(extractApiError(err));
}

function DetailRow({
  label,
  value,
  mono,
  className,
}: {
  label: string;
  value: string;
  mono?: boolean;
  className?: string;
}) {
  return (
    <div className={className}>
      <dt className="text-section text-text-faint">{label}</dt>
      <dd className={`mt-0.5 break-all text-label text-text-secondary ${mono ? 'pc-mono text-meta' : ''}`}>
        {value}
      </dd>
    </div>
  );
}

export function FederationPanel() {
  const [servers, setServers] = useState<FederatedServer[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [creating, setCreating] = useState(false);
  const [deletingName, setDeletingName] = useState<string | null>(null);
  const [inspectingName, setInspectingName] = useState<string | null>(null);
  const [selectedServer, setSelectedServer] = useState<FederatedServer | null>(null);

  const [serverName, setServerName] = useState('');
  const [domain, setDomain] = useState('');
  const [endpoint, setEndpoint] = useState('');
  const [publicKeyHex, setPublicKeyHex] = useState('');
  const [keyId, setKeyId] = useState('');
  const [trusted, setTrusted] = useState(true);
  const [discover, setDiscover] = useState(true);

  const [trustStates, setTrustStates] = useState<FederationPeerTrustState[]>([]);
  const [subscriptions, setSubscriptions] = useState<FederationModerationSubscription[]>([]);
  const [modLoading, setModLoading] = useState(true);
  const [modRefreshing, setModRefreshing] = useState(false);
  const [applyServer, setApplyServer] = useState('');
  const [applyAction, setApplyAction] = useState<'block' | 'quarantine' | 'allow'>('block');
  const [applyReason, setApplyReason] = useState('');
  const [applyQuarantineMinutes, setApplyQuarantineMinutes] = useState('60');
  const [applying, setApplying] = useState(false);
  const [subUrl, setSubUrl] = useState('');
  const [subServer, setSubServer] = useState('');
  const [addingSub, setAddingSub] = useState(false);
  const [deletingSubId, setDeletingSubId] = useState<string | null>(null);
  const [importText, setImportText] = useState('');
  const [importing, setImporting] = useState(false);
  // null until the deployment has answered. Federation is off by default, and
  // every federation endpoint answers 400 "federation is disabled" — which this
  // panel used to surface as a red toast reading "Failed to load federated
  // servers: bad request: federation is disabled" every time an admin opened
  // the tab, above a peer form that could not possibly work.
  const [federationEnabled, setFederationEnabled] = useState<boolean | null>(null);
  const [applyError, setApplyError] = useState<string | null>(null);
  const [subError, setSubError] = useState<string | null>(null);
  const [importError, setImportError] = useState<string | null>(null);

  const fetchServers = async (showSpinner = false) => {
    if (showSpinner) setRefreshing(true);
    try {
      const { data } = await adminApi.listFederatedServers();
      const nextServers = Array.isArray(data.servers) ? data.servers : [];
      setServers(nextServers);
      if (selectedServer) {
        const match = nextServers.find((s) => s.server_name === selectedServer.server_name) ?? null;
        setSelectedServer(match);
      }
    } catch (err) {
      if (isFederationDisabled(err)) {
        setFederationEnabled(false);
      } else {
        toast.error(`Failed to load federated servers: ${extractApiError(err)}`);
      }
      setServers([]);
      setSelectedServer(null);
    } finally {
      setLoading(false);
      if (showSpinner) setRefreshing(false);
    }
  };

  const fetchModeration = async (showSpinner = false) => {
    if (showSpinner) setModRefreshing(true);
    try {
      const [stateRes, subRes] = await Promise.all([
        adminApi.listModerationState(),
        adminApi.listModerationSubscriptions(),
      ]);
      setTrustStates(Array.isArray(stateRes.data.states) ? stateRes.data.states : []);
      setSubscriptions(
        Array.isArray(subRes.data.subscriptions) ? subRes.data.subscriptions : [],
      );
    } catch (err) {
      if (isFederationDisabled(err)) {
        setFederationEnabled(false);
      } else {
        toast.error(`Failed to load federation moderation: ${extractApiError(err)}`);
      }
      setTrustStates([]);
      setSubscriptions([]);
    } finally {
      setModLoading(false);
      if (showSpinner) setModRefreshing(false);
    }
  };

  useEffect(() => {
    let cancelled = false;
    // Ask the deployment whether federation is on before knocking on endpoints
    // that answer 400 when it is off. If health itself is unreachable, fall
    // through and let the calls decide, so a health outage never hides the
    // panel from a server that is genuinely federating.
    adminApi
      .getHealth()
      .then(({ data }) => (cancelled ? null : data.network.federation_enabled))
      .catch(() => (cancelled ? null : true))
      .then((enabled) => {
        if (cancelled || enabled === null) return;
        setFederationEnabled(enabled);
        if (!enabled) {
          setLoading(false);
          setModLoading(false);
          return;
        }
        fetchServers();
        fetchModeration();
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleCreate = async () => {
    const trimmedName = serverName.trim();
    const trimmedDomain = domain.trim();
    const trimmedEndpoint = endpoint.trim();
    if (!trimmedName || !trimmedDomain || !trimmedEndpoint) {
      toast.error('Server name, domain, and endpoint are required.');
      return;
    }
    setCreating(true);
    try {
      await adminApi.addFederatedServer({
        server_name: trimmedName,
        domain: trimmedDomain,
        federation_endpoint: trimmedEndpoint,
        public_key_hex: publicKeyHex.trim() || undefined,
        key_id: keyId.trim() || undefined,
        trusted,
        discover,
      });
      toast.success('Federated server added.');
      setServerName('');
      setDomain('');
      setEndpoint('');
      setPublicKeyHex('');
      setKeyId('');
      await fetchServers();
    } catch (err) {
      toast.error(`Failed to add server: ${extractApiError(err)}`);
    } finally {
      setCreating(false);
    }
  };

  const handleInspect = async (name: string) => {
    setInspectingName(name);
    try {
      const { data } = await adminApi.getFederatedServer(name);
      setSelectedServer(data);
    } catch (err) {
      toast.error(`Failed to inspect server: ${extractApiError(err)}`);
    } finally {
      setInspectingName(null);
    }
  };

  const handleDelete = async (name: string) => {
    const ok = await confirm({
      title: 'Remove federated server?',
      description: `Remove peer "${name}" from this server's federation directory?`,
      confirmLabel: 'Remove',
      variant: 'danger',
    });
    if (!ok) return;
    setDeletingName(name);
    try {
      await adminApi.deleteFederatedServer(name);
      toast.success('Federated server removed.');
      if (selectedServer?.server_name === name) setSelectedServer(null);
      await fetchServers();
    } catch (err) {
      toast.error(`Failed to delete server: ${extractApiError(err)}`);
    } finally {
      setDeletingName(null);
    }
  };

  const handleApplyModeration = async () => {
    const name = applyServer.trim().toLowerCase();
    setApplyError(null);
    if (!name) {
      setApplyError('Server name is required.');
      toast.error('Server name is required.');
      return;
    }
    if (!/^[a-z0-9][a-z0-9._-]*$/i.test(name)) {
      setApplyError('Server name should look like a peer id (letters, digits, ., _, -).');
      toast.error('Invalid server name.');
      return;
    }
    let quarantineMinutes: number | undefined;
    if (applyAction === 'quarantine') {
      quarantineMinutes = Number.parseInt(applyQuarantineMinutes, 10);
      if (!Number.isFinite(quarantineMinutes) || quarantineMinutes < 1) {
        setApplyError('Quarantine minutes must be a positive integer.');
        toast.error('Invalid quarantine duration.');
        return;
      }
    }
    setApplying(true);
    try {
      const { data } = await adminApi.applyModerationList({
        source: 'admin-ui',
        entries: [
          {
            server_name: name,
            action: applyAction,
            reason: applyReason.trim() || undefined,
            quarantine_minutes: quarantineMinutes,
          },
        ],
      });
      toast.success(`Applied ${data.applied} moderation entr${data.applied === 1 ? 'y' : 'ies'}.`);
      setApplyServer('');
      setApplyReason('');
      setApplyError(null);
      await fetchModeration();
    } catch (err) {
      const message = extractApiError(err);
      setApplyError(message);
      toast.error(`Failed to apply moderation: ${message}`);
    } finally {
      setApplying(false);
    }
  };

  const handleImportList = async () => {
    setImportError(null);
    const lines = importText
      .split(/[\n,]+/)
      .map((line) => line.trim())
      .filter(Boolean);
    if (lines.length === 0) {
      setImportError('Paste one server name per line (optional: name action reason).');
      toast.error('Nothing to import.');
      return;
    }

    const entries: Array<{
      server_name: string;
      action: string;
      reason?: string;
      quarantine_minutes?: number;
    }> = [];
    const parseErrors: string[] = [];

    for (const line of lines) {
      // Formats: "peer.example", "peer.example block", "peer.example quarantine 60 reason…"
      const parts = line.split(/\s+/);
      const server_name = (parts[0] ?? '').toLowerCase();
      if (!server_name) continue;
      if (!/^[a-z0-9][a-z0-9._-]*$/i.test(server_name)) {
        parseErrors.push(`Invalid name: ${parts[0]}`);
        continue;
      }
      const actionRaw = (parts[1] ?? applyAction).toLowerCase();
      const action =
        actionRaw === 'allow' || actionRaw === 'unblock'
          ? 'allow'
          : actionRaw === 'quarantine'
            ? 'quarantine'
            : actionRaw === 'block' || actionRaw === 'deny'
              ? 'block'
              : null;
      if (!action) {
        parseErrors.push(`Unknown action on ${server_name}: ${parts[1]}`);
        continue;
      }
      let quarantine_minutes: number | undefined;
      let reasonStart = 2;
      if (action === 'quarantine' && parts[2] && /^\d+$/.test(parts[2])) {
        quarantine_minutes = Number.parseInt(parts[2], 10);
        reasonStart = 3;
      } else if (action === 'quarantine') {
        quarantine_minutes = Number.parseInt(applyQuarantineMinutes, 10) || 60;
      }
      const reason = parts.slice(reasonStart).join(' ').trim() || undefined;
      entries.push({ server_name, action, reason, quarantine_minutes });
    }

    if (entries.length === 0) {
      setImportError(parseErrors[0] ?? 'No valid entries found.');
      toast.error('No valid entries to apply.');
      return;
    }

    setImporting(true);
    try {
      const { data } = await adminApi.applyModerationList({
        source: 'admin-ui-import',
        entries,
      });
      const skipped = parseErrors.length;
      toast.success(
        `Imported ${data.applied} entr${data.applied === 1 ? 'y' : 'ies'}${skipped ? ` (${skipped} skipped)` : ''}.`,
      );
      setImportText('');
      setImportError(skipped ? parseErrors.slice(0, 3).join(' · ') : null);
      await fetchModeration();
    } catch (err) {
      const message = extractApiError(err);
      setImportError(message);
      toast.error(`Failed to import list: ${message}`);
    } finally {
      setImporting(false);
    }
  };

  const handleAddSubscription = async () => {
    const url = subUrl.trim();
    setSubError(null);
    if (!url) {
      setSubError('Source URL is required.');
      toast.error('Source URL is required.');
      return;
    }
    try {
      // Basic URL shape check — API still validates reachability on fetch.
      const parsed = new URL(url);
      if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
        setSubError('Source URL must be http(s).');
        toast.error('Invalid source URL protocol.');
        return;
      }
    } catch {
      setSubError('Source URL is not a valid URL.');
      toast.error('Invalid source URL.');
      return;
    }
    setAddingSub(true);
    try {
      await adminApi.upsertModerationSubscription({
        source_url: url,
        source_server: subServer.trim() || undefined,
        enabled: true,
      });
      toast.success('Moderation subscription added.');
      setSubUrl('');
      setSubServer('');
      setSubError(null);
      await fetchModeration();
    } catch (err) {
      const message = extractApiError(err);
      setSubError(message);
      toast.error(`Failed to add subscription: ${message}`);
    } finally {
      setAddingSub(false);
    }
  };

  const handleDeleteSubscription = async (id: string | number) => {
    const idStr = String(id);
    const ok = await confirm({
      title: 'Remove subscription?',
      description: 'Stop syncing this remote moderation list?',
      confirmLabel: 'Remove',
      variant: 'danger',
    });
    if (!ok) return;
    setDeletingSubId(idStr);
    try {
      await adminApi.deleteModerationSubscription(idStr);
      toast.success('Subscription removed.');
      await fetchModeration();
    } catch (err) {
      toast.error(`Failed to remove subscription: ${extractApiError(err)}`);
    } finally {
      setDeletingSubId(null);
    }
  };


  if (federationEnabled === false) {
    return (
      <div className="flex flex-col gap-8">
        <section>
          <SettingsSectionHeader
            title="Federation"
            description="Manage trusted peer servers and inspect discovered federation metadata."
          />
          <EmptyState
            icon={<Globe2 size={18} />}
            title="Federation is turned off on this deployment"
            description="Nothing is exchanged with other servers, and no peers can be added. Set enabled = true under [federation] in this server's configuration file, give it a domain and a signing key, then restart to peer with other servers."
          />
        </section>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-8">
      <section>
        <SettingsSectionHeader
          title="Federation"
          description="Manage trusted peer servers and inspect discovered federation metadata."
          action={
            <Button
              variant="ghost"
              onClick={() => fetchServers(true)}
              disabled={refreshing}
              className="gap-2"
            >
              {refreshing ? (
                <Loader2 size={16} className="animate-spin" />
              ) : (
                <RotateCcw size={16} />
              )}
              {refreshing ? 'Refreshing…' : 'Refresh'}
            </Button>
          }
        />

        <h3 className="pc-display text-heading text-text-primary">Add a federated server</h3>
        <div className="mt-3 grid gap-4 md:grid-cols-2">
          <TextField id="fed-name" label="Server name" type="text" value={serverName} onChange={(e) => setServerName(e.target.value)} placeholder="example-server" />
          <TextField id="fed-domain" label="Domain" type="text" value={domain} onChange={(e) => setDomain(e.target.value)} placeholder="example.com" />
          <TextField id="fed-endpoint" label="Federation endpoint" type="url" value={endpoint} onChange={(e) => setEndpoint(e.target.value)} placeholder="https://example.com/_paracord/federation/v1" className="md:col-span-2" />
          <TextField id="fed-pubkey" label="Public key (hex)" type="text" value={publicKeyHex} onChange={(e) => setPublicKeyHex(e.target.value)} placeholder="Optional" />
          <TextField id="fed-keyid" label="Key ID" type="text" value={keyId} onChange={(e) => setKeyId(e.target.value)} placeholder="Optional" />
        </div>

        <div className="mt-4 flex flex-col">
          <Divider />
          <ToggleRow
            label="Trusted peer"
            description="Accept this server's signed envelopes without a manual review."
            checked={trusted}
            onChange={setTrusted}
          />
          <ToggleRow
            label="Discover keys automatically"
            description="Fetch the peer's signing key from its federation endpoint instead of pasting one."
            checked={discover}
            onChange={setDiscover}
          />
          <div className="mt-3 flex justify-end">
            <Button onClick={handleCreate} loading={creating} disabled={creating} className="gap-2">
              {!creating && <Plus size={16} />}
              {creating ? 'Adding…' : 'Add server'}
            </Button>
          </div>
        </div>
      </section>

      <section>
        <h3 className="pc-display text-heading text-text-primary">Known servers</h3>
        {loading ? (
          <Well className="mt-3 px-6 py-10">
            <LoadingSpinner size="sm" label="Loading federated servers…" />
          </Well>
        ) : servers.length === 0 ? (
          <EmptyState
            icon={<Globe2 size={20} />}
            title="No peers configured yet"
            description="This server isn't federated with anyone. Add a trusted peer above to start exchanging messages and identities across servers."
          />
        ) : (
          <ul className="mt-2 flex flex-col">
            {servers.map((server) => (
              <li
                key={server.server_name}
                className="flex flex-wrap items-center justify-between gap-4 border-t border-border-subtle py-3.5 transition-colors hover:bg-bg-mod-subtle"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="pc-display truncate text-name text-text-primary">
                      {server.server_name}
                    </p>
                    {server.trusted ? (
                      <Chip size="sm" tone="accent">
                        <ShieldCheck size={12} aria-hidden /> Trusted
                      </Chip>
                    ) : (
                      <Chip size="sm" className="text-accent-warning">
                        <ShieldAlert size={12} aria-hidden /> Untrusted
                      </Chip>
                    )}
                  </div>
                  <p className="mt-0.5 truncate text-label text-text-secondary">{server.domain}</p>
                  <p className="pc-mono truncate text-meta text-text-muted">
                    {server.federation_endpoint}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => handleInspect(server.server_name)}
                    disabled={inspectingName === server.server_name}
                    className="gap-1.5"
                  >
                    {inspectingName === server.server_name ? (
                      <Loader2 size={14} className="animate-spin" />
                    ) : (
                      <Search size={14} />
                    )}
                    Inspect
                  </Button>
                  <Button
                    variant="danger"
                    size="sm"
                    onClick={() => handleDelete(server.server_name)}
                    disabled={deletingName === server.server_name}
                    className="gap-1.5"
                  >
                    {deletingName === server.server_name ? (
                      <Loader2 size={14} className="animate-spin" />
                    ) : (
                      <Trash2 size={14} />
                    )}
                    Remove
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {selectedServer && (
        <section>
          <h3 className="pc-display text-heading text-text-primary">
            Details — {selectedServer.server_name}
          </h3>
          <Well className="mt-3 grid gap-4 px-4 py-4 sm:grid-cols-2">
            <DetailRow label="Domain" value={selectedServer.domain} />
            <DetailRow label="Trusted" value={selectedServer.trusted ? 'Yes' : 'No'} />
            <DetailRow label="Endpoint" value={selectedServer.federation_endpoint} mono className="sm:col-span-2" />
            <DetailRow label="Key ID" value={selectedServer.key_id || 'Not set'} mono />
            <DetailRow label="Last seen" value={selectedServer.last_seen_at || 'Never'} />
            <DetailRow label="Public key" value={selectedServer.public_key_hex || 'Not set'} mono className="sm:col-span-2" />
          </Well>
        </section>
      )}

      <Divider />

      <section>
        <SettingsSectionHeader
          title="Federation moderation"
          description="Block, quarantine, or allow peer servers, and subscribe to remote moderation lists."
          action={
            <Button
              variant="ghost"
              onClick={() => fetchModeration(true)}
              disabled={modRefreshing}
              className="gap-2"
            >
              {modRefreshing ? (
                <Loader2 size={14} className="animate-spin" />
              ) : (
                <RotateCcw size={14} />
              )}
              Refresh
            </Button>
          }
        />

        <h3 className="pc-display text-heading text-text-primary">Apply an action</h3>
        <div className="mt-3 grid gap-4 md:grid-cols-2">
          <TextField id="mod-server" label="Server name" type="text" value={applyServer} onChange={(e) => setApplyServer(e.target.value)} placeholder="peer.example" />
          <div className="flex flex-col gap-1.5">
            <label htmlFor="mod-action" className="text-label font-medium text-text-secondary">
              Action
            </label>
            <Select
              id="mod-action"
              value={applyAction}
              onChange={(e) => setApplyAction(e.target.value as 'block' | 'quarantine' | 'allow')}
            >
              <option value="block">Block</option>
              <option value="quarantine">Quarantine</option>
              <option value="allow">Allow / unblock</option>
            </Select>
          </div>
          <TextField id="mod-reason" label="Reason" type="text" value={applyReason} onChange={(e) => setApplyReason(e.target.value)} placeholder="Optional" />
          {applyAction === 'quarantine' && (
            <TextField id="mod-quarantine" label="Quarantine minutes" type="number" min={1} value={applyQuarantineMinutes} onChange={(e) => setApplyQuarantineMinutes(e.target.value)} />
          )}
        </div>
        {applyError && <ErrorBanner className="mt-3" message={applyError} multiline />}
        <div className="mt-4 flex justify-end">
          <Button
            variant={applyAction === 'allow' ? 'ghost' : 'danger'}
            onClick={handleApplyModeration}
            loading={applying}
            disabled={applying}
          >
            {applying ? 'Applying…' : `Apply ${applyAction}`}
          </Button>
        </div>
      </section>

      <section>
        <h3 className="pc-display text-heading text-text-primary">Paste or import a list</h3>
        <p className="mt-1 max-w-prose text-body text-text-secondary">
          One entry per line: <span className="pc-mono text-meta">server</span>,{' '}
          <span className="pc-mono text-meta">server block</span>, or{' '}
          <span className="pc-mono text-meta">server quarantine 60 reason</span>. Bare names use the
          action selected above.
        </p>
        <label htmlFor="mod-import" className="sr-only">
          Import moderation list
        </label>
        <Textarea
          id="mod-import"
          value={importText}
          onChange={(e) => setImportText(e.target.value)}
          rows={5}
          placeholder={'bad.peer\nother.peer quarantine 120 spam\nallowed.peer allow'}
          className="pc-mono mt-3 text-meta"
        />
        {importError && <ErrorBanner className="mt-3" message={importError} multiline />}
        <div className="mt-4 flex justify-end">
          <Button
            variant="ghost"
            onClick={handleImportList}
            loading={importing}
            disabled={importing || !importText.trim()}
          >
            {importing ? 'Importing…' : 'Import list'}
          </Button>
        </div>
      </section>

      <section>
        <h3 className="pc-display text-heading text-text-primary">
          Peer trust state
          {!modLoading && trustStates.length > 0 && (
            <span className="pc-mono ml-2 text-meta tabular-nums text-text-faint">
              {trustStates.length}
            </span>
          )}
        </h3>
        {modLoading ? (
          <Well className="mt-3 px-6 py-10">
            <LoadingSpinner size="sm" label="Loading trust state…" />
          </Well>
        ) : trustStates.length === 0 ? (
          <EmptyState
            icon={<ShieldCheck size={20} />}
            title="No moderation state yet"
            description="Apply a block or quarantine above, import a list, or wait for a subscribed list to sync."
          />
        ) : (
          <ul className="mt-2 flex flex-col">
            {trustStates.map((row) => {
              const mode = row.mode.toLowerCase();
              const modeChip =
                mode === 'block' ? (
                  <Chip size="sm" tone="danger">
                    <ShieldAlert size={12} aria-hidden /> Blocked
                  </Chip>
                ) : mode === 'quarantine' ? (
                  <Chip size="sm" className="text-accent-warning">
                    <ShieldAlert size={12} aria-hidden /> Quarantined
                  </Chip>
                ) : (
                  <Chip size="sm" tone="accent">
                    <ShieldCheck size={12} aria-hidden /> {row.mode}
                  </Chip>
                );
              return (
                <li
                  key={row.server_name}
                  className="flex flex-wrap items-start justify-between gap-3 border-t border-border-subtle py-3.5"
                >
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="pc-display truncate text-name text-text-primary">
                        {row.server_name}
                      </p>
                      {modeChip}
                    </div>
                    {row.reason && <p className="mt-0.5 text-meta text-text-muted">{row.reason}</p>}
                  </div>
                  <p className="pc-mono text-meta tabular-nums text-text-muted">
                    {row.quarantined_until_ms
                      ? `Until ${new Date(row.quarantined_until_ms).toLocaleString()}`
                      : `Updated ${new Date(row.updated_at_ms).toLocaleString()}`}
                  </p>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section>
        <h3 className="pc-display text-heading text-text-primary">Moderation list subscriptions</h3>
        <div className="mt-3 grid gap-4 md:grid-cols-2">
          <TextField id="sub-url" label="Source URL" type="url" value={subUrl} onChange={(e) => setSubUrl(e.target.value)} placeholder="https://example.com/moderation.json" className="md:col-span-2" />
          <TextField id="sub-server" label="Source server (optional)" type="text" value={subServer} onChange={(e) => setSubServer(e.target.value)} placeholder="list-publisher" />
        </div>
        {subError && <ErrorBanner className="mt-3" message={subError} multiline />}
        <div className="mt-4 flex justify-end">
          <Button
            variant="ghost"
            onClick={handleAddSubscription}
            loading={addingSub}
            disabled={addingSub}
            className="gap-2"
          >
            {!addingSub && <Plus size={16} />}
            Add subscription
          </Button>
        </div>

        <div className="mt-6">
          {subscriptions.length === 0 ? (
            <EmptyState
              icon={<Globe2 size={20} />}
              title="Not subscribed to any lists"
              description="Point this server at a published moderation list and its blocks and quarantines will sync automatically."
            />
          ) : (
            <ul className="flex flex-col">
              {subscriptions.map((sub) => (
                <li
                  key={String(sub.id)}
                  className="flex flex-wrap items-center justify-between gap-3 border-t border-border-subtle py-3"
                >
                  <div className="min-w-0 flex-1">
                    <p className="pc-mono truncate text-meta text-text-primary">{sub.source_url}</p>
                    <div className="mt-1 flex flex-wrap items-center gap-2">
                      {sub.enabled ? (
                        <Chip size="sm" tone="accent">Enabled</Chip>
                      ) : (
                        <Chip size="sm">Disabled</Chip>
                      )}
                      {sub.source_server && (
                        <span className="text-meta text-text-muted">{sub.source_server}</span>
                      )}
                      {sub.last_fetch_at_ms != null && (
                        <span className="pc-mono text-meta tabular-nums text-text-muted">
                          Last fetch {new Date(sub.last_fetch_at_ms).toLocaleString()}
                        </span>
                      )}
                    </div>
                    {sub.last_error && (
                      <p className="mt-1 text-meta text-accent-danger" role="status">
                        Last error: {sub.last_error}
                      </p>
                    )}
                  </div>
                  <Button
                    variant="danger"
                    size="sm"
                    onClick={() => handleDeleteSubscription(sub.id)}
                    disabled={deletingSubId === String(sub.id)}
                    className="gap-1.5"
                  >
                    {deletingSubId === String(sub.id) ? (
                      <Loader2 size={14} className="animate-spin" />
                    ) : (
                      <Trash2 size={14} />
                    )}
                    Remove
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>
    </div>
  );
}
