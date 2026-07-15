import { useState, useEffect, type ReactNode } from 'react';
import { Loader2, Plus, RotateCcw, Trash2, Search, ShieldCheck, ShieldAlert, Globe2 } from 'lucide-react';
import {
  adminApi,
  type FederatedServer,
  type FederationPeerTrustState,
  type FederationModerationSubscription,
} from '../../api/admin';
import { extractApiError } from '../../api/client';
import { toast } from '../../stores/toastStore';
import { Button } from '../../components/ui/Button';
import { Input } from '../../components/ui/Input';
import { EmptyState, LoadingSpinner } from '../../components/ui/Feedback';
import { confirm } from '../../stores/confirmStore';

function Field({ label, htmlFor, className, children }: { label: string; htmlFor: string; className?: string; children: ReactNode }) {
  return (
    <div className={className}>
      <label htmlFor={htmlFor} className="mb-2 block text-label font-medium text-text-secondary">{label}</label>
      {children}
    </div>
  );
}

function DetailRow({ label, value, mono, className }: { label: string; value: string; mono?: boolean; className?: string }) {
  return (
    <div className={className}>
      <dt className="text-section uppercase text-text-muted">{label}</dt>
      <dd className={`mt-0.5 break-all text-body text-text-secondary ${mono ? 'font-code text-meta' : ''}`}>{value}</dd>
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
      toast.error(`Failed to load federated servers: ${extractApiError(err)}`);
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
      toast.error(`Failed to load federation moderation: ${extractApiError(err)}`);
      setTrustStates([]);
      setSubscriptions([]);
    } finally {
      setModLoading(false);
      if (showSpinner) setModRefreshing(false);
    }
  };

  useEffect(() => {
    fetchServers();
    fetchModeration();
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

  return (
    <div className="space-y-8">
      <header>
        <h2 className="font-display text-heading text-text-primary">Federation</h2>
        <p className="mt-1 text-body text-text-secondary">
          Manage trusted peer servers and inspect discovered federation metadata.
        </p>
      </header>

      <section className="rounded-md border border-border-subtle bg-bg-secondary p-6 shadow-sm">
        <h3 className="mb-5 text-section uppercase text-text-secondary">Add a federated server</h3>
        <div className="grid gap-4 md:grid-cols-2">
          <Field label="Server name" htmlFor="fed-name">
            <Input id="fed-name" aria-label="Server Name" type="text" value={serverName} onChange={(e) => setServerName(e.target.value)} placeholder="example-server" />
          </Field>
          <Field label="Domain" htmlFor="fed-domain">
            <Input id="fed-domain" aria-label="Domain" type="text" value={domain} onChange={(e) => setDomain(e.target.value)} placeholder="example.com" />
          </Field>
          <Field label="Federation endpoint" htmlFor="fed-endpoint" className="md:col-span-2">
            <Input id="fed-endpoint" aria-label="Federation Endpoint" type="url" value={endpoint} onChange={(e) => setEndpoint(e.target.value)} placeholder="https://example.com/_paracord/federation/v1" />
          </Field>
          <Field label="Public key (hex)" htmlFor="fed-pubkey">
            <Input id="fed-pubkey" aria-label="Public Key hex" type="text" value={publicKeyHex} onChange={(e) => setPublicKeyHex(e.target.value)} placeholder="Optional" />
          </Field>
          <Field label="Key ID" htmlFor="fed-keyid">
            <Input id="fed-keyid" aria-label="Key ID" type="text" value={keyId} onChange={(e) => setKeyId(e.target.value)} placeholder="Optional" />
          </Field>
        </div>

        <div className="mt-5 flex flex-wrap items-center gap-5 border-t border-border-subtle pt-5">
          <label className="inline-flex cursor-pointer items-center gap-2 text-body text-text-secondary">
            <input aria-label="Trusted peer" type="checkbox" checked={trusted} onChange={(e) => setTrusted(e.target.checked)} className="h-4 w-4 rounded-xs border-border-subtle accent-accent-primary" />
            Trusted peer
          </label>
          <label className="inline-flex cursor-pointer items-center gap-2 text-body text-text-secondary">
            <input aria-label="Discover keys automatically" type="checkbox" checked={discover} onChange={(e) => setDiscover(e.target.checked)} className="h-4 w-4 rounded-xs border-border-subtle accent-accent-primary" />
            Discover keys automatically
          </label>
          <div className="ml-auto flex flex-wrap gap-2">
            <Button variant="outline" onClick={() => fetchServers(true)} disabled={refreshing} className="gap-2">
              {refreshing ? <Loader2 size={16} className="animate-spin" /> : <RotateCcw size={16} />}
              {refreshing ? 'Refreshing…' : 'Refresh'}
            </Button>
            <Button onClick={handleCreate} loading={creating} disabled={creating} className="gap-2">
              {!creating && <Plus size={16} />}
              {creating ? 'Adding…' : 'Add server'}
            </Button>
          </div>
        </div>
      </section>

      <section>
        <h3 className="mb-3 text-section uppercase text-text-secondary">Known servers</h3>
        {loading ? (
          <div className="rounded-md border border-border-subtle bg-bg-secondary px-6 py-10 shadow-sm">
            <LoadingSpinner size="sm" label="Loading federated servers…" />
          </div>
        ) : servers.length === 0 ? (
          <div className="rounded-md border border-border-subtle bg-bg-secondary px-4 shadow-sm">
            <EmptyState
              icon={<Globe2 size={20} />}
              title="No peers configured yet"
              description="This server isn't federated with anyone. Add a trusted peer above to start exchanging messages and identities across servers."
            />
          </div>
        ) : (
          <div className="overflow-hidden rounded-md border border-border-subtle bg-bg-secondary shadow-sm">
            {servers.map((server, i) => (
              <div
                key={server.server_name}
                className={`group/row flex flex-wrap items-center justify-between gap-4 px-5 py-4 transition-colors hover:bg-bg-mod-subtle ${i > 0 ? 'border-t border-border-subtle/60' : ''}`}
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <p className="truncate text-label font-semibold text-text-primary">{server.server_name}</p>
                    {server.trusted ? (
                      <span className="inline-flex items-center gap-1 rounded-xs bg-success-tint px-2 py-0.5 text-meta font-semibold text-accent-success">
                        <ShieldCheck size={12} /> Trusted
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1 rounded-xs bg-warning-tint px-2 py-0.5 text-meta font-semibold text-accent-warning">
                        <ShieldAlert size={12} /> Untrusted
                      </span>
                    )}
                  </div>
                  <p className="mt-0.5 truncate text-body text-text-secondary">{server.domain}</p>
                  <p className="truncate font-code text-meta text-text-muted">{server.federation_endpoint}</p>
                </div>
                <div className="flex items-center gap-2 opacity-100 transition-opacity md:opacity-0 md:focus-within:opacity-100 md:group-hover/row:opacity-100">
                  <Button variant="secondary" size="sm" onClick={() => handleInspect(server.server_name)} disabled={inspectingName === server.server_name} className="gap-1.5">
                    {inspectingName === server.server_name ? <Loader2 size={14} className="animate-spin" /> : <Search size={14} />}
                    Inspect
                  </Button>
                  <Button variant="destructive" size="sm" onClick={() => handleDelete(server.server_name)} disabled={deletingName === server.server_name} className="gap-1.5">
                    {deletingName === server.server_name ? <Loader2 size={14} className="animate-spin" /> : <Trash2 size={14} />}
                    Remove
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {selectedServer && (
        <section className="rounded-md border border-border-subtle bg-bg-secondary p-6 shadow-sm">
          <h3 className="mb-4 text-section uppercase text-text-secondary">
            Details — {selectedServer.server_name}
          </h3>
          <dl className="grid gap-4 sm:grid-cols-2">
            <DetailRow label="Domain" value={selectedServer.domain} />
            <DetailRow label="Trusted" value={selectedServer.trusted ? 'Yes' : 'No'} />
            <DetailRow label="Endpoint" value={selectedServer.federation_endpoint} mono className="sm:col-span-2" />
            <DetailRow label="Key ID" value={selectedServer.key_id || 'Not set'} mono />
            <DetailRow label="Last seen" value={selectedServer.last_seen_at || 'Never'} />
            <DetailRow label="Public key" value={selectedServer.public_key_hex || 'Not set'} mono className="sm:col-span-2" />
          </dl>
        </section>
      )}

      <header className="border-t border-border-subtle pt-8">
        <h2 className="font-display text-heading text-text-primary">Federation moderation</h2>
        <p className="mt-1 text-body text-text-secondary">
          Block, quarantine, or allow peer servers, and subscribe to remote moderation lists.
        </p>
      </header>

      <section className="rounded-md border border-border-subtle bg-bg-secondary p-6 shadow-sm">
        <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
          <h3 className="text-section uppercase text-text-secondary">Apply action</h3>
          <Button variant="outline" size="sm" onClick={() => fetchModeration(true)} disabled={modRefreshing} className="gap-2">
            {modRefreshing ? <Loader2 size={14} className="animate-spin" /> : <RotateCcw size={14} />}
            Refresh
          </Button>
        </div>
        <div className="grid gap-4 md:grid-cols-2">
          <Field label="Server name" htmlFor="mod-server">
            <Input id="mod-server" aria-label="Moderation server name" type="text" value={applyServer} onChange={(e) => setApplyServer(e.target.value)} placeholder="peer.example" />
          </Field>
          <Field label="Action" htmlFor="mod-action">
            <select
              id="mod-action"
              aria-label="Moderation action"
              value={applyAction}
              onChange={(e) => setApplyAction(e.target.value as 'block' | 'quarantine' | 'allow')}
              className="h-10 w-full rounded-sm border border-border-subtle bg-bg-primary px-3 text-body text-text-primary"
            >
              <option value="block">Block</option>
              <option value="quarantine">Quarantine</option>
              <option value="allow">Allow / unblock</option>
            </select>
          </Field>
          <Field label="Reason" htmlFor="mod-reason">
            <Input id="mod-reason" aria-label="Moderation reason" type="text" value={applyReason} onChange={(e) => setApplyReason(e.target.value)} placeholder="Optional" />
          </Field>
          {applyAction === 'quarantine' && (
            <Field label="Quarantine minutes" htmlFor="mod-quarantine">
              <Input id="mod-quarantine" aria-label="Quarantine minutes" type="number" min={1} value={applyQuarantineMinutes} onChange={(e) => setApplyQuarantineMinutes(e.target.value)} />
            </Field>
          )}
        </div>
        {applyError && (
          <p className="mt-3 text-body text-accent-danger" role="alert">
            {applyError}
          </p>
        )}
        <div className="mt-5 flex justify-end border-t border-border-subtle pt-5">
          <Button onClick={handleApplyModeration} loading={applying} disabled={applying}>
            {applying ? 'Applying…' : `Apply ${applyAction}`}
          </Button>
        </div>
      </section>

      <section className="rounded-md border border-border-subtle bg-bg-secondary p-6 shadow-sm">
        <h3 className="mb-2 text-section uppercase text-text-secondary">Paste / import list</h3>
        <p className="mb-4 text-body text-text-muted">
          One entry per line: <span className="font-code text-meta">server</span>,{' '}
          <span className="font-code text-meta">server block</span>, or{' '}
          <span className="font-code text-meta">server quarantine 60 reason</span>. Bare names use the
          action selected above.
        </p>
        <textarea
          id="mod-import"
          aria-label="Import moderation list"
          value={importText}
          onChange={(e) => setImportText(e.target.value)}
          rows={5}
          placeholder={'bad.peer\nother.peer quarantine 120 spam\nallowed.peer allow'}
          className="w-full rounded-sm border border-border-subtle bg-bg-primary px-3 py-2 font-code text-meta text-text-primary placeholder:text-text-muted"
        />
        {importError && (
          <p className="mt-2 text-body text-accent-danger" role="alert">
            {importError}
          </p>
        )}
        <div className="mt-4 flex justify-end">
          <Button onClick={handleImportList} loading={importing} disabled={importing || !importText.trim()}>
            {importing ? 'Importing…' : 'Import list'}
          </Button>
        </div>
      </section>

      <section>
        <h3 className="mb-3 text-section uppercase text-text-secondary">
          Peer trust state{!modLoading && trustStates.length > 0 ? ` · ${trustStates.length}` : ''}
        </h3>
        {modLoading ? (
          <div className="rounded-md border border-border-subtle bg-bg-secondary px-6 py-10 shadow-sm">
            <LoadingSpinner size="sm" label="Loading trust state…" />
          </div>
        ) : trustStates.length === 0 ? (
          <div className="rounded-md border border-border-subtle bg-bg-secondary px-4 shadow-sm">
            <EmptyState
              icon={<ShieldCheck size={20} />}
              title="No moderation state yet"
              description="Apply a block or quarantine above, import a list, or wait for a subscribed list to sync."
            />
          </div>
        ) : (
          <div className="overflow-hidden rounded-md border border-border-subtle bg-bg-secondary shadow-sm">
            {trustStates.map((row, i) => {
              const mode = row.mode.toLowerCase();
              const modeBadge =
                mode === 'block' ? (
                  <span className="inline-flex items-center gap-1 rounded-xs bg-danger-tint px-2 py-0.5 text-meta font-semibold text-accent-danger">
                    <ShieldAlert size={12} /> Blocked
                  </span>
                ) : mode === 'quarantine' ? (
                  <span className="inline-flex items-center gap-1 rounded-xs bg-warning-tint px-2 py-0.5 text-meta font-semibold text-accent-warning">
                    <ShieldAlert size={12} /> Quarantine
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1 rounded-xs bg-success-tint px-2 py-0.5 text-meta font-semibold text-accent-success">
                    <ShieldCheck size={12} /> {row.mode}
                  </span>
                );
              return (
                <div
                  key={row.server_name}
                  className={`flex flex-wrap items-start justify-between gap-3 px-5 py-4 ${i > 0 ? 'border-t border-border-subtle/60' : ''}`}
                >
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="truncate text-label font-semibold text-text-primary">{row.server_name}</p>
                      {modeBadge}
                    </div>
                    {row.reason && <p className="mt-0.5 text-meta text-text-muted">{row.reason}</p>}
                  </div>
                  <p className="font-code text-meta text-text-muted">
                    {row.quarantined_until_ms
                      ? `Until ${new Date(row.quarantined_until_ms).toLocaleString()}`
                      : `Updated ${new Date(row.updated_at_ms).toLocaleString()}`}
                  </p>
                </div>
              );
            })}
          </div>
        )}
      </section>

      <section className="rounded-md border border-border-subtle bg-bg-secondary p-6 shadow-sm">
        <h3 className="mb-5 text-section uppercase text-text-secondary">Moderation list subscriptions</h3>
        <div className="grid gap-4 md:grid-cols-2">
          <Field label="Source URL" htmlFor="sub-url" className="md:col-span-2">
            <Input id="sub-url" aria-label="Subscription source URL" type="url" value={subUrl} onChange={(e) => setSubUrl(e.target.value)} placeholder="https://example.com/moderation.json" />
          </Field>
          <Field label="Source server (optional)" htmlFor="sub-server">
            <Input id="sub-server" aria-label="Subscription source server" type="text" value={subServer} onChange={(e) => setSubServer(e.target.value)} placeholder="list-publisher" />
          </Field>
        </div>
        {subError && (
          <p className="mt-3 text-body text-accent-danger" role="alert">
            {subError}
          </p>
        )}
        <div className="mt-5 flex justify-end border-t border-border-subtle pt-5">
          <Button onClick={handleAddSubscription} loading={addingSub} disabled={addingSub} className="gap-2">
            {!addingSub && <Plus size={16} />}
            Add subscription
          </Button>
        </div>

        <div className="mt-6">
          {subscriptions.length === 0 ? (
            <p className="text-body text-text-muted">No subscriptions configured.</p>
          ) : (
            <div className="overflow-hidden rounded-md border border-border-subtle">
              {subscriptions.map((sub, i) => (
                <div
                  key={String(sub.id)}
                  className={`flex flex-wrap items-center justify-between gap-3 px-4 py-3 ${i > 0 ? 'border-t border-border-subtle/60' : ''}`}
                >
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-code text-meta text-text-primary">{sub.source_url}</p>
                    <div className="mt-1 flex flex-wrap items-center gap-2">
                      {sub.enabled ? (
                        <span className="rounded-xs bg-success-tint px-2 py-0.5 text-meta font-semibold text-accent-success">
                          Enabled
                        </span>
                      ) : (
                        <span className="rounded-xs bg-bg-mod-strong px-2 py-0.5 text-meta font-semibold text-text-muted">
                          Disabled
                        </span>
                      )}
                      {sub.source_server && (
                        <span className="text-meta text-text-muted">{sub.source_server}</span>
                      )}
                      {sub.last_fetch_at_ms != null && (
                        <span className="font-code text-meta text-text-muted">
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
                    variant="destructive"
                    size="sm"
                    onClick={() => handleDeleteSubscription(sub.id)}
                    disabled={deletingSubId === String(sub.id)}
                    className="gap-1.5"
                  >
                    {deletingSubId === String(sub.id) ? <Loader2 size={14} className="animate-spin" /> : <Trash2 size={14} />}
                    Remove
                  </Button>
                </div>
              ))}
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
