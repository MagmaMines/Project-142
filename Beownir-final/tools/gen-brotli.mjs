#!/usr/bin/env node
/**
 * Generates the brotli region of o/runtime/worker-runtime.js from
 * o/compat/brotli/brotli.js and o/compat/brotli/brotli_wasm_bg.wasm.
 *
 *   node tools/gen-brotli.mjs            # rewrite the region
 *   node tools/gen-brotli.mjs --check    # fail when the region is stale (CI)
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const jsSourcePath = path.join(root, 'o', 'compat', 'brotli', 'brotli.js');
const wasmSourcePath = path.join(root, 'o', 'compat', 'brotli', 'brotli_wasm_bg.wasm');
const target = path.join(root, 'o', 'runtime', 'worker-runtime.js');
const BEGIN = '/* BEGIN generated: brotli (tools/gen-brotli.mjs - do not edit) */';
const END = '/* END generated: brotli */';

export function buildRegion() {
  const rawJs = fs.readFileSync(jsSourcePath, 'utf8')
    .replace(/^'use strict';\s*/m, '')
    .replace(/^module\.exports\s*=\s*function initBrotliWasm/m, 'function initBrotliWasm');
  const wasmGzB64 = zlib.gzipSync(fs.readFileSync(wasmSourcePath), { level: 9, mtime: 0 }).toString('base64');
  return [
    BEGIN,
    `const BROTLI_WASM_GZ_B64 = ${JSON.stringify(wasmGzB64)};`,
    rawJs.trimEnd(),
    END,
  ].join('\n');
}

function splice(text, region) {
  const start = text.indexOf(BEGIN), end = text.indexOf(END);
  if (start < 0 || end < 0 || end < start) throw new Error('worker-runtime.js has no generated brotli region');
  return text.slice(0, start) + region + text.slice(end + END.length);
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const current = fs.readFileSync(target, 'utf8');
  const next = splice(current, buildRegion());
  if (process.argv.includes('--check')) {
    if (current !== next) { console.error('brotli region is stale: run node tools/gen-brotli.mjs'); process.exit(1); }
    console.log('brotli region is current');
  } else {
    fs.writeFileSync(target, next);
    console.log('brotli region written');
  }
}
