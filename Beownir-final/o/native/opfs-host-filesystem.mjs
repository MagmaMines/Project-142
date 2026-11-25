/* Browser-only OPFS backing store for the SDK host mount.
 *
 * The WASIX worker blocks on a SharedArrayBuffer RPC while this supervisor
 * performs asynchronous OPFS work. Every mount is scoped to one execution
 * group. Mutating operations are serialized; this is required by OPFS and is
 * especially important while pnpm is linking a large dependency graph.
 */
import { respondToHostFileSystem } from '/node_modules/@wasmer/sdk/dist/host-filesystem.js';

const nowNanos = () => String(Math.trunc(Date.now() * 1e6));
const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
const safeNamespace = value => {
  const name = String(value || 'workspace');
  if (!/^[a-zA-Z0-9_-]{1,120}$/.test(name)) fail('EINVAL', 'Invalid OPFS namespace');
  return name;
};
function mapError(error, fallback = 'EIO') {
  if (typeof error?.code === 'string') return error;
  const name = String(error?.name || '');
  const code = name === 'NotFoundError' ? 'ENOENT' :
    name === 'TypeMismatchError' ? 'ENOTDIR' :
    name === 'InvalidModificationError' ? 'ENOTEMPTY' :
    name === 'NoModificationAllowedError' ? 'EACCES' :
    name === 'QuotaExceededError' ? 'ENOSPC' :
    name === 'AbortError' ? 'ECANCELED' : fallback;
  return Object.assign(new Error(String(error?.message || error || 'OPFS error')), { code });
}
function bytes(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  if (Array.isArray(value)) return Uint8Array.from(value);
  fail('EINVAL', 'Expected filesystem bytes');
}
function pieces(path) {
  const value = String(path ?? '').replace(/^\/+|\/+$/g, '');
  if (!value) return [];
  if (value.length > 2048 || value.includes('\\') || value.includes('\0')) fail('EACCES', 'Invalid mounted filesystem path');
  const out = value.split('/');
  if (out.some(part => !part || part === '.' || part === '..')) fail('EACCES', 'Invalid mounted filesystem path');
  return out;
}
function metadata(kind, size = 0, modified = Date.now()) {
  const stamp = String(Math.max(0, Math.trunc(modified)) * 1e6);
  return { kind, size, accessed: stamp, modified: stamp, created: stamp || nowNanos() };
}
function recursiveOption(value) {
  return value === true || (value && typeof value === 'object' && value.recursive === true);
}

class OPFSHostFileSystem {
  constructor(root) {
    this.root = root;
    this.handles = new Map();
    this.nextHandle = 1;
    this.writeChain = Promise.resolve();
    this.closed = false;
  }
  assertOpen() { if (this.closed) fail('EIO', 'OPFS mount is closed'); }
  async entry(path) {
    this.assertOpen();
    const names = pieces(path);
    let directory = this.root;
    if (!names.length) return { handle: directory, kind: 'directory' };
    for (let index = 0; index < names.length - 1; index++) directory = await directory.getDirectoryHandle(names[index]);
    const name = names[names.length - 1];
    try { return { handle: await directory.getFileHandle(name), kind: 'file', parent: directory, name }; }
    catch (fileError) {
      if (fileError?.name !== 'NotFoundError' && fileError?.name !== 'TypeMismatchError') throw fileError;
      try { return { handle: await directory.getDirectoryHandle(name), kind: 'directory', parent: directory, name }; }
      catch (directoryError) {
        if (directoryError?.name === 'NotFoundError') throw fileError;
        throw directoryError;
      }
    }
  }
  async parent(path) {
    this.assertOpen();
    const names = pieces(path);
    if (!names.length) fail('EACCES', 'Cannot modify mount root');
    let directory = this.root;
    for (let index = 0; index < names.length - 1; index++) directory = await directory.getDirectoryHandle(names[index]);
    return { directory, name: names[names.length - 1] };
  }
  async mkdirParents(names) {
    let directory = this.root;
    for (const name of names) {
      try { directory = await directory.getDirectoryHandle(name); }
      catch (error) {
        if (error?.name === 'TypeMismatchError') fail('ENOTDIR', 'A parent path is a file: ' + name);
        if (error?.name !== 'NotFoundError') throw error;
        directory = await directory.getDirectoryHandle(name, { create: true });
      }
    }
    return directory;
  }
  write(task) {
    const next = this.writeChain.then(async () => { this.assertOpen(); return task(); }, async () => { this.assertOpen(); return task(); });
    this.writeChain = next.catch(() => {});
    return next;
  }
  async stat(path) {
    const found = await this.entry(path);
    if (found.kind === 'directory') return metadata('directory');
    const file = await found.handle.getFile();
    return metadata('file', file.size, file.lastModified);
  }
  async readDir(path) {
    const found = await this.entry(path);
    if (found.kind !== 'directory') fail('ENOTDIR', 'Not a directory');
    const result = [];
    for await (const [name, handle] of found.handle.entries()) {
      if (handle.kind === 'directory') result.push({ name, ...metadata('directory') });
      else { const file = await handle.getFile(); result.push({ name, ...metadata('file', file.size, file.lastModified) }); }
    }
    return result.sort((a, b) => a.name.localeCompare(b.name));
  }
  async open(path, read, write, create, createNew, truncate, append) {
    return this.write(async () => {
      const { directory, name } = await this.parent(path);
      let existing = null;
      try { existing = await directory.getFileHandle(name); }
      catch (error) {
        if (error?.name === 'TypeMismatchError') fail('EISDIR', 'Path is a directory');
        if (error?.name !== 'NotFoundError') throw error;
      }
      if (createNew && existing) fail('EEXIST', 'File already exists');
      if (!existing && !create) fail('ENOENT', 'No such file');
      const handle = existing || await directory.getFileHandle(name, { create: true });
      if (truncate) { const stream = await handle.createWritable({ keepExistingData: true }); await stream.truncate(0); await stream.close(); }
      const id = this.nextHandle++;
      this.handles.set(id, { handle, read: !!read, write: !!write, append: !!append });
      return id;
    });
  }
  record(id) { this.assertOpen(); const value = this.handles.get(Number(id)); if (!value) fail('EBADF', 'Closed file handle'); return value; }
  async fileStat(id) { const file = await this.record(id).handle.getFile(); return metadata('file', file.size, file.lastModified); }
  async read(id, offset, length) {
    const record = this.record(id); if (!record.read) fail('EACCES', 'File is not readable');
    const file = await record.handle.getFile();
    const start = Math.max(0, Number(offset) || 0), size = Math.min(512 * 1024, Math.max(0, Number(length) || 0));
    return new Uint8Array(await file.slice(start, start + size).arrayBuffer());
  }
  async writeAt(id, offset, value) {
    const record = this.record(id); if (!record.write) fail('EACCES', 'File is not writable');
    const data = bytes(value);
    return this.write(async () => {
      let position = Math.max(0, Number(offset) || 0);
      if (record.append) position = (await record.handle.getFile()).size;
      const stream = await record.handle.createWritable({ keepExistingData: true });
      try { await stream.write({ type: 'write', position, data }); }
      finally { await stream.close(); }
      return data.byteLength;
    });
  }
  async setLen(id, length) {
    const record = this.record(id); if (!record.write) fail('EACCES', 'File is not writable');
    return this.write(async () => {
      const stream = await record.handle.createWritable({ keepExistingData: true });
      try { await stream.truncate(Math.max(0, Number(length) || 0)); }
      finally { await stream.close(); }
      return null;
    });
  }
  async mkdir(path, options = {}) {
    return this.write(async () => {
      const names = pieces(path);
      if (!names.length) return null;
      if (recursiveOption(options)) { await this.mkdirParents(names); return null; }
      const { directory, name } = await this.parent(path);
      try { await directory.getFileHandle(name); fail('EEXIST', 'Path exists'); }
      catch (error) { if (typeof error?.code === 'string') throw error; if (!['NotFoundError', 'TypeMismatchError'].includes(error?.name)) throw error; }
      try { await directory.getDirectoryHandle(name); fail('EEXIST', 'Path exists'); }
      catch (error) { if (typeof error?.code === 'string') throw error; if (error?.name !== 'NotFoundError') throw error; }
      await directory.getDirectoryHandle(name, { create: true });
      return null;
    });
  }
  async remove(path, options = {}) {
    return this.write(async () => {
      const { directory, name } = await this.parent(path);
      await directory.removeEntry(name, { recursive: recursiveOption(options) });
      return null;
    });
  }
  async copyDirectory(source, destination) {
    for await (const [name, entry] of source.entries()) {
      if (entry.kind === 'directory') {
        const next = await destination.getDirectoryHandle(name, { create: true });
        await this.copyDirectory(entry, next);
      } else {
        const target = await destination.getFileHandle(name, { create: true });
        const input = await entry.getFile();
        const stream = await target.createWritable({ keepExistingData: false });
        try {
          for (let offset = 0; offset < input.size; offset += 65536) {
            const part = new Uint8Array(await input.slice(offset, Math.min(offset + 65536, input.size)).arrayBuffer());
            await stream.write({ type: 'write', position: offset, data: part });
          }
        } finally { await stream.close(); }
      }
    }
  }
  async rename(from, to) {
    return this.write(async () => {
      const oldParent = await this.parent(from), nextParent = await this.parent(to);
      const fromPath = pieces(from), toPath = pieces(to);
      if (fromPath.join('/') === toPath.join('/')) { await this.entry(from); return null; }
      if (fromPath.length < toPath.length && fromPath.every((part, index) => part === toPath[index])) fail('EINVAL', 'Cannot move a directory into itself');
      let source;
      try { source = await oldParent.directory.getFileHandle(oldParent.name); }
      catch (fileError) { try { source = await oldParent.directory.getDirectoryHandle(oldParent.name); } catch { throw fileError; } }
      try { await nextParent.directory.removeEntry(nextParent.name, { recursive: true }); }
      catch (error) { if (error?.name !== 'NotFoundError') throw error; }
      if (source.kind === 'directory') {
        const target = await nextParent.directory.getDirectoryHandle(nextParent.name, { create: true });
        await this.copyDirectory(source, target);
      } else {
        const input = await source.getFile(), target = await nextParent.directory.getFileHandle(nextParent.name, { create: true });
        const stream = await target.createWritable({ keepExistingData: false });
        try {
          for (let offset = 0; offset < input.size; offset += 65536) {
            const part = new Uint8Array(await input.slice(offset, Math.min(offset + 65536, input.size)).arrayBuffer());
            await stream.write({ type: 'write', position: offset, data: part });
          }
        } finally { await stream.close(); }
      }
      await oldParent.directory.removeEntry(oldParent.name, { recursive: source.kind === 'directory' });
      return null;
    });
  }
  close() { this.closed = true; this.handles.clear(); }
  async dispatch(method, args) {
    switch (method) {
      case 'stat': return this.stat(args[0]);
      case 'readDir': return this.readDir(args[0]);
      case 'open': return this.open(...args);
      case 'mkdir': return this.mkdir(args[0], args[1]);
      case 'remove': return this.remove(args[0], args[1]);
      case 'rename': return this.rename(args[0], args[1]);
      case 'sync': case 'flush': case 'setTimes': case 'setFileTimes': return null;
      case 'fileStat': return this.fileStat(args[0]);
      case 'read': return this.read(args[0], args[1], args[2]);
      case 'write': return this.writeAt(args[0], args[1], args[2]);
      case 'setLen': return this.setLen(args[0], args[1]);
      case 'close': this.handles.delete(Number(args[0])); return null;
      default: fail('ENOSYS', 'Unsupported OPFS filesystem operation: ' + method);
    }
  }
}

function routerState() {
  const key = '__beownirOPFSHostRouterState';
  if (globalThis[key]) return globalThis[key];
  const previous = globalThis.__beownirHostFileSystemRpc;
  const state = { previous, providers: new Map(), handler: null };
  state.handler = request => {
    const provider = state.providers.get(request?.mount);
    if (!provider) return typeof state.previous === 'function' ? state.previous(request) : false;
    Promise.resolve(provider.dispatch(request.method, request.args || []))
      .then(value => respondToHostFileSystem(request, { value }), error => {
        const mapped = mapError(error);
        respondToHostFileSystem(request, { error: { code: mapped.code || 'EIO', message: String(mapped.message || error) } });
      });
    return true;
  };
  globalThis.__beownirHostFileSystemRpc = state.handler;
  globalThis[key] = state;
  return state;
}

export async function installOPFSHostFileSystem(mount, namespace) {
  if (!Number.isInteger(mount) || mount < 0 || mount > 0xffffffff) fail('EINVAL', 'Invalid OPFS mount id');
  if (!navigator.storage?.getDirectory) fail('ENOTSUP', 'Origin Private File System is unavailable');
  const storage = await navigator.storage.getDirectory();
  const base = await storage.getDirectoryHandle('beownir-wasix-v1', { create: true });
  const name = safeNamespace(namespace);
  try { await base.removeEntry(name, { recursive: true }); } catch (error) { if (error?.name !== 'NotFoundError') throw mapError(error); }
  const provider = new OPFSHostFileSystem(await base.getDirectoryHandle(name, { create: true }));
  const state = routerState();
  if (state.providers.has(mount)) fail('EEXIST', 'OPFS mount id is already active');
  state.providers.set(mount, provider);
  return Object.freeze({
    provider,
    dispose() {
      provider.close();
      state.providers.delete(mount);
      if (state.providers.size === 0 && globalThis.__beownirHostFileSystemRpc === state.handler) {
        globalThis.__beownirHostFileSystemRpc = state.previous;
        delete globalThis.__beownirOPFSHostRouterState;
      }
    }
  });
}
