import { useState, useRef, useCallback, useEffect } from 'react';
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

  const btnStyle = (active: boolean, color: string, disabledColor: string) => ({
    padding: '0.5rem 1rem',
    backgroundColor: active ? color : disabledColor,
    color: 'white',
    border: 'none',
    borderRadius: '4px',
    cursor: connected ? 'pointer' : 'not-allowed',
    marginRight: '0.5rem',
    opacity: connected ? 1 : 0.5,
  });

  return (
    <div style={{ padding: '2rem', color: '#dcddde', backgroundColor: '#36393f', minHeight: '100vh', fontFamily: 'system-ui, sans-serif' }}>
      <h1 style={{ marginBottom: '0.5rem' }}>Media Engine Test</h1>
      <p style={{ color: '#72767d', marginBottom: '2rem' }}>
        Standalone test page for the custom QUIC media server.
        Connect to a running paracord-media-dev instance.
      </p>

      {/* Connection controls */}
      <div style={{ marginBottom: '1rem', display: 'flex', gap: '0.5rem', alignItems: 'flex-end' }}>
        <div>
          <label style={{ display: 'block', marginBottom: '0.25rem', fontSize: '0.85rem', color: '#b9bbbe' }}>Relay Endpoint</label>
          <input
            type="text"
            value={endpoint}
            onChange={(e) => setEndpoint(e.target.value)}
            disabled={connected}
            style={{
              width: '350px',
              padding: '0.5rem',
              backgroundColor: '#40444b',
              border: '1px solid #202225',
              borderRadius: '4px',
              color: '#dcddde',
            }}
          />
        </div>
        <div>
          <label style={{ display: 'block', marginBottom: '0.25rem', fontSize: '0.85rem', color: '#b9bbbe' }}>Auth Token</label>
          <input
            type="text"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            disabled={connected}
            style={{
              width: '200px',
              padding: '0.5rem',
              backgroundColor: '#40444b',
              border: '1px solid #202225',
              borderRadius: '4px',
              color: '#dcddde',
            }}
          />
        </div>
        <button
          onClick={handleConnect}
          disabled={connecting}
          style={{
            padding: '0.5rem 1.5rem',
            backgroundColor: connected ? '#ed4245' : '#3ba55d',
            color: 'white',
            border: 'none',
            borderRadius: '4px',
            cursor: connecting ? 'wait' : 'pointer',
            fontWeight: 600,
          }}
        >
          {connecting ? 'Connecting...' : connected ? 'Disconnect' : 'Connect'}
        </button>
      </div>

      {/* Status bar */}
      <div style={{
        marginBottom: '1.5rem',
        padding: '0.5rem 1rem',
        backgroundColor: connected ? '#2d4f3e' : '#2f3136',
        borderRadius: '4px',
        borderLeft: `3px solid ${connected ? '#3ba55d' : '#72767d'}`,
        display: 'flex',
        alignItems: 'center',
        gap: '0.75rem',
      }}>
        <div style={{
          width: 8,
          height: 8,
          borderRadius: '50%',
          backgroundColor: connected ? '#3ba55d' : '#72767d',
        }} />
        <span>{status}</span>
      </div>

      {/* Error display */}
      {error && (
        <div style={{
          marginBottom: '1rem',
          padding: '0.75rem 1rem',
          backgroundColor: '#4e2326',
          borderRadius: '4px',
          borderLeft: '3px solid #ed4245',
          color: '#f5a6a8',
        }}>
          {error}
          <button
            onClick={() => setError(null)}
            style={{
              float: 'right',
              background: 'none',
              border: 'none',
              color: '#f5a6a8',
              cursor: 'pointer',
            }}
          >
            X
          </button>
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem' }}>
        {/* Audio Controls */}
        <div style={{ padding: '1rem', backgroundColor: '#2f3136', borderRadius: '8px' }}>
          <h3 style={{ marginBottom: '0.75rem' }}>Audio Controls</h3>
          <button
            disabled={!connected}
            onClick={handleMute}
            style={btnStyle(muted, '#ed4245', '#4f545c')}
          >
            {muted ? 'Unmute' : 'Mute'}
          </button>
          <button
            disabled={!connected}
            onClick={handleDeafen}
            style={btnStyle(deafened, '#ed4245', '#4f545c')}
          >
            {deafened ? 'Undeafen' : 'Deafen'}
          </button>
        </div>

        {/* Video Controls */}
        <div style={{ padding: '1rem', backgroundColor: '#2f3136', borderRadius: '8px' }}>
          <h3 style={{ marginBottom: '0.75rem' }}>Video Controls</h3>
          <button disabled style={btnStyle(false, '#5865f2', '#4f545c')}>
            Enable Video (Phase 4)
          </button>
          <button disabled style={btnStyle(false, '#5865f2', '#4f545c')}>
            Share Screen (Phase 4)
          </button>
        </div>

        {/* Participants */}
        <div style={{ padding: '1rem', backgroundColor: '#2f3136', borderRadius: '8px' }}>
          <h3 style={{ marginBottom: '0.75rem' }}>Participants ({participants.length})</h3>
          {participants.length === 0 ? (
            <p style={{ color: '#72767d', fontSize: '0.85rem' }}>No participants yet</p>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
              {participants.map((p) => (
                <div
                  key={p.userId}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '0.5rem',
                    padding: '0.4rem 0.6rem',
                    backgroundColor: '#36393f',
                    borderRadius: '4px',
                    border: p.speaking ? '1px solid #3ba55d' : '1px solid transparent',
                  }}
                >
                  <div style={{
                    width: 8,
                    height: 8,
                    borderRadius: '50%',
                    backgroundColor: p.speaking ? '#3ba55d' : '#72767d',
                  }} />
                  <span style={{ flex: 1, fontSize: '0.85rem' }}>{p.userId}</span>
                  {/* Audio level bar */}
                  <div style={{
                    width: 60,
                    height: 6,
                    backgroundColor: '#202225',
                    borderRadius: 3,
                    overflow: 'hidden',
                  }}>
                    <div style={{
                      width: `${levelPercent(p.audioLevel)}%`,
                      height: '100%',
                      backgroundColor: p.speaking ? '#3ba55d' : '#4f545c',
                      transition: 'width 100ms',
                    }} />
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Debug Log */}
        <div style={{ padding: '1rem', backgroundColor: '#2f3136', borderRadius: '8px' }}>
          <h3 style={{ marginBottom: '0.75rem' }}>Debug Log</h3>
          <div style={{
            fontSize: '0.75rem',
            fontFamily: 'monospace',
            maxHeight: '250px',
            overflow: 'auto',
            backgroundColor: '#202225',
            borderRadius: '4px',
            padding: '0.5rem',
          }}>
            {logs.length === 0 ? (
              <span style={{ color: '#72767d' }}>Waiting for connection...</span>
            ) : (
              logs.map((entry, i) => (
                <div key={i} style={{
                  color: entry.level === 'error' ? '#ed4245' : entry.level === 'warn' ? '#faa61a' : '#72767d',
                  marginBottom: '2px',
                }}>
                  <span style={{ color: '#4f545c' }}>[{entry.time}]</span> {entry.message}
                </div>
              ))
            )}
            <div ref={logEndRef} />
          </div>
        </div>
      </div>
    </div>
  );
}
