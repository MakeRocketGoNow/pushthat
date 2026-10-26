// Writes vectors.json: the six vectors docs/e2ee.md lists, from the fixed inputs below and
// nothing random, so that running it again reproduces the file byte for byte (`--check`
// compares instead of writing, for CI). The clients' unit tests read the file; a client
// that disagrees with a byte here disagrees with the specification.
//
// Every input is obviously made up: nothing here is a real account, password or push.

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  accountSubkeys,
  base64,
  blindIndex,
  CHUNK_SIZE,
  deriveKeys,
  encodeRecoveryKey,
  encryptFile,
  fromHex,
  hex,
  KDF,
  normalizeEmail,
  PBKDF2_ITERATIONS,
  recoveryWrappingKey,
  searchTokens,
  sealPush,
  sha256,
  utf8,
  wrapAccountKey,
} from "./e2ee.mjs";

export const VECTORS_PATH = fileURLToPath(new URL("./vectors.json", import.meta.url));

// A run of bytes starting at `first`, so each fixed key is distinct and readable in hex.
const run = (first, length) => Uint8Array.from({ length }, (_, i) => (first + i) & 0xff);

// The pattern the 3 MiB + 1 file is made of: byte i is i mod 251. 251 is prime, so the
// pattern never lines up with a chunk boundary and a chunk put back in the wrong place
// would still differ from the right one.
export const filePattern = (length) => Uint8Array.from({ length }, (_, i) => i % 251);

// The 3 MiB + 1 file, tampered: one bit flipped at this offset, which falls inside the
// ciphertext of chunk 1 (chunk 0 ends at 12 + 1 MiB + 16).
export const TAMPER_OFFSET = 2000000;

export const inputs = {
  // Untrimmed, mixed case, so the salt pins the normalization. The password holds "e"
  // followed by U+0301 (combining acute), which NFC folds into U+00E9; a client that
  // skips the normalization derives a different key.
  email: " Example.User@Example.com ",
  password: "Cafe\u0301 latte, 2026!",
  uid: "vector-uid-0001",
  accountKey: run(0x10, 32),
  passwordWrapNonce: run(0xa0, 12),
  recoveryKey: run(0x40, 20),
  recoveryWrapNonce: run(0xb0, 12),
  pushId: "vector-push-0001",
  pushNonce: run(0xc0, 12),
  pushPlaintext: '{"url":"https://example.com/docs/report?v=2#summary","title":"Example report","ext":"html"}',
  searchText: "GitHub Repository",
  fk: run(0x60, 32),
  np: run(0xd0, 8),
  fileLength: 3 * CHUNK_SIZE + 1,
};

export const generate = async () => {
  const keys = await deriveKeys(inputs.email, inputs.password);
  const sub = await accountSubkeys(inputs.accountKey);
  const passwordWrap = await wrapAccountKey(keys.masterKey, inputs.accountKey, inputs.uid, "password", inputs.passwordWrapNonce);
  const recoveryWrapKey = await recoveryWrappingKey(inputs.recoveryKey);
  const recoveryWrap = await wrapAccountKey(recoveryWrapKey, inputs.accountKey, inputs.uid, "recovery", inputs.recoveryWrapNonce);
  const plaintext = utf8(inputs.pushPlaintext);
  const enc = await sealPush(sub.metaKey, inputs.uid, inputs.pushId, plaintext, inputs.pushNonce);
  const tokens = searchTokens(inputs.searchText);
  const blind = await blindIndex(sub.searchKey, tokens);

  const pattern = filePattern(inputs.fileLength);
  const file = await encryptFile(inputs.fk, inputs.np, pattern);
  const tampered = Uint8Array.from(file);
  tampered[TAMPER_OFFSET] ^= 0x01;
  const sealedSize = CHUNK_SIZE + 16;
  const reordered = Uint8Array.from(file);
  reordered.set(file.subarray(12, 12 + sealedSize), 12 + sealedSize);
  reordered.set(file.subarray(12 + sealedSize, 12 + 2 * sealedSize), 12);
  const empty = await encryptFile(inputs.fk, inputs.np, new Uint8Array(0));

  return {
    // Every byte string is hex unless it is the string a client stores or shows, in which
    // case it is given exactly as stored (and in hex beside it where that helps).
    spec: "docs/e2ee.md",
    kdf: KDF,
    keys: {
      email: inputs.email,
      normalizedEmail: normalizeEmail(inputs.email),
      password: inputs.password,
      passwordNfcUtf8: hex(utf8(inputs.password.normalize("NFC"))),
      iterations: PBKDF2_ITERATIONS,
      salt: hex(keys.salt),
      stretched: hex(keys.stretched),
      authKey: hex(keys.authKey),
      masterKey: hex(keys.masterKey),
      firebasePassword: keys.firebasePassword,
    },
    account: {
      uid: inputs.uid,
      accountKey: hex(inputs.accountKey),
      metaKey: hex(sub.metaKey),
      searchKey: hex(sub.searchKey),
      wrapAad: hex(utf8("pushthat/wrap/v1:" + inputs.uid)),
      // Under keys.masterKey.
      passwordWrap: { nonce: hex(inputs.passwordWrapNonce), ...passwordWrap },
      recovery: {
        bytes: hex(inputs.recoveryKey),
        display: encodeRecoveryKey(inputs.recoveryKey),
        wrappingKey: hex(recoveryWrapKey),
        wrap: { nonce: hex(inputs.recoveryWrapNonce), ...recoveryWrap },
      },
    },
    // Under account.metaKey.
    push: {
      userId: inputs.uid,
      pushId: inputs.pushId,
      aad: hex(utf8(`pushthat/push/v1:${inputs.uid}:${inputs.pushId}`)),
      plaintext: inputs.pushPlaintext,
      plaintextUtf8: hex(plaintext),
      nonce: hex(inputs.pushNonce),
      enc,
    },
    // Under account.searchKey. `tokens` is what the generator emits for `text`; the blind
    // index is pinned per token, so a client checks its HMAC and its generator apart.
    search: {
      text: inputs.searchText,
      tokens,
      blind,
    },
    file: {
      fk: hex(inputs.fk),
      np: hex(inputs.np),
      fkBase64: base64(inputs.fk),
      npBase64: base64(inputs.np),
      header: hex(file.subarray(0, 12)),
      length: inputs.fileLength,
      pattern: "byte i is i mod 251",
      plaintextSha256: hex(await sha256(pattern)),
      encryptedLength: file.length,
      encryptedSha256: hex(await sha256(file)),
      // The same file with byte `tamperOffset` XOR 0x01: must fail to decrypt.
      tamperOffset: TAMPER_OFFSET,
      tamperedSha256: hex(await sha256(tampered)),
      // The same file with the sealed chunks 0 and 1 swapped: must fail to decrypt.
      reorderedSha256: hex(await sha256(reordered)),
    },
    emptyFile: {
      fk: hex(inputs.fk),
      np: hex(inputs.np),
      encrypted: hex(empty),
      encryptedSha256: hex(await sha256(empty)),
    },
  };
};

// Two spaces, a trailing newline, and nothing outside ASCII: the one non-ASCII input is
// written as an escape so the decomposed "e" + U+0301 is visible in the file.
export const render = (vectors) =>
  JSON.stringify(vectors, null, 2).replace(/[\u0080-\uffff]/g, (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0")) + "\n";

const main = async () => {
  const text = render(await generate());
  if (process.argv.includes("--check")) {
    let current = null;
    try {
      current = readFileSync(VECTORS_PATH, "utf8");
    } catch {
      // Treated as a stale file below.
    }
    if (current !== text) {
      console.error("vectors.json is out of date: run `npm run vectors`");
      process.exit(1);
    }
    console.log("vectors.json is current");
    return;
  }
  writeFileSync(VECTORS_PATH, text);
  console.log(`wrote ${VECTORS_PATH}`);
};

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await main();
}
