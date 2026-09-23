# Security policy

## Reporting a vulnerability

Please report security problems privately, not in a public issue.

Use GitHub's private vulnerability reporting: open the **Security** tab of this repository
and choose **Report a vulnerability**. Only the maintainer can see what you send there.

A useful report says:

- what the problem is and what someone could do with it,
- the Paracord version (the server prints it when it starts) and whether you used the
  browser or the desktop app,
- the steps to reproduce it, or a proof of concept,
- anything you already know about a fix.

Please give us a reasonable chance to fix it before you publish anything.

## What is in scope

- The Paracord server (`paracord-server` and the crates under `crates/`), including its API,
  realtime connection, voice and video relay, federation and setup flow.
- The web client and the desktop app (`client/`).
- The end-to-end encryption of direct messages, group DMs and calls
  ([how it works](docs/encryption.md)).
- The installers (`scripts/install.sh`, `scripts/install.ps1`), the Docker image, and the
  release packages published on GitHub.

Out of scope:

- Messages in a server's channels being readable by the people who run that server. That is
  how Paracord works today, and it is documented.
- Problems that need the attacker to already control the server, the machine it runs on, or
  the victim's unlocked device.
- A server that its owner has configured insecurely on purpose (for example, open
  registration or a disabled setup claim).
- Denial of service by sheer volume of traffic.
- Bugs in third-party software that Paracord only depends on. Please report those upstream,
  though we would like to hear if Paracord uses something in a way that makes it exploitable.

## Supported versions

Security fixes go into the **latest release** only. If you run an older version, the fix is
to update: on a server, run the install command again, which keeps your data.

## What happens after you report

1. We confirm we have your report, normally within a few days.
2. We check it, and tell you whether we can reproduce it and how serious we think it is.
3. We fix it in a new release and publish a GitHub security advisory. We credit you in the
   advisory unless you ask us not to.

Paracord is a small project, so a fix can take time. We will keep you informed about where
it stands.
