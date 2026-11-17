import test from 'node:test';
import assert from 'node:assert/strict';
import { loadRuntime } from './helpers/runtime.mjs';

/* The source workspace used to be capped at a hard-coded 64 MiB, far below what
 * a browser grants (Chrome gives an origin ~60% of free disk). The cap is now
 * derived: clamp(origin quota / 2, 64 MiB, 20 GiB). These tests pin the rule,
 * the enforcement, and the reporting, because a quota is a promise the UI makes
 * to the user and every path has to agree on the number. */

const MiB = 1024 * 1024;
const GiB = 1024 * MiB;
const rt = loadRuntime();
const plain = value => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));
const evaluate = async code => plain(await rt.evaluate(code));
const sync = code => plain(rt.evaluate(code));

test.beforeEach(() => {
  rt.restore();
  sync('applyWorkspaceBudget(0)');
});

test('the budget is half the origin quota, floored and ceilinged', () => {
  const cases = [
    ['no quota reported', 0, 64 * MiB, 16 * MiB, 'floor'],
    ['1 GiB', 1 * GiB, 512 * MiB, 128 * MiB, 'quota'],
    ['200 MiB', 200 * MiB, 100 * MiB, 25 * MiB, 'quota'],
    ['100 GiB', 100 * GiB, 20 * GiB, 256 * MiB, 'quota'],
    ['1 TiB', 1024 * GiB, 20 * GiB, 256 * MiB, 'quota'],
  ];
  for (const [label, quota, bytes, perFile, source] of cases) {
    const limits = sync(`workspaceBudgetFromQuota(${quota})`);
    assert.equal(limits.bytes, bytes, label + ': total');
    assert.equal(limits.perFile, perFile, label + ': per file');
    assert.equal(limits.source, source, label + ': provenance');
  }
});

test('a browser that cannot report a quota keeps exactly the old limit', () => {
  assert.equal(sync('LIMITS.bytes'), 64 * MiB, 'floor is the previous behaviour');
  assert.equal(sync('LIMITS.perFile'), 16 * MiB);
  assert.equal(sync('LIMITS.source'), 'floor');
  // and the constant itself has not drifted
  const rule = sync('WORKSPACE_QUOTA');
  assert.equal(rule.floorBytes, 64 * MiB);
  assert.equal(rule.ceilingBytes, 20 * GiB);
  assert.equal(rule.share, 0.5);
});

test('refreshWorkspaceBudget reads navigator.storage.estimate', async () => {
  const scoped = loadRuntime({ globals: { navigator: { hardwareConcurrency: 4, userAgent: 'probe', storage: { estimate: async () => ({ quota: 4 * GiB, usage: 100 * MiB }) } } }, keep: true });
  const limits = JSON.parse(JSON.stringify(await scoped.evaluate('refreshWorkspaceBudget()')));
  assert.equal(limits.bytes, 2 * GiB, 'half of a 4 GiB quota');
  assert.equal(limits.perFile, 256 * MiB, 'a quarter of 2 GiB, clamped to the per-file ceiling');
  assert.equal(limits.quota, 4 * GiB);
  assert.equal(limits.source, 'quota');
});

test('a browser that throws from estimate() still boots at the floor', async () => {
  const scoped = loadRuntime({ globals: { navigator: { storage: { estimate: async () => { const error = new Error('denied'); error.name = 'SecurityError'; throw error; } } } }, keep: true });
  const limits = JSON.parse(JSON.stringify(await scoped.evaluate('refreshWorkspaceBudget()')));
  assert.equal(limits.bytes, 64 * MiB);
  assert.equal(limits.source, 'floor');
  assert.equal(JSON.parse(JSON.stringify(scoped.evaluate('LIMITS.bytes'))), 64 * MiB, 'the module state agrees');
});

test('the write path enforces the per-file limit with a real ENOSPC', () => {
  sync('applyWorkspaceLimits({ bytes: 8 * 1024 * 1024, perFile: 64 * 1024, entries: 20000 })');
  const result = sync(`(() => {
    const fs = require('fs');
    fs.mkdirSync('/project/inner', { recursive: true });
    const exact = 'a'.repeat(64 * 1024);            // exactly the 64 KiB per-file cap
    fs.writeFileSync('/project/inner/exact.txt', exact);
    const failure = (() => { try { fs.writeFileSync('/project/inner/big.txt', 'a'.repeat(64 * 1024 + 1)); return null; } catch (error) { return { code: error.code, errno: error.errno, syscall: error.syscall, path: error.path, message: error.message }; } })();
    return { wrote: fs.readFileSync('/project/inner/exact.txt', 'utf8').length, failure };
  })()`);
  assert.equal(result.wrote, 64 * 1024, 'a file exactly at the limit is accepted');
  assert.equal(result.failure.code, 'ENOSPC');
  assert.equal(result.failure.errno, -28);
  assert.equal(result.failure.syscall, 'write');
  assert.equal(result.failure.path, '/project/inner/big.txt');
  assert.match(result.failure.message, /larger than the per-file limit/);
  assert.match(result.failure.message, /workspace limit 8\.0 MiB, 64 KiB per file, 20,000 entries/);
});

test('the write path enforces the total with the live numbers in the message', () => {
  // 1 MiB total, 1 MiB per file: each write fits on its own, together they do not.
  sync('applyWorkspaceLimits({ bytes: 1 * 1024 * 1024, perFile: 1 * 1024 * 1024, entries: 20000 })');
  const result = sync(`(() => {
    const fs = require('fs');
    fs.mkdirSync('/project/a', { recursive: true });
    fs.writeFileSync('/project/a/one.txt', 'a'.repeat(400 * 1024));   // 400 KiB, under the per-file cap
    let failure = null;
    try { fs.writeFileSync('/project/a/two.txt', 'b'.repeat(700 * 1024)); } catch (error) { failure = { code: error.code, bytes: error.bytes, limit: error.limit, message: error.message }; }
    return { failure, entries: require('fs').readdirSync('/project/a').length };
  })()`);
  assert.equal(result.failure.code, 'ENOSPC');
  assert.equal(result.failure.limit, 1 * MiB);
  assert.ok(result.failure.bytes > 1 * MiB, 'the report says how much was attempted');
  assert.match(result.failure.message, /Virtual filesystem quota exceeded/);
  // The rejection names the total budget, proving it was the total that tripped.
  assert.match(result.failure.message, /workspace limit 1\.0 MiB/);
  assert.match(result.failure.message, /quota exceeded/);
  assert.match(result.failure.message, /\.next, dist or \.cache/, 'the hint survives the rewrite');
  assert.deepEqual(result.entries, 1, 'the rejected file was not created');
});

test('rewriting a file is charged the difference, not the sum', () => {
  sync('applyWorkspaceLimits({ bytes: 1 * 1024 * 1024, perFile: 512 * 1024, entries: 20000 })');
  const result = sync(`(() => {
    const fs = require('fs');
    fs.mkdirSync('/project/b', { recursive: true });
    fs.writeFileSync('/project/b/log.txt', 'a'.repeat(100 * 1024));  // 100 KiB
    fs.writeFileSync('/project/b/log.txt', 'b'.repeat(100 * 1024));  // same size: charged the difference
    const same = fs.statSync('/project/b/log.txt').size;
    let failure = null;
    try { fs.writeFileSync('/project/b/log.txt', 'c'.repeat(600 * 1024)); } catch (error) { failure = error.code; }
    return { size: same, failure, after: fs.statSync('/project/b/log.txt').size };
  })()`);
  assert.equal(result.failure, 'ENOSPC', 'growing past the per-file cap is refused');
  assert.equal(result.size, 100 * 1024, 'the same-size rewrite was accepted');
  assert.equal(result.after, 100 * 1024, 'the refused rewrite left the previous contents intact');
});

test('statfs reports the same budget the write path enforces', () => {
  sync('applyWorkspaceLimits({ bytes: 3 * 1024 * 1024, perFile: 256 * 1024, entries: 20000 })');
  const result = sync(`(() => {
    const fs = require('fs');
    fs.mkdirSync('/project/c', { recursive: true });
    fs.writeFileSync('/project/c/data.txt', 'x'.repeat(100 * 1024));  // 100 KiB
    const stats = fs.statfsSync('/project');
    return { blocks: stats.blocks, bfree: stats.bfree, bsize: stats.bsize, files: stats.files };
  })()`);
  assert.equal(result.bsize, 4096);
  assert.equal(result.blocks, Math.floor((3 * MiB) / 4096), 'total blocks describe the workspace budget');
  assert.ok(result.bfree < result.blocks);
  assert.equal(result.files, 20000);
  // The source tree only: runtime internals under /.beownir never count.
  const used = sync(`workspaceUsage().bytes`);
  assert.equal(result.bfree, Math.floor(((3 * MiB) - used) / 4096), 'free blocks are the real remainder');
});

test('df prints the budget instead of claiming 64 MiB', async () => {
  sync('applyWorkspaceLimits({ bytes: 2 * 1024 * 1024, perFile: 512 * 1024, entries: 20000 })');
  const run = await rt.run('df');
  assert.equal(run.code, 0, run.stderr);
  // The seeded demo project is already in the store, so only the shape matters.
  assert.match(run.stdout, /Workspace\s+[\d.]+ (?:B|KiB|MiB)\s+of 2\.0 MiB/, 'usage is shown against the real budget');
  assert.match(run.stdout, /Budget\s+2\.0 MiB/, 'the effective budget is printed');
  assert.match(run.stdout, /floor: this browser does not report a quota|half of the/, 'the provenance is named');
  assert.ok(!/64 MiB source quota/.test(run.stdout));
  assert.match(run.stdout, /512 KiB per file/);
  assert.ok(!/64 MiB source quota/.test(run.stdout), 'the old fixed number is gone');
});

test('the page can hand the runtime its limits, and they are clamped', () => {
  const applied = sync(`(() => {
    applyWorkspaceLimits({ bytes: 4096 * 1024 * 1024 * 1024, perFile: 8 * 1024 * 1024 * 1024, entries: 5000, quota: 999 * 1024 * 1024 * 1024 });
    return { ...LIMITS };
  })()`);
  assert.equal(applied.bytes, 20 * GiB, 'a page cannot raise the ceiling past 20 GiB');
  assert.equal(applied.perFile, 256 * MiB, 'nor the per-file ceiling');
  assert.equal(applied.entries, 5000);
  const tiny = sync(`(() => { applyWorkspaceLimits({ bytes: 1024 * 1024, perFile: 1024 }); return { ...LIMITS }; })()`);
  assert.equal(tiny.bytes, 1 * MiB, 'a page may describe a small origin quota');
  assert.equal(tiny.perFile, 1024);
  const grain = sync(`(() => { applyWorkspaceLimits({ bytes: 'nonsense', perFile: null }); return { ...LIMITS }; })()`);
  assert.equal(grain.bytes, 1 * MiB, 'unparseable values are ignored, not applied');
});

test('the runtime reports its limits to the host on boot', async () => {
  const scoped = loadRuntime({ globals: { navigator: { storage: { estimate: async () => ({ quota: 8 * GiB }) } } }, keep: true });
  const from = scoped.posts.length;
  await scoped.evaluate(`(() => new Promise(resolve => {
    // The worker's own message handler is driven by the kernel; simulate the
    // init message the page sends after a boot.
    self.onmessage({ data: { type: 'init', files: {}, versions: {}, embeddedEsbuildBrowser: '', embeddedEsbuildWasm: new Uint8Array(0), embeddedPako: '' } });
    setTimeout(resolve, 20);
  }))()`);
  const messages = scoped.posts.slice(from).filter(message => message && message.type === 'storage');
  assert.ok(messages.length >= 1, 'a storage message is posted');
  const limits = messages.at(-1).report.limits;
  assert.equal(limits.bytes, 4 * GiB, 'half of the reported 8 GiB');
  assert.equal(limits.perFile, 256 * MiB, 'the per-file ceiling holds at any quota');
});
