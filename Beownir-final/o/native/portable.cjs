'use strict';
// General Node/WASIX ABI corrections; real framework CLIs remain unmodified.
const util = require('node:util');
const decode = util.TextDecoder.prototype.decode;
util.TextDecoder.prototype.decode = function(input, options) {
  if (util.types.isDataView(input)) input = new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  return Reflect.apply(decode, this, [input, options]);
};
// Go's JS/WASM syscall bridge assumes O_RDONLY=0. WASIX uses an explicit bit.
require('./portable-async.cjs');
require('./portable-diagnostics.cjs');
const fs = require('node:fs');
const access = fs.constants.O_RDONLY | fs.constants.O_WRONLY | fs.constants.O_RDWR;
// @tybys/wasm-util's WASI adapter deliberately uses ordinary POSIX numeric
// flags (0/1/2, 64 for O_CREAT, 512 for O_TRUNC). The underlying WASIX Node
// filesystem instead has explicit high-bit access flags. Convert only a value
// that has no WASIX access bits; JS callers that already receive native flags
// are left untouched.
function normalize(flags) {
  if (typeof flags !== 'number') return flags;
  if (flags & access) return flags;
  const legacyAccess = flags & 3;
  let value = legacyAccess === 1 ? fs.constants.O_WRONLY : legacyAccess === 2 ? fs.constants.O_RDWR : fs.constants.O_RDONLY;
  const map = [
    [64, fs.constants.O_CREAT], [128, fs.constants.O_EXCL], [512, fs.constants.O_TRUNC],
    [1024, fs.constants.O_APPEND], [65536, fs.constants.O_DIRECTORY], [131072, fs.constants.O_NOFOLLOW],
    [2048, fs.constants.O_NONBLOCK], [4096, fs.constants.O_DSYNC], [1052672, fs.constants.O_SYNC]
  ];
  for (const [legacy, native] of map) if ((flags & legacy) === legacy && native !== undefined) value |= native;
  return value;
}
for (const name of ['open', 'openSync']) {
  const original = fs[name];
  fs[name] = function(path, flags, ...rest) { return Reflect.apply(original, this, [path, normalize(flags), ...rest]); };
}
require('./portable-fs.cjs');
require('./portable-modules.cjs');
require('./portable-subprocess.cjs');
const {WASI: JSWASI} = require('./portable-wasi.cjs');
class PortableWASI extends JSWASI { constructor(options={}){super({...options,fs});} }
require('node:wasi').WASI = PortableWASI;
require('./portable-watch.cjs');
require('./portable-watch-file.cjs');
require('./portable-net.cjs');
require('./portable-process-tree.cjs');
require('node:module').syncBuiltinESMExports();
