/**
 * View sessions: watching a stream without joining its call (docs/glass-spec.md
 * §6; docs/design/glass-plan.md §1.2 and §3 "View-session design constraints";
 * docs/design/glass-g5-checkpoint.md).
 *
 * The rules this module keeps, all deterministic:
 *
 * - **Watch** = the stream's video and its own audio, never the voices. It is
 *   counted ("2 watching"). (The server also knows an `ambient` view kind, the
 *   stream's lowest layer, for the retired room light; the client no longer
 *   asks for one.)
 * - **One view per account** on the server (a new view replaces the old one,
 *   anywhere).
 * - **A view on a channel whose call this client is in rides the call**
 *   (`route: 'call'`): no second connection. The server says so for a watch
 *   (`via_membership`) and counts it.
 *   Joining a call in the channel you are watching carries the watch over
 *   (the relay moves it to the membership); leaving it moves the watch back
 *   onto a session of its own. Watching never joins the call and stopping
 *   never leaves it. A self-preview rides the local call without a server
 *   viewer registration or audio playback, and ends when that call ends.
 * - **No automatic retry.** A view the relay superseded, ended or revoked (its
 *   viewer may no longer see the channel), one that did
 *   not connect within {@link VIEW_CONNECT_DEADLINE_MS}, or one refused by the
 *   server stays down with its reason until someone asks again.
 *
 * The store owns the state (`watchView`); this module owns the connections. It never imports the store: `voiceStore` hands it a
 * {@link ViewHost} at start-up.
 */
import { createCallVoiceApi, type VoiceViewKind, type VoiceViewSession } from '../../api/voice';
import { voiceErrorMessage } from './errors';
import type { MediaEngine } from '../../lib/media/mediaEngine';
import { parseRelayCloseReason } from '../../lib/media/engineShared';
import type { OperationContext } from '../../lib/operationContext';
import type { AccountScope } from '../../lib/serverScope';
import type { CallSession } from './callSession';

/**
 * How long a new view is given to connect. The server retires a view that has
 * no media connection for 20 seconds, so a later connection would be refused.
 */
export const VIEW_CONNECT_DEADLINE_MS = 20_000;

/** The only kind of view the client opens. */
export type MediaViewKind = Extract<VoiceViewKind, 'watch'>;

/**
 * What to view: one person's stream in one voice channel. `serverId` is the
 * instance (the `AccountScope.serverId`) whose API and relay carry it; omitted,
 * it is the instance active when the view starts.
 */
export interface MediaViewTarget {
  serverId?: string;
  guildId: string;
  channelId: string;
  streamerId: string;
}

/**
 * How a view receives its frames:
 * - `session`: its own view-session connection (receive-only).
 * - `call`: the call this client holds in that channel.
 */
export type MediaViewRoute = 'session' | 'call';

/**
 * - `starting`: asking the server.
 * - `connecting`: connecting its media (or waiting for the call it rides).
 * - `live`: frames can arrive; `engine` renders it.
 * - `ended`: the relay superseded, ended or revoked it (`endReason` says
 *   which). Not retried.
 * - `failed`: refused, broken, or past its connect deadline. Not retried.
 */
export type MediaViewPhase = 'starting' | 'connecting' | 'live' | 'ended' | 'failed';

/**
 * Why a view stopped: the relay's own reason (`superseded` by a newer view of
 * this account, `ended`, or `revoked` because the viewer may no longer see the
 * channel), the connect deadline, or a failure.
 */
export type MediaViewEndReason = 'superseded' | 'ended' | 'revoked' | 'deadline' | 'failed';

export interface MediaViewState {
  /** Changes whenever the view is replaced (never reused across targets). */
  id: string;
  kind: MediaViewKind;
  scope: AccountScope;
  guildId: string;
  channelId: string;
  streamerId: string;
  route: MediaViewRoute | null;
  phase: MediaViewPhase;
  /**
   * The engine that carries this view's stream now: its own, the call's, or
   * the watch's. Subscribe surfaces (`subscribeVideo(streamerId, canvas, …,
   * { preferredTrackId: 'screen' })`) and taps to this one, and again when it
   * changes (a call joined or left moves a watch between engines).
   */
  engine: MediaEngine | null;
  /** The view session's receipt (route `session`). */
  sessionId: string | null;
  endReason: MediaViewEndReason | null;
  /** What went wrong, in the server's or the transport's words. */
  error: string | null;
}

/** What `voiceStore` gives this module. */
export interface ViewHost {
  publish(state: MediaViewState | null): void;
  /** The call this account holds in `channelId` (joining or connected). */
  callIn(scope: AccountScope, channelId: string): CallSession | null;
  /** The call's engine once it is connected; null if it ends first. */
  callMedia(call: CallSession): Promise<{ engine: MediaEngine; sessionId: string } | null>;
  /** The connected call's engine now, without waiting. */
  connectedCallMedia(call: CallSession): { engine: MediaEngine; sessionId: string } | null;
  /** Settles once a closed call's membership has been released on the server. */
  callReleased(call: CallSession): Promise<void>;
  createEngine(): Promise<MediaEngine>;
  captureContext(serverId?: string): OperationContext;
  /** Playback gain for a watched stream's audio (0..2). */
  streamVolume(streamerId: string): number;
}

interface ResolvedTarget {
  scope: AccountScope;
  scopeKey: string;
  guildId: string;
  channelId: string;
  streamerId: string;
}

function sameTarget(a: ResolvedTarget, b: ResolvedTarget): boolean {
  return a.scopeKey === b.scopeKey && a.channelId === b.channelId && a.streamerId === b.streamerId
    && a.guildId === b.guildId;
}

class ViewDeadlineError extends Error {
  constructor() {
    super(`The stream did not connect within ${VIEW_CONNECT_DEADLINE_MS / 1000} seconds.`);
    this.name = 'ViewDeadlineError';
  }
}

/** One view's lifetime: its connection, its audio, and its published state. */
class ViewOwner {
  readonly id: string = crypto.randomUUID();
  private readonly controller = new AbortController();
  readonly signal = this.controller.signal;
  /** The engine this view created (route `session`); disconnected on end. */
  ownEngine: MediaEngine | null = null;
  /** The engine carrying it now (own, call's or watch's). */
  engine: MediaEngine | null = null;
  route: MediaViewRoute | null = null;
  /** The call it rides, when it does. */
  call: CallSession | null = null;
  sessionId: string | null = null;
  releaseAudio: (() => void) | null = null;
  /** Ended or failed: stays down. */
  finished = false;
  /**
   * Bumped by every attempt to (re)establish this view. An attempt that has
   * been overtaken (a call joined or left under it) stops at its next step
   * instead of attaching a second connection.
   */
  attempt = 0;
  state: MediaViewState;
  promise: Promise<void> = Promise.resolve();

  constructor(
    readonly kind: MediaViewKind,
    readonly target: ResolvedTarget,
    readonly context: OperationContext,
    /** Whether this owner disposes the context when it ends. */
    private readonly ownsContext: boolean,
  ) {
    this.state = {
      id: this.id, kind, scope: target.scope, guildId: target.guildId, channelId: target.channelId,
      streamerId: target.streamerId, route: null, phase: 'starting', engine: null, sessionId: null,
      endReason: null, error: null,
    };
  }

  /** The publisher previews locally; it is never registered as its own viewer. */
  get isSelfPreview(): boolean {
    return this.kind === 'watch' && this.target.streamerId === this.target.scope.userId;
  }

  get current(): boolean {
    return !this.signal.aborted && !this.context.signal.aborted;
  }

  assertCurrent(attempt?: number): void {
    if (!this.current) throw new DOMException('The view has ended.', 'AbortError');
    if (attempt !== undefined && attempt !== this.attempt) {
      throw new DOMException('The view attempt was overtaken.', 'AbortError');
    }
    this.context.assertCurrent();
  }

  /** Whether `attempt` is still the one in charge. */
  leads(attempt: number): boolean {
    return this.current && this.attempt === attempt;
  }

  /** End this owner: nothing it started may publish or act after this. */
  close(): void {
    if (this.signal.aborted) return;
    this.controller.abort(new DOMException('The view has ended.', 'AbortError'));
  }

  disposeContext(): void {
    if (this.ownsContext) this.context.dispose();
  }
}

let host: ViewHost | null = null;
let watchOwner: ViewOwner | null = null;

function requireHost(): ViewHost {
  if (!host) throw new Error('View sessions are not ready.');
  return host;
}

export function initViewSessions(value: ViewHost): void {
  host = value;
}

function publish(owner: ViewOwner, patch: Partial<MediaViewState>): void {
  owner.state = { ...owner.state, ...patch };
  if (watchOwner !== owner) return;
  host?.publish(owner.state);
}

function resolveTarget(target: MediaViewTarget, context: OperationContext): ResolvedTarget {
  if (!target.guildId || !target.channelId || !target.streamerId) {
    throw new Error('A view needs a server, a voice channel and a streamer.');
  }
  return {
    scope: context.scope, scopeKey: context.key,
    guildId: target.guildId, channelId: target.channelId, streamerId: target.streamerId,
  };
}

function releaseAudio(owner: ViewOwner): void {
  const release = owner.releaseAudio;
  owner.releaseAudio = null;
  try { release?.(); } catch { /* the engine is already gone */ }
}

function releaseOwnEngine(owner: ViewOwner): void {
  const engine = owner.ownEngine;
  owner.ownEngine = null;
  if (owner.engine === engine) owner.engine = null;
  if (engine) void engine.disconnect().catch(() => {});
}

/**
 * The receipt a stop must name: the view session's own, or the call's when
 * the view rides it. Unscoped, the server would end both at once.
 */
function stopReceipt(owner: ViewOwner): string | null {
  if (owner.route === 'session') return owner.sessionId;
  if (owner.route === 'call') return owner.call?.membershipSessionId ?? null;
  return null;
}

/** Tell the server this view is over (scoped to its receipt), then let the context go. */
function stopOnServer(owner: ViewOwner): void {
  const receipt = stopReceipt(owner);
  const registered = !owner.isSelfPreview && (owner.route === 'session' || owner.route === 'call');
  if (!receipt || !registered) { owner.disposeContext(); return; }
  void createCallVoiceApi(owner.context).stopView(owner.target.channelId, receipt)
    .catch((error) => console.warn('[voice] Stopping a view failed:', error))
    .finally(() => owner.disposeContext());
}

/** Tear an owner down locally: audio, its own connection, and its callbacks. */
function teardown(owner: ViewOwner): void {
  owner.close();
  releaseAudio(owner);
  releaseOwnEngine(owner);
}

// ── Watch ────────────────────────────────────────────────────────────────────

/**
 * Watch a stream without joining its call (or through the call when this
 * client is in it). Resolves once the view is live; rejects when it fails.
 * The same target again returns the running watch.
 */
export function startWatch(target: MediaViewTarget): Promise<void> {
  const h = requireHost();
  const context = h.captureContext(target.serverId);
  let resolved: ResolvedTarget;
  try { resolved = resolveTarget(target, context); } catch (error) { context.dispose(); return Promise.reject(error); }
  const running = watchOwner;
  if (running && running.current && !running.finished && sameTarget(running.target, resolved)) {
    context.dispose();
    return running.promise;
  }
  if (running) endWatch(running);
  const owner = new ViewOwner('watch', resolved, context, true);
  watchOwner = owner;
  publish(owner, {});
  owner.promise = attemptWatch(owner);
  return owner.promise;
}

/** Stop watching (Esc, "Stop watching"). Never touches the call. */
export function stopWatch(): Promise<void> {
  const owner = watchOwner;
  if (!owner) return Promise.resolve();
  endWatch(owner);
  host?.publish(null);
  return Promise.resolve();
}

function endWatch(owner: ViewOwner): void {
  const wasCurrent = watchOwner === owner;
  teardown(owner);
  if (!owner.finished) stopOnServer(owner);
  else owner.disposeContext();
  if (wasCurrent) watchOwner = null;
}

async function attemptWatch(owner: ViewOwner): Promise<void> {
  const h = requireHost();
  const attempt = ++owner.attempt;
  const { channelId, streamerId } = owner.target;
  try {
    if (owner.isSelfPreview) {
      if (!h.callIn(owner.target.scope, channelId)) {
        throw new Error('Your stream preview is only available in the call you are sharing from.');
      }
      await rideCall(owner, h, attempt);
      return;
    }
    const { data } = await createCallVoiceApi(owner.context).startView(channelId, 'watch', streamerId);
    owner.assertCurrent(attempt);
    if (data.via_membership) await rideCall(owner, h, attempt);
    else await connectSession(owner, data, h, attempt);
  } catch (error) {
    if (!owner.leads(attempt)) return;
    fail(owner, error);
    throw error;
  }
}

/** A watch whose server answer says it rides this client's call. */
async function rideCall(owner: ViewOwner, h: ViewHost, attempt: number): Promise<void> {
  const call = h.callIn(owner.target.scope, owner.target.channelId);
  if (!call) {
    throw new Error('The server counts this client in that call, but the call is not here. Rejoin or stop watching.');
  }
  owner.route = 'call';
  owner.call = call;
  owner.sessionId = null;
  publish(owner, { route: 'call', phase: 'connecting', engine: null, sessionId: null });
  const media = await h.callMedia(call);
  owner.assertCurrent(attempt);
  // The call ended before it connected: `onCallClosed` moves the watch.
  if (!media) return;
  attach(owner, media.engine);
}

/** A view session's own connection, with the connect deadline. */
async function connectSession(owner: ViewOwner, data: VoiceViewSession, h: ViewHost, attempt: number): Promise<void> {
  const media = data.media;
  if (!media || !data.session_id) throw new Error('The server did not return media for this view.');
  owner.route = 'session';
  owner.call = null;
  owner.sessionId = data.session_id;
  publish(owner, { route: 'session', phase: 'connecting', sessionId: data.session_id, engine: null });
  const candidates = (media.media_endpoint_candidates.length ? media.media_endpoint_candidates : [media.media_endpoint])
    .filter((url) => typeof url === 'string' && !!url.trim());
  if (!candidates.length) throw new Error('The server did not name a media endpoint for this view.');
  const api = createCallVoiceApi(owner.context);
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(new ViewDeadlineError()), VIEW_CONNECT_DEADLINE_MS);
  const expired = new Promise<never>((_, reject) => {
    deadline.signal.addEventListener('abort', () => reject(deadline.signal.reason), { once: true });
  });
  expired.catch(() => {});
  try {
    let lastError: unknown = new Error('The view could not connect.');
    for (const endpoint of candidates) {
      owner.assertCurrent(attempt);
      if (deadline.signal.aborted) throw deadline.signal.reason;
      const engine = await Promise.race([h.createEngine(), expired]);
      if (!owner.leads(attempt)) { void engine.disconnect().catch(() => {}); owner.assertCurrent(attempt); }
      owner.ownEngine = engine;
      engine.onTransportLost((reason) => onViewLost(owner, engine, reason));
      const connectSignal = AbortSignal.any([owner.signal, deadline.signal]);
      try {
        await Promise.race([
          engine.connect(endpoint, media.media_token, media.cert_hash ?? undefined, {
            id: owner.id,
            role: 'view',
            signal: connectSignal,
            account: owner.context,
            refreshCertHash: () => api.mediaCertificatePin(),
          }),
          expired,
        ]);
        owner.assertCurrent(attempt);
        attach(owner, engine);
        return;
      } catch (error) {
        lastError = deadline.signal.aborted ? deadline.signal.reason : error;
        if (owner.ownEngine === engine) releaseOwnEngine(owner);
        else void engine.disconnect().catch(() => {});
        owner.assertCurrent(attempt);
        if (deadline.signal.aborted) throw deadline.signal.reason;
      }
    }
    throw lastError;
  } finally {
    clearTimeout(timer);
  }
}

function attach(owner: ViewOwner, engine: MediaEngine): void {
  owner.engine = engine;
  releaseAudio(owner);
  if (owner.kind === 'watch' && !owner.isSelfPreview) {
    // A self-preview must never play captured audio back into its own capture.
    // Watch = the stream's video AND its own audio (owner decision, plan §8).
    const h = requireHost();
    const { streamerId } = owner.target;
    owner.releaseAudio = engine.subscribeScreenShareAudio(streamerId, () => h.streamVolume(streamerId));
  }
  publish(owner, { phase: 'live', engine, route: owner.route, sessionId: owner.sessionId, error: null });
}

function fail(owner: ViewOwner, error: unknown): void {
  const deadline = error instanceof ViewDeadlineError;
  const message = deadline ? error.message : voiceErrorMessage(error, 'The stream could not be opened.');
  releaseAudio(owner);
  releaseOwnEngine(owner);
  const registered = owner.route === 'session' && !!owner.sessionId;
  owner.finished = true;
  publish(owner, {
    phase: 'failed', endReason: deadline ? 'deadline' : 'failed', error: message, engine: null,
  });
  // A view that never connected is retired by the server after 20 seconds
  // anyway; saying so now frees it at once.
  if (registered) {
    const receipt = owner.sessionId!;
    void createCallVoiceApi(owner.context).stopView(owner.target.channelId, receipt).catch(() => {});
  }
}

/** The relay (or the network) closed a view session's connection. */
function onViewLost(owner: ViewOwner, engine: MediaEngine, reason: string): void {
  if (!owner.current || owner.ownEngine !== engine) return;
  const h = requireHost();
  // Joining the call in the channel being watched moves the watch onto the
  // membership, and the relay then ends the view session: expected, and the
  // call takes over (see onCallCommitted).
  const call = h.callIn(owner.target.scope, owner.target.channelId);
  if (call) {
    releaseAudio(owner);
    releaseOwnEngine(owner);
    owner.attempt += 1;
    owner.route = 'call';
    owner.call = call;
    owner.sessionId = null;
    publish(owner, { phase: 'connecting', route: 'call', engine: null, sessionId: null });
    // Already connected: take it now. Otherwise the commit does.
    if (h.connectedCallMedia(call)) owner.promise = attemptWatch(owner).catch(() => {});
    return;
  }
  // The relay says why it closed a view (its close code and words reach both
  // transports); anything else is a failure.
  const relayReason = parseRelayCloseReason(reason);
  releaseAudio(owner);
  releaseOwnEngine(owner);
  owner.finished = true;
  publish(owner, {
    phase: relayReason ? 'ended' : 'failed',
    endReason: relayReason ?? 'failed',
    error: relayReason ? null : reason,
    engine: null,
  });
}

// ── The call moving under a view ───────────────────────────────────────────

/** A call connected: views of its channel move onto it. */
export function onCallCommitted(call: CallSession): void {
  const owner = watchOwner;
  if (owner && owner.current && !owner.finished
      && owner.target.scopeKey === call.context.key && owner.target.channelId === call.target.channelId) {
    if (owner.route === 'call' && owner.call === call && owner.engine) {
      // Already riding it.
    } else {
      // The relay carried the watch over to the membership at the join;
      // asking again is idempotent and returns `via_membership`.
      releaseAudio(owner);
      releaseOwnEngine(owner);
      owner.promise = attemptWatch(owner).catch(() => {});
    }
  }
}

/**
 * A call closed. A watch that rode it goes back onto a session of its own
 * once the membership is released (Leave is the only way out of a call, and
 * it never stops a watch).
 */
export function onCallClosed(call: CallSession): void {
  const h = host;
  if (!h) return;
  const owner = watchOwner;
  const rodeIt = !!owner && owner.current && !owner.finished && (owner.call === call
    || (owner.route === 'call' && owner.target.scopeKey === call.context.key
      && owner.target.channelId === call.target.channelId));
  if (owner && rodeIt) {
    releaseAudio(owner);
    owner.attempt += 1;
    owner.engine = null;
    owner.call = null;
    owner.route = null;
    // Leaving ends the publisher's local preview; it cannot become a remote
    // view of itself after the call's media engine has been released.
    if (owner.isSelfPreview) {
      owner.finished = true;
      publish(owner, { phase: 'ended', endReason: 'ended', route: null, engine: null, sessionId: null });
    } else {
      publish(owner, { phase: 'connecting', route: null, engine: null, sessionId: null });
    }
  }
  void h.callReleased(call).catch(() => {}).then(() => {
    if (owner && rodeIt && watchOwner === owner && owner.current && !owner.finished) {
      owner.promise = attemptWatch(owner).catch(() => {});
    }
  });
}

// ── Lifetime ────────────────────────────────────────────────────────────────

/** Close every view (sign-out). */
export function resetViewSessions(): void {
  if (watchOwner) endWatch(watchOwner);
  host?.publish(null);
}

/** Close the views that belong to an instance being disconnected. */
export function closeViewsForServer(serverId: string): void {
  if (watchOwner && watchOwner.target.scope.serverId === serverId) {
    endWatch(watchOwner);
    host?.publish(null);
  }
}
