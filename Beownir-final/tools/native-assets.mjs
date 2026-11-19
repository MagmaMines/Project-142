#!/usr/bin/env node
/**
 * The browser-WASM runtime ships as base64+gzip blobs inside
 * <script id="beownir-native-assets">. Editing base64 by hand is not
 * reviewable, so the blobs have a real source tree under o/native/:
 *
 *   node tools/native-assets.mjs --extract   # blobs -> o/native/**
 *   node tools/native-assets.mjs --embed     # o/native/** -> blobs
 *   node tools/native-assets.mjs --check     # fail when they differ (CI)
 *
 * Paths in o/native/ mirror the request paths the runtime serves, e.g.
 * "/native-kernel.mjs" -> o/native/native-kernel.mjs and
 * "/node_modules/@wasmer/sdk/dist/index.js" -> o/native/node_modules/@wasmer/sdk/dist/index.js.
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const appPath = path.join(root, 'o', 'site', 'index.html');
const sourceDir = path.join(root, 'o', 'native');
// Keep SDK source files out of a directory literally named node_modules:
// repository snapshot systems and package tooling commonly exclude those
// directories. The browser asset URL remains the upstream /node_modules path.
const VENDORED_SDK_SOURCE = '/vendor/wasmer-sdk/';
const VENDORED_SDK_URL = '/node_modules/@wasmer/sdk/';

function sourceNameForAsset(urlName) {
  return urlName.startsWith(VENDORED_SDK_URL)
    ? VENDORED_SDK_SOURCE + urlName.slice(VENDORED_SDK_URL.length)
    : urlName;
}
function assetNameForSource(sourceName) {
  return sourceName.startsWith(VENDORED_SDK_SOURCE)
    ? VENDORED_SDK_URL + sourceName.slice(VENDORED_SDK_SOURCE.length)
    : sourceName;
}

const PACK_OPEN = '<script id="beownir-native-assets" type="application/json">';
const PACK_CLOSE = '</script>';
const CONTENT_TYPES = {
  '.mjs': 'text/javascript; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.cjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.wasm': 'application/wasm',
  '.map': 'application/json; charset=utf-8'
};

export function contentType(name) {
  return CONTENT_TYPES[path.extname(name).toLowerCase()] || 'application/octet-stream';
}

export function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function locate(html) {
  const open = html.indexOf(PACK_OPEN);
  if (open < 0) throw new Error('native asset pack is missing from o/site/index.html');
  const start = open + PACK_OPEN.length;
  const end = html.indexOf(PACK_CLOSE, start);
  if (end < 0) throw new Error('native asset pack is not closed');
  return { start, end };
}

export function readPack(html) {
  const { start, end } = locate(html);
  return JSON.parse(html.slice(start, end));
}

/** Deterministic gzip so re-embedding an unchanged file does not churn the HTML. */
export function packBytes(bytes) {
  return zlib.gzipSync(bytes, { level: 9, mtime: 0 });
}

export function buildPack(html, files) {
  const { start, end } = locate(html);
  const pack = {};
  for (const name of [...files.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))) {
    const bytes = files.get(name);
    pack[name] = { type: contentType(name), sha256: sha256(bytes), base64: packBytes(bytes).toString('base64') };
  }
  return html.slice(0, start) + JSON.stringify(pack) + html.slice(end);
}

function walk(dir, base = dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, base, out);
    else if (entry.isFile()) out.push('/' + path.relative(base, full).split(path.sep).join('/'));
  }
  return out;
}

function extractAssets(html) {
  const pack = readPack(html);
  let count = 0;
  for (const [name, entry] of Object.entries(pack)) {
    const bytes = zlib.gunzipSync(Buffer.from(entry.base64, 'base64'), { maxOutputLength: 64 * 1024 * 1024 });
    if (sha256(bytes) !== entry.sha256) throw new Error('embedded hash mismatch for ' + name);
    const target = path.join(sourceDir, sourceNameForAsset(name).replace(/^\//, ''));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, bytes);
    count++;
  }
  return count;
}

function loadSources() {
  const files = new Map();
  for (const sourceName of walk(sourceDir)) {
    const assetName = assetNameForSource(sourceName);
    files.set(assetName, fs.readFileSync(path.join(sourceDir, sourceName.replace(/^\//, ''))));
  }
  return files;
}

/** Compares o/native/** with the blobs and returns human-readable differences. */
export function diffAssets(html) {
  if (!fs.existsSync(sourceDir)) return ['o/native/ is missing: run node tools/native-assets.mjs --extract'];
  const pack = readPack(html);
  const files = loadSources();
  const problems = [];
  for (const [name, bytes] of files) {
    const entry = pack[name];
    if (!entry) { problems.push('missing from the HTML pack: ' + name); continue; }
    if (entry.sha256 !== sha256(bytes)) problems.push('content differs: ' + name);
    if (entry.type !== contentType(name)) problems.push('content-type differs: ' + name);
  }
  for (const name of Object.keys(pack)) if (!files.has(name)) problems.push('missing from o/native: ' + name);
  return problems;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const mode = process.argv.includes('--extract') ? 'extract' : process.argv.includes('--embed') ? 'embed' : process.argv.includes('--check') ? 'check' : null;
  if (!mode) {
    console.error('usage: node tools/native-assets.mjs --extract | --embed | --check');
    process.exitCode = 2;
  } else {
    const html = fs.readFileSync(appPath, 'utf8');
    if (mode === 'extract') {
      const count = extractAssets(html);
      console.log('extracted ' + count + ' assets into o/native/');
    } else if (mode === 'check') {
      const problems = diffAssets(html);
      if (problems.length) {
        for (const problem of problems) console.error('FAIL  ' + problem);
        console.error('\n' + problems.length + ' asset difference(s): run node tools/native-assets.mjs --extract (or --embed)');
        process.exitCode = 1;
      } else console.log('native assets match o/native/ (' + Object.keys(readPack(html)).length + ' files)');
    } else {
      const files = loadSources();
      const next = buildPack(html, files);
      if (next === html) console.log('native asset pack already up to date');
      else {
        fs.writeFileSync(appPath, next);
        console.log('embedded ' + files.size + ' assets from o/native/ (' + (next.length - html.length) + ' bytes delta)');
      }
    }
  }
}
