import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { loadRuntime } from './helpers/runtime.mjs';

/* A developer porting code writes `require('fs')` in one file and
 * `import fs from 'node:fs'` in another. Both spellings have to reach the same
 * module, and the error for a builtin the runtime does not ship must not send
 * anyone to npm. */

const rt = loadRuntime();
const plain = value => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));
const evaluate = async code => plain(await rt.evaluate(code));
const sync = code => plain(rt.evaluate(code));
const hostRequire = createRequire(import.meta.url);

test('every runtime module answers to both spellings', () => {
  const mismatches = sync(`(() => {
    const broken = [];
    for (const name of require('module').builtinModules) {
      try {
        const bare = require(name);
        const prefixed = require('node:' + name);
        if (bare !== prefixed) broken.push(name + ':identity');
      } catch (error) { broken.push(name + ':' + error.code); }
    }
    return broken;
  })()`);
  assert.deepEqual(mismatches, [], 'require(x) === require(node:x) for every module');
});

test('module.builtinModules covers every public builtin the running Node has', () => {
  const listed = sync('require("module").builtinModules');
  const expected = hostRequire('node:module').builtinModules.filter(name => !name.startsWith('_'));
  const missing = expected.filter(name => !listed.includes(name));
  assert.deepEqual(missing, [], 'no Node builtin is silently absent from the list');
  // The list must not advertise anything that cannot be loaded (this is how six
  // modules went missing while the list still claimed them).
  const unloadable = sync(`(() => {
    const broken = [];
    for (const name of require('module').builtinModules) {
      try { require(name); } catch { broken.push(name); }
    }
    return broken;
  })()`);
  assert.deepEqual(unloadable, []);
});

test('isBuiltin accepts both spellings and rejects everything else', () => {
  const verdicts = sync(`(() => {
    const { isBuiltin } = require('module');
    return {
      yes: ['fs', 'node:fs', 'path/win32', 'node:path/win32', 'dgram', 'wasi', 'test'].map(name => [name, isBuiltin(name)]),
      no: ['left-pad', 'node:sqlite', 'fs/promises/nope', '', '_http_agent', 'node:_stream_readable'].map(name => [name, isBuiltin(name)]),
    };
  })()`);
  for (const [name, value] of verdicts.yes) assert.equal(value, true, name + ' is a builtin');
  for (const [name, value] of verdicts.no) assert.equal(value, false, name + ' is not a builtin this runtime ships');
});

test('require.resolve keeps the requested spelling, like Node', () => {
  const resolved = sync(`(() => {
    const moduleApi = require('module');
    return ['fs', 'node:fs', 'node:path/win32', 'dgram', 'node:wasi'].map(name => [name, moduleApi._resolveFilename(name, { filename: '/project/index.js' })]);
  })()`);
  // Node echoes the request verbatim, subpaths included.
  assert.deepEqual(resolved, [['fs', 'fs'], ['node:fs', 'node:fs'], ['node:path/win32', 'node:path/win32'], ['dgram', 'dgram'], ['node:wasi', 'node:wasi']]);
  assert.equal(sync('require.resolve("node:fs")'), 'node:fs');
  assert.equal(sync('require.resolve("fs")'), 'fs');
});

test('createRequire reaches builtins through both spellings', () => {
  const result = sync(`(() => {
    const { createRequire } = require('module');
    const scoped = createRequire('/project/src/app.js');
    return [typeof scoped('node:fs').readFileSync, typeof scoped('fs').readFileSync, scoped('node:path').join('a', 'b')];
  })()`);
  assert.deepEqual(result, ['function', 'function', 'a/b']);
});

test('a builtin the runtime does not ship fails without an npm suggestion', () => {
  const result = sync(`(() => {
    try { require('node:sqlite'); return 'no throw'; }
    catch (error) { return { code: error.code, message: error.message }; }
  })()`);
  assert.equal(result.code, 'MODULE_NOT_FOUND');
  assert.match(result.message, /Cannot find module 'node:sqlite'/);
  assert.match(result.message, /does not provide/);
  assert.ok(!/npm install/.test(result.message), 'a builtin is not installable: ' + result.message);
});

test('a missing package still points at npm', () => {
  const result = sync(`(() => {
    try { require('definitely-not-installed'); return 'no throw'; }
    catch (error) { return { code: error.code, message: error.message }; }
  })()`);
  assert.equal(result.code, 'MODULE_NOT_FOUND');
  assert.match(result.message, /try: npm install definitely-not-installed/);
});

test('process.getBuiltinModule agrees with require for both spellings', () => {
  const result = sync(`(() => {
    const get = process.getBuiltinModule;
    return [typeof get, get('node:fs') === require('fs'), get('fs') === require('node:fs'), get('node:dgram') === require('dgram')];
  })()`);
  assert.deepEqual(result, ['function', true, true, true]);
});

test('an ESM module imports builtins with and without the prefix', async () => {
  await evaluate(`(() => {
    const fs = require('fs');
    fs.mkdirSync('/project/esm', { recursive: true });
    fs.writeFileSync('/project/esm/parity.mjs', [
      "import { readFileSync, writeFileSync } from 'node:fs';",
      "import path from 'path';",
      "import { createHash } from 'node:crypto';",
      'writeFileSync("/project/esm/out.txt", path.join("a", "b") + "|" + createHash("sha256").update("esm").digest("hex").slice(0, 8));',
      'const text = readFileSync("/project/esm/out.txt", "utf8");',
      'console.log(text);',
      'export default text;',
      '',
    ].join('\\n'));
    return true;
  })()`);
  const run = await rt.run('node esm/parity.mjs');
  assert.equal(run.code, 0, 'the ESM app exits cleanly: ' + run.stderr);
  assert.match(run.stdout, /a\/b\|[0-9a-f]{8}/);
  assert.equal(sync(`require('fs').readFileSync('/project/esm/out.txt', 'utf8')`), run.stdout.trim());
});

test('CommonJS and ESM interop in one project', async () => {
  await evaluate(`(() => {
    const fs = require('fs');
    fs.mkdirSync('/project/interop', { recursive: true });
    fs.writeFileSync('/project/interop/shared.cjs', 'module.exports = { add: (a, b) => a + b, name: "shared" };\\n');
    fs.writeFileSync('/project/interop/main.mjs', [
      "import shared from './shared.cjs';",
      'console.log(shared.name, shared.add(2, 3));',
      '',
    ].join('\\n'));
    return true;
  })()`);
  const run = await rt.run('node interop/main.mjs');
  assert.equal(run.code, 0, run.stderr);
  assert.match(run.stdout, /shared 5/);
});

test('the same module object is shared between the two entry styles', () => {
  const shared = sync(`(() => {
    const a = require('node:events');
    const b = require('events');
    a.__probe = 1;
    return [b.__probe, a === b];
  })()`);
  assert.deepEqual(shared, [1, true]);
});
