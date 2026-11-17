#!/usr/bin/env node
/**
 * Builds `beownir-standalone.html`: the complete, single-file distribution.
 *
 * The application source (`o/site/index.html`) already carries the IDE markup,
 * CSS, editor, runtime worker, frame kernel, preview bridge, host source and
 * the native WASM asset pack. This tool turns that source into a *release
 * artifact* that can be audited on its own:
 *
 *   1. verifies every essential source exists (a missing worker, installer,
 *      host source or WASM binary fails the build instead of shipping a shell);
 *   2. verifies the embedded copies are byte-identical to their files
 *      (src/runtime consistency, the same rule CI enforces);
 *   3. verifies the native asset pack: base64 -> gzip -> sha256 per entry;
 *   4. verifies every required anchor (runtime, workers, assets, templates);
 *   5. checks that nothing essential is loaded from a separate mandatory file
 *      (worker bootstrapping and imports are resolved from embedded sources);
 *   6. embeds a deterministic integrity manifest (per-source and per-asset
 *      digests plus a digest of the document itself) into the artifact;
 *   7. writes the artifact, or with --check compares it byte for byte.
 *
 * Determinism: the manifest contains no timestamps, entries are sorted, and
 * gzip mtime is already pinned to 0 in tools/native-assets.mjs. Two builds from
 * the same commit produce identical bytes.
 *
 * Usage:
 *   node tools/build-standalone.mjs                 # build ./beownir-standalone.html
 *   node tools/build-standalone.mjs --check         # fail when the artifact is stale
 *   node tools/build-standalone.mjs --out <file>    # custom destination
 *   node tools/build-standalone.mjs --smoke         # build then boot it headlessly
 *   node tools/build-standalone.mjs --print-manifest
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { SOURCES, staleSources, readBlock } from './sync-embedded.mjs';

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const SOURCE_APP = path.join(root, 'o', 'site', 'index.html');
export const ARTIFACT_NAME = 'beownir-standalone.html';
export const MANIFEST_ID = 'beownir-build-manifest';
const MANIFEST_OPEN = '<script id="' + MANIFEST_ID + '" type="application/json">';
const MANIFEST_CLOSE = '</script>';

/** Files that must exist for the artifact to be the whole product. */
export const REQUIRED_FILES = [
  ['o/site/index.html', 'the single-file application source'],
  ['o/site/coi-sw.js', 'the isolation / offline service worker'],
  ['o/runtime/worker-runtime.js', 'the Node-compatible worker runtime'],
  ['o/runtime/stream-kit.js', 'the streaming install kit (sha512, tar, gzip)'],
  ['o/runtime/frame-kernel.js', 'the virtual OS kernel'],
  ['o/runtime/preview-bridge.js', 'the preview bridge'],
  ['o/host/beownir-host.mjs', 'the network-only host source'],
  ...SOURCES.filter(source => source.file.startsWith('o/native')).map(source => [source.file, 'native runtime asset']),
];

/** Anchors the artifact must contain (script ids the app looks up by id). */
export const REQUIRED_ANCHORS = [
  'runtimeSource',
  'runtimeFrameSource',
  'previewBridgeSource',
  'beownirHostSource',
  'beownir-native-assets',
  'coiServiceWorkerSource',
  'pakoSource',
  'esbuildWasm',
  'esbuildBrowser',
  'vendorBundle',
  'licenseText',
];

/* External references that are *allowed* because the browser genuinely needs a
 * same-origin file for them, or because the native profile lives behind the
 * host. Everything else has to be embedded. Keep this list in sync with
 * SINGLEFILE_BUILD_REPORT.md — the report prints it verbatim. */
export const ALLOWED_EXTERNAL = [
  { reference: 'coi-sw.js', why: 'service workers can only be registered from a same-origin script URL; the app degrades to non-isolated mode when it is absent' },
  { reference: '/native-kernel.mjs', why: 'served by the host from the embedded native asset pack for the isolated browser-WASM profile' },
  { reference: '/node_modules/@wasmer/sdk/', why: 'same: host-served from the embedded pack' },
];

const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/** Every essential input, with its digest and size. */
export function collectSources() {
  const problems = [];
  const files = [];
  for (const [relative, label] of REQUIRED_FILES) {
    const absolute = path.join(root, relative);
    if (!fs.existsSync(absolute)) {
      problems.push('missing ' + label + ': ' + relative);
      continue;
    }
    const bytes = fs.readFileSync(absolute);
    if (!bytes.length) problems.push('empty ' + label + ': ' + relative);
    files.push({ file: relative, label, sha256: sha256(bytes), bytes: bytes.length });
  }
  // Every runtime asset in the embedded pack must also exist in o/native/.
  const nativeFiles = [];
  const walk = dir => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else nativeFiles.push(full);
    }
  };
  if (fs.existsSync(path.join(root, 'o', 'native'))) walk(path.join(root, 'o', 'native'));
  files.push(...nativeFiles.map(full => {
    const bytes = fs.readFileSync(full);
    return {
      file: path.relative(root, full).split(path.sep).join('/'),
      label: 'native asset',
      sha256: sha256(bytes),
      bytes: bytes.length,
    };
  }));
  files.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
  return { files, problems, nativeFiles: nativeFiles.length };
}

/** Verifies the embedded pack: base64 -> gunzip -> sha256, per entry. */
export function verifyAssetPack(html) {
  const open = html.indexOf('<script id="beownir-native-assets" type="application/json">');
  if (open < 0) return { problems: ['the native asset pack block is missing'], assets: [] };
  const start = html.indexOf('>', open) + 1;
  const end = html.indexOf(MANIFEST_CLOSE, start);
  let pack;
  try {
    pack = JSON.parse(html.slice(start, end));
  } catch (error) {
    return { problems: ['the native asset pack is not valid JSON: ' + error.message], assets: [] };
  }
  const problems = [];
  const assets = [];
  for (const name of Object.keys(pack).sort()) {
    const entry = pack[name];
    let bytes;
    try {
      bytes = zlib.gunzipSync(Buffer.from(entry.base64, 'base64'), { maxOutputLength: 64 * 1024 * 1024 });
    } catch (error) {
      problems.push('asset does not gunzip: ' + name + ' (' + error.message + ')');
      continue;
    }
    const digest = sha256(bytes);
    if (digest !== entry.sha256) problems.push('asset digest mismatch: ' + name);
    if (!bytes.length) problems.push('asset is empty: ' + name);
    assets.push({ path: name, type: entry.type, sha256: digest, bytes: bytes.length, compressedBytes: Buffer.from(entry.base64, 'base64').length });
  }
  return { problems, assets };
}

/** Things a single-file distribution must not depend on. */
export function externalReferences(html) {
  // A dependency is a reference in the document markup or an actual worker
  // bootstrap. URL strings that live inside embedded application source (the
  // project templates the IDE writes into a user workspace) are not loaded by
  // this document and must not be reported as required files.
  const markup = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, match => (/^<script\b[^>]*\bsrc=/.test(match) ? match : ''));
  const found = new Set();
  for (const match of markup.matchAll(/<(?:script|link|img|iframe)\b[^>]*\b(?:src|href)="([^"#:]+)"/g)) found.add(match[1]);
  for (const match of html.matchAll(/new Worker\(\s*['"]([^'"]+)['"]/g)) found.add(match[1]);
  for (const match of html.matchAll(/import\(\s*['"](\.\/|\/)([^'"]+)['"]\s*\)/g)) found.add('/' + match[2]);
  return [...found].sort();
}

/**
 * Normalises a document so it carries an *empty* manifest block at the fixed
 * insertion point. Hashing this instead of the raw HTML means the digest
 * describes the document and not the manifest (which would be circular), and it
 * is identical whether the input is the raw source or a built artifact.
 */
export function withoutManifest(html) {
  const open = html.indexOf(MANIFEST_OPEN);
  if (open < 0) {
    if (!html.includes('</head>')) throw new Error('the source document has no </head> to place the manifest in');
    return html.replace('</head>', MANIFEST_OPEN + MANIFEST_CLOSE + '\n</head>');
  }
  const end = html.indexOf(MANIFEST_CLOSE, open + MANIFEST_OPEN.length);
  if (end < 0) throw new Error('the build manifest block is not closed');
  return html.slice(0, open) + MANIFEST_OPEN + MANIFEST_CLOSE + html.slice(end + MANIFEST_CLOSE.length);
}

export function renderManifest(manifest) {
  // Sorted keys and a stable separator: JSON.stringify of an object built in a
  // fixed order is already deterministic, but sorting the asset list protects
  // against a future reordering of the pack.
  return JSON.stringify(manifest);
}

/**
 * Builds the artifact in memory. Throws an Error with every problem attached
 * when the source tree cannot produce a complete single file.
 */
export function build({ source = SOURCE_APP, strict = true } = {}) {
  const problems = [];
  const html = fs.readFileSync(source, 'utf8');
  const { files, problems: fileProblems } = collectSources();
  problems.push(...fileProblems);

  // 1. source <-> embedded consistency. A missing block throws from the locator,
  // so it is caught here and reported like any other build problem.
  try {
    problems.push(...staleSources(html, {}));
  } catch (error) {
    problems.push(String(error && error.message || error));
  }

  // 2. native asset pack
  const pack = verifyAssetPack(html);
  problems.push(...pack.problems);

  // 3. anchors
  const missingAnchors = REQUIRED_ANCHORS.filter(id => !html.includes('<script id="' + id + '"'));
  for (const id of missingAnchors) problems.push('required anchor is missing: <script id="' + id + '">');

  // 4. determinism guard: a build must not embed a timestamp
  const timestamped = /beownir-build-manifest[^]*?"builtAt"/.test(html);

  // 5. external references
  const external = externalReferences(html).filter(reference => !ALLOWED_EXTERNAL.some(allowed => reference === allowed.reference || reference.startsWith(allowed.reference.replace(/\/$/, '') + '/') || reference.startsWith(allowed.reference)));

  if (strict && problems.length) {
    const error = new Error('the single-file build cannot proceed:\n  - ' + problems.join('\n  - '));
    error.problems = problems;
    throw error;
  }

  const document = withoutManifest(html);
  /* The document cannot be listed as a source of itself: its digest would then
   * depend on the manifest that lists it, and a source file that already carries
   * a manifest could never converge to a fixed point. `document.sha256` below
   * covers its content, which is what a verifier needs. */
  const documentFile = path.relative(root, path.resolve(source)).split(path.sep).join('/');
  const documentSources = files.filter(entry => entry.file !== documentFile);
  const manifest = {
    format: 'beownir-standalone/1',
    version: readJson(path.join(root, 'package.json')).version,
    // Major version only: the exact patch changes between build images, which
    // would make byte-for-byte reproducibility impossible to satisfy.
    node: process.versions.node.split('.')[0],
    document: { sha256: sha256(document), bytes: Buffer.byteLength(document, 'utf8') },
    sources: documentSources.map(entry => ({ file: entry.file, sha256: entry.sha256, bytes: entry.bytes })),
    assets: pack.assets,
    anchors: REQUIRED_ANCHORS,
    external: ALLOWED_EXTERNAL,
    counts: {
      sources: documentSources.length,
      assets: pack.assets.length,
      // Counted on the normalised document so the number does not change when
      // the source file itself already carries a manifest.
      scripts: (document.match(/<script\b/g) || []).length,
      embeddedBlocks: SOURCES.filter(item => item.id).length,
    },
  };
  const rendered = renderManifest(manifest);
  const empty = MANIFEST_OPEN + MANIFEST_CLOSE;
  const at = document.indexOf(empty);
  if (at < 0) throw new Error('internal error: the document placeholder is missing');
  const output = document.slice(0, at) + MANIFEST_OPEN + rendered + MANIFEST_CLOSE + document.slice(at + empty.length);
  // The manifest must describe the document it lives in, not itself.
  if (sha256(withoutManifest(output)) !== manifest.document.sha256) {
    throw new Error('internal error: the manifest does not describe the emitted document');
  }
  return {
    html: output,
    manifest,
    problems,
    external,
    timestamped,
    assets: pack.assets,
    sources: documentSources,
  };
}

/** Reads the manifest out of an existing artifact. */
export function readManifest(html) {
  const open = html.indexOf(MANIFEST_OPEN);
  if (open < 0) return null;
  const start = open + MANIFEST_OPEN.length;
  const end = html.indexOf(MANIFEST_CLOSE, start);
  return JSON.parse(html.slice(start, end));
}

/** Independent verification of an artifact, used by --check and the tests. */
export function verifyArtifact(html) {
  const problems = [];
  const manifest = readManifest(html);
  if (!manifest) return { problems: ['the artifact has no build manifest'], manifest: null };
  const document = withoutManifest(html);
  if (sha256(document) !== manifest.document.sha256) problems.push('document digest does not match the manifest');
  if (Buffer.byteLength(document, 'utf8') !== manifest.document.bytes) problems.push('document byte length does not match the manifest');
  const pack = verifyAssetPack(html);
  problems.push(...pack.problems);
  const assetDigests = new Map(pack.assets.map(asset => [asset.path, asset.sha256]));
  for (const asset of manifest.assets) {
    if (assetDigests.get(asset.path) !== asset.sha256) problems.push('embedded asset differs from the manifest: ' + asset.path);
  }
  for (const id of manifest.anchors) if (!html.includes('<script id="' + id + '"')) problems.push('declared anchor is missing: ' + id);
  // Source digests in the manifest must match the files on disk when they are
  // present, which is the source-to-distribution consistency check.
  for (const entry of manifest.sources) {
    const absolute = path.join(root, entry.file);
    if (!fs.existsSync(absolute)) { problems.push('source listed in the manifest is gone: ' + entry.file); continue; }
    if (sha256(fs.readFileSync(absolute)) !== entry.sha256) problems.push('source changed since the artifact was built: ' + entry.file);
  }
  return { problems, manifest };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const args = process.argv.slice(2);
  const check = args.includes('--check');
  const smoke = args.includes('--smoke');
  const outIndex = args.indexOf('--out');
  const destination = path.resolve(root, outIndex >= 0 ? args[outIndex + 1] : ARTIFACT_NAME);
  try {
    const result = build();
    if (args.includes('--print-manifest')) console.log(JSON.stringify(result.manifest, null, 2));
    if (check) {
      if (!fs.existsSync(destination)) {
        console.error('FAIL  ' + path.relative(root, destination) + ' does not exist: run node tools/build-standalone.mjs');
        process.exitCode = 1;
      } else {
        const existing = fs.readFileSync(destination, 'utf8');
        if (existing !== result.html) {
          console.error('FAIL  ' + path.relative(root, destination) + ' is stale: rebuild it (the artifact must be reproducible from the source tree)');
          process.exitCode = 1;
        } else {
          const verified = verifyArtifact(existing);
          if (verified.problems.length) {
            for (const problem of verified.problems) console.error('FAIL  ' + problem);
            process.exitCode = 1;
          } else {
            console.log('artifact is current and self-consistent (' + (Buffer.byteLength(existing, 'utf8') / 1048576).toFixed(2) + ' MiB, sha256 ' + sha256(existing).slice(0, 16) + ')');
          }
        }
      }
    } else {
      fs.writeFileSync(destination, result.html);
      const size = Buffer.byteLength(result.html, 'utf8');
      const gzipped = zlib.gzipSync(Buffer.from(result.html), { level: 9, mtime: 0 }).length;
      console.log('built ' + path.relative(root, destination));
      console.log('  size          ' + (size / 1048576).toFixed(2) + ' MiB (' + (gzipped / 1048576).toFixed(2) + ' MiB gzip)');
      console.log('  sha256        ' + sha256(result.html));
      console.log('  sources       ' + result.sources.length);
      console.log('  native assets ' + result.assets.length);
      console.log('  external refs ' + result.external.length + (result.external.length ? ' (' + result.external.join(', ') + ')' : ''));
      if (result.timestamped) console.warn('  warning       the document carries a "builtAt" field; builds may not be reproducible');
    }
  } catch (error) {
    console.error(error.message || error);
    process.exitCode = 1;
  }
  if (smoke && !process.exitCode) {
    const { smokeArtifact } = await import('./standalone-smoke.mjs');
    const report = await smokeArtifact(destination);
    for (const line of report.lines) console.log('  ' + line);
    if (!report.ok) process.exitCode = 1;
  }
}
