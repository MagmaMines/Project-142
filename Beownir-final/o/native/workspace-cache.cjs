'use strict';
/* Transactional workspace checkpoint for the browser-WASM runtime.
 *
 * Files and symlinks keep their real bytes; nothing is converted to text, and
 * only guest workspace paths are reachable. Two rules keep the origin storage
 * budget usable:
 *   1. rebuildable state is never packed: `.next` (Next.js build/dev output)
 *      and the npm download cache are caches, not source or dependencies;
 *   2. restore replaces a root in place instead of unpacking a second staged
 *      copy first, which used to need ~2x the tree and pushed Next.js
 *      workspaces over the browser quota mid-restore.
 */
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');

const ROOT = path.resolve(process.env.BEOWNIR_WORKSPACE_ROOT || '/workspace');
const MAX = 384 * 1024 * 1024;
const MAX_FILE = 64 * 1024 * 1024;
const MAX_COMPRESSED = 128 * 1024 * 1024;
const MAX_ENTRIES = 100000;
const MAGIC = 'BNPK2\n';

/* Directories that are pure caches/build output: walked past, never packed. */
const ignored = new Set(['node_modules', '.git', '.beownir', '.next', '.nuxt', '.output', 'dist', '.cache', '.local', '.npm', '.pnpm-store', 'coverage']);
/* Roots that are worth checkpointing. `node_modules` (including nested ones),
 * `dist` and `.output` are build/install output that is expensive to recreate;
 * `.next` and the npm cache are deliberately absent. */
const ROOTS = ['node_modules', 'dist', '.output', '.beownir/addons-cache', '.beownir/native-registry.json', '.beownir/global', '.beownir/npm-cli', '.beownir/install-materialized.json'];
/* Removed by `gc` when the origin is short on space; all reproducible. */
const GC_PATHS = ['.next/cache', '.next/dev', '.next/standalone', '.next/trace', '.beownir/npm-cache', '.beownir/checkpoint.bin', '.beownir/pnpm-store', '.pnpm-store'];

function manifestValue(name, contents) {
  if (!name.endsWith('package.json')) return contents;
  try {
    const source = JSON.parse(contents), value = {};
    for (const key of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies', 'peerDependenciesMeta', 'overrides', 'pnpm', 'workspaces', 'packageManager', 'engines', 'os', 'cpu', 'libc', 'resolutions']) if (source[key] !== undefined) value[key] = source[key];
    if (name !== 'package.json') { value.name = source.name; value.version = source.version; }
    if (source.beownir?.nativeAddons) value.nativeAddons = source.beownir.nativeAddons;
    const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
    return canonical(value);
  } catch { return contents; }
}

function fingerprint() {
  const values = [];
  function walk(dir = '') {
    let entries;
    try { entries = fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const name = dir ? dir + '/' + entry.name : entry.name;
      if (entry.isDirectory()) { if (!ignored.has(entry.name)) walk(name); }
      else if (entry.name === 'package.json' || (!dir && ['package-lock.json', 'npm-shrinkwrap.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml'].includes(entry.name))) values.push([name, manifestValue(name, fs.readFileSync(path.join(ROOT, name), 'utf8'))]);
    }
  }
  walk();
  values.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return crypto.createHash('sha256').update(JSON.stringify(values)).digest('hex');
}

function unsafe(name) {
  return typeof name !== 'string' || name.length > 2048 || name.includes('\0') || name.includes('\\')
    || name.startsWith('/') || name.split('/').some(part => !part || part === '.' || part === '..');
}

/** The top-level directory a checkpoint path belongs to (it is replaced whole on restore). */
function rootOf(name) {
  const parts = name.split('/');
  if (parts[0] === '.beownir') return parts.slice(0, 2).join('/');
  const moduleAt = parts.indexOf('node_modules');
  if (moduleAt >= 0) return parts.slice(0, moduleAt + 1).join('/');
  return parts[0];
}

function covered(name) {
  if (unsafe(name)) return false;
  const root = rootOf(name);
  if (root === 'node_modules' || root.endsWith('/node_modules')) return true;
  return ROOTS.includes(root);
}

function safePath(name) {
  if (unsafe(name) || !covered(name)) throw Error('Invalid checkpoint path: ' + name);
  return path.join(ROOT, name);
}

function quotaMessage(action, target, error) {
  return 'Storage full while ' + action + ' ' + target + ': the browser origin quota is exhausted. '
    + 'Run `storage gc` in the terminal (or Help → Storage → Free space), then retry. '
    + 'Underlying error: ' + String(error?.message || error);
}

function writeFileQuotaAware(target, data, mode) {
  try { fs.writeFileSync(target, data, { mode }); }
  catch (error) { throw Object.assign(Error(quotaMessage('writing', path.relative(ROOT, target) || target, error)), { code: 'ENOSPC' }); }
}

function pack(file) {
  const roots = [...ROOTS];
  function findNested(dir = '') {
    let entries;
    try { entries = fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      const name = dir ? dir + '/' + entry.name : entry.name;
      if (entry.name === 'node_modules') { if (dir) roots.push(name); }
      else if (!ignored.has(entry.name)) findNested(name);
    }
  }
  findNested();
  const chunks = [Buffer.from(MAGIC)];
  let total = MAGIC.length, count = 0;
  function walk(name) {
    const full = safePath(name);
    let stat;
    try { stat = fs.lstatSync(full); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
    if (++count > MAX_ENTRIES) throw Error('Checkpoint entry budget exceeded (' + MAX_ENTRIES + ' entries)');
    const meta = { path: name, mode: (stat.mode & 0o777) || (name.includes('/.bin/') ? 0o755 : stat.isDirectory() ? 0o755 : 0o644), mtime: stat.mtimeMs };
    let data;
    if (stat.isSymbolicLink()) {
      meta.type = 'link';
      meta.target = fs.readlinkSync(full);
      const resolved = path.resolve(path.dirname(full), meta.target);
      if (resolved !== ROOT && !resolved.startsWith(ROOT + path.sep)) throw Error('Checkpoint symlink escapes the workspace: ' + name);
    } else if (stat.isDirectory()) meta.type = 'dir';
    else if (stat.isFile()) {
      if (stat.size > MAX_FILE) throw Error('Checkpoint file budget exceeded (' + MAX_FILE + ' bytes): ' + name);
      meta.type = 'file';
      data = fs.readFileSync(full);
      meta.size = data.length;
    } else return;
    const header = Buffer.from(JSON.stringify(meta));
    const size = Buffer.alloc(4);
    size.writeUInt32LE(header.length);
    total += 4 + header.length + (data ? data.length : 0);
    if (total > MAX) throw Error('Checkpoint expanded budget exceeded (' + MAX + ' bytes); reduce node_modules or drop the build output');
    chunks.push(size, header);
    if (data) chunks.push(data);
    if (meta.type === 'dir') for (const child of fs.readdirSync(full).sort()) walk(name + '/' + child);
  }
  for (const name of roots) if (fs.existsSync(path.join(ROOT, name))) walk(name);
  const bytes = zlib.gzipSync(Buffer.concat(chunks, total), { level: 3 });
  if (bytes.length > MAX_COMPRESSED) throw Error('Checkpoint compressed budget exceeded (' + MAX_COMPRESSED + ' bytes)');
  try { fs.writeFileSync(file, bytes); } catch (error) { throw Object.assign(Error(quotaMessage('saving the checkpoint to', file, error)), { code: 'ENOSPC' }); }
  let dependencies = {};
  try { const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')); dependencies = { ...pkg.dependencies, ...pkg.devDependencies }; } catch { /* no manifest */ }
  const rootModulesComplete = Object.keys(dependencies).every(name => fs.existsSync(path.join(ROOT, 'node_modules', name, 'package.json')));
  return { fingerprint: fingerprint(), compressedBytes: bytes.length, expandedBytes: total, entries: count, rootModulesComplete, dependencyNames: Object.keys(dependencies) };
}

function restore(file, expected) {
  let compressed;
  try { compressed = fs.readFileSync(file); } catch (error) { throw Error('Checkpoint file is unreadable: ' + error.message); }
  if (compressed.length > MAX_COMPRESSED) throw Error('Checkpoint compressed budget exceeded');
  const data = zlib.gunzipSync(compressed, { maxOutputLength: MAX });
  if (data.subarray(0, MAGIC.length).toString() !== MAGIC) throw Error('Unknown checkpoint format');
  if (expected && fingerprint() !== expected) throw Error('Checkpoint dependency fingerprint differs');

  /* Pass 1: validate everything before touching the workspace, so a corrupt
   * checkpoint can never leave a half-restored tree. */
  let offset = MAGIC.length, count = 0;
  const entries = [], roots = new Set(), links = [], seen = new Set(), skipped = new Set();
  while (offset < data.length) {
    if (++count > MAX_ENTRIES || offset + 4 > data.length) throw Error('Invalid checkpoint entry');
    const headerLength = data.readUInt32LE(offset);
    offset += 4;
    if (headerLength > 8192 || offset + headerLength > data.length) throw Error('Invalid checkpoint header');
    const meta = JSON.parse(data.subarray(offset, offset + headerLength).toString());
    offset += headerLength;
    if (unsafe(meta.path)) throw Error('Invalid checkpoint path');
    if (seen.has(meta.path)) throw Error('Duplicate checkpoint path: ' + meta.path);
    seen.add(meta.path);
    let payload = null;
    if (meta.type === 'file') {
      if (!Number.isInteger(meta.size) || meta.size < 0 || meta.size > MAX_FILE || offset + meta.size > data.length) throw Error('Invalid checkpoint file');
      payload = data.subarray(offset, offset + meta.size);
      offset += meta.size;
    } else if (meta.type === 'link') {
      if (typeof meta.target !== 'string' || meta.target.length > 4096 || meta.target.includes('\0')) throw Error('Invalid checkpoint link');
      const resolved = path.resolve(path.dirname(path.join(ROOT, meta.path)), meta.target);
      if (resolved !== ROOT && !resolved.startsWith(ROOT + path.sep)) throw Error('Checkpoint link escapes the workspace');
    } else if (meta.type !== 'dir') throw Error('Unknown checkpoint entry type');
    if (!covered(meta.path)) { skipped.add(rootOf(meta.path)); continue; }
    roots.add(rootOf(meta.path));
    entries.push({ meta, payload });
    if (meta.type === 'link') links.push({ target: path.join(ROOT, meta.path), link: meta.target });
  }

  /* Pass 2: replace each covered root in place. The checkpoint is the source of
   * truth for these roots, so the old copy is removed first instead of being
   * duplicated into a staging directory. */
  for (const root of roots) {
    const target = path.join(ROOT, root);
    if (!target.startsWith(ROOT + path.sep)) throw Error('Invalid checkpoint root');
    try { fs.rmSync(target, { recursive: true, force: true }); } catch (error) { throw Object.assign(Error(quotaMessage('replacing', root, error)), { code: 'ENOSPC' }); }
  }
  let written = 0;
  for (const { meta, payload } of entries) {
    const target = path.join(ROOT, meta.path);
    if (!target.startsWith(ROOT + path.sep)) throw Error('Invalid checkpoint path');
    try {
      if (meta.type === 'dir') fs.mkdirSync(target, { recursive: true, mode: meta.mode });
      else if (meta.type === 'file') {
        fs.mkdirSync(path.dirname(target), { recursive: true });
        writeFileQuotaAware(target, payload, meta.mode);
        written += payload.length;
      }
    } catch (error) {
      if (error.code === 'ENOSPC') throw error;
      throw Error('Checkpoint restore failed at ' + meta.path + ': ' + error.message);
    }
  }
  for (const link of links) {
    fs.mkdirSync(path.dirname(link.target), { recursive: true });
    try { fs.symlinkSync(link.link, link.target); }
    catch (error) { if (error.code !== 'EEXIST') throw Error('Checkpoint link restore failed: ' + error.message); }
  }
  return { entries: entries.length, expandedBytes: written, skippedRoots: [...skipped], roots: [...roots] };
}

function sizeOf(target) {
  let total = 0;
  let stat;
  try { stat = fs.lstatSync(target); } catch { return 0; }
  if (stat.isFile()) return stat.size;
  if (!stat.isDirectory()) return 0;
  for (const child of fs.readdirSync(target)) total += sizeOf(path.join(target, child));
  return total;
}

/** Removes rebuildable caches. Returns what was freed. */
function gc() {
  const freed = [];
  let bytes = 0;
  for (const name of GC_PATHS) {
    const target = path.join(ROOT, name);
    const size = sizeOf(target);
    if (!size && !fs.existsSync(target)) continue;
    try { fs.rmSync(target, { recursive: true, force: true }); }
    catch (error) { freed.push({ path: name, error: String(error.message) }); continue; }
    bytes += size;
    freed.push({ path: name, bytes: size });
  }
  /* Leftover staging directories from older builds. */
  try {
    const beownir = path.join(ROOT, '.beownir');
    for (const child of fs.readdirSync(beownir)) {
      if (!child.startsWith('restore-')) continue;
      const target = path.join(beownir, child);
      const size = sizeOf(target);
      try { fs.rmSync(target, { recursive: true, force: true }); bytes += size; freed.push({ path: '.beownir/' + child, bytes: size }); }
      catch (error) { freed.push({ path: '.beownir/' + child, error: String(error.message) }); }
    }
  } catch { /* no .beownir directory */ }
  return { freedBytes: bytes, freed };
}

module.exports = { pack, restore, fingerprint, gc, ROOT, ROOTS, GC_PATHS, MAX, MAX_COMPRESSED, MAX_FILE, MAX_ENTRIES };

if (require.main === module) {
  try {
    const [action, file, expected] = process.argv.slice(2);
    const result = action === 'pack' ? pack(file)
      : action === 'restore' ? restore(file, expected)
      : action === 'gc' ? gc()
      : action === 'fingerprint' ? { fingerprint: fingerprint() }
      : { roots: ROOTS, root: ROOT };
    console.log(JSON.stringify(result));
  } catch (error) {
    console.error(String(error?.stack || error));
    process.exitCode = 1;
  }
}
