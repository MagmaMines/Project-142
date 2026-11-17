#!/usr/bin/env node
/**
 * Generates the node-path region of o/runtime/worker-runtime.js from o/compat/node-path/:
 * prelude.js (the internals lib/path.js imports) followed by path.js, Node 22.12's file
 * unmodified (MIT, Joyent and Node contributors). The worker evaluates the combined source
 * to get the path module, so path.posix and path.win32 match Node exactly.
 *
 *   node tools/gen-node-path.mjs            # rewrite the region
 *   node tools/gen-node-path.mjs --check    # fail when the region is stale (CI)
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const vendor = path.join(root, 'o', 'compat', 'node-path');
const target = path.join(root, 'o', 'runtime', 'worker-runtime.js');
const BEGIN = '/* BEGIN generated: node-path (tools/gen-node-path.mjs - do not edit) */';
const END = '/* END generated: node-path */';

export function buildRegion() {
  const source = fs.readFileSync(path.join(vendor, 'prelude.js'), 'utf8') + '\n' + fs.readFileSync(path.join(vendor, 'path.js'), 'utf8');
  return [BEGIN, `const NODE_PATH_SOURCE = ${JSON.stringify(source)};`, END].join('\n');
}

function splice(source, region) {
  const start = source.indexOf(BEGIN), end = source.indexOf(END);
  if (start < 0 || end < 0 || end < start) throw new Error('worker-runtime.js has no generated node-path region');
  return source.slice(0, start) + region + source.slice(end + END.length);
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const current = fs.readFileSync(target, 'utf8');
  const next = splice(current, buildRegion());
  if (process.argv.includes('--check')) {
    if (current !== next) { console.error('node-path region is stale: run node tools/gen-node-path.mjs'); process.exit(1); }
    console.log('node-path region is current');
  } else {
    fs.writeFileSync(target, next);
    console.log('node-path region written');
  }
}
