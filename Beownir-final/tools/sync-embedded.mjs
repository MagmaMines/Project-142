#!/usr/bin/env node
/**
 * Keeps the single-file app honest.
 *
 * The IDE ships as one HTML file, so the runtime sources live as real files and
 * are inlined into it:
 *
 *   o/runtime/stream-kit.js      -> the `@beownir-kit-start/end` block inside
 *                                   o/runtime/worker-runtime.js
 *   o/runtime/worker-runtime.js  -> <script id="runtimeSource" type="text/plain">
 *   o/runtime/frame-kernel.js    -> <script id="runtimeFrameSource" type="text/plain">
 *   o/runtime/preview-bridge.js  -> <script id="previewBridgeSource" type="text/plain">
 *   o/site/coi-sw.js             -> <script id="coiServiceWorkerSource" type="text/plain">
 *
 * Earlier revisions kept the worker runtime only inside the HTML: a 640 KiB
 * blob that no editor could diff and no test could import by path. The files
 * are now the source of truth and this tool makes the embedded copies match
 * them byte for byte.
 *
 * Usage:
 *   node tools/sync-embedded.mjs           # files -> embedded copies
 *   node tools/sync-embedded.mjs --check   # exit 1 when they are stale (CI)
 *   node tools/sync-embedded.mjs --extract # embedded copies -> files
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const appPath = path.join(root, 'o', 'site', 'index.html');

const KIT_START = '/* @beownir-kit-start (generated from o/runtime/stream-kit.js by tools/sync-embedded.mjs) */';
const KIT_END = '/* @beownir-kit-end */';

/** Every text source that is inlined into the single file, in embed order. */
export const SOURCES = [
  { name: 'kit', file: 'o/runtime/stream-kit.js', label: 'stream-kit.js', markers: true },
  { name: 'runtimeSource', file: 'o/runtime/worker-runtime.js', label: 'worker-runtime.js', id: 'runtimeSource', type: 'text/plain', carriesKit: true },
  { name: 'runtimeFrameSource', file: 'o/runtime/frame-kernel.js', label: 'frame-kernel.js', id: 'runtimeFrameSource', type: 'text/plain' },
  { name: 'previewBridgeSource', file: 'o/runtime/preview-bridge.js', label: 'preview-bridge.js', id: 'previewBridgeSource', type: 'text/plain' },
  // The isolation/offline service worker. It cannot be *registered* from a
  // Blob URL (browsers require a same-origin script URL), so the app still
  // loads ./coi-sw.js when a host serves one; the source travels inside the
  // HTML so the artifact carries it and can hand it to the host.
  { name: 'coiServiceWorkerSource', file: 'o/site/coi-sw.js', label: 'coi-sw.js', id: 'coiServiceWorkerSource', type: 'text/plain' },
];

export function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

function readSource(file, label) {
  const text = fs.readFileSync(file, 'utf8');
  if (!text.trim()) throw new Error(label + ' is empty');
  if (text.includes('</script')) throw new Error(label + ' must not contain a closing </script> tag');
  return text;
}

/** Every `<script id="...">` block that this tool governs, located by id. */
export function locateBlock(html, id) {
  const pattern = new RegExp('<script id="' + id + '"[^>]*>');
  const open = pattern.exec(html);
  if (!open) throw new Error('missing <script id="' + id + '"> block in o/site/index.html');
  const start = open.index + open[0].length;
  const end = html.indexOf('</script>', start);
  if (end < 0) throw new Error('the ' + id + ' block is not closed');
  return { start, end, open: open[0] };
}

export function readBlock(html, id) {
  const { start, end } = locateBlock(html, id);
  return html.slice(start, end);
}

function replaceBlock(html, id, content) {
  const { start, end, open } = locateBlock(html, id);
  return html.slice(0, start) + content + html.slice(end);
}

/** Replaces the `@beownir-kit-start/end` region of a runtime source with the kit. */
export function applyKit(runtime, kit) {
  const start = runtime.indexOf(KIT_START);
  const end = runtime.indexOf(KIT_END);
  if (start < 0 || end < 0 || end < start) {
    throw new Error('the kit markers are missing from o/runtime/worker-runtime.js');
  }
  return runtime.slice(0, start) + KIT_START + '\n' + kit + '\n' + KIT_END + runtime.slice(end + KIT_END.length);
}

/** Returns the embedded copies plus the rewritten document. */
export function buildEmbedded(html, sources) {
  // Backwards-compatible call shape: { kit, host } as plain strings.
  const files = new Map();
  for (const source of SOURCES) {
    const supplied = sources && Object.hasOwn(sources, source.name) ? sources[source.name] : undefined;
    const text = typeof supplied === 'string' ? supplied : readSource(path.join(root, source.file), source.label);
    files.set(source.name, text);
  }
  const kit = files.get('kit').replace(/\s+$/, '');
  let output = html;
  for (const source of SOURCES) {
    if (source.markers || !source.id) continue;
    let content = files.get(source.name);
    if (source.carriesKit) content = applyKit(content, kit);
    output = replaceBlock(output, source.id, content);
  }
  return { output, embedded: Object.fromEntries(files), kit };
}

export function checkEmbedded(html, sources) {
  const { output } = buildEmbedded(html, sources);
  return output === html;
}

/** Inlined copies that are stale, with a human-readable reason. */
export function staleSources(html, sources) {
  const problems = [];
  const { embedded, kit } = buildEmbedded(html, sources);
  for (const source of SOURCES) {
    if (source.markers || !source.id) continue;
    const expected = source.carriesKit ? applyKit(embedded[source.name], kit) : embedded[source.name];
    const actual = readBlock(html, source.id);
    if (actual !== expected) problems.push(source.label + ' <script id="' + source.id + '"> is stale');
  }
  return problems;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const check = process.argv.includes('--check');
  const extract = process.argv.includes('--extract');
  const html = fs.readFileSync(appPath, 'utf8');
  if (extract) {
    // HTML -> files: the reverse direction, used once when a blob moves into
    // the source tree (and to prove the two directions agree).
    const kit = readBlock(html, 'runtimeSource');
    const start = kit.indexOf(KIT_START);
    const end = kit.indexOf(KIT_END);
    if (start < 0 || end < 0) throw new Error('the runtimeSource block has no kit markers');
    fs.writeFileSync(path.join(root, 'o/runtime/stream-kit.js'), kit.slice(start + KIT_START.length, end).replace(/^\n/, '').replace(/\n$/, '') + '\n');
    for (const source of SOURCES) {
      if (source.markers || !source.id) continue;
      fs.writeFileSync(path.join(root, source.file), readBlock(html, source.id));
    }
    console.log('extracted ' + SOURCES.filter(source => source.id).length + ' sources from o/site/index.html');
  } else {
    const { output, embedded } = buildEmbedded(html, {});
    if (output === html) {
      console.log('embedded sources are up to date (' + SOURCES.filter(s => s.id).length + ' blocks, sha256 ' + sha256(output).slice(0, 16) + ')');
    } else if (check) {
      const problems = staleSources(html, {});
      for (const problem of problems) console.error('FAIL  ' + problem);
      console.error('embedded sources are stale: run `node tools/sync-embedded.mjs` and commit the result');
      process.exitCode = 1;
    } else {
      fs.writeFileSync(appPath, output);
      console.log('synced ' + SOURCES.filter(s => s.id).length + ' embedded sources into o/site/index.html (' + (output.length - html.length) + ' bytes delta)');
      void embedded;
    }
  }
}
