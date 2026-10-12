# S13 checkpoint: the first-run UI

Package S13 of [`setup-plan.md`](setup-plan.md), implementing
[`setup-spec.md`](../setup-spec.md) §1 (all of it), §2.6 on the JS side, §2.11
claim mode, §6.6 web join and the §1.14 routes, at parity with the
owner-approved prototype (`output/design-reference/setup/paracord-first-run.html`),
which wins over §1.3's welcome text: the launch sequence and the split
welcome (Host left, Join right, hover lights one side and dims the other,
choosing a side opens it to the full window, then the steps).

## 1. What exists

| Piece | Where |
|---|---|
| Store: mode (desktop / claim / web), phase, path, reached step, fields, rows, phrase (memory only), result, sheet; `launchSeen` (versioned key `firstRun.launchSeen`) | `client/src/stores/firstRunStore.ts` |
| Page: routes, phase, screen swap, preview geometry, clipboard watch, deep-link intake, setup start, sheets, sign-in, phrase, host invite, Done handoff | `client/src/pages/firstRun/FirstRunPage.tsx` |
| Flows: preflight, host setup through `hostStore` (row 3 = `prepareNewIdentity` → `hostStore.claim` → `adoptNewAccount` → privacy defaults → `writeEscrow`), claim mode (`/setup/credential-claim`, then `/admin/host-status` rows), join (probe → `signUpWithPassword` → `POST /invites/{code}`), trust on Continue | `pages/firstRun/flows.ts` |
| Row copy, the row sequencer (in order, ≥ 300 ms each, a failed row stops the rest), chips, §4.6 storage copy | `pages/firstRun/rows.ts` |
| Invite check (desktop through the shell's new `preview_invite`, web same-origin) | `pages/firstRun/inviteCheck.ts` |
| Escrow key (§4.7) with the server crate's vector | `pages/firstRun/escrow.ts` |
| Landing (`general`), home-server invites, claim code from the fragment | `pages/firstRun/{landing,claimToken}.ts` |
| Screens | `components/firstRun/{Launch,TitleBar,Welcome,Screen,NameStep,InviteStep,AccountStep,SetupStep,PhraseStep,HostInviteStep,SignInStep,Sheets,Handoff,primitives}.tsx` |
| Live preview: the app at window size from Index recipes (`ix-sq`, `ix-av`, `ix-ch`, `ix-rm`, `ix-search`, dock) and a static model | `components/firstRun/preview/{Preview.tsx,model.ts,preview.css}` |
| Styles (`fr-*`), `--fr-*` tokens | `components/firstRun/firstRun.css`, `styles/tokens.css` (first-run block) |

Composed, not rebuilt: S10's `IdentityChangedSheet`, S12's `ProtectedSheet`,
S3's `lib/oneCredential` (`signUpWithPassword`, `prepareNewIdentity`,
`adoptNewAccount`, `signInWithPassword`, `completeMfaSignIn`, `legacySignIn`,
`completeLegacyMfa`, `confirmRecoverySaved`, `currentRecoveryPhrase`), S7's
`hostStore` (`runPreflight`, `runSetup({ port, account })`, `retry`,
`retryReachability`, `allowFirewall`, `logsTail`, `loadInfo`, `loadStatus`,
`onLaunch`), S1's `assessNewPassword`, S9's `parseInviteLink`, S10's
`trustWords` / `probeServerIdentity` / `trustServer`, S11's
`useDeepLinkIntake`, `setFirstRunProbe`, `watchClipboardInvite`,
`copySecretToClipboard`, S5's `previous_url`. No mock code is in the product.

### Routes (§1.14, `App.tsx` route table)

`/welcome`, `/welcome/sign-in`, `/welcome/:path/:step` (desktop);
`/setup-server[/:step]` (claim mode; `InstanceSetupPage` deleted);
`/invite/:code[/:step]` → `InvitePage` renders the first run (web join) for a
browser without a session, the old accept page otherwise; `/connect` →
`ConnectRedirect` (no servers and no session: `/welcome` on the desktop,
`/login` on the web; else `/app` with the Add server sheet on Join).
`OnboardingWizard` deleted. `FIRST_RUN_SIGN_IN_PATH` is now
`/welcome/sign-in`. `App` calls `useHostStore.getState().onLaunch()` once on
the desktop and renders `FirstRunHandoff` outside the routes.

### Behavior notes

- **Launch.** The draw and the wordmark are the loading screen's own
  (`#pc-boot`, same `draw` motion): on a real first launch it is already on
  screen before any script. `Launch` draws that screen's final frame with its
  own classes, holds it (`useBootSplashHold`) so it plays to the end and fades
  over an identical picture, then clears the background and glides the mark
  (550 ms spring) onto the 96 px welcome mark. Any key or click skips; reduced
  motion has no launch. Shown only with no saved servers and `launchSeen` unset.
- **Welcome halves** animate only transform/opacity (the prototype's
  `flex-grow` is replaced by window-wide glow layers that travel, and content
  that slides and fades). Each half is a picture plus one covering button.
- **Done** (§1.13): the flow column leaves, the preview FLIPs to the full
  window (360 ms), then the route moves to `general` and the grown preview
  stays as an overlay until the Index frame has drawn, then crossfades out
  (120 ms). The AppShell chunk is prefetched at the phrase step. Narrow
  windows and reduced motion go straight to the app. Toasts: "{name} is
  live" / "You joined {server}".
- Esc: closes a sheet, else Back. Enter submits the step. Focus goes to the
  step's first field after its entrance.

## 2. Compare results (1280×800, `node e2e/setup-compare.mjs s13`)

All shots in `output/design-reference/setup-build/s13/`, side-by-sides in
`…/s13/compare/`, read one by one. Mean pixel difference:

| State | Mean | State | Mean |
|---|---|---|---|
| welcome | 0.36% | join-invite-card | 0.72% |
| welcome-hover-host / -join | 0.35% / 0.36% | join-invite-checking | 0.48% |
| welcome-choose-host-140ms | 0.73% | join-invite-clipboard / welcome-clipboard | 0.48% |
| host-name-empty / -typed | 0.26% / 0.37% | join-invite-empty* | 0.47% |
| host-name-blocked-* (5)* | 0.59–1.05% | join-invite-ca-verified* | 0.75% |
| account-empty / -weak / -strong | 0.27 / 0.38 / 0.39% | join-invite-invalid / -unreachable / -old-server* | 0.57 / 0.81 / 0.64% |
| host-setup-running | 0.26% | identity-changed* | 3.71% |
| host-setup-done | 0.31% | join-account | 1.33% |
| host-setup-refused / -no-answer* / -shared* | 0.34 / 0.34 / 0.97% | join-setup-done | 1.18% |
| host-setup-fail* | 0.25% | join-phrase | 1.42% |
| privacy-sheet-host / -join | 3.60 / 2.20% | done-join | 3.88% |
| router-sheet / shared-sheet* | 1.73 / 3.49% | sign-in-empty / -probed / -mfa / -legacy* | 0.83 / 1.55 / 1.71 / 2.35% |
| phrase-blurred / -revealed | 0.20 / 0.49% | claim-mode-setup-web / -at-rest-on / -off* | 0.53 / 0.53 / 0.98% |
| host-invite-internet / -lan | 0.56 / 1.07% | launch-1150ms | 1.83% |
| done-host | 0.33% | | |

\* derived reference (weaker authority). Prototype references: 27 compared,
mean of means 0.94%, worst 3.88% (done-join). What the larger numbers are:

- **Join preview** (join-account, join-setup-done, join-phrase, done-join):
  channels and messages are placeholder shapes, as §1.9 requires (the one
  deliberate deviation from the prototype); everything else matches.
- **Trust words** are the real words of the scene's fingerprint
  (`coconut · gasp · air · volume`), not the prototype's placeholder words.
- **privacy-sheet-*:** S12's sheet (its switches are Index cream, not green,
  S12 deviation 1); the modal sits ~10 px higher with taller rows (the app's
  body line height inside the portal).
- **identity-changed:** S10's sheet design (its own layout); the reference is
  derived.
- **sign-in-*:** the derived references draw the join preview with content and
  a different MFA layout; mine shows the trust row and the placeholder
  preview.
- **launch-1150ms:** the frame on screen is the loading screen (`#pc-boot`,
  184 px mark), not the prototype's 168 px boot (see §1).
- The prototype's `--ink3` is .5; Index's is .62 (the contrast rule), so quiet
  text is a little brighter everywhere.

Other windows (`…/s13/viewports/`, read): 1040×680 (preview scaled to fit,
flow column scrolls in Setup), 900×700 (single column, welcome halves fit),
390×844 web join (16 px gutters, sticky footer). The progress strip sits
next to the brand on a phone.

## 3. Commands and results

| Check | Result |
|---|---|
| `npm run typecheck` | clean |
| `npm run test:unit` | 4822 passed, 1 failed: `CallSheet.test.tsx › a short drag springs back` (known timing flake) |
| new unit tests | `pages/firstRun/{rows,inviteCheck,escrow}.test.ts`, `components/firstRun/validation.test.ts`, updated `InvitePage.test.tsx`, `vocabulary.test.ts` |
| `npm run lint` | 0 errors |
| `test:tokens`, `test:motion-lint`, `test:a11y:static`, `test:contrast` | pass |
| `setup-s13.spec.ts` (scene, ports 5003/5005) | 29 tests pass (all states above, viewports, idle-motion check: nothing running 2 s after welcome and after setup) |
| `setup-harness.spec.ts` | 21 pass (updated to S7's two-call `host_setup_start`) |
| `real-server.setup-claim.spec.ts`, `real-server.setup-join.spec.ts` (release binary with this UI embedded, own server on 18290, data dir deleted) | 2 pass |
| `cargo clippy -p paracord-desktop -p paracord-hostctl --all-targets -D warnings`, `cargo fmt --check` | clean |
| `cargo test -p paracord-desktop --lib invite_preview`, `cargo test -p paracord-hostctl --lib` | 2 + 55 pass |

Run the visual spec:

```
cd client
PARACORD_E2E_SETUP_SPEC=setup-s13 PARACORD_E2E_SETUP_PORT=5003 PARACORD_E2E_SETUP_RT_PORT=5005 \
PARACORD_E2E_SETUP_WP=s13 npx playwright test -c e2e/setup-review.config.ts
node e2e/setup-compare.mjs s13
```

The real-server specs launch their own server; run them with
`PARACORD_E2E_REAL=1 PARACORD_E2E_SERVER_BIN=<release paracord-server>` and
`--project real-server` (they are in `playwright.config.ts`'s real-server
match; they do not need the shared harness on 18150).

## 4. Changes outside the S13 row (smallest, named)

1. **`client/src-tauri/src/lib.rs`** (S10's trust region): new command
   `preview_invite({ serverUrl, code })` + its `generate_handler!` line and two
   unit tests. The invite card has to show a server before it is trusted, and
   `native_fetch` refuses untrusted hosts by design; this is the one other
   first-contact request (HTTPS off this machine, same verifier, code checked,
   path built in Rust) and it reports the certificate of that same connection,
   so the words shown are the certificate the preview came over.
2. **`crates/paracord-hostctl/src/host.rs`, `client/src/lib/host/types.ts`**
   (S7): `HostInfo.instance_id`. The escrow key's HKDF info is the instance id
   and nothing exposed it to the page.
3. **`client/src/lib/clipboardInvite.ts`** (S11): a link read by a watch that
   stopped mid-read (a React remount) is offered again instead of being lost.
   Found in e2e: under StrictMode the welcome never saw the clipboard invite.
4. **`client/src/lib/deepLinks.ts`** (S11): `FIRST_RUN_SIGN_IN_PATH` repointed.
5. **`client/src/styles/tokens.css`**: the `--fr-*` block (the plan says
   `globals.css`, but literal colors may only live in `tokens.css`).
6. **S13a fixture** (`e2e/fixtures/setup/tauriHost.ts`): stubs for
   `preview_invite`, `native_fetch` (forwarded to the page's own fetch so the
   scene's routes answer), `host_claim` (spec-scripted), `host_info`,
   `host_on_launch`, `host_write_escrow`, `host_allow_firewall`,
   `host_logs_tail`, `pending_identity_change`; `host_status` in the contract
   shape; `host_setup_start` split into rows 1–2 and 4–5 per S7.
   `setup-harness.spec.ts` follows. `accept_changed_identity` reads the
   camelCase argument.
7. **`client/playwright.config.ts`**: the real-server match swaps the retired
   `real-server-setup.spec.ts` for the two new specs.
8. **`docs/index-spec.md`**: §6.14 and §8.1 pointers.

## 5. Deviations

1. **Claim-mode rows** run account first (3, 2, 4, 5): rows 2, 4, 5 are read
   from `/admin/host-status`, which needs the owner's session, so they cannot
   honestly precede it. Row 4 is dropped when reach is `off` (§5.4). A
   storage row with at-rest off is a warn with the `encrypt-storage` command.
2. **Launch**: the draw belongs to the loading screen (see §1).
3. **"Save as file"** downloads a text file in both builds (no save dialog
   plugin in the dependencies; adding one is a `package.json` change).
4. **Host invite on a loopback-only server**: the link uses the address in use
   and says "Only this computer can reach this server right now…" rather than
   showing no link (found in the real-server run).
5. **"Restore from a backup instead"** (§1.4, §4.8) is not built: the link is
   not shown. `hostStore`/`host_restore` exist (S7); the archive picker and
   phrase entry are left.
6. Claim-mode escrow (`POST /admin/storage-key/escrow`) is not sent: the page
   cannot learn the instance id from `/admin/host-status`. The desktop host
   escrows (row 3).
7. The Settings banner for a failed host update (§2.8) is not drawn;
   `onLaunch()` runs and its result is in `hostStore.launch`.

## 6. Open

- Restore-from-backup UI; claim-mode escrow (needs `instance_id` in
  `HostStatus`/admin status, S6/orchestrator).
- The desktop debug build was not run under Xvfb against a real hosted
  server (S7 forbids installing a service here; S15 covers it).
- `npm run test:motion` (port 4173) was not run (preamble forbids default
  ports); the S13 spec's idle check covers the first run.
