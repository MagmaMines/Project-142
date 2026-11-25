import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

/* workspace-cache.cjs runs inside the WASIX guest. Its filesystem is a plain
 * directory, so the real module can be exercised against a temp directory. */

const require = createRequire(import.meta.url);
const modulePath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'o', 'native', 'workspace-cache.cjs');

function load(root) {
  process.env.BEOWNIR_WORKSPACE_ROOT = root;
  delete require.cache[modulePath];
  return require(modulePath);
}

function workspace() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beownir-cache-'));
  const write = (name, contents = '') => {
    const target = path.join(dir, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, contents);
  };
  write('package.json', JSON.stringify({ name: 'app', version: '1.0.0', dependencies: { next: '16.4.3' } }));
  write('app/page.js', 'export default function Page() { return null; }\n');
  write('node_modules/next/package.json', JSON.stringify({ name: 'next', version: '16.4.3' }));
  write('node_modules/next/dist/server.js', 'module.exports = 1;\n');
  write('node_modules/.bin/next', '#!/usr/bin/env node\n');
  fs.chmodSync(path.join(dir, 'node_modules/.bin/next'), 0o755);
  write('node_modules/.pnpm/lock.yaml', 'lockfile\n');
  write('packages/plugin/node_modules/plugin/package.json', JSON.stringify({ name: 'plugin', version: '2.0.0' }));
  write('dist/app.js', 'console.log(1);\n');
  write('.next/server/page.js', 'compiled\n');
  write('.next/cache/webpack/x.pack', 'cache\n');
  write('.beownir/npm-cache/_cacache/index', 'tarballs\n');
  write('.beownir/global/bin/tool', '#!/bin/sh\n');
  return { dir, write, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

const listAll = dir => {
  const out = [];
  const walk = rel => {
    for (const entry of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
      const name = rel ? rel + '/' + entry.name : entry.name;
      if (entry.isDirectory()) { out.push(name + '/'); walk(name); } else out.push(name);
    }
  };
  walk('');
  return out;
};

test('pack stores dependencies and build output but never rebuildable caches', () => {
  const ws = workspace();
  try {
    const cache = load(ws.dir);
    const checkpoint = path.join(ws.dir, '.beownir', 'checkpoint.bin');
    fs.mkdirSync(path.join(ws.dir, '.beownir'), { recursive: true });
    const info = cache.pack(checkpoint);
    assert.ok(fs.existsSync(checkpoint));
    assert.equal(info.rootModulesComplete, true);
    assert.deepEqual(info.dependencyNames, ['next']);
    assert.equal(typeof info.fingerprint, 'string');
    assert.equal(info.fingerprint.length, 64);

    // A restore target holds the source (copied by the supervisor) but no deps.
    const restored = fs.mkdtempSync(path.join(os.tmpdir(), 'beownir-restore-'));
    try {
      fs.copyFileSync(path.join(ws.dir, 'package.json'), path.join(restored, 'package.json'));
      const target = load(restored);
      const result = target.restore(checkpoint, info.fingerprint);
      const files = listAll(restored);
      assert.ok(files.includes('node_modules/next/dist/server.js'), 'node_modules is restored');
      assert.ok(files.includes('node_modules/.pnpm/lock.yaml'), 'pnpm links directory is restored');
      assert.ok(files.includes('packages/plugin/node_modules/plugin/package.json'), 'nested node_modules is restored');
      assert.ok(files.includes('dist/app.js'), 'dist is restored');
      assert.ok(files.includes('.beownir/global/bin/tool'), 'global bins are restored');
      assert.ok(!files.some(name => name.startsWith('.next')), '.next is not checkpointed: ' + files.filter(name => name.startsWith('.next')));
      assert.ok(!files.some(name => name.includes('npm-cache')), 'the npm cache is not checkpointed');
      assert.ok(!files.some(name => name.startsWith('.beownir/restore-')), 'no staging directory is left behind');
      assert.ok(result.roots.includes('node_modules'));
      assert.equal(fs.statSync(path.join(restored, 'node_modules/.bin/next')).mode & 0o111, 0o111, 'executable bits survive');
      assert.equal(fs.readFileSync(path.join(restored, 'node_modules/next/dist/server.js'), 'utf8'), 'module.exports = 1;\n');
    } finally {
      fs.rmSync(restored, { recursive: true, force: true });
    }
  } finally {
    ws.cleanup();
  }
});

test('restore replaces the old tree in place instead of keeping a second copy', () => {
  const ws = workspace();
  try {
    const cache = load(ws.dir);
    const checkpoint = path.join(ws.dir, 'checkpoint.bin');
    const info = cache.pack(checkpoint);
    // Simulate a stale, larger tree from an earlier install.
    ws.write('node_modules/old-package/index.js', 'stale\n');
    ws.write('node_modules/next/dist/extra-chunk.js', 'stale\n');
    cache.restore(checkpoint, info.fingerprint);
    assert.ok(!fs.existsSync(path.join(ws.dir, 'node_modules/old-package')), 'stale packages are gone');
    assert.ok(!fs.existsSync(path.join(ws.dir, 'node_modules/next/dist/extra-chunk.js')), 'stale files inside a package are gone');
    assert.ok(fs.existsSync(path.join(ws.dir, 'node_modules/next/dist/server.js')));
    assert.ok(!fs.readdirSync(path.join(ws.dir, '.beownir')).some(name => name.startsWith('restore-')), 'nothing is staged under .beownir');
    // Source files are untouched: the checkpoint only owns dependency/build roots.
    assert.equal(fs.readFileSync(path.join(ws.dir, 'app/page.js'), 'utf8'), 'export default function Page() { return null; }\n');
  } finally {
    ws.cleanup();
  }
});

test('a corrupt checkpoint fails before any file is removed', () => {
  const ws = workspace();
  try {
    const cache = load(ws.dir);
    const checkpoint = path.join(ws.dir, 'broken.bin');
    const zlib = require('node:zlib');
    fs.writeFileSync(checkpoint, zlib.gzipSync(Buffer.concat([Buffer.from('BNPK2\n'), Buffer.from([9, 0, 0, 0]), Buffer.from('{"path"')])));
    assert.throws(() => cache.restore(checkpoint), /Invalid checkpoint header/);
    assert.ok(fs.existsSync(path.join(ws.dir, 'node_modules/next/dist/server.js')), 'the existing tree is intact');
  } finally {
    ws.cleanup();
  }
});

test('checkpoints from older builds that contain .next still restore', () => {
  const ws = workspace();
  try {
    const cache = load(ws.dir);
    const checkpoint = path.join(ws.dir, 'legacy.bin');
    const info = cache.pack(checkpoint);
    // Re-pack by hand, injecting a .next entry the current packer would skip.
    const zlib = require('node:zlib');
    const raw = zlib.gunzipSync(fs.readFileSync(checkpoint));
    const meta = Buffer.from(JSON.stringify({ path: '.next/server/page.js', type: 'file', size: 8, mode: 0o644 }));
    const length = Buffer.alloc(4);
    length.writeUInt32LE(meta.length);
    const next = zlib.gzipSync(Buffer.concat([raw, length, meta, Buffer.from('compiled')]));
    fs.writeFileSync(checkpoint, next);
    // A fresh guest has the source but not the old build output.
    const restored = fs.mkdtempSync(path.join(os.tmpdir(), 'beownir-legacy-'));
    try {
      fs.copyFileSync(path.join(ws.dir, 'package.json'), path.join(restored, 'package.json'));
      const result = load(restored).restore(checkpoint, info.fingerprint);
      assert.deepEqual(result.skippedRoots, ['.next']);
      assert.ok(!fs.existsSync(path.join(restored, '.next/server/page.js')), 'unknown roots are skipped, not written');
      assert.ok(fs.existsSync(path.join(restored, 'node_modules/next/dist/server.js')));
    } finally {
      fs.rmSync(restored, { recursive: true, force: true });
    }
  } finally {
    ws.cleanup();
  }
});

test('a different dependency fingerprint is refused', () => {
  const ws = workspace();
  try {
    const cache = load(ws.dir);
    const checkpoint = path.join(ws.dir, 'checkpoint.bin');
    cache.pack(checkpoint);
    ws.write('package.json', JSON.stringify({ name: 'app', version: '1.0.0', dependencies: { next: '15.0.0' } }));
    assert.throws(() => cache.restore(checkpoint, 'a'.repeat(64)), /fingerprint differs/);
  } finally {
    ws.cleanup();
  }
});

test('gc frees caches, the checkpoint file and stale staging directories', () => {
  const ws = workspace();
  try {
    const cache = load(ws.dir);
    ws.write('.beownir/checkpoint.bin', Buffer.alloc(4096));
    ws.write('.beownir/restore-deadbeef/node_modules/x/index.js', 'leftover\n');
    const before = ['node_modules/next/dist/server.js', '.next/cache/webpack/x.pack', '.beownir/npm-cache/_cacache/index'];
    for (const name of before) assert.ok(fs.existsSync(path.join(ws.dir, name)), name + ' exists before gc');
    const result = cache.gc();
    assert.ok(result.freedBytes > 4096, 'gc reports the reclaimed bytes: ' + result.freedBytes);
    const paths = result.freed.map(entry => entry.path);
    for (const gone of ['.next/cache', '.beownir/npm-cache', '.beownir/checkpoint.bin', '.beownir/restore-deadbeef']) {
      assert.ok(paths.includes(gone), 'gc removed ' + gone + ' (freed: ' + paths.join(', ') + ')');
    }
    assert.ok(!fs.existsSync(path.join(ws.dir, '.next/cache')));
    assert.ok(!fs.existsSync(path.join(ws.dir, '.beownir/npm-cache')));
    assert.ok(!fs.existsSync(path.join(ws.dir, '.beownir/restore-deadbeef')));
    // Dependencies and source are never touched by gc.
    assert.ok(fs.existsSync(path.join(ws.dir, 'node_modules/next/dist/server.js')));
    assert.ok(fs.existsSync(path.join(ws.dir, 'app/page.js')));
    assert.ok(fs.existsSync(path.join(ws.dir, '.next/server/page.js')), 'other .next output stays');
  } finally {
    ws.cleanup();
  }
});

test('the CLI prints JSON for pack, restore, gc and fingerprint', () => {
  const ws = workspace();
  try {
    const { execFileSync } = require('node:child_process');
    const run = args => execFileSync(process.execPath, [modulePath, ...args], {
      env: { ...process.env, BEOWNIR_WORKSPACE_ROOT: ws.dir },
      encoding: 'utf8'
    }).trim();
    const info = JSON.parse(run(['pack', path.join(ws.dir, 'checkpoint.bin')]).split('\n').at(-1));
    assert.equal(info.rootModulesComplete, true);
    const restored = JSON.parse(run(['restore', path.join(ws.dir, 'checkpoint.bin'), info.fingerprint]));
    assert.ok(restored.entries > 0);
    const freed = JSON.parse(run(['gc']));
    assert.ok(Array.isArray(freed.freed));
    const fingerprint = JSON.parse(run(['fingerprint'])).fingerprint;
    assert.equal(fingerprint, info.fingerprint);
  } finally {
    ws.cleanup();
  }
});

test('symlinks resolving directly to the workspace root pack and restore cleanly', () => {
  const ws = workspace();
  try {
    fs.mkdirSync(path.join(ws.dir, 'node_modules', 'self-link'), { recursive: true });
    fs.symlinkSync('../..', path.join(ws.dir, 'node_modules', 'self-link', 'root'));
    const cache = load(ws.dir);
    const checkpoint = path.join(ws.dir, '.beownir', 'root-link.bin');
    const info = cache.pack(checkpoint);
    assert.ok(info.entries > 0);
    fs.rmSync(path.join(ws.dir, 'node_modules', 'self-link'), { recursive: true, force: true });
    cache.restore(checkpoint);
    assert.equal(fs.readlinkSync(path.join(ws.dir, 'node_modules', 'self-link', 'root')), '../..');
  } finally {
    ws.cleanup();
  }
});

test('portable-subprocess accepts ArrayBuffer and SharedArrayBuffer inputs', () => {
  const vm = require('node:vm');
  const subPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'o', 'native', 'portable-subprocess.cjs');
  const source = fs.readFileSync(subPath, 'utf8');
  const seen = [];
  const cpStub = { spawnSync: null, execFileSync: null, execSync: null };
  const fakeRequire = id => {
    if (id === 'node:child_process') return cpStub;
    if (id === 'node:url') return { fileURLToPath: x => String(x) };
    if (id === 'node:module') return { syncBuiltinESMExports() {} };
    throw new Error('unexpected require: ' + id);
  };
  const mod = { exports: {} };
  const ctx = {
    require: fakeRequire,
    module: mod,
    exports: mod.exports,
    process: { cwd: () => '/workspace', env: {} },
    Buffer,
    Uint8Array,
    ArrayBuffer,
    SharedArrayBuffer,
    URL,
    TypeError,
    RangeError,
    Error,
    globalThis: {
      __beownirSyscallSync(req) {
        seen.push(Array.from(req.input));
        return { pid: 1, status: 0, stdout: req.input, stderr: new Uint8Array() };
      },
    },
  };
  vm.runInNewContext(source, ctx, { filename: 'portable-subprocess.cjs' });
  cpStub.spawnSync('cat', [], { input: new Uint8Array([0x10, 0x80, 0xff]).buffer });
  const sab = new SharedArrayBuffer(2);
  new Uint8Array(sab).set([0x41, 0x42]);
  cpStub.spawnSync('cat', [], { input: sab });
  assert.deepEqual(seen, [[0x10, 0x80, 0xff], [0x41, 0x42]]);
});

test('package-manager verifyMaterialized handles empty manifests without node_modules and npm: aliases', () => {
  const vm = require('node:vm');
  const pmPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'o', 'native', 'package-manager.cjs');
  const pmSource = fs.readFileSync(pmPath, 'utf8');
  const fnMatch = pmSource.match(/function within[\s\S]*?\nfunction writeMaterializationReceipt/);
  assert.ok(fnMatch, 'verifyMaterialized helper exists in package-manager.cjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beownir-pm-'));
  try {
    const snippet = fnMatch[0].replace(/\nfunction writeMaterializationReceipt$/, '');
    const fn = vm.runInNewContext(
      '(function(fs, path, manager) {\n' + snippet + '\nreturn verifyMaterialized;\n})',
      {},
    )(fs, path, 'npm');

    // Empty dependencies with absent node_modules (e.g. after uninstalling last package)
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'empty', version: '1.0.0', dependencies: {} }));
    const emptyRes = fn(dir);
    assert.equal(emptyRes.directDependencies, 0);
    assert.equal(emptyRes.nodeModules, null);

    // npm: alias package points to node_modules/my-ms whose package.json declares name: "ms"
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'aliased', version: '1.0.0', dependencies: { 'my-ms': 'npm:ms@^2.1.3', '@my/pkg': 'npm:@real/pkg@^1.0.0' } }));
    fs.mkdirSync(path.join(dir, 'node_modules', 'my-ms'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'node_modules', 'my-ms', 'package.json'), JSON.stringify({ name: 'ms', version: '2.1.3' }));
    fs.mkdirSync(path.join(dir, 'node_modules', '@my', 'pkg'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'node_modules', '@my', 'pkg', 'package.json'), JSON.stringify({ name: '@real/pkg', version: '1.2.0' }));
    const aliasRes = fn(dir);
    assert.equal(aliasRes.directDependencies, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
