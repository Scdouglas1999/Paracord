import { create } from 'zustand';

import type { HostPreflight } from '../api/generated/HostPreflight';
import type { InvitePreview } from '../api/generated/InvitePreview';
import type { InviteLink } from '../lib/inviteLinks';
import { getVersionedStorageItem, setVersionedStorageItem } from '../lib/versionedStorage';

/**
 * The first run's state (docs/setup-spec.md §1, §9.6): which path, which step,
 * what the person typed, the setup rows, and the errors. The step in the URL
 * (`/welcome/host/:step`, `/welcome/join/:step`) is for back/forward and tests;
 * this store is what the screens read.
 *
 * Nothing secret is persisted. The password lives here only while the Account
 * and Setup steps need it and is dropped the moment the account exists; the
 * recovery phrase is held in memory only (§1.8).
 */

export type FirstRunPath = 'host' | 'join';
/**
 * Where the first run is running:
 * - `desktop`: the desktop app with no servers (launch, welcome, both paths);
 * - `claim`: a headless install's `/setup-server#claim=…` page (§2.11): the host
 *   path without the launch, the welcome or row 1;
 * - `web`: a browser on a server's own `/invite/:code` page (§6.6).
 */
export type FirstRunMode = 'desktop' | 'claim' | 'web';

export type HostStep = 'name' | 'account' | 'setup' | 'phrase' | 'invite';
export type JoinStep = 'invite' | 'account' | 'setup' | 'phrase';
export type FlowStep = HostStep | JoinStep;

export const HOST_STEPS: readonly HostStep[] = ['name', 'account', 'setup', 'phrase', 'invite'];
export const JOIN_STEPS: readonly JoinStep[] = ['invite', 'account', 'setup', 'phrase'];

export function stepsOf(path: FirstRunPath): readonly FlowStep[] {
  return path === 'host' ? HOST_STEPS : JOIN_STEPS;
}

export function isStepOf(path: FirstRunPath, step: string | undefined): step is FlowStep {
  return !!step && (stepsOf(path) as readonly string[]).includes(step);
}

/** The welcome screen counts as step 0: `n = steps − 1` segments, `k` filled when `k < index` (§1.1). */
export function progressOf(path: FirstRunPath, step: FlowStep): { segments: number; filled: number } {
  const steps = stepsOf(path);
  return { segments: steps.length, filled: steps.indexOf(step) + 1 };
}

/** Where the whole window is. */
export type FirstRunPhase =
  /** The launch sequence (§1.2): the mark draws itself, then glides into the welcome. */
  | 'launch'
  | 'welcome'
  /** A side was picked: it opens to the full window before the steps begin. */
  | 'choosing'
  | 'flow'
  | 'sign-in'
  /** The preview is growing into the app (§1.13 Done). */
  | 'done';

export type RowState = 'waiting' | 'run' | 'ok' | 'warn' | 'fail';
export type RowChip = 'show-me-how' | 'try-again' | 'what-can-i-do' | 'allow' | 'show-details' | 'retry-row';

export interface SetupRow {
  /** Spec §1.7 numbering: host 1-5, join 1-3. */
  row: number;
  title: string;
  /** The line under the title while waiting or running. */
  pending: string;
  state: RowState;
  /** The line once it settled (done, warn or fail copy). */
  detail?: string;
  /** A machine-readable code (a reachability state, a failure reason). */
  code?: string;
  chips?: RowChip[];
  /** When the row started running, to hold it in `run` for at least 300ms (§1.7). */
  startedAt?: number;
}

export type InviteState =
  | 'empty'
  | 'checking'
  | 'card'
  | 'invalid'
  | 'unreachable'
  | 'old-server'
  | 'identity-changed'
  /** The text is not an invite link (no request is made). */
  | 'not-a-link';

export interface InviteIdentity {
  /** Hex SHA-256 of the leaf certificate the server presented (desktop); null on the web. */
  fingerprint: string | null;
  caVerified: boolean;
  /** The four words for `fingerprint` (§7.1); empty when CA-verified or on the web. */
  words: string[];
}

export interface InviteCheck {
  state: InviteState;
  link: InviteLink | null;
  preview: InvitePreview | null;
  identity: InviteIdentity | null;
  /** The host as shown ("kanto.home.arpa"). */
  host: string | null;
}

export interface AccountFields {
  displayName: string;
  username: string;
  /** Username was typed by hand: stop filling it from the display name. */
  usernameEdited: boolean;
  email: string;
  password: string;
}

export type AccountField = 'displayName' | 'username' | 'email' | 'password' | 'form';

export type SheetId = 'protected' | 'router' | 'shared' | 'identity' | 'details' | null;

/** What the finished account and server are, for the Invite step and the landing. */
export interface FirstRunResult {
  serverUrl: string;
  guildId: string | null;
  channelId: string | null;
  serverName: string;
  hue: number;
}

export const DEFAULT_HUE = 18;
export const HOST_HUES = [18, 350, 38, 150, 172, 200, 220, 0] as const;
/** The join path's stage hue before an invite is chosen (prototype). */
export const JOIN_HUE = 200;

interface FirstRunState {
  mode: FirstRunMode;
  phase: FirstRunPhase;
  path: FirstRunPath | null;
  /** The furthest step reached on the current path, so back/forward cannot skip ahead. */
  reached: number;

  /** Host › Name. */
  serverName: string;
  hue: number;
  preflight: { status: 'idle' | 'checking' | 'done' | 'error'; result: HostPreflight | null; error: string | null };

  /** Join › Invite. */
  inviteText: string;
  invite: InviteCheck;
  /** An invite found on the clipboard, offered with the banner (not filled). */
  clipboardInvite: InviteLink | null;

  /** Account. */
  account: AccountFields;
  /** `require_email` from the server (`auth/options`, or the invite preview's instance). */
  requireEmail: boolean;
  errors: Partial<Record<AccountField, string>>;

  /** Setup. */
  rows: SetupRow[];
  setupStatus: 'idle' | 'running' | 'done' | 'failed';

  /** Recovery phrase (memory only). */
  phrase: string[] | null;
  phraseRevealed: boolean;
  phraseSaved: boolean;

  /** The finished server, once the account exists. */
  result: FirstRunResult | null;

  sheet: SheetId;

  setMode: (mode: FirstRunMode) => void;
  setPhase: (phase: FirstRunPhase) => void;
  choosePath: (path: FirstRunPath) => void;
  noteReached: (index: number) => void;
  setServerName: (name: string) => void;
  setHue: (hue: number) => void;
  setPreflight: (preflight: Partial<FirstRunState['preflight']>) => void;
  setInviteText: (text: string) => void;
  setInvite: (invite: Partial<InviteCheck>) => void;
  setClipboardInvite: (link: InviteLink | null) => void;
  setAccount: (fields: Partial<AccountFields>) => void;
  setRequireEmail: (required: boolean) => void;
  setError: (field: AccountField, message: string | null) => void;
  clearErrors: () => void;
  setRows: (rows: SetupRow[]) => void;
  updateRow: (row: number, patch: Partial<SetupRow>) => void;
  setSetupStatus: (status: FirstRunState['setupStatus']) => void;
  setPhrase: (words: string[] | null) => void;
  revealPhrase: () => void;
  setPhraseSaved: (saved: boolean) => void;
  setResult: (result: FirstRunResult | null) => void;
  openSheet: (sheet: SheetId) => void;
  /** Drops the password (the account exists, or the person left the step). */
  forgetPassword: () => void;
  reset: () => void;
}

const EMPTY_INVITE: InviteCheck = { state: 'empty', link: null, preview: null, identity: null, host: null };
const EMPTY_ACCOUNT: AccountFields = { displayName: '', username: '', usernameEdited: false, email: '', password: '' };

const initial = {
  mode: 'desktop' as FirstRunMode,
  phase: 'welcome' as FirstRunPhase,
  path: null as FirstRunPath | null,
  reached: 0,
  serverName: '',
  hue: DEFAULT_HUE,
  preflight: { status: 'idle' as const, result: null, error: null },
  inviteText: '',
  invite: EMPTY_INVITE,
  clipboardInvite: null,
  account: EMPTY_ACCOUNT,
  requireEmail: false,
  errors: {},
  rows: [] as SetupRow[],
  setupStatus: 'idle' as const,
  phrase: null,
  phraseRevealed: false,
  phraseSaved: false,
  result: null,
  sheet: null as SheetId,
};

/** Username from a display name (§1.6): lowercase, keep `[a-z0-9_.]`, at most 20. */
export function usernameFrom(displayName: string): string {
  return displayName.toLowerCase().replace(/[^a-z0-9_.]/g, '').slice(0, 20);
}

export const useFirstRunStore = create<FirstRunState>()((set) => ({
  ...initial,

  setMode: (mode) => set({ mode }),
  setPhase: (phase) => set({ phase }),
  choosePath: (path) =>
    set((state) => (state.path === path ? { path } : { path, reached: 0, rows: [], setupStatus: 'idle', sheet: null })),
  noteReached: (index) => set((state) => (index > state.reached ? { reached: index } : state)),
  setServerName: (serverName) => set({ serverName }),
  setHue: (hue) => set({ hue }),
  setPreflight: (preflight) => set((state) => ({ preflight: { ...state.preflight, ...preflight } })),
  setInviteText: (inviteText) => set({ inviteText }),
  setInvite: (invite) => set((state) => ({ invite: { ...state.invite, ...invite } })),
  setClipboardInvite: (clipboardInvite) => set({ clipboardInvite }),
  setAccount: (fields) =>
    set((state) => {
      const account = { ...state.account, ...fields };
      if (fields.displayName !== undefined && !account.usernameEdited) account.username = usernameFrom(fields.displayName);
      // A field the person changed is no longer the field Setup refused.
      const errors = { ...state.errors };
      for (const key of Object.keys(fields) as Array<keyof AccountFields>) {
        if (key in errors) delete errors[key as AccountField];
      }
      return { account, errors };
    }),
  setRequireEmail: (requireEmail) => set({ requireEmail }),
  setError: (field, message) =>
    set((state) => {
      const errors = { ...state.errors };
      if (message) errors[field] = message;
      else delete errors[field];
      return { errors };
    }),
  clearErrors: () => set({ errors: {} }),
  setRows: (rows) => set({ rows }),
  updateRow: (row, patch) => set((state) => ({ rows: state.rows.map((r) => (r.row === row ? { ...r, ...patch } : r)) })),
  setSetupStatus: (setupStatus) => set({ setupStatus }),
  setPhrase: (phrase) => set({ phrase, phraseRevealed: false, phraseSaved: false }),
  revealPhrase: () => set({ phraseRevealed: true }),
  setPhraseSaved: (phraseSaved) => set({ phraseSaved }),
  setResult: (result) => set({ result }),
  openSheet: (sheet) => set({ sheet }),
  forgetPassword: () => set((state) => ({ account: { ...state.account, password: '' } })),
  reset: () => set({ ...initial }),
}));

/** The first run is on screen (deep links route invites to it, spec §6.4). */
export function isFirstRunActive(): boolean {
  if (typeof window === 'undefined') return false;
  const path = window.location.pathname;
  return path === '/welcome' || path.startsWith('/welcome/') || path === '/setup-server';
}

/* ---- The launch is shown once (spec §1.2) --------------------------------- */

const LAUNCH_SEEN_KEY = 'firstRun.launchSeen';

export function launchSeen(): boolean {
  try {
    return getVersionedStorageItem(LAUNCH_SEEN_KEY, []) === '1';
  } catch {
    return false;
  }
}

export function markLaunchSeen(): void {
  try {
    setVersionedStorageItem(LAUNCH_SEEN_KEY, '1');
  } catch {
    // Storage refused (a private window): the launch plays again next time, which is harmless.
  }
}
