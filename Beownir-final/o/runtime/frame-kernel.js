/* Beownir virtual OS kernel (browser runtime). Runs in an opaque-origin iframe.
 * Owns real browser Worker execution contexts (processes and worker_threads),
 * canonical VFS, SharedArrayBuffer control tables, IPC and virtual HTTP routes.
 * It is not a native OS kernel and deliberately does not expose privileged host APIs.
 */
(() => {
  'use strict';
  let initialized = false;
  window.addEventListener('message', event => {
    if (initialized || event.source !== parent || event.data?.type !== 'beownir-runtime' || !event.ports[0] || typeof event.data.source !== 'string') return;
    initialized = true;
    const host = event.ports[0], processes = new Map(), threads = new Map(), actors = new Map(), files = Object.create(null), versions = Object.create(null), envData = new Map(), listeners = new Map(), httpRoutes = new Map(), hostFetchPending = new Map(), syncSessions = new Set();
    let sourceURL, npmWorkerURL, assets, nextPID = 2, nextThreadFallback = 1, sequence = 0, epoch = 0, stopped = false, inputPID = 1;
    let networkConfig = (event.data.network && typeof event.data.network === 'object') ? event.data.network
      : (event.data.limits && typeof event.data.limits.network === 'object' ? event.data.limits.network : null);
    const profilerState = {
      enabled: Boolean(event.data.profiler && event.data.profiler.enabled),
      maxSpans: Number(event.data.profiler && event.data.profiler.maxSpans) > 0 ? Math.min(20000, Math.floor(Number(event.data.profiler.maxSpans))) : 10000,
      startedAt: Date.now(),
      spans: [],
    };
    const recordKernelSpan = (name, category, startMs, metadata) => {
      if (!profilerState.enabled || profilerState.spans.length >= profilerState.maxSpans) return;
      const span = {
        name,
        category,
        startTime: Date.now(),
        durationMs: Number(Math.max(0, performance.now() - startMs).toFixed(3)),
        thread: 'frame-kernel',
        pid: 0,
        threadId: 0,
      };
      if (metadata) span.metadata = metadata;
      profilerState.spans.push(span);
    };
    const appendWorkerSpans = list => {
      if (!Array.isArray(list) || !profilerState.enabled) return;
      for (const s of list) {
        if (profilerState.spans.length >= profilerState.maxSpans) break;
        if (s && typeof s === 'object') profilerState.spans.push(s);
      }
    };
    const pendingCollect = new Map();
    const MAX_PROCESSES = 8, MAX_THREADS = 32, utf8 = new TextEncoder();
    // Shared cross-worker control slab when cross-origin isolation provides SharedArrayBuffer:
    // [0]=nextThreadId, [1]=fsEpoch, [2]=activeWorkers, [3]=envVersion
    const ctrlSab = typeof SharedArrayBuffer === 'function' ? new SharedArrayBuffer(4096) : null;
    const ctrlI32 = ctrlSab ? new Int32Array(ctrlSab) : null;
    if (ctrlI32) Atomics.store(ctrlI32, 2, 1);
    // Same budget the kernel and the editor use; the host sends it with the
    // source, and these defaults apply only if a message arrives without it.
    const limits = { bytes: 64 * 1024 * 1024, perFile: 16 * 1024 * 1024, entries: 20000, recordChars: 24 * 1024 * 1024 };
    if (event.data.limits && typeof event.data.limits === 'object') {
      const positive = value => Number.isFinite(Number(value)) && Number(value) > 0 ? Math.floor(Number(value)) : 0;
      limits.bytes = positive(event.data.limits.bytes) || limits.bytes;
      limits.perFile = Math.min(positive(event.data.limits.perFile) || limits.perFile, limits.bytes);
      limits.entries = positive(event.data.limits.entries) || limits.entries;
      limits.recordChars = Math.min(384 * 1024 * 1024, Math.ceil(limits.perFile * 4 / 3) + 4096);
    }
    const sendHost = (message, transfer) => {
      if (stopped) return;
      if (Array.isArray(transfer) && transfer.length) host.postMessage(message, transfer);
      else host.postMessage(message);
    };
    const error = (code, message) => Object.assign(new Error(message), { code });
    const recordError = e => ({ ...(e?.name ? { name: String(e.name) } : {}), code: e?.code || 'ERR_VIRTUAL_OS', message: String(e?.message || e).slice(0, 4000) });
    const validPath = p => typeof p === 'string' && p.length <= 768 && !/[\\\x00-\x1f]/.test(p) && !p.includes('//') && !p.endsWith('/') && !p.split('/').some(s => s === '.' || s === '..') && (p === '/project' || p.startsWith('/project/') || p === '/tmp' || p.startsWith('/tmp/'));
    const sameEntry = (a, b) => a === b || (!!a && !!b && a.d === b.d && a.c === b.c);
    // UTF-8 bytes, exactly what the kernel charges, so both agree on the total.
    const fileSize = entry => entry?.d ? 0 : entry?.c ? utf8.encode(entry.c).length : 0;
    let usedBytes = 0;
    function syncActiveCount() {
      if (ctrlI32) Atomics.store(ctrlI32, 2, processes.size + threads.size);
    }
    function table() { return [...processes.values()].map(p => ({ pid: p.pid, ppid: p.ppid, state: p.state, command: [p.command, ...p.args].join(' ').slice(0, 180), cwd: p.cwd, startedAt: p.startedAt, ports: [...listeners].filter(([, ownerKey]) => ownerKey === p.actorKey).map(([port]) => port) })); }
    function publishTable() {
      const data = table(); sendHost({ type: 'kernel-processes', processes: data, maxProcesses: MAX_PROCESSES, fsEpoch: epoch });
      for (const p of processes.values()) p.worker.postMessage({ type: 'kernel-table', processes: data });
    }
    function reply(actor, id, result, failure, transfer) {
      if (!actors.has(actor.actorKey)) return;
      const payload = { type: 'kernel-reply', id, result, error: failure ? recordError(failure) : undefined };
      if (Array.isArray(transfer) && transfer.length) actor.worker.postMessage(payload, transfer);
      else actor.worker.postMessage(payload);
    }
    const npmWorkerScriptSource = () => `
'use strict';
let pakoMod = null;
function loadPako(source) {
  if (pakoMod) return pakoMod;
  const mod = { exports: {} };
  const fn = new Function('exports', 'module', source + '; return module.exports;');
  const out = fn(mod.exports, mod);
  pakoMod = (out && out.Inflate) ? out : (self.pako || mod.exports);
  return pakoMod;
}
const TD = new TextDecoder();
const TE = new TextEncoder();
const TEXT_RE = /\\.(?:[cm]?js|json|jsx|tsx?|md|txt|map|css|html?|ya?ml|flow|svg|scss|less)$/i;
const DOC_RE = /(?:^|\\/)(?:LICENSE|README|CHANGELOG)(?:\\.[^/]*)?$/i;
function checkArchivePath(name) {
  if (typeof name !== 'string' || name.length > 768 || name.startsWith('/') || /[\\\\\\x00-\\x1f:]/.test(name)) {
    throw new Error('Unsafe archive path: ' + name);
  }
  const parts = name.split('/');
  for (let i = 0; i < parts.length; i++) {
    if (parts[i] === '..' || parts[i] === '.') throw new Error('Unsafe archive path: ' + name);
  }
  return name;
}
function isSafeRel(rel) {
  if (!rel || typeof rel !== 'string' || rel.length > 768 || rel.startsWith('/') || /[\\\\\\x00-\\x1f:]/.test(rel)) return false;
  const parts = rel.split('/');
  for (let i = 0; i < parts.length; i++) {
    if (!parts[i] || parts[i] === '.' || parts[i] === '..') return false;
  }
  return true;
}
const K512 = new Uint32Array([
  0x428a2f98,0xd728ae22,0x71374491,0x23ef65cd,0xb5c0fbcf,0xec4d3b2f,0xe9b5dba5,0x8189dbbc,
  0x3956c25b,0xf348b538,0x59f111f1,0xb605d019,0x923f82a4,0xaf194f9b,0xab1c5ed5,0xda6d8118,
  0xd807aa98,0xa3030242,0x12835b01,0x45706fbe,0x243185be,0x4ee4b28c,0x550c7dc3,0xd5ffb4e2,
  0x72be5d74,0xf27b896f,0x80deb1fe,0x3b1696b1,0x9bdc06a7,0x25c71235,0xc19bf174,0xcf692694,
  0xe49b69c1,0x9ef14ad2,0xefbe4786,0x384f25e3,0x0fc19dc6,0x8b8cd5b5,0x240ca1cc,0x77ac9c65,
  0x2de92c6f,0x592b0275,0x4a7484aa,0x6ea6e483,0x5cb0a9dc,0xbd41fbd4,0x76f988da,0x831153b5,
  0x983e5152,0xee66dfab,0xa831c66d,0x2db43210,0xb00327c8,0x98fb213f,0xbf597fc7,0xbeef0ee4,
  0xc6e00bf3,0x3da88fc2,0xd5a79147,0x930aa725,0x06ca6351,0xe003826f,0x14292967,0x0a0e6e70,
  0x27b70a85,0x46d22ffc,0x2e1b2138,0x5c26c926,0x4d2c6dfc,0x5ac42aed,0x53380d13,0x9d95b3df,
  0x650a7354,0x8baf63de,0x766a0abb,0x3c77b2a8,0x81c2c92e,0x47edaee6,0x92722c85,0x1482353b,
  0xa2bfe8a1,0x4cf10364,0xa81a664b,0xbc423001,0xc24b8b70,0xd0f89791,0xc76c51a3,0x0654be30,
  0xd192e819,0xd6ef5218,0xd6990624,0x5565a910,0xf40e3585,0x5771202a,0x106aa070,0x32bbd1b8,
  0x19a4c116,0xb8d2d0c8,0x1e376c08,0x5141ab53,0x2748774c,0xdf8eeb99,0x34b0bcb5,0xe19b48a8,
  0x391c0cb3,0xc5c95a63,0x4ed8aa4a,0xe3418acb,0x5b9cca4f,0x7763e373,0x682e6ff3,0xd6b2b8a3,
  0x748f82ee,0x5defb2fc,0x78a5636f,0x43172f60,0x84c87814,0xa1f0ab72,0x8cc70208,0x1a6439ec,
  0x90befffa,0x23631e28,0xa4506ceb,0xde82bde9,0xbef9a3f7,0xb2c67915,0xc67178f2,0xe372532b,
  0xca273ece,0xea26619c,0xd186b8c7,0x21c0c207,0xeada7dd6,0xcde0eb1e,0xf57d4f7f,0xee6ed178,
  0x06f067aa,0x72176fba,0x0a637dc5,0xa2c898a6,0x113f9804,0xbef90dae,0x1b710b35,0x131c471b,
  0x28db77f5,0x23047d84,0x32caab7b,0x40c72493,0x3c9ebe0a,0x15c9bebc,0x431d67c4,0x9c100d4c,
  0x4cc5d4be,0xcb3e42b6,0x597f299c,0xfc657e2a,0x5fcb6fab,0x3ad6faec,0x6c44198c,0x4a475817
]);
function sha512Bytes(bytes) {
  let h0 = 0x6a09e667, h0l = 0xf3bcc908, h1 = 0xbb67ae85, h1l = 0x84caa73b;
  let h2 = 0x3c6ef372, h2l = 0xfe94f82b, h3 = 0xa54ff53a, h3l = 0x5f1d36f1;
  let h4 = 0x510e527f, h4l = 0xade682d1, h5 = 0x9b05688c, h5l = 0x2b3e6c1f;
  let h6 = 0x1f83d9ab, h6l = 0xfb41bd6b, h7 = 0x5be0cd19, h7l = 0x137e2179;
  const W = new Uint32Array(160);
  function compress(data, offset) {
    for (let i = 0; i < 16; i++) {
      const at = offset + i * 8;
      W[i * 2] = (data[at] << 24) | (data[at + 1] << 16) | (data[at + 2] << 8) | data[at + 3];
      W[i * 2 + 1] = (data[at + 4] << 24) | (data[at + 5] << 16) | (data[at + 6] << 8) | data[at + 7];
    }
    for (let i = 16; i < 80; i++) {
      const a = (i - 15) * 2, b = (i - 2) * 2;
      const xh = W[a], xl = W[a + 1], yh = W[b], yl = W[b + 1];
      const s0h = ((xh >>> 1) | (xl << 31)) ^ ((xh >>> 8) | (xl << 24)) ^ (xh >>> 7);
      const s0l = ((xl >>> 1) | (xh << 31)) ^ ((xl >>> 8) | (xh << 24)) ^ ((xl >>> 7) | (xh << 25));
      const s1h = ((yh >>> 19) | (yl << 13)) ^ ((yl >>> 29) | (yh << 3)) ^ (yh >>> 6);
      const s1l = ((yl >>> 19) | (yh << 13)) ^ ((yh >>> 29) | (yl << 3)) ^ ((yl >>> 6) | (yh << 26));
      const lo = (W[(i - 16) * 2 + 1] >>> 0) + (s0l >>> 0) + (W[(i - 7) * 2 + 1] >>> 0) + (s1l >>> 0);
      const hi = (W[(i - 16) * 2] >>> 0) + (s0h >>> 0) + (W[(i - 7) * 2] >>> 0) + (s1h >>> 0) + Math.floor(lo / 0x100000000);
      W[i * 2] = hi >>> 0; W[i * 2 + 1] = lo >>> 0;
    }
    let ah = h0, al = h0l, bh = h1, bl = h1l, ch = h2, cl = h2l, dh = h3, dl = h3l;
    let eh = h4, el = h4l, fh = h5, fl = h5l, gh = h6, gl = h6l, hh = h7, hl = h7l;
    for (let i = 0; i < 80; i++) {
      const s1h = ((eh >>> 14) | (el << 18)) ^ ((eh >>> 18) | (el << 14)) ^ ((el >>> 9) | (eh << 23));
      const s1l = ((el >>> 14) | (eh << 18)) ^ ((el >>> 18) | (eh << 14)) ^ ((eh >>> 9) | (el << 23));
      const chh = (eh & fh) ^ (~eh & gh), chl = (el & fl) ^ (~el & gl);
      const t1lo = (hl >>> 0) + (s1l >>> 0) + (chl >>> 0) + (K512[i * 2 + 1] >>> 0) + (W[i * 2 + 1] >>> 0);
      const t1hi = (hh >>> 0) + (s1h >>> 0) + (chh >>> 0) + (K512[i * 2] >>> 0) + (W[i * 2] >>> 0) + Math.floor(t1lo / 0x100000000);
      const t1h = t1hi >>> 0, t1l = t1lo >>> 0;
      const s0h = ((ah >>> 28) | (al << 4)) ^ ((al >>> 2) | (ah << 30)) ^ ((al >>> 7) | (ah << 25));
      const s0l = ((al >>> 28) | (ah << 4)) ^ ((ah >>> 2) | (al << 30)) ^ ((ah >>> 7) | (al << 25));
      const majh = (ah & bh) ^ (ah & ch) ^ (bh & ch), majl = (al & bl) ^ (al & cl) ^ (bl & cl);
      const t2lo = (s0l >>> 0) + (majl >>> 0);
      const t2hi = (s0h >>> 0) + (majh >>> 0) + Math.floor(t2lo / 0x100000000);
      const t2h = t2hi >>> 0, t2l = t2lo >>> 0;
      hh = gh; hl = gl; gh = fh; gl = fl; fh = eh; fl = el;
      const elo = (dl >>> 0) + (t1l >>> 0);
      eh = (dh + t1h + Math.floor(elo / 0x100000000)) >>> 0; el = elo >>> 0;
      dh = ch; dl = cl; ch = bh; cl = bl; bh = ah; bl = al;
      const alo = (t1l >>> 0) + (t2l >>> 0);
      ah = (t1h + t2h + Math.floor(alo / 0x100000000)) >>> 0; al = alo >>> 0;
    }
    const v0 = (h0l >>> 0) + (al >>> 0); h0 = (h0 + ah + Math.floor(v0 / 0x100000000)) >>> 0; h0l = v0 >>> 0;
    const v1 = (h1l >>> 0) + (bl >>> 0); h1 = (h1 + bh + Math.floor(v1 / 0x100000000)) >>> 0; h1l = v1 >>> 0;
    const v2 = (h2l >>> 0) + (cl >>> 0); h2 = (h2 + ch + Math.floor(v2 / 0x100000000)) >>> 0; h2l = v2 >>> 0;
    const v3 = (h3l >>> 0) + (dl >>> 0); h3 = (h3 + dh + Math.floor(v3 / 0x100000000)) >>> 0; h3l = v3 >>> 0;
    const v4 = (h4l >>> 0) + (el >>> 0); h4 = (h4 + eh + Math.floor(v4 / 0x100000000)) >>> 0; h4l = v4 >>> 0;
    const v5 = (h5l >>> 0) + (fl >>> 0); h5 = (h5 + fh + Math.floor(v5 / 0x100000000)) >>> 0; h5l = v5 >>> 0;
    const v6 = (h6l >>> 0) + (gl >>> 0); h6 = (h6 + gh + Math.floor(v6 / 0x100000000)) >>> 0; h6l = v6 >>> 0;
    const v7 = (h7l >>> 0) + (hl >>> 0); h7 = (h7 + hh + Math.floor(v7 / 0x100000000)) >>> 0; h7l = v7 >>> 0;
  }
  let pos = 0;
  for (; pos + 128 <= bytes.length; pos += 128) compress(bytes, pos);
  const rem = bytes.length - pos;
  const tail = new Uint8Array(rem < 112 ? 128 : 256);
  tail.set(bytes.subarray(pos), 0);
  tail[rem] = 0x80;
  let bits = bytes.length * 8;
  for (let i = tail.length - 1; i >= tail.length - 8 && bits > 0; i--) {
    tail[i] = bits % 256;
    bits = Math.floor(bits / 256);
  }
  for (let off = 0; off < tail.length; off += 128) compress(tail, off);
  const out = new Uint8Array(64);
  const words = [[h0,h0l],[h1,h1l],[h2,h2l],[h3,h3l],[h4,h4l],[h5,h5l],[h6,h6l],[h7,h7l]];
  for (let i = 0; i < 8; i++) {
    const hi = words[i][0], lo = words[i][1];
    out[i*8]=hi>>>24; out[i*8+1]=(hi>>>16)&255; out[i*8+2]=(hi>>>8)&255; out[i*8+3]=hi&255;
    out[i*8+4]=lo>>>24; out[i*8+5]=(lo>>>16)&255; out[i*8+6]=(lo>>>8)&255; out[i*8+7]=lo&255;
  }
  return out;
}
async function verifySri(bytes, sri) {
  if (!sri) throw new Error('Package has no integrity hash. Refusing an unverified download.');
  const algos = { sha512: 'SHA-512', sha384: 'SHA-384', sha256: 'SHA-256', sha1: 'SHA-1' };
  const tokens = String(sri).trim().split(/\\s+/);
  const candidates = [];
  for (let i = 0; i < tokens.length; i++) {
    const clean = tokens[i].split('?')[0];
    const sep = clean.indexOf('-');
    if (sep > 0) {
      const algo = clean.slice(0, sep);
      if (algos[algo]) candidates.push([algo, clean.slice(sep + 1)]);
    }
  }
  const order = ['sha512', 'sha384', 'sha256', 'sha1'];
  let strongest = null;
  for (let i = 0; i < order.length; i++) {
    for (let j = 0; j < candidates.length; j++) {
      if (candidates[j][0] === order[i]) { strongest = order[i]; break; }
    }
    if (strongest) break;
  }
  if (!strongest) throw new Error('Unsupported package integrity algorithm.');
  let digestBytes;
  if (typeof crypto !== 'undefined' && crypto && crypto.subtle) {
    digestBytes = new Uint8Array(await crypto.subtle.digest(algos[strongest], bytes));
  } else if (strongest === 'sha512') {
    digestBytes = sha512Bytes(bytes);
  } else {
    throw new Error('WebCrypto digest unavailable in worker.');
  }
  let bin = '';
  for (let i = 0; i < digestBytes.length; i++) bin += String.fromCharCode(digestBytes[i]);
  const b64 = btoa(bin);
  for (let i = 0; i < candidates.length; i++) {
    if (candidates[i][0] === strongest && candidates[i][1] === b64) return true;
  }
  return false;
}
function inflateTar(pako, compressed, limit) {
  const inflate = new pako.Inflate({ chunkSize: 65536 });
  const chunks = [];
  let total = 0;
  inflate.onData = chunk => {
    total += chunk.length;
    if (total > limit) throw new Error('Expanded archive exceeds limit.');
    chunks.push(new Uint8Array(chunk));
  };
  inflate.push(compressed, true);
  if (inflate.err) throw new Error('Invalid gzip archive: ' + (inflate.msg || inflate.err));
  const out = new Uint8Array(total);
  let pos = 0;
  for (let i = 0; i < chunks.length; i++) {
    out.set(chunks[i], pos);
    pos += chunks[i].length;
  }
  return out;
}
function parseTarPack(tarBytes, maxEntries, maxEntryBytes) {
  const entries = [];
  let offset = 0, pendingName = null, pax = Object.create(null);
  const readStr = (s, n) => TD.decode(tarBytes.subarray(s, s + n)).replace(/\\0[\\s\\S]*$/, '');
  while (offset + 512 <= tarBytes.length) {
    let allZero = true;
    for (let z = 0; z < 512; z++) { if (tarBytes[offset + z] !== 0) { allZero = false; break; } }
    if (allZero) break;
    const expected = parseInt(readStr(offset + 148, 8).trim(), 8);
    let checksum = 0;
    for (let i = 0; i < 512; i++) checksum += (i >= 148 && i < 156) ? 32 : tarBytes[offset + i];
    if (checksum !== expected) throw new Error('Invalid tar checksum.');
    const size = parseInt(readStr(offset + 124, 12).trim(), 8) || 0;
    const type = String.fromCharCode(tarBytes[offset + 156]);
    if (!Number.isSafeInteger(size) || size < 0 || offset + 512 + size > tarBytes.length) throw new Error('Invalid tar entry size.');
    let name = readStr(offset, 100);
    const prefix = readStr(offset + 345, 155);
    if (prefix) name = prefix + '/' + name;
    const data = tarBytes.subarray(offset + 512, offset + 512 + size);
    if (type === 'x' || type === 'g') {
      let i = 0;
      while (i < data.length) {
        const space = data.indexOf(32, i);
        if (space < 0) break;
        const length = Number(TD.decode(data.subarray(i, space)));
        if (!Number.isSafeInteger(length) || length <= 0 || i + length > data.length) throw new Error('Invalid PAX header.');
        const record = TD.decode(data.subarray(space + 1, i + length - 1));
        const eq = record.indexOf('=');
        if (eq > 0) pax[record.slice(0, eq)] = record.slice(eq + 1);
        i += length;
      }
    } else if (type === 'L') {
      pendingName = TD.decode(data).replace(/\\0[\\s\\S]*$/, '');
    } else if (type === 'K') {
      // ignore GNU long link target header without clobbering pendingName
    } else {
      const fullName = checkArchivePath(pax.path || pendingName || name);
      pendingName = null;
      pax = Object.create(null);
      if (type === '0' || type === '\\0') {
        if (size > maxEntryBytes) throw new Error('Package file exceeds per-file budget.');
        const rel = fullName.split('/').slice(1).join('/');
        if (rel) {
          if (!isSafeRel(rel)) throw new Error('Unsafe archive path: ' + rel);
          const relBytes = TE.encode(rel);
          const isText = (TEXT_RE.test(rel) || DOC_RE.test(rel)) ? 1 : 0;
          entries.push({ relBytes, isText, data });
          if (entries.length > maxEntries) throw new Error('Too many files in package.');
        }
      }
    }
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  let totalSize = 8;
  for (let i = 0; i < entries.length; i++) totalSize += 9 + entries[i].relBytes.length + entries[i].data.length;
  const out = new Uint8Array(totalSize);
  const view = new DataView(out.buffer);
  out[0] = 0x42; out[1] = 0x4E; out[2] = 0x50; out[3] = 0x4B;
  view.setUint32(4, entries.length, true);
  let pos = 8;
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    view.setUint32(pos, e.relBytes.length, true);
    out[pos + 4] = e.isText;
    view.setUint32(pos + 5, e.data.length, true);
    pos += 9;
    out.set(e.relBytes, pos);
    pos += e.relBytes.length;
    out.set(e.data, pos);
    pos += e.data.length;
  }
  return { packBuffer: out.buffer, filesCount: entries.length };
}
async function downloadWithRetry(url, maxTarballBytes, attempts, timeoutMs) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const r = await fetch(url, { credentials: 'omit', redirect: 'error', signal: controller.signal });
      if (!r.ok) {
        const err = new Error('Registry returned HTTP ' + r.status + ' for ' + url);
        if (attempt < attempts && (r.status === 408 || r.status === 429 || r.status >= 500)) {
          lastError = err;
          await new Promise(res => setTimeout(res, Math.min(2000, 150 * attempt)));
          continue;
        }
        throw err;
      }
      const lenHdr = Number(r.headers.get('content-length'));
      if (lenHdr > maxTarballBytes) throw new Error('Tarball exceeds size budget.');
      const buf = await r.arrayBuffer();
      if (buf.byteLength > maxTarballBytes) throw new Error('Tarball exceeds size budget.');
      return new Uint8Array(buf);
    } catch (e) {
      lastError = e;
      if (attempt >= attempts || /exceeds size|HTTP 4\\d\\d/.test(String(e && e.message || ''))) throw e;
      await new Promise(res => setTimeout(res, Math.min(2000, 150 * attempt)));
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError;
}
self.onmessage = async ev => {
  const msg = ev.data;
  if (!msg || msg.type !== 'run') return;
  const pako = loadPako(msg.pakoSource);
  const jobs = msg.jobs || [];
  const ctrl = msg.sab ? new Int32Array(msg.sab) : null;
  let fallbackIdx = Number(msg.workerId) || 0;
  const step = Number(msg.workerCount) || 1;
  while (true) {
    if (ctrl && Atomics.load(ctrl, 1) !== 0) break;
    const index = ctrl ? Atomics.add(ctrl, 0, 1) : fallbackIdx;
    if (!ctrl) fallbackIdx += step;
    if (index >= jobs.length) break;
    const job = jobs[index];
    try {
      const rawBytes = await downloadWithRetry(job.tarball, job.maxTarballBytes, job.attempts || 3, job.idleTimeoutMs || 45000);
      const valid = await verifySri(rawBytes, job.integrity);
      if (!valid) throw new Error('Integrity verification failed: ' + job.tarball);
      const tarBytes = inflateTar(pako, rawBytes, job.maxExpandedBytes);
      const packed = parseTarPack(tarBytes, job.maxEntries || 20000, job.maxEntryBytes || 64 * 1024 * 1024);
      self.postMessage({
        type: 'job-done',
        idx: job.idx,
        ok: true,
        packBuffer: packed.packBuffer,
        bytes: rawBytes.byteLength,
        expandedBytes: tarBytes.byteLength,
        filesCount: packed.filesCount
      }, [packed.packBuffer]);
    } catch (err) {
      if (ctrl) Atomics.store(ctrl, 1, 1);
      self.postMessage({ type: 'job-done', idx: job.idx, ok: false, error: String((err && err.message) || err) });
      break;
    }
  }
  self.postMessage({ type: 'worker-done' });
};
`;
    function getNpmWorkerURL() {
      if (!npmWorkerURL) npmWorkerURL = URL.createObjectURL(new Blob([npmWorkerScriptSource()], { type: 'text/javascript' }));
      return npmWorkerURL;
    }
    async function npmExtractBatch(data) {
      if (!assets || typeof assets.pako !== 'string' || !assets.pako) throw error('ENOSYS', 'Pako runtime asset is unavailable.');
      if (!data || !Array.isArray(data.jobs) || !data.jobs.length || data.jobs.length > 2048) throw error('EINVAL', 'Invalid npm batch job list.');
      let originUrl;
      try { originUrl = new URL(String(data.origin || '')); } catch { throw error('EINVAL', 'Invalid npm registry origin.'); }
      if (originUrl.protocol !== 'https:' || originUrl.username || originUrl.password) throw error('EINVAL', 'Only HTTPS registry origins are permitted.');
      const cleanJobs = data.jobs.map(job => {
        let u;
        try { u = new URL(String(job?.tarball || '')); } catch { throw error('EINVAL', 'Invalid package tarball URL.'); }
        if (u.origin !== originUrl.origin || u.username || u.password) throw error('EINVAL', 'Tarball URL origin mismatch: ' + String(job?.tarball || ''));
        return {
          idx: Number(job.idx),
          tarball: u.href,
          integrity: String(job.integrity || ''),
          maxTarballBytes: Math.min(64 * 1024 * 1024, Number(job.maxTarballBytes) || 64 * 1024 * 1024),
          maxExpandedBytes: Math.min(256 * 1024 * 1024, Number(job.maxExpandedBytes) || 256 * 1024 * 1024),
          maxEntryBytes: Math.min(64 * 1024 * 1024, Number(job.maxEntryBytes) || 64 * 1024 * 1024),
          maxEntries: Math.min(25000, Number(job.maxEntries) || 20000),
          attempts: Math.max(1, Math.min(5, Number(job.attempts) || 3)),
          idleTimeoutMs: Math.max(5000, Math.min(120000, Number(job.idleTimeoutMs) || 45000)),
        };
      });
      const hw = (typeof navigator !== 'undefined' && Number(navigator.hardwareConcurrency)) || 4;
      const workerCount = Math.min(cleanJobs.length, Math.max(2, Math.min(6, hw)));
      const sab = typeof SharedArrayBuffer === 'function' ? new SharedArrayBuffer(16) : null;
      const url = getNpmWorkerURL();
      const pool = [];
      const results = [];
      const transfers = [];
      return new Promise((resolve, reject) => {
        let settled = false;
        let finishedWorkers = 0;
        const cleanup = () => {
          for (let i = 0; i < pool.length; i++) {
            try { pool[i].terminate(); } catch {}
          }
          pool.length = 0;
        };
        const fail = err => {
          if (settled) return;
          settled = true;
          cleanup();
          reject(err);
        };
        const maybeResolve = () => {
          if (settled || finishedWorkers < workerCount) return;
          if (results.length !== cleanJobs.length) {
            fail(error('ERR_NPM_BATCH', 'Incomplete package extraction batch.'));
            return;
          }
          settled = true;
          cleanup();
          resolve({ results, __transfer: transfers });
        };
        try {
          for (let w = 0; w < workerCount; w++) {
            const worker = new Worker(url);
            pool.push(worker);
            worker.onmessage = ev => {
              const msg = ev.data;
              if (!msg || settled) return;
              if (msg.type === 'job-done') {
                if (!msg.ok) { fail(new Error(msg.error || 'Package extraction failed.')); return; }
                results.push({ idx: msg.idx, packBuffer: msg.packBuffer, bytes: msg.bytes, expandedBytes: msg.expandedBytes, filesCount: msg.filesCount });
                if (msg.packBuffer instanceof ArrayBuffer) transfers.push(msg.packBuffer);
                return;
              }
              if (msg.type === 'worker-done') {
                finishedWorkers++;
                maybeResolve();
              }
            };
            worker.onerror = ev => fail(new Error(ev?.message || 'Package worker failed.'));
            worker.postMessage({ type: 'run', workerId: w, workerCount, jobs: cleanJobs, sab, pakoSource: assets.pako });
          }
        } catch (err) {
          fail(err);
        }
      });
    }
    function recordSyncOutput(process, stream, data) {
      const session = process.syncSession;
      if (!session || session.done || session.overflow) return;
      const bytes = data instanceof Uint8Array ? data : utf8.encode(String(data));
      if (session.totalBytes + bytes.length > session.maxBuffer) {
        session.overflow = true;
        session.error = error('ENOBUFS', 'spawnSync ' + process.command + ' ENOBUFS');
        finish(process, null, session.killSignal || 'SIGKILL');
        return;
      }
      session.totalBytes += bytes.length;
      if (stream === 'stdout') session.stdoutChunks.push(bytes);
      else if (stream === 'stderr') session.stderrChunks.push(bytes);
    }
    function completeSyncSession(session, code, signal, failure) {
      if (!session || session.done) return;
      session.done = true;
      clearTimeout(session.timeoutTimer);
      syncSessions.delete(session);
      const sab = session.syncSab;
      if (!sab) return;
      const i32 = new Int32Array(sab, 0, 16);
      const u8 = new Uint8Array(sab);
      const concatChunks = chunks => {
        let len = 0;
        for (const c of chunks) len += c.length;
        const out = new Uint8Array(len);
        let pos = 0;
        for (const c of chunks) { out.set(c, pos); pos += c.length; }
        return out;
      };
      let outBytes = concatChunks(session.stdoutChunks);
      let errBytes = concatChunks(session.stderrChunks);
      const errObj = session.error || failure || null;
      const sigBytes = signal ? utf8.encode(String(signal)) : new Uint8Array(0);
      const codeBytes = errObj?.code ? utf8.encode(String(errObj.code)) : new Uint8Array(0);
      const msgBytes = errObj?.message ? utf8.encode(String(errObj.message)) : (errObj ? utf8.encode(String(errObj)) : new Uint8Array(0));
      let deltaBytes = new Uint8Array(0);
      if (Object.keys(session.deltaFiles).length) {
        try { deltaBytes = utf8.encode(JSON.stringify({ files: session.deltaFiles, versions: session.deltaVersions })); } catch { deltaBytes = new Uint8Array(0); }
      }
      const cap = Math.max(0, sab.byteLength - 64);
      const fixedMeta = sigBytes.length + codeBytes.length + msgBytes.length;
      if (fixedMeta + outBytes.length + errBytes.length + deltaBytes.length > cap) {
        if (fixedMeta + outBytes.length + errBytes.length <= cap) deltaBytes = new Uint8Array(0);
        else {
          deltaBytes = new Uint8Array(0);
          const room = Math.max(0, cap - fixedMeta);
          if (outBytes.length > room) { outBytes = outBytes.subarray(0, room); errBytes = new Uint8Array(0); }
          else if (outBytes.length + errBytes.length > room) errBytes = errBytes.subarray(0, room - outBytes.length);
        }
      }
      let off = 64;
      u8.set(outBytes, off); off += outBytes.length;
      u8.set(errBytes, off); off += errBytes.length;
      u8.set(sigBytes, off); off += sigBytes.length;
      u8.set(codeBytes, off); off += codeBytes.length;
      u8.set(msgBytes, off); off += msgBytes.length;
      u8.set(deltaBytes, off);
      i32[1] = session.pid || 0;
      i32[2] = code === null || code === undefined ? -1 : Number(code);
      i32[3] = outBytes.length;
      i32[4] = errBytes.length;
      i32[5] = sigBytes.length;
      i32[6] = codeBytes.length;
      i32[7] = msgBytes.length;
      i32[8] = deltaBytes.length;
      i32[9] = epoch;
      Atomics.store(i32, 0, 1);
      Atomics.notify(i32, 0, 1);
    }
    function childEvent(process, message) {
      if (process.syncSession) {
        if (message.event === 'stdout' || message.event === 'stderr') recordSyncOutput(process, message.event, message.data);
        return;
      }
      const owner = processes.get(process.ppid);
      if (owner) owner.worker.postMessage({ type: 'kernel-child', pid: process.pid, ...message });
    }
    function threadEvent(entry, message) {
      const owner = actors.get(entry.ownerKey);
      if (owner) owner.worker.postMessage({ type: 'thread-event', threadId: entry.threadId, ...message });
    }
    function serializeEnvData() {
      const list = [];
      for (const [k, v] of envData.entries()) list.push([k, v]);
      return list;
    }
    function fsUpdate(incoming, incomingVersions, authoritative, sourceActorKey) {
      const __profStart = profilerState.enabled ? performance.now() : 0;
      if (!incoming || typeof incoming !== 'object' || Object.keys(incoming).length > 20000) throw error('EFBIG', 'Oversized virtual filesystem update.');
      const candidate = { ...files }, delta = Object.create(null), deltaVersions = Object.create(null);
      for (const [path, value] of Object.entries(incoming)) {
        if (!validPath(path)) continue;
        if (!authoritative && (Number(incomingVersions?.[path]) || 0) !== (versions[path] || 0)) continue;
        const entry = value === null ? null : value.d === true ? { d: true } : typeof value.c === 'string' && value.c.length <= limits.recordChars ? { c: value.c } : undefined;
        if (entry === undefined) throw error('EINVAL', 'Invalid virtual file record.');
        if ((path === '/project' || path === '/tmp') && !entry?.d) throw error('EPERM', 'The workspace and temporary roots cannot be removed.');
        if (fileSize(entry) > limits.perFile) throw error('EFBIG', 'Virtual file exceeds the ' + Math.round(limits.perFile / 1048576) + ' MiB per-file limit.');
        if (sameEntry(candidate[path], entry) && !authoritative) continue;
        if (entry === null) delete candidate[path]; else candidate[path] = entry;
        delta[path] = entry; deltaVersions[path] = authoritative ? Number(incomingVersions?.[path]) || 0 : versions[path] || 0;
      }
      // Charge the delta instead of re-measuring every file on every update.
      let projected = usedBytes, projectedEntries = Object.keys(files).length;
      for (const [path, entry] of Object.entries(delta)) {
        projected += fileSize(entry) - fileSize(files[path]);
        if (!files[path] && entry) projectedEntries++;
        if (files[path] && !entry) projectedEntries--;
      }
      if (projectedEntries > limits.entries || projected > limits.bytes) throw error('ENOSPC', 'Shared virtual filesystem quota exceeded (' + Math.round(limits.bytes / 1048576) + ' MiB budget, ' + Math.round(limits.perFile / 1048576) + ' MiB per file).');
      for (const path of Object.keys(candidate)) { const parentPath = path.slice(0, path.lastIndexOf('/')); if (parentPath && parentPath !== '/' && !candidate[parentPath]?.d) throw error('ENOTDIR', 'Missing shared filesystem directory: ' + parentPath); }
      if (!Object.keys(delta).length) return;
      for (const [path, value] of Object.entries(delta)) {
        versions[path] = deltaVersions[path];
        usedBytes += fileSize(value) - fileSize(files[path]);
        if (value === null) delete files[path]; else files[path] = value;
      }
      if (usedBytes < 0) usedBytes = 0;
      epoch++;
      if (ctrlI32) { Atomics.store(ctrlI32, 1, epoch); Atomics.notify(ctrlI32, 1); }
      for (const session of syncSessions) {
        for (const [p, v] of Object.entries(delta)) {
          session.deltaFiles[p] = v;
          session.deltaVersions[p] = deltaVersions[p];
        }
      }
      for (const actor of actors.values()) if (actor.actorKey !== sourceActorKey) actor.worker.postMessage({ type: 'setfiles', files: delta, versions: deltaVersions, kernelEpoch: epoch });
      if (!authoritative) {
        const visible = Object.fromEntries(Object.entries(delta).filter(([p]) => p === '/project' || p.startsWith('/project/')));
        if (Object.keys(visible).length) sendHost({ type: 'fssync', files: visible, versions: deltaVersions });
      }
      if (profilerState.enabled) recordKernelSpan('fs.update', 'filesystem', __profStart, { count: Object.keys(delta).length, authoritative });
    }
    function emitOutput(actor, type, value) {
      if (actor.syncSession && (type === 'stdout' || type === 'stderr')) {
        recordSyncOutput(actor, type, value);
        return;
      }
      const text = String(value).slice(0, 32768), now = performance.now();
      if (now - actor.outputWindow > 1000) { actor.outputWindow = now; actor.outputMessages = 0; }
      if (++actor.outputMessages > 256) return;
      if (actor.isThread) {
        const pipe = type === 'stdout' ? actor.stdoutPipe : actor.stderrPipe;
        if (pipe) { threadEvent(actor, { event: type, data: text }); return; }
        const owner = actors.get(actor.ownerKey);
        if (owner) { emitOutput(owner, type, text); return; }
        sendHost({ type, data: text });
        return;
      }
      if (actor.pid === 1) return sendHost({ type, data: text });
      const mode = actor.stdio[type === 'stdout' ? 1 : 2];
      if (mode === 'ignore') return;
      if (mode === 'inherit') { const owner = processes.get(actor.ppid); if (owner) emitOutput(owner, type, text); else sendHost({ type, data: text }); }
      else childEvent(actor, { event: type, data: text });
    }
    function finishThread(entry, code = 0, failure) {
      if (!threads.has(entry.threadId)) return;
      clearTimeout(entry.bootTimeout);
      entry.worker.terminate();
      threads.delete(entry.threadId);
      actors.delete(entry.actorKey);
      syncActiveCount();
      for (const [port, ownerKey] of listeners) if (ownerKey === entry.actorKey) { listeners.delete(port); sendHost({ type: 'close', port }); }
      for (const [id, route] of httpRoutes) if (route.target === entry.actorKey) { clearTimeout(route.timer); httpRoutes.delete(id); route.reject(error('ECONNRESET', 'The virtual HTTP thread exited.')); }
      for (const child of [...threads.values()]) if (child.ownerKey === entry.actorKey) finishThread(child, 1);
      threadEvent(entry, { event: 'exit', code: Number(code) || 0, error: failure ? recordError(failure) : undefined });
      publishTable();
    }
    function finish(process, code = 0, signal = null, failure) {
      if (!processes.has(process.pid)) return;
      clearTimeout(process.bootTimeout); clearTimeout(process.killTimeout); process.worker.terminate();
      processes.delete(process.pid);
      actors.delete(process.actorKey);
      syncActiveCount();
      for (const [port, ownerKey] of listeners) if (ownerKey === process.actorKey) { listeners.delete(port); sendHost({ type: 'close', port }); }
      for (const [id, route] of httpRoutes) if (route.target === process.actorKey) { clearTimeout(route.timer); httpRoutes.delete(id); route.reject(error('ECONNRESET', 'The virtual HTTP process exited.')); }
      for (const child of [...threads.values()]) if (child.ownerKey === process.actorKey) finishThread(child, 1);
      if (inputPID === process.pid) inputPID = 1;
      if (process.syncSession) {
        completeSyncSession(process.syncSession, signal ? null : Number(code) || 0, signal, failure);
        for (const child of processes.values()) if (child.ppid === process.pid) { child.ppid = 1; child.ipc = false; child.worker.postMessage({ type: 'kernel-reparent', ppid: 1 }); child.worker.postMessage({ type: 'kernel-disconnect' }); }
      } else if (process.pid !== 1) {
        childEvent(process, { event: 'exit', code: signal ? null : Number(code) || 0, signal, error: failure ? recordError(failure) : undefined });
        for (const child of processes.values()) if (child.ppid === process.pid) { child.ppid = 1; child.ipc = false; child.worker.postMessage({ type: 'kernel-reparent', ppid: 1 }); child.worker.postMessage({ type: 'kernel-disconnect' }); }
      } else sendHost({ type: 'fatal', message: failure?.message || 'The interactive kernel process exited. Press Run to restart.' });
      publishTable();
    }
    function kill(pid, signal = 'SIGTERM', tree = false) {
      pid = Number(pid); const process = processes.get(pid);
      if (pid === 1) throw error('EPERM', 'PID 1 is the IDE shell. Use Stop to reset the entire virtual OS.');
      if (!process) throw error('ESRCH', 'No virtual process with PID ' + pid);
      if (!['SIGTERM', 'SIGINT', 'SIGKILL', 0, '0'].includes(signal)) throw error('EINVAL', 'Unsupported virtual signal: ' + signal);
      if (signal === 0 || signal === '0') return true;
      if (tree) for (const child of [...processes.values()]) if (child.ppid === pid) kill(child.pid, signal, true);
      if (signal === 'SIGKILL') finish(process, 137, signal);
      else {
        process.state = 'stopping'; process.worker.postMessage({ type: 'kernel-signal', signal });
        clearTimeout(process.killTimeout);
        process.killTimeout = setTimeout(() => finish(process, signal === 'SIGINT' ? 130 : 143, signal), 150);
        publishTable();
      }
      return true;
    }
    // WebSocket sessions are owned by the worker that accepted the open, so later frames follow it.
    const wsOwners = new Map();
    function wsRoute(message) {
      if (message.op === 'open') {
        const ownerKey = listeners.get(Number(message.port)) || 'p:1';
        const target = actors.get(ownerKey);
        if (!target || typeof message.url !== 'string' || !message.url.startsWith('/') || message.url.startsWith('//')) {
          sendHost({ type: 'wsevent', id: message.id, event: 'error', message: 'connect ECONNREFUSED 127.0.0.1:' + message.port });
          sendHost({ type: 'wsevent', id: message.id, event: 'close', code: 1006, reason: '' });
          return;
        }
        wsOwners.set(message.id, target.actorKey);
        target.worker.postMessage({ ...message, type: 'ws' });
        return;
      }
      const owner = actors.get(wsOwners.get(message.id));
      if (message.op === 'close') wsOwners.delete(message.id);
      if (owner) owner.worker.postMessage({ ...message, type: 'ws' });
    }
    function routeHTTP(message) {
      const ownerKey = listeners.get(Number(message.port)) || 'p:1';
      const target = actors.get(ownerKey);
      if (!target) return Promise.reject(error('ECONNREFUSED', 'No virtual runtime is available.'));
      if (typeof message.url !== 'string' || !message.url.startsWith('/') || message.url.startsWith('//') || message.url.length > 4096) return Promise.reject(error('EINVAL', 'Invalid virtual HTTP path.'));
      if ((message.body?.byteLength || message.body?.length || 0) > 1024 * 1024) return Promise.reject(error('EFBIG', 'Virtual request body exceeds 1 MiB.'));
      const id = 'kernel-http-' + ++sequence;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { httpRoutes.delete(id); reject(error('ETIMEDOUT', 'Virtual HTTP request timed out.')); }, 600000);
        httpRoutes.set(id, { target: target.actorKey, resolve, reject, timer });
        target.worker.postMessage({ ...message, type: 'http', id });
      });
    }
    function startWorker(pid, ppid, spec = {}) {
      if (processes.size >= MAX_PROCESSES) throw error('EAGAIN', 'Virtual process limit reached (' + MAX_PROCESSES + ' including the IDE shell).');
      const worker = new Worker(sourceURL, { name: 'Beownir process ' + pid });
      const process = { actorKey: 'p:' + pid, isThread: false, pid, ppid, threadId: 0, worker, state: 'booting', command: spec.command || 'beownir shell', args: spec.args || [], cwd: spec.cwd || '/project', env: spec.env || {}, stdio: spec.stdio || ['inherit', 'inherit', 'inherit'], ipc: !!spec.ipc, prepared: spec.prepared || [], syncSession: spec.syncSession || null, startedAt: Date.now(), bootPerfStart: profilerState.enabled ? performance.now() : 0, outputWindow: performance.now(), outputMessages: 0, fsError: null };
      processes.set(pid, process);
      actors.set(process.actorKey, process);
      syncActiveCount();
      worker.onmessage = event => handleActorMessage(process, event.data);
      worker.onerror = event => { event.preventDefault(); finish(process, 1, null, error('ERR_WORKER', event.message || 'Virtual worker crashed.')); };
      worker.onmessageerror = () => finish(process, 1, null, error('ERR_IPC', 'Could not decode worker message.'));
      process.bootTimeout = setTimeout(() => finish(process, 1, null, error('ETIMEDOUT', 'Virtual process startup timed out.')), 600000);
      if (assets) initializeProcess(process);
      publishTable(); return process;
    }
    function initializeProcess(process) {
      if (process.initialized) return; process.initialized = true;
      const wasm = assets.wasm.slice().buffer;
      const deps = assets.deps ? assets.deps.slice().buffer : undefined;
      const transfer = deps ? [wasm, deps] : [wasm];
      const syncInput = process.syncSession?.inputBytes ? new Uint8Array(process.syncSession.inputBytes) : null;
      const profilerCfg = profilerState.enabled ? { enabled: true, maxSpans: profilerState.maxSpans, reset: true } : null;
      process.worker.postMessage({ type: 'init', files, versions, embeddedEsbuildWasm: wasm, embeddedEsbuildBrowser: assets.browser, embeddedPako: assets.pako, deps, network: networkConfig, profiler: profilerCfg, kernel: { pid: process.pid, ppid: process.ppid, isThread: false, threads: true, threadId: 0, cwd: process.cwd, env: process.env, ipc: process.ipc, stdio: process.stdio, prepared: process.prepared, hasSyncInput: !!process.syncSession, syncInput, ctrlSab, envData: serializeEnvData(), epoch, network: networkConfig, profiler: profilerCfg } }, transfer);
    }
    function spawnSyncProcess(actor, message) {
      const session = {
        pid: 0,
        syncSab: message.syncSab,
        maxBuffer: Math.min(8 * 1024 * 1024, Math.max(1024, Number(message.maxBuffer) || 1024 * 1024)),
        killSignal: message.killSignal || 'SIGTERM',
        inputBytes: message.inputBytes instanceof Uint8Array ? message.inputBytes : (message.inputBytes instanceof ArrayBuffer ? new Uint8Array(message.inputBytes) : null),
        stdoutChunks: [],
        stderrChunks: [],
        totalBytes: 0,
        overflow: false,
        error: null,
        deltaFiles: Object.create(null),
        deltaVersions: Object.create(null),
        done: false,
        timeoutTimer: null,
      };
      if (!(session.syncSab instanceof SharedArrayBuffer)) return;
      try {
        if (message.fsSync && typeof message.fsSync === 'object') fsUpdate(message.fsSync.files, message.fsSync.versions, false, actor.actorKey);
        syncSessions.add(session);
        if (!assets || typeof message.command !== 'string' || !Array.isArray(message.args) || message.args.some(a => typeof a !== 'string') || JSON.stringify(message.args).length > 16384) throw error('EINVAL', 'Invalid process arguments.');
        const command = message.command.split('/').pop();
        if (!['node', 'nodejs', 'npm', 'pnpm', 'yarn', 'bun', 'bunx', 'npx', 'esbuild', 'sh'].includes(command)) throw error('ENOENT', 'spawnSync ' + message.command + ' ENOENT');
        if (!validPath(message.cwd) || !files[message.cwd]?.d) throw error('ENOENT', 'spawnSync ' + message.command + ' ENOENT');
        if (JSON.stringify(message.env || {}).length > 65536 || !Array.isArray(message.prepared || []) || JSON.stringify(message.prepared || []).length > 16 * 1024 * 1024) throw error('EFBIG', 'Process environment or prepared module graph exceeds limit.');
        if (message.deps instanceof ArrayBuffer) assets.deps = new Uint8Array(message.deps).slice();
        else if (ArrayBuffer.isView(message.deps)) assets.deps = new Uint8Array(message.deps.buffer, message.deps.byteOffset, message.deps.byteLength).slice();
        const child = startWorker(nextPID++, actor.isThread ? 1 : actor.pid, {
          command,
          args: message.args,
          cwd: message.cwd,
          env: message.env || {},
          stdio: ['pipe', 'pipe', 'pipe'],
          ipc: false,
          prepared: message.prepared || [],
          syncSession: session,
        });
        session.pid = child.pid;
        if (Number(message.timeout) > 0) {
          session.timeoutTimer = setTimeout(() => {
            if (session.done) return;
            session.error = error('ETIMEDOUT', 'spawnSync ' + command + ' ETIMEDOUT');
            finish(child, null, session.killSignal || 'SIGTERM');
          }, Math.max(1, Number(message.timeout)));
        }
      } catch (failure) {
        completeSyncSession(session, null, null, failure);
      }
    }
    function spawnThread(owner, spec) {
      const threadId = Number(spec.threadId) || (ctrlI32 ? (Atomics.add(ctrlI32, 0, 1) + 1) : (1000 + nextThreadFallback++));
      const actorKey = 't:' + threadId;
      if (!assets) {
        owner.worker.postMessage({ type: 'thread-event', threadId, event: 'error', error: recordError(error('ERR_WORKER_NOT_RUNNING', 'Runtime assets are not ready.')) });
        owner.worker.postMessage({ type: 'thread-event', threadId, event: 'exit', code: 1 });
        return;
      }
      if (threads.size >= MAX_THREADS) {
        owner.worker.postMessage({ type: 'thread-event', threadId, event: 'error', error: recordError(error('ERR_WORKER_OUT_OF_MEMORY', 'Virtual worker_threads limit reached (' + MAX_THREADS + ' active threads).')) });
        owner.worker.postMessage({ type: 'thread-event', threadId, event: 'exit', code: 1 });
        return;
      }
      if (spec.deps instanceof ArrayBuffer) assets.deps = new Uint8Array(spec.deps).slice();
      else if (ArrayBuffer.isView(spec.deps)) assets.deps = new Uint8Array(spec.deps.buffer, spec.deps.byteOffset, spec.deps.byteLength).slice();
      if (spec.shareEnv) owner.shareEnv = true;
      const worker = new Worker(sourceURL, { name: spec.name || ('Beownir thread ' + threadId) });
      const entry = {
        actorKey, isThread: true, pid: owner.pid, ownerKey: owner.actorKey, ownerThreadId: owner.threadId || 0,
        threadId, worker, state: 'booting', cwd: spec.cwd || owner.cwd || '/project',
        env: spec.env || {}, shareEnv: !!spec.shareEnv, stdoutPipe: !!spec.stdoutPipe, stderrPipe: !!spec.stderrPipe,
        port: spec.port, mailboxes: spec.mailboxes || null, workerData: spec.workerData, transferredPorts: Array.isArray(spec.transferredPorts) ? spec.transferredPorts : [],
        filename: spec.filename, isEval: !!spec.isEval, name: spec.name || '', resourceLimits: spec.resourceLimits || null,
        execArgv: Array.isArray(spec.execArgv) ? spec.execArgv : [], argv: Array.isArray(spec.argv) ? spec.argv : [],
        prepared: Array.isArray(spec.prepared) ? spec.prepared : [], startedAt: Date.now(), bootPerfStart: profilerState.enabled ? performance.now() : 0, outputWindow: performance.now(), outputMessages: 0, fsError: null,
      };
      threads.set(threadId, entry);
      actors.set(actorKey, entry);
      syncActiveCount();
      worker.onmessage = event => handleActorMessage(entry, event.data);
      worker.onerror = event => { event.preventDefault(); finishThread(entry, 1, error('ERR_WORKER', event.message || 'Worker thread crashed.')); };
      worker.onmessageerror = () => finishThread(entry, 1, error('ERR_IPC', 'Could not decode worker thread message.'));
      entry.bootTimeout = setTimeout(() => finishThread(entry, 1, error('ETIMEDOUT', 'Worker thread startup timed out.')), 600000);
      const wasm = assets.wasm.slice().buffer;
      const deps = assets.deps ? assets.deps.slice().buffer : undefined;
      const transfer = [wasm];
      if (deps) transfer.push(deps);
      if (entry.port && transfer.indexOf(entry.port) < 0) transfer.push(entry.port);
      for (const item of entry.transferredPorts) {
        if (item && typeof item === 'object' && (item instanceof ArrayBuffer || (typeof MessagePort !== 'undefined' && item instanceof MessagePort)) && transfer.indexOf(item) < 0) {
          transfer.push(item);
        }
      }
      const profilerCfg = profilerState.enabled ? { enabled: true, maxSpans: profilerState.maxSpans, reset: true } : null;
      worker.postMessage({
        type: 'init',
        files,
        versions,
        embeddedEsbuildWasm: wasm,
        embeddedEsbuildBrowser: assets.browser,
        embeddedPako: assets.pako,
        deps,
        network: networkConfig,
        profiler: profilerCfg,
        kernel: {
          pid: entry.ownerKey === 'p:1' ? 1 : owner.pid,
          ppid: 0,
          isThread: true,
          threads: true,
          threadId: entry.threadId,
          ownerThreadId: entry.ownerThreadId,
          cwd: entry.cwd,
          env: entry.env,
          shareEnv: entry.shareEnv,
          ipc: false,
          stdio: ['pipe', entry.stdoutPipe ? 'pipe' : 'inherit', entry.stderrPipe ? 'pipe' : 'inherit'],
          prepared: entry.prepared,
          ctrlSab,
          envData: serializeEnvData(),
          port: entry.port,
          mailboxes: entry.mailboxes,
          workerData: entry.workerData,
          transferredPorts: entry.transferredPorts,
          filename: entry.filename,
          isEval: entry.isEval,
          name: entry.name,
          resourceLimits: entry.resourceLimits,
          stdoutPipe: entry.stdoutPipe,
          stderrPipe: entry.stderrPipe,
          execArgv: entry.execArgv,
          argv: entry.argv,
          epoch,
          network: networkConfig,
          profiler: profilerCfg,
        },
      }, transfer);
      // Drop references to transferred handles from router memory once handed to child.
      entry.port = null;
      entry.workerData = null;
      entry.transferredPorts = [];
    }
    async function syscall(actor, message) {
      const data = message.data || {};
      switch (message.op) {
        case 'barrier': if (actor.fsError) { const failure = actor.fsError; actor.fsError = null; throw failure; } return { epoch };
        case 'fs-snapshot': return { files, versions, epoch };
        case 'ps': return table();
        case 'write-output': {
          if (!['stdout', 'stderr'].includes(data.stream) || !(data.bytes instanceof Uint8Array) || data.bytes.length > 8 * 1024 * 1024) throw error('EFBIG', 'Invalid virtual output bytes.');
          if (actor.isThread) {
            const pipe = data.stream === 'stdout' ? actor.stdoutPipe : actor.stderrPipe;
            if (pipe) { threadEvent(actor, { event: data.stream, data: data.bytes }); return true; }
            emitOutput(actor, data.stream, new TextDecoder().decode(data.bytes));
            return true;
          }
          const index = data.stream === 'stdout' ? 1 : 2, mode = actor.stdio[index];
          if (mode === 'ignore') return true;
          if (mode === 'pipe') { if (!processes.has(actor.ppid)) throw error('EPIPE', 'Child output pipe is closed.'); childEvent(actor, { event: data.stream, data: data.bytes }); }
          else emitOutput(actor, data.stream, new TextDecoder().decode(data.bytes));
          return true;
        }
        case 'spawn': {
          if (!assets || typeof data.command !== 'string' || !Array.isArray(data.args) || data.args.some(a => typeof a !== 'string') || JSON.stringify(data.args).length > 16384) throw error('EINVAL', 'Invalid process arguments.');
          const command = data.command.split('/').pop();
          if (!['node', 'nodejs', 'npm', 'pnpm', 'yarn', 'bun', 'bunx', 'npx', 'esbuild', 'sh'].includes(command)) throw error('ENOENT', 'No browser executable named ' + command + '. Native OS binaries cannot be spawned.');
          if (!validPath(data.cwd) || !files[data.cwd]?.d) throw error('ENOENT', 'Child working directory does not exist.');
          if (JSON.stringify(data.env || {}).length > 65536 || !Array.isArray(data.prepared) || JSON.stringify(data.prepared).length > 16 * 1024 * 1024) throw error('EFBIG', 'Process environment or prepared module graph exceeds limit.');
          if (data.deps instanceof ArrayBuffer) assets.deps = new Uint8Array(data.deps).slice();
          else if (ArrayBuffer.isView(data.deps)) assets.deps = new Uint8Array(data.deps.buffer, data.deps.byteOffset, data.deps.byteLength).slice();
          const child = startWorker(nextPID++, actor.isThread ? 1 : actor.pid, { ...data, command });
          return { pid: child.pid };
        }
        case 'kill': return kill(data.pid, data.signal, data.tree === true);
        case 'signal-handled': clearTimeout(actor.killTimeout); actor.state = 'running'; publishTable(); return true;
        case 'ipc': {
          const targetPID = data.direction === 'parent' ? actor.ppid : Number(data.pid), target = processes.get(targetPID);
          if (!target || !actor.ipc && data.direction === 'parent' || data.direction !== 'parent' && (!target.ipc || target.ppid !== actor.pid)) throw error('ERR_IPC_CHANNEL_CLOSED', 'The virtual IPC channel is closed.');
          if (JSON.stringify(data.message).length > 1024 * 1024) throw error('EFBIG', 'IPC messages are limited to JSON-compatible data up to 1 MiB.');
          if (data.direction === 'parent') childEvent(actor, { event: 'message', message: data.message });
          else target.worker.postMessage({ type: 'kernel-ipc', message: data.message });
          return true;
        }
        case 'disconnect': {
          const target = data.pid ? processes.get(Number(data.pid)) : actor;
          if (!target || data.pid && target.ppid !== actor.pid) throw error('ERR_IPC_CHANNEL_CLOSED', 'IPC channel is not owned by this process.');
          target.ipc = false; target.worker.postMessage({ type: 'kernel-disconnect' }); childEvent(target, { event: 'disconnect' }); return true;
        }
        case 'stdin': {
          const target = processes.get(Number(data.pid)); if (!target || target.ppid !== actor.pid) throw error('EPIPE', 'Child input is not writable.');
          if ((data.bytes?.byteLength || 0) > 1024 * 1024) throw error('EFBIG', 'Stdin chunk exceeds 1 MiB.');
          target.worker.postMessage({ type: 'kernel-stdin', bytes: data.bytes || null, end: !!data.end }); return true;
        }
        case 'thread-message': {
          const targetId = Number(data.targetThreadId);
          const fromId = actor.isThread ? actor.threadId : 0;
          if (targetId === fromId) throw error('ERR_WORKER_MESSAGING_SAME_THREAD', 'Cannot send a message to the same thread');
          const target = targetId === 0 ? processes.get(actor.pid || 1) : threads.get(targetId);
          if (!target) throw error('ERR_WORKER_MESSAGING_FAILED', 'Cannot send message to thread ' + targetId + ': thread is not running.');
          const ports = Array.isArray(data.transferredPorts) ? data.transferredPorts : [];
          const transfer = [];
          for (const item of ports) {
            if (item && typeof item === 'object' && (item instanceof ArrayBuffer || (typeof MessagePort !== 'undefined' && item instanceof MessagePort)) && transfer.indexOf(item) < 0) transfer.push(item);
          }
          target.worker.postMessage({ type: 'thread-direct-message', fromThreadId: fromId, value: data.value, transferredPorts: ports }, transfer);
          return true;
        }
        case 'bind-http': {
          let port = Number(data.port);
          if (port === 0) { port = 30000; while (listeners.has(port) && port < 65535) port++; }
          if (!Number.isInteger(port) || port < 1 || port > 65535) throw error('EINVAL', 'Invalid virtual port.');
          if (listeners.has(port)) throw error('EADDRINUSE', 'Virtual port already in use: ' + port);
          listeners.set(port, actor.actorKey); publishTable(); return { port };
        }
        case 'unbind-http': if (listeners.get(Number(data.port)) === actor.actorKey) { listeners.delete(Number(data.port)); sendHost({ type: 'close', port: Number(data.port) }); publishTable(); } return true;
        case 'http': return routeHTTP({ ...data, type: 'http' });
        case 'npm-extract-batch': return npmExtractBatch(data);
        case 'host-fetch': {
          const hasRelativeProxy = typeof networkConfig?.corsProxy === 'string' && networkConfig.corsProxy.startsWith('/');
          if (!networkConfig?.useHostProxy && !hasRelativeProxy) throw error('ENOTCAPABLE', 'Host fetch proxy relay is not enabled.');
          if (typeof data.url !== 'string' || !/^https:\/\//i.test(data.url) || data.url.length > 8192) throw error('EINVAL', 'Invalid proxied fetch URL.');
          if ((data.body?.byteLength || data.body?.length || 0) > 2 * 1024 * 1024) throw error('EFBIG', 'Proxied request body exceeds 2 MiB.');
          const fetchId = 'host-fetch-' + ++sequence;
          return new Promise((resolve, reject) => {
            const timer = setTimeout(() => { hostFetchPending.delete(fetchId); reject(error('ETIMEDOUT', 'Host fetch proxy timed out.')); }, 600000);
            hostFetchPending.set(fetchId, { resolve, reject, timer });
            sendHost({ type: 'host-fetch', id: fetchId, url: data.url, method: data.method || 'GET', headers: data.headers || {}, body: data.body || null });
          });
        }
        default: throw error('ENOSYS', 'Unknown virtual OS syscall: ' + message.op);
      }
    }
    function handleActorMessage(actor, message) {
      if (stopped || !actors.has(actor.actorKey) || !message || typeof message !== 'object') return;
      if (message.type === 'kernel-call') {
        Promise.resolve().then(() => syscall(actor, message)).then(result => {
          let transfer;
          if (result && typeof result === 'object' && Array.isArray(result.__transfer)) {
            transfer = result.__transfer;
            delete result.__transfer;
          }
          reply(actor, message.id, result, null, transfer);
        }, failure => reply(actor, message.id, null, failure));
        return;
      }
      if (message.type === 'spawn-sync') { spawnSyncProcess(actor, message); return; }
      if (message.type === 'thread-spawn') { spawnThread(actor, message); return; }
      if (message.type === 'thread-terminate') {
        const entry = threads.get(Number(message.threadId));
        if (entry && entry.ownerKey === actor.actorKey) finishThread(entry, 1);
        else actor.worker.postMessage({ type: 'thread-event', threadId: Number(message.threadId), event: 'exit', code: 1 });
        return;
      }
      if (message.type === 'thread-env') {
        if (message.deleted) envData.delete(message.key);
        else envData.set(message.key, message.value);
        if (ctrlI32) Atomics.add(ctrlI32, 3, 1);
        for (const peer of actors.values()) if (peer.actorKey !== actor.actorKey) peer.worker.postMessage({ type: 'kernel-env-data', key: message.key, value: message.value, deleted: !!message.deleted });
        return;
      }
      if (message.type === 'thread-share-env') {
        for (const peer of actors.values()) {
          if (peer.actorKey === actor.actorKey || peer.pid !== actor.pid) continue;
          if (peer.shareEnv || peer.actorKey === actor.ownerKey) peer.worker.postMessage({ type: 'kernel-share-env', key: message.key, value: message.value, deleted: !!message.deleted });
        }
        return;
      }
      if (message.type === 'thread-online' && actor.isThread) {
        clearTimeout(actor.bootTimeout);
        actor.ready = true;
        actor.state = 'running';
        threadEvent(actor, { event: 'online' });
        return;
      }
      if (message.type === 'profiler-spans') {
        appendWorkerSpans(message.spans);
        return;
      }
      if (message.type === 'profiler-data') {
        appendWorkerSpans(message.spans);
        const pending = pendingCollect.get(message.collectId);
        if (pending) {
          pending.remaining.delete(actor.actorKey);
          if (pending.remaining.size === 0) pending.finish();
        }
        return;
      }
      if (message.type === 'thread-exit' && actor.isThread) {
        finishThread(actor, message.code, message.error || null);
        return;
      }
      if (message.type === 'kernel-exit') { if (!actor.isThread && actor.pid !== 1) finish(actor, message.code, message.signal || null); return; }
      if (message.type === 'stdout' || message.type === 'stderr' || message.type === 'notice') { emitOutput(actor, message.type, message.data); return; }
      if (message.type === 'fssync') {
        try { fsUpdate(message.files, message.versions, false, actor.actorKey); }
        catch (failure) { actor.fsError = failure; emitOutput(actor, 'stderr', failure.message + '\n'); }
        return;
      }
      if (message.type === 'ready') {
        if (actor.ready) return; actor.ready = true;
        clearTimeout(actor.bootTimeout); actor.state = 'running';
        if (profilerState.enabled && actor.bootPerfStart) {
          recordKernelSpan(actor.isThread ? 'thread.boot' : 'worker.boot', 'workers', actor.bootPerfStart, { pid: actor.pid, threadId: actor.threadId || 0 });
        }
        if (actor.isThread) return;
        publishTable();
        if (actor.pid === 1) sendHost({ type: 'ready' });
        else { childEvent(actor, { event: 'spawn' }); actor.worker.postMessage({ type: 'kernel-start', command: actor.command, args: actor.args }); }
        return;
      }
      if (message.type === 'wsevent') { if (message.event === 'close') wsOwners.delete(message.id); sendHost(message); return; }
      if (message.type === 'httpres') {
        const route = httpRoutes.get(message.id); if (!route || route.target !== actor.actorKey) return;
        clearTimeout(route.timer); httpRoutes.delete(message.id);
        if (!(message.body instanceof Uint8Array) || message.body.length > 8 * 1024 * 1024) route.reject(error('EFBIG', 'Invalid or oversized HTTP response.'));
        else route.resolve({ status: message.status, statusMessage: message.statusMessage, headers: message.headers || {}, body: message.body }); return;
      }
      if (message.type === 'listen') { if (listeners.get(message.port) === actor.actorKey) { sendHost(message); publishTable(); } return; }
      if (message.type === 'close') { if (listeners.get(message.port) === actor.actorKey) { listeners.delete(message.port); sendHost(message); publishTable(); } return; }
      if (!actor.isThread && message.type === 'question') { inputPID = actor.pid; sendHost(message); return; }
      if (!actor.isThread && message.type === 'questionend') { inputPID = 1; sendHost(message); return; }
      if (!actor.isThread && message.type === 'kernel-cwd') { if (validPath(message.cwd) && files[message.cwd]?.d) { actor.cwd = message.cwd; publishTable(); } return; }
      if (message.type === 'fatal') {
        if (actor.isThread) finishThread(actor, 1, error('ERR_WORKER', message.message));
        else finish(actor, 1, null, error('ERR_PROCESS', message.message));
        return;
      }
      if (!actor.isThread && actor.pid === 1 && message.type === 'deps-checkpoint') {
        assets.deps = message.bytes instanceof ArrayBuffer ? new Uint8Array(message.bytes).slice() : null;
        sendHost(message, message.bytes instanceof ArrayBuffer ? [message.bytes] : undefined);
        return;
      }
      if (!actor.isThread && actor.pid === 1 && ['done', 'clear', 'open', 'pkgdone', 'pong', 'pkgprogress', 'deps-state', 'deps-restored', 'deps-cleared', 'storage', 'storage-gc-request', 'storage-persist-request'].includes(message.type)) sendHost(message);
    }
    function shutdown() {
      if (stopped) return; stopped = true;
      for (const session of [...syncSessions]) completeSyncSession(session, null, 'SIGTERM', error('ECONNRESET', 'Virtual OS stopped.'));
      for (const process of processes.values()) { clearTimeout(process.bootTimeout); clearTimeout(process.killTimeout); process.worker.terminate(); }
      for (const entry of threads.values()) { clearTimeout(entry.bootTimeout); entry.worker.terminate(); }
      for (const route of httpRoutes.values()) clearTimeout(route.timer);
      for (const pending of hostFetchPending.values()) { clearTimeout(pending.timer); pending.reject(error('ECONNRESET', 'Virtual OS stopped.')); }
      processes.clear(); threads.clear(); actors.clear(); httpRoutes.clear(); hostFetchPending.clear(); listeners.clear(); if (sourceURL) URL.revokeObjectURL(sourceURL); if (npmWorkerURL) URL.revokeObjectURL(npmWorkerURL);
      host.postMessage({ type: 'kernel-stopped' }); host.close();
    }
    try {
      sourceURL = URL.createObjectURL(new Blob([event.data.source], { type: 'text/javascript' })); startWorker(1, 0);
      host.onmessage = async event => {
        const message = event.data; if (!message || typeof message !== 'object' || stopped) return;
        try {
          if (message.type === 'terminate') return shutdown();
          if (message.type === 'init') {
            if (message.network && typeof message.network === 'object') networkConfig = message.network;
            if (message.profiler && typeof message.profiler === 'object') {
              profilerState.enabled = Boolean(message.profiler.enabled);
              if (Number(message.profiler.maxSpans) > 0) profilerState.maxSpans = Math.min(20000, Math.floor(Number(message.profiler.maxSpans)));
              if (profilerState.enabled) { profilerState.startedAt = Date.now(); profilerState.spans.length = 0; }
            }
            const depsCopy = message.deps instanceof ArrayBuffer ? new Uint8Array(message.deps).slice()
              : ArrayBuffer.isView(message.deps) ? new Uint8Array(message.deps.buffer, message.deps.byteOffset, message.deps.byteLength).slice()
              : null;
            assets = { wasm: new Uint8Array(message.embeddedEsbuildWasm), browser: message.embeddedEsbuildBrowser, pako: message.embeddedPako, deps: depsCopy };
            fsUpdate({ '/tmp': { d: true }, ...message.files }, message.versions, true, 'p:1'); initializeProcess(processes.get(1)); return;
          }
          if (message.type === 'setfiles') { fsUpdate(message.files, message.versions, true, 'host'); return; }
          if (message.type === 'set-network') {
            networkConfig = message.network && typeof message.network === 'object' ? message.network : null;
            for (const actor of actors.values()) actor.worker.postMessage({ type: 'set-network', network: networkConfig });
            return;
          }
          if (message.type === 'profiler') {
            const action = message.action;
            if (action === 'start') {
              profilerState.enabled = true;
              if (Number(message.maxSpans) > 0) profilerState.maxSpans = Math.min(20000, Math.floor(Number(message.maxSpans)));
              profilerState.startedAt = Date.now();
              profilerState.spans.length = 0;
              for (const actor of actors.values()) actor.worker.postMessage({ type: 'profiler', action: 'start', maxSpans: profilerState.maxSpans });
              if (message.id) sendHost({ type: 'profiler-report', id: message.id, report: { startedAt: profilerState.startedAt, spans: [] } });
              return;
            }
            if (action === 'stop' || action === 'snapshot') {
              const collectId = 'col-' + (++sequence);
              const remaining = new Set(actors.keys());
              const finishCollect = () => {
                if (!pendingCollect.has(collectId)) return;
                clearTimeout(entry.timer);
                pendingCollect.delete(collectId);
                const collected = profilerState.spans.slice();
                if (action === 'stop') { profilerState.enabled = false; profilerState.spans.length = 0; }
                sendHost({ type: 'profiler-report', id: message.id, report: { startedAt: profilerState.startedAt, endedAt: Date.now(), spans: collected } });
              };
              const entry = { remaining, finish: finishCollect, timer: setTimeout(finishCollect, 400) };
              if (!remaining.size) { finishCollect(); return; }
              pendingCollect.set(collectId, entry);
              for (const actor of actors.values()) actor.worker.postMessage({ type: 'profiler', action, collectId });
              return;
            }
          }
          if (message.type === 'host-fetch-reply') {
            const pending = hostFetchPending.get(message.id);
            if (!pending) return;
            clearTimeout(pending.timer); hostFetchPending.delete(message.id);
            if (message.error) pending.reject(error(message.code || 'ENETUNREACH', message.error));
            else pending.resolve({ status: message.status, statusMessage: message.statusText || '', headers: message.headers || {}, body: message.body instanceof Uint8Array ? message.body : new Uint8Array(message.body || []) });
            return;
          }
          if (message.type === 'http') {
            try { const response = await routeHTTP(message); sendHost({ ...response, type: 'httpres', id: message.id }); }
            catch (failure) { sendHost({ type: 'httpres', id: message.id, status: 502, headers: { 'content-type': 'text/plain' }, body: new TextEncoder().encode(failure.message) }); } return;
          }
          if (message.type === 'ws') { wsRoute(message); return; }
          if (message.type === 'kill-process') { kill(message.pid, message.signal || 'SIGTERM', message.tree === true); return; }
          if (['cmd', 'ping'].includes(message.type)) processes.get(1)?.worker.postMessage(message);
          if (message.type === 'stdin') (processes.get(inputPID) || processes.get(1))?.worker.postMessage(message);
        } catch (failure) { sendHost({ type: 'stderr', data: 'Virtual OS: ' + failure.message + '\n' }); }
      };
      host.start(); sendHost({ type: 'connected' }); window.addEventListener('pagehide', shutdown, { once: true });
    } catch (failure) { sendHost({ type: 'fatal', message: failure.message }); shutdown(); }
  });
})();
