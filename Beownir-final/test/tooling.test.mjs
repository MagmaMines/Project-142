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
  for (const script of ['test', 'check', 'sync', 'verify', 'serve:static']) assert.ok(pkg.scripts[script], 'missing script ' + script);
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
    assert.match(status, /browser compatibility sign-off/);
    const artifact = fs.readFileSync(path.join(out, 'beownir-standalone.html'));
    const expected = fs.readFileSync(path.join(root, 'beownir-standalone.html'));
    assert.deepEqual(artifact, expected);
    /* The embed client ships in the same candidate: a host page needs the one
     * file, and the bundle proves it is the verified build. */
    const embed = fs.readFileSync(path.join(out, 'beownir-kernel.js'));
    const expectedEmbed = fs.readFileSync(path.join(root, 'o', 'embed', 'beownir-kernel.js'));
    assert.deepEqual(embed, expectedEmbed);
    const checksum = fs.readFileSync(path.join(out, 'SHA256SUMS'), 'utf8');
    assert.match(checksum, /^[a-f0-9]{64}  beownir-standalone\.html\n[a-f0-9]{64}  beownir-kernel\.js\n$/);
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
});

test('the checked-in single-file deployment artifact has no stale origin placeholders', () => {
  const html = fs.readFileSync(appPath, 'utf8');
  const toml = fs.readFileSync(path.join(root, 'o', 'netlify.toml'), 'utf8');
  assert.ok(!/-ORIGIN-HERE/.test(toml), 'no placeholder in netlify.toml headers');
  assert.ok(!html.includes('beownir-native-assets'), 'no WASIX asset pack remains');
  assert.ok(!html.includes('beownirHostSource'), 'no Node host script remains');
  assert.ok(html.length > 6 * 1024 * 1024, 'the single file is complete: ' + html.length);
});
