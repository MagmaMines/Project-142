/**
 * What a host actually publishes must be the thing that was verified.
 *
 * These tests exist because the failure mode is silent: a static host happily
 * serves a stale copy of a 9 MiB HTML file, and nothing on the page complains.
 * They assert three things:
 *
 *   1. the publish directory is byte-identical to the release artifact;
 *   2. the artifact in the publish directory passes its own verification;
 *   3. `_headers` (what Cloudflare Pages and other static hosts read) matches
 *      `netlify.toml` (what Netlify reads), so isolation cannot be lost by
 *      choosing a different host.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyArtifact, readManifest, root } from '../tools/build-standalone.mjs';
import { checkHeaders, renderHeaders, writeHeaders, expected } from '../tools/deploy-files.mjs';
import { parseConfig, headersFor, configFile } from '../tools/serve-static.mjs';

const deployDir = path.join(root, 'o', 'site');
const artifact = path.join(root, 'beownir-standalone.html');
const page = fs.readFileSync(path.join(deployDir, 'index.html'), 'utf8');

test('the publish directory ships the verified artifact, byte for byte', () => {
  const published = fs.readFileSync(path.join(deployDir, 'index.html'));
  const release = fs.readFileSync(artifact);
  assert.equal(published.length, release.length, 'publish size equals artifact size');
  assert.ok(published.equals(release), 'o/site/index.html is the artifact (rebuild and re-copy if this fails)');
});

test('the published page passes its own manifest verification', () => {
  const { problems, manifest } = verifyArtifact(page);
  assert.deepEqual(problems, []);
  assert.ok(manifest, 'the published page carries a build manifest');
  assert.equal(manifest.format, 'beownir-standalone/1');
  assert.ok(manifest.sources.length >= 6, 'sources are listed');
  assert.deepEqual(manifest.assets, [], 'no WASIX asset packs are listed');
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.equal(manifest.version, pkg.version, 'manifest version matches package.json');
  // The page's own <title> is what the deploy checker compares, so it has to
  // agree too.
  const title = /<title>([^<]*)<\/title>/.exec(page)?.[1] || '';
  const digits = manifest.version.replace(/^(\d+)\.(\d+)\.(\d+)(?:-rc\.(\d+))?$/, '$1.$2 RC.$4');
  assert.match(title, new RegExp(digits.replace(/\./g, '\\.')), 'title spells the manifest version');
});

test('_headers is generated from netlify.toml and stays current', () => {
  assert.deepEqual(checkHeaders(), []);
  const file = fs.readFileSync(path.join(deployDir, '_headers'), 'utf8');
  const config = parseConfig(fs.readFileSync(configFile, 'utf8'));
  for (const [name, value] of Object.entries(headersFor(config, '/'))) {
    assert.ok(file.includes(name + ': ' + value), '_headers carries ' + name);
  }
  assert.match(file, /^\/\*$/m, 'the wildcard block is present');
  assert.match(file, /^\/coi-sw\.js$/m, 'the service worker has its own scope block');
});

test('a tampered or missing _headers file is detected', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beownir-headers-'));
  try {
    const file = path.join(dir, '_headers');
    assert.match(checkHeaders(file).join('\n'), /missing/, 'a missing file is reported');
    fs.writeFileSync(file, expected().replace('require-corp', 'unsafe-none'));
    const problems = checkHeaders(file).join('\n');
    assert.match(problems, /differs from netlify\.toml/, 'a wrong header is reported');
    assert.match(problems, /require-corp/, 'the report names the expected value');
    writeHeaders(file);
    assert.deepEqual(checkHeaders(file), [], 'writing fixes it');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('renderHeaders refuses a header block with no values', () => {
  assert.throws(() => renderHeaders({ headers: [{ for: '/*', values: {} }] }), /no values/);
});

test('the manifest excludes the document itself', () => {
  const manifest = readManifest(page);
  const relative = path.relative(root, path.join(deployDir, 'index.html')).split(path.sep).join('/');
  assert.equal(manifest.sources.some(entry => entry.file === relative), false, 'the document is not listed as its own source');
  assert.ok(manifest.document.sha256, 'the document digest is recorded separately');
});
