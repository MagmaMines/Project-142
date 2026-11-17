#!/usr/bin/env node
/**
 * Generates the Rollup WASM region of o/runtime/worker-runtime.js from the vendored
 * files in o/compat/rollup-wasm/ (Rollup 4.68.2, @rollup/wasm-node).
 *
 *   node tools/gen-rollup-compat.mjs            # rewrite the region
 *   node tools/gen-rollup-compat.mjs --check    # fail when the region is stale (CI)
 *
 * Vite imports Rollup, and Rollup's native loader looks for a per-platform binary that
 * cannot run in the browser worker. The worker mounts these three files at
 * /.beownir/runtime/rollup/ and redirects Rollup's native.js there.
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const vendor = path.join(root, 'o', 'compat', 'rollup-wasm');
const target = path.join(root, 'o', 'runtime', 'worker-runtime.js');
const BEGIN = '/* BEGIN generated: rollup-wasm (tools/gen-rollup-compat.mjs - do not edit) */';
const END = '/* END generated: rollup-wasm */';

export function buildRegion() {
  const native = fs.readFileSync(path.join(vendor, 'native.js'), 'utf8');
  const bindings = fs.readFileSync(path.join(vendor, 'wasm-node', 'bindings_wasm.js'), 'utf8');
  const wasmGz = zlib.gzipSync(fs.readFileSync(path.join(vendor, 'wasm-node', 'bindings_wasm_bg.wasm')), { level: 9 });
  return [
    BEGIN,
    '// Literals are JSON strings, so no source text can break out of them.',
    `const ROLLUP_NATIVE_SOURCE = ${JSON.stringify(native)};`,
    `const ROLLUP_BINDINGS_SOURCE = ${JSON.stringify(bindings)};`,
    `const ROLLUP_WASM_GZ_B64 = ${JSON.stringify(wasmGz.toString('base64'))};`,
    END,
  ].join('\n');
}

function splice(source, region) {
  const start = source.indexOf(BEGIN);
  const end = source.indexOf(END);
  if (start < 0 || end < 0 || end < start) throw new Error('worker-runtime.js has no generated rollup region');
  return source.slice(0, start) + region + source.slice(end + END.length);
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const current = fs.readFileSync(target, 'utf8');
  const next = splice(current, buildRegion());
  if (process.argv.includes('--check')) {
    if (current !== next) { console.error('rollup region is stale: run node tools/gen-rollup-compat.mjs'); process.exit(1); }
    console.log('rollup region is current');
  } else {
    fs.writeFileSync(target, next);
    console.log('rollup region written (' + buildRegion().length + ' chars)');
  }
}
