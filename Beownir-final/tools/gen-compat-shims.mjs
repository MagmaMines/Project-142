#!/usr/bin/env node
/**
 * Generates the compat-shims region of o/runtime/worker-runtime.js from the sources in
 * o/compat/tailwind/. These replace two native modules that cannot load in the worker:
 *
 *   @tailwindcss/oxide -> o/compat/tailwind/oxide.cjs   (JavaScript candidate scanner)
 *   lightningcss       -> o/compat/tailwind/lightningcss.cjs (pass-through transform)
 *
 *   node tools/gen-compat-shims.mjs            # rewrite the region
 *   node tools/gen-compat-shims.mjs --check    # fail when the region is stale (CI)
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const vendor = path.join(root, 'o', 'compat', 'tailwind');
const target = path.join(root, 'o', 'runtime', 'worker-runtime.js');
const BEGIN = '/* BEGIN generated: compat-shims (tools/gen-compat-shims.mjs - do not edit) */';
const END = '/* END generated: compat-shims */';

export function buildRegion() {
  const oxide = fs.readFileSync(path.join(vendor, 'oxide.cjs'), 'utf8');
  const lightningcss = fs.readFileSync(path.join(vendor, 'lightningcss.cjs'), 'utf8');
  return [
    BEGIN,
    '// Literals are JSON strings, so no source text can break out of them.',
    `const COMPAT_OXIDE_SOURCE = ${JSON.stringify(oxide)};`,
    `const COMPAT_LIGHTNINGCSS_SOURCE = ${JSON.stringify(lightningcss)};`,
    END,
  ].join('\n');
}

function splice(source, region) {
  const start = source.indexOf(BEGIN);
  const end = source.indexOf(END);
  if (start < 0 || end < 0 || end < start) throw new Error('worker-runtime.js has no generated compat-shims region');
  return source.slice(0, start) + region + source.slice(end + END.length);
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const current = fs.readFileSync(target, 'utf8');
  const next = splice(current, buildRegion());
  if (process.argv.includes('--check')) {
    if (current !== next) { console.error('compat-shims region is stale: run node tools/gen-compat-shims.mjs'); process.exit(1); }
    console.log('compat-shims region is current');
  } else {
    fs.writeFileSync(target, next);
    console.log('compat-shims region written');
  }
}
