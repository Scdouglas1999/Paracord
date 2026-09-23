# How encryption works in Paracord

This page explains what Paracord encrypts, how, and what it does not protect. The first
section is for everyone. The rest goes into detail and names the source files, so you can
check each claim yourself.

## The short version

**Direct messages and group DMs are encrypted end to end.** That covers the text you type
and the files you attach. Your device encrypts them before they leave, and only the people
in the conversation can decrypt them. The server stores and passes along data it cannot
read.

**Messages in a server's channels are not encrypted end to end.** Whoever runs the
instance can read them, and so can anyone with access to its database, backups or disk.
The same goes for files posted in channels.

**The server still sees a lot around your messages.** It knows who talks to whom, when,
how big each message and file is, who is in each group, and when you are online. It sees
your IP address. Encryption hides what you say, not the fact that you said something.

**This is Paracord's own code, and nobody outside the project has audited it.** It follows
the design of the Signal protocol, but it is not Signal's library. Keep that in mind when
you decide what to say in it.

## Direct messages

One-to-one DMs use the two parts of the Signal design: X3DH to start a conversation, and
the Double Ratchet for every message after that.

### Starting a conversation (X3DH)

- Each account has an **identity key**, an Ed25519 key pair. The public half is stored
  on the server as the account's `public_key`. The same key signs the login challenge
  when you sign in with your key.
- Each account publishes a **prekey bundle** to the server (`PUT /api/v1/users/@me/keys`):
  one signed prekey (X25519, signed with the identity key), a batch of 50 one-time prekeys,
  and one "last-resort" prekey that is used when the one-time prekeys run out. The client
  adds more one-time prekeys when fewer than 20 are left. It replaces the signed prekey
  every 7 days.
- To write to someone for the first time, your client fetches their bundle
  (`GET /api/v1/users/{id}/keys`). The server hands out one one-time prekey and deletes it.
  Your client checks the signed prekey's signature. It also checks that the identity key
  matches the one it has pinned for that person (see [Verifying a contact](#verifying-a-contact)).
- Your client then does three or four X25519 exchanges between your identity key, a fresh
  ephemeral key, and their prekeys. It runs the result through HKDF-SHA-256 to get the
  starting secret. The Ed25519 identity keys are converted to X25519 form for this.
- Source: `client/src/lib/crypto/x3dh.ts`, `client/src/lib/crypto/hkdf.ts`,
  `client/src/lib/dmCipher.ts`, `crates/paracord-api/src/routes/keys.rs`.

### Every message after that (Double Ratchet)

- Each message gets its own key. Message keys come from a chain key (HMAC-SHA-256), and the
  chain is reset with a new X25519 exchange each time the conversation changes direction
  (HKDF-SHA-256).
- The body is encrypted with AES-256-GCM. The ratchet header (the sender's current ratchet
  public key and two counters) is authenticated as additional data.
- Messages that arrive out of order are handled. The client keeps up to 256 skipped keys
  per gap and at most 1,024 in total.
- Source: `client/src/lib/crypto/doubleRatchet.ts`, `client/src/lib/crypto/signalSessions.ts`.

### What that gives you

- **Forward secrecy for messages in transit.** Message keys are used once and not kept.
  Someone who later steals the keys a conversation is using now cannot use them to decrypt
  earlier ciphertext they recorded.
- **Recovery after a compromise.** Every change of direction mixes in a fresh X25519
  exchange. Someone who stole a device's ratchet state loses access once both sides have
  sent a new message, unless they are still inside the device.

Limits to keep in mind:

- Your device keeps a copy of your decrypted messages in its encrypted local store, so
  that it can show your history. Anyone who can unlock your device's store can read that
  history. Forward secrecy does not help there.
- Older signed prekeys stay on the device, so a first message that arrives late can still
  be opened. Earlier ratchet sessions for a conversation are kept for the same reason.
- The server refuses plaintext DMs. A client that tries to send one gets an error.

## Group DMs

Group DMs use sender keys, the approach Signal uses for groups.

- Each member creates a random 32-byte AES-256-GCM key for the group: their **sender key**.
  Each message they send to the group is encrypted with it.
- The sender key reaches each other member in a separate **envelope**. The envelope is
  encrypted with AES-256-GCM, under a key made from an X25519 exchange between the two
  members' identity keys. The server stores the envelopes and delivers them.
- **Every group message is signed** with the sender's Ed25519 identity key. The signature
  covers the channel, the header and the ciphertext. It is checked against the key pinned
  for that sender. Without it, any member could post a message that looked like it came
  from someone else, because every member holds every sender key.
- The header (sender, epoch and membership fingerprint) is also the AES-GCM additional
  data. A header with any other fields is refused.

### When keys change

The client makes a new sender key (a new "epoch") whenever the **membership fingerprint**
changes. The fingerprint is a SHA-256 hash of the channel ID plus every member's user ID and
identity key. So a new key is made when:

- someone joins the group,
- someone leaves or is removed, or
- any member's identity key changes.

When it publishes an envelope, the client names the membership it made the key for. The
server rejects the publish if the group's membership has changed since. A member who
receives a key made for a group that includes someone they can no longer see refuses it.

### Limits

- There is no ratchet inside an epoch. One key covers every message a member sends until
  the membership changes.
- Envelopes are encrypted with the two members' long-term identity keys, and the server
  keeps them after they are delivered. If your identity private key is ever stolen, whoever
  has it plus the server's stored data can open every group message you were able to read.
- The server decides who is in a group. It can add an account, and that account will get
  keys for messages sent after it joins. It cannot read earlier messages or forge a message
  from an existing member.
- Source: `client/src/lib/crypto/groupSenderKeys.ts`,
  `crates/paracord-api/src/routes/message_features.rs`, `crates/paracord-db/src/group_e2ee.rs`.

## Attachments

In DMs and group DMs:

- Each file is encrypted on your device with its own random AES-256-GCM key and nonce.
- The server receives only the ciphertext. It is stored under a random name
  (`<32 hex characters>.bin`) as `application/octet-stream`. The server refuses to keep a
  real filename or type for these uploads, and makes no preview or thumbnail.
- The file's key, its real name, type, size, a SHA-256 hash of its contents, and an
  optional small encrypted thumbnail go **inside** the encrypted message. The recipient
  checks the size and hash after decrypting, and refuses a file that does not match.
- What the server still learns: that a message has attachments, how many, and each file's
  size (the original size plus 16 bytes).
- One encrypted message can hold at most about 12 KB, including up to 10 attachment
  descriptions. Large thumbnails are dropped first to make room.
- Source: `client/src/lib/messages/attachments/attachmentCrypto.ts`,
  `client/src/lib/messages/attachments/attachmentEnvelope.ts`,
  `crates/paracord-api/src/routes/files.rs`.

## Algorithms and libraries

The client uses three `@noble` packages (versions from `client/package-lock.json`) plus the
browser's built-in Web Crypto:

| What | Used for | Comes from |
|---|---|---|
| X25519 | X3DH, ratchet steps, group envelopes, voice call keys | `@noble/curves` 2.0.1 |
| Ed25519 | identity keys, signed prekeys, group message signatures | `@noble/curves` 2.0.1 |
| Ed25519 | creating the account key, signing the login challenge | `@noble/ed25519` 3.0.0 |
| SHA-256, HMAC-SHA-256, HKDF-SHA-256 | key derivation, fingerprints, transcripts | `@noble/hashes` 2.0.1 |
| scrypt | turning your encryption password into a key | `@noble/hashes` 2.0.1 |
| AES-256-GCM | messages, envelopes, attachments, local storage | Web Crypto (`crypto.subtle`) |
| HKDF-SHA-256 | deriving the local storage key | Web Crypto |
| AES-128-GCM | voice and video frames | Web Crypto in the browser; the Rust `aes-gcm` crate in the desktop app |

Paracord does not use `@noble/ciphers`. All AES-GCM in the client goes through Web Crypto.

## How keys are kept on your device

There are three layers.

1. **Your identity key, protected by your encryption password.** During setup
   (**Secure your account**, or **Set up a local identity**), the app creates your identity
   key and asks for a
   **New encryption password** (at least 10 characters; it can be different from your
   sign-in password). The key is encrypted with AES-256-GCM, using a key made from your
   password with scrypt (N = 2^17, r = 8, p = 1). The encrypted key is saved in the app's
   local storage. When you open the app you type this password on the **Welcome back**
   screen to unlock it. Source: `client/src/lib/account.ts`,
   `client/src/lib/crypto/identityKeystore.ts`.
2. **Everything else in an encrypted local vault.** Prekeys, ratchet sessions, group
   sender keys, pinned contact keys, drafts, queued messages and your decrypted history live
   in an IndexedDB database. Each record is encrypted with AES-256-GCM, under a key made
   from your identity private key with HKDF-SHA-256. The vault can only be opened while
   your identity is unlocked. Source: `client/src/lib/crypto/accountVault.ts`.
3. **Drafts before you set up encryption** go into a separate store, under a random key
   that the app cannot export. This keeps them from sitting in plain text on disk. It does
   not protect them from other code running as you. Source:
   `client/src/lib/crypto/deviceAccountVault.ts`.

In the desktop app, the operating system's keychain (Windows Credential Manager, macOS
Keychain, or Secret Service on Linux) holds your sign-in tokens. It does not hold the
encryption keys above, apart from keys saved by older versions, which the app reads once
and moves into the vault.

### Recovery phrase and new devices

- After setup the app shows a **Recovery phrase** of 24 words. The phrase is your identity
  private key itself, written as words, with a checksum. Anyone who has it can take over
  your account.
- On a new device, **Recover your account** asks for the phrase and a new password. That
  brings back your identity, so your contacts still see the same key.
- It does **not** bring back your messages or session keys. Encrypted conversations from
  before show as "Encrypted message" on the new device.
- The new device then publishes fresh prekeys under the same identity. You approve this
  with **Publish new keys for this device**. Any other device signed in to the same account
  stops getting new encrypted conversations until it is set up again. In practice, one
  device per account handles encrypted messages at a time.

## What the server can and cannot see

The server **cannot** see:

- the text of DMs and group DMs,
- the contents, real names or real types of files attached to them,
- your identity private key, prekey private keys, session keys or sender keys.

The server **can** see:

- who sent each message, in which conversation, and when,
- the size of each encrypted message and file (nothing is padded),
- that a message has attachments, and how many,
- the members of every DM and group DM, and when they change,
- everyone's public identity key and public prekeys, and who fetched whose prekeys (which
  shows who is starting a new conversation with whom),
- the unencrypted parts of each message header: ratchet public keys and counters in DMs,
  plus the sender's identity key and chosen prekeys on the first message; in groups, the
  sender, epoch, membership fingerprint and signature,
- that a message was edited or deleted,
- reactions in DMs, which are stored in plain form,
- typing indicators, online status and read activity,
- your IP address and browser or app details, which it records for each sign-in session,
- for voice and video, who is in each call, for how long, and the size and timing of media
  packets.

## Server channels are not end-to-end encrypted

Messages and files in a server's channels are sent to the instance as normal data. The
instance stores the text as it is. It may encrypt uploaded files on disk, but it holds that
key itself. Anyone who runs the instance, or can reach its database or backups, can read
channel messages. Use a DM or group DM for anything you want to keep from the people who run
the instance.

## Voice and video

- Voice and video frames are encrypted with AES-128-GCM before they leave your device. The
  relay that forwards them has no key.
- Each person in a call makes a sender key and sends it to the others, wrapped with
  AES-GCM under an X25519 key made for that one call. Senders make a new key when someone
  joins or leaves.
- Those per-call keys are **not** tied to your identity key, and there is no way to verify
  them. The server passes them between participants, so the call's privacy depends on the
  server passing along the right keys. This protects against a relay that only records
  traffic. It does not protect against an operator who changes the server to swap keys.
- The server setting `[voice] e2ee_required` (on by default) is only reported by the
  connection check. The client always encrypts media whatever it is set to, and has no
  unencrypted path.
- Source: `client/src/lib/media/mediaKeyring.ts`, `client/src/lib/media/senderKeys.ts`,
  `crates/paracord-codec/src/crypto.rs`, `crates/paracord-relay/src/e2ee.rs`.

## Our own implementation, and not audited

- Paracord follows the design of the Signal protocol, but **it does not use libsignal**,
  the library Signal ships. libsignal is licensed under the AGPL, which does not fit
  Paracord's source-available license. Paracord's version is written from scratch in
  TypeScript on the `@noble` libraries.
- It is not identical to Signal. For example, the X3DH identity keys are not included in
  the message's additional data, group chats have no ratchet inside an epoch, and old
  signed prekeys are kept.
- **No independent security firm has audited it.** The project has reviewed its own code
  (see `docs/security-audit-2026-09-19.md`), and it has tests. An outside audit is a
  different thing, and there has not been one.

What that means in practice: it should keep your DMs away from a server operator who is
curious, from someone who copies the database, and from a backup that leaks. Do not rely on
it where a mistake could put someone in danger, or against an attacker with serious
resources. For that, use a tool whose encryption has been studied and audited for years.

## Verifying a contact

The first time your app sees a contact's identity key, it saves ("pins") it. From then on,
if the server shows a different key for that person, your app refuses to encrypt to them
or decrypt from them until you accept the new key. This only helps if the first key was the
right one. A dishonest server could hand you its own key the first time. Checking the key
with your contact closes that gap.

How to check:

1. Your contact opens **Settings → Identity**. Under **Current identity key** they see
   their **Fingerprint**, 64 characters in groups of four.
2. You open your contact's profile. Under **Identity verification** you see the fingerprint
   your app has for them and a status: **Not verified**, **Verified**, or **Unknown until
   you unlock encryption**.
3. Compare the two fingerprints in person, or over a channel you already trust (a phone
   call, for example). Every character must match.
4. If they match, click **Mark verified**. The status changes to **Verified**.

If a contact's key changes, their profile shows "Identity key changed" with the previous
fingerprint, and sending to them is blocked. Check the new fingerprint with them the same
way, then click **Mark verified** to accept it.

The **Verify** button on the profile opens **Cross-device identity verification**, with a
QR code and a text payload of the fingerprint your device holds. It is for comparing that
fingerprint between two of **your own** devices: copy the payload on one device and paste
it into **Verify from scanned payload** on the other, then click **Verify payload**. The app
cannot scan QR codes itself. Both of your devices get the key from the same server, so this
is not a replacement for checking with the contact.

The fingerprint is your contact's public identity key. It is not a combined "safety
number" for the two of you like Signal's. You check each person's key on its own.
