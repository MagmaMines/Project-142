import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const siteDir = path.join(root, 'o', 'site');
const appPath = path.join(siteDir, 'index.html');

const run = (args, options = {}) => spawnSync(process.execPath, args, { cwd: root, encoding: 'utf8', ...options });

test('the embedded host and install kit match their source files', () => {
  const result = run(['tools/sync-embedded.mjs', '--check']);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /up to date/);
});

test('static checks pass on the single-file app', { timeout: 120000 }, () => {
  const result = run(['tools/check.mjs', '--skip-assets']);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /all checks passed/);
  assert.match(result.stdout, /script blocks parse/);
  assert.match(result.stdout, /element lookups resolve/);
});

test('package metadata advertises a supported Node range and the documented scripts', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.ok(pkg.private, 'the app is not published to npm');
  assert.match(pkg.engines.node, />=\s*18/);
  for (const script of ['test', 'check', 'sync', 'verify', 'host']) assert.ok(pkg.scripts[script], 'missing script ' + script);
  assert.match(pkg.scripts.test, /node --test/);
});

test('release candidate packaging includes integrity and explicit commercial blockers', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'beownir-candidate-'));
  try {
    const out = path.join(temp, 'bundle');
    const result = run(['tools/package-release.mjs', out]);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const status = fs.readFileSync(path.join(out, 'CANDIDATE-STATUS.txt'), 'utf8');
    assert.match(status, /NOT CLEARED FOR COMMERCIAL DISTRIBUTION/);
    assert.match(status, /native Node\/WASIX acceptance gates/);
    const artifact = fs.readFileSync(path.join(out, 'beownir-standalone.html'));
    const expected = fs.readFileSync(path.join(root, 'beownir-standalone.html'));
    assert.deepEqual(artifact, expected);
    const checksum = fs.readFileSync(path.join(out, 'SHA256SUMS'), 'utf8');
    assert.match(checksum, /^[a-f0-9]{64}  beownir-standalone\.html\n$/);
  } finally { fs.rmSync(temp, {recursive:true, force:true}); }
});

test('deployment configuration points at files that exist', () => {
  const toml = fs.readFileSync(path.join(root, 'o', 'netlify.toml'), 'utf8');
  const publish = /publish\s*=\s*"([^"]+)"/.exec(toml)?.[1];
  assert.ok(publish, 'netlify.toml declares a publish directory');
  assert.ok(fs.existsSync(path.join(root, 'o', publish)), 'publish directory exists: ' + publish);
  const redirectTargets = [...toml.matchAll(/to\s*=\s*"([^"]+)"/g)].map(match => match[1]);
  for (const target of redirectTargets) {
    assert.ok(fs.existsSync(path.join(root, 'o', publish, target.replace(/^\//, ''))), 'redirect target exists: ' + target);
  }
  assert.ok(toml.includes('Cross-Origin-Opener-Policy'), 'COOP header is configured');
  assert.ok(toml.includes('Cross-Origin-Embedder-Policy'), 'COEP header is configured');

  const configure = fs.readFileSync(path.join(root, 'o', 'deploy', 'configure.mjs'), 'utf8');
  const htmlPath = /path\.join\(root, 'site', '([^']+)'\)/.exec(configure)?.[1];
  assert.ok(htmlPath, 'configure.mjs targets the site HTML');
  assert.ok(fs.existsSync(path.join(siteDir, htmlPath)), 'configure.mjs target exists: ' + htmlPath);

  const hostScript = fs.readFileSync(path.join(root, 'o', 'host', 'run-host.sh'), 'utf8');
  assert.ok(!/beownir-standalone-production\.html/.test(hostScript), 'run-host.sh must not reference a missing artifact');
  assert.match(hostScript, /site\/index\.html/);
  assert.ok(!/Node 22\+/.test(hostScript), 'run-host.sh documents the real Node floor');
});

test('configure.mjs writes the deployment origins into a copy of the site', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'beownir-deploy-'));
  try {
    fs.mkdirSync(path.join(temp, 'site'), { recursive: true });
    fs.mkdirSync(path.join(temp, 'deploy'), { recursive: true });
    fs.copyFileSync(appPath, path.join(temp, 'site', 'index.html'));
    fs.copyFileSync(path.join(root, 'o', 'netlify.toml'), path.join(temp, 'netlify.toml'));
    fs.copyFileSync(path.join(root, 'o', 'deploy', 'configure.mjs'), path.join(temp, 'deploy', 'configure.mjs'));
    const result = run(['deploy/configure.mjs', '--runtime', 'https://runtime.example.com', '--preview', 'https://preview.example.com'], { cwd: temp });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const html = fs.readFileSync(path.join(temp, 'site', 'index.html'), 'utf8');
    assert.match(html, /<meta name="beownir-origins" content="runtime=https:\/\/runtime\.example\.com;preview=https:\/\/preview\.example\.com">/);
    const toml = fs.readFileSync(path.join(temp, 'netlify.toml'), 'utf8');
    assert.match(toml, /cross-origin-isolated=\(self "https:\/\/runtime\.example\.com" "https:\/\/preview\.example\.com"\)/);

    const again = run(['deploy/configure.mjs', '--runtime', 'https://rt2.example.com', '--preview', 'https://pv2.example.com'], { cwd: temp });
    assert.equal(again.status, 0, 'configure is idempotent');
    assert.match(fs.readFileSync(path.join(temp, 'site', 'index.html'), 'utf8'), /runtime=https:\/\/rt2\.example\.com/);

    const same = run(['deploy/configure.mjs', '--runtime', 'https://same.example.com', '--preview', 'https://same.example.com'], { cwd: temp });
    assert.notEqual(same.status, 0, 'runtime and preview origins must differ');
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('the checked-in deployment metadata has no placeholder origins left behind', () => {
  const html = fs.readFileSync(appPath, 'utf8');
  assert.ok(html.includes('<meta name="beownir-origins"'), 'origin meta tag exists');
  const toml = fs.readFileSync(path.join(root, 'o', 'netlify.toml'), 'utf8');
  assert.ok(!/-ORIGIN-HERE/.test(toml), 'no placeholder in netlify.toml headers');
  assert.ok(html.length > 8 * 1024 * 1024, 'the single file is complete: ' + html.length);
});
