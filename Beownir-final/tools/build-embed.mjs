#!/usr/bin/env node
/**
 * Builds `beownir-kernel.js`: the embeddable, headless kernel for third-party
 * web IDEs (see EMBEDDING.md).
 *
 * The bundle is generated from the *same* sources that ship inside
 * beownir-standalone.html — the worker runtime, the frame kernel, pako and the
 * esbuild assets — so an embed can never drift from the IDE. The template holds
 * the public API; this tool inlines the payload and writes one self-contained
 * file with no fetch() of its own parts.
 *
 *   node tools/build-embed.mjs          # write o/embed/beownir-kernel.js
 *   node tools/build-embed.mjs --check  # fail when the committed file is stale
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const templatePath = path.join(root, 'o', 'embed', 'beownir-kernel-api.template.js');
export const outputPath = path.join(root, 'o', 'embed', 'beownir-kernel.js');
const appPath = path.join(root, 'o', 'site', 'index.html');

/** Reads a `<script id="…">` payload out of the application source. */
export function block(html, id) {
  const match = html.match(new RegExp('<script id="' + id + '"[^>]*>([\\s\\S]*?)<\\/script>'));
  if (!match) throw new Error('the application source has no <script id="' + id + '"> block');
  return match[1];
}

export function payload(html = fs.readFileSync(appPath, 'utf8')) {
  const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
  return {
    version,
    runtime: block(html, 'runtimeSource'),
    kernel: block(html, 'runtimeFrameSource'),
    pako: block(html, 'pakoSource'),
    esbuildWasm: block(html, 'esbuildWasm').trim(),
    esbuildBrowser: block(html, 'esbuildBrowser').trim(),
  };
}

export function build(html) {
  const template = fs.readFileSync(templatePath, 'utf8');
  const parts = payload(html);
  /* JSON.stringify leaves U+2028/U+2029 raw, and a literal `</script` would
   * close the host page's tag if the bundle is inlined. Escape both, plus the
   * usual <, >, & set, so the literal is safe in any HTML context. */
  const literal = JSON.stringify(parts)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
  if (!template.includes('__BEOWNIR_EMBED_BUILD__')) throw new Error('the template has no __BEOWNIR_EMBED_BUILD__ placeholder');
  /* A function replacer, not a string: the payload contains `$&`, `$'` and
   * ``$` `` sequences, which String#replace would otherwise expand. */
  return template.replace('__BEOWNIR_EMBED_BUILD__', () => literal);
}

export function sha256(text) { return crypto.createHash('sha256').update(text).digest('hex'); }

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const built = build();
  const bytes = Buffer.byteLength(built);
  if (process.argv.includes('--check')) {
    if (!fs.existsSync(outputPath)) {
      console.error('FAIL  o/embed/beownir-kernel.js is missing: run node tools/build-embed.mjs');
      process.exitCode = 1;
    } else if (fs.readFileSync(outputPath, 'utf8') !== built) {
      console.error('FAIL  o/embed/beownir-kernel.js is stale: run node tools/build-embed.mjs');
      process.exitCode = 1;
    } else {
      console.log('o/embed/beownir-kernel.js is current (' + (bytes / 1024).toFixed(0) + ' KiB, sha256 ' + sha256(built).slice(0, 16) + ')');
    }
  } else {
    fs.writeFileSync(outputPath, built);
    console.log('wrote o/embed/beownir-kernel.js (' + (bytes / 1024).toFixed(0) + ' KiB, sha256 ' + sha256(built).slice(0, 16) + ')');
  }
}
