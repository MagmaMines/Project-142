#!/usr/bin/env node
// Writes your real origins into every place the deployment needs them.
// Usage:
//   node deploy/configure.mjs --runtime https://runtime.yourdomain --preview https://preview.yourdomain
// Idempotent: re-running with new origins replaces the previous values.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const arg = (name) => { const i = argv.indexOf('--' + name); return i >= 0 ? argv[i + 1] : undefined; };

function bareOrigin(name, value) {
  if (!value) throw new Error(`missing --${name}`);
  let u;
  try { u = new URL(value); } catch { throw new Error(`--${name} is not a URL: ${value}`); }
  const local = u.hostname === 'localhost' || u.hostname === '127.0.0.1';
  if (u.protocol !== 'https:' && !(local && u.protocol === 'http:')) throw new Error(`--${name} must use https (http is allowed only for localhost)`);
  if (u.pathname !== '/' || u.search || u.hash || u.username || u.password) throw new Error(`--${name} must be a bare origin like https://runtime.example.com`);
  return u.origin;
}

const runtime = bareOrigin('runtime', arg('runtime'));
const preview = bareOrigin('preview', arg('preview'));
if (runtime === preview) throw new Error('runtime and preview must be different origins');

const htmlPath = path.join(root, 'site', 'index.html');
const tomlPath = path.join(root, 'netlify.toml');

let html = fs.readFileSync(htmlPath, 'utf8');
const metaRe = /<meta name="beownir-origins" content="[^"]*">/;
if (!metaRe.test(html)) throw new Error('origin meta tag not found in the HTML; is this the patched file?');
html = html.replace(metaRe, `<meta name="beownir-origins" content="runtime=${runtime};preview=${preview}">`);

/* Patching the document invalidates the build manifest that describes it. The
 * manifest is what `o/deploy/check.mjs` compares against the local artifact, so
 * leaving it stale would make a correct deploy look tampered with. Recompute the
 * document digest the same way the builder does: normalise the manifest block to
 * empty, hash that, and rebuild the block around the same JSON. */
const MANIFEST_OPEN = '<script id="beownir-build-manifest" type="application/json">';
const MANIFEST_CLOSE = '</script>';
function restampManifest(source) {
  const open = source.indexOf(MANIFEST_OPEN);
  if (open < 0) return { html: source, restamped: false };
  const start = open + MANIFEST_OPEN.length;
  const end = source.indexOf(MANIFEST_CLOSE, start);
  if (end < 0) throw new Error('the build manifest block is not closed');
  const manifest = JSON.parse(source.slice(start, end));
  /* `head` ends with the opening tag, `tail` begins with the closing tag: their
   * concatenation is the document with an empty manifest block, which is exactly
   * what the builder hashes. */
  const head = source.slice(0, start);
  const tail = source.slice(end);
  const normalized = head + tail;
  manifest.document = {
    sha256: crypto.createHash('sha256').update(normalized).digest('hex'),
    bytes: Buffer.byteLength(normalized, 'utf8'),
  };
  return { html: head + JSON.stringify(manifest) + tail, restamped: true };
}
const stamped = restampManifest(html);
html = stamped.html;
fs.writeFileSync(htmlPath, html);

let toml = fs.readFileSync(tomlPath, 'utf8');
const permsRe = /cross-origin-isolated=(\([^)]*\)|\*)/;
if (!permsRe.test(toml)) throw new Error('cross-origin-isolated allowlist not found in netlify.toml');
toml = toml.replace(permsRe, `cross-origin-isolated=(self "${runtime}" "${preview}")`);
fs.writeFileSync(tomlPath, toml);

/* Cloudflare Pages and other static hosts read the generated _headers file
 * instead of netlify.toml, so it has to carry the same allowlist. */
const headersPath = path.join(root, 'site', '_headers');
if (fs.existsSync(headersPath)) {
  const headers = fs.readFileSync(headersPath, 'utf8').replace(permsRe, `cross-origin-isolated=(self "${runtime}" "${preview}")`);
  fs.writeFileSync(headersPath, headers);
}

console.log('configured');
console.log('  runtime origin :', runtime);
console.log('  preview origin :', preview);
console.log('  site meta      : runtime=' + runtime + ';preview=' + preview);
console.log('  netlify.toml   : Permissions-Policy allowlist updated');
console.log('  site/_headers  : ' + (fs.existsSync(path.join(root, 'site', '_headers')) ? 'Permissions-Policy allowlist updated' : 'not present'));
console.log('  build manifest : ' + (stamped.restamped ? 'document digest restamped' : 'not present (not a release artifact)'));
console.log('next: deploy the zip root to Netlify, and run the host with the same origins plus your IDE URL');
