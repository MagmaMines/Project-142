#!/usr/bin/env node
/* Checks a deployed Beownir from the outside and names exactly what fails.
 *
 * Single-file deploy (Netlify, Cloudflare Pages, any static host):
 *   node o/deploy/check.mjs --ide https://your-site.netlify.app/
 *
 * Three-origin deploy (the Node host: IDE + isolated runtime + preview):
 *   node o/deploy/check.mjs --ide https://ide.example \
 *                           --runtime https://runtime.example --preview https://preview.example
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

let failures = 0;
const out = (ok, label, detail = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  -- ' + detail : ''}`); };
const note = (label, detail = '') => console.log(`INFO  ${label}${detail ? '  -- ' + detail : ''}`);

const argv = process.argv.slice(2);
const arg = name => { const i = argv.indexOf('--' + name); return i >= 0 ? argv[i + 1] : undefined; };
const ide = arg('ide'), runtime = arg('runtime'), preview = arg('preview');
if (!ide) { console.error('usage: --ide <page url> [--runtime <origin> --preview <origin>]'); process.exit(2); }
if (Boolean(runtime) !== Boolean(preview)) { console.error('--runtime and --preview go together'); process.exit(2); }

const timeoutFetch = (url, opts = {}) => fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(20000), ...opts });
const origin = value => new URL(value).origin;
const here = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

let idePage;
try { idePage = await timeoutFetch(ide); }
catch (error) { out(false, 'IDE page reachable', String(error.message || error)); process.exit(1); }

out(idePage.status === 200, 'IDE page returns 200', 'status ' + idePage.status);
if (idePage.status === 301 || idePage.status === 302) {
  note('redirect', idePage.headers.get('location') || '(no location)');
}
const coop = idePage.headers.get('cross-origin-opener-policy');
const coep = idePage.headers.get('cross-origin-embedder-policy');
const perms = idePage.headers.get('permissions-policy') || '';
out(coop === 'same-origin', 'Page sends Cross-Origin-Opener-Policy: same-origin', 'got ' + coop);
out(coep === 'require-corp' || coep === 'credentialless', 'Page sends a cross-origin isolating COEP', 'got ' + coep);
out(/-ORIGIN-HERE/.test(perms) === false, 'No placeholder origins in the deployed headers');

const body = await idePage.text();
const title = body.match(/<title>([^<]*)<\/title>/)?.[1] || '';
const localVersion = JSON.parse(fs.readFileSync(path.join(here, 'package.json'), 'utf8')).version;
// The title spells the release "Beownir 3.0 RC.5"; package.json says 3.0.0-rc.5.
const versionInTitle = (() => {
  const match = title.match(/(\d+)\.(\d+)(?:\.(\d+))?(?:\s*RC\.(\d+))?/i);
  if (!match) return null;
  const [, major, minor, patch, rc] = match;
  return rc ? major + '.' + minor + '.' + (patch || 0) + '-rc.' + rc : major + '.' + minor + '.' + (patch || 0);
})();
note('Deployed page', title ? '"' + title + '"' : '(no title)');
if (versionInTitle) {
  out(versionInTitle === localVersion, 'Deployed page is the version in this checkout', 'page ' + versionInTitle + ', package.json ' + localVersion);
}
out(body.length > 1_000_000, 'Page carries the embedded runtime, not a placeholder', (body.length / 1024 / 1024).toFixed(2) + ' MiB');

/* The release artifact describes itself. When the deployed page carries that
 * manifest, it must be the same build this checkout produced — otherwise the
 * deploy is some other copy of the file and the hashes in the reports do not
 * describe what users are running. */
const manifestText = /<script id="beownir-build-manifest" type="application\/json">([\s\S]*?)<\/script>/.exec(body)?.[1];
const localArtifact = path.join(here, 'beownir-standalone.html');
if (!manifestText) {
  note('Deployed page has no build manifest', 'it is the source HTML, not the verified artifact: run `node tools/build-standalone.mjs` and deploy o/site');
} else {
  let manifest = null;
  try { manifest = JSON.parse(manifestText); } catch (error) { out(false, 'Build manifest is valid JSON', String(error.message || error)); }
  if (manifest) {
    out(manifest.format === 'beownir-standalone/1', 'Build manifest has the expected format', String(manifest.format));
    out(manifest.version === localVersion, 'Build manifest version matches this checkout', 'page ' + manifest.version + ', checkout ' + localVersion);
    note('Embedded document', manifest.counts.sources + ' sources, ' + manifest.counts.assets + ' native assets');
    if (fs.existsSync(localArtifact)) {
      const local = /<script id="beownir-build-manifest" type="application\/json">([\s\S]*?)<\/script>/.exec(fs.readFileSync(localArtifact, 'utf8'))?.[1];
      let localManifest = null;
      try { localManifest = local ? JSON.parse(local) : null; } catch { localManifest = null; }
      if (localManifest) {
        out(localManifest.document.sha256 === manifest.document.sha256,
          'Deployed document digest matches the local artifact',
          'deployed ' + String(manifest.document.sha256).slice(0, 16) + ', local ' + String(localManifest.document.sha256).slice(0, 16));
        out(localManifest.document.bytes === manifest.document.bytes, 'Deployed document has the same byte length as the local artifact');
      } else {
        note('Local artifact has no readable manifest', 'skipped the digest comparison');
      }
    } else {
      note('No local artifact to compare against', localArtifact);
    }
  }
}

// A single-file deploy must not depend on external assets or a second origin.
const external = [...body.matchAll(/<(?:script|link|img)\b[^>]*\b(?:src|href)="(https?:)?\/\/([^"]+)"/g)]
  .map(match => match[2]).filter(host => !host.startsWith('${'));
out(external.length === 0, 'No external script/style/image dependencies', external.slice(0, 3).join(', '));

const meta = body.match(/<meta name="beownir-origins" content="([^"]*)">/)?.[1];
out(meta !== undefined, 'Origin meta tag present in the deployed HTML');

if (!runtime && !preview) {
  // ---- single-origin / single-file mode ----
  out(meta === '', 'Single-file mode: no external origins are configured', 'meta content: "' + (meta ?? '') + '"');
  const isolationFromWorker = /coi-sw\.js/.test(body);
  out(Boolean(coop && coep) || isolationFromWorker, 'Cross-origin isolation comes from headers or the shipped service worker',
    coop && coep ? 'headers' : isolationFromWorker ? 'service worker' : 'missing both');

  const workerUrl = new URL('coi-sw.js', ide).href;
  let worker;
  try { worker = await timeoutFetch(workerUrl); } catch (error) { worker = null; note('worker fetch failed', String(error.message || error)); }
  out(Boolean(worker && worker.status === 200), 'coi-sw.js is served next to the page', worker ? 'status ' + worker.status : 'unreachable');
  if (worker && worker.status === 200) {
    out(worker.headers.get('service-worker-allowed') === '/' || worker.headers.get('service-worker-allowed') === null,
      'coi-sw.js may control the whole origin', 'Service-Worker-Allowed: ' + (worker.headers.get('service-worker-allowed') ?? '(default scope)'));
    const sw = await worker.text();
    out(/Cross-Origin-Embedder-Policy/.test(sw), 'Service worker really sets COEP');
  }
} else {
  // ---- three-origin mode ----
  const allow = perms.match(/cross-origin-isolated=\(([^)]*)\)/)?.[1] || (/cross-origin-isolated=\*/.test(perms) ? '"' + origin(runtime) + '" "' + origin(preview) + '"' : '');
  out(allow.includes('"' + origin(runtime) + '"'), 'Permissions-Policy allows the runtime origin', allow ? 'allowlist: ' + allow : 'no cross-origin-isolated allowlist');
  out(allow.includes('"' + origin(preview) + '"'), 'Permissions-Policy allows the preview origin');
  let hostConfig = null;
  const injectedConfig = /window\.__BEOWNIR_HOST__=(\{[^;]+\});/.exec(body)?.[1];
  if (injectedConfig) {
    try { hostConfig = JSON.parse(injectedConfig); } catch {}
  }
  const metaMatches = !!meta && meta.includes('runtime=' + origin(runtime)) && meta.includes('preview=' + origin(preview));
  const hostMatches = hostConfig?.runtimeOrigin === origin(runtime) && hostConfig?.previewOrigin === origin(preview);
  out(metaMatches || hostMatches, 'Runtime and preview origins match the deployment', hostMatches ? 'host-injected origin config' : 'meta content: "' + (meta ?? '') + '"');

  let rt;
  try { rt = await timeoutFetch(origin(runtime) + '/'); } catch (error) { out(false, 'Runtime host reachable', String(error.message || error)); }
  if (rt) {
    out(rt.status === 200, 'Runtime host returns 200', 'status ' + rt.status);
    out(rt.headers.get('cross-origin-resource-policy') === 'cross-origin', 'Runtime sends Cross-Origin-Resource-Policy: cross-origin');
    out(rt.headers.get('cross-origin-embedder-policy') !== null, 'Runtime sends a COEP header');
  }
  try { const pv = await timeoutFetch(origin(preview) + '/'); out(pv.status > 0, 'Preview host reachable', 'status ' + pv.status); }
  catch (error) { out(false, 'Preview host reachable', String(error.message || error)); }
}

console.log(failures ? `\n${failures} check(s) failed. Fix the first FAIL above; the later ones may follow from it.` : '\nAll server-side checks passed. Open the page and confirm the terminal prints `node -v`.');
process.exit(failures ? 1 : 0);
