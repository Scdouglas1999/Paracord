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
instance can read them. The same goes for files posted in channels. A server made with
the installer or the desktop app also encrypts everything it stores on its own disk, so a
copied backup or a lifted disk is not enough to read it; see
[Stored data on the server](#stored-data-on-the-server) for what that covers and what it
doesn't.

**One password signs you in and unlocks your encryption.** The server never receives it,
and never receives anything that would let it decrypt your identity key. See
[One password](#one-password).

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

## Forwarded messages

- When you forward a message from one DM or group DM into another, the quoted text and
  where it came from (the conversation, the message, who wrote it and when) go inside the
  new encrypted message. The server stores none of it. The "Forwarded from" line is written
  by your device and nobody else checks it, the same as the text you forward.
- A forward into or out of a server channel goes through the server. It checks that you can
  read the original and records where it came from. Forwarding out of a DM into a server
  channel asks you first, because it posts the text unencrypted.
- Paracord 3.2 put the source of a DM-to-DM forward in a field the server could read. The
  server now drops that field instead of storing it, so those forwards arrive without their
  "Forwarded from" line.
- Source: `client/src/lib/forwardedMessage.ts`,
  `client/src/lib/messages/attachments/attachmentEnvelope.ts`,
  `crates/paracord-api/src/routes/channels/forwards.rs`.

## Algorithms and libraries

The client uses three `@noble` packages (versions from `client/package-lock.json`) plus the
browser's built-in Web Crypto:

| What | Used for | Comes from |
|---|---|---|
| X25519 | X3DH, ratchet steps, group envelopes, voice call keys | `@noble/curves` 2.0.1 |
| Ed25519 | identity keys, signed prekeys, group message signatures | `@noble/curves` 2.0.1 |
| Ed25519 | creating the account key, signing the login challenge | `@noble/ed25519` 3.0.0 |
| SHA-256, HMAC-SHA-256, HKDF-SHA-256 | key derivation, fingerprints, transcripts | `@noble/hashes` 2.0.1 |
| scrypt | turning your password into the auth key and the wrap key | `@noble/hashes` 2.0.1 |
| AES-256-GCM | messages, envelopes, attachments, local storage | Web Crypto (`crypto.subtle`) |
| HKDF-SHA-256 | deriving the local storage key | Web Crypto |
| AES-128-GCM | voice and video frames | Web Crypto in the browser; the Rust `aes-gcm` crate in the desktop app |
| Argon2id | the server's stored hash of your auth key | the Rust `argon2` crate |
| SQLCipher, AES-256-GCM | the server's database and files on its own disk (the [server section](#stored-data-on-the-server)) | SQLCipher with a statically built OpenSSL; the Rust `aes-gcm` crate |

Paracord does not use `@noble/ciphers`. All AES-GCM in the client goes through Web Crypto.

## One password

You type one password. Your device turns it into two independent keys. One goes to the
server to prove it is you, and the other never leaves your device.

```
pw       = UTF-8(NFKC(password))
salt     = 32 random bytes, stored on the server (public)
master   = scrypt(pw, SHA-256("paracord/credential/v2/salt" || salt), N = 2^17, r = 8, p = 1)
auth_key = HKDF-SHA-256(master, info = "paracord/credential/v2/auth")   sent to the server
wrap_key = HKDF-SHA-256(master, info = "paracord/credential/v2/wrap")   never sent
```

- The **auth key** is what you sign in with. The server stores only an Argon2id hash of it.
- The **wrap key** encrypts your identity private key with AES-256-GCM. The encrypted
  identity is stored on the server as a backup and on your device. This is what lets a new
  device sign in with your username and password and get the same identity back.
- The server cannot compute the wrap key from the auth key: they are separate outputs of
  the key derivation, and neither one reveals the other.
- Your device refuses weaker key-derivation settings than the ones above. A server that
  starts asking for weaker ones for an account that already uses one password is refused,
  and nothing is sent to it.
- Source: `client/src/lib/credential/` (`derive.ts`, `wrap.ts`, `kdf.worker.ts`),
  `crates/paracord-core/src/credential.rs`, `crates/paracord-api/src/routes/credential.rs`.

### Changing the password

A new password re-wraps the same identity. Your contacts still see the same key and your
sessions on other devices end. Other devices notice the change (the credential has a
counter) the next time they unlock and ask for the new password.

### What the server learns

| The server stores or sees | It cannot |
|---|---|
| Username, display name, email if you gave one | Read your password |
| The salt and the key-derivation settings (public) | Compute the wrap key |
| The auth key, every time you sign in, kept as an Argon2id hash | Decrypt your identity private key |
| Your identity **public** key and prekeys | Read your recovery phrase |
| Your identity private key **encrypted** under the wrap key | |
| When and from where you sign in | |

**A server operator can try to guess your password offline.** Whoever has the server's
database holds the auth key hash and the encrypted identity. Each guess costs one scrypt
run (128 MiB of memory) and one Argon2id run, which makes guessing slow, not impossible. So
the end-to-end encryption of your DMs is as strong as your password, against someone who runs
or copies the server. Paracord requires at least 10 characters, rejects the most common
passwords, and suggests a passphrase of several words. This is true of any identity backup
that a password unlocks. A long, unusual passphrase is the real defense.

**A server you have never signed in to can lie about how you sign in.** On a brand-new
device, a dishonest server could claim your account still uses the older two-password
sign-in and show that screen. Typing your password there gives it away. The older screen
says so in its wording, and appears only for accounts that really have not moved yet.

### Where your device keeps things

1. **Your identity key, wrapped by the password.** The same encrypted copy the server
   holds is saved in the app's local storage. Unlocking decrypts it on your device, with no
   network needed. Source: `client/src/lib/crypto/identityKeystore.ts`.
2. **Everything else in an encrypted local vault.** Prekeys, ratchet sessions, group
   sender keys, pinned contact keys, drafts, queued messages and your decrypted history live
   in an IndexedDB database. Each record is encrypted with AES-256-GCM, under a key made
   from your identity private key with HKDF-SHA-256. The vault can only be opened while
   your identity is unlocked. Source: `client/src/lib/crypto/accountVault.ts`.
3. **Drafts before you set up your account** go into a separate store, under a random key
   that the app cannot export. This keeps them from sitting in plain text on disk. It does
   not protect them from other code running as you. Source:
   `client/src/lib/crypto/deviceAccountVault.ts`.

In the desktop app, after you unlock, the operating system's keychain (Windows Credential
Manager, macOS Keychain, or Secret Service on Linux) also holds your identity key, so a
relaunch opens without asking. **Settings, Privacy, "Ask for my password when Paracord
opens"** turns that off and deletes the keychain copy. If the keychain is not available the
app does not remember you and asks for the password. A browser never remembers the key; a new tab
asks for the password.

### Recovery phrase and new devices

- After sign-up the app shows a **recovery phrase** of 24 words. The phrase is your identity
  private key itself, written as words, with a checksum. Anyone who has it can take over
  your account, and it works even if you forget the password.
- **Forgot your password?** Choose **Use your recovery phrase**. The phrase signs you in with
  your key, and you pick a new password. Your identity, your contacts' view of you and your
  stored keys carry on.
- **Start over** (a reset link by email, on servers that send email) cannot bring the old
  identity back, because the server cannot decrypt it. It makes a new identity. Your old
  private messages cannot be opened with it.
- The phrase does **not** bring back your messages or session keys. Encrypted conversations
  from before show as "Encrypted message" on the new device.
- A new device then publishes fresh prekeys under the same identity. You approve this
  with **Publish new keys for this device**. Any other device signed in to the same account
  stops getting new encrypted messages until it is set up again. In practice, one
  device per account handles encrypted messages at a time.
- Your contacts' next message reaches the new device without it having to write first.
  The server names each published bundle with a **prekey generation**, a server ID that
  changes only when a device replaces the whole bundle. It is in the bundle a sender
  fetches and in the DM list (`recipient.prekey_generation`), and publishing keys tells the
  account's contacts to reload that list. A sender remembers which generation each of its
  ratchets was started against (the bundle it fetched, or the server ID of the first
  message the other side sent). If a ratchet is older than the contact's current
  generation, the sender stops sending on it and starts a new session (X3DH) with the
  current bundle. The old ratchet stays for reading late messages. Source:
  `client/src/lib/crypto/signalSessions.ts`, `crates/paracord-db/src/prekeys.rs`.
- On a server you set up on your own computer, the same phrase also restores the server's
  stored-data key; see [Recovering the storage key](#recovering-the-storage-key).

## What the server can and cannot see

(For a DM or group DM. The server can read channel messages; see
[Server channels are not end-to-end encrypted](#server-channels-are-not-end-to-end-encrypted).)

The server **cannot** see:

- the text of DMs and group DMs,
- the contents, real names or real types of files attached to them,
- your password, your identity private key, prekey private keys, session keys or sender keys.

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
- for voice and video, who is in each call, for how long, who is watching a screen share
  without being in the call, and the size and timing of media packets.

## Server channels are not end-to-end encrypted

Messages and files in a server's channels are sent to the instance as normal data, and the
instance can read them. It encrypts them again on its own disk (see the next section), but
it holds that key itself. Anyone who runs the instance can read channel messages. Use a DM
or group DM for anything you want to keep from the people who run the instance.

## Stored data on the server

A server made with the installer, or by the desktop app on someone's computer, encrypts
what it writes to disk: the database (SQLite, with SQLCipher) and every uploaded or cached
file (AES-256-GCM). This is separate from end-to-end encryption. The server holds the key
and uses it all the time, so it protects against someone who gets the **disk or a copy of a
backup**, not against someone who controls the running server.

It does not cover PostgreSQL databases (you can still encrypt the files), and it is off in
Docker unless you turn it on ([Docker setup](docker-setup.md#encrypting-stored-data)).

### Where the key is kept

The server makes a random 256-bit key on its first run and stores it in one place. The
place depends on how the server was installed, and the admin screen says how well the key is
protected:

| Key kept in | Used by | What the admin screen says |
|---|---|---|
| The system keychain of the account the server runs as | The desktop app's "Paracord on this computer"; a macOS install for one user | Encrypted on this computer's disk. The key lives in your system keychain. |
| A systemd credential, sealed to the computer's TPM when it has one | `install.sh` as root on systemd 250 or newer | Encrypted on disk. The key is sealed to this machine's security chip. (Without a TPM: the key is protected by this machine's own credentials.) |
| A key file, readable only by the server's account, next to the config | `install.sh` for one user, a macOS system install, `install.ps1`, a plain first run without a keychain | Encrypted on disk, with the key stored on the same disk. This protects backups copied elsewhere, not a stolen disk. |
| An environment variable | Docker, and configs that used it before | Same as the key file |
| nothing | Docker by default; a server installed before this existed | Not encrypted |

The "same disk" rows deserve plain words: if someone takes the whole disk, they take
the key file with it. The encryption still helps against a backup or a copy of the data
folder that leaves without the key file, which is the common way data leaks.

If the key cannot be read at start (the keychain is locked, a file is missing, a wrong key),
the server stops and says which one. It never starts unencrypted on its own.

### What it does not do

- It does not hide anything from the server while it runs; the server decrypts to serve you.
- A deleted unencrypted file may still be recoverable. When a server is converted, the
  unencrypted database is deleted after the encrypted one is checked, but a solid-state
  disk can keep the old blocks for a while. If that matters, also wipe the free space or
  use full-disk encryption.
- A conversion keeps a backup taken just before it, and that backup is **not** encrypted.
  The command says where it is. Delete it once a new backup exists.
- TOTP and webhook secrets stored before the conversion were stored in readable form; they
  now sit inside the encrypted database.

### Encrypting an existing server

Servers installed before this existed keep storing unencrypted until you convert them. The
installer asks on an upgrade (`install.sh --encrypt-storage`, `install.ps1 -EncryptStorage`
skip the question). To do it by hand:

```bash
# stop Paracord first; the command refuses while the server answers on its port
paracord-server -c /opt/paracord/config/paracord.toml encrypt-storage --key-source file
# --key-source keychain | systemd-creds | file | env;  --key-file <path> for file and systemd-creds
```

It takes a backup, makes the key and stores it, copies the database into an encrypted one
and compares every table's row count, encrypts the files in place, and only then updates
the config and deletes the old database. If it is interrupted, run it again; it resumes. It
prints the next step: saving a recovery copy of the key.

### Recovering the storage key

The key lives on the computer. If that computer's keychain, key file or disk is lost, an
encrypted backup cannot be opened. So the server's owner can save a **recovery copy**: the
key, wrapped with a value derived from the owner's identity key and stored in the server's
`storage-key.escrow` file and inside every backup made afterward. The recovery phrase is the
identity key, so the phrase alone can unwrap it:

```
escrow_key = HKDF-SHA-256(owner identity private key,
                          salt = "paracord/host-storage-escrow/v1", info = instance id)
```

- The desktop app saves it automatically while it sets up a server on your computer.
- A server installed with the installer saves it when its first owner is created: the
  page the installer opens (`/setup-server`) makes the owner-only call
  (`POST /api/v1/admin/storage-key/escrow`, accepted once) right after it shows the
  recovery phrase, with the server's instance id from `GET /api/v1/admin/host-status`.
  The setup screen says so on its "Encrypting everything it stores" row; if it could not
  (a server encrypted by hand without `[host] instance_id`, for example), the row says why,
  and you should keep your own copy of the key somewhere that is not that disk.
- To restore on another computer, the desktop app's **Restore from a backup instead** asks
  for the recovery phrase and does the rest, and saves a new recovery copy for the restored
  server. By hand, `paracord-server escrow-key --archive <file>` reads the phrase from
  standard input and prints `escrow_key` (base64url, one line), and
  `paracord-server restore-backup --archive <file> --output-dir <dir> --escrow-key-stdin`
  reads that from standard input, unwraps the storage key from the archive and stores it
  where the config says before restoring; pipe one into the other. See
  [Backup and offline recovery](backup-recovery.md#restoring-an-encrypted-server-without-its-key).
- A backup made before a recovery copy exists carries none. Only the server's own key can
  open it.

Nothing about this gives anyone else access: the wrapping key is not stored on the server,
and the file cannot be read without the owner's identity key.

## Voice and video

- Voice and video frames are encrypted with AES-128-GCM before they leave your device. The
  relay that forwards them has no key.
- The server setting `[voice] e2ee_required` (on by default) is only reported by the
  connection check. The client always encrypts media whatever it is set to, and has no
  unencrypted path.

### Members and viewers

Two kinds of connection can receive media from a call:

- A **member** is in the call: they joined, or they are listening in. A member hears the
  voices.
- A **viewer** is watching one person's screen share without being in the call. A *watch*
  (you pressed Watch) receives that stream's video and its own audio. An *ambient view* (the
  app opens one by itself, for example to light the room from the busiest stream in the
  server) receives video only, at a low, capped rate. A viewer never receives the voices or
  anyone's camera.

In a DM or group DM call, only the DM's recipients can be members or viewers (and a DM call
has no ambient view); the rules below apply to it unchanged.

The relay marks every entry in a call's roster `member` or `viewer`. It sets the marker
from how the connection was admitted, so no client has to guess from voice states. A
client reading a marker it does not know refuses the entry instead of treating it as a
member, because a member is owed the voice key. (The browser drops that one entry. The
desktop app refuses the whole control message, which is safe but blunt.) A relay that
sends no marker is an older one with no viewers, so every entry reads as a member.

### One key per track

Each person in a call makes a separate random sender key for their voice and for each
video or stream-audio track they publish: camera, screen video and screen audio. A key
opens one track and nothing else, so handing someone the screen share's key does not hand
them the voice.

The sender wraps each key once per person entitled to it, with AES-GCM under an X25519 key
made for that one call, and the server passes the wrapped keys along:

| Key | Sent to |
|---|---|
| Voice | Members only |
| Screen video and screen audio | Members, and viewers of that screen share |
| Camera | Members only. Never a viewer |

The sender applies this when it chooses who to wrap for. The relay applies it again when it
delivers: a viewer is never handed any key or track outside the one stream it is watching
(`ViewTarget::allows`), so a sender that got it wrong would still not reach a viewer.

### When keys change

A sender makes new keys when the people who can open them change. Whoever leaves stops
being sent new keys, so every key they could open is replaced. A member could open all
three kinds, and a viewer only the screen share's.

| What changes in the call | Voice | Camera | Screen video and audio |
|---|---|---|---|
| A member arrives | new key | new key | new keys |
| A member leaves | new key | new key | new keys |
| A member leaves the call but keeps watching (now a viewer) | new key | new key | new keys |
| A viewer leaves | kept | kept | new keys |
| A viewer arrives, or the same account's newer view replaces its old one | kept | kept | kept. The viewer is sent the current keys |

Each track counts its key periods (its epoch) by itself, so a screen share can move to a new
key without the voice moving.

### Closing a connection, and why

When the relay ends a connection it says why, with a code and words that clients match. A
client never reconnects by itself after any of these.

| Reason | Code | Words | When |
|---|---|---|---|
| Superseded | 4001 | `superseded by a newer media connection` | A newer connection from the same account took its place: a second device's view, or a reconnect that won the race |
| Ended | 4002 | `view session ended` | The view was stopped, went unused past its deadline, or was carried over into joining the call |
| Revoked | 4003 | `media access revoked` | The account was removed or banned, or may no longer view that channel |

The server re-checks every active view about every 5 seconds against the account's
current permissions. A view whose account has lost View Channel, or lost Connect for a
watch, or whose channel is gone, is ended as revoked. So the picture stops within one
sweep of the change (0.2 to 5.1 seconds in our live runs). A database error leaves the
view for the next sweep rather than ending views on a passing fault.

### Limits

- Those per-call keys are **not** tied to your identity key, and there is no way to verify
  them. The server passes them between participants, so the call's privacy depends on the
  server passing along the right keys. This protects against a relay that only records
  traffic. It does not protect against an operator who changes the server to swap keys.
- A viewer arriving does not start new screen share keys, unlike a member arriving. The
  viewer is given the keys the stream uses now, and the stream does not freeze for everyone
  watching each time someone starts or stops an ambient view. The cost: an operator who had
  recorded the stream's earlier packets could hand them to a new viewer, who could open those
  from the current key period. A member arriving does not have this problem, because it
  starts new keys.
- The roster marker does not say whether a view is a watch or an ambient view, so the sender
  also wraps the screen audio key for ambient viewers. The relay does not deliver it to them
  and sends them no audio.
- Only views are re-checked while they run. A member who loses access to a call's channel
  stays in the call until they leave or are removed.
- When a viewer leaves, everyone watching that screen share sees a short stall while the new
  screen key reaches them (in our live runs, the longest gap in the picture was 0.1 to 0.7
  seconds).
- Source: `client/src/lib/media/mediaKeyring.ts`, `client/src/lib/media/senderKeys.ts`,
  `client/src/lib/media/engineShared.ts` (`keyRecipients`, `isViewableStream`),
  `client/src/lib/media/browserMediaEngine.ts`, `client/src/lib/media/tauriMediaEngine.ts`,
  `client/src-tauri/src/native_media/events.rs` (what each roster change rotates),
  `crates/paracord-codec/src/crypto.rs`, `crates/paracord-relay/src/e2ee.rs`,
  `crates/paracord-relay/src/participant.rs` (`ViewTarget`),
  `crates/paracord-relay/src/relay.rs` (`roster_kind`),
  `crates/paracord-transport/src/control.rs` (`SessionParticipantKind`, `MediaCloseReason`),
  `crates/paracord-api/src/routes/voice.rs` (`revoke_views_without_access`).

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
