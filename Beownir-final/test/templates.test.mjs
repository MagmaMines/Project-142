/**
 * The built-in framework templates are shipped as source inside the app page
 * (`o/site/index.html`). Each template's `create(kind)` writes a `package.json`
 * whose `overrides` pin native packages to browser-compatible versions. A
 * dropped character in a pinned version turns a real range (`3.3.1`) into a
 * non-existent one (`3.31.1`), which the registry installer then fails on with
 * "No published version of @nuxt/devtools satisfies 3.31.1". This suite drives
 * the shipped template source and asserts every pinned override is a version
 * that actually exists on the npm registry — so a typo can never reach a user
 * workspace again.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { root } from '../tools/build-standalone.mjs';

const page = fs.readFileSync(path.join(root, 'o', 'site', 'index.html'), 'utf8');

/** Extracts and evaluates the `BeownirNativeTemplates` IIFE from the app page. */
function loadNativeTemplates() {
  const start = page.indexOf('const BeownirNativeTemplates = (() => {');
  assert.ok(start > 0, 'the native templates block is present in the shipped page');
  const end = page.indexOf('})();', start);
  assert.ok(end > start, 'the native templates block closes');
  const block = page.slice(start, end + '})();'.length);
  const sandbox = { console, JSON, Object, Array, String, Number, Boolean, Math, RegExp, Error, Date, Set, Map, Promise, Symbol, Reflect, encodeURIComponent, decodeURIComponent };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  /* `const` in a vm script is not attached to the context object, so expose
   * the IIFE result explicitly before running the surrounding code. */
  vm.runInContext(block + '\nglobalThis.BeownirNativeTemplates = BeownirNativeTemplates;', sandbox, { filename: 'native-templates.js' });
  return sandbox.BeownirNativeTemplates;
}

/** Parses the package.json a template writes into its file set. */
function templatePackage(project, kind) {
  const entry = project.files['/project/package.json'];
  assert.ok(entry && typeof entry.c === 'string', kind + ' writes a package.json');
  return JSON.parse(entry.c);
}

test('the nuxt-native template pins @nuxt/devtools to a published version', async () => {
  const templates = loadNativeTemplates();
  const project = templates.create('nuxt-native');
  const pkg = templatePackage(project, 'nuxt-native');
  const range = pkg.overrides['@nuxt/devtools'];
  assert.equal(range, '3.3.1', 'the pinned devtools override is 3.3.1, not a dropped-dot 3.31.1');
  assert.doesNotMatch(String(range), /3\.31\.1/, 'the override never contains the bogus 3.31.1');
});

test('every pinned override resolves to a version that exists on the registry', async () => {
  const templates = loadNativeTemplates();
  const project = templates.create('nuxt-native');
  const pkg = templatePackage(project, 'nuxt-native');
  const overrides = pkg.overrides || {};
  const entries = Object.entries(overrides).filter(([, v]) => typeof v === 'string' && !v.startsWith('npm:'));
  assert.ok(entries.length > 0, 'the nuxt template pins plain-version overrides');
  for (const [name, range] of entries) {
    const url = 'https://registry.npmjs.org/' + encodeURIComponent(name) + '/' + encodeURIComponent(range);
    const res = await fetch(url, { headers: { Accept: 'application/vnd.npm.install-v1+json' } });
    if (res.status === 404) {
      assert.fail(name + ' override ' + range + ' does not exist on the registry (HTTP 404)');
    }
    assert.ok(res.ok, name + ' override ' + range + ' fetchable (HTTP ' + res.status + ')');
  }
});

test('the nuxt-native template package.json carries the overrides in both places npm reads', async () => {
  const templates = loadNativeTemplates();
  const project = templates.create('nuxt-native');
  const pkg = templatePackage(project, 'nuxt-native');
  /* npm reads `overrides`; pnpm reads `pnpm.overrides`. Both must agree. */
  assert.deepEqual(pkg.pnpm.overrides, pkg.overrides, 'pnpm and npm overrides are identical');
  assert.equal(pkg.overrides['@nuxt/devtools'], '3.3.1');
});

test('no native template writes a dropped-dot devtools range', () => {
  const templates = loadNativeTemplates();
  for (const def of templates.definitions) {
    const project = templates.create(def.id);
    const pkg = templatePackage(project, def.id);
    const text = JSON.stringify(pkg.overrides || {});
    assert.doesNotMatch(text, /3\.31\.1/, def.id + ' overrides never contain the bogus 3.31.1');
  }
});
