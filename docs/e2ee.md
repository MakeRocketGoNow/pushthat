# End-to-end encryption

A push's content (its URL, its title, a file's name and bytes) is readable only on the account's own devices. Firestore, Cloud Storage, Cloud Functions, Google and we hold ciphertext and the metadata needed to count, deliver and expire it. The key is derived from the account password on the device, so the password is the encryption and the user can see that it is: there is no second passphrase and nothing to trust in the background.

Decided 2026-10-26, after weighing a separate encryption passphrase (Pushbullet's model) and per-device key pairs with pairing. The password-derived design was chosen because every device already signs in with the password, so there is no new ceremony, and because a user who knows the password is the key understands what is encrypted and what a forgotten password costs. The costs that come with it are stated plainly below: a password reset without the recovery key loses the history, and a server-side title lookup for web pushes is no longer possible.

This document is the specification. The five clients (Android, iOS, macOS, the web app and the Chrome extension) implement the same byte formats, checked against the test vectors in `packages/push-test`, which is the reference implementation.

## What it protects, and what it does not

Protected: the content of every push at rest in Firestore and Cloud Storage, in transit through Cloud Functions and FCM, and from anyone with access to the Firebase project, Google included.

Not protected, and not claimed:

- **Metadata.** Who pushed, when, whether it was a URL or a file, the file's size, which device sent it and how many pushes an account makes. The quota, expiry and orphan sweeps need these, and they stay in plaintext.
- **Search patterns.** Search uses a blind index (below), which lets the server see that two pushes share a word, not what the word is.
- **A malicious client.** We ship the apps, and a changed app could send the key anywhere. This is true of every end-to-end encrypted app with automatic updates, and the honest statement of the guarantee is: the servers cannot read your pushes; the apps you install from us are what you trust.
- **A weak password.** The key is only as strong as the password, stretched by a slow KDF. The sign-up screen asks for at least 10 characters and says why.
- **A compromised device.** Keys are stored in the platform keystore but are usable by the app, so a device that is unlocked and in someone else's hands reads what the user reads.

## Keys

Everything derives from the password and the email, with no lookup before sign-in, so a fresh device needs nothing but the credentials it asks for today.

```
salt      = SHA-256("pushthat/salt/v1:" || lowercase(trim(email)))
stretched = PBKDF2-HMAC-SHA256(NFC(password), salt, 600000 iterations, 32 bytes)
prk       = HMAC-SHA256(key = 32 zero bytes, msg = stretched)
authKey   = HMAC-SHA256(prk, "pushthat/auth/v1"   || 0x01)
masterKey = HMAC-SHA256(prk, "pushthat/master/v1" || 0x01)
```

The last three lines are HKDF-SHA256 with an empty salt written out, since every output is one hash block and not every platform ships HKDF. The password is Unicode-normalized to NFC and not trimmed.

Byte for byte: every string in a derivation is UTF-8, the labels are ASCII, and `|| 0x01` appends one byte. The email is NFC-normalized first, like the password, since two keyboards can spell one accented letter as different code points; then `trim` removes space, tab, CR and LF from both ends and `lowercase` maps A to Z onto a to z and changes nothing else. Both are deliberately ASCII-only so that no platform's locale or Unicode tables can enter the salt: an address with a capital letter outside ASCII keeps it. Every AES-GCM tag in this document is 16 bytes, every `base64` field (`n`, `ct`, `fk`, `np`) is the standard alphabet with padding, and every `base64url` string is unpadded. PBKDF2 was chosen over Argon2id because WebCrypto, Android and CommonCrypto all have it natively and the Chrome extension's service worker has no room for a WASM library; the `kdf` field on the user document names the construction so it can be raised later. 600,000 iterations is OWASP's 2023 figure and costs about a second on a phone, paid once at sign-in.

`authKey` is what Firebase Auth sees. The clients sign in and register with `base64url(authKey)` (43 characters, no padding) as the Firebase password, never the password itself. Firebase cannot derive `masterKey` from what it holds, and a stolen Firebase hash is behind 600,000 iterations per guess before Firebase's own scrypt.

`masterKey` never leaves the device and wraps the account key:

```
accountKey = 32 random bytes, generated once at registration
prk2       = HMAC-SHA256(32 zero bytes, accountKey)
metaKey    = HMAC-SHA256(prk2, "pushthat/meta/v1"   || 0x01)   // push envelopes
searchKey  = HMAC-SHA256(prk2, "pushthat/search/v1" || 0x01)   // blind index
```

The indirection is so that a password change rewraps one 32-byte key instead of re-encrypting every push, and so that the recovery key can wrap the same account key a second time. `metaKey` and `searchKey` are separate so that a search token can never be confused with ciphertext under the same key.

### The user document

```
users/{uid}.e2ee = {
  v: 1,
  kdf: "pbkdf2-sha256-600000",
  keyVersion: 1,
  wraps: {
    <wrapId>: { by: "password" | "recovery", n: <base64 nonce>, ct: <base64 ciphertext||tag> }
  }
}
```

Each wrap is `accountKey` under AES-256-GCM with a random 12-byte nonce and AAD `"pushthat/wrap/v1:" || uid` (the Firebase uid, UTF-8), the wrapping key being `masterKey` for `password` and the recovery wrapping key for `recovery`; `ct` is 48 bytes. `wrapId` is 8 random bytes, base64url. `keyVersion` counts account keys: it goes up only when a reset without the recovery key replaces the account key, and every push records the version it was encrypted under.

A password change, in the app: derive the new `masterKey`, write a new `password` wrap, then `updatePassword` with the new `authKey`, then delete the old wrap. The order means a crash between steps leaves an account that opens with either password, never one that opens with neither.

### The recovery key

20 random bytes, shown once at registration as 32 Crockford base32 characters in groups of four separated by hyphens (`810M-4GT4-8N34-EJ29-995M-RKAE-9X85-2MJK` is the vector's), with a copy button and a "I saved it" confirmation. The encoding is RFC 4648's bit layout (most significant bit first, five bits a symbol) over Crockford's alphabet, `0123456789ABCDEFGHJKMNPQRSTVWXYZ`; 160 bits are exactly 32 symbols, so there is no padding and no check symbol. Reading one back is lenient, which is the point of the alphabet: case does not matter, hyphens and spaces are dropped, and `I` and `L` read as `1`, `O` as `0`. It wraps `accountKey` as the `recovery` wrap, with the wrapping key `HMAC-SHA256(HMAC-SHA256(32 zero bytes, recoveryBytes), "pushthat/recovery/v1" || 0x01)` over the 20 raw bytes, never the text. Settings offers to show a new one (which replaces the wrap) for a user who lost it while still signed in.

### Where keys live on each device

Only `accountKey` is kept after sign-in; `masterKey` is dropped as soon as the account key is unwrapped, and `authKey` is not needed again because Firebase keeps the session. Each install also makes a `deviceId`, 16 random bytes base64url, stored beside the key.

| Platform         | Store                                                                                                                                               |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Android          | A Keystore-wrapped entry in app storage, readable by `ShareActivity`, `RetryPushWorker` and `PushThatMessagingService`                                |
| iOS, macOS       | Keychain in the access group `group.com.makerocketgonow.pushthat`, `kSecAttrAccessibleAfterFirstUnlock`, so the share extensions and the notification service extension read it while the phone is locked |
| Web              | A non-extractable `CryptoKey` in IndexedDB: the page can use it, scripts cannot export it                                                           |
| Chrome extension | The same IndexedDB: the bundled web page and the service worker share the extension's origin, so the key the page stores at sign-in is the worker's too, and its bytes are never sent between them |

A device that holds a Firebase session but no key (an install that updated while signed in) prompts for the password once and derives.

## The push envelope

A push document keeps in plaintext what the rules, the trigger and the sweeps need, and puts everything else in one encrypted field:

```
pushes/{pushId} = {
  userId, type: "url" | "file", createdAt,
  deviceId,               // replaces deviceName; echo suppression only
  keyVersion,
  enc: { v: 1, n: <base64 nonce>, ct: <base64 ciphertext||tag> },
  searchTokens: [...],    // blind index, below
  objectPath,             // file pushes only: "uploads/{uid}/{objectId}"
  expiresAt               // file pushes, written by onNewPushCreated as today
}
```

`enc` is AES-256-GCM under `metaKey` with a random 12-byte nonce and AAD `"pushthat/push/v1:" || userId || ":" || pushId`, all UTF-8. The AAD binds the ciphertext to its document, so a ciphertext moved to another document fails to open. It means the client picks the document id before encrypting (`doc(collection(db, 'pushes'))`, `collection.document()`, `document()`), and the retry workers keep that id across attempts.

The plaintext is a JSON object:

| Type   | Fields                                                                                                  |
| ------ | ------------------------------------------------------------------------------------------------------- |
| `url`  | `url`, `title` (may be empty until scraped), `ext`                                                      |
| `file` | `name`, `mime`, `size`, `ext`, `fk` (the per-file key, base64), `np` (the file's 8-byte nonce prefix, base64) |

The plaintext is the object's JSON in UTF-8 and nothing more is fixed: there is no canonical form, since a client encrypts what its own serializer wrote and parses what it finds, so the vector gives the exact bytes it encrypted rather than an object to re-serialize. `size` is a JSON number. No `url`, `title`, `deviceName` or `ext` field may exist in plaintext on a document that has `enc`; the rules refuse them, so a downgraded client cannot leak by accident.

The one update a client makes today, filling in a scraped title, becomes a rewrite of `enc` and `searchTokens` on a `url` push (the url is re-encrypted with the title under a fresh nonce). A file push is never updated, as now.

## Files

A file is encrypted on the device with its own key before upload, stored under a random name, and the name, type and key travel in the envelope.

```
fk     = 32 random bytes            // in the envelope as fk
prefix = 8 random bytes             // in the envelope as np, and in the file header
header = "PTE1" || prefix           // 12 bytes
chunk i (plaintext 1 MiB, the last 0..1 MiB):
  nonce = prefix || BE32(i)
  aad   = "pushthat/file/v1" || BE32(i) || (final ? 0x01 : 0x00)
  out   = AES-256-GCM(fk, nonce, chunk, aad)   // ciphertext || 16-byte tag
file   = header || out_0 || out_1 || ...
```

Every chunk but the last is exactly 1 MiB of plaintext and the decryptor checks that, so a truncated, reordered or extended file fails rather than opening short. A file of n > 0 bytes has ceil(n / 1 MiB) chunks, so the last holds 1 to 1 MiB and a file of exactly 2 MiB is two full chunks, the second marked final; the empty file is the one case with an empty final chunk, a header and a bare tag, 28 bytes. The decryptor needs no length field: with every sealed chunk but the last 1 MiB + 16 bytes, a body of L bytes is ceil(L / (1 MiB + 16)) chunks and the remainder is the last, which must be at least its 16-byte tag. It also checks the magic and that the header's prefix equals the envelope's `np`, so an object cannot be served for a push it does not belong to. Everything else a corrupt file can do (a changed byte, a chunk dropped, moved or appended, a prefix swapped, a cut at a chunk boundary) fails on a tag, because the index and the final flag are in the AAD. The overhead is 16 bytes per MiB plus 12, inside the rounding of the size limits, which the Storage rules keep measuring on the uploaded object.

The object is `uploads/{uid}/{objectId}`, `objectId` 16 random bytes base64url, uploaded as `application/octet-stream`. The push records that path in `objectPath`; the download URL with its token is no longer stored or used, since every client reads through the SDK with its own auth and the Storage rules already limit reads to the owner. `onPushRecordDeleted` and the orphan sweep (`orphans.ts`) take the path from `objectPath` and fall back to the title-derived path only for documents without `enc`.

Receiving a file means downloading the object in full, decrypting chunk by chunk, and then presenting it:

- **Android, iOS, macOS** stream to a cache file and open or share it through the file provider, as they open a download today.
- **Web** decrypts into a `Blob` and triggers a save. At 100 MB that is a 200 MB peak in the tab, which is acceptable; the File System Access API can stream it later if it proves not to be.

Streaming encryption on upload means a 100 MB file never needs to be in memory twice on the apps; the web app builds the encrypted `Blob` chunk by chunk and uploads it with `uploadBytes` as now.

## Search

Every client queries `searchTokens` with `array-contains` (the Links page, `MainActivity`'s list, `PushListViewModel`) and writes them with a prefix generator. That stays, with every token replaced by its blind index:

```
token' = base64url(HMAC-SHA256(searchKey, token))[0:16]     // 96 bits
```

The token is HMACed as UTF-8, and 16 base64url characters are 96 bits exactly. The query is the one each client runs today, against the composite index it already uses.

Once the tokens are blinded, a title tokenized two ways gives two indexes that never meet, so every client tokenizes by one rule, the reference's `searchTokens`:

1. The text is NFC-normalized, then lowercased by the full Unicode mapping without a locale.
2. It is split on every run of code points that are not a letter, a combining mark or a digit (`[^\p{L}\p{M}\p{N}]+`).
3. Every prefix of every word is a token, counted in code points, and the tokens are kept once each in the order first seen, at most 3000 of them (the rules' bound).

A URL push tokenizes its title and its URL together, so a push with no title yet is found by its host and path; a file push tokenizes its name. A search normalizes and splits the term by the same rule and looks up its first word, so "github repo" finds what "github" finds, as the single `array-contains` always has; a term with no word in it is no search.

This was decided in phase 4. The three generators had drifted: the web app and Android dropped punctuation and split on whitespace (where `\w` keeps underscores and knows only ASCII letters), and iOS split on anything that is not a letter or a digit. The iOS rule was kept because it is the only one that treats every script alike, with two things pinned that Swift leaves to its String: NFC first, so a composed search term finds a decomposed title, and prefixes by code point, which every platform counts cheaply, where Swift counts grapheme clusters (the two differ only on a cluster that NFC cannot compose into one code point). Pushes made before differ in how they were split, which does not matter: the migration below tokenizes each one again by this rule as it encrypts it. The vector pins the tokens of one title and the HMAC of each, so a client checks its generator and its HMAC apart.

What the server learns is that two documents share a token and how many tokens each has; because the generator emits every prefix, two titles that share a three-letter prefix share a token. That was weighed against client-side search over a decrypted local cache, which leaks nothing but needs a cache on every platform and loads the whole history on the web, and the blind index was chosen for the first version. It can be replaced per client later without a data change, since the tokens are derivable from the envelope.

## Notifications

The server knows nothing to put in a notification but the push's id, so delivery becomes two steps: FCM carries the id, the device reads the document and decrypts before showing anything.

`onNewPushCreated` sends:

```
data:    { pushId, type, deviceId, keyVersion }
android: { priority: "high" }
apns:    { payload: { aps: { alert: { title: "New push" }, "mutable-content": 1, sound: "default" } } }
```

`title`, `url` and `deviceName` leave the payload, and the domain fallback in the function goes with them; receivers compute the domain from the decrypted URL.

- **Android.** `PushThatMessagingService` skips the push if `deviceId` is its own, reads the document, decrypts and posts the notification it posts today, deep-linking to the URL. Offline, it posts "New push" and the list decrypts when opened.
- **Chrome extension.** The service worker's push handler already initializes Firestore; it reads the document, decrypts with the key in IndexedDB and opens the tab, inside the same `waitUntil`. One Firestore read of latency, roughly 100 to 300 ms, before the tab opens.
- **iOS.** A new target, `PushThatNotificationService`, a `UNNotificationServiceExtension` on the shared Keychain group. It gets an ID token from `FirebaseAuth` (configured with `useUserAccessGroup`, as the share extension already is), fetches the document over the Firestore REST endpoint with plain `URLSession` (the Firestore SDK is too large for the extension's 24 MB), decrypts, and sets the title and body. If anything fails inside the extension's time budget the banner says "New push", and a tap opens the app, which decrypts and opens the URL. This is the largest new piece of work in the design and the only one that adds a target.
- **macOS.** The app is usually running and decrypts in-process; a notification service extension is possible on macOS too and can be added when the iOS one is proven.

Echo suppression compares `deviceId` instead of the device's model name, which also stops two phones of the same model hiding each other's pushes.

One case it does not cover: a link pushed from pushthat.link in a Chrome that also has the extension opens in a new tab there. The site and the extension are two origins with two IndexedDBs, so two device ids, where the old comparison of user agents happened to match them (and also hid every push between two machines on the same Chrome version). Closing it needs the site to ask the extension for its id, through `externally_connectable` and the extension's published id, which the repository does not have yet; until then the duplicate tab is the cost.

## Titles

The web app asks a Cloud Function, `getPageTitle`, to fetch a page's title, because a browser cannot read a cross-origin page. That function is removed: a server that fetched the URL would know it. A web push goes out with an empty title and the first native device to receive it scrapes the page and writes the title back, which the Android, iOS and macOS scrapers already do for their own pushes and now also do for a received `url` push whose title is empty. Two receivers scraping the same push both write the same title; last write wins. The Chrome extension could scrape before a phone does, but it holds host permissions only for FCM and asking for every site is a worse trade than a late title; not planned.

Until a title arrives the list shows the URL, as it does today for a push with no title.

## Rules

`firestore.rules`:

- `pushes` create: keys `hasOnly` the plaintext list above; `enc` is a map with an int `v` and string `n` and `ct`; `type` is `url` or `file`; `objectPath` is required for `file` and must start with `uploads/{uid}/`; `keyVersion` is the account's current `e2ee.keyVersion` once it has one, so a device left holding a key a reset replaced cannot add pushes nobody can open; `expiresAt` absent; the usage check unchanged. No `url`, `title`, `deviceName` or `ext` key.
- `pushes` update: on a push with `enc`, `type == 'url'` and `affectedKeys().hasOnly(['enc', 'searchTokens'])`. On a push without it, today's title update and the one migration update described under Migration.
- `users` create and update: the client may also write `e2ee`, a map whose `keyVersion` is an int no smaller than the stored one. The `hasOnly` lists gain `e2ee`; everything else stays server-owned.
- The `deviceNames` array the trigger keeps on the user document is dropped; it was the model name and it is gone from the push.

`storage.rules` are unchanged; the object name is random instead of the filename, under the same path and the same size test.

## Password reset

Firebase's hosted reset page sets the Firebase password to whatever the user types, which no client can derive `authKey` from. The plan was to point the reset email's action URL (Authentication, Templates) at `https://pushthat.link/reset`, where the web app takes the code and the new password, derives the new keys, and calls `confirmPasswordReset` with the new `authKey`. That setting cannot be changed on this project: Firebase answers `EMAIL_TEMPLATE_UPDATE_NOT_ALLOWED` from the console and from the Identity Toolkit API alike, a verified sender domain does not lift it, and a support case is the only known way to. Nor can a client steer the link there itself: `ActionCodeSettings` with `handleCodeInApp` makes the hosted handler forward a click to the continue URL with the code only for email-link sign-in, and for a password reset it always shows its own form (read from the handler's script).

So a reset runs on Firebase's hosted form, and the clients send the email with the web sign-in page as the continue URL, which gives that form a Continue button once the password is set. The sign-in that follows, on any client, derives the new keys, finds that the new `masterKey` opens none of the stored `password` wraps, and asks for the recovery key: with it, the account key is rewrapped and nothing is lost; without it, the client says the earlier pushes cannot be read and starts new keys, as below. The `/reset` page stays complete for the day the template is unlocked. What the detour costs is the order of one warning, which the recovery-key screen at sign-up has already given, and a client from before phase 3 is not affected, since the hosted form sets the raw password it signs in with.

Without the recovery key, the app says plainly that the pushes made before this reset cannot be read, generates a fresh account key with `keyVersion + 1`, and offers to delete the old pushes in one step; a user who declines sees them in the list as locked rows that can be deleted but never opened. Files expire on their own within 30 days either way.

The email is the salt, so an email change would be a rewrap like a password change. The apps have no email change today and this does not add one.

## Migration

Existing accounts have the raw password as their Firebase password and plaintext pushes. Both move on the user's first sign-in with an updated client, with no step for the user beyond signing in.

**The password.** The client derives the keys and tries `authKey` as the Firebase password. On a wrong-password error it tries the raw password; if that succeeds the account is legacy: it generates `accountKey`, writes `e2ee` with the `password` wrap, calls `updatePassword(authKey)` (allowed without reauthentication straight after sign-in), and shows the recovery key. A sign-in that fails both ways is a wrong password.

**URL pushes.** Updated in place rather than recreated, because a create would fire `onNewPushCreated` and count against the month. The update rule allows, on a document that has no `enc` yet, one update that adds `enc`, `searchTokens`, `keyVersion` and `deviceId` and removes `url`, `title`, `deviceName`, `ext` and the old `searchTokens`. The client migrates in pages of 50, from the newest, and marks the user document `e2ee.migratedAt` when the query comes back empty; any client that finds the mark skips the pass.

**File pushes.** The bytes are in Storage in plaintext and cannot be re-encrypted without a download and an upload from a device, and they expire within 30 days. The metadata is migrated like a URL push's, with `objectPath` set to the old title-derived path and `legacyPlain: true` in the envelope so clients download it without decrypting. The filename stays visible as the object's name until the file expires, which is the one place the migration leaves plaintext, for at most 30 days.

**Old app versions.** A client that has not updated cannot read an encrypted push (it finds no `url` in the FCM payload and ignores it) and cannot write one. The rules accept both shapes through a grace period and then require `enc`, after which an old version is refused on push with a message to update.

## Saying so

The reason for a password-derived key is that the user can see it. The surfaces:

- **Sign-up:** "Your password is the key to your pushes. We never see it and cannot reset it for you. Save your recovery key." The recovery key is shown there and then.
- **Settings and the Plan page:** an "Encrypted" line with the device's `deviceId` and a link to the security page.
- **Password reset:** the recovery key prompt and, without it, the sentence that the old pushes are gone, before anything is deleted.
- **The site:** a `/security` page with the gist of this document: what is encrypted, what is not, what a lost password costs.

## Server changes

Small, next to the clients:

| Where                                     | Change                                                                                       |
| ----------------------------------------- | -------------------------------------------------------------------------------------------- |
| `index.ts` `onNewPushCreated`             | FCM payload as above; drop the `deviceNames` write                                           |
| `index.ts` `onPushRecordDeleted`          | Path from `objectPath`, title fallback for legacy                                             |
| `index.ts` `getPageTitle`                 | Removed                                                                                       |
| `orphans.ts` `uploadPathsOf`              | Adds `objectPath`                                                                              |
| `expiry.ts`, `plan.ts`, billing, Stripe   | Unchanged; they read `type`, counts and `expiresAt` only                                       |
| `firestore.rules`                         | As above                                                                                      |
| Reset email (every client)                | `ActionCodeSettings` with the sign-in page as `url`; the template's action URL is locked, so the reset itself stays on Firebase's form |

## Test vectors

`packages/push-test/vectors.json`, generated by `vectors.mjs` there from `e2ee.mjs` (the reference implementation, on WebCrypto and nothing else), is the reference every client's unit tests check byte for byte. Every input is fixed and obviously made up, so running the script again reproduces the file; `npm test` there fails when the file is stale. Byte strings are hex, except where a client stores or shows a string (the Firebase password, `n`, `ct`, the blind tokens, the recovery key's display), which is given exactly as stored:

1. `email` (untrimmed, mixed case) and `password` (with a decomposed "e" + U+0301, written as an escape so that the file stays ASCII, to pin NFC) and the expected `salt`, `stretched`, `authKey`, `masterKey`, and the Firebase password string.
2. A fixed `accountKey` with `metaKey`, `searchKey`, a `password` wrap under vector 1's `masterKey` and a fixed nonce, and a fixed recovery key with its display form, its wrapping key and its `recovery` wrap.
3. A `url` envelope: fixed nonce, `userId`, `pushId`, plaintext JSON bytes, expected `ct`.
4. The blind index for "GitHub Repository": the tokens the generator emits, and the blind token for each.
5. A file of 3 MiB + 1 byte where byte i is i mod 251 (prime, so the pattern never lines up with a chunk) with a fixed `fk` and `np`: the expected SHA-256 of the encrypted file, of a tampered copy (byte 2,000,000, inside chunk 1's ciphertext, XOR 0x01) and of a copy with sealed chunks 0 and 1 swapped, both of which must fail to decrypt.
6. The empty file: its 28 bytes.

## Phases

Each phase is shippable on its own; the rules do not require `enc` until the last.

1. **Reference and vectors.** The Node implementation and `vectors.json` in `packages/push-test`.
2. **Server, both shapes.** The function changes above with legacy fallbacks; rules that accept both shapes; the reset action URL and the `/reset` page. The page ships here but is not reached today, since the template's action URL cannot be changed on this project (Password reset, above); resets stay on Firebase's form and the recovery key is asked for at the next sign-in.
3. **Keys.** Sign-in, registration, the legacy fallback and the password migration on all five clients, each with a vector test. Users see no change yet beyond the recovery key at sign-up.
4. **Pushes.** The envelope, files, the blind index, the receive paths and the push migration on all five clients; the iOS notification service extension.
5. **Require it.** Rules refuse plaintext pushes; `getPageTitle` and the plaintext FCM fields are removed; the "Encrypted" copy and the security page go up.

## Costs

- One Firestore read per device per push received, so that a notification can be shown. At current volumes this is below the free quota.
- About a second of KDF at sign-in on a phone, once.
- Memory on the web for a 100 MB file: about twice the file during decryption.
- A push document grows by nothing worth noting: the blind tokens are 16 characters against the words they replace, and `enc` is the fields it replaces plus 28 bytes.
