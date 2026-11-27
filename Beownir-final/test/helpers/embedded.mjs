// Extracts embedded sources from the single-file application so tests can run
// them directly in Node instead of trusting a copy.
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const siteFile = path.join(root, 'o', 'site', 'index.html');

export function readSite() {
  return fs.readFileSync(siteFile, 'utf8');
}

/** Returns the raw text of `<script id="...">`. */
export function scriptById(html, id) {
  const pattern = new RegExp(`<script id="${id}"[^>]*>([\\s\\S]*?)<\\/script>`);
  const match = pattern.exec(html);
  if (!match) throw new Error('Missing embedded script: ' + id);
  return match[1];
}

export function pakoModule() {
  const source = scriptById(readSite(), 'pakoSource');
  const sandbox = { module: { exports: {} }, exports: {}, self: {}, window: {} };
  sandbox.self = sandbox;
  sandbox.window = sandbox;
  vm.runInNewContext(source, sandbox, { filename: 'pakoSource' });
  return sandbox.pako || sandbox.exports;
}
