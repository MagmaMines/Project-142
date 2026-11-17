#!/usr/bin/env node
/**
 * Generates the node-querystring region of o/runtime/worker-runtime.js from o/compat/node-querystring/:
 * prelude.js plus Node 22.12's lib/querystring.js and lib/internal/querystring.js, both unmodified
 * (MIT, Joyent and Node contributors). The worker evaluates them lazily, on the first require.
 *
 *   node tools/gen-node-querystring.mjs            # rewrite the region
 *   node tools/gen-node-querystring.mjs --check    # fail when the region is stale (CI)
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const vendor = path.join(root, 'o', 'compat', 'node-querystring');
const target = path.join(root, 'o', 'runtime', 'worker-runtime.js');
const BEGIN = '/* BEGIN generated: node-querystring (tools/gen-node-querystring.mjs - do not edit) */';
const END = '/* END generated: node-querystring */';

export function buildRegion() {
  const read = name => fs.readFileSync(path.join(vendor, name), 'utf8');
  return [
    BEGIN,
    read('prelude.js'),
    `const NODE_QS_INTERNAL_SOURCE = ${JSON.stringify(read('internal-querystring.js'))};`,
    `const NODE_QS_SOURCE = ${JSON.stringify(read('querystring.js'))};`,
    END,
  ].join('\n');
}

function splice(source, region) {
  const start = source.indexOf(BEGIN), end = source.indexOf(END);
  if (start < 0 || end < 0 || end < start) throw new Error('worker-runtime.js has no generated node-querystring region');
  return source.slice(0, start) + region + source.slice(end + END.length);
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const current = fs.readFileSync(target, 'utf8');
  const next = splice(current, buildRegion());
  if (process.argv.includes('--check')) {
    if (current !== next) { console.error('node-querystring region is stale: run node tools/gen-node-querystring.mjs'); process.exit(1); }
    console.log('node-querystring region is current');
  } else {
    fs.writeFileSync(target, next);
    console.log('node-querystring region written');
  }
}
