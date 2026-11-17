import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isQuotaError, formatBytes, describeStorage, capacityVerdict, capacityMessage,
  ensurePersistence, sweepOpfs, createStorageManager, MIB
} from '../o/native/storage-manager.mjs';

/* A tiny in-memory stand-in for OPFS/StorageManager. */
function fakeOpfs(names, onRemove = () => {}) {
  const dirs = new Map(names.map(name => [name, { kind: 'directory', name }]));
  const root = {
    kind: 'directory',
    entries() {
      return [...dirs.values()].map(handle => [handle.name, handle])[Symbol.iterator] ? [...dirs.values()].map(handle => [handle.name, handle]).values() : [];
    },
    async removeEntry(name, options) {
      if (!dirs.has(name)) throw Object.assign(new Error('missing'), { name: 'NotFoundError' });
      dirs.delete(name);
      this.removed = [...(this.removed || []), { name, options }];
      onRemove(name);
    }
  };
  return { root, dirs };
}

function fakeNavigator({ usage = 0, quota = 0, persisted = false, granted = true, namespaces = [], freedPerNamespace = 0 } = {}) {
  let current = usage;
  const { root: base, dirs } = fakeOpfs(namespaces, () => { current = Math.max(0, current - freedPerNamespace); });
  /* OPFS shape: origin -> beownir-wasix-v1 -> workspace-<id> */
  const root = {
    kind: 'directory',
    async getDirectoryHandle(name) {
      if (name !== 'beownir-wasix-v1') throw Object.assign(new Error('missing'), { name: 'NotFoundError' });
      return base;
    }
  };
  return {
    root,
    base,
    dirs,
    storage: {
      async estimate() { return { usage: current, quota }; },
      async persisted() { return persisted; },
      async persist() { return granted; },
      async getDirectory() { return root; }
    }
  };
}

test('quota errors are recognised however the browser words them', () => {
  assert.equal(isQuotaError(Object.assign(new Error('x'), { name: 'QuotaExceededError' })), true);
  assert.equal(isQuotaError(new Error('ENOSPC: no space left on device')), true);
  assert.equal(isQuotaError(Object.assign(new Error('nope'), { code: 'ENOSPC' })), true);
  assert.equal(isQuotaError(new Error('Failed to execute createWritable: Storage capacity quota exceeded.')), true);
  assert.equal(isQuotaError(new Error('The quota has been exceeded.')), true);
  assert.equal(isQuotaError(new Error('disk full')), true);
  assert.equal(isQuotaError(new Error('ENOENT: no such file')), false);
  assert.equal(isQuotaError(null), false);
});

test('byte formatting is stable across magnitudes', () => {
  assert.equal(formatBytes(512), '512 B');
  assert.equal(formatBytes(1536), '1.5 KiB');
  assert.equal(formatBytes(5 * MIB), '5.0 MiB');
  assert.equal(formatBytes(190.4 * MIB), '190 MiB');
  assert.equal(formatBytes(2.5 * 1024 * MIB), '2.5 GiB');
  assert.equal(formatBytes(undefined), '?');
});

test('describeStorage reports usage, availability and a level', () => {
  const ok = describeStorage({ usage: 100 * MIB, quota: 1000 * MIB }, true);
  assert.equal(ok.available, 900 * MIB);
  assert.equal(ok.level, 'ok');
  assert.equal(ok.persisted, true);
  assert.equal(describeStorage({ usage: 800 * MIB, quota: 1000 * MIB }).level, 'low');
  assert.equal(describeStorage({ usage: 950 * MIB, quota: 1000 * MIB }).level, 'critical');
  assert.equal(describeStorage({ usage: 0, quota: 0 }).level, 'unknown');
  assert.equal(describeStorage(null).level, 'unknown');
});

test('capacityVerdict keeps a 10% reserve before big writes', () => {
  const report = describeStorage({ usage: 500 * MIB, quota: 1000 * MIB });
  assert.equal(capacityVerdict(report, 300 * MIB).ok, true, '500 + 300 <= 900');
  const tight = capacityVerdict(report, 420 * MIB);
  assert.equal(tight.ok, false);
  assert.equal(tight.overBy, 20 * MIB);
  assert.equal(capacityVerdict(describeStorage({ usage: 1, quota: 0 }), 999 * MIB).ok, true, 'an unknown quota never blocks');
  const message = capacityMessage(tight, 'npm install');
  assert.match(message, /npm install needs about/);
  assert.match(message, /storage gc/);
  assert.match(message, /Help → Storage/);
});

test('ensurePersistence reports whether the origin is protected', async () => {
  assert.deepEqual(await ensurePersistence(fakeNavigator({ persisted: true })), { persisted: true, granted: true });
  assert.deepEqual(await ensurePersistence(fakeNavigator({ persisted: false, granted: true })), { persisted: true, granted: true });
  assert.deepEqual(await ensurePersistence(fakeNavigator({ persisted: false, granted: false })), { persisted: false, granted: true });
  assert.deepEqual(await ensurePersistence({}), { persisted: false, granted: false });
});

test('sweepOpfs removes only namespaces that no live group owns', async () => {
  const { root, dirs } = fakeOpfs(['workspace-1', 'workspace-2', 'workspace-3', 'keep-me']);
  const removed = await sweepOpfs(root, { keep: new Set(['workspace-2']) });
  assert.deepEqual(removed.sort(), ['workspace-1', 'workspace-3']);
  assert.deepEqual([...dirs.keys()].sort(), ['keep-me', 'workspace-2']);
  assert.ok(root.removed.every(entry => entry.options.recursive === true));
  assert.deepEqual(await sweepOpfs(null), []);
});

test('the manager preflights, sweeps a full origin and reports the recovery', async () => {
  // 950 MiB used, one dead 200 MiB mount plus the live one.
  const nav = fakeNavigator({ usage: 950 * MIB, quota: 1000 * MIB, namespaces: ['workspace-1', 'workspace-2'], freedPerNamespace: 200 * MIB });
  const messages = [];
  const manager = createStorageManager({ nav, log: message => messages.push(message) });
  const before = await manager.report();
  assert.equal(before.level, 'critical');

  const verdict = await manager.ensureCapacity(100 * MIB, 'npm install', { keep: new Set(['workspace-2']) });
  assert.equal(verdict.ok, true, 'the sweep makes room');
  assert.equal(verdict.report.usage, 750 * MIB, 'the freed mount is reflected in the estimate');
  assert.deepEqual(verdict.swept, ['workspace-1']);
  assert.match(messages.join('\n'), /freed 1 stale mount/);
  assert.ok(!nav.dirs.has('workspace-1'));
  assert.ok(nav.dirs.has('workspace-2'), 'a live group keeps its mount');
});

test('the manager refuses clearly when nothing can be freed', async () => {
  const nav = fakeNavigator({ usage: 990 * MIB, quota: 1000 * MIB, namespaces: [] });
  const manager = createStorageManager({ nav });
  const verdict = await manager.ensureCapacity(200 * MIB, 'next build', { allowSweep: false });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, 'over-budget');
  const message = capacityMessage(verdict, 'next build');
  assert.match(message, /used 990 MiB of its 1000 MiB/);
});

test('persist() is best effort and always reports the budget', async () => {
  const manager = createStorageManager({ nav: fakeNavigator({ usage: 10 * MIB, quota: 100 * MIB, granted: false }) });
  const result = await manager.persist();
  assert.equal(result.persisted, false);
  assert.equal(result.report.quota, 100 * MIB);
  const bare = createStorageManager({ nav: {} });
  assert.deepEqual(await bare.persist(), { persisted: false, granted: false, report: describeStorage(undefined, false) });
});
