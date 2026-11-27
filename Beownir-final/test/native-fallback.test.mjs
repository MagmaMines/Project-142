import test from 'node:test';
import assert from 'node:assert/strict';
import { loadRuntime } from './helpers/runtime.mjs';

/* The JS-only native-addon fallback: a browser cannot execute .node binaries,
 * so when the ecosystem ships a JavaScript/WASM build of the same package the
 * resolver loads that instead (Next.js → @next/swc-wasm-nodejs is the case
 * that matters), and when there is none the require fails with ENOSYS naming
 * the package and the fix — never a silent no-op. */

const rt = loadRuntime();
const fs = rt.CORE.fs;

const makePackage = (name, main, body) => {
  const dir = '/project/node_modules/' + name;
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(dir + '/package.json', JSON.stringify({ name, main }));
  fs.writeFileSync(dir + '/' + main, body);
};

const requireFromProject = spec => rt.evaluate(
  `(() => { const require = CORE.module.createRequire('/project/index.js'); return require(${JSON.stringify(spec)}); })()`,
);

test('a mapped native binding loads its installed JS-only fallback', () => {
  makePackage('@next/swc-linux-x64-gnu', 'binding.node', 'not really a binary');
  makePackage('@next/swc-wasm-nodejs', 'index.js', "module.exports = { transform: () => 'JS_FALLBACK_OK' };\n");
  const binding = requireFromProject('@next/swc-linux-x64-gnu');
  assert.equal(binding.transform(), 'JS_FALLBACK_OK');
  /* The same binding reached through process.dlopen gets the same treatment. */
  const viaDlopen = rt.evaluate(`(() => {
    const mod = { exports: {} };
    CORE.process.dlopen(mod, '/project/node_modules/@next/swc-linux-x64-gnu/binding.node');
    return mod.exports.transform();
  })()`);
  assert.equal(viaDlopen, 'JS_FALLBACK_OK');
});

test('a missing fallback fails with ENOSYS and names the package to install', () => {
  makePackage('@next/swc-darwin-arm64', 'binding.node', 'binary');
  /* Test 1 installed the wasm package; this row must see it gone. */
  fs.rmSync('/project/node_modules/@next/swc-wasm-nodejs', { recursive: true, force: true });
  assert.throws(
    () => requireFromProject('@next/swc-darwin-arm64'),
    error => error.code === 'ENOSYS'
      && /@next\/swc-darwin-arm64/.test(error.message)
      && /npm install @next\/swc-wasm-nodejs/.test(error.message),
  );
});

test('an unknown native addon fails with ENOSYS and points at the override', () => {
  makePackage('totally-native', 'native.node', 'binary');
  assert.throws(
    () => requireFromProject('totally-native'),
    error => error.code === 'ENOSYS'
      && /totally-native/.test(error.message)
      && /BEOWNIR_NATIVE_FALLBACK/.test(error.message),
  );
});

test('BEOWNIR_NATIVE_FALLBACK maps packages the runtime does not know', () => {
  makePackage('weird-native', 'w.node', 'binary');
  makePackage('weird-js', 'index.js', "module.exports = { loaded: 'override' };\n");
  rt.CORE.process.env.BEOWNIR_NATIVE_FALLBACK = '{"weird-native":"weird-js"}';
  try {
    assert.equal(requireFromProject('weird-native').loaded, 'override');
  } finally {
    delete rt.CORE.process.env.BEOWNIR_NATIVE_FALLBACK;
  }
});

test('the override can also steer a known mapping elsewhere', () => {
  makePackage('@swc/core-win32-x64-msvc', 'core.node', 'binary');
  makePackage('my-swc-js', 'index.js', "module.exports = { source: 'redirected' };\n");
  rt.CORE.process.env.BEOWNIR_NATIVE_FALLBACK = '{"@swc/core-win32-x64-msvc":"my-swc-js"}';
  try {
    assert.equal(requireFromProject('@swc/core-win32-x64-msvc').source, 'redirected');
  } finally {
    delete rt.CORE.process.env.BEOWNIR_NATIVE_FALLBACK;
  }
});

test('plain JavaScript packages do not take the fallback path', () => {
  makePackage('plain-js', 'index.js', "module.exports = { plain: true };\n");
  assert.equal(requireFromProject('plain-js').plain, true);
});

test('rolldown, oxc and generic -wasm32-wasi bindings resolve via fallback or report WASM sibling', () => {
  makePackage('@rolldown/binding-linux-x64-gnu', 'index.node', 'ELF');
  assert.throws(
    () => requireFromProject('@rolldown/binding-linux-x64-gnu'),
    error => error.code === 'ENOSYS' && /@rolldown\/binding-wasm32-wasi/.test(error.message),
  );
  makePackage('@rolldown/binding-wasm32-wasi', 'index.js', 'module.exports = { wasiRolldown: true };\n');
  assert.equal(requireFromProject('@rolldown/binding-linux-x64-gnu').wasiRolldown, true);

  makePackage('@acme/tool-darwin-arm64', 'native.node', 'MACHO');
  makePackage('@acme/tool-wasm32-wasi', 'index.js', 'module.exports = { genericWasi: true };\n');
  assert.equal(requireFromProject('@acme/tool-darwin-arm64').genericWasi, true);
});
