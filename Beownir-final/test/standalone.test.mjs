// Tests for the single-file distribution. They read ONLY the artifact plus the
// build tooling: nothing here imports the runtime from o/site/index.html, so a
// regression in the build (an asset that stops being embedded, a stale copy)
// fails even when the application source is fine.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  build, verifyArtifact, readManifest, withoutManifest, externalReferences,
  ARTIFACT_NAME, REQUIRED_ANCHORS,
} from '../tools/build-standalone.mjs';
import { smokeArtifact, bootRuntime } from '../tools/standalone-smoke.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const artifactPath = path.join(root, ARTIFACT_NAME);
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

test('the committed artifact is reproducible from the source tree', { timeout: 180000 }, () => {
  const { html } = build();
  assert.ok(fs.existsSync(artifactPath), ARTIFACT_NAME + ' is committed');
  const committed = fs.readFileSync(artifactPath, 'utf8');
  assert.equal(committed, html, ARTIFACT_NAME + ' is stale: run node tools/build-standalone.mjs');
  // Two builds of the same source must be byte-identical (no timestamps).
  assert.equal(build().html, html, 'the build is not deterministic');
});

test('the artifact describes itself with a verifiable manifest', () => {
  const html = fs.readFileSync(artifactPath, 'utf8');
  const manifest = readManifest(html);
  assert.ok(manifest, 'the artifact carries a build manifest');
  assert.equal(manifest.format, 'beownir-standalone/1');
  assert.equal(sha256(withoutManifest(html)), manifest.document.sha256);
  const verified = verifyArtifact(html);
  assert.deepEqual(verified.problems, []);
  // The digest covers the document with an *empty* manifest block, so it is
  // independent of the manifest's own content and a rebuild converges.
  assert.equal(sha256(withoutManifest(html)), sha256(withoutManifest(withoutManifest(html))));
});

test('every essential runtime asset is embedded, not fetched', () => {
  const html = fs.readFileSync(artifactPath, 'utf8');
  for (const id of REQUIRED_ANCHORS) assert.ok(html.includes('<script id="' + id + '"'), 'embedded anchor: ' + id);
  // The worker bootstraps from a Blob URL built from the embedded source.
  assert.match(html, /URL\.createObjectURL\(new Blob\(\[event\.data\.source\]/);
  assert.deepEqual(externalReferences(html), [], 'no mandatory external files');
  // No remote script/style/image is required to render the IDE.
  assert.doesNotMatch(html, /<script[^>]+src="https?:/);
  assert.doesNotMatch(html, /<link[^>]+href="https?:/);
});

test('embedded esbuild WASM decodes and is a valid WebAssembly module', () => {
  const html = fs.readFileSync(artifactPath, 'utf8');
  const match = /<script id="esbuildWasm"[^>]*>([\s\S]*?)<\/script>/.exec(html);
  assert.ok(match, 'esbuildWasm is embedded');
  const raw = zlib.gunzipSync(Buffer.from(match[1].trim(), 'base64'));
  assert.deepEqual([...raw.subarray(0, 4)], [0x00, 0x61, 0x73, 0x6d], 'wasm magic');
  assert.ok(!html.includes('beownir-native-assets'), 'no WASIX asset pack is embedded');
  assert.ok(!html.includes('beownirHostSource'), 'no Node host script is embedded');
});

test('the artifact boots, runs commands and restores a project', { timeout: 120000 }, async () => {
  const report = await smokeArtifact(artifactPath);
  assert.deepEqual(report.problems, [], report.lines.join('\n'));
  assert.ok(report.ok);
  assert.ok(report.timings.bootMs > 0, 'boot time was measured');
});

test('a missing essential source fails the build instead of shipping a shell', () => {
  // Simulate a broken tree by asking the builder for a document with an anchor
  // removed. The builder must refuse rather than emit a half-application.
  const html = fs.readFileSync(path.join(root, 'o', 'site', 'index.html'), 'utf8');
  const broken = html.replace('<script id="previewBridgeSource"', '<script id="renamedBridgeSource"');
  const temporary = path.join(root, '.beownir', 'broken-source.html');
  fs.mkdirSync(path.dirname(temporary), { recursive: true });
  fs.writeFileSync(temporary, broken);
  try {
    assert.throws(() => build({ source: temporary }), /required anchor is missing|previewBridgeSource|embedded sources are stale/);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
});

test('the embedded runtime refuses to be spoofed by a stale manifest digest', () => {
  const html = fs.readFileSync(artifactPath, 'utf8');
  const manifest = readManifest(html);
  const sampleDigest = manifest.sources[0].sha256;
  const tamperedDigest = (sampleDigest.startsWith('ff') ? '00' : 'ff') + sampleDigest.slice(2);
  const broken = html.replace(sampleDigest, tamperedDigest);
  const report = verifyArtifact(broken);
  assert.ok(report.problems.length > 0, 'a tampered digest is reported');
  assert.ok(report.problems.some(problem => /source|digest|manifest/i.test(problem)), 'the report names the mismatch: ' + report.problems.join('; '));
});

test('the runtime inside the artifact persists files through the init message', async () => {
  const html = fs.readFileSync(artifactPath, 'utf8');
  const runtime = bootRuntime(html);
  await runtime.run('echo persisted > state.txt');
  const snapshot = runtime.snapshot();
  assert.equal(snapshot['/project/state.txt'].c, 'persisted\n');
  const second = bootRuntime(html);
  await second.reload(snapshot);
  const read = await second.run('cat state.txt');
  assert.equal(read.output, 'persisted\n');
});
