# Setup fix F4: Settings › "Paracord on this computer"

Fix package F4 of the first-run setup program. The fresh-machine gate found that
no package had built spec §2.9 (`docs/design/setup-s15-checkpoint.md` §4.7). Without
it the owner could not read the server's words to a friend, see reachability
after setup, or remove the host from the UI. The page now exists. It is desktop
only and shown only when `host.json.enabled`. It is drawn in the Index settings
language (index-spec §6.7).

## What it shows and does

| Row | Source | Copy |
|---|---|---|
| Status at a glance: **Running / Starting / Stopping / Stopped / Can't start** + reason, version and port, **Start** / **Stop** | `host_info` (`service`, `storage_key_problem`, `service_error`), the rejection of a pressed Start | §2.9. A stopped server says "Nobody can reach the server until it starts again, you included." Exit 78 says "It can't open its storage key: {reason}." When `systemctl`/`schtasks`/`launchctl` can't be asked, the page says **Can't tell** with the reason. It never guesses |
| An update that didn't come up | `info.update_failure`, `info.held_version` | §2.8: "Paracord on this computer didn't start after the update." + **Restore the backup from before the update** + **Show details**. After that, the held version is named |
| "Starts when you sign in to this computer" switch | `host_set_autostart` | §2.4 / §2.9 |
| Friends outside your home | `HostStatus.reachability` | §5.4 "Elsewhere" via `reachabilityCopy`. `confirmed_at` gives "A friend connected from outside {relative}." Refused and no-answer say "Paracord checks again every minute." and offer **Show me how** (the same `RouterSheet` steps as setup, with gateway/LAN IP/port) and **Try again**. Shared address offers **What can I do?** (`SharedAddressSheet`). Firewall offers **Allow**. While the router is being asked the row shows row 4's "Asking your router to open a port." Elsewhere there is **Check the router again** |
| This server's words | `HostStatus.tls.fingerprint_sha256` → `lib/trustWords.ts` | §7.1, with **Copy** and a line on reading them to friends. Words are only shown for the certificate reported now |
| Stored messages and files | `HostStatus.storage` | §4.6 by protection label. Recovery copy of the key (§4.7): saved / "can't unlock … yet" + **Save it now** |
| Backups | `HostStatus.backups` | Last backup (relative), "Daily. Kept on this computer for 14 days.", the last error, **Back up now** (then reads the status again) |
| Invite friends | the account's own server on its home server | **Invite people** closes Settings and opens the app's invite dialog for the first text channel |
| When something's wrong | `host_logs_tail(200)` | **Show logs** in an Index dialog |
| Remove | `host_remove({ delete_data })` | A careful dialog. By default it lists what is **kept** (messages, files, accounts, 14 days of backups, the keychain key; setting it up again brings it back). "Also delete the server's data" swaps that list for what is deleted (including the backups on this computer and the storage key, and that it can't be undone, and that a copied backup is still restorable with the phrase). It needs the server's name typed. A refusal is shown inline and the dialog stays open |

When the server isn't running, the four live rows collapse to one line: "Who
can reach it, its words, its storage and its backups show here while it
runs." When it is running but `host_status` failed, that line gives the reason.

No polling while the page is closed (§2.8). The page reads `host_info` and
`host_status` when it opens and after each action. While reachability is
`asking` it reads the status once a second, for at most 15 s. A 60 s render
tick keeps relative times true and makes no network calls.

**Save it now** (escrow from Settings) uses the owner-only `POST
/admin/storage-key/escrow` on this computer's own server, not
`host_write_escrow`. That way the server itself checks that the signed-in
account, whose unlocked identity derives the key, is the one that claimed it.
`host_write_escrow` would record the owner's public key under any account's
wrapping key. It runs only when the app's home origin is this host's
`home_url` and the account is unlocked. Otherwise it says "Sign in to this
computer's server with the account that set it up, then try again." A 403
says only the account that set it up can do it. A 409 "already escrowed"
counts as done.

## Files

New (F4):
- `client/src/lib/host/settingsView.ts`: the pure state → copy/tone/actions mapping (service, reach, storage + escrow, backups, update, remove confirmation).
- `client/src/lib/host/settingsView.test.ts`: 29 unit tests of that mapping, including "never says friends can reach you without open/direct".
- `client/src/components/host/HostSettingsSection.tsx` (+ `useHostedHere()`), `RemoveHostDialog.tsx`, `hostSettings.css`.
- `client/e2e/setup-f4-host-settings.spec.ts`: 20 scenes, every state shot, every action's Tauri call asserted.

Small additive changes outside the package:
- `client/src/components/user/UserSettings.tsx`: one nav item `host` ("This computer", `HardDrive`, `hostOnly`), the `hostedHere` filter, and the mount line. The page title is the full "Paracord on this computer". The nav label is short because 240 px truncated the full name.
- `client/src/components/firstRun/Sheets.tsx`: `RouterSheet`/`SharedAddressSheet` take an optional `zIndexClassName`. Settings is a windowed overlay at `z-[150]` and these sheets opened underneath it (default `z-[60]`). The first run is unchanged.
- `client/e2e/fixtures/setup/tauriHost.ts`: a `hosting` option (a computer that already hosts: service state, autostart, storage-key problem, update failure/held version, escrowed, last backup/error, `confirmed_at`, start/remove failures). It also stubs `host_start`, `host_stop`, `host_set_autostart` and `host_remove`, and a `serviceHold` to shoot "Starting". Without `hosting` the scene behaves as before (setup-harness + setup-s13: 55 passed).

No Rust, no new Tauri command, no contract change. It uses only the existing
`hostStore` actions and host commands. F1/F2/F3 regions are untouched. If F2
adds a router-address field to the status, `RouterSheet` keeps reading
`reachability.gateway_ip`, which already exists.

## Gates

| Gate | Result |
|---|---|
| `npm run typecheck` | clean |
| `npx vitest run src/lib/host` | 29 + existing pass |
| `npm run test:unit` | 4893 passed, 1 failed: `CallSheet.test.tsx › a short drag springs back` (timing under full-suite load; passes alone, 6/6; untouched) |
| `eslint` on touched files | 0 errors. New files have 0 warnings. The 6 warnings in `UserSettings.tsx` are pre-existing |
| `test:tokens`, `test:motion-lint`, `test:a11y:static`, `test:contrast` | all pass (no new tokens: tones reuse `--fr-ok`, `--fr-warn`, `--ix-danger-ink`) |
| `setup-f4-host-settings` (setup-review config, ports 5043/5045) | 20 passed |
| `setup-harness` + `setup-s13` with the extended stub | 55 passed |

Cargo gates are not applicable (no Rust touched), so `host:stage` was not needed.

## Screenshots (read)

`output/design-reference/setup-build/f4/`:
`running-open(-full)`, `reach-refused(-sheet)`, `reach-no_answer(-sheet)`,
`reach-shared(-sheet)`, `reach-firewall`, `reach-direct`, `stopped(-full)`,
`starting`, `cant-start`, `cant-start-key`, `cant-tell`, `update-failed`,
`update-held`, `escrow-missing-backup-failed(-full)`, `backed-up`, `logs`,
`invite`, `remove-keep`, `remove-delete`, `remove-failed`, `removed`.

The scene is the Index scene with the desktop Tauri stub. Its gateway runs
through the shell, which the scene does not provide, so toasts like "Failed to
load messages" sometimes appear in shots. That comes from the scene, not the page.

## Deviations and open issues

1. **Nav label** is "This computer", not the full page title (truncation at 240 px).
2. **Port in use (§2.10)**: there is no structured reason from `hostctl`. The page shows whatever the failed Start says. A specific "Port {port} is in use by another program." needs F1/S7 to emit it.
3. **After Remove**, the page shows "This computer isn't running a Paracord server." and the nav row goes away. The app's home server is still `127.0.0.1:<port>`, so the shell shows it as unavailable. Signing out, or offering to set it up again, is not done here; that is an owner decision.
4. **ProtectedSheet from Settings › Privacy** opens at the default `z-[60]`, the same stacking bug fixed here for the router sheets (S12's file; not changed).
5. **No `INSTANCE_STATUS_UPDATE` consumer** exists on the client. The page reads `host_status` itself while open, which spec §2.8 allows.
6. The "Allow" (firewall) path and **Save it now** with a real unlocked owner are covered by stubs and logic only. They were not run against a real Windows host or a real escrow-less server.
