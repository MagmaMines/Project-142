#!/usr/bin/env node
/**
 * Generates the wasi region of o/runtime/worker-runtime.js from o/compat/wasi/host.js, which is
 * the Beownir WASI host (Node's `wasi` module, preview1, on the runtime file system).
 *
 *   node tools/gen-wasi.mjs            # rewrite the region
 *   node tools/gen-wasi.mjs --check    # fail when the region is stale (CI)
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.join(root, 'o', 'compat', 'wasi', 'host.js');
const target = path.join(root, 'o', 'runtime', 'worker-runtime.js');
const BEGIN = '/* BEGIN generated: wasi (tools/gen-wasi.mjs - do not edit) */';
const END = '/* END generated: wasi */';

export function buildRegion() {
  return [BEGIN, `const NODE_WASI_SOURCE = ${JSON.stringify(fs.readFileSync(source, 'utf8'))};`, END].join('\n');
}

function splice(text, region) {
  const start = text.indexOf(BEGIN), end = text.indexOf(END);
  if (start < 0 || end < 0 || end < start) throw new Error('worker-runtime.js has no generated wasi region');
  return text.slice(0, start) + region + text.slice(end + END.length);
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const current = fs.readFileSync(target, 'utf8');
  const next = splice(current, buildRegion());
  if (process.argv.includes('--check')) {
    if (current !== next) { console.error('wasi region is stale: run node tools/gen-wasi.mjs'); process.exit(1); }
    console.log('wasi region is current');
  } else {
    fs.writeFileSync(target, next);
    console.log('wasi region written');
  }
}
