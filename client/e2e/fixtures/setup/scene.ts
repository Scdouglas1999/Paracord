/**
 * The first-run review scene's facts (docs/setup-spec.md, prototype
 * output/design-reference/setup/paracord-first-run.html): one computer, one
 * friend's server, and the people the invite card shows. Every number here is
 * what the prototype's screens show, so a shot of the first-run UI against the
 * scene reads the same as the reference.
 */

/** This computer, as the host steps see it (prototype: 73.162.4.19 / 192.168.1.28). */
export const THIS_COMPUTER = {
  lanIp: '192.168.1.28',
  gatewayIp: '192.168.1.1',
  externalIp: '73.162.4.19',
  /** First free port of 8443..=8463 (spec 2.3). */
  port: 8443,
  hostRoot: '/home/sam/.local/share/paracord-host',
} as const;

/** The scene's clock: first-run copy has no dates, but expiry and "just now" lines read it. */
export const CLOCK = { start: '2026-10-12T20:30:00-05:00' } as const;
export const SCENE_TIMEZONE = 'America/Chicago';

/** The server the join steps preview (prototype: Kanto Friends, hue 200, 9 online, 41 members). */
export const KANTO = {
  name: 'Kanto Friends',
  host: 'kanto.home.arpa',
  port: 8443,
  hue: 200,
  online: 9,
  members: 41,
  faces: [
    { initial: 'M', hue: 18 },
    { initial: 'T', hue: 150 },
    { initial: 'J', hue: 220 },
  ],
} as const;

/** The host's hue choices (spec 1.4). */
export const HOST_HUES = [18, 350, 38, 150, 172, 200, 220, 0] as const;

/** The 24 words the phrase screen shows (prototype WORDS). */
export const PHRASE_WORDS =
  'ember quarry lantern osprey velvet harbor tundra copper meadow signal orbit pebble falcon hollow saddle juniper beacon marble canyon thistle drift summit cobalt willow'.split(
    ' ',
  );
