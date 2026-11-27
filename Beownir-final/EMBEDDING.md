# Embedding the Beownir kernel in your own web IDE

Beownir ships as a single-file IDE, but the runtime inside it — virtual
filesystem, Node-compatible worker runtime, streamed npm installer, virtual
HTTP servers — does not require that IDE. **`o/embed/beownir-kernel.js` is one
file you can drop into your own HTML/CSS interface**, with no build step and no
other files from this repository:

```html
<script src="beownir-kernel.js"></script>
<script>
  const kernel = BeownirKernel.create();
  kernel.whenReady().then(async () => {
    await kernel.writeFile('app.js', "console.log('hello from someone else\\'s IDE');\n");
    const run = await kernel.run('node app.js');   // { code: 0, stdout: "hello…\n", stderr: '' }
  });
</script>
```

Everything runs in the visitor's browser. There is no server, no WebSocket
backend, no native binary download. The bundle is 5.6 MiB (5,703 KiB at
3.0.0-rc.6) because it carries the same runtime the IDE carries: the worker
runtime (1.17 MiB), the frame kernel (23 KB), pako (46 KB) and the esbuild
wasm/browser pair used to run ESM and TypeScript. It is generated from the
application's own sources, so it cannot drift from them — `npm run check`
fails the build if it does, and `test/embed.test.mjs` pins the payload
byte-for-byte.

A complete working example — a third-party-style page with its own editor,
console and run buttons that installs an npm package and starts a dev server —
lives at `test/embed/index.html`. `npm run embed:e2e` drives it headless
(see **What is actually tested** below).

---

## API

`BeownirKernel.create([options])` → `kernel`. The global is frozen and carries
`version`, `create`, `BeownirKernel`, `normalisePath` and `capabilities()`.

Options:

| option       | type    | meaning                                                                 |
|--------------|---------|-------------------------------------------------------------------------|
| `files`      | object  | initial files: `{'/project/app.js': '…'}` (strings, `{content}` or `{directory: true}`; `null` removes) |
| `container`  | element or selector | where the hidden kernel iframe goes (default `<body>`)        |
| `limits`     | object  | `{bytes, perFile, entries}` workspace budget overrides                  |
| `autostart`  | boolean | boot immediately (default `true`)                                       |

### Lifecycle

- `kernel.start()` — boots the kernel; resolves when ready. Called automatically unless `autostart: false`.
- `kernel.whenReady()` — promise that resolves when the runtime accepts commands.
- `kernel.destroy()` — terminates every process, server and timer, removes the hidden frame, rejects pending work. Commands afterwards reject.
- `kernel.state` — `idle` → `booting` → `ready` → `stopped`/`destroyed`/`failed`.
- `kernel.ports` — array of virtual ports with a listening server.

### Files

- `kernel.writeFile(path, content)` — writes a text file; parent directories are created. Relative paths resolve inside `/project`.
- `kernel.writeFileBytes(path, bytes)` — writes binary content (`Uint8Array` or base64 string).
- `kernel.removeFile(path)` — removes an entry.
- `kernel.setFiles(map)` — replaces the whole filesystem.
- `kernel.readFile(path)` / `kernel.exists(path)` — read the client-side mirror. The mirror updates when your programs write files (`fs.writeFileSync` inside `node` fires a `files` event the client applies). Binary files written by programs are stored base64-prefixed; `readFile` returns that record as-is.

Only `/project` and `/tmp` exist. Anything else — `/etc/passwd`, `C:\…`, a bare
`../escape` — normalises and then throws an `Error` with `code: 'EPERM'`
before a message is even sent. The kernel would reject it anyway; the client
fails fast with a name you can branch on.

### Commands

- `kernel.run(command, [{timeoutMs, onData}])` → `{code, stdout, stderr, cwd}`.
  Runs in a Node-compatible shell: `node file.js`, `node -e "…"`, `npm install`,
  `pnpm`, `yarn`, `bun`, `bunx`, `npm run …`, `npx …`, `ls`, `cat`, `mkdir`,
  `echo`, pipes and redirects work.
  Output streams through `onData({stream: 'stdout'|'stderr', data})` and the
  `stdout`/`stderr` events while the promise is pending.
  `run('node server.js')` **resolves once the entry file is evaluated**, even
  if the program keeps a server listening — the server keeps serving while you
  keep running commands.
- `kernel.sendInput(text)` — stdin for a program that is reading (prompts, REPLs).
- `kernel.kill(pidOrPort?)` — sends a signal through the kernel.

### Preview Mounting & Inspection

- `kernel.mountPreview(iframe, { port, path, inspector })` → `{ port, path, inspector, reload, destroy }` —
  fetches HTML and local scripts/stylesheets from the virtual server on `port`,
  mounts a sandboxed `srcdoc` preview frame (`allow-scripts` + strict CSP),
  bridges virtual `fetch`/cookies/WebSocket/HMR over `MessageChannel`, and attaches
  a `PreviewInspector`.
- `BeownirKernel.PreviewInspector` / `kernel.createInspector()` — opt-in structured
  DOM/console/error/network/layout inspector (`attach`, `detach`, `ping`,
  `waitUntil`, `metrics`, `text`, `console`, `errors`, `networkFailures`, `query`,
  `dom`, `interactive`, `act`, `snapshot`, `destroy`) communicating via `MessageChannel`
  over both `srcdoc` previews and same-origin service-worker previews (`o/site/coi-sw.js`)
  without `eval`.

### Opt-in Runtime Profiler

- `kernel.startProfile(options)` / `kernel.getProfile()` / `kernel.stopProfile()` —
  zero-overhead-when-inactive profiler capturing host, frame-kernel, and worker spans
  (boot, gunzip, commands, npm installs, esbuild transforms, virtual HTTP, filesystem
  sync, worker/thread lifecycle) with per-span aggregates (`count`, `totalMs`, `minMs`,
  `maxMs`, `avgMs`, `p95Ms`).

### Host Bundler & Server Adapters

Zero-dependency ESM adapters ship in `o/embed/` and via `package.json` `exports`:

- `beownir/vite` (`o/embed/vite.mjs`) — `beownir(options)` Vite plugin adding COOP/COEP
  headers and serving `/__beownir__/beownir-kernel.js` and `/coi-sw.js` locally.
- `beownir/next` (`o/embed/next.mjs`) — `withBeownir(nextConfig, options)` /
  `getBeownirHeaders(options)` injecting Next.js `headers()` isolation rules.
- `beownir/server` (`o/embed/server.mjs`) — `createBeownirMiddleware(options)` for
  Express/Connect/Node HTTP and `createWebAssetResponse(request, options)` for Web Fetch handlers.

### Virtual HTTP

Programs listen on the kernel's in-page loopback. No real port is opened — a
browser cannot — but inside the kernel, `http.createServer().listen(5173)`
works, and the host page talks to it:

- `kernel.http('http://localhost:5173/path', {method, headers, body})` → `{status, headers, body, bytes}`
- `kernel.httpJson(url)` — same, parsed.
- `kernel.waitForServer(port, {path, timeoutMs, intervalMs})` — polls until a dev server answers; use it after `run('npm run dev')`-style commands.
- the `server` event fires `{port, listening}` when a program binds or unbinds a port.

### Events

`kernel.on(type, handler)` → unsubscribe function. Types: `stdout`, `stderr`,
`server`, `exit` (`{id, code, stdout, stderr}`), `files`, `state`, `error`,
`question`/`questionend` (a program is reading stdin), plus kernel messages
such as `pkgprogress` and `kernel-processes` passed through as-is.

### Probing

`BeownirKernel.capabilities()` reports `worker`, `blob`, `iframe`,
`webassembly`, `serviceWorker`, `crossOriginIsolated` — check it before
offering a Run button on an odd browser.

---

## What a dev-server integration looks like

```js
const kernel = BeownirKernel.create();
await kernel.whenReady();

await kernel.writeFile('package.json', JSON.stringify({
  name: 'demo', private: true, type: 'module',
  scripts: { dev: 'vite --port 5173' }, dependencies: { vite: '6.4.6' },
}, null, 2) + '\n');
await kernel.writeFile('index.html', '<h1 id="app">booting</h1><script type="module" src="/src/main.js"></script>');
await kernel.writeFile('src/main.js', "document.querySelector('#app').textContent = 'ready';\n");

await kernel.run('npm install');                 // streamed from registry.npmjs.org
kernel.run('npm run dev').catch(() => {});       // resolves when vite is up; vite keeps running
const response = await kernel.waitForServer(5173);
// response.body is the served HTML — render it in your own preview pane,
// rewrite asset URLs through kernel.http(), or just show the status.
```

If you want a live preview like the IDE's, you have two options: request each
asset with `kernel.http()` and build a `srcdoc` page from the bytes (the IDE's
approach — see `#previewBridgeSource` in `o/site/index.html`), or render only
data and keep your own DOM. There is no service worker in the embed; that part
of the IDE is not included.

---

## What you do NOT get

Stated as code, not as prose — each of these throws a **named error**, so your
UI can catch and explain it:

- **No raw TCP/UDP.** `net.Socket`, `dgram`, `tls` are not implemented as real
  sockets; they throw `ERR_VIRTUAL_OS`-family errors. Inside programs, network
  access is limited by the kernel's own policy to `https://registry.npmjs.org`
  (npm installs); other hosts are blocked by that CSP, not by reachability.
- **No native addons.** `require('*.node')` and `process.dlopen` throw
  `ENOSYS`. There is no native Node.js inside the page.
- **No real ports.** Nothing outside the page can connect to your "server",
  and it cannot bind on the visitor's machine. Only `kernel.http()` (and your
  code) can reach it.
- **No unknown binaries.** `python`, `git`, `make` are not present:
  `run('python …')` exits non-zero with `Unknown command: python` on stderr;
  spawning them from Node code fails with `ENOENT: No browser executable named …`.
- **No TLS as a server, no X.509 certificate parsing, no RSA-PSS.** RSA key
  pairs come from `crypto.subtle`; `generateKeyPairSync` throws with the
  reason. See `README.md → Node compatibility` for the measured crypto matrix.
- **Process limit: 8** including the shell. The ninth spawn fails with
  `EAGAIN: Virtual process limit reached`.
- **Virtual request bodies ≤ 1 MiB, responses ≤ 8 MiB** between your page and
  a virtual server.

For npm there are install budgets (64 MiB compressed / 256 MiB unpacked per
package, 512 MiB per graph) and a workspace budget (64 MiB / 20,000 entries by
default, override with the `limits` option). Exceeding them fails with `ENOSPC`
/ `EFBIG` messages, not a crash.

---

## Security model

- The kernel runs in a **sandboxed iframe (`allow-scripts` only)** — an opaque
  origin. Project code cannot reach your page's DOM, cookies, `localStorage`
  or `IndexedDB`; the only bridge is a private `MessagePort`.
- The iframe carries its own CSP (`script-src 'unsafe-inline' 'unsafe-eval'
  'wasm-unsafe-eval' blob:; worker-src blob:; connect-src
  https://registry.npmjs.org; …`). Because the iframe is sandboxed, it does
  **not** inherit your page's CSP, so a strict host policy does not break the
  kernel — and the kernel's policy is what constrains project code, not yours.
- **Your page's CSP does not need `unsafe-eval`.** The client code never
  evaluates anything in your page. On engines without `DecompressionStream`
  (Firefox < 113, Safari < 16.4) the esbuild wasm is gunzipped inside a second
  sandboxed iframe running the bundled pako — still outside your policy.
- `destroy()` terminates every Worker, timer and virtual server; nothing keeps
  running afterwards.

---

## Hosting requirements

- Serve `beownir-kernel.js` from any static host, same-origin with your page
  (a plain `<script src>`), or inline it — the bundle contains no raw
  `</script`, `<`, `>` or `&`, so it is safe to paste inside a `<script>`
  element.
- **Cross-origin isolation is not required.** COOP/COEP headers only unlock
  the IDE's WASIX profile; the embed boots and runs without them (that is how
  the E2E below is tested).
- `file://` works for the kernel itself, but npm installs need
  `https://registry.npmjs.org` reachable from the visitor's browser.

## Browser support

Same floor as the IDE: **Chrome 85+, Edge 85+, Firefox 79+, Safari 14+** —
enforced by a build-time scan (`npm run check` fails on any language feature
newer than the floor, the embed client included). What has actually been
**executed** here is headless Chromium: `npm run embed:e2e` runs the 16-check
suite below on every change we make. Firefox and Safari are covered by the
floor scan and the runtime's own differential suite against real Node, not by
a browser run in this repository's CI — no Firefox/WebKit binaries are
available in the sandbox that builds this.

## What is actually tested

`npm run embed:e2e` (needs `BEOWNIR_CHROMIUM` and `BEOWNIR_PLAYWRIGHT`)
serves a plain page that loads nothing but `beownir-kernel.js` and asserts,
in a real headless Chromium:

| # | check | measured |
|---|-------|----------|
| 1 | `window.BeownirKernel` exports a versioned, frozen API | v3.0.0-rc.6 |
| 2 | `capabilities()` reports worker + webassembly | yes |
| 3 | writes outside `/project`,`/tmp` throw `EPERM` | yes |
| 4 | boot to `ready` | 197 ms |
| 5 | `writeFile` creates nested directories | yes |
| 6 | `run('node …')` returns exit code + captured stdout | exit 0 |
| 7 | multi-file `require()` resolves | `UTIL=42` |
| 8 | `node -e` one-liner | `INLINE_OK` |
| 9 | unknown binary → named error, no hang | exit ≠ 0 |
| 10 | `npm install ms` from the real registry | 232 ms |
| 11 | installed package is requirable | `MS=172800000` |
| 12 | virtual dev server serves HTML + headers on :5173 | 200 `text/html` |
| 13 | more commands run while the server is up | still serving |
| 14 | program-written files sync back to the host | `out.txt === 'SYNCED'` |
| 15 | boots with `DecompressionStream` deleted (pako iframe fallback) | 356 ms |
| 16 | `destroy()` removes the frame and rejects commands | yes |

The last full run: **16/16 PASS** on headless Chromium. `test/embed.test.mjs`
(additionally part of `npm test`) pins the bundle against the application
sources, verifies it parses and evaluates, and asserts the API surface and the
documented limits.

---

## Rebuilding

```
npm run embed:build    # regenerate o/embed/beownir-kernel.js
npm run embed:check    # fail when the committed bundle is stale
npm run embed:e2e      # the browser suite above
```

`npm run check` also verifies freshness and that the client code respects the
browser floor, so a stale or floor-breaking embed cannot pass a release.
Editing the generated file is pointless — regenerate it from
`o/embed/beownir-kernel-api.template.js` and the application's embedded
sources.
