/* The page keeps a 20 GiB budget honest in two places that the runtime tests
 * cannot reach: the workspace rule copied into the page shell, and the autosave
 * layout that stores one IndexedDB value per distinct file content.
 *
 * Both are extracted from the shipped single file and executed here, so these
 * tests fail if the page drifts from the runtime or if the manifest stops
 * round-tripping text, directories and duplicate contents.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadRuntime } from './helpers/runtime.mjs';

const runtime = loadRuntime({ keep: true });
const workspaceBudgetFromQuota = quota => runtime.evaluate('workspaceBudgetFromQuota(' + JSON.stringify(quota === undefined ? null : quota) + ')');
const html = readFileSync(fileURLToPath(new URL('../o/site/index.html', import.meta.url)), 'utf8');

function between(source, start, end) {
  const from = source.indexOf(start);
  assert.notEqual(from, -1, 'missing anchor: ' + start.slice(0, 60));
  const to = source.indexOf(end, from + start.length);
  assert.notEqual(to, -1, 'missing end anchor: ' + end.slice(0, 60));
  return source.slice(from, to);
}

/* ---------- the archive, extracted as shipped ---------- */
const archiveSource = between(html, "const BeownirArchive = (() => {", "</script>");
const BeownirArchive = new Function('pako', archiveSource + '\nreturn BeownirArchive;')({});

/* ---------- the page's budget rule, extracted as shipped ---------- */
const pageRuleSource = between(html, 'const WORKSPACE_QUOTA = { floorBytes:', 'async function resolveWorkspaceBudget()');
const pageRule = new Function(pageRuleSource + '\nreturn { WORKSPACE_QUOTA, workspaceBudgetFromQuota };')();

/* ---------- the autosave helpers, extracted as shipped ---------- */
const autosaveSource = between(html, '  let storedHashes = new Set();', '  function persist() {');
const makeAutosave = ({ db, A = BeownirArchive, crypto = globalThis.crypto } = {}) => new Function(
  'db', 'A', 'utf8', 'entryBytes', 'idbRequest', 'crypto',
  autosaveSource + '\nreturn { prepareSnapshot, projectFromSnapshot, recordHashes, hashes: () => storedHashes, setHashes: value => { storedHashes = value; } };'
)(db, A, new TextEncoder(), entry => (entry && !entry.d ? new TextEncoder().encode(entry.c).length : 0), idbRequest, crypto);

const idbRequest = request => new Promise((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
function fakeDb(records = new Map()) {
  return {
    records,
    transaction(name) {
      assert.equal(name, 'records');
      return {
        objectStore() {
          return {
            get(key) {
              const request = { result: records.get(key) };
              // Real IDB fires asynchronously; the page sets handlers first.
              setTimeout(() => request.onsuccess?.(), 0);
              return request;
            },
          };
        },
      };
    },
  };
}

const project = (files, extra = {}) => ({
  schema: 2, projectId: 'project-12345678', runtimeTarget: 'compat', templateId: null,
  name: 'records', files, tabs: ['/project/a.js'], active: '/project/a.js',
  runTarget: 'npm start', updatedAt: 1, settings: { fontSize: 13 }, ...extra,
});

test('the page copy of the budget rule matches the runtime exactly', () => {
  const quotas = [0, undefined, null, Number.NaN, -1, 100 * 1024 * 1024, 1024 ** 3, 4 * 1024 ** 3, 20 * 1024 ** 3, 100 * 1024 ** 3];
  for (const quota of quotas) {
    const page = pageRule.workspaceBudgetFromQuota(quota);
    const expected = workspaceBudgetFromQuota(quota);
    assert.deepEqual(
      { bytes: page.bytes, perFile: page.perFile, entries: page.entries, quota: page.quota, source: page.source },
      { bytes: expected.bytes, perFile: expected.perFile, entries: expected.entries, quota: expected.quota, source: expected.source },
      'quota ' + String(quota)
    );
  }
  assert.equal(pageRule.workspaceBudgetFromQuota(100 * 1024 ** 3).bytes, 20 * 1024 ** 3);
  assert.equal(pageRule.workspaceBudgetFromQuota(0).bytes, 64 * 1024 * 1024);
});

test('the archive follows whatever budget the page hands it', () => {
  const defaults = { ...BeownirArchive.limits };
  try {
    BeownirArchive.setLimits({ bytes: 100 * 1024 * 1024, perFile: 25 * 1024 * 1024, entries: 50 });
    assert.equal(BeownirArchive.limits.bytes, 100 * 1024 * 1024);
    assert.equal(BeownirArchive.limits.perFile, 25 * 1024 * 1024);
    assert.equal(BeownirArchive.limits.entries, 50);
    assert.ok(BeownirArchive.limits.recordChars >= 25 * 1024 * 1024, 'a 25 MiB text file still fits one record');

    const big = 'a'.repeat(26 * 1024 * 1024);
    assert.throws(() => BeownirArchive.validate(project({ '/project/big.txt': { c: big } })), /per-file limit is 25 MiB/);

    const many = Object.fromEntries(Array.from({ length: 51 }, (_, index) => ['/project/f' + index + '.txt', { c: 'x' }]));
    assert.throws(() => BeownirArchive.validate(project(many)), /too many entries \(50 at most\)/);

    // perFile can never exceed the total budget.
    BeownirArchive.setLimits({ bytes: 1024 * 1024, perFile: 9 * 1024 * 1024 });
    assert.equal(BeownirArchive.limits.perFile, 1024 * 1024);
    BeownirArchive.setLimits({ bytes: 2 * 1024 * 1024 });
    assert.equal(BeownirArchive.limits.perFile, 1024 * 1024, 'a smaller budget lowers the per-file limit with it');
  } finally {
    BeownirArchive.setLimits(defaults);
  }
  assert.equal(BeownirArchive.limits.bytes, defaults.bytes);
});

test('a snapshot is a small manifest plus one record per distinct content', async () => {
  const autosave = makeAutosave();
  const shared = 'export const answer = 42;\n';
  const { doc, records, hashes } = await autosave.prepareSnapshot(project({
    '/project': { d: true },
    '/project/a.js': { c: shared },
    '/project/copy.js': { c: shared },
    '/project/readme.md': { c: '# hello\n' },
  }));
  assert.equal(doc.schema, 3);
  assert.equal(hashes.size, 2, 'two distinct contents');
  assert.deepEqual([...records.keys()].sort(), [...hashes].sort());
  assert.equal(records.size, 2, 'the duplicate is stored once');
  assert.deepEqual(doc.files['/project'], { d: true });
  assert.ok(doc.files['/project/a.js'].hash);
  assert.equal(doc.files['/project/a.js'].bytes, shared.length);
  assert.equal(doc.files['/project/copy.js'].hash, doc.files['/project/a.js'].hash);
  assert.ok(!JSON.stringify(doc).includes('export const answer'), 'the manifest carries hashes, not text');
  assert.equal(doc.name, 'records');
  assert.deepEqual(doc.settings, { fontSize: 13 });
  assert.equal(doc.schema === 2, false);
});

test('the manifest round-trips text, directories and metadata through the record store', async () => {
  const autosave = makeAutosave();
  const source = project({
    '/project': { d: true },
    '/project/a.js': { c: 'let a = 1;\n' },
    '/project/src': { d: true },
    '/project/src/b.ts': { c: 'const b: number = 2;\n' },
    '/project/logo.png': { c: BeownirArchive.binaryPrefix + 'AAAA' },
  });
  const { doc, records } = await autosave.prepareSnapshot(source);
  const db = fakeDb(new Map(records));
  const restored = await makeAutosave({ db }).projectFromSnapshot(doc);
  assert.deepEqual(JSON.parse(JSON.stringify(restored.files)), source.files);
  assert.equal(restored.active, '/project/a.js');
  assert.deepEqual(restored.tabs, ['/project/a.js']);
  assert.equal(restored.name, 'records');
  assert.equal(restored.projectId, 'project-12345678');
  assert.equal(restored.schema, 2, 'the validated project keeps the public schema');
});

test('a missing record is an error, not a silently truncated workspace', async () => {
  const autosave = makeAutosave();
  const { doc, records } = await autosave.prepareSnapshot(project({ '/project': { d: true }, '/project/a.js': { c: 'x' } }));
  const key = [...records.keys()][0];
  const db = fakeDb(new Map());
  await assert.rejects(makeAutosave({ db }).projectFromSnapshot(doc), /stored file record is missing: \/project\/a\.js/i);
  assert.equal(db.records.has(key), false);
});

test('a second save writes only the content that changed', async () => {
  const autosave = makeAutosave();
  const first = await autosave.prepareSnapshot(project({ '/project': { d: true }, '/project/a.js': { c: 'one' }, '/project/b.js': { c: 'two' } }));
  autosave.setHashes(first.hashes);
  assert.equal(first.records.size, 2);
  const second = await autosave.prepareSnapshot(project({ '/project': { d: true }, '/project/a.js': { c: 'one' }, '/project/b.js': { c: 'two changed' } }));
  assert.equal(second.records.size, 1, 'the untouched file is not rewritten');
  assert.equal([...second.records.values()][0], 'two changed');
  assert.equal(second.hashes.size, 2);
  // Unchanged content keeps its key across saves, which is what lets the
  // 'previous' manifest share records with the current one.
  assert.equal(second.doc.files['/project/a.js'].hash, first.doc.files['/project/a.js'].hash);
});

test('garbage collection keeps everything current and previous can point at', async () => {
  const autosave = makeAutosave();
  const previous = await autosave.prepareSnapshot(project({ '/project': { d: true }, '/project/a.js': { c: 'old' } }));
  const current = await autosave.prepareSnapshot(project({ '/project': { d: true }, '/project/a.js': { c: 'new' } }));
  const keep = new Set([...current.hashes, ...autosave.recordHashes(previous.doc)]);
  assert.equal(keep.size, 2, 'both versions are referenced');
  for (const hash of autosave.recordHashes(previous.doc)) assert.ok(keep.has(hash), 'rollback target survives the sweep');
  assert.equal(autosave.recordHashes(previous.doc).size, 1);
});

test('a legacy single-value snapshot is still accepted', () => {
  const legacy = project({ '/project': { d: true }, '/project/a.js': { c: 'legacy' } });
  const restored = BeownirArchive.validate(legacy);
  assert.equal(restored.files['/project/a.js'].c, 'legacy');
});

test('the editor refuses what the runtime would refuse, with the real numbers', () => {
  const pageRuleSource = between(html, 'const WORKSPACE_QUOTA = { floorBytes:', 'async function resolveWorkspaceBudget()');
  const putSource = between(html, '  function put(path, value) {', '  function ensureFolders(path) {');
  const formatSource = between(html, '  function formatStorageBytes(value) {', '  const isStorageQuotaError =');
  const makeEditor = (budget, files = {}) => {
    const state = { files: { ...files } };
    const api = new Function(
      'state', 'A', 'revisions', 'pendingChanges', 'noteFileChange',
      'let sizeEstimate = 0;const revisionFor = path => revisions[path] || 0;' + pageRuleSource + formatSource + putSource + '\nreturn { put, budget: workspaceBudget };'
    )(state, BeownirArchive, Object.create(null), new Set(), () => {});
    Object.assign(api.budget, budget);
    api.used = () => Object.values(state.files).reduce((n, value) => n + (value && !value.d ? new TextEncoder().encode(value.c).length : 0), 0);
    return { ...api, state };
  };

  const budget = { bytes: 12 * 1024 * 1024, perFile: 8 * 1024 * 1024, entries: 20000, quota: 24 * 1024 * 1024, source: 'quota' };
  const editor = makeEditor(budget);
  editor.put('/project/a.txt', { c: 'a'.repeat(1024 * 1024) });
  assert.equal(editor.used(), 1024 * 1024, 'the editor tracks bytes, not UTF-16 units');

  assert.throws(() => editor.put('/project/big.txt', { c: 'a'.repeat(9 * 1024 * 1024) }), /per-file limit is 8\.0 MiB/);
  assert.equal(editor.state.files['/project/big.txt'], undefined, 'the rejected file is not created');

  editor.put('/project/b.txt', { c: 'b'.repeat(8 * 1024 * 1024) });
  assert.throws(() => editor.put('/project/c.txt', { c: 'c'.repeat(12 * 1024 * 1024) }), /per-file limit/);
  assert.throws(() => editor.put('/project/c.txt', { c: 'c'.repeat(7 * 1024 * 1024) }), /this change would make the source tree 16 MiB of the 12 MiB budget/);

  // A same-size rewrite is charged the difference, not the sum.
  const before = editor.used();
  editor.put('/project/b.txt', { c: 'd'.repeat(8 * 1024 * 1024) });
  assert.equal(editor.used(), before);
  editor.put('/project/b.txt', null);
  assert.equal(editor.used(), 1024 * 1024, 'deleting frees the bytes');
});

test('a floor budget keeps the historical 64 MiB and 16 MiB numbers in the editor', () => {
  const pageRuleSource = between(html, 'const WORKSPACE_QUOTA = { floorBytes:', 'async function resolveWorkspaceBudget()');
  const putSource = between(html, '  function put(path, value) {', '  function ensureFolders(path) {');
  const formatSource = between(html, '  function formatStorageBytes(value) {', '  const isStorageQuotaError =');
  const api = new Function(
    'state', 'A', 'revisions', 'pendingChanges', 'noteFileChange',
    'let sizeEstimate = 0;const revisionFor = path => revisions[path] || 0;' + pageRuleSource + formatSource + putSource + '\nreturn { put, budget: workspaceBudget };'
  )({ files: {} }, BeownirArchive, Object.create(null), new Set(), () => {});
  assert.equal(api.budget.bytes, 64 * 1024 * 1024);
  assert.equal(api.budget.perFile, 16 * 1024 * 1024);
  assert.doesNotThrow(() => api.put('/project/ok.txt', { c: 'x'.repeat(16 * 1024 * 1024) }));
  assert.throws(() => api.put('/project/no.txt', { c: 'x'.repeat(16 * 1024 * 1024 + 1) }), /per-file limit is 16 MiB/);
});

test('an edit re-hashes only the file that changed', async () => {
  const real = globalThis.crypto;
  let digests = 0;
  const counting = { subtle: { digest: (...args) => { digests++; return real.subtle.digest(...args); } }, randomUUID: real.randomUUID };
  const autosave = makeAutosave({ crypto: counting });
  const files = () => ({
    '/project': { d: true },
    '/project/a.js': { c: 'export default 1;' },
    '/project/b.js': { c: 'export default 2;' },
    '/project/c.js': { c: 'export default 3;' },
  });
  const first = await autosave.prepareSnapshot(project(files()));
  assert.equal(digests, 3, 'the first save hashes every file once');
  autosave.setHashes(first.hashes);   // persist() records them after a commit
  const unchanged = await autosave.prepareSnapshot(project(files()));
  assert.equal(digests, 3, 'an unchanged workspace is not re-hashed');
  assert.equal(unchanged.records.size, 0, 'and writes nothing');
  const edited = files();
  edited['/project/b.js'] = { c: 'export default 20;' };
  const second = await autosave.prepareSnapshot(project(edited));
  assert.equal(digests, 4, 'one edit costs one hash');
  assert.equal(second.records.size, 1);
  autosave.setHashes(second.hashes);
  const renamed = { ...edited };
  renamed['/project/moved.js'] = { c: 'export default 3;' };
  delete renamed['/project/c.js'];
  const moved = await autosave.prepareSnapshot(project(renamed));
  assert.equal(digests, 5, 'only the new path is hashed; the other files hit the cache');
  assert.equal(moved.records.size, 0, 'and known content writes no new record');
});

test('a binary record is charged the base64 size that is actually stored', () => {
  const defaults = { ...BeownirArchive.limits };
  try {
    BeownirArchive.setLimits({ bytes: 64 * 1024 * 1024, perFile: 5 * 1024 * 1024, entries: 20000 });
    const record = bytes => BeownirArchive.binaryPrefix + BeownirArchive.base64(bytes);
    // 4 MiB of bytes is ~5.3 MiB of base64 text, which is what the runtime keeps.
    assert.throws(() => BeownirArchive.validate(project({ '/project/big.bin': { c: record(new Uint8Array(4 * 1024 * 1024)) } })), /as stored; the per-file limit is 5\.0 MiB/);
    const accepted = BeownirArchive.validate(project({ '/project/ok.bin': { c: record(new Uint8Array(3 * 1024 * 1024)) } }));
    assert.ok(accepted.files['/project/ok.bin'].c.startsWith(BeownirArchive.binaryPrefix));
  } finally {
    BeownirArchive.setLimits(defaults);
  }
});
