import { THIS_COMPUTER } from './scene';

/**
 * Scripted host behavior: what the Rust side of the desktop app answers during
 * first run (docs/setup-spec.md 2.3 preflight, 2.6 setup rows, 5.2/5.4 reach).
 * The copy strings are the spec's, verbatim, so a screenshot reads the same as
 * the real thing.
 */

export type PreflightScenario = 'ok' | 'no_user_services' | 'no_keychain' | 'existing_server' | 'no_port' | 'no_space' | 'already_hosting';
/** `paracord_core::reachability` states (spec 5.2). */
export type ReachScenario = 'open' | 'direct' | 'refused' | 'no_answer' | 'shared_address' | 'firewall_blocked';
/** What else can happen to the setup rows. */
export type SetupScenario = 'ok' | 'install_fail' | 'start_fail' | 'storage_unencrypted' | 'backup_fail';

export type RowStep = 'install' | 'init' | 'service' | 'start' | 'storage' | 'reach' | 'backup';
export interface ProgressEvent {
  /** 1..5 as in spec 2.6 (row 3 is the JS credential row; the host never emits it). */
  row: number;
  step: RowStep;
  state: 'run' | 'ok' | 'warn' | 'fail';
  detail?: string;
  code?: string;
}

export interface PreflightAnswer {
  ok: boolean;
  port?: number;
  reason?: Exclude<PreflightScenario, 'ok' | 'already_hosting'>;
  detail?: string;
  existing_url?: string;
}

export function preflightAnswer(s: PreflightScenario): PreflightAnswer {
  switch (s) {
    case 'ok':
    case 'already_hosting': // never blocks (spec 2.3): the flow resumes at the first incomplete row
      return { ok: true, port: THIS_COMPUTER.port };
    case 'existing_server':
      return { ok: false, reason: s, detail: 'Paracord is already running on this computer.', existing_url: 'https://127.0.0.1:8443' };
    case 'no_user_services':
      return { ok: false, reason: s, detail: 'systemctl --user show-environment failed' };
    case 'no_keychain':
      return { ok: false, reason: s, detail: 'org.freedesktop.secrets is not on the bus' };
    case 'no_port':
      return { ok: false, reason: s, detail: 'ports 8443-8463 are all in use' };
    case 'no_space':
      return { ok: false, reason: s, detail: '312 MB free under the host root' };
  }
}

/** The reach row's outcome per spec 5.4. */
export function reachEvent(reach: ReachScenario): ProgressEvent {
  const { externalIp, port } = THIS_COMPUTER;
  switch (reach) {
    case 'open':
      return { row: 4, step: 'reach', state: 'ok', code: 'open', detail: `Your router opened the way. Friends can reach you at ${externalIp}.` };
    case 'direct':
      return {
        row: 4,
        step: 'reach',
        state: 'ok',
        code: 'direct',
        detail: `This computer has its own public address (${externalIp}). Friends can reach it if your firewall allows port ${port}.`,
      };
    case 'refused':
      return { row: 4, step: 'reach', state: 'warn', code: 'refused', detail: "Your router didn't allow it, so for now only people on your home network can join." };
    case 'no_answer':
      return { row: 4, step: 'reach', state: 'warn', code: 'no_answer', detail: "Your router didn't answer, so for now only people on your home network can join." };
    case 'shared_address':
      return {
        row: 4,
        step: 'reach',
        state: 'warn',
        code: 'shared_address',
        detail:
          "Your internet connection shares its public address with others (your provider, or another router in front of yours), so friends outside can't reach this computer. People on your home network can join.",
      };
    case 'firewall_blocked':
      return { row: 4, step: 'reach', state: 'warn', code: 'firewall_blocked', detail: 'Windows Firewall is blocking friends.' };
  }
}

/** The share address the invite carries for a reach state (spec 5.6). */
export function shareAddress(reach: ReachScenario): { url: string; reach: 'internet' | 'internet_unconfirmed'; note?: 'port_not_forwarded'; port: number } {
  // The link is always the public address; until the router opened the way it
  // is unconfirmed, and the note says the port is the host's to forward.
  const internet = reach === 'open' || reach === 'direct';
  const url = `https://${THIS_COMPUTER.externalIp}:${THIS_COMPUTER.port}`;
  return internet
    ? { url, reach: 'internet', port: THIS_COMPUTER.port }
    : { url, reach: 'internet_unconfirmed', note: 'port_not_forwarded', port: THIS_COMPUTER.port };
}

/**
 * The `host://progress` events one `host_setup_start` produces, in order. Rows
 * 1, 2, 4 and 5 are the host's (spec 2.6); a failing row stops the sequence.
 */
export function progressScript(setup: SetupScenario, reach: ReachScenario): ProgressEvent[] {
  const events: ProgressEvent[] = [];
  const run = (row: number, step: RowStep) => events.push({ row, step, state: 'run' });
  const ok = (row: number, step: RowStep, detail?: string) => events.push({ row, step, state: 'ok', detail });

  run(1, 'install');
  if (setup === 'install_fail') {
    events.push({ row: 1, step: 'install', state: 'fail', code: 'install_failed', detail: "Couldn't copy Paracord's server files (permission denied)." });
    return events;
  }
  ok(1, 'install');
  run(1, 'init');
  ok(1, 'init');
  run(1, 'service');
  ok(1, 'service');
  run(1, 'start');
  if (setup === 'start_fail') {
    events.push({ row: 1, step: 'start', state: 'fail', code: 'start_timeout', detail: "Paracord on this computer didn't start." });
    return events;
  }
  ok(1, 'start');

  run(2, 'storage');
  if (setup === 'storage_unencrypted') {
    events.push({ row: 2, step: 'storage', state: 'fail', code: 'storage_unencrypted', detail: 'Paracord on this computer is running without encryption.' });
    return events;
  }
  ok(2, 'storage');

  // Row 3 is the credential row, run by the page (spec 2.6); the host is quiet.
  run(4, 'reach');
  events.push(reachEvent(reach));

  run(5, 'backup');
  if (setup === 'backup_fail') {
    events.push({ row: 5, step: 'backup', state: 'fail', code: 'backup_failed', detail: "The first backup didn't finish (no space left on device)." });
    return events;
  }
  ok(5, 'backup', 'Kept on this computer for 14 days.');
  return events;
}
