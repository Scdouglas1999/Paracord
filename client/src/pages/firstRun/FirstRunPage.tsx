import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router';

import { getServerApi } from '../../api/activeClient';
import type { HostStatus } from '../../api/generated/HostStatus';
import { watchClipboardInvite } from '../../lib/clipboardInvite';
import { setStoredServerUrl } from '../../lib/config/apiBaseUrl';
import { setFirstRunProbe, useDeepLinkIntake } from '../../lib/deepLinks';
import { parseInviteLink, type InviteLink } from '../../lib/inviteLinks';
import { useReducedMotion } from '../../lib/motion/reducedMotion';
import { completeLegacyMfa, completeMfaSignIn, currentRecoveryPhrase, legacySignIn, signInWithPassword, type PendingMfaSignIn, type SignInOutcome } from '../../lib/oneCredential';
import { toPortableUri } from '../../lib/portableLinks';
import { OlderServerError } from '../../lib/serverFeatures';
import { LOCAL_SERVER_ID } from '../../lib/serverScope';
import { isTauri } from '../../lib/tauriEnv';
import { trustServer } from '../../lib/trustedHosts';
import { useServerListStore } from '../../stores/serverListStore';
import { toast } from '../../stores/toastStore';
import {
  JOIN_HUE,
  isFirstRunActive,
  isStepOf,
  launchSeen,
  markLaunchSeen,
  progressOf,
  stepsOf,
  useFirstRunStore,
  type FirstRunMode,
  type FirstRunPath,
  type FlowStep,
  type RowChip,
  type SetupRow,
} from '../../stores/firstRunStore';
import { AccountStep } from '../../components/firstRun/AccountStep';
import { useHandoffStore } from '../../components/firstRun/Handoff';
import { HostInviteStep, type HostInviteView } from '../../components/firstRun/HostInviteStep';
import { IdentityChangedSheet } from '../../components/firstRun/IdentityChangedSheet';
import { InviteStep, serverLabel } from '../../components/firstRun/InviteStep';
import { Launch } from '../../components/firstRun/Launch';
import { NameStep } from '../../components/firstRun/NameStep';
import { PhraseStep } from '../../components/firstRun/PhraseStep';
import { ProtectedSheet, type ProtectedHostRows } from '../../components/firstRun/ProtectedSheet';
import type { ScreenState } from '../../components/firstRun/Screen';
import { SetupStep } from '../../components/firstRun/SetupStep';
import { DetailsSheet, RouterSheet, SharedAddressSheet } from '../../components/firstRun/Sheets';
import { SignInStep, type ProbedServer, type SignInSubmit, type SignInView } from '../../components/firstRun/SignInStep';
import { TitleBar } from '../../components/firstRun/TitleBar';
import { Welcome } from '../../components/firstRun/Welcome';
import { Preview } from '../../components/firstRun/preview/Preview';
import type { PreviewModel } from '../../components/firstRun/preview/model';
import '../../components/firstRun/firstRun.css';
import { takeSetupCodeFromLocation } from './claimToken';
import {
  BackToAccount,
  confirmPhrase,
  errorMessage,
  onBackToAccount,
  retryReach,
  retrySetup,
  runClaimSetup,
  runHostSetup,
  runJoinSetup,
  setClaimToken,
  startPreflight,
  stopSetup,
  trustInvitedServer,
} from './flows';
import { useHostStore } from '../../stores/hostStore';
import type { HostRow } from '../../lib/host/rows';
import { checkInvite } from './inviteCheck';
import { acceptInvite, homeInvites, landingPath } from './landing';
import { storageCopy } from './rows';

/**
 * The first run (docs/setup-spec.md §1): the launch, the split welcome, the
 * host and join paths, sign-in, claim mode for a headless install (§2.11) and
 * the web join on a server's own page (§6.6). It owns the whole window.
 *
 * Routes (§1.14): `/welcome`, `/welcome/host/:step`, `/welcome/join/:step`,
 * `/welcome/sign-in`; `/setup-server[/:step]`; `/invite/:code[/:step]` on the
 * web. The step in the URL is for back/forward and tests; what each screen
 * shows is in `useFirstRunStore`, and the URL can only name a step already
 * reached.
 */

type Geometry = { narrow: boolean; phone: boolean; style: CSSProperties };

/** The preview's place (§1.1): the app scaled to sit right of the flow column, half size at 1280x800. */
function geometry(): Geometry {
  const w = window.innerWidth;
  const h = window.innerHeight;
  const narrow = w < 1040 || h < 680;
  const s = Math.min(0.5, (w - 640) / w);
  const x = w - 28 - s * w;
  const y = (h - s * h) / 2 - 24;
  return {
    narrow,
    phone: w < 640,
    style: { '--fr-pv-s': String(s), '--fr-pv-x': `${x}px`, '--fr-pv-y': `${y}px` } as CSSProperties,
  };
}

function useGeometry(): Geometry {
  const [geo, setGeo] = useState(geometry);
  useEffect(() => {
    const update = () => setGeo(geometry());
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, []);
  return geo;
}

interface ScreenEntry {
  key: string;
  step: FlowStep | 'sign-in';
  state: ScreenState;
}

/** The current screen and the one leaving (§1.1 screen change). */
function useScreens(key: string, step: FlowStep | 'sign-in', index: number): ScreenEntry[] {
  const [screens, setScreens] = useState<ScreenEntry[]>([{ key, step, state: 'on' }]);
  const lastIndex = useRef(index);
  const reduced = useReducedMotion();

  useLayoutEffect(() => {
    setScreens((current) => {
      if (current.length === 1 && current[0].key === key) return current;
      const forward = index >= lastIndex.current;
      lastIndex.current = index;
      const leaving = current
        .filter((s) => s.key !== key)
        .slice(-1)
        .map((s) => ({ ...s, state: (forward ? 'past' : 'next') as ScreenState }));
      return [...(reduced ? [] : leaving), { key, step, state: (forward ? 'next' : 'past') as ScreenState }];
    });
  }, [key, step, index, reduced]);

  useEffect(() => {
    const entering = screens.find((s) => s.key === key && s.state !== 'on');
    if (!entering) return;
    const frame = requestAnimationFrame(() =>
      requestAnimationFrame(() => setScreens((current) => current.map((s) => (s.key === key ? { ...s, state: 'on' } : s)))),
    );
    return () => cancelAnimationFrame(frame);
  }, [screens, key]);

  useEffect(() => {
    if (screens.length < 2) return;
    const timer = window.setTimeout(() => setScreens((current) => current.filter((s) => s.key === key)), 280);
    return () => window.clearTimeout(timer);
  }, [screens.length, key]);

  return screens;
}

export interface FirstRunPageProps {
  /** Which first run this route is: the desktop app, a headless install's claim page, or a web invite. */
  mode: FirstRunMode;
}

export function FirstRunPage({ mode }: FirstRunPageProps) {
  const navigate = useNavigate();
  const location = useLocation();
  const params = useParams<{ step?: string; path?: string; code?: string }>();
  const reduced = useReducedMotion();
  const geo = useGeometry();
  const desktop = isTauri();
  const st = useFirstRunStore();

  /* ---- Where this route is ------------------------------------------------- */

  const base = mode === 'claim' ? '/setup-server' : mode === 'web' ? `/invite/${params.code ?? ''}` : '/welcome';
  const routePath: FirstRunPath | null = mode === 'claim' ? 'host' : mode === 'web' ? 'join' : params.path === 'host' || params.path === 'join' ? params.path : null;
  const signInRoute = location.pathname.endsWith('/sign-in');
  const stepParam = signInRoute ? undefined : params.step;
  const pathOf = (path: FirstRunPath, step: string) => (mode === 'desktop' ? `/welcome/${path}/${step}` : `${base}/${step}`);
  const signInPath = mode === 'desktop' ? '/welcome/sign-in' : `${base}/sign-in`;

  // The flow always starts on the first step of its path; the URL cannot skip ahead.
  const path = routePath;
  const steps = path ? stepsOf(path) : [];
  const urlStep: FlowStep | null = path ? (isStepOf(path, stepParam) ? stepParam : steps[0]) : null;
  const urlIndex = urlStep ? steps.indexOf(urlStep) : -1;
  const step: FlowStep | null = urlStep && urlIndex <= st.reached ? urlStep : path ? steps[Math.min(st.reached, steps.length - 1)] : null;
  const stepIndex = step ? steps.indexOf(step) : -1;

  useEffect(() => {
    useFirstRunStore.getState().setMode(mode);
  }, [mode]);

  useEffect(() => {
    if (useFirstRunStore.getState().phase === 'done') return;
    if (path && step && urlStep !== step) navigate(pathOf(path, step), { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, step, urlStep]);

  useEffect(() => {
    if (path && useFirstRunStore.getState().path !== path) useFirstRunStore.getState().choosePath(path);
  }, [path]);

  /* ---- Phase --------------------------------------------------------------- */

  const [launch, setLaunch] = useState<'hold' | 'out' | null>(() => {
    if (mode !== 'desktop' || routePath || signInRoute) return null;
    if (reduced || launchSeen() || useServerListStore.getState().servers.length > 0) return null;
    return 'hold';
  });
  const [chose, setChose] = useState<FirstRunPath | null>(null);

  const phase = st.phase;
  useEffect(() => {
    const s = useFirstRunStore.getState();
    if (s.phase === 'done') return;
    if (signInRoute) s.setPhase('sign-in');
    else if (path) s.setPhase('flow');
    else if (launch === 'hold') s.setPhase('launch');
    else if (!chose) s.setPhase('welcome');
  }, [signInRoute, path, launch, chose]);

  useEffect(() => {
    setFirstRunProbe(isFirstRunActive);
    return () => setFirstRunProbe(null);
  }, []);

  /* ---- Claim mode: the setup code from the link's fragment ------------------- */

  useEffect(() => {
    if (mode !== 'claim') return;
    const code = takeSetupCodeFromLocation();
    if (code) setClaimToken(code);
  }, [mode]);

  /* ---- The welcome --------------------------------------------------------- */

  const choose = useCallback(
    (next: FirstRunPath) => {
      if (chose) return;
      const s = useFirstRunStore.getState();
      s.choosePath(next);
      if (next === 'host' && desktop) void startPreflight();
      if (reduced) {
        navigate(pathOf(next, stepsOf(next)[0]));
        return;
      }
      setChose(next);
      s.setPhase('choosing');
      window.setTimeout(() => {
        navigate(pathOf(next, stepsOf(next)[0]));
        window.setTimeout(() => setChose(null), 350);
      }, 430);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [chose, desktop, reduced],
  );

  // A deep link waiting at launch, or one that arrives on the welcome: straight to Join (§1.2, §6.4).
  const pendingInvite = useDeepLinkIntake((s) => s.invite);
  useEffect(() => {
    if (!pendingInvite || mode !== 'desktop' || launch || path === 'join') return;
    useFirstRunStore.getState().choosePath('join');
    navigate(pathOf('join', 'invite'));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingInvite, launch, path, mode]);

  /* ---- Join › Invite --------------------------------------------------------- */

  const checkRun = useRef(0);
  const runCheck = useCallback(async (link: InviteLink) => {
    const run = ++checkRun.current;
    useFirstRunStore.getState().setInvite({ state: 'checking', link, preview: null, identity: null });
    const result = await checkInvite(link);
    if (run !== checkRun.current) return;
    const s = useFirstRunStore.getState();
    s.setInvite(result);
    if (result.preview?.instance) s.setRequireEmail(result.preview.instance.require_email === true);
    if (result.state === 'identity-changed') s.openSheet('identity');
  }, []);

  const textTimer = useRef(0);
  const onInviteText = useCallback(
    (text: string) => {
      const s = useFirstRunStore.getState();
      s.setInviteText(text);
      window.clearTimeout(textTimer.current);
      checkRun.current += 1;
      const link = parseInviteLink(text);
      if (!text.trim()) {
        s.setInvite({ state: 'empty', link: null, preview: null, identity: null, host: null });
        return;
      }
      if (!link) {
        s.setInvite({ state: 'empty', link: null, preview: null, identity: null, host: null });
        textTimer.current = window.setTimeout(() => useFirstRunStore.getState().setInvite({ state: 'not-a-link' }), 600);
        return;
      }
      // The spinner shows at once; the request goes 250 ms after the last keystroke (§1.5).
      s.setInvite({ state: 'checking', link, preview: null, identity: null, host: null });
      textTimer.current = window.setTimeout(() => void runCheck(link), 250);
    },
    [runCheck],
  );

  const fillInvite = useCallback(
    (link: InviteLink) => {
      const text = link.serverUrl && link.code ? `${link.serverUrl}/invite/${link.code}` : '';
      const s = useFirstRunStore.getState();
      s.setInviteText(text);
      s.setClipboardInvite(null);
      window.clearTimeout(textTimer.current);
      void runCheck(link);
    },
    [runCheck],
  );

  // The deep link's invite fills the field (§6.4); it still waits for Continue.
  const onInviteStep = path === 'join' && step === 'invite' && phase === 'flow';
  useEffect(() => {
    if (!onInviteStep || mode !== 'desktop' || !pendingInvite) return;
    const link = useDeepLinkIntake.getState().takeInvite();
    if (link) fillInvite(link);
  }, [onInviteStep, pendingInvite, mode, fillInvite]);

  // The clipboard (desktop only, §6.5): on the welcome and on an empty Join step.
  const watching = mode === 'desktop' && desktop && !launch && (phase === 'welcome' || onInviteStep);
  const watchState = useRef({ phase, onInviteStep });
  useEffect(() => {
    watchState.current = { phase, onInviteStep };
  }, [phase, onInviteStep]);
  useEffect(() => {
    if (!watching) return;
    return watchClipboardInvite({
      isActive: () => watchState.current.phase === 'welcome' || watchState.current.onInviteStep,
      fieldIsEmpty: () => !useFirstRunStore.getState().inviteText.trim(),
      onInvite: (link) => {
        useFirstRunStore.getState().setClipboardInvite(link);
        if (watchState.current.phase === 'welcome') choose('join');
      },
    });
  }, [watching, choose]);

  // The web join: the invite is this page's own (§6.6), resolved before anything is shown.
  useEffect(() => {
    if (mode !== 'web' || !params.code) return;
    const link = { serverUrl: window.location.origin, code: params.code };
    useFirstRunStore.getState().setInviteText(`${link.serverUrl}/invite/${link.code}`);
    void runCheck(link);
  }, [mode, params.code, runCheck]);

  const [continueError, setContinueError] = useState<string | null>(null);
  const [trusting, setTrusting] = useState(false);

  /* ---- Navigation helpers ---------------------------------------------------- */

  const goStep = useCallback(
    (next: FlowStep) => {
      if (!path) return;
      const i = stepsOf(path).indexOf(next);
      useFirstRunStore.getState().noteReached(i);
      navigate(pathOf(path, next));
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [path, navigate],
  );

  const back = useCallback(() => {
    if (signInRoute) {
      navigate(-1);
      return;
    }
    if (!path || !step) return;
    const i = stepsOf(path).indexOf(step);
    if (step === 'setup') return; // no Back on Setup (§1.7)
    if (i === 0) {
      if (mode === 'desktop') {
        useFirstRunStore.getState().setPhase('welcome');
        navigate('/welcome');
      }
      return;
    }
    navigate(pathOf(path, stepsOf(path)[i - 1]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signInRoute, path, step, mode, navigate]);

  // Esc: a sheet closes itself; otherwise Back (§1.1).
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      if (useFirstRunStore.getState().sheet || document.querySelector('[role="dialog"], [role="alertdialog"]')) return;
      if (phase === 'flow' || phase === 'sign-in') back();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [phase, back]);

  /* ---- Setup ----------------------------------------------------------------- */

  useEffect(() => {
    onBackToAccount((backTo: BackToAccount) => {
      if (backTo) navigate(pathOf(useFirstRunStore.getState().path ?? 'host', 'account'), { replace: true });
    });
    return () => onBackToAccount(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [navigate]);

  useEffect(() => {
    if (step !== 'setup' || phase !== 'flow') return;
    const s = useFirstRunStore.getState();
    if (s.setupStatus !== 'idle') return;
    const run = mode === 'claim' ? runClaimSetup : path === 'join' ? runJoinSetup : runHostSetup;
    void run().catch((error: unknown) => {
      if (!(error instanceof BackToAccount)) toast.error(errorMessage(error));
    });
  }, [step, phase, mode, path]);

  // Leaving the first run (the Done handoff, or a route elsewhere) forgets what it held.
  useEffect(
    () => () => {
      stopSetup();
      if (useFirstRunStore.getState().phase === 'done' || useFirstRunStore.getState().result) useFirstRunStore.getState().reset();
    },
    [],
  );

  // Prefetch the app's own chunk once the account exists, so the Done handoff is quick (§1.13).
  useEffect(() => {
    if (step === 'phrase') void import('../AppShell');
  }, [step]);

  /* ---- Sheets ---------------------------------------------------------------- */

  // The desktop host's rows come from the host store (S7); the join and claim rows from the page's own sequencer.
  const hostDesktop = mode === 'desktop' && path === 'host';
  const hostRows = useHostStore((s) => s.rows);
  const setupRows: SetupRow[] = hostDesktop ? hostRows.map(fromHostRow) : st.rows;
  const hostPhase = useHostStore((s) => s.phase);
  const setupStatus = hostDesktop ? (hostPhase === 'done' ? 'done' : hostPhase === 'failed' ? 'failed' : hostPhase === 'idle' ? st.setupStatus : 'running') : st.setupStatus;

  const [status, setStatus] = useState<HostStatus | null>(null);
  const [details, setDetails] = useState('');
  const readStatus = useCallback(async (): Promise<HostStatus | null> => {
    try {
      const next = mode === 'claim' ? (await getServerApi(LOCAL_SERVER_ID).get<HostStatus>('/admin/host-status')).data : desktop ? await useHostStore.getState().loadStatus() : null;
      setStatus(next);
      return next;
    } catch {
      return null;
    }
  }, [mode, desktop]);

  const onChip = useCallback(
    async (row: SetupRow, chip: RowChip) => {
      const s = useFirstRunStore.getState();
      switch (chip) {
        case 'show-me-how':
          await readStatus();
          s.openSheet('router');
          break;
        case 'what-can-i-do':
          await readStatus();
          s.openSheet('shared');
          break;
        case 'try-again':
          if (hostDesktop) void useHostStore.getState().retryReachability();
          else void retryReach();
          break;
        case 'allow':
          void useHostStore.getState().allowFirewall();
          break;
        case 'retry-row':
          if (!hostDesktop) stopSetup();
          s.setSetupStatus('idle');
          void retrySetup();
          break;
        case 'show-details':
          setDetails(hostDesktop ? await useHostStore.getState().logsTail(200).catch((e: unknown) => errorMessage(e)) : (row.detail ?? ''));
          s.openSheet('details');
          break;
      }
    },
    [readStatus, hostDesktop],
  );

  const protectedHost: ProtectedHostRows | undefined = useMemo(() => {
    if (path !== 'host' || !status) return undefined;
    const encrypted = status.storage.sqlite_encrypted && status.storage.files_encrypted;
    return {
      storageCopy: storageCopy(status.storage.protection, encrypted),
      storageOn: encrypted,
      inviteOnly: true,
      backups: {
        enabled: status.backups.enabled,
        days: status.backups.keep,
        onChange: async (enabled: boolean) => {
          await getServerApi(LOCAL_SERVER_ID).patch('/admin/backups', { enabled });
          await readStatus();
        },
      },
    };
  }, [path, status, readStatus]);

  /* ---- Phrase and Done -------------------------------------------------------- */

  const [probed, setProbed] = useState<ProbedServer | null>(null);
  const [phraseBusy, setPhraseBusy] = useState(false);
  const [phraseError, setPhraseError] = useState<string | null>(null);

  const previewModel = usePreviewModel(path, signInRoute, probed);
  const previewSnapshot = useRef<PreviewModel>(previewModel);
  useEffect(() => {
    previewSnapshot.current = previewModel;
  }, [previewModel]);

  const finish = useCallback(() => {
    const s = useFirstRunStore.getState();
    const result = s.result;
    const target = landingPath(result?.guildId ?? null, result?.channelId ?? null);
    const hue = Number(getComputedStyle(document.documentElement).getPropertyValue('--fr-hue')) || stageHue(s);
    markLaunchSeen();
    const announce = () => {
      if (!result) return;
      if (s.path === 'host' && !signInRoute) toast.success(`${result.serverName} is live`);
      else if (signInRoute) toast.success(`Signed in to ${result.serverName}`);
      else toast.success(`You joined ${result.serverName}`);
    };
    const handOff = () => {
      useHandoffStore.getState().start(previewSnapshot.current, hue);
      navigate(target, { replace: true });
      window.setTimeout(announce, 200);
    };
    if (reduced || geo.narrow) {
      s.setPhase('done');
      navigate(target, { replace: true });
      window.setTimeout(announce, 200);
      return;
    }
    s.setPhase('done');
    window.setTimeout(handOff, 360);
  }, [navigate, reduced, geo.narrow, signInRoute]);


  const onPhraseContinue = useCallback(async () => {
    setPhraseBusy(true);
    setPhraseError(null);
    try {
      await confirmPhrase();
      if (path === 'host' && !signInRoute) goStep('invite');
      else finish();
    } catch (error) {
      setPhraseError(`Couldn't save that you kept your phrase (${errorMessage(error)}). Try again.`);
    } finally {
      setPhraseBusy(false);
    }
  }, [path, signInRoute, goStep, finish]);

  /* ---- Host › Invite ----------------------------------------------------------- */

  const invite = useHostInvite(step === 'invite' && path === 'host' && phase !== 'done');

  /* ---- Sign in ------------------------------------------------------------------ */

  const [signInView, setSignInView] = useState<SignInView>('form');
  const [signInBusy, setSignInBusy] = useState(false);
  const [signInError, setSignInError] = useState<string | null>(null);
  const [signedInPhrase, setSignedInPhrase] = useState(false);
  const pendingMfa = useRef<PendingMfaSignIn | null>(null);
  const legacyTicket = useRef<string | null>(null);
  const initialServer = useMemo(() => {
    const fromLink = useDeepLinkIntake.getState().takeServer();
    if (fromLink) return fromLink;
    const fromState = (location.state as { server?: string } | null)?.server;
    if (fromState) return fromState;
    if (mode === 'web') return window.location.origin;
    return useFirstRunStore.getState().invite.link?.serverUrl ?? '';
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signInRoute]);

  const afterSignIn = useCallback(
    async (outcome: SignInOutcome, server: ProbedServer) => {
      if (outcome.kind === 'legacy') {
        setSignInView('legacy');
        return;
      }
      if (outcome.kind === 'mfa') {
        pendingMfa.current = outcome.pending;
        setSignInView('mfa');
        return;
      }
      const s = useFirstRunStore.getState();
      let guildId: string | null = null;
      let channelId: string | null = null;
      let name = server.name;
      if (server.inviteCode) {
        const joined = await acceptInvite(server.inviteCode);
        guildId = joined.guildId;
        channelId = joined.channelId;
        name = joined.name;
      }
      s.setResult({ serverUrl: server.url, guildId, channelId, serverName: name, hue: JOIN_HUE });
      if (!outcome.recoveryConfirmed) {
        const phrase = currentRecoveryPhrase();
        if (phrase) {
          s.setPhrase(phrase.split(/\s+/));
          setSignedInPhrase(true);
          return;
        }
      }
      finish();
    },
    [finish],
  );

  const onSignInSubmit = useCallback(
    async ({ server, identifier, password, code, view }: SignInSubmit) => {
      setSignInBusy(true);
      setSignInError(null);
      try {
        if (view === 'form') {
          if (desktop && server.fingerprint) await trustServer(server.url, server.fingerprint);
          if (desktop) setStoredServerUrl(server.url);
          await afterSignIn(await signInWithPassword(identifier, password), server);
        } else if (view === 'mfa') {
          if (legacyTicket.current) {
            await completeLegacyMfa(legacyTicket.current, code);
            legacyTicket.current = null;
            navigate('/setup');
            return;
          }
          if (!pendingMfa.current) throw new Error('Sign in again.');
          await afterSignIn(await completeMfaSignIn(pendingMfa.current, code), server);
        } else {
          const result = await legacySignIn(identifier, password);
          if (result.kind === 'mfa') {
            legacyTicket.current = result.ticket;
            setSignInView('mfa');
            return;
          }
          // The move to one password (§3.11) is the /setup screen.
          navigate('/setup');
        }
      } catch (error) {
        if (error instanceof OlderServerError) {
          // An older server keeps its own sign-in pages (§3.12).
          navigate('/login', { replace: true });
          return;
        }
        const statusCode = (error as { response?: { status?: number } } | null)?.response?.status;
        setSignInError(statusCode === 401 ? (view === 'mfa' ? "That code didn't work. Try the newest one." : "That username or password isn't right.") : errorMessage(error));
      } finally {
        setSignInBusy(false);
      }
    },
    [desktop, afterSignIn, navigate],
  );

  const onForgot = useCallback(
    async (server: ProbedServer | null) => {
      try {
        if (server && desktop) {
          if (server.fingerprint) await trustServer(server.url, server.fingerprint);
          setStoredServerUrl(server.url);
        }
        navigate('/recover');
      } catch (error) {
        setSignInError(errorMessage(error));
      }
    },
    [desktop, navigate],
  );

  /* ---- Render ---------------------------------------------------------------- */

  const screenKey = signInRoute ? (signedInPhrase ? 'sign-in-phrase' : 'sign-in') : `${path}:${step}`;
  const screenStep: FlowStep | 'sign-in' = signInRoute ? 'sign-in' : (step ?? 'invite');
  const screens = useScreens(screenKey, screenStep, signInRoute ? 0 : stepIndex);

  const progress = path && step && !signInRoute ? progressOf(path, step) : { segments: 0, filled: 0 };
  const hueNow = stageHue(st, signInRoute);
  const serverName = st.serverName.trim();
  const joinName = serverLabel(st.invite);

  const renderScreen = (entry: ScreenEntry) => {
    const state = entry.state;
    if (entry.key === 'sign-in-phrase') {
      return (
        <PhraseStep
          key={entry.key}
          state={state}
          primary={`Open ${st.result?.serverName ?? 'Paracord'}`}
          username={st.account.username || ''}
          server={st.result?.serverName ?? ''}
          busy={phraseBusy}
          error={phraseError}
          onContinue={() => void onPhraseContinue()}
        />
      );
    }
    if (entry.step === 'sign-in') {
      return (
        <SignInStep
          key={entry.key}
          state={state}
          web={mode === 'web'}
          initialServer={initialServer}
          view={signInView}
          busy={signInBusy}
          error={signInError}
          onProbed={setProbed}
          onSubmit={(submit) => void onSignInSubmit(submit)}
          onBack={signInView === 'form' ? back : () => setSignInView('form')}
          onForgot={(server) => void onForgot(server)}
        />
      );
    }
    const [entryPath, entryStep] = entry.key.split(':') as [FirstRunPath, FlowStep];
    switch (entryStep) {
      case 'name':
        return (
          <NameStep
            key={entry.key}
            state={state}
            checkHost={mode === 'desktop'}
            onContinue={() => goStep('account')}
            onBack={mode === 'desktop' ? back : undefined}
            onUseExisting={(url) => navigate(signInPath, { state: { server: url } })}
            onRetryPreflight={() => void startPreflight()}
          />
        );
      case 'invite':
        if (entryPath === 'host') {
          return (
            <HostInviteStep
              key={entry.key}
              state={state}
              serverName={st.result?.serverName ?? serverName}
              view={invite.view}
              busy={invite.busy}
              onChange={(options) => void invite.change(options)}
              onContinue={finish}
              onBack={back}
            />
          );
        }
        return (
          <InviteStep
            key={entry.key}
            state={state}
            web={mode === 'web'}
            busy={trusting}
            continueError={continueError}
            onTextChange={onInviteText}
            onUseClipboard={() => st.clipboardInvite && fillInvite(st.clipboardInvite)}
            onRetry={() => {
              const link = useFirstRunStore.getState().invite.link;
              if (!link) return;
              if (useFirstRunStore.getState().invite.state === 'identity-changed') useFirstRunStore.getState().openSheet('identity');
              else void runCheck(link);
            }}
            onContinue={async () => {
              setTrusting(true);
              setContinueError(null);
              try {
                await trustInvitedServer();
                goStep('account');
              } catch (error) {
                setContinueError(errorMessage(error));
              } finally {
                setTrusting(false);
              }
            }}
            onBack={mode === 'desktop' ? back : undefined}
            onOpenApp={mode === 'web' && params.code ? () => window.location.assign(toPortableUri(window.location.origin, params.code!)) : undefined}
          />
        );
      case 'account':
        return (
          <AccountStep
            key={entry.key}
            state={state}
            path={entryPath}
            ownerOf={serverName}
            joining={joinName}
            onContinue={() => {
              useFirstRunStore.getState().clearErrors();
              useFirstRunStore.getState().setSetupStatus('idle');
              goStep('setup');
            }}
            onBack={back}
            onSignIn={() => navigate(signInPath)}
          />
        );
      case 'setup':
        return (
          <SetupStep
            key={entry.key}
            state={state}
            path={entryPath}
            rows={setupRows}
            status={setupStatus}
            onChip={(row, chip) => void onChip(row, chip)}
            onContinue={() => goStep('phrase')}
            onProtected={() => {
              void readStatus();
              useFirstRunStore.getState().openSheet('protected');
            }}
          />
        );
      case 'phrase':
        return (
          <PhraseStep
            key={entry.key}
            state={state}
            primary={entryPath === 'join' ? `Open ${st.result?.serverName ?? joinName}` : 'Continue'}
            username={st.account.username}
            server={st.result?.serverName ?? (entryPath === 'host' ? serverName : joinName)}
            busy={phraseBusy}
            error={phraseError}
            onContinue={() => void onPhraseContinue()}
            onBack={back}
          />
        );
    }
  };

  const sheet = st.sheet;
  const close = () => useFirstRunStore.getState().openSheet(null);
  const reach = status?.reachability;

  return (
    <div
      className="fr"
      data-phase={phase}
      data-booting={launch === 'hold' ? '' : undefined}
      data-narrow={geo.narrow ? '' : undefined}
      data-phone={geo.phone ? '' : undefined}
      data-web={!desktop ? '' : undefined}
      data-path={path ?? undefined}
      style={{ ...geo.style, '--fr-hue': hueNow } as CSSProperties}
      data-testid="first-run"
    >
      <div className="fr-glow" />
      <TitleBar segments={progress.segments} filled={progress.filled} onSignIn={() => navigate(signInPath)} showSignIn={!signInRoute && (phase === 'flow' || phase === 'done')} />

      {(phase === 'launch' || phase === 'welcome' || phase === 'choosing') && (
        <Welcome chose={chose} showHost={desktop && mode === 'desktop'} showMark={!launch} onChoose={choose} onSignIn={() => navigate(signInPath)} />
      )}

      {(path || signInRoute) && <div className="fr-flow">{screens.map(renderScreen)}</div>}

      {(path || signInRoute) && !geo.narrow && (
        <div className="fr-pre">
          <Preview model={previewModel} />
        </div>
      )}

      {launch && (
        <Launch
          onOut={() => {
            setLaunch('out');
            useFirstRunStore.getState().setPhase('welcome');
          }}
          onDone={() => {
            markLaunchSeen();
            setLaunch(null);
          }}
        />
      )}

      <ProtectedSheet open={sheet === 'protected'} onClose={close} host={protectedHost} />
      <RouterSheet
        open={sheet === 'router'}
        onClose={close}
        variant={reach?.state === 'no_answer' ? 'no_answer' : 'refused'}
        gatewayIp={reach?.gateway_ip ?? null}
        lanIp={reach?.lan_ip ?? null}
        port={reach?.port ?? useFirstRunStore.getState().preflight.result?.port ?? 8443}
      />
      <SharedAddressSheet open={sheet === 'shared'} onClose={close} port={reach?.port ?? 8443} />
      <DetailsSheet open={sheet === 'details'} onClose={close} text={details} />
      {st.invite.link && (
        <IdentityChangedSheet
          open={sheet === 'identity'}
          serverName={joinName}
          serverUrl={st.invite.link.serverUrl}
          onClose={close}
          onTrusted={() => {
            close();
            const link = useFirstRunStore.getState().invite.link;
            if (link) void runCheck(link);
          }}
        />
      )}
    </div>
  );
}

/** The stage hue (§1.1): the host's pick, the invited server's, else the join blue. */
function stageHue(s: ReturnType<typeof useFirstRunStore.getState>, signIn = false): number {
  if (signIn) return s.result?.hue ?? JOIN_HUE;
  if (s.path === 'join') return s.invite.preview?.guild?.hue ?? JOIN_HUE;
  return s.hue;
}

/** The live preview's model (§1.9), from the store; nothing else feeds it. */
function usePreviewModel(path: FirstRunPath | null, signIn: boolean, probed: ProbedServer | null): PreviewModel {
  const name = useFirstRunStore((s) => s.serverName);
  const hue = useFirstRunStore((s) => s.hue);
  const me = useFirstRunStore((s) => s.account.displayName.trim() || null);
  const ownRow1 = useFirstRunStore((s) => s.rows.find((r) => r.row === 1)?.state ?? 'waiting');
  const hostRow1 = useHostStore((s) => s.rows.find((r) => r.row === 1)?.state ?? 'waiting');
  const setupStatus = useFirstRunStore((s) => s.setupStatus);
  const mode = useFirstRunStore((s) => s.mode);
  const row1 = mode === 'desktop' ? hostRow1 : ownRow1;
  const invite = useFirstRunStore((s) => s.invite);
  const result = useFirstRunStore((s) => s.result);
  return useMemo<PreviewModel>(() => {
    if (path === 'host' && !signIn) {
      // Claim mode has no row 1: the server is already running (§2.11).
      const status = mode === 'claim' ? 'online' : row1 === 'ok' || row1 === 'warn' ? 'online' : row1 === 'run' ? 'starting' : setupStatus === 'done' ? 'online' : 'off';
      return { kind: 'host', name, hue, status, me };
    }
    const guild = invite.state === 'card' ? invite.preview?.guild : null;
    if (guild) return { kind: 'join', server: { name: guild.name, hue: guild.hue ?? JOIN_HUE, online: guild.online_count ?? 0, members: guild.member_count }, me };
    if (signIn && result) return { kind: 'join', server: { name: result.serverName, hue: result.hue, online: null, members: null }, me };
    if (signIn && probed) return { kind: 'join', server: { name: probed.name, hue: JOIN_HUE, online: null, members: null }, me };
    return { kind: 'join', server: null, me };
  }, [path, signIn, probed, name, hue, me, row1, setupStatus, mode, invite, result]);
}

/** Host › Invite (§1.13): the share address and the invite, made when the screen first appears. */
function useHostInvite(active: boolean): { view: HostInviteView; busy: boolean; change: (o: { maxAge: number; maxUses: number }) => Promise<void> } {
  const [view, setView] = useState<HostInviteView>({ url: null, lan: false, onlyHere: false, addressChanged: false, maxAge: 604_800, maxUses: 25, error: null });
  const [busy, setBusy] = useState(false);
  const code = useRef<string | null>(null);
  const share = useRef<string | null>(null);

  const readShare = useCallback(async () => {
    const { data } = await homeInvites.shareAddress();
    const previous = (data as { previous_url?: string | null }).previous_url;
    // A server only this computer can reach has no share address (§5.5
    // `this_computer`): the link is the address in use here, and says so.
    const url = data.url ?? useFirstRunStore.getState().result?.serverUrl ?? null;
    share.current = url;
    setView((v) => ({
      ...v,
      lan: data.reach === 'local_network',
      onlyHere: !data.url || data.reach === 'this_computer',
      addressChanged: Boolean(previous),
      url: url && code.current ? `${url}/invite/${code.current}` : v.url,
    }));
    return url;
  }, []);

  const make = useCallback(
    async (maxAge: number, maxUses: number) => {
      const channelId = useFirstRunStore.getState().result?.channelId;
      if (!channelId) throw new Error('The server has no channel to invite to yet.');
      if (code.current) await homeInvites.delete(code.current).catch(() => undefined);
      const { data } = await homeInvites.create(channelId, { max_age: maxAge, max_uses: maxUses });
      code.current = data.code;
      const base = share.current ?? (await readShare());
      setView((v) => ({ ...v, maxAge, maxUses, error: null, url: base ? `${base}/invite/${data.code}` : null }));
    },
    [readShare],
  );

  useEffect(() => {
    if (!active || code.current) return;
    setBusy(true);
    void readShare()
      .then(() => make(604_800, 25))
      .catch((error: unknown) => setView((v) => ({ ...v, error: `Couldn't make the invite link (${errorMessage(error)}).` })))
      .finally(() => setBusy(false));
  }, [active, make, readShare]);

  // The link follows the address while this screen is open (§1.13, §5.6): the
  // server re-asks its router every minute, so this re-reads it on that beat and on focus.
  useEffect(() => {
    if (!active) return;
    const refresh = () => void readShare().catch(() => undefined);
    const timer = window.setInterval(refresh, 60_000);
    window.addEventListener('focus', refresh);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('focus', refresh);
    };
  }, [active, readShare]);

  const change = useCallback(
    async ({ maxAge, maxUses }: { maxAge: number; maxUses: number }) => {
      setBusy(true);
      try {
        await make(maxAge, maxUses);
      } catch (error) {
        setView((v) => ({ ...v, error: `Couldn't make a new link (${errorMessage(error)}).` }));
      } finally {
        setBusy(false);
      }
    },
    [make],
  );

  return { view, busy, change };
}

export default FirstRunPage;

/** A host store row (S7, `lib/host/rows.ts`) as the Setup step draws it. */
function fromHostRow(row: HostRow): SetupRow {
  const chips = row.chips.map((chip): RowChip => {
    switch (chip) {
      case 'show_me_how':
        return 'show-me-how';
      case 'what_can_i_do':
        return 'what-can-i-do';
      case 'show_details':
        return 'show-details';
      case 'allow':
        return 'allow';
      default:
        return row.state === 'fail' ? 'retry-row' : 'try-again';
    }
  });
  return { row: row.row, title: row.title, pending: row.detail, detail: row.detail, state: row.state, code: row.code ?? undefined, chips };
}
