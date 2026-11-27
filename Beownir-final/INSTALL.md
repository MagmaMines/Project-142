# Installing and launching Beownir

Two pure-browser ways to run the exact same single-file IDE — no project server or three-origin host required.

| Path | Isolation (`SharedArrayBuffer`) | Service worker | Preview / offline shell |
| --- | --- | --- | --- |
| A. Open `beownir-standalone.html` (`file://`) | no | no | In-page `srcdoc` preview; virtual fallback threads |
| B. Static deploy / `npm run serve:static` | yes (via COOP/COEP headers or `coi-sw.js`) | yes | Cross-tab `/__beownir_preview__/` + HMR + offline shell |

## Requirements

- **Browser**: Chrome/Edge 85+, Firefox 79+, or Safari 14+ (tested primarily on Chromium).
- **Node.js**: 18.17+ (22 LTS recommended) for local tooling, tests, and static dev server (`npm run serve:static`). Nothing in the browser needs Node.

## A. Open the single file

```bash
git clone <repository> && cd Project-142/Beownir-final
node tools/build-standalone.mjs          # writes ./beownir-standalone.html
# then open beownir-standalone.html in your browser (file:// is fine)
```

`file://` cannot be cross-origin isolated (no `COOP`/`COEP` headers) and cannot register a service worker. Everything else works completely inside the browser tab: editor, terminal, virtual filesystem, concurrent npm installs, and sandboxed preview.

## B. Static deploy (isolation + offline shell + SW preview)

```bash
node tools/build-standalone.mjs --out o/site/index.html
npm run serve:static                                      # http://127.0.0.1:8080
```

`netlify.toml` publishes `o/site` with `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp`, while `coi-sw.js` provides isolation headers, offline caching, and `/__beownir_preview__/` cross-tab preview on any static HTTPS host (GitHub Pages, Cloudflare Pages, Netlify, Nginx, S3).

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| Help → This device says "not cross-origin isolated" | served without COOP/COEP, or opened as `file://` | serve via `npm run serve:static` or static host with `coi-sw.js` |
| `quota exceeded` when installing | origin quota reached | run `storage gc` in terminal, or raise budget / export backup |
| Install fails with `EINTEGRITY` | registry returned bytes that do not match `dist.integrity` | retry; the transaction rolled back and nothing partial was kept |
| Service worker does not register | `file://`, or the HTML is served without `coi-sw.js` next to it | use a server (path B) |
