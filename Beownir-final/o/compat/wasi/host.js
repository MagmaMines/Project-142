'use strict';
// Beownir WASI host: the WASI class from Node's `wasi` module (preview1), implemented on the
// runtime's own file system. Every system call is plain JavaScript, so each one can be tested.
// Calls that have no meaning in the browser return ENOSYS, and the program sees that errno.
const { Buffer } = require('buffer');
const process = require('process');
const fs = require('fs');
const nodePath = require('path');
const crypto = require('crypto');

const ERRNO = { SUCCESS: 0, BADF: 8, EXIST: 20, INVAL: 28, IO: 29, ISDIR: 31, NOENT: 44, NOSYS: 52, NOTDIR: 54, NOTEMPTY: 55, NOTCAPABLE: 76 };
const FILETYPE = { UNKNOWN: 0, DIRECTORY: 3, REGULAR_FILE: 4 };
const OFLAGS = { CREAT: 1, DIRECTORY: 2, EXCL: 4, TRUNC: 8 };
const WHENCE = { SET: 0, CUR: 1, END: 2 };
const ALL_RIGHTS = (1n << 64n) - 1n;
const ERRNO_BY_CODE = { ENOENT: ERRNO.NOENT, EEXIST: ERRNO.EXIST, EISDIR: ERRNO.ISDIR, ENOTDIR: ERRNO.NOTDIR, ENOTEMPTY: ERRNO.NOTEMPTY, EBADF: ERRNO.BADF, EINVAL: ERRNO.INVAL, ENOTCAPABLE: ERRNO.NOTCAPABLE };
const UNSUPPORTED = ['fd_filestat_set_times', 'path_link', 'path_readlink', 'path_symlink', 'path_filestat_set_times', 'proc_raise', 'sock_accept', 'sock_recv', 'sock_send', 'sock_shutdown', 'fd_readdir_cookie'];

// Errors have the same codes and messages as Node's WASI class, so code that handles them works unchanged.
function nodeError(code, message) {
  const error = new TypeError(message);
  error.code = code;
  return error;
}
function describe(value) {
  if (value === undefined) return 'undefined';
  if (value === null) return 'null';
  return typeof value === 'string' ? `'${value}'` : String(value);
}
function invalidType(name, type, value) {
  return nodeError('ERR_INVALID_ARG_TYPE', `The "${name}" property must be of type ${type}. Received ${describe(value)}`);
}

// Thrown by proc_exit. start() turns it into an exit code instead of unwinding the host.
class WASIExit extends Error {
  constructor(code) { super('WASI process exited with code ' + code); this.name = 'WASIExit'; this.code = code; }
}

function errnoFor(error) {
  if (error instanceof WASIExit) throw error;
  return ERRNO_BY_CODE[error && error.code] || ERRNO.IO;
}

class WASI {
  constructor(options) {
    if (options === undefined || options === null || typeof options !== 'object') {
      throw nodeError('ERR_INVALID_ARG_TYPE', `The "options" argument must be of type object. Received ${describe(options)}`);
    }
    if (typeof options.version !== 'string') throw invalidType('options.version', 'string', options.version);
    if (options.version !== 'preview1' && options.version !== 'unstable') {
      throw nodeError('ERR_INVALID_ARG_VALUE', `The property 'options.version' unsupported WASI version. Received '${options.version}'`);
    }
    this._moduleName = options.version === 'unstable' ? 'wasi_unstable' : 'wasi_snapshot_preview1';
    this._args = (options.args || []).map(String);
    this._env = Object.entries(options.env || {}).map(([key, value]) => key + '=' + value);
    this._stdout = typeof options.stdout === 'function' ? options.stdout : null;
    this._stderr = typeof options.stderr === 'function' ? options.stderr : null;
    this._memory = typeof WebAssembly !== 'undefined' && options.memory instanceof WebAssembly.Memory ? options.memory : null;
    this._fds = new Map([
      [0, { kind: 'stdin' }],
      [1, { kind: 'stdout' }],
      [2, { kind: 'stderr' }],
    ]);
    this._nextFd = 3;
    for (const [guest, host] of Object.entries(options.preopens || {})) {
      this._fds.set(this._nextFd++, { kind: 'dir', host: nodePath.resolve(host), preopen: guest });
    }
    this._imports = this._buildImports();
    this.wasiImport = this._imports;
  }

  getImportObject() {
    return { [this._moduleName]: this._imports };
  }

  // Runs a command module: calls _start and returns its exit code. Node requires _start here.
  start(instance) {
    this._memory = this._checkInstance(instance);
    if (typeof instance.exports._start !== 'function') throw invalidType('instance.exports._start', 'function', instance.exports._start);
    if (instance.exports._initialize !== undefined) throw invalidType('instance.exports._initialize', 'undefined', instance.exports._initialize);
    try {
      instance.exports._start();
      return 0;
    } catch (error) {
      if (error instanceof WASIExit) return error.code;
      throw error;
    }
  }

  // Prepares a reactor module: calls _initialize if it exists. Node forbids _start here.
  initialize(instance) {
    this._memory = this._checkInstance(instance);
    if (instance.exports._start !== undefined) throw invalidType('instance.exports._start', 'undefined', instance.exports._start);
    if (typeof instance.exports._initialize === 'function') instance.exports._initialize();
  }

  // Execute one WASI command module as a child of the current runtime. This is
  // an in-runtime WebAssembly task, not an operating-system process. The new
  // WASI instance has independent descriptors and returns proc_exit to parent.
  static async runChild(source, options = {}) {
    if (!(source instanceof WebAssembly.Module) && !(source instanceof ArrayBuffer) && !ArrayBuffer.isView(source)) {
      throw invalidType('source', 'WebAssembly.Module, ArrayBuffer, or typed array', source);
    }
    const maxOutputBytes = options.maxOutputBytes === undefined ? 1024 * 1024 : Number(options.maxOutputBytes);
    if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 0 || maxOutputBytes > 32 * 1024 * 1024) {
      throw nodeError('ERR_OUT_OF_RANGE', 'maxOutputBytes must be between 0 and 33554432');
    }
    const output = { stdout: [], stderr: [], bytes: 0, truncated: false };
    const capture = stream => text => {
      const value = String(text);
      const bytes = Buffer.from(value);
      const room = Math.max(0, maxOutputBytes - output.bytes);
      const kept = bytes.subarray(0, room);
      if (kept.length) output[stream].push(kept.toString('utf8'));
      output.bytes += kept.length;
      if (kept.length < bytes.length) output.truncated = true;
    };
    const wasi = new WASI({...options, stdout:capture('stdout'), stderr:capture('stderr')});
    const module = source instanceof WebAssembly.Module ? source : await WebAssembly.compile(source);
    const instance = await WebAssembly.instantiate(module, wasi.getImportObject());
    const status = wasi.start(instance);
    return {status, stdout:output.stdout.join(''), stderr:output.stderr.join(''), outputLimitExceeded:output.truncated};
  }

  _checkInstance(instance) {
    const exports = instance && instance.exports;
    if (typeof exports !== 'object' || exports === null) throw invalidType('instance.exports', 'object', exports);
    if (exports.memory instanceof WebAssembly.Memory) return exports.memory;
    if (this._memory instanceof WebAssembly.Memory) return this._memory;
    throw nodeError('ERR_INVALID_ARG_TYPE', `"instance.exports.memory" property must be a WebAssembly.Memory object. Received ${describe(exports.memory)}`);
  }

  // Memory is read through the buffer each time, because a memory that grows replaces its buffer.
  _bytes(ptr, len) { return new Uint8Array(this._memory.buffer, ptr, len); }
  _view() { return new DataView(this._memory.buffer); }
  _text(ptr, len) {
    const view = this._bytes(ptr, len);
    return new TextDecoder().decode(typeof SharedArrayBuffer !== 'undefined' && view.buffer instanceof SharedArrayBuffer ? view.slice() : view);
  }

  _entry(fd, kind) {
    const entry = this._fds.get(fd);
    if (!entry) throw Object.assign(new Error('bad fd'), { code: 'EBADF' });
    if (kind && entry.kind !== kind) throw Object.assign(new Error('wrong kind of fd'), { code: entry.kind === 'dir' ? 'EISDIR' : 'EBADF' });
    return entry;
  }

  // Path calls read the disk, so every open file with unsaved changes is written first.
  _flushAll() {
    for (const entry of this._fds.values()) this._flush(entry);
  }

  _resolve(dirfd, relative) {
    this._flushAll();
    const dir = this._entry(dirfd, 'dir');
    const host = nodePath.resolve(dir.host, relative);
    const prefix = dir.host.endsWith('/') ? dir.host : dir.host + '/';
    if (host !== dir.host && !host.startsWith(prefix)) throw Object.assign(new Error('path escapes the preopened directory'), { code: 'ENOTCAPABLE' });
    return host;
  }

  // Reads from entry.data at `position` into the iovecs. Returns the byte count.
  _readInto(entry, iovs, iovsLen, position) {
    let total = 0, at = position;
    for (let i = 0; i < iovsLen; i++) {
      const ptr = this._view().getUint32(iovs + i * 8, true);
      const len = this._view().getUint32(iovs + i * 8 + 4, true);
      const count = Math.max(0, Math.min(len, entry.data.length - at));
      this._bytes(ptr, count).set(entry.data.subarray(at, at + count));
      at += count;
      total += count;
      if (count < len) break;
    }
    return total;
  }

  // Gathers the iovecs into one buffer.
  _gather(iovs, iovsLen) {
    const chunks = [];
    for (let i = 0; i < iovsLen; i++) {
      const ptr = this._view().getUint32(iovs + i * 8, true);
      const len = this._view().getUint32(iovs + i * 8 + 4, true);
      chunks.push(Buffer.from(this._bytes(ptr, len)));
    }
    return Buffer.concat(chunks);
  }

  // Writes data into a file's buffer at `position`, growing the file with zeros if needed.
  _writeAt(entry, data, position) {
    const end = position + data.length;
    const grown = Buffer.alloc(Math.max(entry.data.length, end));
    entry.data.copy(grown, 0);
    data.copy(grown, position);
    entry.data = grown;
    entry.dirty = true;
  }

  _allocFd(entry) {
    const fd = this._nextFd++;
    this._fds.set(fd, entry);
    return fd;
  }

  _flush(entry) {
    if (entry.kind === 'file' && entry.dirty) {
      fs.writeFileSync(entry.host, entry.data);
      entry.dirty = false;
    }
  }

  _writeFilestat(ptr, type, size, mtimeMs) {
    const view = this._view();
    view.setBigUint64(ptr, 0n, true);
    view.setBigUint64(ptr + 8, 0n, true);
    view.setUint8(ptr + 16, type);
    view.setBigUint64(ptr + 24, 1n, true);
    view.setBigUint64(ptr + 32, BigInt(size), true);
    const time = BigInt(Math.round(mtimeMs)) * 1000000n;
    view.setBigUint64(ptr + 40, time, true);
    view.setBigUint64(ptr + 48, time, true);
    view.setBigUint64(ptr + 56, time, true);
  }

  _buildImports() {
    const self = this;
    const guard = fn => function (...args) {
      try { return fn.apply(self, args); } catch (error) { return errnoFor(error); }
    };
    const calls = {
      args_sizes_get(countPtr, sizePtr) {
        const size = this._args.reduce((total, arg) => total + Buffer.byteLength(arg) + 1, 0);
        this._view().setUint32(countPtr, this._args.length, true);
        this._view().setUint32(sizePtr, size, true);
        return ERRNO.SUCCESS;
      },
      args_get(argvPtr, bufPtr) {
        return this._writeStrings(this._args, argvPtr, bufPtr);
      },
      environ_sizes_get(countPtr, sizePtr) {
        const size = this._env.reduce((total, item) => total + Buffer.byteLength(item) + 1, 0);
        this._view().setUint32(countPtr, this._env.length, true);
        this._view().setUint32(sizePtr, size, true);
        return ERRNO.SUCCESS;
      },
      environ_get(argvPtr, bufPtr) {
        return this._writeStrings(this._env, argvPtr, bufPtr);
      },
      clock_res_get(id, outPtr) {
        this._view().setBigUint64(outPtr, 1000000n, true);
        return ERRNO.SUCCESS;
      },
      clock_time_get(id, precision, outPtr) {
        this._view().setBigUint64(outPtr, BigInt(Date.now()) * 1000000n, true);
        return ERRNO.SUCCESS;
      },
      random_get(ptr, len) {
        this._bytes(ptr, len).set(crypto.randomBytes(len));
        return ERRNO.SUCCESS;
      },
      sched_yield() { return ERRNO.SUCCESS; },
      poll_oneoff(inPtr, outPtr, nsubscriptions, neventsPtr) {
        const count = Number(nsubscriptions);
        if (!Number.isInteger(count) || count <= 0) return ERRNO.INVAL;
        const view = this._view();
        const ready = [];
        const clocks = [];
        const nowMs = Date.now();
        for (let i = 0; i < count; i++) {
          const base = inPtr + i * 48;
          const userdata = view.getBigUint64(base, true);
          const type = view.getUint8(base + 8);
          if (type === 0) {
            const timeoutNs = view.getBigUint64(base + 24, true);
            const flags = view.getUint16(base + 40, true);
            const delayMs = (flags & 1) ? Math.max(0, Number(timeoutNs) / 1e6 - nowMs) : Math.max(0, Number(timeoutNs) / 1e6);
            clocks.push({ userdata, type, delayMs });
          } else if (type === 1 || type === 2) {
            const fd = view.getInt32(base + 16, true);
            const entry = this._fds.get(fd);
            if (!entry) {
              ready.push({ userdata, type, error: ERRNO.BADF, nbytes: 0n });
            } else if (type === 1) {
              if (entry.kind === 'file') {
                ready.push({ userdata, type, error: ERRNO.SUCCESS, nbytes: BigInt(Math.max(0, entry.data.length - entry.pos)) });
              } else if (entry.kind === 'stdin') {
                if (count === 1) ready.push({ userdata, type, error: ERRNO.SUCCESS, nbytes: 0n });
              } else {
                ready.push({ userdata, type, error: ERRNO.BADF, nbytes: 0n });
              }
            } else {
              if (entry.kind === 'file' || entry.kind === 'stdout' || entry.kind === 'stderr') {
                ready.push({ userdata, type, error: ERRNO.SUCCESS, nbytes: 65536n });
              } else {
                ready.push({ userdata, type, error: ERRNO.BADF, nbytes: 0n });
              }
            }
          } else {
            return ERRNO.INVAL;
          }
        }
        if (!ready.length && clocks.length) {
          let minDelay = Infinity;
          for (const c of clocks) if (c.delayMs < minDelay) minDelay = c.delayMs;
          const waitMs = Math.max(0, Math.min(30000, Math.ceil(minDelay)));
          if (waitMs > 0) {
            let slept = false;
            if (typeof SharedArrayBuffer !== 'undefined' && typeof Atomics !== 'undefined') {
              try {
                Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, waitMs);
                slept = true;
              } catch {}
            }
            if (!slept) {
              const until = (typeof performance !== 'undefined' ? performance.now() : Date.now()) + waitMs;
              while ((typeof performance !== 'undefined' ? performance.now() : Date.now()) < until) {}
            }
          }
          for (const c of clocks) {
            if (c.delayMs <= minDelay + 1) ready.push({ userdata: c.userdata, type: 0, error: ERRNO.SUCCESS, nbytes: 0n });
          }
        }
        const outView = this._view();
        for (let i = 0; i < ready.length; i++) {
          const ev = ready[i];
          const ptr = outPtr + i * 32;
          this._bytes(ptr, 32).fill(0);
          outView.setBigUint64(ptr, ev.userdata, true);
          outView.setUint16(ptr + 8, ev.error, true);
          outView.setUint8(ptr + 10, ev.type);
          if (ev.type === 1 || ev.type === 2) outView.setBigUint64(ptr + 16, ev.nbytes, true);
        }
        outView.setUint32(neventsPtr, ready.length, true);
        return ERRNO.SUCCESS;
      },
      proc_exit(code) { throw new WASIExit(code); },
      fd_write(fd, iovs, iovsLen, writtenPtr) {
        const entry = this._entry(fd);
        const data = this._gather(iovs, iovsLen);
        if (entry.kind === 'stdout') (this._stdout || (text => process.stdout.write(text)))(data.toString('utf8'));
        else if (entry.kind === 'stderr') (this._stderr || (text => process.stderr.write(text)))(data.toString('utf8'));
        else if (entry.kind === 'file') {
          this._writeAt(entry, data, entry.pos);
          entry.pos += data.length;
        } else throw Object.assign(new Error('fd is not writable'), { code: entry.kind === 'dir' ? 'EISDIR' : 'EBADF' });
        this._view().setUint32(writtenPtr, data.length, true);
        return ERRNO.SUCCESS;
      },
      fd_read(fd, iovs, iovsLen, readPtr) {
        const entry = this._entry(fd);
        let total = 0;
        if (entry.kind === 'file') {
          total = this._readInto(entry, iovs, iovsLen, entry.pos);
          entry.pos += total;
        } else if (entry.kind === 'dir') throw Object.assign(new Error('is a directory'), { code: 'EISDIR' });
        else if (entry.kind !== 'stdin') throw Object.assign(new Error('fd is not readable'), { code: 'EBADF' });
        this._view().setUint32(readPtr, total, true);
        return ERRNO.SUCCESS;
      },
      fd_seek(fd, offset, whence, newPtr) {
        const entry = this._entry(fd, 'file');
        const base = whence === WHENCE.SET ? 0 : whence === WHENCE.CUR ? entry.pos : whence === WHENCE.END ? entry.data.length : -1;
        if (base < 0) return ERRNO.INVAL;
        const position = base + Number(offset);
        if (position < 0) return ERRNO.INVAL;
        entry.pos = position;
        this._view().setBigUint64(newPtr, BigInt(position), true);
        return ERRNO.SUCCESS;
      },
      fd_pread(fd, iovs, iovsLen, offset, readPtr) {
        const entry = this._entry(fd, 'file');
        const total = this._readInto(entry, iovs, iovsLen, Number(offset));
        this._view().setUint32(readPtr, total, true);
        return ERRNO.SUCCESS;
      },
      fd_pwrite(fd, iovs, iovsLen, offset, writtenPtr) {
        const entry = this._entry(fd, 'file');
        const data = this._gather(iovs, iovsLen);
        this._writeAt(entry, data, Number(offset));
        this._view().setUint32(writtenPtr, data.length, true);
        return ERRNO.SUCCESS;
      },
      fd_filestat_set_size(fd, size) {
        const entry = this._entry(fd, 'file');
        const length = Number(size);
        const resized = Buffer.alloc(length);
        entry.data.copy(resized, 0, 0, Math.min(length, entry.data.length));
        entry.data = resized;
        entry.dirty = true;
        return ERRNO.SUCCESS;
      },
      fd_allocate(fd, offset, length) {
        const entry = this._entry(fd, 'file');
        const end = Number(offset) + Number(length);
        if (end > entry.data.length) {
          const grown = Buffer.alloc(end);
          entry.data.copy(grown, 0);
          entry.data = grown;
          entry.dirty = true;
        }
        return ERRNO.SUCCESS;
      },
      fd_advise() { return ERRNO.SUCCESS; },
      fd_renumber(from, to) {
        const entry = this._entry(from);
        if (from < 3 || to < 0) throw Object.assign(new Error('bad fd'), { code: 'EBADF' });
        if (this._fds.has(to)) this._flush(this._fds.get(to));
        this._fds.delete(from);
        this._fds.set(to, entry);
        return ERRNO.SUCCESS;
      },
      fd_tell(fd, outPtr) {
        this._view().setBigUint64(outPtr, BigInt(this._entry(fd, 'file').pos), true);
        return ERRNO.SUCCESS;
      },
      fd_close(fd) {
        if (fd < 3) throw Object.assign(new Error('standard streams stay open'), { code: 'EBADF' });
        const entry = this._entry(fd);
        this._flush(entry);
        this._fds.delete(fd);
        return ERRNO.SUCCESS;
      },
      fd_sync(fd) {
        this._flush(this._entry(fd));
        return ERRNO.SUCCESS;
      },
      fd_datasync(fd) {
        this._flush(this._entry(fd));
        return ERRNO.SUCCESS;
      },
      fd_fdstat_get(fd, statPtr) {
        const entry = this._entry(fd);
        const type = entry.kind === 'dir' ? FILETYPE.DIRECTORY : entry.kind === 'file' ? FILETYPE.REGULAR_FILE : FILETYPE.UNKNOWN;
        const view = this._view();
        view.setUint8(statPtr, type);
        view.setUint16(statPtr + 2, 0, true);
        view.setBigUint64(statPtr + 8, ALL_RIGHTS, true);
        view.setBigUint64(statPtr + 16, ALL_RIGHTS, true);
        return ERRNO.SUCCESS;
      },
      fd_fdstat_set_flags() { return ERRNO.SUCCESS; },
      fd_filestat_get(fd, statPtr) {
        const entry = this._entry(fd);
        if (entry.kind === 'file') {
          const st = fs.statSync(entry.host);
          this._writeFilestat(statPtr, FILETYPE.REGULAR_FILE, entry.data.length, st.mtimeMs);
        } else if (entry.kind === 'dir') {
          const st = fs.statSync(entry.host);
          this._writeFilestat(statPtr, FILETYPE.DIRECTORY, 0, st.mtimeMs);
        } else {
          this._writeFilestat(statPtr, FILETYPE.UNKNOWN, 0, Date.now());
        }
        return ERRNO.SUCCESS;
      },
      fd_prestat_get(fd, ptr) {
        const entry = this._entry(fd, 'dir');
        if (entry.preopen === undefined) throw Object.assign(new Error('not a preopened directory'), { code: 'EBADF' });
        this._view().setUint8(ptr, 0);
        this._view().setUint32(ptr + 4, Buffer.byteLength(entry.preopen), true);
        return ERRNO.SUCCESS;
      },
      fd_prestat_dir_name(fd, pathPtr, pathLen) {
        const entry = this._entry(fd, 'dir');
        if (entry.preopen === undefined) throw Object.assign(new Error('not a preopened directory'), { code: 'EBADF' });
        this._bytes(pathPtr, pathLen).set(Buffer.from(entry.preopen).subarray(0, pathLen));
        return ERRNO.SUCCESS;
      },
      fd_readdir(fd, bufPtr, bufLen, cookie, usedPtr) {
        const entry = this._entry(fd, 'dir');
        const names = fs.readdirSync(entry.host);
        let used = 0;
        for (let index = Number(cookie); index < names.length; index++) {
          const name = Buffer.from(names[index]);
          const child = fs.statSync(nodePath.join(entry.host, names[index]));
          const header = Buffer.alloc(24);
          header.writeBigUInt64LE(BigInt(index + 1), 0);
          header.writeBigUInt64LE(0n, 8);
          header.writeUInt32LE(name.length, 16);
          header.writeUInt8(child.isDirectory() ? FILETYPE.DIRECTORY : FILETYPE.REGULAR_FILE, 20);
          const record = Buffer.concat([header, name]);
          const room = Math.max(0, Number(bufLen) - used);
          this._bytes(bufPtr + used, Math.min(room, record.length)).set(record.subarray(0, Math.min(room, record.length)));
          used += Math.min(room, record.length);
          if (room < record.length) break;
        }
        this._view().setUint32(usedPtr, used, true);
        return ERRNO.SUCCESS;
      },
      path_open(dirfd, dirflags, pathPtr, pathLen, oflags, rightsBase, rightsInheriting, fdflags, fdPtr) {
        const host = this._resolve(dirfd, this._text(pathPtr, pathLen));
        const exists = fs.existsSync(host);
        if (exists && (oflags & OFLAGS.EXCL)) throw Object.assign(new Error('file exists'), { code: 'EEXIST' });
        if (!exists) {
          if (!(oflags & OFLAGS.CREAT)) throw Object.assign(new Error('no such file'), { code: 'ENOENT' });
          fs.writeFileSync(host, '');
        }
        const st = fs.statSync(host);
        let fd;
        if (st.isDirectory()) {
          fd = this._allocFd({ kind: 'dir', host });
        } else {
          if (oflags & OFLAGS.DIRECTORY) throw Object.assign(new Error('not a directory'), { code: 'ENOTDIR' });
          const truncate = (oflags & OFLAGS.TRUNC) !== 0;
          const data = truncate ? Buffer.alloc(0) : Buffer.from(fs.readFileSync(host));
          fd = this._allocFd({ kind: 'file', host, data, pos: 0, dirty: truncate });
        }
        this._view().setUint32(fdPtr, fd, true);
        return ERRNO.SUCCESS;
      },
      path_filestat_get(dirfd, flags, pathPtr, pathLen, statPtr) {
        const host = this._resolve(dirfd, this._text(pathPtr, pathLen));
        const st = fs.statSync(host);
        this._writeFilestat(statPtr, st.isDirectory() ? FILETYPE.DIRECTORY : FILETYPE.REGULAR_FILE, st.size, st.mtimeMs);
        return ERRNO.SUCCESS;
      },
      path_create_directory(dirfd, pathPtr, pathLen) {
        fs.mkdirSync(this._resolve(dirfd, this._text(pathPtr, pathLen)));
        return ERRNO.SUCCESS;
      },
      path_remove_directory(dirfd, pathPtr, pathLen) {
        fs.rmdirSync(this._resolve(dirfd, this._text(pathPtr, pathLen)));
        return ERRNO.SUCCESS;
      },
      path_unlink_file(dirfd, pathPtr, pathLen) {
        const host = this._resolve(dirfd, this._text(pathPtr, pathLen));
        if (fs.statSync(host).isDirectory()) throw Object.assign(new Error('is a directory'), { code: 'EISDIR' });
        fs.unlinkSync(host);
        return ERRNO.SUCCESS;
      },
      path_rename(oldDirfd, oldPtr, oldLen, newDirfd, newPtr, newLen) {
        fs.renameSync(this._resolve(oldDirfd, this._text(oldPtr, oldLen)), this._resolve(newDirfd, this._text(newPtr, newLen)));
        return ERRNO.SUCCESS;
      },
    };
    const imports = {};
    for (const [name, fn] of Object.entries(calls)) imports[name] = guard(fn).bind(this);
    for (const name of UNSUPPORTED) imports[name] = () => ERRNO.NOSYS;
    return imports;
  }

  _writeStrings(items, listPtr, bufPtr) {
    let offset = bufPtr;
    items.forEach((item, index) => {
      this._view().setUint32(listPtr + index * 4, offset, true);
      const encoded = Buffer.from(item + '\0');
      this._bytes(offset, encoded.length).set(encoded);
      offset += encoded.length;
    });
    return ERRNO.SUCCESS;
  }
}

module.exports = { WASI, WASIExit, ERRNO };
