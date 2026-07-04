import { useState, useEffect, type ReactNode } from 'react';
import { Loader2, Plus, RotateCcw, Trash2, Search, ShieldCheck, ShieldAlert, Globe2 } from 'lucide-react';
import { adminApi, type FederatedServer } from '../../api/admin';
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

  useEffect(() => {
    fetchServers();
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
      toast.success(`Federated server added: ${trimmedName}`);
      setServerName('');
      setDomain('');
      setEndpoint('');
      setPublicKeyHex('');
      setKeyId('');
      setTrusted(true);
      setDiscover(true);
      await fetchServers();
    } catch (err) {
      toast.error(`Failed to add federated server: ${extractApiError(err)}`);
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
    if (!(await confirm({
      title: 'Delete federated server?',
      description: `Delete "${name}" from trusted federation peers?`,
      confirmLabel: 'Delete',
      variant: 'danger',
    }))) return;
    setDeletingName(name);
    try {
      await adminApi.deleteFederatedServer(name);
      toast.success(`Deleted federated server: ${name}`);
      setServers((prev) => prev.filter((s) => s.server_name !== name));
      if (selectedServer?.server_name === name) setSelectedServer(null);
    } catch (err) {
      toast.error(`Failed to delete server: ${extractApiError(err)}`);
    } finally {
      setDeletingName(null);
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

      {/* Add peer form */}
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

      {/* Known servers */}
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
    </div>
  );
}
