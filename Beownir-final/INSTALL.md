# Installing and launching Beownir

Three supported ways to run the same product. They differ in what the browser
will allow, not in what the IDE is.

| Path | Isolation | Service worker | Host bridge | Native WASM profile |
| --- | --- | --- | --- | --- |
| A. Open `beownir-standalone.html` | no | no | no | no (reported in Diagnostics) |
| B. Static deploy of the file | yes, if the server sends COOP/COEP | yes | no | no |
| C. `npm run host` | yes | yes | yes | yes, when the runtime origin is reachable |

## Requirements

- **Browser**: a current Chromium-based browser (Chrome/Edge 120 or newer).
  Firefox and Safari work for the editor, the virtual runtime and npm installs,
  but the native browser-WASM profile needs `SharedArrayBuffer` + JSPI, which
  they do not ship.
- **Node.js**: 22 LTS for the tooling, tests and host (`engines: >=18.17`,
  but the test suite and the hashes in the reports were produced on 22.22.3).
  Nothing in the browser needs Node.
- **Disk**: the artifact is about 9.04 MiB.

## A. Open the single file

```bash
git clone <repository> && cd Bioneeer9
node tools/build-standalone.mjs          # writes ./beownir-standalone.html
# then open beownir-standalone.html in your browser (file:// is fine)
```

`file://` cannot be cross-origin isolated (no `COOP`/`COEP` headers), cannot
register a service worker, and cannot reach the host. The IDE detects this and
reports it under **Help → Diagnostics** instead of pretending. Everything else
works: editor, terminal, virtual filesystem, npm installs, preview.

## B. Static deploy (isolation + offline shell)

```bash
node tools/build-standalone.mjs --out o/site/index.html   # or keep both files
npm run serve:static                                      # http://127.0.0.1:8080
```

`netlify.toml` already publishes `o/site` with:

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

### Netlify

`netlify.toml` publishes `o/site`, sends the headers, pins Node 22, and runs a
build command that **only verifies** (`deploy-files` + `build-standalone --check`)
so a stale artifact fails the deploy instead of shipping.

Two ways to publish:

```bash
# 1. from this checkout
npx netlify-cli@17 deploy --prod --dir o/site

# 2. connect the repository in the Netlify UI (build command comes from the TOML)
```

For deploys from GitHub Actions, add two repository secrets —
`NETLIFY_AUTH_TOKEN` (User settings → Applications) and `NETLIFY_SITE_ID`
(Site configuration → Site information). `.github/workflows/deploy.yml` then
verifies, deploys `o/site`, and runs `deploy:check` against the live URL. Without
the secrets that job skips with a notice and the verify job still runs.

### Cloudflare Pages

Cloudflare reads a `_headers` file from the output directory, not `netlify.toml`.
`o/site/_headers` is generated from `netlify.toml` by `node tools/deploy-files.mjs`
(checked in CI), so the two cannot disagree.

| Setting | Value |
| --- | --- |
| Build command | `node tools/deploy-files.mjs` (verify the header file is current) |
| Build output directory | `o/site` |
| Node version | 22 (`NODE_VERSION=22`) |

`node tools/build-standalone.mjs --check` in the same build command fails the
deploy if the committed artifact is stale, which is the cheapest possible guard
against shipping an old copy of a 9 MiB file.

### Anything else

Any host that can send those two headers works (Nginx `add_header`, S3 +
CloudFront response headers, GitHub Pages behind a worker). With them the page
becomes cross-origin isolated; `coi-sw.js` is served next to the HTML, so the
service worker registers and the app installs as an offline shell.

### After deploying

```bash
npm run deploy:check -- --ide https://your-site.example/
```

It fetches the live page and asserts: 200, COOP/COEP present, no external asset
dependencies, `coi-sw.js` served, and — when the page carries a build manifest —
that the deployed document digest equals the artifact in this checkout. That last
check is what tells you the file users get is the file you verified.

## C. The three-origin host (network bridge + native profile)

```bash
npm run host        # 4173 IDE, 4174 runtime origin, 4175 preview origin
```

Open `http://localhost:4173`. The host provides what a page cannot:

- a **real TCP relay** for preview servers (`/tcp/`), with capability tokens
  and origin checks, so `http.Server` inside the runtime is reachable from a
  browser tab;
- a **separate runtime origin**, which is what makes the native browser-WASM
  profile possible (the Node distribution in `o/native/` runs there);
- **COOP/COEP on every response**, so SharedArrayBuffer stays available.

The host binds to `127.0.0.1` by default. For a trusted LAN/reverse-proxy
setup, explicitly opt in with `BEOWNIR_BIND=0.0.0.0 PORT=8080 npm run host`.
This exposes all three ports to the network; do not use it on an untrusted
network or public interface without a separately secured reverse proxy.

## First project

1. **Ctrl/Cmd + K** opens the command palette; **New project** offers the
   templates in `o/fixtures/`.
2. In the terminal: `npm install lodash` (streamed, SHA-512 verified, resumable).
3. Start something:

```
node -e "require('http').createServer((q,s)=>s.end('hi')).listen(3000)"
```

Open the preview panel: the virtual loopback answers. With the host running, the
same server is also reachable from another browser tab through the preview
origin.

## Verifying a download

Every artifact carries a manifest of itself:

```bash
node tools/build-standalone.mjs --check        # stale or tampered artifact fails
node tools/standalone-smoke.mjs beownir-standalone.html   # boots it, runs commands
sha256sum beownir-standalone.html              # compare with the build report
```

In the app, **Help → Diagnostics** shows the runtime version, the isolation
status, whether the host is reachable and which storage backend is active.

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| Diagnostics says "not cross-origin isolated" | served without COOP/COEP, or opened as `file://` | use path B or C |
| Preview shows "your browser runtime is not connected" | preview opened without the host, or the server stopped | start the server; use the in-IDE preview |
| `WebAssembly.Memory: could not allocate` | the native profile needs more memory than the tab allows | close tabs, or stay on the limited engine |
| `quota exceeded` when installing | origin quota reached | delete `node_modules`, or raise the budget in Settings |
| Install fails with `EINTEGRITY` | registry returned bytes that do not match `dist.integrity` | retry; the transaction rolled back and nothing partial was kept |
| Service worker does not register | `file://`, or the HTML is served without `coi-sw.js` next to it | use a server (path B) |
