import { getServerApi } from '../../api/activeClient';
import { extractApiError } from '../../api/client';
import type { HostStatus } from '../../api/generated/HostStatus';
import type { InvitePreview } from '../../api/generated/InvitePreview';
import { setStoredServerUrl } from '../../lib/config/apiBaseUrl';
import { withExplicitActivityOff } from '../../lib/features/privacyDefaults';
import { adoptNewAccount, confirmRecoverySaved, prepareNewIdentity, signUpWithPassword } from '../../lib/oneCredential';
import { OlderServerError } from '../../lib/serverFeatures';
import { LOCAL_SERVER_ID } from '../../lib/serverScope';
import { isTauri } from '../../lib/tauriEnv';
import { probeServerIdentity, trustServer } from '../../lib/trustedHosts';
import { useAuthStore } from '../../stores/authStore';
import { useFirstRunStore, type AccountField, type FirstRunResult } from '../../stores/firstRunStore';
import type { LoginResponse } from '../../types';
import { useHostStore } from '../../stores/hostStore';
import { escrowWrappingKey } from './escrow';
import { hostOf } from './inviteCheck';
import { acceptInvite, firstTextChannel } from './landing';
import { CLAIM_STORAGE_OFF_WARN, hostRows, joinRows, RowSequencer, storageCopy } from './rows';
import { privateKeyFromPhrase } from '../../lib/credential/phrase';
import { backupDate, backupProblem, keyForBackup, phraseWords, RESTORE_COPY, RESTORE_ROW, restoreFailure, restoreRow } from './restore';

/**
 * What the first run's steps do (docs/setup-spec.md §1.4–§1.8, §2.6, §2.11,
 * §6.6). The screens call these; these write the outcome into
 * `useFirstRunStore`. Account work goes through the one-password flows
 * (`lib/oneCredential`), host work through the shell's host commands.
 */

const store = () => useFirstRunStore.getState();

export function errorMessage(error: unknown): string {
  // The desktop shell's commands reject with their sentence as a plain string.
  if (typeof error === 'string' && error) return error;
  if (error instanceof OlderServerError) return 'This server runs an older version of Paracord. Ask the person who runs it to update, then try again.';
  const fromApi = extractApiError(error);
  if (fromApi && fromApi !== 'unauthorized') return fromApi;
  if (error instanceof Error && error.message) return error.message;
  return typeof error === 'string' ? error : 'Something went wrong.';
}

/* ---- Host › Name: preflight (§2.3) ---------------------------------------- */

let preflightRun = 0;

export async function startPreflight(): Promise<void> {
  const run = ++preflightRun;
  store().setPreflight({ status: 'checking', result: null, error: null });
  const result = await useHostStore.getState().runPreflight();
  if (run !== preflightRun) return;
  if (result) store().setPreflight({ status: 'done', result, error: null });
  else store().setPreflight({ status: 'error', error: useHostStore.getState().preflightError ?? 'The check did not answer.' });
}

/* ---- Account errors that belong under a field (§1.6) ----------------------- */

/**
 * A refusal the Account step can fix: the flow goes back there with the reason
 * under the field, and Setup resets (§1.6).
 */
function accountFieldFor(error: unknown): { field: AccountField; message: string } | null {
  const status = (error as { response?: { status?: number } } | null)?.response?.status;
  const message = extractApiError(error) ?? '';
  const lower = message.toLowerCase();
  if (status === 400 || status === 409 || status === 422) {
    if (lower.includes('email')) return { field: 'email', message: message || 'That email cannot be used here.' };
    if (lower.includes('unable to complete registration') || lower.includes('taken') || lower.includes('already')) {
      return { field: 'username', message: 'That username, or that email, is already used on this server. Try another.' };
    }
    if (lower.includes('username')) return { field: 'username', message };
    if (lower.includes('display name')) return { field: 'displayName', message };
    if (lower.includes('invite')) return { field: 'form', message };
  }
  return null;
}

export class BackToAccount extends Error {
  constructor(
    readonly field: AccountField,
    message: string,
  ) {
    super(message);
  }
}

/* ---- Setup ------------------------------------------------------------------ */

let sequencer: RowSequencer | null = null;
let setupRun = 0;

function beginRows(rows: ReturnType<typeof hostRows>): RowSequencer {
  sequencer?.stop();
  const s = store();
  s.setRows(rows);
  s.setSetupStatus('running');
  const seq = new RowSequencer(rows, (shown) => {
    useFirstRunStore.getState().setRows(shown);
    const failed = shown.some((r) => r.state === 'fail');
    const settled = shown.every((r) => r.state === 'ok' || r.state === 'warn');
    if (failed) useFirstRunStore.getState().setSetupStatus('failed');
    else if (settled) useFirstRunStore.getState().setSetupStatus('done');
  });
  sequencer = seq;
  return seq;
}

export function stopSetup(): void {
  setupRun += 1;
  sequencer?.stop();
  sequencer = null;
}

/** Turns an account-step refusal into "go back to Account"; anything else fails the row. */
function failRow(seq: RowSequencer, row: number, error: unknown): void {
  const field = accountFieldFor(error);
  if (field) {
    store().setError(field.field, field.message);
    stopSetup();
    store().setRows([]);
    store().setSetupStatus('idle');
    throw new BackToAccount(field.field, field.message);
  }
  seq.set(row, { state: 'fail', detail: errorMessage(error) });
}

async function recordPrivacyDefaults(): Promise<void> {
  const auth = useAuthStore.getState();
  await auth.fetchSettings();
  const settings = useAuthStore.getState().settings;
  if (!settings) return;
  await auth.updateSettings({ notifications: withExplicitActivityOff(settings.notifications) });
}

function finishAccount(phrase: string, result: FirstRunResult): void {
  const s = store();
  s.setPhrase(phrase.trim().split(/\s+/));
  s.forgetPassword();
  s.setResult(result);
}

/** The loopback address of this computer's own server (§2.5). */
export const loopbackUrl = (port: number) => `https://127.0.0.1:${port}`;

/**
 * Host setup on the desktop (§2.6), through the host store: rows 1-2 in the
 * shell, row 3 here (the owner account, claimed on this computer's own server,
 * and the storage key escrowed under its phrase), then rows 4-5 in the shell.
 */
export async function runHostSetup(): Promise<void> {
  const port = store().preflight.result?.port;
  if (!port) throw new Error('Paracord has not checked this computer yet.');
  setupRun += 1;
  store().setSetupStatus('running');
  const phase = await useHostStore.getState().runSetup({ port, account: () => createHostAccount(port) });
  store().setSetupStatus(phase === 'done' ? 'done' : phase === 'failed' ? 'failed' : 'running');
}

/** Host row 3 (§2.6, §4.7). Rejects with the row's detail. */
async function createHostAccount(port: number): Promise<void> {
  const s = store();
  const name = s.serverName.trim();
  const host = useHostStore.getState();
  try {
    const info = await host.loadInfo();
    const instanceId = info?.instance_id;
    if (!instanceId) throw new Error("Paracord on this computer didn't say which server it is, so your recovery phrase can't protect its storage key.");
    setStoredServerUrl(info?.home_url ?? loopbackUrl(port));
    const prepared = await prepareNewIdentity(s.account.password);
    let claim: ClaimResponse;
    let wrappingKey: string;
    try {
      wrappingKey = escrowWrappingKey(prepared.privateKey, instanceId);
      claim = (await host.claim({
        username: s.account.username.trim(),
        display_name: s.account.displayName.trim() || null,
        email: null,
        credential: prepared.credential,
        identity: prepared.identity,
        instance_name: name,
        initial_space_name: name,
        initial_space_hue: s.hue,
        initial_space_template: 'friends',
      })) as ClaimResponse;
    } catch (error) {
      prepared.privateKey.fill(0);
      throw error;
    }
    const { phrase } = await adoptNewAccount(prepared, claim, [s.account.username.trim()]);
    await recordPrivacyDefaults().catch(() => undefined);
    await host.writeEscrow(wrappingKey);
    const guildId = claim.space?.id ?? null;
    const channelId = guildId ? await firstTextChannel(guildId, claim.space?.system_channel_id ?? null) : null;
    finishAccount(phrase, { serverUrl: info?.home_url ?? loopbackUrl(port), guildId, channelId, serverName: name, hue: s.hue });
  } catch (error) {
    const field = accountFieldFor(error);
    if (field) {
      store().setError(field.field, field.message);
      store().setSetupStatus('idle');
      backListener?.(new BackToAccount(field.field, field.message));
    }
    throw new Error(errorMessage(error));
  }
}

/* ---- "Try again" on a row (§1.7) -------------------------------------------- */

/** Claim mode's row 4 Try again (§5.3): ask the router now, then read what it said. The desktop's is the host store's. */
export async function retryReach(): Promise<void> {
  const seq = sequencer;
  if (!seq) return;
  seq.set(4, { state: 'run' });
  try {
    await getServerApi(LOCAL_SERVER_ID).post('/admin/reachability/retry');
    const status = await waitForReach();
    seq.set(4, reachTarget(status));
  } catch (error) {
    seq.set(4, { state: 'warn', detail: errorMessage(error), code: 'error' });
  }
}

async function readStatus(): Promise<HostStatus> {
  return (await getServerApi(LOCAL_SERVER_ID).get<HostStatus>('/admin/host-status')).data;
}

/** Poll the status once a second while the router is being asked (≤ 15 s, §2.6). */
async function waitForReach(): Promise<HostStatus> {
  const deadline = Date.now() + 15_000;
  let status = await readStatus();
  while (status.reachability.state === 'asking' && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    status = await readStatus();
  }
  return status;
}

/** Row 4's outcome per spec §5.4. */
export function reachTarget(status: HostStatus): { state: 'ok' | 'warn'; detail: string; code: string } {
  const r = status.reachability;
  const ip = r.external_ip ?? '';
  switch (r.state) {
    case 'open':
      return { state: 'ok', code: r.state, detail: `Your router opened the way. Friends can reach you at ${ip}.` };
    case 'direct':
      return { state: 'ok', code: r.state, detail: `This computer has its own public address (${ip}). Friends can reach it if your firewall allows port ${r.port}.` };
    case 'refused':
      return { state: 'warn', code: r.state, detail: "Your router didn't allow it, so for now only people on your home network can join." };
    case 'no_answer':
      return { state: 'warn', code: r.state, detail: "Your router didn't answer, so for now only people on your home network can join." };
    case 'shared_address':
      return {
        state: 'warn',
        code: r.state,
        detail:
          "Your internet connection shares its public address with others (your provider, or another router in front of yours), so friends outside can't reach this computer. People on your home network can join.",
      };
    case 'firewall_blocked':
      return { state: 'warn', code: r.state, detail: 'Windows Firewall is blocking friends.' };
    case 'asking':
      return { state: 'warn', code: r.state, detail: "Your router hasn't answered yet. Paracord keeps asking." };
    default:
      return { state: 'warn', code: r.state, detail: "Paracord isn't asking your router to let friends in." };
  }
}

/** A failed row's Try again: the whole setup again (completed steps are skipped, §2.6). */
export async function retrySetup(): Promise<void> {
  const s = store();
  if (s.mode === 'claim') return runClaimSetup();
  if (s.path === 'join') return runJoinSetup();
  if (s.path === 'restore') {
    // The restore itself failed (nothing was kept): run it again. A later row: resume the host rows.
    if (s.rows.find((r) => r.row === RESTORE_ROW)?.state !== 'ok') return runRestoreSetup();
    setupRun += 1;
    s.setSetupStatus('running');
    const phase = await useHostStore.getState().retry();
    finishRestore(phase);
    return;
  }
  setupRun += 1;
  s.setSetupStatus('running');
  const phase = await useHostStore.getState().retry();
  store().setSetupStatus(phase === 'done' ? 'done' : 'failed');
}

/* ---- Claim mode: a headless install (§2.11) ----------------------------------- */

let claimToken: string | null = null;

export function setClaimToken(token: string | null): void {
  claimToken = token;
}

export function hasClaimToken(): boolean {
  return Boolean(claimToken);
}

interface ClaimResponse extends LoginResponse {
  space?: { id: string; name: string; system_channel_id?: string | null };
  instance_name?: string;
}

export async function runClaimSetup(): Promise<void> {
  const run = ++setupRun;
  const s = store();
  const name = s.serverName.trim();
  const seq = beginRows(hostRows({ claim: true }));
  seq.set(3, { state: 'run' });
  try {
    if (!claimToken) throw new Error('This page needs the setup link your server printed. Open that link again.');
    const prepared = await prepareNewIdentity(s.account.password);
    let claim: ClaimResponse;
    try {
      ({ data: claim } = await getServerApi(LOCAL_SERVER_ID).post<ClaimResponse>('/setup/credential-claim', {
        token: claimToken,
        username: s.account.username.trim(),
        display_name: s.account.displayName.trim() || null,
        email: s.requireEmail ? s.account.email.trim() : null,
        credential: prepared.credential,
        identity: prepared.identity,
        instance_name: name,
        initial_space_name: name,
        initial_space_hue: s.hue,
        initial_space_template: 'friends',
      }));
    } catch (error) {
      prepared.privateKey.fill(0);
      throw error;
    }
    if (run !== setupRun) return;
    claimToken = null;
    const { phrase } = await adoptNewAccount(prepared, claim, [s.account.username.trim()]);
    await recordPrivacyDefaults().catch(() => undefined);
    const guildId = claim.space?.id ?? null;
    const channelId = guildId ? await firstTextChannel(guildId, claim.space?.system_channel_id ?? null) : null;
    finishAccount(phrase, { serverUrl: window.location.origin, guildId, channelId, serverName: name, hue: s.hue });
    seq.set(3, { state: 'ok' });
  } catch (error) {
    try {
      failRow(seq, 3, error);
    } catch (back) {
      notifyBackToAccount(back);
    }
    return;
  }

  // The rest is read from the server, now as its owner (§2.11).
  seq.set(2, { state: 'run' });
  let status: HostStatus;
  try {
    status = (await getServerApi(LOCAL_SERVER_ID).get<HostStatus>('/admin/host-status')).data;
  } catch (error) {
    seq.set(2, { state: 'fail', detail: `Couldn't read this server's status (${errorMessage(error)}).` });
    return;
  }
  if (run !== setupRun) return;
  const encrypted = status.storage.sqlite_encrypted && status.storage.files_encrypted;
  if (!encrypted) {
    seq.set(2, { state: 'warn', detail: CLAIM_STORAGE_OFF_WARN, code: 'storage_off' });
  } else {
    // The same escrow as the desktop's row 3 (§4.7): the owner's phrase can restore the storage key.
    const escrow = await escrowAfterClaim(status);
    if (run !== setupRun) return;
    seq.set(2, escrow ? { state: 'warn', detail: escrow, code: 'escrow_failed' } : { state: 'ok', detail: storageCopy(status.storage.protection, true) });
  }
  if (status.reachability.state === 'off') {
    // The row is not shown when the server is not asking its router (§5.4).
    seq.drop(4);
  } else {
    seq.set(4, reachTarget(status.reachability.state === 'asking' ? await waitForReach() : status));
  }
  seq.set(
    5,
    status.backups.enabled
      ? { state: 'ok', detail: `Kept on the server for ${status.backups.keep} days.` }
      : { state: 'warn', detail: 'Daily backups are off on this server.', code: 'backups_off' },
  );
}

/**
 * Claim mode's escrow (§2.11, §4.7): `POST /admin/storage-key/escrow` with the
 * key derived from the new owner's phrase and the server's instance id.
 * Returns null when the key is escrowed (now or already), else the storage
 * row's warning. The account exists either way, so this never fails setup.
 */
async function escrowAfterClaim(status: HostStatus): Promise<string | null> {
  if (status.storage.escrowed) return null;
  const kept = ' Keep a copy of the storage key somewhere safe; see docs/encryption.md.';
  const instanceId = status.instance_id;
  if (!instanceId) {
    return `Encrypted on disk. This server has no instance id, so your recovery phrase can't restore its storage key.${kept}`;
  }
  const words = store().phrase;
  if (!words) return `Encrypted on disk, but Paracord no longer has your recovery phrase to protect its key with.${kept}`;
  try {
    const key = privateKeyFromPhrase(words.join(' '));
    let wrappingKey: string;
    try {
      wrappingKey = escrowWrappingKey(key, instanceId);
    } finally {
      key.fill(0);
    }
    await getServerApi(LOCAL_SERVER_ID).post('/admin/storage-key/escrow', { wrapping_key: wrappingKey });
    return null;
  } catch (error) {
    const statusCode = (error as { response?: { status?: number } } | null)?.response?.status;
    // 409 "already escrowed": a page reloaded after the escrow. It is this owner's, written once.
    if (statusCode === 409 && /already escrowed/i.test(extractApiError(error) ?? '')) return null;
    return `Encrypted on disk, but your recovery phrase couldn't be set up to restore its key (${errorMessage(error)}).${kept}`;
  }
}

/* ---- Join setup (§1.7 join rows, §6.6) ---------------------------------------- */

export async function runJoinSetup(): Promise<void> {
  const run = ++setupRun;
  const s = store();
  const { invite } = s;
  const link = invite.link;
  const preview = invite.preview as InvitePreview | null;
  if (!link || !preview?.guild) throw new Error('There is no invite to join with.');
  const serverName = preview.guild.name;
  const web = s.mode === 'web';
  const seq = beginRows(joinRows(serverName, { web }));

  if (!web) {
    seq.set(1, { state: 'run' });
    try {
      // The identity the person accepted is the one the server still presents.
      const probe = await probeServerIdentity(link.serverUrl);
      const shown = invite.identity?.fingerprint ?? null;
      if (shown && probe.fingerprint !== shown) throw new Error("This server's identity changed while you were looking at it.");
      if (run !== setupRun) return;
      seq.set(1, { state: 'ok' });
    } catch (error) {
      seq.set(1, { state: 'fail', detail: errorMessage(error) });
      return;
    }
    setStoredServerUrl(link.serverUrl);
  }

  seq.set(2, { state: 'run' });
  let phrase: string;
  try {
    const result = await signUpWithPassword({
      username: s.account.username.trim(),
      password: s.account.password,
      displayName: s.account.displayName.trim() || undefined,
      email: s.requireEmail ? s.account.email.trim() : undefined,
      inviteCode: link.code,
    });
    phrase = result.phrase;
  } catch (error) {
    try {
      failRow(seq, 2, error);
    } catch (back) {
      notifyBackToAccount(back);
    }
    return;
  }
  if (run !== setupRun) return;
  seq.set(2, { state: 'ok' });

  seq.set(3, { state: 'run' });
  try {
    const joined = await acceptInvite(link.code);
    finishAccount(phrase, {
      serverUrl: link.serverUrl,
      guildId: joined.guildId,
      channelId: joined.channelId,
      serverName: joined.name || serverName,
      hue: preview.guild.hue ?? 200,
    });
    seq.set(3, { state: 'ok' });
  } catch (error) {
    seq.set(3, { state: 'fail', detail: errorMessage(error) });
  }
}

/* ---- Restore from a backup (§1.4, §4.8) ---------------------------------------------- */

/** Restore › Backup: the system file picker, and whether the file can be restored with a phrase. */
export async function pickBackup(): Promise<void> {
  const s = store();
  if (s.restore.picking) return;
  s.setRestore({ picking: true });
  try {
    const file = await useHostStore.getState().pickBackup();
    if (!file) return; // The picker was closed: keep what was there.
    store().setRestore({ file });
    const problem = backupProblem(file);
    if (problem) store().setRestoreError('file', problem);
  } catch (error) {
    store().setRestore({ file: null });
    store().setRestoreError('file', errorMessage(error));
  } finally {
    store().setRestore({ picking: false });
  }
}

/** Restore › Backup › Restore: the phrase must be the backup owner's (checked here, before anything runs). */
export async function checkRestorePhrase(): Promise<boolean> {
  const { file, phrase } = store().restore;
  if (!file) {
    store().setRestoreError('file', 'Choose the backup to restore.');
    return false;
  }
  const problem = backupProblem(file);
  if (problem) {
    store().setRestoreError('file', problem);
    return false;
  }
  try {
    const key = await keyForBackup(phrase, file);
    key.fill(0);
    return true;
  } catch (error) {
    store().setRestoreError('phrase', errorMessage(error));
    return false;
  }
}

/** The escrow key for `instanceId` from the phrase in memory (zeroed straight after). */
function restoreWrappingKey(instanceId: string): string {
  const key = privateKeyFromPhrase(phraseWords(store().restore.phrase).join(' '));
  try {
    return escrowWrappingKey(key, instanceId);
  } finally {
    key.fill(0);
  }
}

function finishRestore(phase: string): void {
  const s = store();
  if (phase === 'done') {
    // The restored server has its escrow again: the phrase is not needed any more.
    s.setRestore({ phrase: '' });
    s.setSetupStatus('done');
  } else {
    s.setSetupStatus('failed');
  }
}

/**
 * Restore › Setup (§4.8): the restore (install, init, the generated key taken
 * back, `restore-backup --escrow-key-stdin`), then the host rows. The owner
 * came with the backup, so there is no claim; the restored server is a new
 * instance, so row 3 escrows the storage key again under the same phrase
 * before rows 4 and 5 (the first backup after a restore carries it again).
 */
export async function runRestoreSetup(): Promise<void> {
  const run = ++setupRun;
  const s = store();
  const file = s.restore.file;
  if (!file?.escrow) throw new Error('Choose the backup to restore.');
  s.setRows([restoreRow('run')]);
  s.setSetupStatus('running');
  const since = Date.now();
  try {
    const key = await keyForBackup(s.restore.phrase, file);
    let archiveKey: string;
    try {
      archiveKey = escrowWrappingKey(key, file.escrow.instance_id);
    } finally {
      key.fill(0);
    }
    await useHostStore.getState().restore(file.path, archiveKey);
  } catch (error) {
    if (run !== setupRun) return;
    const failure = restoreFailure(errorMessage(error));
    s.setRows([restoreRow('fail', failure.detail, failure.retry ? ['retry-row'] : undefined)]);
    s.setSetupStatus('failed');
    return;
  }
  const wait = 300 - (Date.now() - since);
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  if (run !== setupRun) return;
  store().setRows([restoreRow('ok', `Restored from the backup of ${backupDate(file)}.`)]);

  const info = await useHostStore.getState().loadInfo();
  const port = info?.port ?? s.preflight.result?.port;
  if (!port || !info?.home_url) {
    store().setSetupStatus('failed');
    throw new Error("Paracord on this computer didn't say where it runs after the restore.");
  }
  setStoredServerUrl(info.home_url);
  const phase = await useHostStore.getState().runSetup({
    port,
    account: async () => {
      const instanceId = (await useHostStore.getState().loadInfo())?.instance_id;
      if (!instanceId) throw new Error("Paracord on this computer didn't say which server it is, so your recovery phrase can't protect its storage key.");
      await useHostStore.getState().writeEscrow(restoreWrappingKey(instanceId));
    },
  });
  if (run !== setupRun) return;
  finishRestore(phase);
}

export { RESTORE_COPY };

/* ---- Join › Invite: trusting the server the card showed (§7.3) ------------------- */

/** Continue on the invite card: pin exactly the identity that was shown. */
export async function trustInvitedServer(): Promise<void> {
  const { invite } = store();
  if (!isTauri() || !invite.link) return;
  const fp = invite.identity?.fingerprint;
  if (!fp) throw new Error(`Paracord couldn't see ${invite.host ?? hostOf(invite.link.serverUrl)}'s identity. Try again.`);
  await trustServer(invite.link.serverUrl, fp);
}

/* ---- Recovery phrase (§1.8) ------------------------------------------------------- */

export async function confirmPhrase(): Promise<void> {
  await confirmRecoverySaved();
}

/* ---- Back to the Account step ------------------------------------------------------- */

type BackListener = (back: BackToAccount) => void;
let backListener: BackListener | null = null;

/** The page navigates; the flows only say where to. */
export function onBackToAccount(listener: BackListener | null): void {
  backListener = listener;
}

function notifyBackToAccount(back: unknown): void {
  if (back instanceof BackToAccount) backListener?.(back);
}
