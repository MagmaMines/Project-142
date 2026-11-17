import test from 'node:test';
import assert from 'node:assert/strict';
import { loadRuntime } from './helpers/runtime.mjs';

/* The runtime loads ESM-only packages (preact 11, vite, svelte 5) by rewriting
 * static import/export into CommonJS bindings. These tests drive the real
 * loader in the VM, with hand-written modules that cover the syntax Node
 * accepts, so a regression fails here instead of inside a framework install. */

const rt = loadRuntime();

const write = files => {
  for (const [path, contents] of Object.entries(files)) {
    rt.FS[path] = typeof contents === 'string' ? { c: contents, m: Date.now() } : contents;
  }
};
const dir = path => { rt.FS[path] = { d: true, m: Date.now() }; };
const requireFrom = path => rt.evaluate(`CORE.module.createRequire(${JSON.stringify(path)})`);
const load = (spec, from = '/project/index.js') => {
  const req = requireFrom(from);
  return req(spec);
};

test('default, named and namespace imports resolve through the loader', () => {
  dir('/project/esm');
  write({
    '/project/esm/math.mjs': `export const add = (a, b) => a + b;
export const pi = 3.5;
export default function double(value) { return value * 2; }`,
    '/project/esm/use.mjs': `import double, { add, pi } from './math.mjs';
import * as math from './math.mjs';
export const sum = add(pi, 1);
export const doubled = double(4);
export const namespaceKeys = Object.keys(math).sort().join(',');`,
  });
  const use = load('/project/esm/use.mjs');
  assert.equal(use.sum, 4.5);
  assert.equal(use.doubled, 8);
  assert.equal(use.namespaceKeys, 'add,default,pi', 'export default function keeps the function private');
});

test('re-exports, star exports and export lists keep live getters', () => {
  write({
    '/project/esm/a.mjs': `export const a = 1; export default 'A';`,
    '/project/esm/b.mjs': `export const b = 2;`,
    '/project/esm/barrel.mjs': `export * from './a.mjs';
export * from './b.mjs';
export { a as firstA } from './a.mjs';
export const local = 3;`,
  });
  const barrel = load('/project/esm/barrel.mjs');
  assert.equal(barrel.a, 1);
  assert.equal(barrel.b, 2);
  assert.equal(barrel.firstA, 1);
  assert.equal(barrel.local, 3);
  assert.equal(barrel.default, undefined, 'export * never re-exports default');
});

test('a "type":"module" package makes .js files ESM', () => {
  dir('/project/node_modules/modern');
  write({
    '/project/node_modules/modern/package.json': JSON.stringify({ name: 'modern', version: '1.0.0', type: 'module', main: 'index.js' }),
    '/project/node_modules/modern/index.js': `export const flavour = 'esm'; export default function greet(who) { return 'hi ' + who; }`,
  });
  const modern = load('modern');
  assert.equal(modern.flavour, 'esm');
  assert.equal(modern.default('beownir'), 'hi beownir');
});

test('require(esm) and import of CommonJS interop both ways', () => {
  write({
    '/project/esm/legacy.cjs': `module.exports = function legacy() { return 'cjs'; }; module.exports.extra = 7;`,
    '/project/esm/bridge.mjs': `import legacy from './legacy.cjs';
export const value = legacy();
export const extra = legacy.extra;`,
  });
  const bridge = load('/project/esm/bridge.mjs');
  assert.equal(bridge.value, 'cjs');
  assert.equal(bridge.extra, 7);
  const namespace = load('/project/esm/math.mjs');
  assert.equal(namespace.__esModule, true);
  assert.equal(Object.prototype.toString.call(namespace), '[object Module]');
});

test('import.meta and dynamic import work inside ES modules', async () => {
  write({
    '/project/esm/meta.mjs': `export const here = import.meta.url;
export const folder = import.meta.dirname;
export const loaded = () => import('./math.mjs').then(mod => mod.add(2, 3));`,
  });
  const meta = load('/project/esm/meta.mjs');
  assert.equal(meta.here, 'file:///project/esm/meta.mjs');
  assert.equal(meta.folder, '/project/esm');
  const req = requireFrom('/project/index.js');
  const math = req('/project/esm/math.mjs');
  assert.equal(math.default(21), 42);
});

test('dynamic import resolves to a namespace promise', async () => {
  const result = await rt.evaluate(`CORE.module.createRequire('/project/esm/meta.mjs')('/project/esm/meta.mjs').loaded()`);
  assert.equal(result, 5);
});

test('top-level await fails with the same code Node uses', () => {
  write({ '/project/esm/tla.mjs': `export const ready = await Promise.resolve('later');` });
  assert.throws(() => load('/project/esm/tla.mjs'), error => error.code === 'ERR_REQUIRE_ASYNC_MODULE' && /top-level await/.test(error.message));
});

test('strings, comments and regexes that look like imports are left alone', () => {
  write({
    '/project/esm/tricky.mjs': `const text = "import x from 'y'";
const template = \`export default \${text}\`;
// export const fake = 1;
/* import fake from 'nothing' */
const pattern = /export\\s+default/;
export const real = pattern.test('export default 1;') ? 'regex' : 'none';
export const composed = template;
export const quoted = text;`,
  });
  const tricky = load('/project/esm/tricky.mjs');
  assert.equal(tricky.real, 'regex', 'a regex literal containing export syntax is untouched');
  assert.equal(tricky.composed, "export default import x from 'y'");
  assert.equal(tricky.quoted, "import x from 'y'", 'a string mentioning an import is untouched');
  assert.equal(tricky.fake, undefined, 'commented-out exports do not leak');
});

test('circular imports behave like Node instead of hanging', () => {
  write({
    '/project/esm/ping.mjs': `import { pong } from './pong.mjs';
export const ping = 'ping';
export const combined = () => pong() + ping;`,
    '/project/esm/pong.mjs': `import { ping } from './ping.mjs';
export const pong = () => 'pong';
export const fromPing = () => ping;`,
  });
  const ping = load('/project/esm/ping.mjs');
  assert.equal(ping.ping, 'ping');
  assert.equal(typeof ping.combined, 'function');
});

test('subpath exports map through package.json "exports"', () => {
  dir('/project/node_modules/featured');
  dir('/project/node_modules/featured/dist');
  write({
    '/project/node_modules/featured/package.json': JSON.stringify({
      name: 'featured', version: '1.0.0', type: 'module',
      exports: { '.': { import: './dist/main.mjs', default: './dist/main.mjs' }, './helper': './dist/helper.mjs', './*': './dist/*.mjs' },
    }),
    '/project/node_modules/featured/dist/main.mjs': `export const main = 'main';`,
    '/project/node_modules/featured/dist/helper.mjs': `export const helper = 'helper';`,
    '/project/node_modules/featured/dist/extra.mjs': `export const extra = 'extra';`,
  });
  assert.equal(load('featured').main, 'main');
  assert.equal(load('featured/helper').helper, 'helper');
  assert.equal(load('featured/extra').extra, 'extra');
  assert.throws(() => load('featured/missing'), error => error.code === 'MODULE_NOT_FOUND');
});

test('a CommonJS file can dynamic-import an ES module', async () => {
  write({
    '/project/esm/bridge.cjs': `exports.load = () => import('./math.mjs').then(mod => mod.add(20, 22));`,
  });
  const bridge = load('/project/esm/bridge.cjs');
  assert.equal(await bridge.load(), 42);
});

test('import.meta is available even when a module declares __dirname itself', () => {
  write({
    '/project/esm/selfdir.mjs': `const __dirname = '/declared/inside/the/module';
export const folder = __dirname;
export const meta = import.meta.dirname;`,
  });
  const module = load('/project/esm/selfdir.mjs');
  assert.equal(module.folder, '/declared/inside/the/module');
  assert.equal(module.meta, '/project/esm');
});

test('destructuring exports and export * from CommonJS work', () => {
  write({
    '/project/esm/pattern.mjs': `export const { alpha, beta: renamed, ...remaining } = { alpha: 1, beta: 2, gamma: 3 };
export const [first, , third = 30] = [10, 20];
export let counter = 0;
export const bump = () => { counter += 1; return counter; };`,
    '/project/esm/legacy2.cjs': `exports.legacyA = 'a'; exports.legacyB = 'b';`,
    '/project/esm/star-cjs.mjs': `export * from './legacy2.cjs';`,
  });
  const pattern = load('/project/esm/pattern.mjs');
  assert.equal(pattern.alpha, 1);
  assert.equal(pattern.renamed, 2);
  assert.deepEqual({ ...pattern.remaining }, { gamma: 3 });
  assert.equal(pattern.first, 10);
  assert.equal(pattern.third, 30);
  assert.equal(pattern.counter, 0);
  pattern.bump();
  assert.equal(pattern.counter, 1, 'exported let stays live through the getter');
  const star = load('/project/esm/star-cjs.mjs');
  assert.equal(star.legacyA, 'a');
  assert.equal(star.legacyB, 'b');
});

test('import() of a Node builtin resolves to its namespace', async () => {
  write({ '/project/esm/builtin.mjs': `export const load = () => import('node:path').then(mod => mod.join('/a', 'b'));` });
  assert.equal(await load('/project/esm/builtin.mjs').load(), '/a/b');
});
