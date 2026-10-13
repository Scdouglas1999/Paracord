import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Copy, FileText, HardDriveDownload, Power, RotateCw, Trash2, UserPlus } from 'lucide-react';

import { getServerApi } from '../../api/activeClient';
import { extractApiError } from '../../api/client';
import { withUnlockedPrivateKey } from '../../lib/accountSession';
import { writeClipboardText } from '../../lib/clipboard';
import { normalizeHomeOrigin } from '../../lib/credential/keystoreV2';
import {
  ESCROW_COPY,
  UPDATE_COPY,
  hostSettingsView,
  reachIsSettling,
  type PendingAction,
  type ReachChip,
  type Tone,
} from '../../lib/host/settingsView';
import { homeOrigin } from '../../lib/oneCredential';
import { LOCAL_SERVER_ID } from '../../lib/serverScope';
import { isTauri } from '../../lib/tauriEnv';
import { formatTrustWords, trustWords } from '../../lib/trustWords';
import { useAccountStore } from '../../stores/accountStore';
import { useAuthStore } from '../../stores/authStore';
import { useChannelStore } from '../../stores/channelStore';
import { useGuildStore } from '../../stores/guildStore';
import { useHostStore } from '../../stores/hostStore';
import { toast } from '../../stores/toastStore';
import { ChannelType } from '../../types';
import { escrowWrappingKey } from '../../pages/firstRun/escrow';
import { RouterSheet, SharedAddressSheet } from '../firstRun/Sheets';
import { openInvite } from '../ix/menus/hostStore';
import { Button, SettingsSectionHeader, ToggleRow } from '../ui';
import { Modal, ModalBody, ModalDescription, ModalFooter, ModalHeader, ModalTitle } from '../ui/Modal';
import { RemoveHostDialog } from './RemoveHostDialog';
import '../firstRun/firstRun.css';
import './hostLaunch.css';
import './hostSettings.css';

/** How long the page keeps reading the status while the router is being asked (spec 2.6 row 4). */
const ASKING_POLL_MS = 1000;
const ASKING_POLL_LIMIT = 15;

/**
 * Is this computer hosting a server? Desktop only; reads `host_info` once if
 * nothing has yet (the app reads it at launch). Settings shows "Paracord on
 * this computer" only when this is true (spec 2.9: `host.json.enabled`).
 */
export function useHostedHere(): boolean {
  const desktop = isTauri();
  const enabled = useHostStore((s) => s.info?.enabled ?? false);
  useEffect(() => {
    if (desktop && !useHostStore.getState().info) void useHostStore.getState().loadInfo();
  }, [desktop]);
  return desktop && enabled;
}

/** The server this computer hosts, as this account sees it: the one it owns on its home server. */
function useHostedServer() {
  const userId = useAuthStore((s) => s.user?.id ?? null);
  const guilds = useGuildStore((s) => s.guilds);
  return useMemo(
    () => guilds.find((g) => g.scope.serverId === LOCAL_SERVER_ID && userId !== null && g.owner_id === userId) ?? null,
    [guilds, userId],
  );
}

/**
 * Settings › "Paracord on this computer" (docs/setup-spec.md §2.9): the server
 * this computer runs in the background, at a glance and with its controls.
 * The words on it come from `lib/host/settingsView.ts` (spec copy, tested);
 * this draws them and runs the actions through `useHostStore`.
 *
 * Reads `host_info` and `host_status` when it opens and after each action;
 * while the router is being asked it reads the status once a second for at
 * most 15 s. Nothing runs when the page is closed (spec 2.8).
 */
/** Settings is a windowed overlay at z-[150]; anything this page opens sits above it. */
const OVER_SETTINGS = 'z-[160]';

export function HostSettingsSection({ onCloseSettings }: { onCloseSettings?: () => void }) {
  const info = useHostStore((s) => s.info);
  const status = useHostStore((s) => s.status);
  const storeError = useHostStore((s) => s.error);
  const server = useHostedServer();

  const [pending, setPending] = useState<PendingAction>(null);
  const [startError, setStartError] = useState<string | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [notes, setNotes] = useState<Record<string, { tone: 'ok' | 'fail'; text: string } | undefined>>({});
  const [sheet, setSheet] = useState<'router' | 'shared' | null>(null);
  const [logs, setLogs] = useState<string | null>(null);
  const [removeOpen, setRemoveOpen] = useState(false);
  const [wordsFor, setWordsFor] = useState<{ fingerprint: string; text: string } | null>(null);
  const mounted = useRef(true);

  const note = (key: string, value: { tone: 'ok' | 'fail'; text: string } | undefined) =>
    setNotes((n) => ({ ...n, [key]: value }));
  const withBusy = async <T,>(key: string, run: () => Promise<T>): Promise<T> => {
    setBusy((b) => ({ ...b, [key]: true }));
    try {
      return await run();
    } finally {
      if (mounted.current) setBusy((b) => ({ ...b, [key]: false }));
    }
  };

  /** Read host.json + the service state, then the running server's status. */
  const refresh = useCallback(async () => {
    const host = useHostStore.getState();
    const nextInfo = await host.loadInfo();
    if (nextInfo?.service?.state === 'running') {
      const next = await host.loadStatus();
      if (mounted.current) setStatusError(next ? null : (useHostStore.getState().error ?? 'it gave no reason'));
    }
    if (mounted.current) setNow(Date.now());
  }, []);

  useEffect(() => {
    mounted.current = true;
    void refresh();
    // Relative times ("about 2 hours ago") stay true while the page is open.
    const tick = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => {
      mounted.current = false;
      window.clearInterval(tick);
    };
  }, [refresh]);

  // The router is being asked: read again until it answers (bounded).
  const asking = reachIsSettling(status?.reachability);
  useEffect(() => {
    if (!asking) return;
    let reads = 0;
    const timer = window.setInterval(() => {
      reads += 1;
      if (reads > ASKING_POLL_LIMIT) {
        window.clearInterval(timer);
        return;
      }
      void useHostStore.getState().loadStatus();
    }, ASKING_POLL_MS);
    return () => window.clearInterval(timer);
  }, [asking]);

  const fingerprint = status?.tls.fingerprint_sha256 ?? null;
  useEffect(() => {
    if (!fingerprint) return;
    let live = true;
    trustWords(fingerprint)
      .then((w) => live && setWordsFor({ fingerprint, text: formatTrustWords(w) }))
      .catch(() => live && setWordsFor(null));
    return () => {
      live = false;
    };
  }, [fingerprint]);
  // Words are only ever shown for the certificate the server reports right now.
  const words = wordsFor && wordsFor.fingerprint === fingerprint ? wordsFor.text : null;

  if (!info) {
    return (
      <div data-testid="host-settings">
        <SettingsSectionHeader title="Paracord on this computer" />
        <p className="text-body text-text-secondary" role="status">
          {storeError ? `Paracord couldn't read how it's set up on this computer: ${storeError}` : 'Reading how it’s set up…'}
        </p>
      </div>
    );
  }
  if (!info.enabled) {
    return (
      <div data-testid="host-settings" data-state="removed">
        <SettingsSectionHeader title="Paracord on this computer" />
        <p className="text-body text-text-secondary" role="status">
          This computer isn&rsquo;t running a Paracord server.
        </p>
      </div>
    );
  }

  const view = hostSettingsView({ info, status, statusError, pending, startError, now });
  const port = info.port ?? status?.reachability.port ?? 8443;
  const serverName = server?.name ?? null;

  const startOrStop = async (which: 'start' | 'stop') => {
    setPending(which);
    setStartError(null);
    const host = useHostStore.getState();
    const ok = which === 'start' ? await host.start() : await host.stop();
    if (!mounted.current) return;
    if (!ok) {
      const reason = useHostStore.getState().error ?? 'it gave no reason';
      if (which === 'start') setStartError(reason);
      else note('service', { tone: 'fail', text: `It didn't stop: ${reason}` });
    } else {
      note('service', undefined);
    }
    setPending(null);
    await refresh();
  };

  const setAutostart = (next: boolean) =>
    withBusy('autostart', async () => {
      const ok = await useHostStore.getState().setAutostart(next);
      note('autostart', ok ? undefined : { tone: 'fail', text: `That didn't change: ${useHostStore.getState().error ?? 'no reason given'}` });
    });

  const recheck = () =>
    withBusy('reach', async () => {
      await useHostStore.getState().retryReachability();
      if (mounted.current) setNow(Date.now());
    });

  const allowFirewall = () =>
    withBusy('reach', async () => {
      const outcome = await useHostStore.getState().allowFirewall();
      if (outcome === 'declined') note('reach', { tone: 'fail', text: 'Windows asked and the change was declined, so the firewall still blocks friends.' });
      else note('reach', undefined);
    });

  const chip = (c: ReachChip) => {
    switch (c) {
      case 'show_me_how':
        return (
          <Button key={c} size="sm" variant="glass" onClick={() => setSheet('router')} data-testid="host-reach-howto">
            Show me how
          </Button>
        );
      case 'try_again':
        return (
          <Button key={c} size="sm" variant="glass" loading={busy.reach} onClick={() => void recheck()} data-testid="host-reach-retry">
            Try again
          </Button>
        );
      case 'what_can_i_do':
        return (
          <Button key={c} size="sm" variant="glass" onClick={() => setSheet('shared')} data-testid="host-reach-shared">
            What can I do?
          </Button>
        );
      case 'allow':
        return (
          <Button key={c} size="sm" variant="glass" loading={busy.reach} onClick={() => void allowFirewall()} data-testid="host-reach-allow">
            Allow
          </Button>
        );
    }
  };

  const backUpNow = () =>
    withBusy('backup', async () => {
      const done = await useHostStore.getState().backupNow();
      if (!mounted.current) return;
      note('backup', done ? { tone: 'ok', text: `Backed up: ${done.name}` } : { tone: 'fail', text: `The backup didn't finish: ${useHostStore.getState().error ?? 'no reason given'}` });
      await refresh();
    });

  const showLogs = async () => {
    const text = await useHostStore
      .getState()
      .logsTail(200)
      .catch((error: unknown) => `Paracord couldn't read the log: ${error instanceof Error ? error.message : String(error)}`);
    if (mounted.current) setLogs(text);
  };

  const rollback = () =>
    withBusy('rollback', async () => {
      const ok = await useHostStore.getState().rollbackUpdate();
      note('update', ok ? { tone: 'ok', text: 'Restored the backup from before the update.' } : { tone: 'fail', text: `Restoring didn't finish: ${useHostStore.getState().error ?? 'no reason given'}` });
      await refresh();
    });

  /**
   * §4.7 from Settings: seal the storage key under the signed-in owner's
   * recovery phrase. Uses the owner-only `POST /admin/storage-key/escrow` on
   * this computer's own server, so the server itself checks that the account
   * whose key is used is the one that set it up.
   */
  const saveEscrow = () =>
    withBusy('escrow', async () => {
      const instanceId = status?.instance_id ?? info.instance_id ?? null;
      try {
        if (!instanceId) throw new Error("This server has no instance id, so there is nothing to tie the copy to.");
        const home = info.home_url ? normalizeHomeOrigin(info.home_url) : null;
        if (!home || home !== homeOrigin() || !useAccountStore.getState().isUnlocked) throw new Error(ESCROW_COPY.needsUnlock);
        const wrappingKey = await withUnlockedPrivateKey(async (privateKey) => escrowWrappingKey(privateKey, instanceId));
        await getServerApi(LOCAL_SERVER_ID).post('/admin/storage-key/escrow', { wrapping_key: wrappingKey });
        note('escrow', { tone: 'ok', text: ESCROW_COPY.saved_now });
      } catch (error) {
        const code = (error as { response?: { status?: number } } | null)?.response?.status;
        if (code === 409 && /already escrowed/i.test(extractApiError(error) ?? '')) note('escrow', undefined);
        else if (code === 403) note('escrow', { tone: 'fail', text: 'Only the account that set up this server can do this.' });
        else note('escrow', { tone: 'fail', text: error instanceof Error && !code ? error.message : `It wasn't saved: ${extractApiError(error)}` });
      }
      await refresh();
    });

  const invite = () =>
    withBusy('invite', async () => {
      if (!server) return;
      const channels = useChannelStore.getState();
      if (!channels.channelsByGuild[server.key]) await channels.fetchChannels(server.id, server.scope).catch(() => undefined);
      const text = (useChannelStore.getState().channelsByGuild[server.key] ?? []).find(
        (c) => (c.type ?? c.channel_type) === ChannelType.Text,
      );
      if (!text) {
        note('invite', { tone: 'fail', text: `${server.name} has no text channel to invite people to.` });
        return;
      }
      note('invite', undefined);
      // The invite dialog belongs to the app, not to Settings: close Settings and open it there.
      onCloseSettings?.();
      openInvite({ guildName: server.name, channelId: text.id });
    });

  const copyWords = async () => {
    if (!words) return;
    try {
      await writeClipboardText(words);
      toast.success('Copied the words.');
    } catch (error) {
      toast.error(`Couldn't copy: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const { live } = view;
  const reach = status?.reachability ?? null;

  return (
    <div data-testid="host-settings" data-service={view.service.kind}>
      <SettingsSectionHeader
        title="Paracord on this computer"
        description={
          serverName
            ? `${serverName} runs here, in the background, even with this window closed.`
            : 'Your server runs here, in the background, even with this window closed.'
        }
      />

      {/* At a glance */}
      <section className="ix-host-glance pc-well" aria-labelledby="host-glance-state" data-testid="host-glance">
        <div className="ix-host-glance__top">
          <div className="min-w-0">
            <div className="ix-host-state" data-tone={view.service.tone} id="host-glance-state" role="status" aria-live="polite">
              <span className="ix-host-dot" aria-hidden />
              <span data-testid="host-state">{view.service.label}</span>
            </div>
            {view.facts && <p className="ix-host-facts">{view.facts}</p>}
          </div>
          <div className="ix-host-actions">
            {view.actions.stop && (
              <Button variant="glass" loading={pending === 'stop'} disabled={pending !== null} onClick={() => void startOrStop('stop')} data-testid="host-stop">
                <Power size={15} aria-hidden />
                Stop
              </Button>
            )}
            {view.actions.start && (
              <Button variant="primary" loading={pending === 'start'} disabled={pending !== null} onClick={() => void startOrStop('start')} data-testid="host-start">
                <Power size={15} aria-hidden />
                Start
              </Button>
            )}
          </div>
        </div>
        {view.service.reason && (
          <p className="ix-host-reason" data-tone={view.service.tone} data-testid="host-reason">
            {view.service.reason}
          </p>
        )}
        <Note value={notes.service} />
        {view.update && (
          <div className="ix-host-update" data-kind={view.update.kind} data-testid="host-update">
            <p>{view.update.text}</p>
            {view.update.kind === 'failed' && (
              <div className="ix-host-chips">
                <Button size="sm" variant="glass" loading={busy.rollback} onClick={() => void rollback()} data-testid="host-rollback">
                  {UPDATE_COPY.rollback}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => void showLogs()}>
                  Show details
                </Button>
              </div>
            )}
            <Note value={notes.update} />
          </div>
        )}
      </section>

      <ToggleRow
        className="mt-3 py-4"
        label="Starts when you sign in to this computer"
        description="Paracord starts your server in the background whenever you sign in, before you open this app."
        checked={info.autostart}
        onChange={(next) => void setAutostart(next)}
        disabled={busy.autostart}
      >
        <Note value={notes.autostart} />
      </ToggleRow>

      {live ? (
        <>
        <Row label="Friends outside your home" testId="host-row-reach">
          <>
              <Line tone={live.reach.tone} testId="host-reach">
                {live.reach.text}
              </Line>
              {live.reach.note && <p className="ix-host-sub">{live.reach.note}</p>}
              {(live.reach.chips.length > 0 || live.reach.recheck) && (
                <div className="ix-host-chips">
                  {live.reach.chips.map(chip)}
                  {live.reach.recheck && (
                    <Button size="sm" variant="glass" loading={busy.reach} onClick={() => void recheck()} data-testid="host-reach-recheck">
                      <RotateCw size={14} aria-hidden />
                      Check the router again
                    </Button>
                  )}
                </div>
              )}
              <Note value={notes.reach} />
            </>
        </Row>

        <Row label="This server's words" testId="host-row-words">
          {words ? (
            <>
              <div className="ix-host-words">
                <span data-testid="host-words">{words}</span>
                <Button size="sm" variant="ghost" onClick={() => void copyWords()} aria-label="Copy the words">
                  <Copy size={14} aria-hidden />
                  Copy
                </Button>
              </div>
              <p className="ix-host-sub">
                When a friend joins, Paracord shows them four words for your server. Read these to them: if theirs match, they reached this computer and nobody in between.
              </p>
            </>
          ) : (
            <Missing text="Working out the words…" />
          )}
        </Row>

        <Row label="Stored messages and files" testId="host-row-storage">
          <>
              <Line tone={live.storage.tone} testId="host-storage">
                {live.storage.text}
              </Line>
              {live.storage.escrow && (
                <div className="ix-host-escrow" data-testid="host-escrow" data-saved={!live.storage.escrow.canSave}>
                  <Line tone={live.storage.escrow.tone}>{live.storage.escrow.text}</Line>
                  {live.storage.escrow.canSave && (
                    <div className="ix-host-chips">
                      <Button size="sm" variant="glass" loading={busy.escrow} onClick={() => void saveEscrow()} data-testid="host-escrow-save">
                        {ESCROW_COPY.saveNow}
                      </Button>
                    </div>
                  )}
                </div>
              )}
              <Note value={notes.escrow} />
            </>
        </Row>

        <Row label="Backups" testId="host-row-backups">
          <>
              <Line tone={live.backups.tone} testId="host-backup">
                {live.backups.text}
              </Line>
              <p className="ix-host-sub">{live.backups.note}</p>
              <div className="ix-host-chips">
                <Button size="sm" variant="glass" loading={busy.backup} onClick={() => void backUpNow()} data-testid="host-backup-now">
                  <HardDriveDownload size={14} aria-hidden />
                  Back up now
                </Button>
              </div>
              <Note value={notes.backup} />
            </>
        </Row>
        </>
      ) : (
        <Row label="While it runs" testId="host-row-live">
          <Missing text={view.liveMissing} />
        </Row>
      )}

      {server && (
        <Row label="Invite friends" testId="host-row-invite">
          <p className="ix-host-sub ix-host-sub--first">Make a link to {server.name} and send it to people you want in.</p>
          <div className="ix-host-chips">
            <Button size="sm" variant="glass" loading={busy.invite} disabled={!live} onClick={() => void invite()} data-testid="host-invite">
              <UserPlus size={14} aria-hidden />
              Invite people
            </Button>
          </div>
          <Note value={notes.invite} />
        </Row>
      )}

      <Row label="When something's wrong" testId="host-row-logs">
        <p className="ix-host-sub ix-host-sub--first">What your server wrote most recently. Passwords and keys are never in it.</p>
        <div className="ix-host-chips">
          <Button size="sm" variant="glass" onClick={() => void showLogs()} data-testid="host-logs">
            <FileText size={14} aria-hidden />
            Show logs
          </Button>
        </div>
      </Row>

      <Row label="Remove" testId="host-row-remove">
        <p className="ix-host-sub ix-host-sub--first">
          Stop running a server on this computer. Its messages and files are kept unless you choose to delete them.
        </p>
        <div className="ix-host-chips">
          <Button size="sm" variant="danger" onClick={() => setRemoveOpen(true)} data-testid="host-remove">
            <Trash2 size={14} aria-hidden />
            Remove from this computer
          </Button>
        </div>
      </Row>

      {reach && (
        <>
          <RouterSheet
            open={sheet === 'router'}
            onClose={() => setSheet(null)}
            variant={reach.state === 'no_answer' ? 'no_answer' : 'refused'}
            gatewayIp={reach.gateway_ip}
            lanIp={reach.lan_ip}
            port={port}
            zIndexClassName={OVER_SETTINGS}
          />
          <SharedAddressSheet open={sheet === 'shared'} onClose={() => setSheet(null)} port={port} zIndexClassName={OVER_SETTINGS} />
        </>
      )}

      <Modal open={logs !== null} onClose={() => setLogs(null)} size="lg" labeledBy="ix-host-logs-title" describedBy="ix-host-logs-desc" zIndexClassName={OVER_SETTINGS}>
        <ModalHeader>
          <ModalTitle id="ix-host-logs-title">What your server wrote</ModalTitle>
          <ModalDescription id="ix-host-logs-desc">The last lines Paracord on this computer wrote. Passwords and keys are never in it.</ModalDescription>
        </ModalHeader>
        <ModalBody>
          <pre className="ix-host-log" data-testid="host-log">
            {logs || 'Nothing was written.'}
          </pre>
        </ModalBody>
        <ModalFooter>
          <Button variant="primary" onClick={() => setLogs(null)} autoFocus>
            Close
          </Button>
        </ModalFooter>
      </Modal>

      <RemoveHostDialog
        key={removeOpen ? 'open' : 'closed'}
        open={removeOpen}
        serverName={serverName}
        onClose={() => setRemoveOpen(false)}
        onRemove={async (deleteData) => {
          const ok = await useHostStore.getState().remove(deleteData);
          if (!ok) throw new Error(useHostStore.getState().error ?? 'it gave no reason');
          toast.success(deleteData ? 'Paracord and its data were removed from this computer.' : 'Paracord was removed from this computer. Its data is kept.');
        }}
      />
    </div>
  );
}

function Row({ label, children, testId }: { label: string; children: ReactNode; testId: string }) {
  return (
    <section className="ix-host-row" data-testid={testId}>
      <h3 className="ix-label text-text-muted">{label}</h3>
      <div className="ix-host-row__body">{children}</div>
    </section>
  );
}

function Line({ tone, children, testId }: { tone: Tone; children: ReactNode; testId?: string }) {
  return (
    <p className="ix-host-line" data-tone={tone} data-testid={testId}>
      <span className="ix-host-dot" aria-hidden />
      <span>{children}</span>
    </p>
  );
}

function Missing({ text }: { text: string | null }) {
  return <p className="ix-host-sub ix-host-sub--first">{text}</p>;
}

function Note({ value }: { value: { tone: 'ok' | 'fail'; text: string } | undefined }) {
  if (!value) return null;
  return (
    <p className="ix-host-note" data-tone={value.tone} role={value.tone === 'fail' ? 'alert' : 'status'}>
      {value.text}
    </p>
  );
}
