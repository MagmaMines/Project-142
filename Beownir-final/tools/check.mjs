#!/usr/bin/env node
/**
 * Static checks for the single-file app. Runs in CI and before a release.
 *
 *   node tools/check.mjs [--skip-assets]
 *
 * Checks:
 *   1. the embedded host + install kit match their source files
 *   2. every <script> block parses (node --check) and closes properly
 *   3. every `$('#id')` lookup points at an element that exists
 *   4. every DOM id is unique
 *   5. the native runtime asset pack is valid: base64 -> gzip -> sha256
 *   6. the document keeps its required single-file anchors
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { staleSources, SOURCES } from './sync-embedded.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const appPath = path.join(root, 'o', 'site', 'index.html');
const failures = [];
const notes = [];
const fail = message => failures.push(message);

const html = fs.readFileSync(appPath, 'utf8');

/* 1. embedded sources: the worker runtime, frame kernel, preview bridge, kit
 *    and host are real files under o/ and the HTML must carry them verbatim. */
const stale = staleSources(html, {});
if (stale.length) for (const problem of stale) fail(problem + ': run `node tools/sync-embedded.mjs`');
else notes.push('embedded sources match their files (' + SOURCES.filter(source => source.id).length + ' blocks)');

/* 2/3/4. scripts and ids */
const scripts = [];
const opener = /(?:^|\n)<script([^>]*)>/g;
for (let match = opener.exec(html); match; match = opener.exec(html)) {
  const openEnd = match.index + match[0].length;
  const close = html.indexOf('</script>', openEnd);
  if (close < 0) { fail('script block is not closed near offset ' + openEnd); break; }
  scripts.push({ attrs: match[1], body: html.slice(openEnd, close), start: openEnd, end: close });
  opener.lastIndex = close;
}
notes.push(scripts.length + ' script blocks');

const typeOf = attrs => (/type="([^"]*)"/.exec(attrs) || [])[1] || 'text/javascript';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beownir-check-'));
let parsed = 0;
for (const [index, script] of scripts.entries()) {
  const type = typeOf(script.attrs);
  if (type !== 'text/javascript' && type !== 'module' && type !== 'text/plain' && !type.startsWith('application/')) continue;
  const isCode = type === 'text/javascript' || type === 'module' || (type === 'text/plain' && /id="(?:runtimeSource|beownirHostSource)"/.test(script.attrs));
  if (!isCode) continue;
  const file = path.join(dir, 'block-' + index + (type === 'module' ? '.mjs' : '.js'));
  fs.writeFileSync(file, script.body);
  try { execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' }); parsed++; }
  catch (error) { fail('script block ' + index + ' (' + type + ') does not parse: ' + String(error.stderr || error.message).split('\n').slice(0, 3).join(' ')); }
}
fs.rmSync(dir, { recursive: true, force: true });
notes.push(parsed + ' script blocks parse');

/* Template literals inside scripts contain markup of their own; only real
 * document markup counts for the id uniqueness check. */
let markup = html;
for (const script of [...scripts].reverse()) markup = markup.slice(0, script.start) + markup.slice(script.end);
const ids = [...markup.matchAll(/\bid="([A-Za-z0-9_:-]+)"/g)].map(match => match[1]);
const duplicates = ids.filter((id, index) => ids.indexOf(id) !== index);
if (duplicates.length) fail('duplicate element ids: ' + [...new Set(duplicates)].join(', '));
else notes.push(ids.length + ' unique element ids');

const elementIds = new Set(ids);
const lookups = [...new Set([...html.matchAll(/\$\('#([A-Za-z0-9_:-]+)'\)/g)].map(match => match[1]))];
const missing = lookups.filter(id => !elementIds.has(id));
if (missing.length) fail('$() lookups without an element: ' + missing.join(', '));
else notes.push(lookups.length + ' element lookups resolve');

/* 5. native asset pack */
if (!process.argv.includes('--skip-assets')) {
  const pack = /<script id="beownir-native-assets" type="application\/json">([\s\S]*?)<\/script>/.exec(html);
  if (!pack) fail('native asset pack is missing');
  else {
    let json;
    try { json = JSON.parse(pack[1]); } catch (error) { fail('native asset pack is not valid JSON: ' + error.message); }
    if (json) {
      let total = 0, assets = 0;
      for (const [name, entry] of Object.entries(json)) {
        if (!name.startsWith('/') || name.includes('..')) { fail('bad asset path ' + name); continue; }
        if (typeof entry.base64 !== 'string' || typeof entry.sha256 !== 'string') { fail('asset ' + name + ' has no base64/sha256'); continue; }
        let bytes;
        try { bytes = zlib.gunzipSync(Buffer.from(entry.base64, 'base64'), { maxOutputLength: 16 * 1024 * 1024 }); }
        catch (error) { fail('asset ' + name + ' does not decompress: ' + error.message); continue; }
        const digest = crypto.createHash('sha256').update(bytes).digest('hex');
        if (digest !== entry.sha256) fail('asset ' + name + ' hash mismatch');
        total += bytes.length; assets++;
      }
      notes.push(assets + ' native assets verified (' + (total / 1048576).toFixed(1) + ' MiB)');
    }
  }
}

/* 6. the browser-WASM runtime sources match the embedded pack */
try {
  const { diffAssets } = await import('./native-assets.mjs');
  const problems = diffAssets(html);
  if (problems.length) for (const problem of problems) fail(problem + ' (run node tools/native-assets.mjs --extract or --embed)');
  else notes.push('native runtime sources match o/native/');
} catch (error) {
  fail('native asset check failed: ' + error.message);
}

/* 7. single-file anchors */
for (const anchor of ['<!--BEOWNIR_HOST_CONFIG-->', '<meta name="beownir-origins"', 'id="runtimeSource"', 'id="runtimeFrameSource"', 'id="previewBridgeSource"', 'id="pakoSource"']) {
  if (!html.includes(anchor)) fail('missing anchor: ' + anchor);
}
notes.push((html.length / 1024 / 1024).toFixed(2) + ' MiB single file');

for (const note of notes) console.log('  ok  ' + note);
for (const message of failures) console.error('FAIL  ' + message);
if (failures.length) {
  console.error('\n' + failures.length + ' check(s) failed');
  process.exitCode = 1;
} else {
  console.log('\nall checks passed');
}
