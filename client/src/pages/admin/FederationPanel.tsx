import { useState, useEffect } from 'react';
import { Loader2, Pencil, Plus, RotateCcw, Trash2 } from 'lucide-react';
import { adminApi, type FederatedServer } from '../../api/admin';
import { extractApiError } from '../../api/client';
import { toast } from '../../stores/toastStore';
import { Button } from '../../components/ui/Button';
import { confirm } from '../../stores/confirmStore';

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
      <div>
        <h2 className="mb-2 text-xl font-semibold text-text-primary">Federation</h2>
        <p className="text-sm text-text-muted">
          Manage trusted peers and inspect discovered federation metadata.
        </p>
      </div>

      <section className="card-surface space-y-5 rounded-xl border border-border-subtle bg-bg-mod-subtle/60 p-6">
        <h3 className="text-sm font-semibold uppercase tracking-wide text-text-muted">Add Federated Server</h3>
        <div className="grid gap-4 md:grid-cols-2">
          <div>
            <label className="mb-2 block text-sm font-medium text-text-secondary">Server Name</label>
            <input
              aria-label="Server Name"
              type="text"
              value={serverName}
              onChange={(e) => setServerName(e.target.value)}
              placeholder="example-server"
              className="input-field"
            />
          </div>
          <div>
            <label className="mb-2 block text-sm font-medium text-text-secondary">Domain</label>
            <input
              aria-label="Domain"
              type="text"
              value={domain}
              onChange={(e) => setDomain(e.target.value)}
              placeholder="example.com"
              className="input-field"
            />
          </div>
          <div className="md:col-span-2">
            <label className="mb-2 block text-sm font-medium text-text-secondary">Federation Endpoint</label>
            <input
              aria-label="Federation Endpoint"
              type="url"
              value={endpoint}
              onChange={(e) => setEndpoint(e.target.value)}
              placeholder="https://example.com/_paracord/federation/v1"
              className="input-field"
            />
          </div>
          <div>
            <label className="mb-2 block text-sm font-medium text-text-secondary">Public Key (hex)</label>
            <input
              aria-label="Public Key hex"
              type="text"
              value={publicKeyHex}
              onChange={(e) => setPublicKeyHex(e.target.value)}
              placeholder="Optional"
              className="input-field"
            />
          </div>
          <div>
            <label className="mb-2 block text-sm font-medium text-text-secondary">Key ID</label>
            <input
              aria-label="Key ID"
              type="text"
              value={keyId}
              onChange={(e) => setKeyId(e.target.value)}
              placeholder="Optional"
              className="input-field"
            />
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-4">
          <label className="card-surface inline-flex items-center gap-2 rounded-lg border border-border-subtle bg-bg-secondary/40 px-3 py-2 text-sm text-text-secondary">
            <input
              aria-label="Trusted peer"
              type="checkbox"
              checked={trusted}
              onChange={(e) => setTrusted(e.target.checked)}
              className="h-4 w-4 rounded border-border-subtle accent-accent-primary"
            />
            Trusted peer
          </label>
          <label className="card-surface inline-flex items-center gap-2 rounded-lg border border-border-subtle bg-bg-secondary/40 px-3 py-2 text-sm text-text-secondary">
            <input
              aria-label="Discover keys automatically"
              type="checkbox"
              checked={discover}
              onChange={(e) => setDiscover(e.target.checked)}
              className="h-4 w-4 rounded border-border-subtle accent-accent-primary"
            />
            Discover keys automatically
          </label>
        </div>

        <div className="flex flex-wrap gap-3">
          <Button
            onClick={handleCreate}
            disabled={creating}
            className="inline-flex items-center gap-2"
          >
            {creating ? <Loader2 size={16} className="animate-spin" /> : <Plus size={16} />}
            {creating ? 'Adding...' : 'Add Server'}
          </Button>
          <button
            onClick={() => fetchServers(true)}
            disabled={refreshing}
            className="btn-secondary inline-flex items-center gap-2"
          >
            {refreshing ? <Loader2 size={16} className="animate-spin" /> : <RotateCcw size={16} />}
            {refreshing ? 'Refreshing...' : 'Refresh List'}
          </button>
        </div>
      </section>

      <section>
        <h3 className="mb-3 text-sm font-semibold uppercase tracking-wide text-text-muted">Known Servers</h3>
        {loading ? (
          <div className="card-surface rounded-xl border border-border-subtle bg-bg-mod-subtle/60 px-6 py-6 text-sm text-text-muted">
            Loading federated servers...
          </div>
        ) : servers.length === 0 ? (
          <div className="card-surface rounded-xl border border-border-subtle bg-bg-mod-subtle/60 px-6 py-6 text-sm text-text-muted">
            No federated servers configured yet.
          </div>
        ) : (
          <div className="space-y-3">
            {servers.map((server) => (
              <div
                key={server.server_name}
                className="card-surface flex flex-wrap items-center justify-between gap-4 rounded-xl border border-border-subtle bg-bg-mod-subtle/60 px-4 py-4"
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium text-text-primary">{server.server_name}</p>
                  <p className="truncate text-sm text-text-muted">{server.domain}</p>
                  <p className="truncate text-xs text-text-muted">{server.federation_endpoint}</p>
                </div>
                <div className="flex items-center gap-2">
                  <span
                    className={`rounded-full px-2 py-1 text-xs font-semibold ${
                      server.trusted
                        ? 'bg-accent-success/20 text-accent-success'
                        : 'bg-warning/20 text-warning'
                    }`}
                  >
                    {server.trusted ? 'Trusted' : 'Untrusted'}
                  </span>
                  <button
                    onClick={() => handleInspect(server.server_name)}
                    disabled={inspectingName === server.server_name}
                    className="btn-secondary inline-flex items-center gap-2"
                  >
                    {inspectingName === server.server_name ? (
                      <Loader2 size={14} className="animate-spin" />
                    ) : (
                      <Pencil size={14} />
                    )}
                    Inspect
                  </button>
                  <button
                    onClick={() => handleDelete(server.server_name)}
                    disabled={deletingName === server.server_name}
                    className="btn-danger inline-flex items-center gap-2"
                  >
                    {deletingName === server.server_name ? (
                      <Loader2 size={14} className="animate-spin" />
                    ) : (
                      <Trash2 size={14} />
                    )}
                    Remove
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {selectedServer && (
        <section className="card-surface rounded-xl border border-border-subtle bg-bg-mod-subtle/60 p-6">
          <h3 className="mb-4 text-sm font-semibold uppercase tracking-wide text-text-muted">
            Server Details: {selectedServer.server_name}
          </h3>
          <div className="grid gap-3 text-sm md:grid-cols-2">
            <p className="text-text-secondary">
              <span className="font-medium text-text-primary">Domain:</span> {selectedServer.domain}
            </p>
            <p className="text-text-secondary">
              <span className="font-medium text-text-primary">Trusted:</span>{' '}
              {selectedServer.trusted ? 'Yes' : 'No'}
            </p>
            <p className="text-text-secondary md:col-span-2">
              <span className="font-medium text-text-primary">Endpoint:</span>{' '}
              {selectedServer.federation_endpoint}
            </p>
            <p className="text-text-secondary">
              <span className="font-medium text-text-primary">Key ID:</span>{' '}
              {selectedServer.key_id || 'Not set'}
            </p>
            <p className="text-text-secondary">
              <span className="font-medium text-text-primary">Last Seen:</span>{' '}
              {selectedServer.last_seen_at || 'Never'}
            </p>
            <p className="break-all text-text-secondary md:col-span-2">
              <span className="font-medium text-text-primary">Public Key:</span>{' '}
              {selectedServer.public_key_hex || 'Not set'}
            </p>
          </div>
        </section>
      )}
    </div>
  );
}
