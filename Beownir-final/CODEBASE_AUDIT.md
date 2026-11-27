# Codebase audit: bugs, regressions, and release blockers

**Audit date:** 2026-11-17 (UTC, as supplied by the workspace)
**Scope:** repository source, generated single-file artifact, runtime/deployment paths, test evidence, documented compatibility and security claims. This is a code review and targeted acceptance pass, not a penetration test or a proof of Node/WebContainers equivalence.

## Executive summary

The repository has a substantial local compatibility runtime and an extensive test suite. Its static-host mode is a browser-native, NodePod-style compatibility environment (not a native Node executable), and now routes the visible Install/Build controls into that runtime instead of sending static-host users to native-host setup. Isolated Chromium verified `node -e`, an npm package install and require, launching the starter HTTP server, and rendering its preview through virtual HTTP. This is useful working browser behavior, but it does **not** establish full Node/WASIX compatibility. The separate Edge.js/WASIX profile still cannot be acquired in the tested environment, and browser DOM HMR, broad package coverage, and native guest capability probes remain incomplete or unverified.

Three concrete source/documentation defects were found and corrected during this review:

1. The network-only host was binding to `0.0.0.0` despite docs/audit saying it was loopback-only. It now defaults to `127.0.0.1`; network binding is explicit via `BEOWNIR_BIND=0.0.0.0`.
2. The deployment checker rejected valid three-origin host deployments because it only checked the static origins meta tag, while the host injects `window.__BEOWNIR_HOST__` at request time. It now validates the injected origin config (or the configured meta tag); host integration tests cover it.
3. The UI contained an obsolete 78.4%/1,153-export/43-module claim despite generated evidence reporting 99.8%/1,336 exports/55 modules. That stale number was replaced with a report link and a qualification; the report template's HMR/security statements were also reconciled with the actual evidence.

## Severity-ranked findings

### P0 — Native runtime bootstrap cannot be completed in the tested browser environment (OPEN, release blocker)

- **Evidence:** isolated Chromium had `crossOriginIsolated === true`, `SharedArrayBuffer` and JSPI available. Earlier acceptance attempts failed all three requests to `https://registry.wasmer.io/graphql` with `net::ERR_CONNECTION_CLOSED`. In a subsequent browser attempt, the UI reported the kernel ready, but `node -v` caused its isolated execution group to stop before returning a Node version; no guest behavior probe passed. The guest is therefore still unverified (the UI/kernel ready handshake is not guest readiness).
- **Code path:** `o/native/native-kernel.mjs` loads `wasmer/edgejs@=0.2.5`; retries now run through `client.packages.load`. The user-facing kernel reports the package and registry on final failure. The embedded SDK downloads this runtime separately from the 9 MiB app artifact.
- **Impact:** real guest Node CLI, npm CLI, native Node filesystem/socket/thread behavior, and framework execution in this profile are not validated in this environment. The runtime is not an offline single-file distribution.
- **Next acceptance gate:** run the exact artifact in a browser/deployment where the Wasmer registry/package is reachable, or ship a legally distributable, integrity-verified runtime package from an accessible origin. Then capture browser/version, isolation headers, package digest, `node -v`, filesystem/TCP/worker probe output, and the actual app preview/HMR result. Do not infer success from local Node tests.

### P1 — Network-only host default exposed all interfaces (FIXED)

- **Evidence:** `o/host/beownir-host.mjs` used `server.listen(port, "0.0.0.0", ...)`; meanwhile `INSTALL.md` and `SECURITY_AUDIT.md` described loopback as the default and the install command incorrectly suggested unsupported `--host` flags.
- **Risk:** a user launching the documented local host could unintentionally expose IDE, runtime and preview relays to LAN clients.
- **Correction:** host now defaults to `127.0.0.1`, validates `BEOWNIR_BIND`, and logs the actual bind address. `BEOWNIR_BIND=0.0.0.0` is an explicit opt-in. Install/readme/security docs now state this accurately. Host tests assert the safe default and invalid bind rejection.
- **Deployment note:** remote preview tooling must opt in to `BEOWNIR_BIND=0.0.0.0` when the platform requires it; the development host is still not a hardened public multi-tenant reverse proxy.

### P1 — Deployment checker false-negative for valid hosted configuration (FIXED)

- **Evidence:** `node o/deploy/check.mjs --ide http://localhost:4173 --runtime http://localhost:4174 --preview http://localhost:4175` initially failed because the generated HTML has an empty origins meta tag. This is expected: the host injects its request-specific origins as `window.__BEOWNIR_HOST__`.
- **Impact:** a valid local three-origin deployment was reported as misconfigured, reducing the value of the release gate.
- **Correction:** checker now accepts and validates the host-injected config, with static meta configuration as the alternate path. `test/host.test.mjs` invokes the checker against a running real host and expects a pass.

### P1 — Stale compatibility number presented in the product UI (FIXED)

- **Evidence:** `o/site/index.html` described 78.4% of 1,153 exports across 43 modules, while generated `NODE_COMPATIBILITY_REPORT.md` measured 99.8% of 1,336 exports across 55 modules. These numbers came from different versions of the report and could mislead product users.
- **Correction:** the fixed UI points to generated evidence and explicitly says export presence is not behavioral/native compatibility. Generated report templates were updated to distinguish virtual HMR testing from browser DOM-level HMR and to state native package acquisition is unverified.

### P1 — Browser-side HMR and native behavior are not acceptance-tested (OPEN)

- The framework matrix exercises Vite's virtual WebSocket handshake, `connected` frame, edit/update frame, and transform invalidation. It does not run the real editor iframe + preview browser client through an edit and assert changed DOM.
- The isolated browser cannot launch the Wasmer guest because package acquisition fails first. Thus native HMR, real Node dev-server DOM updates, sockets and worker threads have no observed result.
- Current honest status: **virtual-runtime HMR transport smoke tests pass; browser DOM HMR and native guest behavior are unverified**.

### P1 — WASI socket calls remain unsupported in the limited runtime (OPEN capability gap)

- `o/compat/wasi/host.js` lists `sock_accept`, `sock_recv`, `sock_send`, and `sock_shutdown` as unsupported and returns `ENOSYS`; `poll_oneoff` is also unsupported.
- The JS virtual loopback and the WASI syscall host are separate capability layers. JS `net` loopback tests do not prove WASIX/WASI binaries can use sockets.
- Acceptance requires a real WASIX socket fixture that binds/accepts/connects and exchanges bytes over the virtual network, plus refusal/close/backpressure/isolation cases. Do not advertise general WASIX sockets until then.

### P1 — Resource isolation is incomplete for untrusted code (OPEN security/commercial blocker)

- The security audit describes that user JS can consume memory and CPU until the browser kills the worker/tab; web workers do not provide a script-enforced heap or hard CPU cap. The storage quota is not a memory/CPU limit.
- The development host is not a hardened public reverse proxy. CSP requires unsafe inline/eval for the current app model, so it is not an XSS boundary.
- No external penetration test, hostile-project test campaign, archive-extractor fuzzing, or dependency vulnerability scan was performed in this review. This is acceptable for a private trusted-project prototype, not evidence for a commercial hostile-code sandbox.

### P2 — Broad API export coverage overstates practical compatibility if quoted alone (KNOWN, qualified)

- Generated census: 99.8% exports and 111/111 differential snippets on local Node. These measure the limited JS runtime against host Node, not the Edge.js guest or arbitrary npm projects.
- The same report lists partial/stub behavior: crypto gaps (including key generation/ECDSA/X509 paths), zlib Brotli/Zstd unavailable, virtual-only networking, child-process/worker semantics that are not OS processes, synchronous-scope-only async context, no fresh `vm` realm, and `node:test` unsupported.
- Keep export census, differential snippets, framework matrix, browser integration, and native guest acceptance separate in release language.

### P2 — Commercial/release compliance remains unproven (OPEN)

- Embedded Wasmer SDK and large compiler/runtime assets need a complete license/redistribution review; runtime/transitive artifacts are fetched separately and should be pinned and integrity-checked.
- No SBOM or third-party vulnerability scan was run as part of this audit. The security audit itself says this is an engineering review, not a third-party penetration test.
- The exact runtime package is still upstream-fetched rather than embedded, which creates availability and reproducibility risk in addition to the sandbox's current registry-access failure.

## Validation performed in this audit

- `npm run check`: passed (embedded-source synchronization, script parse/DOM checks, native asset consistency, standalone size checks).
- `npm run standalone:smoke`: passed (9.04 MiB artifact; six checks: boot, pwd, filesystem, `node -e`, ESM require, Buffer; persistence restore).
- `npm run reports`: completed; generated current reports with **327/327 tests passed** and differential **111/111**.
- `npm run matrix:check`: passed **35/35** framework profiles in the virtual runtime.
- `node --test test/host.test.mjs`: passed after bind and deployment-checker corrections.
- Isolated Chromium static-host run: `crossOriginIsolated === true`; `node -e` executed; `npm install is-number` succeeded and `require('is-number')` returned true; `npm start` opened port 3000 and the preview rendered the starter page over virtual HTTP. NPM panel Install also ran `npm install` without opening native setup.
- Isolated Chromium native-profile run: runtime package fetch failed three times with `ERR_CONNECTION_CLOSED`; WASIX guest did not launch.
- A first manual deployment-check run exposed the dynamic-origin checker bug; a regression test now invokes the deployment checker against a live host.

## Recommended order of remaining work

1. Resolve runtime package availability with an approved accessible mirror or pinned signed artifact; rerun the actual guest acceptance probe.
2. Add a browser automation test that boots the runtime, starts a small Vite app, edits a module in the IDE, and asserts the preview DOM changed without a full reload.
3. Implement/test the WASIX socket syscall subset or explicitly keep it unavailable; do not treat JS loopback tests as evidence.
4. Add actual WASIX threaded and filesystem fixtures, then test multiple browser engines and failure/termination behavior.
5. Complete resource-exhaustion and sandbox testing, license/SBOM/dependency review, archive/parser fuzzing, external penetration testing, and release support/privacy/incident policies before commercial release claims.
