import type { OperationContext } from '../../lib/operationContext';
import type { AccountScope } from '../../lib/serverScope';
import type { VoiceMode } from '../../types/voice.types';

export type CallPhase = 'joining' | 'connected' | 'reconnecting' | 'closing' | 'closed' | 'failed';
export type CallTarget = { scope: AccountScope; channelId: string; guildId: string | null };
type Release = () => void | Promise<void>;

/** One lifetime owns pending acquisitions as well as committed media. */
export class CallSession {
  readonly id: string = crypto.randomUUID();
  readonly controller = new AbortController();
  readonly signal = this.controller.signal;
  phase: CallPhase = 'joining';
  membershipSessionId: string | null = null;
  membershipUncertain = false;
  /**
   * How this membership takes part: `listen` until an in-place upgrade makes
   * it `joined` (same receipt, same media connection).
   */
  mode: VoiceMode = 'joined';
  /**
   * Everyone the gateway has reported in this call's channel since the call
   * began. The relay roster cannot tell a call member from a view session
   * (someone watching this client's stream), and a member always has a voice
   * state; so a roster peer seen here is a member, one never seen is a viewer.
   * Only ever grows during a call: "member" wins, because a member's leave
   * must rotate the voice key and a viewer's need not.
   */
  readonly seenMembers = new Set<string>();
  /** Settles once the server has released this membership (or it had none). */
  membershipReleased: Promise<void> | null = null;
  joinPromise: Promise<void> | null = null;
  private releases = new Set<Release>();
  private closing: Promise<void> | null = null;
  private operations = new Map<string, number>();

  constructor(
    readonly context: OperationContext,
    readonly target: CallTarget,
    private readonly isSelected: () => boolean,
    onExpired: () => void,
    readonly preferences: Record<string, unknown> = {},
  ) {
    const expire = () => onExpired();
    context.signal.addEventListener('abort', expire, { once: true });
    this.releases.add(() => context.signal.removeEventListener('abort', expire));
  }

  get current(): boolean { return !this.signal.aborted && this.isSelected() && !this.context.signal.aborted; }

  assertCurrent(): void {
    if (!this.current) throw new DOMException('The call has ended.', 'AbortError');
    this.context.assertCurrent();
  }

  /** Late resources are disposed immediately, rather than adopted by a closed owner. */
  own(release: Release): () => Promise<void> {
    let released: Promise<void> | null = null;
    const once = () => {
      this.releases.delete(once);
      return released ??= Promise.resolve().then(release).catch(error => {
        console.warn('[voice] Resource release failed:', error);
      });
    };
    if (this.signal.aborted) void once();
    else this.releases.add(once);
    return once;
  }

  guard<Args extends unknown[]>(callback: (...args: Args) => void): (...args: Args) => void {
    return (...args) => { if (this.current) callback(...args); };
  }

  operation(key: string): { current: () => boolean; assertCurrent: () => void } {
    const revision = (this.operations.get(key) ?? 0) + 1;
    this.operations.set(key, revision);
    const current = () => this.current && this.operations.get(key) === revision;
    return { current, assertCurrent: () => {
      this.assertCurrent();
      if (!current()) throw new DOMException('The call action was superseded.', 'AbortError');
    } };
  }

  delay(ms: number): Promise<void> {
    this.assertCurrent();
    return new Promise((resolve, reject) => {
      const abort = () => { clearTimeout(timer); reject(this.signal.reason); };
      const timer = setTimeout(() => { this.signal.removeEventListener('abort', abort); resolve(); }, ms);
      this.signal.addEventListener('abort', abort, { once: true });
    });
  }

  /** Revocation is synchronous; every independent release is attempted. */
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.phase = 'closing';
    this.controller.abort(new DOMException('The call has ended.', 'AbortError'));
    const releases = [...this.releases];
    this.releases.clear();
    this.closing = Promise.allSettled(releases.map(release => Promise.resolve().then(release)))
      .then(() => { this.phase = 'closed'; });
    return this.closing;
  }
}
