import { useState, useRef, useCallback, useEffect } from 'react';
import { Mic, Video, Users, Terminal, X } from 'lucide-react';
import { cn } from '../lib/utils';
import type { MediaEngine } from '../lib/media/mediaEngine';

interface LogEntry {
  time: string;
  message: string;
  level: 'info' | 'warn' | 'error';
}

interface Participant {
  userId: string;
  audioLevel: number;
  speaking: boolean;
}

/**
 * Standalone test page for the custom media engine.
 * Accessible at /media-test. Connects directly to paracord-media-dev binary.
 * Does NOT interact with the existing voice UI or voiceStore.
 */
export default function MediaTest() {
  const [connected, setConnected] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [endpoint, setEndpoint] = useState('https://localhost:8443/media');
  const [token, setToken] = useState('dev-test-token');
  const [status, setStatus] = useState('Disconnected');
  const [muted, setMuted] = useState(false);
  const [deafened, setDeafened] = useState(false);
  const [participants, setParticipants] = useState<Participant[]>([]);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [error, setError] = useState<string | null>(null);

  const engineRef = useRef<MediaEngine | null>(null);
  const logEndRef = useRef<HTMLDivElement>(null);

  const addLog = useCallback((message: string, level: LogEntry['level'] = 'info') => {
    const time = new Date().toISOString().split('T')[1].slice(0, 12);
    setLogs((prev) => [...prev.slice(-200), { time, message, level }]);
  }, []);

  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [logs]);

  const handleConnect = useCallback(async () => {
    if (connected) {
      // Disconnect
      setStatus('Disconnecting...');
      addLog('Disconnecting from media server...');
      try {
        await engineRef.current?.disconnect();
        engineRef.current = null;
        setConnected(false);
        setStatus('Disconnected');
        setParticipants([]);
        addLog('Disconnected.');
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        addLog(`Disconnect error: ${msg}`, 'error');
        setError(msg);
      }
      return;
    }

    // Connect
    setConnecting(true);
    setError(null);
    setStatus('Creating media engine...');
    addLog('Creating media engine instance...');

    try {
      const { createMediaEngine } = await import('../lib/media/mediaEngine');
      const engine = await createMediaEngine();
      engineRef.current = engine;

      // Set up callbacks
      engine.onSpeakingChange((speakers) => {
        setParticipants((prev) =>
          prev.map((p) => ({
            ...p,
            audioLevel: speakers.get(p.userId) ?? 127,
            speaking: speakers.has(p.userId),
          })),
        );
      });

      engine.onParticipantJoin((userId) => {
        addLog(`Participant joined: ${userId}`);
        setParticipants((prev) => [
          ...prev,
          { userId, audioLevel: 127, speaking: false },
        ]);
      });

      engine.onParticipantLeave((userId) => {
        addLog(`Participant left: ${userId}`);
        setParticipants((prev) => prev.filter((p) => p.userId !== userId));
      });

      setStatus('Connecting...');
      addLog(`Connecting to ${endpoint}...`);
      await engine.connect(endpoint, token);

      setConnected(true);
      setStatus('Connected');
      addLog('Connected successfully!');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setStatus('Connection failed');
      setError(msg);
      addLog(`Connection failed: ${msg}`, 'error');
      engineRef.current = null;
    } finally {
      setConnecting(false);
    }
  }, [connected, endpoint, token, addLog]);

  const handleMute = useCallback(() => {
    const next = !muted;
    setMuted(next);
    engineRef.current?.setMute(next);
    addLog(next ? 'Muted' : 'Unmuted');
  }, [muted, addLog]);

  const handleDeafen = useCallback(() => {
    const next = !deafened;
    setDeafened(next);
    engineRef.current?.setDeaf(next);
    if (next) setMuted(true);
    addLog(next ? 'Deafened' : 'Undeafened');
  }, [deafened, addLog]);

  // Audio level as a percentage (0 = loudest/127, 127 = silent/0)
  const levelPercent = (level: number) => Math.max(0, 100 - (level / 127) * 100);

  // Dev-tool control button. Active (muted/deafened) reads as the danger fill;
  // idle is a quiet secondary. Consumes Emerald Commons tokens — no ad-hoc hex.
  const ctrlBtn = (active: boolean) =>
    cn(
      'inline-flex h-9 items-center justify-center rounded-sm px-3.5 text-label font-semibold transition-colors duration-[140ms] focus-visible:outline-none focus-visible:[box-shadow:var(--focus-ring)] disabled:cursor-not-allowed disabled:opacity-50',
      active
        ? 'bg-accent-danger-fill text-text-on-danger hover:brightness-95'
        : 'bg-bg-mod-subtle text-text-secondary hover:bg-bg-mod-strong hover:text-text-primary',
    );

  const inputCls =
    'h-10 rounded-sm border border-border-subtle bg-bg-tertiary px-3 font-code text-meta text-text-primary transition-colors placeholder:text-text-muted focus:border-accent-primary focus:outline-none focus:[box-shadow:var(--focus-ring-input)] disabled:opacity-60';

  const panelCls = 'rounded-md border border-border-subtle bg-bg-secondary p-4 shadow-sm';
  const sectionHeadCls = 'mb-3 flex items-center gap-2 text-section uppercase text-text-muted';

  return (
    <div className="min-h-screen w-full overflow-y-auto bg-bg-primary p-8 text-text-primary">
      <div className="mx-auto max-w-4xl">
        <header className="mb-8">
          <p className="mb-2 text-section uppercase text-accent-secondary">Internal · Media transport</p>
          <h1 className="font-display text-title text-text-primary">Media engine harness</h1>
          <p className="mt-1.5 max-w-2xl text-body text-text-secondary">
            Drive the custom QUIC media server directly against a running
            <span className="font-code text-text-primary"> paracord-media-dev</span> instance. This
            bypasses the voice UI and store entirely.
          </p>
        </header>

        {/* Connection controls */}
        <div className="mb-4 flex flex-wrap items-end gap-3">
          <div className="flex flex-col">
            <label htmlFor="mt-endpoint" className="mb-1.5 text-section uppercase text-text-muted">
              Relay endpoint
            </label>
            <input
              id="mt-endpoint"
              type="text"
              value={endpoint}
              onChange={(e) => setEndpoint(e.target.value)}
              disabled={connected}
              className={cn(inputCls, 'w-[22rem] max-w-full')}
            />
          </div>
          <div className="flex flex-col">
            <label htmlFor="mt-token" className="mb-1.5 text-section uppercase text-text-muted">
              Auth token
            </label>
            <input
              id="mt-token"
              type="text"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              disabled={connected}
              className={cn(inputCls, 'w-52 max-w-full')}
            />
          </div>
          <button
            onClick={handleConnect}
            disabled={connecting}
            className={cn(
              'inline-flex h-10 items-center justify-center rounded-sm px-5 text-label font-semibold shadow-sm transition-colors duration-[140ms] focus-visible:outline-none focus-visible:[box-shadow:var(--focus-ring)] disabled:cursor-wait disabled:opacity-70',
              connected
                ? 'bg-accent-danger-fill text-text-on-danger hover:brightness-95'
                : 'bg-accent-primary text-text-on-accent hover:bg-accent-primary-hover active:bg-accent-primary-active',
            )}
          >
            {connecting ? 'Connecting…' : connected ? 'Disconnect' : 'Connect'}
          </button>
        </div>

        {/* Status bar */}
        <div
          className={cn(
            'mb-6 flex items-center gap-3 rounded-md border border-l-[3px] border-border-subtle bg-bg-secondary px-4 py-2.5',
            connected ? 'border-l-accent-success' : 'border-l-interactive-muted',
          )}
        >
          <span
            className={cn(
              'h-2 w-2 shrink-0 rounded-full',
              connected ? 'bg-accent-success' : 'bg-interactive-muted',
            )}
          />
          <span className="font-code text-meta text-text-secondary">{status}</span>
        </div>

        {/* Error display */}
        {error && (
          <div className="mb-4 flex items-start gap-3 rounded-md border border-l-[3px] border-border-subtle border-l-accent-danger bg-danger-tint px-4 py-3">
            <p className="flex-1 font-code text-meta text-accent-danger">{error}</p>
            <button
              onClick={() => setError(null)}
              aria-label="Dismiss error"
              className="rounded-sm p-1 text-accent-danger transition-colors hover:bg-bg-mod-subtle focus-visible:outline-none focus-visible:[box-shadow:var(--focus-ring)]"
            >
              <X size={16} />
            </button>
          </div>
        )}

        <div className="grid gap-4 md:grid-cols-2">
          {/* Audio Controls */}
          <section className={panelCls}>
            <h2 className={sectionHeadCls}>
              <Mic size={15} /> Audio
            </h2>
            <div className="flex gap-2">
              <button disabled={!connected} onClick={handleMute} className={ctrlBtn(muted)}>
                {muted ? 'Unmute' : 'Mute'}
              </button>
              <button disabled={!connected} onClick={handleDeafen} className={ctrlBtn(deafened)}>
                {deafened ? 'Undeafen' : 'Deafen'}
              </button>
            </div>
          </section>

          {/* Video Controls */}
          <section className={panelCls}>
            <h2 className={sectionHeadCls}>
              <Video size={15} /> Video
            </h2>
            <div className="flex flex-wrap gap-2">
              <button disabled className={ctrlBtn(false)}>
                Enable video
              </button>
              <button disabled className={ctrlBtn(false)}>
                Share screen
              </button>
              <span className="self-center font-code text-meta text-text-muted">Phase 4</span>
            </div>
          </section>

          {/* Participants */}
          <section className={panelCls}>
            <h2 className={sectionHeadCls}>
              <Users size={15} /> Participants
              <span className="ml-auto rounded-xs bg-bg-mod-strong px-1.5 py-0.5 font-code text-meta tabular-nums text-text-secondary">
                {participants.length}
              </span>
            </h2>
            {participants.length === 0 ? (
              <p className="text-meta text-text-secondary">Waiting for peers to join the room.</p>
            ) : (
              <div className="flex flex-col gap-1.5">
                {participants.map((p) => (
                  <div
                    key={p.userId}
                    className={cn(
                      'flex items-center gap-3 rounded-sm border px-3 py-2 transition-colors',
                      p.speaking ? 'border-accent-success/50 bg-bg-mod-subtle' : 'border-transparent',
                    )}
                  >
                    <span
                      className={cn(
                        'h-2 w-2 shrink-0 rounded-full',
                        p.speaking ? 'bg-status-online' : 'bg-status-offline',
                      )}
                    />
                    <span className="flex-1 truncate font-code text-meta text-text-secondary">
                      {p.userId}
                    </span>
                    <div className="h-1.5 w-16 overflow-hidden rounded-full bg-bg-tertiary">
                      <div
                        className="h-full rounded-full transition-[width] duration-100"
                        style={{
                          width: `${levelPercent(p.audioLevel)}%`,
                          backgroundColor: p.speaking ? 'var(--accent-primary)' : 'var(--interactive-muted)',
                        }}
                      />
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>

          {/* Debug Log */}
          <section className={panelCls}>
            <h2 className={sectionHeadCls}>
              <Terminal size={15} /> Trace
            </h2>
            <div className="max-h-64 overflow-auto rounded-sm bg-bg-tertiary p-3 font-code text-meta leading-relaxed">
              {logs.length === 0 ? (
                <span className="text-text-muted">No events yet — connect to start the trace.</span>
              ) : (
                logs.map((entry, i) => (
                  <div
                    key={i}
                    className={cn(
                      'mb-0.5',
                      entry.level === 'error'
                        ? 'text-accent-danger'
                        : entry.level === 'warn'
                          ? 'text-accent-warning'
                          : 'text-text-secondary',
                    )}
                  >
                    <span className="text-interactive-muted">[{entry.time}]</span> {entry.message}
                  </div>
                ))
              )}
              <div ref={logEndRef} />
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
