'use strict';
// Beownir WASI host: the WASI class from Node's `wasi` module (preview1), implemented on the
// runtime's own file system and virtual loopback network. Every system call is plain JavaScript,
// so each one can be tested. Only unsupported process-level calls return ENOSYS.
const { Buffer } = require('buffer');
const process = require('process');
const fs = require('fs');
const nodePath = require('path');
const crypto = require('crypto');

let netModule = null;
function getNet() {
  if (!netModule) netModule = require('net');
  return netModule;
}

const ERRNO = {
  SUCCESS: 0,
  ACCES: 2,
  ADDRINUSE: 3,
  ADDRNOTAVAIL: 4,
  AFNOSUPPORT: 5,
  AGAIN: 6,
  BADF: 8,
  CONNABORTED: 13,
  CONNREFUSED: 14,
  CONNRESET: 15,
  EXIST: 20,
  INVAL: 28,
  IO: 29,
  ISCONN: 30,
  ISDIR: 31,
  NOBUFS: 42,
  NOENT: 44,
  NOSYS: 52,
  NOTCONN: 53,
  NOTDIR: 54,
  NOTEMPTY: 55,
  NOTSOCK: 57,
  NOTSUP: 58,
  PIPE: 64,
  TIMEDOUT: 73,
  NOTCAPABLE: 76,
};
const FILETYPE = { UNKNOWN: 0, DIRECTORY: 3, REGULAR_FILE: 4, SOCKET_DGRAM: 5, SOCKET_STREAM: 6, SYMBOLIC_LINK: 7 };
const OFLAGS = { CREAT: 1, DIRECTORY: 2, EXCL: 4, TRUNC: 8 };
const FDFLAGS = { APPEND: 1, DSYNC: 2, NONBLOCK: 4, RSYNC: 8, SYNC: 16 };
const FSTFLAGS = { ATIM: 1, ATIM_NOW: 2, MTIM: 4, MTIM_NOW: 8 };
const SOCK_RECV_PEEK = 1;
const SOCK_RECV_WAITALL = 2;
const SDFLAGS = { RD: 1, WR: 2 };
const WHENCE = { SET: 0, CUR: 1, END: 2 };
const ALL_RIGHTS = (1n << 64n) - 1n;
const ERRNO_BY_CODE = {
  EACCES: ERRNO.ACCES,
  EADDRINUSE: ERRNO.ADDRINUSE,
  EADDRNOTAVAIL: ERRNO.ADDRNOTAVAIL,
  EAFNOSUPPORT: ERRNO.AFNOSUPPORT,
  EAGAIN: ERRNO.AGAIN,
  EWOULDBLOCK: ERRNO.AGAIN,
  EBADF: ERRNO.BADF,
  ECONNABORTED: ERRNO.CONNABORTED,
  ECONNREFUSED: ERRNO.CONNREFUSED,
  ECONNRESET: ERRNO.CONNRESET,
  EEXIST: ERRNO.EXIST,
  EINVAL: ERRNO.INVAL,
  EISCONN: ERRNO.ISCONN,
  EISDIR: ERRNO.ISDIR,
  ENOENT: ERRNO.NOENT,
  ENOTCONN: ERRNO.NOTCONN,
  ENOTDIR: ERRNO.NOTDIR,
  ENOTEMPTY: ERRNO.NOTEMPTY,
  ENOTSOCK: ERRNO.NOTSOCK,
  ENOTSUP: ERRNO.NOTSUP,
  EOPNOTSUPP: ERRNO.NOTSUP,
  EPIPE: ERRNO.PIPE,
  ETIMEDOUT: ERRNO.TIMEDOUT,
  ENOTCAPABLE: ERRNO.NOTCAPABLE,
  EPERM: ERRNO.NOTCAPABLE,
};
const UNSUPPORTED = ['proc_raise', 'fd_readdir_cookie'];

function normalizeLoopbackHost(host) {
  const value = host === undefined || host === null || host === '' ? '127.0.0.1' : String(host).trim().toLowerCase();
  if (value === '127.0.0.1' || value === 'localhost' || value === '::1') return value;
  throw Object.assign(
    new Error('WASI sockets are restricted to virtual loopback hosts (127.0.0.1, localhost, ::1); refused: ' + host),
    { code: 'ENOTCAPABLE' },
  );
}

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

function makeSocketEntry(opts = {}) {
  return {
    kind: 'socket',
    listening: !!opts.listening,
    connected: !!opts.connected,
    fdFlags: opts.fdFlags ? (opts.fdFlags & FDFLAGS.NONBLOCK) : 0,
    shutRd: false,
    shutWr: false,
    eof: false,
    peerClosed: false,
    closed: false,
    recvChunks: [],
    acceptQueue: [],
    netSocket: opts.netSocket || null,
    netServer: opts.netServer || null,
    peerEntry: opts.peerEntry || null,
    localAddress: opts.localAddress || '127.0.0.1',
    localPort: opts.localPort || 0,
    remoteAddress: opts.remoteAddress || '127.0.0.1',
    remotePort: opts.remotePort || 0,
  };
}

function attachNetSocket(netSock, entry) {
  entry.netSocket = netSock;
  entry.connected = true;
  entry.localAddress = netSock.localAddress || entry.localAddress || '127.0.0.1';
  entry.localPort = netSock.localPort || entry.localPort || 0;
  entry.remoteAddress = netSock.remoteAddress || entry.remoteAddress || '127.0.0.1';
  entry.remotePort = netSock.remotePort || entry.remotePort || 0;
  netSock.on('data', chunk => {
    if (!entry.shutRd && !entry.closed) entry.recvChunks.push(Buffer.from(chunk));
  });
  netSock.on('end', () => { entry.eof = true; });
  netSock.on('close', () => { entry.eof = true; entry.peerClosed = true; });
  netSock.on('error', () => { entry.eof = true; entry.peerClosed = true; });
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
    this._stdinBuf = options.stdin !== undefined && options.stdin !== null
      ? (Buffer.isBuffer(options.stdin) ? options.stdin : Buffer.from(options.stdin))
      : null;
    this._stdinPos = 0;
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
    if (Array.isArray(options.sockets)) {
      for (const spec of options.sockets) {
        if (!spec) continue;
        const entry = makeSocketEntry({
          listening: !!spec.listening,
          connected: !!spec.connected || !!spec.socket,
          fdFlags: spec.fdFlags || 0,
        });
        if (spec.socket) attachNetSocket(spec.socket, entry);
        this._fds.set(this._nextFd++, entry);
      }
    }
    this._imports = this._buildImports();
    this.wasiImport = this._imports;
  }

  getImportObject() {
    return { [this._moduleName]: this._imports };
  }

  // Open a virtual-loopback listening socket fd on (host, port) inside the WASI descriptor table.
  // Restricted strictly to loopback addresses (127.0.0.1, localhost, ::1).
  openListener(options = {}) {
    const host = normalizeLoopbackHost(options.host);
    const requestedPort = options.port === undefined ? 0 : Number(options.port);
    if (!Number.isInteger(requestedPort) || requestedPort < 0 || requestedPort > 65535) {
      throw Object.assign(new RangeError('Invalid loopback port: ' + options.port), { code: 'EINVAL' });
    }
    const net = getNet();
    const entry = makeSocketEntry({ listening: true, localAddress: host, fdFlags: options.fdFlags || 0 });
    const fd = this._allocFd(entry);
    return new Promise((resolve, reject) => {
      const server = net.createServer(clientSock => {
        if (entry.closed) {
          try { clientSock.destroy(); } catch {}
          return;
        }
        // Buffer incoming bytes immediately so nothing is lost between TCP accept and sock_accept.
        const earlyChunks = [];
        const state = { ended: false, closed: false };
        const onData = chunk => earlyChunks.push(Buffer.from(chunk));
        const onEnd = () => { state.ended = true; };
        const onClose = () => { state.closed = true; };
        clientSock.on('data', onData);
        clientSock.on('end', onEnd);
        clientSock.on('close', onClose);
        entry.acceptQueue.push({ clientSock, earlyChunks, state, onData, onEnd, onClose });
      });
      entry.netServer = server;
      const onError = err => {
        this._fds.delete(fd);
        reject(err);
      };
      server.once('error', onError);
      server.listen(requestedPort, host, () => {
        server.removeListener('error', onError);
        const addr = typeof server.address === 'function' ? server.address() : null;
        entry.localPort = addr && typeof addr === 'object' && addr.port ? addr.port : requestedPort;
        resolve({ fd, host, port: entry.localPort, close: () => { try { callsCloseEntry(this, fd); } catch {} } });
      });
    });
  }

  // Connect a virtual-loopback TCP client socket fd to (host, port).
  connectSocket(options = {}) {
    const host = normalizeLoopbackHost(options.host);
    const port = Number(options.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw Object.assign(new RangeError('Invalid loopback port: ' + options.port), { code: 'EINVAL' });
    }
    const net = getNet();
    const entry = makeSocketEntry({
      connected: false,
      remoteAddress: host,
      remotePort: port,
      fdFlags: options.fdFlags || 0,
    });
    const fd = this._allocFd(entry);
    return new Promise((resolve, reject) => {
      const sock = net.connect({ host, port });
      attachNetSocket(sock, entry);
      const onErr = err => {
        this._fds.delete(fd);
        reject(err);
      };
      sock.once('error', onErr);
      sock.once('connect', () => {
        sock.removeListener('error', onErr);
        entry.connected = true;
        entry.localAddress = sock.localAddress || host;
        entry.localPort = sock.localPort || 0;
        resolve({ fd, host, port });
      });
    });
  }

  // Create a synchronous bidirectional virtual-loopback socket pair [fdA, fdB].
  openSocketPair() {
    const a = makeSocketEntry({ connected: true });
    const b = makeSocketEntry({ connected: true });
    a.peerEntry = b;
    b.peerEntry = a;
    return [this._allocFd(a), this._allocFd(b)];
  }

  // Close all open socket fds and flush dirty files (used for clean teardown).
  close() {
    for (const [fd, entry] of [...this._fds.entries()]) {
      if (fd < 3) continue;
      if (entry.kind === 'socket') callsCloseEntry(this, fd);
      else {
        this._flush(entry);
        this._fds.delete(fd);
      }
    }
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
    const wasi = new WASI({ ...options, stdout: capture('stdout'), stderr: capture('stderr') });
    try {
      const module = source instanceof WebAssembly.Module ? source : await WebAssembly.compile(source);
      const instance = await WebAssembly.instantiate(module, wasi.getImportObject());
      const status = wasi.start(instance);
      return { status, stdout: output.stdout.join(''), stderr: output.stderr.join(''), outputLimitExceeded: output.truncated };
    } finally {
      wasi.close();
    }
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
    if (kind && entry.kind !== kind) {
      const code = entry.kind === 'dir' ? 'EISDIR' : kind === 'socket' ? 'ENOTSOCK' : 'EBADF';
      throw Object.assign(new Error('wrong kind of fd'), { code });
    }
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

  // Reads from buffered socket chunks into iovecs. When peek=true, leaves recvChunks intact.
  _readSocketChunks(entry, iovs, iovsLen, peek) {
    let total = 0;
    let chunkIdx = 0;
    let chunkOff = 0;
    for (let i = 0; i < iovsLen; i++) {
      const ptr = this._view().getUint32(iovs + i * 8, true);
      const len = this._view().getUint32(iovs + i * 8 + 4, true);
      let wrote = 0;
      while (wrote < len && chunkIdx < entry.recvChunks.length) {
        const chunk = entry.recvChunks[chunkIdx];
        const avail = chunk.length - chunkOff;
        if (avail <= 0) { chunkIdx++; chunkOff = 0; continue; }
        const take = Math.min(len - wrote, avail);
        this._bytes(ptr + wrote, take).set(chunk.subarray(chunkOff, chunkOff + take));
        wrote += take;
        total += take;
        chunkOff += take;
        if (chunkOff >= chunk.length) { chunkIdx++; chunkOff = 0; }
      }
      if (wrote < len) break;
    }
    if (!peek && total > 0) {
      if (chunkOff > 0 && chunkIdx < entry.recvChunks.length) {
        entry.recvChunks = [entry.recvChunks[chunkIdx].subarray(chunkOff), ...entry.recvChunks.slice(chunkIdx + 1)];
      } else {
        entry.recvChunks = entry.recvChunks.slice(chunkIdx);
      }
    }
    return total;
  }

  _socketBufferedBytes(entry) {
    let n = 0;
    for (let i = 0; i < entry.recvChunks.length; i++) n += entry.recvChunks[i].length;
    return n;
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

  _writeSockPayload(entry, data) {
    if (entry.shutWr || entry.peerClosed) throw Object.assign(new Error('socket write after shutdown'), { code: 'EPIPE' });
    if (entry.peerEntry) {
      if (entry.peerEntry.shutRd || entry.peerEntry.closed) {
        throw Object.assign(new Error('peer closed'), { code: 'EPIPE' });
      }
      if (data.length) entry.peerEntry.recvChunks.push(data);
      return data.length;
    }
    if (!entry.netSocket || entry.netSocket.destroyed) {
      throw Object.assign(new Error('socket closed'), { code: 'EPIPE' });
    }
    if (data.length) entry.netSocket.write(data);
    return data.length;
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
        if (id < 0 || id > 3) return ERRNO.INVAL;
        this._view().setBigUint64(outPtr, id === 0 ? 1000000n : 1000n, true);
        return ERRNO.SUCCESS;
      },
      clock_time_get(id, precision, outPtr) {
        if (id < 0 || id > 3) return ERRNO.INVAL;
        const ns = id === 0
          ? BigInt(Date.now()) * 1000000n
          : (typeof performance !== 'undefined' && performance
            ? BigInt(Math.max(0, Math.round(performance.now() * 1000))) * 1000n
            : BigInt(Date.now()) * 1000000n);
        this._view().setBigUint64(outPtr, ns, true);
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
        const nowMonoMs = typeof performance !== 'undefined' && performance ? performance.now() : nowMs;
        for (let i = 0; i < count; i++) {
          const base = inPtr + i * 48;
          const userdata = view.getBigUint64(base, true);
          const type = view.getUint8(base + 8);
          if (type === 0) {
            const clockId = view.getUint32(base + 16, true);
            const timeoutNs = view.getBigUint64(base + 24, true);
            const flags = view.getUint16(base + 40, true);
            const refMs = clockId === 0 ? nowMs : nowMonoMs;
            const delayMs = (flags & 1) ? Math.max(0, Number(timeoutNs) / 1e6 - refMs) : Math.max(0, Number(timeoutNs) / 1e6);
            clocks.push({ userdata, type, delayMs });
          } else if (type === 1 || type === 2) {
            const fd = view.getInt32(base + 16, true);
            const entry = this._fds.get(fd);
            if (!entry) {
              ready.push({ userdata, type, error: ERRNO.BADF, nbytes: 0n, flags: 0 });
            } else if (type === 1) {
              if (entry.kind === 'file') {
                ready.push({ userdata, type, error: ERRNO.SUCCESS, nbytes: BigInt(Math.max(0, entry.data.length - entry.pos)), flags: 0 });
              } else if (entry.kind === 'stdin') {
                if (this._stdinBuf) {
                  const avail = Math.max(0, this._stdinBuf.length - this._stdinPos);
                  if (avail > 0 || count === 1) ready.push({ userdata, type, error: ERRNO.SUCCESS, nbytes: BigInt(avail), flags: avail === 0 ? 1 : 0 });
                } else if (count === 1) {
                  ready.push({ userdata, type, error: ERRNO.SUCCESS, nbytes: 0n, flags: 0 });
                }
              } else if (entry.kind === 'socket') {
                if (entry.listening) {
                  if (entry.acceptQueue.length > 0) {
                    ready.push({ userdata, type, error: ERRNO.SUCCESS, nbytes: BigInt(entry.acceptQueue.length), flags: 0 });
                  }
                } else {
                  const buffered = this._socketBufferedBytes(entry);
                  const hangup = entry.eof || entry.shutRd || entry.peerClosed;
                  if (buffered > 0 || hangup) {
                    ready.push({ userdata, type, error: ERRNO.SUCCESS, nbytes: BigInt(buffered), flags: hangup ? 1 : 0 });
                  }
                }
              } else {
                ready.push({ userdata, type, error: ERRNO.BADF, nbytes: 0n, flags: 0 });
              }
            } else {
              if (entry.kind === 'file' || entry.kind === 'stdout' || entry.kind === 'stderr') {
                ready.push({ userdata, type, error: ERRNO.SUCCESS, nbytes: 65536n, flags: 0 });
              } else if (entry.kind === 'socket') {
                if (entry.listening) {
                  ready.push({ userdata, type, error: ERRNO.INVAL, nbytes: 0n, flags: 0 });
                } else {
                  const closedWr = entry.shutWr || entry.peerClosed;
                  ready.push({ userdata, type, error: closedWr ? ERRNO.PIPE : ERRNO.SUCCESS, nbytes: closedWr ? 0n : 65536n, flags: closedWr ? 1 : 0 });
                }
              } else {
                ready.push({ userdata, type, error: ERRNO.BADF, nbytes: 0n, flags: 0 });
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
            if (c.delayMs <= minDelay + 1) ready.push({ userdata: c.userdata, type: 0, error: ERRNO.SUCCESS, nbytes: 0n, flags: 0 });
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
          if (ev.type === 1 || ev.type === 2) {
            outView.setBigUint64(ptr + 16, ev.nbytes, true);
            if (ev.flags) outView.setUint16(ptr + 24, ev.flags, true);
          }
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
        } else if (entry.kind === 'socket') {
          if (entry.listening || !entry.connected) throw Object.assign(new Error('socket not connected'), { code: 'ENOTCONN' });
          this._writeSockPayload(entry, data);
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
        } else if (entry.kind === 'stdin') {
          if (this._stdinBuf) {
            total = this._readInto({ data: this._stdinBuf }, iovs, iovsLen, this._stdinPos);
            this._stdinPos += total;
          }
        } else if (entry.kind === 'socket') {
          if (entry.listening || !entry.connected) throw Object.assign(new Error('socket not connected'), { code: 'ENOTCONN' });
          if (!entry.shutRd) {
            const avail = this._socketBufferedBytes(entry);
            if (avail === 0 && !(entry.eof || entry.peerClosed)) return ERRNO.AGAIN;
            total = this._readSocketChunks(entry, iovs, iovsLen, false);
          }
        } else if (entry.kind === 'dir') throw Object.assign(new Error('is a directory'), { code: 'EISDIR' });
        else throw Object.assign(new Error('fd is not readable'), { code: 'EBADF' });
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
      fd_filestat_set_times(fd, atim, mtim, fstFlags) {
        const entry = this._entry(fd);
        if (entry.kind !== 'file' && entry.kind !== 'dir') return ERRNO.INVAL;
        this._flush(entry);
        const st = fs.statSync(entry.host);
        const now = Date.now();
        const atime = (fstFlags & FSTFLAGS.ATIM_NOW) ? now : (fstFlags & FSTFLAGS.ATIM) ? Number(atim) / 1e6 : st.atimeMs;
        const mtime = (fstFlags & FSTFLAGS.MTIM_NOW) ? now : (fstFlags & FSTFLAGS.MTIM) ? Number(mtim) / 1e6 : st.mtimeMs;
        fs.utimesSync(entry.host, new Date(atime), new Date(mtime));
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
        if (from === to) return ERRNO.SUCCESS;
        if (this._fds.has(to)) {
          const prev = this._fds.get(to);
          if (prev.kind === 'socket') callsCloseEntry(this, to);
          else this._flush(prev);
        }
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
        if (entry.kind === 'socket') {
          callsCloseEntry(this, fd);
          return ERRNO.SUCCESS;
        }
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
        const type = entry.kind === 'dir'
          ? FILETYPE.DIRECTORY
          : entry.kind === 'file'
            ? FILETYPE.REGULAR_FILE
            : entry.kind === 'socket'
              ? FILETYPE.SOCKET_STREAM
              : FILETYPE.UNKNOWN;
        const view = this._view();
        view.setUint8(statPtr, type);
        view.setUint16(statPtr + 2, entry.kind === 'socket' ? (entry.fdFlags || 0) : 0, true);
        view.setBigUint64(statPtr + 8, ALL_RIGHTS, true);
        view.setBigUint64(statPtr + 16, ALL_RIGHTS, true);
        return ERRNO.SUCCESS;
      },
      fd_fdstat_set_flags(fd, flags) {
        const entry = this._entry(fd);
        if (entry.kind === 'socket') entry.fdFlags = flags & FDFLAGS.NONBLOCK;
        return ERRNO.SUCCESS;
      },
      fd_fdstat_set_rights(fd) {
        this._entry(fd);
        return ERRNO.SUCCESS;
      },
      fd_filestat_get(fd, statPtr) {
        const entry = this._entry(fd);
        if (entry.kind === 'file') {
          const st = fs.statSync(entry.host);
          this._writeFilestat(statPtr, FILETYPE.REGULAR_FILE, entry.data.length, st.mtimeMs);
        } else if (entry.kind === 'dir') {
          const st = fs.statSync(entry.host);
          this._writeFilestat(statPtr, FILETYPE.DIRECTORY, 0, st.mtimeMs);
        } else if (entry.kind === 'socket') {
          this._writeFilestat(statPtr, FILETYPE.SOCKET_STREAM, this._socketBufferedBytes(entry), Date.now());
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
        const cap = Math.max(0, Number(bufLen));
        if (cap === 0) {
          this._view().setUint32(usedPtr, 0, true);
          return ERRNO.SUCCESS;
        }
        const names = fs.readdirSync(entry.host);
        let used = 0;
        for (let index = Number(cookie); index < names.length; index++) {
          const name = Buffer.from(names[index]);
          const childPath = nodePath.join(entry.host, names[index]);
          const child = typeof fs.lstatSync === 'function' ? fs.lstatSync(childPath) : fs.statSync(childPath);
          const childType = typeof child.isSymbolicLink === 'function' && child.isSymbolicLink()
            ? FILETYPE.SYMBOLIC_LINK
            : child.isDirectory()
              ? FILETYPE.DIRECTORY
              : FILETYPE.REGULAR_FILE;
          const header = Buffer.alloc(24);
          header.writeBigUInt64LE(BigInt(index + 1), 0);
          header.writeBigUInt64LE(0n, 8);
          header.writeUInt32LE(name.length, 16);
          header.writeUInt8(childType, 20);
          const record = Buffer.concat([header, name]);
          const room = Math.max(0, cap - used);
          if (room > 0) this._bytes(bufPtr + used, Math.min(room, record.length)).set(record.subarray(0, Math.min(room, record.length)));
          used += Math.min(room, record.length);
          if (room < record.length) break;
        }
        this._view().setUint32(usedPtr, used, true);
        return ERRNO.SUCCESS;
      },
      path_open(dirfd, dirflags, pathPtr, pathLen, oflags, rightsBase, rightsInheriting, fdflags, fdPtr) {
        const host = this._resolve(dirfd, this._text(pathPtr, pathLen));
        let exists = fs.existsSync(host);
        if (!exists && typeof fs.lstatSync === 'function') {
          try { fs.lstatSync(host); exists = true; } catch {}
        }
        if (exists && (oflags & OFLAGS.EXCL)) throw Object.assign(new Error('file exists'), { code: 'EEXIST' });
        if (!exists) {
          if (!(oflags & OFLAGS.CREAT)) throw Object.assign(new Error('no such file'), { code: 'ENOENT' });
          fs.writeFileSync(host, '');
        }
        const st = fs.statSync(host);
        let fd;
        if (st.isDirectory()) {
          if (oflags & OFLAGS.TRUNC) throw Object.assign(new Error('is a directory'), { code: 'EISDIR' });
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
        const st = (flags & 1) === 0 && typeof fs.lstatSync === 'function' ? fs.lstatSync(host) : fs.statSync(host);
        const type = typeof st.isSymbolicLink === 'function' && st.isSymbolicLink()
          ? FILETYPE.SYMBOLIC_LINK
          : st.isDirectory()
            ? FILETYPE.DIRECTORY
            : FILETYPE.REGULAR_FILE;
        this._writeFilestat(statPtr, type, st.size, st.mtimeMs);
        return ERRNO.SUCCESS;
      },
      path_filestat_set_times(dirfd, flags, pathPtr, pathLen, atim, mtim, fstFlags) {
        const host = this._resolve(dirfd, this._text(pathPtr, pathLen));
        const follow = (flags & 1) !== 0;
        const st = !follow && typeof fs.lstatSync === 'function' ? fs.lstatSync(host) : fs.statSync(host);
        const now = Date.now();
        const atime = (fstFlags & FSTFLAGS.ATIM_NOW) ? now : (fstFlags & FSTFLAGS.ATIM) ? Number(atim) / 1e6 : st.atimeMs;
        const mtime = (fstFlags & FSTFLAGS.MTIM_NOW) ? now : (fstFlags & FSTFLAGS.MTIM) ? Number(mtim) / 1e6 : st.mtimeMs;
        if (!follow && typeof fs.lutimesSync === 'function') fs.lutimesSync(host, new Date(atime), new Date(mtime));
        else fs.utimesSync(host, new Date(atime), new Date(mtime));
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
        const st = typeof fs.lstatSync === 'function' ? fs.lstatSync(host) : fs.statSync(host);
        if (st.isDirectory()) throw Object.assign(new Error('is a directory'), { code: 'EISDIR' });
        fs.unlinkSync(host);
        return ERRNO.SUCCESS;
      },
      path_rename(oldDirfd, oldPtr, oldLen, newDirfd, newPtr, newLen) {
        fs.renameSync(this._resolve(oldDirfd, this._text(oldPtr, oldLen)), this._resolve(newDirfd, this._text(newPtr, newLen)));
        return ERRNO.SUCCESS;
      },
      path_link(oldDirfd, oldFlags, oldPtr, oldLen, newDirfd, newPtr, newLen) {
        const oldHost = this._resolve(oldDirfd, this._text(oldPtr, oldLen));
        const newHost = this._resolve(newDirfd, this._text(newPtr, newLen));
        fs.linkSync(oldHost, newHost);
        return ERRNO.SUCCESS;
      },
      path_symlink(oldPtr, oldLen, dirfd, newPtr, newLen) {
        const target = this._text(oldPtr, oldLen);
        if (nodePath.isAbsolute(target)) throw Object.assign(new Error('symlink target escapes preopen'), { code: 'ENOTCAPABLE' });
        const linkHost = this._resolve(dirfd, this._text(newPtr, newLen));
        const dir = this._entry(dirfd, 'dir');
        const resolvedTarget = nodePath.resolve(nodePath.dirname(linkHost), target);
        const prefix = dir.host.endsWith('/') ? dir.host : dir.host + '/';
        if (resolvedTarget !== dir.host && !resolvedTarget.startsWith(prefix)) {
          throw Object.assign(new Error('symlink target escapes preopen'), { code: 'ENOTCAPABLE' });
        }
        fs.symlinkSync(target, linkHost);
        return ERRNO.SUCCESS;
      },
      path_readlink(dirfd, pathPtr, pathLen, bufPtr, bufLen, usedPtr) {
        const host = this._resolve(dirfd, this._text(pathPtr, pathLen));
        const target = Buffer.from(String(fs.readlinkSync(host)));
        const count = Math.min(target.length, Number(bufLen));
        if (count > 0) this._bytes(bufPtr, count).set(target.subarray(0, count));
        this._view().setUint32(usedPtr, count, true);
        return ERRNO.SUCCESS;
      },
      sock_accept(fd, fdFlags, outFdPtr) {
        const entry = this._entry(fd, 'socket');
        if (!entry.listening) return ERRNO.INVAL;
        if (!outFdPtr) return ERRNO.INVAL;
        if (!entry.acceptQueue.length) return ERRNO.AGAIN;
        const accepted = entry.acceptQueue.shift();
        const child = makeSocketEntry({
          listening: false,
          connected: true,
          fdFlags: fdFlags || 0,
        });
        if (accepted && accepted.clientSock) {
          const { clientSock, earlyChunks, state, onData, onEnd, onClose } = accepted;
          clientSock.removeListener('data', onData);
          clientSock.removeListener('end', onEnd);
          clientSock.removeListener('close', onClose);
          for (let i = 0; i < earlyChunks.length; i++) child.recvChunks.push(earlyChunks[i]);
          if (state.ended) child.eof = true;
          if (state.closed) { child.eof = true; child.peerClosed = true; }
          attachNetSocket(clientSock, child);
        } else if (accepted) {
          attachNetSocket(accepted, child);
        }
        const childFd = this._allocFd(child);
        this._view().setUint32(outFdPtr, childFd, true);
        return ERRNO.SUCCESS;
      },
      sock_recv(fd, riDataPtr, riDataLen, riFlags, roDataLenPtr, roFlagsPtr) {
        const entry = this._entry(fd, 'socket');
        if (entry.listening || !entry.connected) return ERRNO.NOTCONN;
        if (!roDataLenPtr) return ERRNO.INVAL;
        if ((riFlags & ~(SOCK_RECV_PEEK | SOCK_RECV_WAITALL)) !== 0) return ERRNO.NOTSUP;
        if (entry.shutRd) {
          this._view().setUint32(roDataLenPtr, 0, true);
          if (roFlagsPtr) this._view().setUint32(roFlagsPtr, 0, true);
          return ERRNO.SUCCESS;
        }
        const avail = this._socketBufferedBytes(entry);
        if (avail === 0) {
          this._view().setUint32(roDataLenPtr, 0, true);
          if (roFlagsPtr) this._view().setUint32(roFlagsPtr, 0, true);
          return (entry.eof || entry.peerClosed) ? ERRNO.SUCCESS : ERRNO.AGAIN;
        }
        const peek = (riFlags & SOCK_RECV_PEEK) !== 0;
        const total = this._readSocketChunks(entry, riDataPtr, riDataLen, peek);
        this._view().setUint32(roDataLenPtr, total, true);
        if (roFlagsPtr) this._view().setUint32(roFlagsPtr, 0, true);
        return ERRNO.SUCCESS;
      },
      sock_send(fd, siDataPtr, siDataLen, siFlags, soDataLenPtr) {
        const entry = this._entry(fd, 'socket');
        if (entry.listening || !entry.connected) return ERRNO.NOTCONN;
        if (siFlags !== 0) return ERRNO.NOTSUP;
        if (!soDataLenPtr) return ERRNO.INVAL;
        const data = this._gather(siDataPtr, siDataLen);
        const sent = this._writeSockPayload(entry, data);
        this._view().setUint32(soDataLenPtr, sent, true);
        return ERRNO.SUCCESS;
      },
      sock_shutdown(fd, how) {
        const entry = this._entry(fd, 'socket');
        if (entry.listening || !entry.connected) return ERRNO.NOTCONN;
        if ((how & ~(SDFLAGS.RD | SDFLAGS.WR)) !== 0 || how === 0) return ERRNO.INVAL;
        if (how & SDFLAGS.RD) {
          entry.shutRd = true;
          entry.recvChunks.length = 0;
          if (entry.netSocket && typeof entry.netSocket.pause === 'function') {
            try { entry.netSocket.pause(); } catch {}
          }
        }
        if (how & SDFLAGS.WR) {
          entry.shutWr = true;
          if (entry.peerEntry) entry.peerEntry.eof = true;
          if (entry.netSocket && typeof entry.netSocket.end === 'function') {
            try { entry.netSocket.end(); } catch {}
          }
        }
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

function callsCloseEntry(wasi, fd) {
  const entry = wasi._fds.get(fd);
  if (!entry) return;
  entry.closed = true;
  if (entry.peerEntry) {
    entry.peerEntry.eof = true;
    entry.peerEntry.peerClosed = true;
  }
  while (entry.acceptQueue && entry.acceptQueue.length) {
    const accepted = entry.acceptQueue.shift();
    const sock = accepted && accepted.clientSock ? accepted.clientSock : accepted;
    try { if (sock && typeof sock.destroy === 'function') sock.destroy(); } catch {}
  }
  if (entry.netSocket && typeof entry.netSocket.destroy === 'function') {
    try { entry.netSocket.destroy(); } catch {}
  }
  if (entry.netServer && typeof entry.netServer.close === 'function') {
    try { entry.netServer.close(); } catch {}
  }
  wasi._fds.delete(fd);
}

module.exports = { WASI, WASIExit, ERRNO };
