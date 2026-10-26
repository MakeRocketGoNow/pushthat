# push-test

Two things live here, with nothing in common but Node and the folder.

## The FCM send script

`index.js` sends one test notification through Firebase Cloud Messaging to one device. It
needs the project's service account key, which signs as the whole Firebase project, and so
lives only on a machine that sends test pushes and never in the repository
(`serviceAccountKey.json` is gitignored; `GOOGLE_APPLICATION_CREDENTIALS` points elsewhere).

```bash
FCM_TOKEN=<the device's registration token> node index.js
```

## The end-to-end encryption reference

`e2ee.mjs` is the reference implementation of [docs/e2ee.md](../../docs/e2ee.md): every
construction in the specification, on WebCrypto and no third-party crypto, so that the web
app and the Chrome extension can lift it as it is and the other platforms have one place to
read the bytes from. `vectors.mjs` writes `vectors.json`, the test vectors every client's
unit tests check byte for byte, from fixed inputs and nothing random; running it again
reproduces the file.

```bash
npm ci
npm test               # round trips, the failures the spec promises, and that vectors.json is current
npm run vectors        # rewrite vectors.json after a change to the spec
npm run vectors:check  # fail if vectors.json is stale, without writing it
```

A change here that changes a byte is a change to the specification: make it in the
document first, then here, then regenerate the vectors, in one commit, so the five clients
read the same thing.
