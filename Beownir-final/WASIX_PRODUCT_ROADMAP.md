# Browser Node.js runtime: WASIX and commercial-readiness roadmap

**Status date:** 2026-11-17
**Purpose:** distinguish working browser-runtime capabilities from real Node-on-WASIX claims, and define an executable path to a publishable product. This is an engineering plan, not a compatibility or certification claim.

## Newly verified compatibility steps

- `WASI.runChild(bytesOrModule, options)` runs a WASI command module in the limited engine with separate descriptors and returns the child's `proc_exit` status plus captured output. The test uses a real WASM module that exits with status 7. This is not a native OS process and is not wired to `child_process.spawn`.
- The framework matrix includes Vite 6 HTTP dev serving, transforms, HMR file invalidation, and production builds. Additional integrated checks now exercise Vite 6 + React 19 together: a dev-server request serves HTML and transforms JSX with React imports, and a production build resolves dependencies and emits the React app bundle. These are bounded smoke tests; the HMR WebSocket upgrade and initial `connected` frame now pass over the virtual duplex transport, but browser-side DOM updates, file-change delivery through HMR, arbitrary plugins and arbitrary application configurations remain unverified.
- The latest recorded matrix contains 35 passing profiles. This is breadth evidence, not a percentage claim for general package compatibility or a substitute for the still-open native Node/WASIX gates.

## Product definition

Beownir is a browser-side development runtime and IDE. It is not Node.js running natively in the browser: browser security forbids arbitrary OS processes, raw sockets, native addons, and unrestricted filesystem access. The product must describe its execution model as a browser sandbox and label each feature as implemented, partial, or unavailable. A commercial release should not use “Node.js for browsers” without an immediate qualification that it provides a Node-compatible environment with platform limitations.

## What this repository establishes today

- The limited engine implements a broad curated Node-compatible API surface.
- `o/native/portable-wasi.cjs` supplies a WASI host implementation, and `test/wasi.test.mjs` verifies filesystem calls, stdio, arguments/environment, exit code behavior, and a real QuickJS WASM fixture.
- The native Wasmer execution group is instrumented to run `o/native/runtime-probe.cjs` without the compatibility preload and report guest Node version plus independent filesystem, TCP-loopback, and `worker_threads` results. The probe is covered against local Node in `test/native-runtime-probe.test.mjs`; this is not evidence that the Wasmer guest supports those capabilities. In the isolated Chromium acceptance attempt, cross-origin isolation was true, but the request to `https://registry.wasmer.io/graphql` failed with `net::ERR_CONNECTION_CLOSED` before package acquisition, so the guest never launched and no guest capability results exist. The kernel now includes the pinned package name in its acquisition error. Native gates remain blocked until the registry is reachable in the target browser or the runtime package is distributed through an accessible, integrity-verified channel.
- `o/native/portable-subprocess.cjs` handles synchronous child-process calls through the runtime syscall broker. Separately, the limited WASI host now exposes `WASI.runChild(bytesOrModule, options)`: it instantiates a child WASI command module with independent descriptors and returns its `proc_exit` status and captured stdio. Tests exercise a real WASM module calling `proc_exit(7)`. This is limited-engine WASI child execution, not a native WASIX process and not generic `child_process.spawn`.
- Existing WASI checks explicitly expect sockets to return `ENOSYS` (`test/wasi.test.mjs`); therefore the in-runtime virtual-network story is not complete for WASIX sockets.
- Worker-related exports and WASI shims do not establish that real threaded Node works. Real threads require shared memory, `SharedArrayBuffer`, `Atomics`, browser worker lifecycle/termination, and a compatible WASIX/Node artifact.
- Running native `node -v` in the Wasmer/WASIX environment is still the decisive release gate for the native Node claim. A sandbox test of the JS/WASI host cannot substitute for it.

These statements are intentionally narrower than an API-export census: export presence is not behavioral or native-runtime compatibility.

## Workstreams and acceptance gates

### 1. Child WebAssembly programs (first)

**Goal:** a parent runtime command launches a WASM/WASI child, captures stdout/stderr, receives its exit status, and can terminate it without escaping the browser sandbox.

**Implementation sequence:**
1. Define a `spawnWasm` contract and error model (module source/URL, args, env, bounded stdio, preopens/capabilities, exit status, termination).
2. Implement it through the existing runtime owner/syscall boundary; do not expose host filesystem paths or ambient network access.
3. Add tests for exit 0/nonzero, `proc_exit`, trap, invalid module, stdout/stderr, byte limits, cancellation, and cleanup. Include a regression proving one child cannot access another child's mounts.
4. Add a small command-style WASI fixture and wire the supported subset into `child_process` only if the public semantics can be made coherent; otherwise expose it as a clearly named WASM API rather than pretending it is arbitrary OS `spawn`.

**Done when:** parent-observable exit codes and bounded output are covered by tests; cleanup occurs on normal exit, trap, and cancellation; the UI and docs call it a WASM child, not an OS process.

### 2. Virtual loopback sockets (second)

**Goal:** WASIX programs and JS programs communicate only through the runtime's virtual network.

**Implementation sequence:**
1. Specify the virtual-network address/port namespace, ownership, connection queue, backpressure, close/error semantics, and per-project isolation.
2. Implement TCP loopback first; map the WASIX socket calls needed by a real test program onto that network. Preserve the existing rule that arbitrary Internet TCP/UDP is unavailable in the page.
3. Test bind/listen/connect/accept, concurrent clients, half-close, reset, refused port, port reuse, backpressure, cancellation, and cross-group isolation. Explicitly prove that an Internet address cannot escape via this path.
4. Add UDP and additional WASIX calls only after TCP behavior is stable and validated against actual WASIX binaries.

**Done when:** the existing `ENOSYS` socket assertion is replaced by executable tests for the supported subset, and a real WASIX socket fixture can exchange data with a JS endpoint.

### 3. Real threads (third; hardest)

**Goal:** support threaded WebAssembly/Node only when the browser and runtime artifact genuinely support shared memory and worker execution.

**Implementation sequence:**
1. Capability-gate on cross-origin isolation, `SharedArrayBuffer`, `Atomics`, worker availability, and the exact Wasmer/WASIX build's thread support.
2. Design shared-memory ownership, worker startup, message/stdio routing, termination, resource limits, and deadlock-safe shutdown.
3. Test atomic visibility, simultaneous workers, memory growth constraints, worker crashes, cancellation, and no cross-project shared-memory leakage.
4. Run actual threaded WASI fixtures, then the target Node build. Never infer thread support from a `worker_threads` module or export count.

**Done when:** a real multithreaded WASI program passes under the browser deployment profile and degrades with a specific actionable capability message otherwise.

### 4. Native Node gate (required before advertising Node-on-WASIX)

Run `node -v` using the exact intended Node/WASIX artifact in the supported browser deployment (served with required isolation headers), followed by `node -e` checks for process exit, filesystem, socket loopback, and threads. Record artifact digest, browser/version, deployment headers, and exact output. If the target Node artifact cannot be acquired or executed, mark this gate **blocked/unverified**; do not convert that absence into a passing claim.

## Commercial publication checklist

- Choose the product promise precisely: browser IDE + compatibility runtime versus genuine Node on WASIX. Treat the latter as a separate, gated profile.
- Maintain a capability matrix with evidence links and versions; distinguish API surface, behavioral tests, framework smoke tests, and native Node tests.
- Publish known limitations: no unrestricted host access, no arbitrary outbound TCP/UDP, native addon limits, browser storage quotas, browser-specific requirements, and unsupported packages.
- Audit software licenses and notices for the app, embedded WASM/runtime binaries, fixtures, and npm dependencies before distribution. Ensure license/redistribution rights are explicit.
- Add a security review for untrusted projects/packages, resource exhaustion, origin isolation, worker termination, supply-chain integrity, and storage cleanup.
- Define privacy and telemetry defaults, data retention, support policy, supported browser versions, release/versioning policy, and incident response.
- Establish reproducible release builds, artifact hashes/SBOM, automated tests, deployment-header checks, and a human-run native Node acceptance test.

## Release rule

A feature is **supported** only when there is a repeatable test on the user-facing browser deployment. “Implemented in a shim,” “exports the API,” and “works in Node tests” are useful evidence, but are not interchangeable with running the real Node/WASIX binary. The native `node -v` gate remains open until it has been executed and recorded on the target environment.
