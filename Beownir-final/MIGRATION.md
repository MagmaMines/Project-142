# Migration notes

Applies to projects, deployments and forks moving from the hand-edited
`o/site/index.html` era (3.0.0-rc.5 and earlier) to this build (3.0.0-rc.6).

## Your workspace and storage: nothing to do

The storage layer is unchanged, so existing workspaces open as they are:

| Store | Name / version | Content |
| --- | --- | --- |
| IndexedDB | `beownir-workspace` v3 | projects, file trees, metadata |
| IndexedDB | `beownir-workspace-cache` v2 | dependency cache, rebuildable checkpoints |
| localStorage | `beownir.fs.v1` | the legacy single-project filesystem, imported once if present |
| localStorage | `beownir-origins`, `beownir-live-reload`, `beownir-coi-reload` | UI preferences |

No key was renamed, no schema migration runs, and the dependency cache is never
trusted over a fresh install: if a cache entry is unreadable it is dropped and
the package is re-fetched (with integrity verification), which is the same
behaviour as before.

## Editing the product moved out of the HTML

Before, the runtime and host existed only as `<script>` blobs inside
`o/site/index.html`. Editing them meant editing an 8 MiB file.

Now:

```
o/runtime/worker-runtime.js   -> <script id="runtimeSource">         (embedded)
o/runtime/frame-kernel.js    -> <script id="runtimeFrameSource">     (embedded)
o/runtime/preview-bridge.js  -> <script id="previewBridgeSource">    (embedded)
o/runtime/stream-kit.js      -> install kit                          (embedded)
o/site/coi-sw.js             -> <script id="coiServiceWorkerSource"> (embedded)
```

Workflow:

```bash
# 1. edit the source file
# 2. push it into the HTML copy
node tools/sync-embedded.mjs
# 3. rebuild the release artifact
node tools/build-standalone.mjs
```

`sync-embedded --check` (part of `npm run verify`) fails when the HTML copy and
the file disagree, so the two can no longer drift silently. Do not hand-edit an
embedded block; the next sync overwrites it.

## The release artifact

`beownir-standalone.html` at the repository root is now the thing you ship. It
is generated, byte-for-byte reproducible, and self-describing:

- `<script id="beownir-build-manifest" type="application/json">` lists every
  source, every native asset, the anchors and the allowed external references;
- `node tools/build-standalone.mjs --check` fails when the committed artifact is
  stale, hand-modified, missing an asset, or when a source no longer matches;
- `node tools/standalone-smoke.mjs` boots the artifact alone (no source tree)
  and runs commands through the embedded runtime.

If you deploy `o/site/index.html` directly, keep doing that: it is still the
single file with everything embedded. The new artifact adds the manifest and is
built by a tool rather than by hand.

## Behaviour changes you might notice

| Area | Before | Now |
| --- | --- | --- |
| `crypto.createSign` / `createVerify` / `sign` / `verify` | threw `ERR_CRYPTO_OPERATION_FAILED` | implemented for RSA with PKCS#1 v1.5 padding; signatures are byte-identical to OpenSSL (asserted in `test/crypto-asymmetric.test.mjs`) |
| `crypto.publicEncrypt` / `privateDecrypt` / `privateEncrypt` / `publicDecrypt` | threw | implemented, PKCS#1 v1.5 and OAEP (`oaepHash`); round-trips with Node in both directions |
| `crypto.createPrivateKey` / `createPublicKey` | threw | parses unencrypted PKCS#1/PKCS#8/SPKI PEM and DER, exports the same plus JWK; `asymmetricKeyDetails` reports the real modulus |
| `crypto.constants` | partial object that could lose `RSA_PKCS1_PSS_PADDING` | merged with the full Node constant table; a PSS request can no longer fall through to PKCS#1 |
| `publicEncrypt({ key, padding, oaepHash }, buf)` | options object was ignored, so a PSS/OAEP request silently became PKCS#1 | options object is honoured; the differential suite asserts that an OAEP ciphertext is *rejected* by PKCS#1 padding |
| `fs`, streams, npm installer | — | unchanged |

Still deliberately absent, and still failing with a stable code rather than a
wrong answer: `crypto.generateKeyPairSync` (key generation), `createECDH`,
ECDSA/Ed25519, RSA-PSS, X.509 certificate parsing, encrypted PEM, Brotli and
Zstd compression, raw TCP/UDP beyond the host relay, and `node --test`'s process
runner.

## Upgrading a fork

1. `git merge` as usual; conflicts in `o/site/index.html` are expected if you
   edited embedded blocks — take the source-side changes from `o/runtime/` and
   re-run `node tools/sync-embedded.mjs` instead of resolving the blob by hand.
2. `npm run verify` must pass. It now includes `build-standalone --check`, so a
   stale artifact fails the gate rather than shipping silently.
3. Regenerate the reports with `npm run reports` so the documented numbers
   match the artifact you ship.
