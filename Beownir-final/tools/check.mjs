#!/usr/bin/env node
/**
 * Static checks for the single-file app. Runs in CI and before a release.
 *
 *   node tools/check.mjs [--skip-assets]
 *
 * Checks:
 *   1. the embedded runtime, frame kernel, preview bridge, install kit, and SW match their source files
 *   2. every <script> block parses (node --check) and closes properly
 *   3. every `$('#id')` lookup points at an element that exists
 *   4. every DOM id is unique
 *   5. the shipped bundle uses no language feature newer than the browser floor
 *   6. the document keeps its required single-file anchors
 *   7. the headless embed bundle (o/embed/beownir-kernel.js) is current and
 *      its client code respects the same browser floor
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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
 *    and coi-sw live under o/ and the HTML must carry them verbatim. */
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
  const isCode = type === 'text/javascript' || type === 'module' || (type === 'text/plain' && /id="(?:runtimeSource|runtimeFrameSource|previewBridgeSource|coiServiceWorkerSource)"/.test(script.attrs));
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

/* 5. browser floor.
 * The app is shipped as one modern-JS document with no transpile step, so a
 * language or platform feature newer than the stated floor can only fail in
 * someone else's browser. Everything below is *unguarded* use of a feature:
 * the guarded ones (service worker, SharedArrayBuffer/JSPI, OPFS, compression
 * streams, storage APIs) are probed at boot and degrade with a visible reason,
 * which is why they are not in this list. Keep this list honest when the floor
 * moves: it is the difference between "supports modern browsers" and a claim. */
const FLOOR = { chrome: 85, edge: 85, firefox: 79, safari: 14 };
/* Patterns are matched against executable source only: script bodies, with the
 * embedded `type="text/plain"` sources checked separately. Prose in the UI
 * (help text, terminal banners) is not code, so `node -e "code"` in a banner
 * must not trip the Array.prototype.at check. */
const UNSHIPPABLE = [
  { pattern: String.raw`\.hasOwn\(`, feature: 'Object.hasOwn', needs: 'Chrome 93, Firefox 92, Safari 15.4' },
  { pattern: String.raw`\.replaceAll\(`, feature: 'String.prototype.replaceAll', needs: 'Chrome 85, Firefox 77, Safari 13.1' },
  { pattern: String.raw`\.at\(-\d\)`, feature: 'Array.prototype.at', needs: 'Chrome 92, Firefox 90, Safari 15.4' },
  { pattern: String.raw`structuredClone\s*\(`, feature: 'structuredClone', needs: 'Chrome 98, Firefox 94, Safari 15.4', probe: "typeof structuredClone !== 'function'" },
  { pattern: String.raw`Promise\.withResolvers`, feature: 'Promise.withResolvers', needs: 'Chrome 119, Firefox 121, Safari 17.4' },
  { pattern: String.raw`Array\.fromAsync`, feature: 'Array.fromAsync', needs: 'Chrome 121, Firefox 121, Safari 16.4' },
  { pattern: String.raw`\.findLast\(`, feature: 'Array.prototype.findLast', needs: 'Chrome 97, Firefox 104, Safari 15.4' },
  { pattern: String.raw`AbortSignal\.timeout`, feature: 'AbortSignal.timeout', needs: 'Chrome 103, Firefox 100, Safari 16' },
];
const scriptBodies = [];
{
  const open = /<script([^>]*)>/g;
  let match;
  while ((match = open.exec(html))) {
    const start = match.index + match[0].length;
    const end = html.indexOf('</script>', start);
    if (end < 0) break;
    scriptBodies.push(html.slice(start, end));
  }
}
const floorIn = bodies => {
  const offences = [];
  for (const { pattern, feature, needs, probe } of UNSHIPPABLE) {
    const matcher = new RegExp(pattern, 'g');
    let total = 0;
    for (const body of bodies) {
      for (const line of body.split('\n')) {
        const trimmed = line.trim();
        /* Comments explain a feature; they do not call it. */
        if (trimmed.startsWith('*') || trimmed.startsWith('//') || trimmed.startsWith('/*')) continue;
        if (!matcher.test(line)) continue;
        matcher.lastIndex = 0;
        /* A guarded use is fine: `typeof structuredClone !== 'function'` on the
         * same line means the feature is probed before it is called. */
        if (typeof probe === 'string' && line.includes(probe)) continue;
        total += (line.match(matcher) || []).length;
      }
    }
    if (total) offences.push(feature + ' x' + total + ' (' + needs + ')');
  }
  return offences;
};
const floorOffences = floorIn(scriptBodies);
if (floorOffences.length) {
  fail('the shipped bundle uses features newer than the supported browser floor (' +
    'Chrome ' + FLOOR.chrome + '+ / Firefox ' + FLOOR.firefox + '+ / Safari ' + FLOOR.safari + '+): ' +
    floorOffences.join('; '));
} else {
  notes.push('browser floor: Chrome ' + FLOOR.chrome + '+ / Firefox ' + FLOOR.firefox + '+ / Safari ' + FLOOR.safari + '+ language features only');
}
/* 6. single-file anchors */
for (const anchor of ['id="runtimeSource"', 'id="runtimeFrameSource"', 'id="previewBridgeSource"', 'id="coiServiceWorkerSource"', 'id="pakoSource"']) {
  if (!html.includes(anchor)) fail('missing anchor: ' + anchor);
}
notes.push((html.length / 1024 / 1024).toFixed(2) + ' MiB single file');

/* 7. headless embed bundle. Third-party pages load o/embed/beownir-kernel.js
 *    instead of the IDE, so it is a shipped surface: it must exist, match the
 *    app's embedded sources byte for byte (a stale copy would silently give a
 *    host an older runtime), and respect the same browser floor. */
try {
  const { build, templatePath, outputPath } = await import('./build-embed.mjs');
  const templateSource = fs.readFileSync(templatePath, 'utf8');
  if (!fs.existsSync(outputPath)) fail('o/embed/beownir-kernel.js is missing: run node tools/build-embed.mjs');
  else if (fs.readFileSync(outputPath, 'utf8') !== build()) fail('o/embed/beownir-kernel.js is stale: run node tools/build-embed.mjs');
  else notes.push('embed bundle current (' + (fs.statSync(outputPath).size / 1048576).toFixed(1) + ' MiB)');
  const embedFloor = floorIn([templateSource]);
  if (embedFloor.length) fail('the embed client uses features newer than the browser floor: ' + embedFloor.join('; '));
  else notes.push('embed client respects the browser floor');
} catch (error) {
  fail('embed check failed: ' + error.message);
}

for (const note of notes) console.log('  ok  ' + note);
for (const message of failures) console.error('FAIL  ' + message);
if (failures.length) {
  console.error('\n' + failures.length + ' check(s) failed');
  process.exitCode = 1;
} else {
  console.log('\nall checks passed');
}
