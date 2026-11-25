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
  assert.ok(manifest.sources.length > 10, 'sources are listed');
  assert.ok(manifest.assets.length > 0, 'native assets are listed');
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

test('the three-origin configure step keeps the artifact verifiable', async () => {
  const { execFileSync } = await import('node:child_process');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beownir-configure-'));
  try {
    fs.mkdirSync(path.join(dir, 'deploy'));
    fs.mkdirSync(path.join(dir, 'site'));
    fs.copyFileSync(path.join(root, 'o', 'deploy', 'configure.mjs'), path.join(dir, 'deploy', 'configure.mjs'));
    fs.copyFileSync(path.join(deployDir, 'index.html'), path.join(dir, 'site', 'index.html'));
    fs.copyFileSync(path.join(deployDir, '_headers'), path.join(dir, 'site', '_headers'));
    fs.copyFileSync(configFile, path.join(dir, 'netlify.toml'));
    execFileSync(process.execPath, ['deploy/configure.mjs', '--runtime', 'https://runtime.example.com', '--preview', 'https://preview.example.com'], { cwd: dir, stdio: 'pipe' });

    const patched = fs.readFileSync(path.join(dir, 'site', 'index.html'), 'utf8');
    assert.match(patched, /runtime=https:\/\/runtime\.example\.com;preview=https:\/\/preview\.example\.com/);
    assert.deepEqual(verifyArtifact(patched).problems, [], 'the patched page still verifies against its own manifest');
    const headers = fs.readFileSync(path.join(dir, 'site', '_headers'), 'utf8');
    assert.match(headers, /cross-origin-isolated=\(self "https:\/\/runtime\.example\.com" "https:\/\/preview\.example\.com"\)/);

    // Multi-block files (e.g. both /* and a sub-path) must have every allowlist updated.
    const extraToml = fs.readFileSync(configFile, 'utf8') + '\n[[headers]]\n  for = "/alt/*"\n  [headers.values]\n    Permissions-Policy = \'cross-origin-isolated=*\'\n';
    const extraHeaders = fs.readFileSync(path.join(deployDir, '_headers'), 'utf8') + '\n/alt/*\n  Permissions-Policy: cross-origin-isolated=*\n';
    fs.writeFileSync(path.join(dir, 'netlify.toml'), extraToml);
    fs.writeFileSync(path.join(dir, 'site', '_headers'), extraHeaders);
    execFileSync(process.execPath, ['deploy/configure.mjs', '--runtime', 'https://rt.example.com', '--preview', 'https://pv.example.com'], { cwd: dir, stdio: 'pipe' });
    const re = /cross-origin-isolated=\(self "https:\/\/rt\.example\.com" "https:\/\/pv\.example\.com"\)/g;
    assert.equal((fs.readFileSync(path.join(dir, 'netlify.toml'), 'utf8').match(re) || []).length, 2, 'every block in netlify.toml is updated');
    assert.equal((fs.readFileSync(path.join(dir, 'site', '_headers'), 'utf8').match(re) || []).length, 2, 'every block in _headers is updated');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
