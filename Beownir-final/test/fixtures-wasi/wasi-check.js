// Runs inside the Beownir runtime. Each function exercises the WASI host through Node's API.
const fs = require('fs');
const { WASI } = require('wasi');

function memoryHarness() {
  const memory = new WebAssembly.Memory({ initial: 2 });
  const bytes = () => new Uint8Array(memory.buffer);
  const view = () => new DataView(memory.buffer);
  const put = (ptr, text) => { const encoded = Buffer.from(text); bytes().set(encoded, ptr); return encoded.length; };
  return { memory, bytes, view, put };
}

module.exports.fileSystem = function () {
  const { memory, bytes, view, put } = memoryHarness();
  fs.rmSync('/project/wasi-sandbox', { recursive: true, force: true });
  fs.mkdirSync('/project/wasi-sandbox', { recursive: true });
  const wasi = new WASI({ version: 'preview1', args: ['prog', 'one'], env: { MODE: 'test' }, preopens: { '/data': '/project/wasi-sandbox' } });
  const api = wasi.getImportObject().wasi_snapshot_preview1;
  const r = {};
  const originalWrite = process.stdout.write;
  let printed = '';
  process.stdout.write = chunk => { printed += chunk; return true; };
  try {
    r.exit = wasi.start({ exports: { memory, _start() {
      const name = put(0, 'hello.txt');
      r.open = api.path_open(3, 0, 0, name, 1, 0n, 0n, 0, 512);
      const fd = view().getUint32(512, true);
      const text = put(700, 'hello wasi!');
      view().setUint32(600, 700, true); view().setUint32(604, text, true);
      r.write = api.fd_write(fd, 600, 1, 608);
      r.written = view().getUint32(608, true);
      r.close = api.fd_close(fd);
      r.reopen = api.path_open(3, 0, 0, name, 0, 0n, 0n, 0, 512);
      const readFd = view().getUint32(512, true);
      view().setUint32(600, 1000, true); view().setUint32(604, 64, true);
      r.read = api.fd_read(readFd, 600, 1, 608);
      r.readText = Buffer.from(bytes().subarray(1000, 1000 + view().getUint32(608, true))).toString();
      r.seek = api.fd_seek(readFd, 6n, 0, 616);
      r.seekTo = Number(view().getBigUint64(616, true));
      r.tell = api.fd_tell(readFd, 624);
      r.close2 = api.fd_close(readFd);
      r.stat = api.path_filestat_get(3, 0, 0, name, 800);
      r.size = Number(view().getBigUint64(800 + 32, true));
      r.missing = api.path_open(3, 0, 900, put(900, 'nope.txt'), 0, 0n, 0n, 0, 512);
      r.escape = api.path_open(3, 0, 900, put(900, '../outside'), 0, 0n, 0n, 0, 512);
      r.exclusive = api.path_open(3, 0, 0, name, 1 | 4, 0n, 0n, 0, 512);
      r.mkdir = api.path_create_directory(3, 900, put(900, 'sub'));
      r.mkdirAgain = api.path_create_directory(3, 900, put(900, 'sub'));
      r.openDir = api.path_open(3, 0, 900, put(900, '.'), 0, 0n, 0n, 0, 512);
      const dirFd = view().getUint32(512, true);
      r.readdir = api.fd_readdir(dirFd, 1200, 512, 0n, 1100);
      r.listed = [];
      let offset = 0; const used = view().getUint32(1100, true);
      while (offset < used) {
        const nameLen = view().getUint32(1200 + offset + 16, true);
        r.listed.push(Buffer.from(bytes().subarray(1200 + offset + 24, 1200 + offset + 24 + nameLen)).toString());
        offset += 24 + nameLen;
      }
      r.unlink = api.path_unlink_file(3, 0, name);
      r.existsAfterUnlink = fs.existsSync('/project/wasi-sandbox/hello.txt');
      view().setUint32(600, 700, true); view().setUint32(604, 11, true);
      r.stdout = api.fd_write(1, 600, 1, 608);
      r.badFd = api.fd_close(77);
      return 0;
    } } });
  } finally {
    process.stdout.write = originalWrite;
  }
  r.printedToStdout = printed;
  return JSON.stringify(r);
};

module.exports.environment = function () {
  const { memory, view } = memoryHarness();
  const wasi = new WASI({ version: 'preview1', args: ['prog', 'one'], env: { MODE: 'test', N: '1' } });
  const api = wasi.getImportObject().wasi_snapshot_preview1;
  const r = {};
  const code = wasi.start({ exports: { memory, _start() {
    r.args = api.args_sizes_get(0, 4);
    r.argCount = view().getUint32(0, true);
    r.argBytes = view().getUint32(4, true);
    r.env = api.environ_sizes_get(8, 12);
    r.envCount = view().getUint32(8, true);
    r.clock = api.clock_time_get(0, 1n, 16);
    r.clockPositive = view().getBigUint64(16, true) > 0n;
    r.random = api.random_get(32, 8);
    r.exit = api.proc_exit(7);
  } } });
  r.startReturned = code;
  return JSON.stringify(r);
};

module.exports.quickjs = function () {
  const { memory } = memoryHarness();
  const bytes = fs.readFileSync('/project/wasi-check/quickjs.wasm');
  const wasi = new WASI({ version: 'preview1', args: ['quickjs'] });
  // The module's `env` imports are the engine's own host hooks (promises, modules, timezone).
  // The version check never calls them, so they are stubs here.
  const env = { host_get_timezone_offset: () => 0, host_interrupt: () => 0, host_promise_rejection: () => 0, host_module_normalize: () => 0, host_module_load: () => 0, host_call: () => 0 };
  const instance = new WebAssembly.Instance(new WebAssembly.Module(bytes), { ...wasi.getImportObject(), env });
  wasi.initialize(instance);
  const pointer = instance.exports.JS_GetVersion();
  const view = new Uint8Array(instance.exports.memory.buffer);
  let end = pointer;
  while (view[end] !== 0) end++;
  return JSON.stringify({ version: Buffer.from(view.subarray(pointer, end)).toString() });
};

module.exports.positionalAndSize = function () {
  const { memory, bytes, view, put } = memoryHarness();
  fs.rmSync('/project/wasi-sandbox', { recursive: true, force: true });
  fs.mkdirSync('/project/wasi-sandbox', { recursive: true });
  const wasi = new WASI({ version: 'preview1', preopens: { '/data': '/project/wasi-sandbox' } });
  const api = wasi.getImportObject().wasi_snapshot_preview1;
  const r = {};
  wasi.start({ exports: { memory, _start() {
    const name = put(0, 'pos.bin');
    r.open = api.path_open(3, 0, 0, name, 1 | 8, 0n, 0n, 0, 512);
    const fd = view().getUint32(512, true);
    const text = put(700, 'ABCDEFGH');
    view().setUint32(600, 700, true); view().setUint32(604, text, true);
    r.pwrite = api.fd_pwrite(fd, 600, 1, 4n, 608);
    r.pwritten = view().getUint32(608, true);
    r.pread = api.fd_pread(fd, 600, 1, 2n, 608) === 0;
    view().setUint32(600, 1000, true); view().setUint32(604, 4, true);
    r.preadRc = api.fd_pread(fd, 600, 1, 2n, 608);
    r.preadBytes = view().getUint32(608, true);
    r.preadText = Buffer.from(bytes().subarray(1000, 1000 + r.preadBytes)).toString();
    r.tellAfterPositional = (api.fd_tell(fd, 616), Number(view().getBigUint64(616, true)));
    r.allocate = api.fd_allocate(fd, 0n, 16n);
    r.sizeAfterAllocate = (api.path_filestat_get(3, 0, 0, name, 800), Number(view().getBigUint64(832, true)));
    r.setSize = api.fd_filestat_set_size(fd, 3n);
    r.sizeAfterTruncate = (api.path_filestat_get(3, 0, 0, name, 800), Number(view().getBigUint64(832, true)));
    r.advise = api.fd_advise(fd, 0n, 3n, 0);
    r.renumber = api.fd_renumber(fd, 9);
    r.oldFdGone = api.fd_close(fd);
    r.newFdWorks = api.fd_close(9);
    r.notSock = api.sock_accept(0, 0);
    return 0;
  } } });
  return JSON.stringify(r);
};
