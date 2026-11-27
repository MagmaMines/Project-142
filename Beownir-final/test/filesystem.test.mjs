import test from 'node:test';
import assert from 'node:assert/strict';
import { loadRuntime } from './helpers/runtime.mjs';

/* Filesystem semantics that real packages rely on: a root inode, real
 * permission bits, and cp() refusing a directory unless it is recursive. */

const rt = loadRuntime();
const fs = rt.CORE.fs;

async function withScratch(fn) {
  rt.restore();
  await rt.run('mkdir -p /project/scratch');
  try { await fn(); } finally { rt.restore(); }
}

test('the virtual filesystem has a root directory', () => withScratch(async () => {
  assert.equal(fs.existsSync('/'), true);
  assert.equal(fs.statSync('/').isDirectory(), true);
  assert.ok(fs.readdirSync('/').includes('project'));
  assert.equal(fs.realpathSync('/'), '/');
  assert.equal((await rt.run('cd / && pwd')).stdout, '/\n');
  assert.equal((await rt.run('cd ~ && pwd')).stdout, '/\n');
  assert.equal((await rt.run('touch /root-file.txt')).code, 0);
  assert.equal(fs.existsSync('/root-file.txt'), true);
  assert.ok(rt.FS['/'].d, 'the root stays a directory after writes');
}));

test('chmod stores real permission bits that stat and ls report', () => withScratch(async () => {
  fs.writeFileSync('/project/scratch/file.txt', 'x');
  fs.chmodSync('/project/scratch/file.txt', 0o600);
  assert.equal(fs.statSync('/project/scratch/file.txt').mode & 0o777, 0o600);
  assert.match((await rt.run('ls -l /project/scratch/file.txt')).stdout, /^-rw-------/);

  fs.chmodSync('/project/scratch/file.txt', 'u+x');
  assert.equal(fs.statSync('/project/scratch/file.txt').mode & 0o777, 0o700);
  fs.chmodSync('/project/scratch/file.txt', 'go-r');
  assert.equal(fs.statSync('/project/scratch/file.txt').mode & 0o777, 0o700);
  fs.chmodSync('/project/scratch/file.txt', 'a-x');
  assert.equal(fs.statSync('/project/scratch/file.txt').mode & 0o777, 0o600);
  fs.chmodSync('/project/scratch/file.txt', 0);
  assert.equal(fs.statSync('/project/scratch/file.txt').mode & 0o777, 0, 'chmod 000 is not rewritten to 0644');
  assert.throws(() => fs.chmodSync('/project/scratch/file.txt', 'nonsense'), error => error.code === 'EINVAL');
}));

test('directories and copies keep their permission bits', () => withScratch(async () => {
  fs.mkdirSync('/project/scratch/perm');
  assert.equal(fs.statSync('/project/scratch/perm').mode & 0o777, 0o755);
  fs.writeFileSync('/project/scratch/perm/app.sh', '#!/bin/sh\n');
  fs.chmodSync('/project/scratch/perm/app.sh', 0o755);
  fs.cpSync('/project/scratch/perm', '/project/scratch/perm-copy', { recursive: true });
  assert.equal(fs.statSync('/project/scratch/perm-copy/app.sh').mode & 0o777, 0o755, 'cp -r keeps the executable bit');
  fs.copyFileSync('/project/scratch/perm/app.sh', '/project/scratch/perm/app2.sh');
  assert.equal(fs.statSync('/project/scratch/perm/app2.sh').mode & 0o777, 0o755);
}));

test('cpSync refuses a directory unless recursive is set', () => withScratch(async () => {
  fs.mkdirSync('/project/scratch/tree/inner', { recursive: true });
  fs.writeFileSync('/project/scratch/tree/inner/file.txt', 'deep');
  assert.throws(() => fs.cpSync('/project/scratch/tree', '/project/scratch/other'), error => error.code === 'ERR_FS_EISDIR');
  assert.throws(() => fs.cpSync('/project/scratch/tree', '/project/scratch/other', {}), error => error.code === 'ERR_FS_EISDIR');
  assert.equal(fs.existsSync('/project/scratch/other'), false, 'a refused copy leaves nothing behind');
  await assert.rejects(fs.promises.cp('/project/scratch/tree', '/project/scratch/other'), error => error.code === 'ERR_FS_EISDIR');
  await fs.promises.cp('/project/scratch/tree', '/project/scratch/other', { recursive: true });
  assert.equal(fs.readFileSync('/project/scratch/other/inner/file.txt', 'utf8'), 'deep');
}));

test('rm, rmdir and root protection still behave', () => withScratch(async () => {
  await assert.rejects(rt.run('rm /'), /Refusing to remove/);
  fs.mkdirSync('/project/scratch/gone', { recursive: true });
  fs.rmSync('/project/scratch/gone', { recursive: true });
  assert.equal(fs.existsSync('/project/scratch/gone'), false);
  assert.equal(fs.existsSync('/'), true);
}));

test('openSync handles directory fds and writeSync handles stdio fds like Node', () => withScratch(async () => {
  fs.mkdirSync('/project/scratch/dir');
  fs.writeFileSync('/project/scratch/file.txt', 'ok');
  const dirFd = fs.openSync('/project/scratch/dir', 'r');
  try {
    assert.equal(typeof dirFd, 'number');
    assert.equal(fs.fstatSync(dirFd).isDirectory(), true);
  } finally {
    fs.closeSync(dirFd);
  }
  assert.throws(() => fs.openSync('/project/scratch/dir', 'w'), error => error.code === 'EISDIR');
  assert.throws(() => fs.openSync('/project/scratch/dir', fs.constants.O_WRONLY), error => error.code === 'EISDIR');
  assert.throws(() => fs.openSync('/project/scratch/file.txt', fs.constants.O_RDONLY | fs.constants.O_DIRECTORY), error => error.code === 'ENOTDIR');
  assert.equal(fs.writeSync(1, 'hello-stdout\n'), 13);
}));

test('recursive readdir Dirent, opendir, lstat and dangling symlinks match POSIX semantics', () => withScratch(async () => {
  fs.mkdirSync('/project/scratch/tree/sub/deep', { recursive: true });
  fs.writeFileSync('/project/scratch/tree/root.txt', 'alpha');
  fs.writeFileSync('/project/scratch/tree/sub/child.txt', 'beta');
  fs.writeFileSync('/project/scratch/tree/sub/deep/leaf.txt', 'gamma');
  fs.symlinkSync('root.txt', '/project/scratch/tree/file-link');
  fs.symlinkSync('sub', '/project/scratch/tree/dir-link');
  fs.symlinkSync('does-not-exist', '/project/scratch/tree/dangling-link');

  const recursive = fs.readdirSync('/project/scratch/tree', { recursive: true, withFileTypes: true })
    .map(d => ({
      name: d.name,
      path: d.path,
      parentPath: d.parentPath,
      file: d.isFile(),
      dir: d.isDirectory(),
      sym: d.isSymbolicLink(),
    }))
    .sort((a, b) => (a.parentPath + '/' + a.name).localeCompare(b.parentPath + '/' + b.name));

  assert.deepEqual(JSON.parse(JSON.stringify(recursive)), [
    { name: 'dangling-link', path: '/project/scratch/tree', parentPath: '/project/scratch/tree', file: false, dir: false, sym: true },
    { name: 'dir-link', path: '/project/scratch/tree', parentPath: '/project/scratch/tree', file: false, dir: false, sym: true },
    { name: 'child.txt', path: '/project/scratch/tree/dir-link', parentPath: '/project/scratch/tree/dir-link', file: true, dir: false, sym: false },
    { name: 'deep', path: '/project/scratch/tree/dir-link', parentPath: '/project/scratch/tree/dir-link', file: false, dir: true, sym: false },
    { name: 'leaf.txt', path: '/project/scratch/tree/dir-link/deep', parentPath: '/project/scratch/tree/dir-link/deep', file: true, dir: false, sym: false },
    { name: 'file-link', path: '/project/scratch/tree', parentPath: '/project/scratch/tree', file: false, dir: false, sym: true },
    { name: 'root.txt', path: '/project/scratch/tree', parentPath: '/project/scratch/tree', file: true, dir: false, sym: false },
    { name: 'sub', path: '/project/scratch/tree', parentPath: '/project/scratch/tree', file: false, dir: true, sym: false },
    { name: 'child.txt', path: '/project/scratch/tree/sub', parentPath: '/project/scratch/tree/sub', file: true, dir: false, sym: false },
    { name: 'deep', path: '/project/scratch/tree/sub', parentPath: '/project/scratch/tree/sub', file: false, dir: true, sym: false },
    { name: 'leaf.txt', path: '/project/scratch/tree/sub/deep', parentPath: '/project/scratch/tree/sub/deep', file: true, dir: false, sym: false },
  ]);

  const opened = [];
  const dir = fs.opendirSync('/project/scratch/tree');
  for (let d = dir.readSync(); d; d = dir.readSync()) {
    opened.push({ name: d.name, path: d.path, parentPath: d.parentPath, file: d.isFile(), dir: d.isDirectory(), sym: d.isSymbolicLink() });
  }
  dir.closeSync();
  opened.sort((a, b) => a.name.localeCompare(b.name));
  assert.deepEqual(JSON.parse(JSON.stringify(opened)), JSON.parse(JSON.stringify(recursive)).filter(d => d.parentPath === '/project/scratch/tree'));

  assert.equal(fs.lstatSync('/project/scratch/tree/dangling-link').isSymbolicLink(), true);
  assert.equal(fs.lstatSync('/project/scratch/tree/dangling-link').isFile(), false);
  assert.equal(fs.lstatSync('/project/scratch/tree/dangling-link').isDirectory(), false);
  assert.equal(fs.lstatSync('/project/scratch/tree/dir-link').isSymbolicLink(), true);
  assert.equal(fs.lstatSync('/project/scratch/tree/dir-link').isDirectory(), false);
  assert.equal(fs.statSync('/project/scratch/tree/dir-link').isDirectory(), true);
  assert.equal(fs.existsSync('/project/scratch/tree/dangling-link'), false);
  assert.equal(fs.readlinkSync('/project/scratch/tree/dangling-link'), 'does-not-exist');
  assert.equal(fs.realpathSync('/project/scratch/tree/file-link'), '/project/scratch/tree/root.txt');
  assert.throws(() => fs.statSync('/project/scratch/tree/dangling-link'), { code: 'ENOENT' });
  assert.throws(() => fs.realpathSync('/project/scratch/tree/dangling-link'), { code: 'ENOENT' });
}));

test('fs.cp runs its callback asynchronously via microtask', () => withScratch(async () => {
  fs.writeFileSync('/project/scratch/src.txt', 'copy-me');
  let firedSync = false;
  let calledAfter = false;
  await new Promise((resolve, reject) => {
    fs.cp('/project/scratch/src.txt', '/project/scratch/dst.txt', error => {
      calledAfter = true;
      if (error) reject(error); else resolve();
    });
    firedSync = calledAfter;
  });
  assert.equal(firedSync, false, 'fs.cp must not invoke its callback synchronously');
  assert.equal(fs.readFileSync('/project/scratch/dst.txt', 'utf8'), 'copy-me');
}));
