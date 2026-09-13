# Paracord 3.0.0 — Lantern Stage

**Paracord 3.0.0** is a new client. The interface has been rebuilt from the ground up around one idea — *light is people, and the room is the app*: every building on the street shows who is in it and where, rooms you can walk into are lit, and the whole thing moves like something physical. Underneath it, the September improvement programme closed a long list of correctness, reliability and operations items, browser voice works for the first time, and installing a server or a client is one command.

Full compare: **[v2.0.0...v3.0.0](https://github.com/Scdouglas1999/Paracord/compare/v2.0.0...v3.0.0)**

> This release is published as a **draft** first. Every artifact is built and attached by CI; it goes live only after the builds have been installed and tested by hand.

---

## Highlights at a Glance

| Area | What's new |
|------|------------|
| **Interface** | **Lantern Stage** — a new design system (tokens, type, elevation, four themes: Night, Daylight, AMOLED, High contrast), a Buildings column that shows presence as light, a Lobby of rooms, a Stage for calls, a Home that tells you what is happening tonight |
| **Motion** | A physical motion layer: lights come on when presence arrives, you walk into a room rather than teleport, arrivals travel one path, messages lift out of the composer, the speaking ring takes the voice, theme changes as the lights changing, an outage dims the building — all transform/opacity, all under 500 ms, all measured by a frame-timing gate, all instant under reduced motion |
| **Voice in the browser** | The native QUIC/WebTransport media path now works from Chromium: certificate rotation, HTTP/3 session framing, leave detection, mic/camera permissions policy, the audio worklet asset |
| **Install** | One-command install for servers and clients (`scripts/install.sh`, `scripts/install.ps1`), with a claim-token first run |
| **Reliability** | The improvement programme: DM voice ownership, deterministic PostgreSQL test templates, delivery guarantees, and the fixes recorded in `docs/improvement-program.md` |

## Upgrading

Server binaries and client installers are attached below. The server upgrades in place from v2.0.0 on SQLite and PostgreSQL (both upgrade paths are exercised in CI from the v2.0.0 tag). Client settings, including the new theme and motion preferences, are per-device.

## Verification

_Filled in at release from the live QA fleet's reports and the final gate run._

## Previous releases

- [v2.0.0 — AutoMod, Server Health, and a Server That Looks After Itself](https://github.com/Scdouglas1999/Paracord/releases/tag/v2.0.0)
- [v1.0.0 — Native Media, Zero-Config, Emerald Commons](https://github.com/Scdouglas1999/Paracord/releases/tag/v1.0.0)
