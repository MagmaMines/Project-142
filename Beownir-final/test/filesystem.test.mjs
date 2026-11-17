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
