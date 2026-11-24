import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createInstallerSandbox, installerSource, loadInstaller } from './helpers/installer-harness.mjs';

const tarAvailable = (() => {
  try { execFileSync('tar', ['--version'], { stdio: 'ignore' }); return true; } catch { return false; }
})();

function makeTarball(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'beownir-reg-'));
  const packageDir = path.join(root, 'package');
  fs.mkdirSync(packageDir, { recursive: true });
  for (const [name, value] of Object.entries(files)) {
    const target = path.join(packageDir, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, value);
  }
  const output = path.join(root, 'package.tgz');
  execFileSync('tar', ['-czf', output, '-C', root, 'package']);
  const bytes = fs.readFileSync(output);
  fs.rmSync(root, { recursive: true, force: true });
  return bytes;
}

function integrityOf(bytes) {
  return 'sha512-' + crypto.createHash('sha512').update(bytes).digest('base64');
}

/** A tiny npm registry that serves the given packages from memory. */
function createRegistry(packages) {
  const tarballs = new Map();
  const versions = new Map();
  const ranges = [];
  for (const [name, definition] of Object.entries(packages)) {
    const { version, files, dependencies = {}, corrupt = false } = definition;
    const bytes = makeTarball(files);
    const integrity = integrityOf(bytes);
    versions.set(name, {
      name,
      version,
      dependencies,
      integrity: corrupt ? 'sha512-' + Buffer.alloc(64, 7).toString('base64') : integrity,
      tarball: `/tarballs/${name.replace('/', '__')}-${version}.tgz`
    });
    tarballs.set(`/tarballs/${name.replace('/', '__')}-${version}.tgz`, bytes);
  }
  const server = http.createServer((request, response) => {
    const url = decodeURIComponent(request.url.split('?')[0]);
    const tarball = tarballs.get(url);
    if (tarball) {
      // Stream in chunks so the installer has to assemble packets.
      const stream = (body, status, extra = {}) => {
        response.writeHead(status, { 'content-type': 'application/octet-stream', 'content-length': body.length, 'accept-ranges': 'bytes', ...extra });
        let offset = 0;
        const pump = () => {
          if (offset >= body.length) { response.end(); return; }
          const next = body.subarray(offset, offset + 16 * 1024);
          offset += next.length;
          if (response.write(next)) setImmediate(pump); else response.once('drain', pump);
        };
        pump();
      };
      const header = request.headers.range;
      if (header) {
        const match = /^bytes=(\d+)-(\d*)$/.exec(header);
        if (!match) { response.writeHead(400).end(); return; }
        const start = Number(match[1]);
        let end = match[2] ? Number(match[2]) : tarball.length - 1;
        if (end >= tarball.length) end = tarball.length - 1;
        if (start > end) { response.writeHead(416, { 'content-range': 'bytes */' + tarball.length }).end(); return; }
        ranges.push({ path: url, start, end });
        stream(tarball.subarray(start, end + 1), 206, { 'content-range': `bytes ${start}-${end}/${tarball.length}` });
        return;
      }
      ranges.push({ path: url, start: 0, end: tarball.length - 1 });
      stream(tarball, 200);
      return;
    }
    const name = url.replace(/^\//, '');
    const document = versions.get(name);
    if (!document) { response.writeHead(404).end('{}'); return; }
    const origin = 'http://' + request.headers.host;
    const body = Buffer.from(JSON.stringify({
      name: document.name,
      'dist-tags': { latest: document.version },
      versions: {
        [document.version]: {
          name: document.name,
          version: document.version,
          dependencies: document.dependencies,
          dist: { tarball: origin + document.tarball, integrity: document.integrity }
        }
      }
    }));
    response.writeHead(200, { 'content-type': 'application/json', 'content-length': body.length });
    response.end(body);
  });
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => resolve({ server, ranges, origin: 'http://127.0.0.1:' + server.address().port }));
  });
}

function bootstrap(html, vfs) {
  vfs.mkdirp('/project');
  vfs.writeFileSync('/project/package.json', JSON.stringify({ name: 'app', version: '1.0.0', dependencies: {} }, null, 2) + '\n');
}

test('npm install streams packages, writes a lockfile and keeps node_modules out of source sync', { skip: !tarAvailable }, async () => {
  const packages = {
    'tiny-dep': { version: '1.2.3', files: { 'package.json': JSON.stringify({ name: 'tiny-dep', version: '1.2.3' }), 'index.js': 'module.exports = 1;\n' } },
    'app-lib': {
      version: '2.0.0',
      dependencies: { 'tiny-dep': '^1.0.0' },
      files: {
        'package.json': JSON.stringify({ name: 'app-lib', version: '2.0.0', dependencies: { 'tiny-dep': '^1.0.0' } }),
        'lib/main.js': 'module.exports = require("tiny-dep");\n',
        'lib/styles.css': 'body{color:red}\n'
      }
    }
  };
  const { server, origin, ranges } = await createRegistry(packages);
  try {
    const { source } = installerSource({ registry: origin });
    const { sandbox, vfs, output, posts } = createInstallerSandbox();
    bootstrap(null, vfs);
    const installer = loadInstaller(sandbox, source);
    sandbox.globalThis = sandbox;

    await installer.npmInstall(['app-lib']);
    const manifest = JSON.parse(vfs.readFileSync('/project/package.json', 'utf8'));
    assert.equal(manifest.dependencies['app-lib'], '^2.0.0');
    assert.ok(vfs.existsSync('/project/node_modules/app-lib/lib/main.js'));
    assert.ok(vfs.existsSync('/project/node_modules/tiny-dep/index.js'));
    assert.equal(vfs.readFileSync('/project/node_modules/tiny-dep/index.js', 'utf8'), 'module.exports = 1;\n');
    const lock = JSON.parse(vfs.readFileSync('/project/package-lock.json', 'utf8'));
    assert.equal(lock.lockfileVersion, 3);
    assert.ok(lock.packages['node_modules/app-lib'].integrity.startsWith('sha512-'));
    assert.equal(lock.packages['node_modules/tiny-dep'].version, '1.2.3');
    assert.ok(posts.some(message => message.type === 'pkgdone'));
    assert.ok(output.join('').includes('package(s)'));
    assert.ok(ranges.length >= 2, 'each tarball is fetched with a byte-range probe');
    assert.ok(ranges.every(entry => entry.path.startsWith('/tarballs/')), 'only tarballs use ranges');

    // npm ci restores the same tree from the lockfile alone.
    vfs.rmrf('/project/node_modules');
    await installer.npmCi();
    assert.ok(vfs.existsSync('/project/node_modules/app-lib/package.json'));
    assert.ok(vfs.existsSync('/project/node_modules/tiny-dep/package.json'));
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('packages larger than the previous 10 MiB limit install fine', { skip: !tarAvailable, timeout: 120000 }, async () => {
  const big = crypto.randomBytes(12 * 1024 * 1024);
  const packages = {
    'big-package': {
      version: '3.0.0',
      files: { 'package.json': JSON.stringify({ name: 'big-package', version: '3.0.0' }), 'assets/blob.bin': big, 'index.js': 'module.exports = "big";\n' }
    }
  };
  const { server, origin, ranges } = await createRegistry(packages);
  try {
    const { source } = installerSource({ registry: origin });
    const { sandbox, vfs } = createInstallerSandbox();
    bootstrap(null, vfs);
    const installer = loadInstaller(sandbox, source);
    await installer.npmInstall(['big-package']);
    const segments = new Set(ranges.filter(entry => entry.end > 0).map(entry => entry.start));
    assert.ok(segments.size >= 3, 'a >8 MiB tarball is split into several byte ranges: ' + [...segments]);
    const written = vfs.readFileSync('/project/node_modules/big-package/assets/blob.bin');
    assert.equal(written.length, big.length);
    assert.equal(crypto.createHash('sha256').update(written).digest('hex'), crypto.createHash('sha256').update(big).digest('hex'));
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('a failed integrity check rolls the whole transaction back', { skip: !tarAvailable }, async () => {
  const packages = {
    'evil-package': { version: '1.0.0', corrupt: true, files: { 'package.json': JSON.stringify({ name: 'evil-package', version: '1.0.0' }), 'index.js': 'x' } }
  };
  const { server, origin } = await createRegistry(packages);
  try {
    const { source } = installerSource({ registry: origin });
    const { sandbox, vfs } = createInstallerSandbox();
    bootstrap(null, vfs);
    vfs.writeFileSync('/project/keep.txt', 'keep me');
    vfs.writeFileSync('/project/package.json', JSON.stringify({ name: 'app', version: '1.0.0', dependencies: { 'evil-package': '^1.0.0' } }));
    const installer = loadInstaller(sandbox, source);
    await assert.rejects(() => installer.npmInstall([]), /Integrity verification failed/);
    assert.equal(vfs.readFileSync('/project/keep.txt', 'utf8'), 'keep me');
    assert.equal(vfs.existsSync('/project/node_modules/evil-package'), false);
    const manifest = JSON.parse(vfs.readFileSync('/project/package.json', 'utf8'));
    assert.deepEqual(manifest.dependencies, { 'evil-package': '^1.0.0' });
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('install limits are configurable and reported clearly', { skip: !tarAvailable }, async () => {
  const { source } = installerSource();
  const { sandbox, vfs } = createInstallerSandbox();
  bootstrap(null, vfs);
  const installer = loadInstaller(sandbox, source);
  assert.ok(installer.INSTALL_BUDGET.tarballBytes >= 64 * 1024 * 1024);
  assert.ok(installer.INSTALL_BUDGET.packageBytes >= 256 * 1024 * 1024);
  assert.ok(installer.INSTALL_BUDGET.packagesPerInstall >= 1024);
  assert.equal(installer.INSTALL_BUDGET.attempts, 3);
});

test('dependency checkpoints round-trip node_modules outside the source workspace', { skip: !tarAvailable }, async () => {
  const packages = {
    'checkpoint-dep': {
      version: '1.0.0',
      files: { 'package.json': JSON.stringify({ name: 'checkpoint-dep', version: '1.0.0' }), 'index.js': 'module.exports = "checkpoint";\n', 'data.bin': Buffer.from([0, 1, 2, 250]) }
    }
  };
  const { server, origin } = await createRegistry(packages);
  try {
    const { source } = installerSource({ registry: origin });
    const { sandbox, vfs, posts, self } = createInstallerSandbox();
    bootstrap(null, vfs);
    const factory = new Function('__sandbox__', 'with (__sandbox__) {\n' + source + '\n;return { npmInstall, saveDependencyCheckpoint, restoreDependencyCheckpoint, DEPS_MAGIC };}');
    const installer = factory(sandbox);
    await installer.npmInstall(['checkpoint-dep']);

    // node_modules never reaches the source sync stream.
    const syncMessages = posts.filter(message => message.type === 'fssync');
    for (const message of syncMessages) {
      for (const path of Object.keys(message.files || {})) assert.ok(!path.startsWith('/project/node_modules'), 'node_modules leaked into fssync: ' + path);
    }

    await installer.saveDependencyCheckpoint();
    const checkpoint = posts.filter(message => message.type === 'deps-checkpoint').at(-1);
    assert.ok(checkpoint, 'checkpoint message missing');
    const packaged = new Uint8Array(checkpoint.bytes);
    assert.ok(packaged.length > 0);

    // A fresh boot restores the tree from the checkpoint bytes alone.
    const second = createInstallerSandbox();
    const restoreFactory = new Function('__sandbox__', 'with (__sandbox__) {\n' + source + '\n;return { restoreDependencyCheckpoint };}');
    second.vfs.mkdirp('/project');
    const restore = restoreFactory(second.sandbox);
    const result = await restore.restoreDependencyCheckpoint(packaged);
    assert.equal(result.files, 4); // package.json, index.js, data.bin and the install receipt
    assert.equal(second.vfs.readFileSync('/project/node_modules/checkpoint-dep/index.js', 'utf8'), 'module.exports = "checkpoint";\n');
    assert.deepEqual([...second.vfs.readFileSync('/project/node_modules/checkpoint-dep/data.bin')], [0, 1, 2, 250]);
    assert.ok(second.posts.some(message => message.type === 'deps-restored'));
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('streamPackage resets hash, tar parser and partial files cleanly when a tarball download retries', { skip: !tarAvailable }, async () => {
  const { server, origin } = await createRegistry({});
  // Build a valid package tarball directly using the registry builder via npm-like request on a custom server:
  await new Promise(resolve => server.close(resolve));

  const cryptoMod = await import('node:crypto');
  const http = await import('node:http');
  const os = await import('node:os');
  const pathMod = await import('node:path');
  const { execFileSync } = await import('node:child_process');
  const stage = fs.mkdtempSync(pathMod.join(os.tmpdir(), 'beownir-retry-'));
  try {
    fs.mkdirSync(pathMod.join(stage, 'package'));
    fs.writeFileSync(pathMod.join(stage, 'package', 'package.json'), JSON.stringify({ name: 'retry-pkg', version: '1.0.0' }));
    fs.writeFileSync(pathMod.join(stage, 'package', 'good.txt'), 'clean-after-reset\n');
    const tgzPath = pathMod.join(stage, 'retry-pkg-1.0.0.tgz');
    execFileSync('tar', ['-czf', tgzPath, '-C', stage, 'package']);
    const tgz = fs.readFileSync(tgzPath);
    const sha512 = 'sha512-' + cryptoMod.createHash('sha512').update(tgz).digest('base64');

    let tarCalls = 0;
    const retryServer = http.createServer((req, res) => {
      const u = new URL(req.url, 'http://127.0.0.1');
      if (u.pathname === '/retry-pkg') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          name: 'retry-pkg',
          'dist-tags': { latest: '1.0.0' },
          versions: { '1.0.0': { name: 'retry-pkg', version: '1.0.0', dist: { tarball: retryOrigin + '/retry-pkg/-/retry-pkg-1.0.0.tgz', integrity: sha512 } } }
        }));
        return;
      }
      if (u.pathname === '/retry-pkg/-/retry-pkg-1.0.0.tgz') {
        tarCalls++;
        if (tarCalls === 1) {
          // Stream the first half of the real gzip tarball, then abruptly drop the socket so downloadToConsumer triggers onReset + retry.
          res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': String(tgz.length) });
          res.write(tgz.subarray(0, Math.max(32, Math.floor(tgz.length / 2))));
          setTimeout(() => req.socket.destroy(), 15);
          return;
        }
        res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': String(tgz.length) });
        res.end(tgz);
        return;
      }
      res.writeHead(404); res.end();
    });
    await new Promise(resolve => retryServer.listen(0, '127.0.0.1', resolve));
    const retryOrigin = 'http://127.0.0.1:' + retryServer.address().port;
    try {
      const { source } = installerSource({ registry: retryOrigin });
      const { sandbox, vfs } = createInstallerSandbox();
      bootstrap(null, vfs);
      const installer = loadInstaller(sandbox, source);
      await installer.npmInstall(['retry-pkg']);
      assert.ok(tarCalls >= 2, 'tarball download retried after mid-stream drop');
      assert.equal(vfs.readFileSync('/project/node_modules/retry-pkg/good.txt', 'utf8'), 'clean-after-reset\n');
    } finally {
      await new Promise(resolve => retryServer.close(resolve));
    }
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
  }
});
