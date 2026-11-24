/*
 * Beownir streaming package-install kit.
 *
 * Pure, dependency-free helpers used by the browser compatibility runtime to
 * install npm tarballs in bounded memory:
 *
 *   - downloadToConsumer(): chunked registry download with stall watchdog,
 *     retries and byte budget (never materialises the whole tarball).
 *   - createSha512(): incremental SHA-512 so integrity can be checked while
 *     the tarball is still streaming (no full-body buffering).
 *   - createTarParser(): incremental ustar/PAX/GNU tar reader that emits file
 *     entries chunk by chunk, so a package is written to disk in "packets".
 *   - streamPackage(): wires download -> hash -> gunzip -> untar -> sink.
 *
 * The module is loaded twice:
 *   1. as a CommonJS module by the Node test-suite (tools/ sync it into the
 *      single-file app), and
 *   2. inlined verbatim into the browser worker source.
 * It therefore uses only standard globals (Uint8Array, TextDecoder, fetch,
 * AbortController) and receives pako/Buffer from its caller.
 */
(function (root, factory) {
  const kit = factory();
  if (typeof module === 'object' && module.exports) module.exports = kit;
  if (root) root.BeownirInstallKit = kit;
})(typeof globalThis !== 'undefined' ? globalThis : typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const MIB = 1024 * 1024;

  /* ------------------------------------------------------------------ *
   * Bytes
   * ------------------------------------------------------------------ */
  function toBytes(value) {
    if (value instanceof Uint8Array) return value;
    if (value instanceof ArrayBuffer) return new Uint8Array(value);
    if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    if (typeof value === 'string') return new TextEncoder().encode(value);
    throw new TypeError('Expected binary data');
  }

  function concatBytes(list, total) {
    if (list.length === 1) return list[0];
    const length = total === undefined ? list.reduce((sum, part) => sum + part.length, 0) : total;
    const out = new Uint8Array(length);
    let offset = 0;
    for (const part of list) { out.set(part, offset); offset += part.length; }
    return out;
  }

  const HEX = '0123456789abcdef';
  function toHex(bytes) {
    let out = '';
    for (let index = 0; index < bytes.length; index++) out += HEX[bytes[index] >>> 4] + HEX[bytes[index] & 15];
    return out;
  }

  const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  function toBase64(bytes) {
    let out = '';
    let index = 0;
    for (; index + 2 < bytes.length; index += 3) {
      const value = (bytes[index] << 16) | (bytes[index + 1] << 8) | bytes[index + 2];
      out += B64[(value >> 18) & 63] + B64[(value >> 12) & 63] + B64[(value >> 6) & 63] + B64[value & 63];
    }
    const rest = bytes.length - index;
    if (rest === 1) {
      const value = bytes[index] << 16;
      out += B64[(value >> 18) & 63] + B64[(value >> 12) & 63] + '==';
    } else if (rest === 2) {
      const value = (bytes[index] << 16) | (bytes[index + 1] << 8);
      out += B64[(value >> 18) & 63] + B64[(value >> 12) & 63] + B64[(value >> 6) & 63] + '=';
    }
    return out;
  }

  function fromBase64(text) {
    const clean = String(text).replace(/[\s=]/g, '');
    const out = new Uint8Array(Math.floor(clean.length * 3 / 4));
    let buffer = 0, bits = 0, offset = 0;
    for (let index = 0; index < clean.length; index++) {
      const value = B64.indexOf(clean[index]);
      if (value < 0) throw new TypeError('Invalid base64 input');
      buffer = (buffer << 6) | value; bits += 6;
      if (bits >= 8) { bits -= 8; out[offset++] = (buffer >> bits) & 0xff; }
    }
    return out.subarray(0, offset);
  }

  /* ------------------------------------------------------------------ *
   * Incremental SHA-512 (64-bit words as hi/lo 32-bit pairs)
   * ------------------------------------------------------------------ */
  const K512 = new Uint32Array([
    0x428a2f98, 0xd728ae22, 0x71374491, 0x23ef65cd, 0xb5c0fbcf, 0xec4d3b2f, 0xe9b5dba5, 0x8189dbbc,
    0x3956c25b, 0xf348b538, 0x59f111f1, 0xb605d019, 0x923f82a4, 0xaf194f9b, 0xab1c5ed5, 0xda6d8118,
    0xd807aa98, 0xa3030242, 0x12835b01, 0x45706fbe, 0x243185be, 0x4ee4b28c, 0x550c7dc3, 0xd5ffb4e2,
    0x72be5d74, 0xf27b896f, 0x80deb1fe, 0x3b1696b1, 0x9bdc06a7, 0x25c71235, 0xc19bf174, 0xcf692694,
    0xe49b69c1, 0x9ef14ad2, 0xefbe4786, 0x384f25e3, 0x0fc19dc6, 0x8b8cd5b5, 0x240ca1cc, 0x77ac9c65,
    0x2de92c6f, 0x592b0275, 0x4a7484aa, 0x6ea6e483, 0x5cb0a9dc, 0xbd41fbd4, 0x76f988da, 0x831153b5,
    0x983e5152, 0xee66dfab, 0xa831c66d, 0x2db43210, 0xb00327c8, 0x98fb213f, 0xbf597fc7, 0xbeef0ee4,
    0xc6e00bf3, 0x3da88fc2, 0xd5a79147, 0x930aa725, 0x06ca6351, 0xe003826f, 0x14292967, 0x0a0e6e70,
    0x27b70a85, 0x46d22ffc, 0x2e1b2138, 0x5c26c926, 0x4d2c6dfc, 0x5ac42aed, 0x53380d13, 0x9d95b3df,
    0x650a7354, 0x8baf63de, 0x766a0abb, 0x3c77b2a8, 0x81c2c92e, 0x47edaee6, 0x92722c85, 0x1482353b,
    0xa2bfe8a1, 0x4cf10364, 0xa81a664b, 0xbc423001, 0xc24b8b70, 0xd0f89791, 0xc76c51a3, 0x0654be30,
    0xd192e819, 0xd6ef5218, 0xd6990624, 0x5565a910, 0xf40e3585, 0x5771202a, 0x106aa070, 0x32bbd1b8,
    0x19a4c116, 0xb8d2d0c8, 0x1e376c08, 0x5141ab53, 0x2748774c, 0xdf8eeb99, 0x34b0bcb5, 0xe19b48a8,
    0x391c0cb3, 0xc5c95a63, 0x4ed8aa4a, 0xe3418acb, 0x5b9cca4f, 0x7763e373, 0x682e6ff3, 0xd6b2b8a3,
    0x748f82ee, 0x5defb2fc, 0x78a5636f, 0x43172f60, 0x84c87814, 0xa1f0ab72, 0x8cc70208, 0x1a6439ec,
    0x90befffa, 0x23631e28, 0xa4506ceb, 0xde82bde9, 0xbef9a3f7, 0xb2c67915, 0xc67178f2, 0xe372532b,
    0xca273ece, 0xea26619c, 0xd186b8c7, 0x21c0c207, 0xeada7dd6, 0xcde0eb1e, 0xf57d4f7f, 0xee6ed178,
    0x06f067aa, 0x72176fba, 0x0a637dc5, 0xa2c898a6, 0x113f9804, 0xbef90dae, 0x1b710b35, 0x131c471b,
    0x28db77f5, 0x23047d84, 0x32caab7b, 0x40c72493, 0x3c9ebe0a, 0x15c9bebc, 0x431d67c4, 0x9c100d4c,
    0x4cc5d4be, 0xcb3e42b6, 0x597f299c, 0xfc657e2a, 0x5fcb6fab, 0x3ad6faec, 0x6c44198c, 0x4a475817
  ]);

  // 64-bit rotation helpers are expanded inline inside compress() so the inner
  // loop does not allocate a temporary array per rotation.
  function rotr(hi, lo, n) {
    if (n === 0) return [hi, lo];
    if (n < 32) return [(hi >>> n) | (lo << (32 - n)), (lo >>> n) | (hi << (32 - n))];
    if (n === 32) return [lo, hi];
    const m = n - 32;
    return [(lo >>> m) | (hi << (32 - m)), (hi >>> m) | (lo << (32 - m))];
  }
  function shr(hi, lo, n) {
    if (n < 32) return [(hi >>> n), (lo >>> n) | (hi << (32 - n))];
    if (n === 32) return [0, hi];
    return [0, hi >>> (n - 32)];
  }

  function createSha512() {
    // [hi, lo] state
    let h0 = 0x6a09e667, h0l = 0xf3bcc908;
    let h1 = 0xbb67ae85, h1l = 0x84caa73b;
    let h2 = 0x3c6ef372, h2l = 0xfe94f82b;
    let h3 = 0xa54ff53a, h3l = 0x5f1d36f1;
    let h4 = 0x510e527f, h4l = 0xade682d1;
    let h5 = 0x9b05688c, h5l = 0x2b3e6c1f;
    let h6 = 0x1f83d9ab, h6l = 0xfb41bd6b;
    let h7 = 0x5be0cd19, h7l = 0x137e2179;

    const W = new Uint32Array(160);
    const block = new Uint8Array(128);
    let blockLength = 0;
    let total = 0;
    let finished = false;

    function compress(data, offset) {
      // Message schedule: 16 words read from the block, 64 expanded.
      for (let index = 0; index < 16; index++) {
        const at = offset + index * 8;
        W[index * 2] = (data[at] << 24) | (data[at + 1] << 16) | (data[at + 2] << 8) | data[at + 3];
        W[index * 2 + 1] = (data[at + 4] << 24) | (data[at + 5] << 16) | (data[at + 6] << 8) | data[at + 7];
      }
      for (let index = 16; index < 80; index++) {
        const a = (index - 15) * 2, b = (index - 2) * 2;
        const xh = W[a], xl = W[a + 1], yh = W[b], yl = W[b + 1];
        const s0h = ((xh >>> 1) | (xl << 31)) ^ ((xh >>> 8) | (xl << 24)) ^ (xh >>> 7), s0l = ((xl >>> 1) | (xh << 31)) ^ ((xl >>> 8) | (xh << 24)) ^ ((xl >>> 7) | (xh << 25));
        const s1h = ((yh >>> 19) | (yl << 13)) ^ ((yl >>> 29) | (yh << 3)) ^ (yh >>> 6), s1l = ((yl >>> 19) | (yh << 13)) ^ ((yh >>> 29) | (yl << 3)) ^ ((yl >>> 6) | (yh << 26));
        const lo = (W[(index - 16) * 2 + 1] >>> 0) + (s0l >>> 0) + (W[(index - 7) * 2 + 1] >>> 0) + (s1l >>> 0);
        const hi = (W[(index - 16) * 2] >>> 0) + (s0h >>> 0) + (W[(index - 7) * 2] >>> 0) + (s1h >>> 0) + Math.floor(lo / 0x100000000);
        W[index * 2] = hi >>> 0; W[index * 2 + 1] = lo >>> 0;
      }

      let ah = h0, al = h0l, bh = h1, bl = h1l, ch = h2, cl = h2l, dh = h3, dl = h3l;
      let eh = h4, el = h4l, fh = h5, fl = h5l, gh = h6, gl = h6l, hh = h7, hl = h7l;

      for (let index = 0; index < 80; index++) {
        const s1h = ((eh >>> 14) | (el << 18)) ^ ((eh >>> 18) | (el << 14)) ^ ((el >>> 9) | (eh << 23)), s1l = ((el >>> 14) | (eh << 18)) ^ ((el >>> 18) | (eh << 14)) ^ ((eh >>> 9) | (el << 23));
        const chh = (eh & fh) ^ (~eh & gh), chl = (el & fl) ^ (~el & gl);
        const t1lo = (hl >>> 0) + (s1l >>> 0) + (chl >>> 0) + (K512[index * 2 + 1] >>> 0) + (W[index * 2 + 1] >>> 0);
        const t1hi = (hh >>> 0) + (s1h >>> 0) + (chh >>> 0) + (K512[index * 2] >>> 0) + (W[index * 2] >>> 0) + Math.floor(t1lo / 0x100000000);
        const t1h = t1hi >>> 0, t1l = t1lo >>> 0;
        const s0h = ((ah >>> 28) | (al << 4)) ^ ((al >>> 2) | (ah << 30)) ^ ((al >>> 7) | (ah << 25)), s0l = ((al >>> 28) | (ah << 4)) ^ ((ah >>> 2) | (al << 30)) ^ ((ah >>> 7) | (al << 25));
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

      const v0lo = (h0l >>> 0) + (al >>> 0); h0 = (h0 + ah + Math.floor(v0lo / 0x100000000)) >>> 0; h0l = v0lo >>> 0;
      const v1lo = (h1l >>> 0) + (bl >>> 0); h1 = (h1 + bh + Math.floor(v1lo / 0x100000000)) >>> 0; h1l = v1lo >>> 0;
      const v2lo = (h2l >>> 0) + (cl >>> 0); h2 = (h2 + ch + Math.floor(v2lo / 0x100000000)) >>> 0; h2l = v2lo >>> 0;
      const v3lo = (h3l >>> 0) + (dl >>> 0); h3 = (h3 + dh + Math.floor(v3lo / 0x100000000)) >>> 0; h3l = v3lo >>> 0;
      const v4lo = (h4l >>> 0) + (el >>> 0); h4 = (h4 + eh + Math.floor(v4lo / 0x100000000)) >>> 0; h4l = v4lo >>> 0;
      const v5lo = (h5l >>> 0) + (fl >>> 0); h5 = (h5 + fh + Math.floor(v5lo / 0x100000000)) >>> 0; h5l = v5lo >>> 0;
      const v6lo = (h6l >>> 0) + (gl >>> 0); h6 = (h6 + gh + Math.floor(v6lo / 0x100000000)) >>> 0; h6l = v6lo >>> 0;
      const v7lo = (h7l >>> 0) + (hl >>> 0); h7 = (h7 + hh + Math.floor(v7lo / 0x100000000)) >>> 0; h7l = v7lo >>> 0;
    }
    function update(input) {
      if (finished) throw new Error('SHA-512 digest already finalised');
      const data = toBytes(input);
      total += data.length;
      let offset = 0;
      if (blockLength) {
        const need = 128 - blockLength;
        if (data.length < need) { block.set(data, blockLength); blockLength += data.length; return true; }
        block.set(data.subarray(0, need), blockLength);
        compress(block, 0);
        blockLength = 0;
        offset = need;
      }
      for (; offset + 128 <= data.length; offset += 128) compress(data, offset);
      if (offset < data.length) { block.set(data.subarray(offset), 0); blockLength = data.length - offset; }
      return true;
    }

    function digest() {
      if (finished) throw new Error('SHA-512 digest already finalised');
      const bits = total * 8;
      const tail = new Uint8Array(blockLength < 112 ? 128 : 256);
      tail.set(block.subarray(0, blockLength), 0);
      tail[blockLength] = 0x80;
      // 128-bit big-endian length; the high 64 bits are zero for our sizes.
      let remaining = bits;
      for (let index = tail.length - 1; index >= tail.length - 8 && remaining > 0; index--) {
        tail[index] = remaining % 256; remaining = Math.floor(remaining / 256);
      }
      for (let offset = 0; offset < tail.length; offset += 128) compress(tail, offset);
      const out = new Uint8Array(64);
      const words = [[h0, h0l], [h1, h1l], [h2, h2l], [h3, h3l], [h4, h4l], [h5, h5l], [h6, h6l], [h7, h7l]];
      words.forEach(([hi, lo], index) => {
        out[index * 8] = hi >>> 24; out[index * 8 + 1] = (hi >>> 16) & 255; out[index * 8 + 2] = (hi >>> 8) & 255; out[index * 8 + 3] = hi & 255;
        out[index * 8 + 4] = lo >>> 24; out[index * 8 + 5] = (lo >>> 16) & 255; out[index * 8 + 6] = (lo >>> 8) & 255; out[index * 8 + 7] = lo & 255;
      });
      finished = true;
      return out;
    }

    return {
      update,
      digest,
      digestHex: () => toHex(digest()),
      digestBase64: () => toBase64(digest()),
      get bytesHashed() { return total; }
    };
  }

  /* ------------------------------------------------------------------ *
   * Integrity metadata (npm "integrity" strings)
   * ------------------------------------------------------------------ */
  function parseIntegrity(value) {
    const entries = String(value || '').trim().split(/\s+/).filter(Boolean).map(token => {
      const clean = token.split('?')[0];
      const dash = clean.indexOf('-');
      return dash > 0 ? { algorithm: clean.slice(0, dash), digest: clean.slice(dash + 1) } : null;
    }).filter(Boolean);
    const wanted = ['sha512', 'sha384', 'sha256', 'sha1'].find(name => entries.some(entry => entry.algorithm === name));
    return wanted ? { algorithm: wanted, digests: entries.filter(entry => entry.algorithm === wanted).map(entry => entry.digest) } : null;
  }

  /* ------------------------------------------------------------------ *
   * Streaming tar parser
   * ------------------------------------------------------------------ */
  const TEXT_EXTENSION = /\.(?:[cm]?js|json|jsx|tsx?|md|txt|map|css|html?|ya?ml|flow|svg|scss|less)$/i;
  function looksLikeText(name) {
    return TEXT_EXTENSION.test(name) || /(?:^|\/)(?:LICENSE|README|CHANGELOG)(?:\.[^/]*)?$/i.test(name);
  }

  function cstring(bytes, start, length) {
    let end = start;
    const limit = start + length;
    while (end < limit && bytes[end] !== 0) end++;
    let out = '';
    for (let index = start; index < end; index++) out += String.fromCharCode(bytes[index]);
    return out;
  }

  function octal(bytes, start, length) {
    let out = '';
    for (let index = start; index < start + length; index++) {
      const byte = bytes[index];
      if (byte === 0 || byte === 0x20) { if (out) break; continue; }
      out += String.fromCharCode(byte);
    }
    return out ? parseInt(out, 8) : 0;
  }

  function safeRelativePath(name) {
    if (typeof name !== 'string' || !name || name.length > 1024) throw new Error('Unsafe archive path');
    if (name.startsWith('/') || name.includes('\\') || /[\x00-\x1f:]/.test(name)) throw new Error('Unsafe archive path: ' + name);
    if (name.split('/').some(part => part === '..' || part === '.')) throw new Error('Unsafe archive path: ' + name);
    return name;
  }

  function createTarParser(options = {}) {
    const onEntry = options.onEntry;
    const onEntryData = options.onEntryData;
    const onEntryEnd = options.onEntryEnd;
    const onDirectory = options.onDirectory;
    const maxEntries = options.maxEntries || 20000;
    const maxEntryBytes = options.maxEntryBytes || 64 * MIB;
    const maxTotalBytes = options.maxTotalBytes || 192 * MIB;

    let state = 'header';        // header | data | pad
    let header = new Uint8Array(512);
    let headerLength = 0;
    let remaining = 0;           // bytes of payload left for the current entry
    let padding = 0;
    let current = null;
    let totalBytes = 0;
    let entries = 0;
    let pendingName = null;
    let pax = null;
    let paxBuffer = [];
    let paxLength = 0;
    let longName = null;
    let longNameBuffer = [];
    let ended = false;
    let finished = false;

    function beginHeader() {
      if (headerLength < 512) return;
      const block = header;
      headerLength = 0;
      if (block.every(byte => byte === 0)) { finished = true; return; }
      let checksum = 0;
      for (let index = 0; index < 512; index++) checksum += index >= 148 && index < 156 ? 32 : block[index];
      const stored = octal(block, 148, 8);
      if (stored !== checksum) {
        // Some writers use signed bytes for the checksum; retry that way before failing.
        let signed = 0;
        for (let index = 0; index < 512; index++) {
          const byte = block[index];
          signed += index >= 148 && index < 156 ? 32 : byte > 127 ? byte - 256 : byte;
        }
        if (signed !== stored) throw new Error('Invalid tar header checksum');
      }
      const size = octal(block, 124, 12);
      if (!Number.isSafeInteger(size) || size < 0 || size > maxEntryBytes) throw new Error('Invalid tar entry size');
      const type = String.fromCharCode(block[156] || 0x30);
      let name = cstring(block, 0, 100);
      const prefix = cstring(block, 345, 155);
      if (prefix) name = prefix + '/' + name;

      if (type === 'x' || type === 'g') {           // PAX extended header
        pax = type === 'g' ? (pax || {}) : {};
        paxBuffer = []; paxLength = 0; remaining = size;
        current = { kind: 'pax', name: 'PaxHeader', size, type };
        state = size ? 'data' : 'pad';
        padding = (512 - (size % 512)) % 512;
        return;
      }
      if (type === 'L') {                            // GNU long name
        longNameBuffer = []; paxLength = 0; remaining = size;
        current = { kind: 'longname', name: 'LongName', size, type };
        state = size ? 'data' : 'pad';
        padding = (512 - (size % 512)) % 512;
        return;
      }
      let entryName = (pax && pax.path) || pendingName || name;
      pendingName = null;
      const entryPax = pax || {}; pax = null;
      if (entryPax.path) entryName = entryPax.path;

      if (type === '5') {                            // directory
        if (onDirectory) onDirectory(safeRelativePath(entryName.replace(/\/+$/, '')));
        remaining = size;
        current = { kind: 'skip', name: entryName, size, type };
        state = size ? 'data' : 'pad';
        padding = (512 - (size % 512)) % 512;
        return;
      }
      if (type !== '0' && type !== '\u0000' && type !== '7') {
        // Links, devices, fifos and other exotic entries are never materialised.
        remaining = size;
        current = { kind: 'skip', name: entryName, size, type };
        state = size ? 'data' : 'pad';
        padding = (512 - (size % 512)) % 512;
        return;
      }
      if (++entries > maxEntries) throw new Error('Archive contains too many files');
      const path = safeRelativePath(entryName);
      current = { kind: 'file', name: path, size, type, text: looksLikeText(path), mode: octal(block, 100, 8) };
      if (onEntry) onEntry(current);
      remaining = size;
      state = size ? 'data' : 'pad';
      padding = (512 - (size % 512)) % 512;
      if (!size && onEntryEnd) onEntryEnd(current);
    }

    function push(data) {
      if (ended) throw new Error('Tar stream already ended');
      const bytes = toBytes(data);
      let offset = 0;
      while (offset < bytes.length) {
        if (finished) return;        // trailing zero blocks are ignored
        if (state === 'header') {
          const take = Math.min(512 - headerLength, bytes.length - offset);
          header.set(bytes.subarray(offset, offset + take), headerLength);
          headerLength += take; offset += take;
          if (headerLength === 512) beginHeader();
          continue;
        }
        if (state === 'data') {
          const take = Math.min(remaining, bytes.length - offset);
          const chunk = bytes.subarray(offset, offset + take);
          totalBytes += take;
          if (totalBytes > maxTotalBytes) throw new Error('Archive expands beyond the install budget');
          if (current.kind === 'file') { if (onEntryData) onEntryData(current, chunk); }
          else if (current.kind === 'pax' || current.kind === 'longname') {
            if (paxLength + take > 64 * 1024) throw new Error('Oversized tar metadata header');
            if (current.kind === 'pax') paxBuffer.push(chunk.slice()); else longNameBuffer.push(chunk.slice());
            paxLength += take;
          }
          remaining -= take; offset += take;
          if (remaining === 0) {
            if (current.kind === 'pax') {
              const text = new TextDecoder().decode(concatBytes(paxBuffer, paxLength));
              const parsed = {};
              let cursor = 0;
              while (cursor < text.length) {
                const space = text.indexOf(' ', cursor);
                if (space < 0) break;
                const length = Number(text.slice(cursor, space));
                if (!Number.isSafeInteger(length) || length <= 0 || cursor + length > text.length) throw new Error('Invalid PAX record');
                const record = text.slice(space + 1, cursor + length - 1);
                const equals = record.indexOf('=');
                if (equals > 0) parsed[record.slice(0, equals)] = record.slice(equals + 1);
                cursor += length;
              }
              pax = { ...(pax || {}), ...parsed };
            } else if (current.kind === 'longname') {
              longName = new TextDecoder().decode(concatBytes(longNameBuffer, paxLength)).replace(/\0.*$/s, '');
              pendingName = longName;
            } else if (current.kind === 'file' && onEntryEnd) onEntryEnd(current);
            paxBuffer = []; longNameBuffer = []; paxLength = 0;
            state = 'pad';
          }
          continue;
        }
        if (state === 'pad') {
          if (padding === 0) { state = 'header'; current = null; continue; }
          const take = Math.min(padding, bytes.length - offset);
          padding -= take; offset += take;
          if (padding === 0) { state = 'header'; current = null; }
        }
      }
      return true;
    }

    function end() {
      if (ended) return;
      ended = true;
      if (state !== 'header' || headerLength !== 0) throw new Error('Truncated tar archive');
      if (current && current.kind === 'file' && onEntryEnd) onEntryEnd(current);
    }

    return { push, end, get files() { return entries; }, get bytes() { return totalBytes; }, get finished() { return finished; } };
  }

  /* ------------------------------------------------------------------ *
   * Registry download
   * ------------------------------------------------------------------ */
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  function retryableError(error) {
    const message = String(error && error.message || error);
    return !/integrity|unsafe|budget|limit|too many|invalid|not permitted|only https/i.test(message);
  }

  function rangeUnsupportedError() {
    const error = new Error('Registry does not support byte ranges for this tarball');
    error.code = 'ERR_RANGE_UNSUPPORTED';
    return error;
  }

  function parseContentRange(value) {
    const match = /^bytes\s+(\d+)-(\d+)\/(\d+|\*)$/i.exec(String(value || '').trim());
    if (!match) return null;
    return { start: Number(match[1]), end: Number(match[2]), total: match[3] === '*' ? null : Number(match[3]) };
  }

  function registryTarget(url, origin) {
    const target = new URL(url);
    if (target.origin !== origin || target.username || target.password) throw new Error('Only HTTPS registry.npmjs.org downloads are permitted');
    return target;
  }

  /* Single-response streaming download. The fallback whenever the registry
   * ignores byte ranges, and the path used when segmentation is disabled. */
  async function streamOnce(url, options = {}) {
    const fetchImpl = options.fetch || (typeof fetch === 'function' ? fetch : null);
    if (!fetchImpl) throw new Error('fetch is unavailable');
    const origin = options.origin || 'https://registry.npmjs.org';
    const maxBytes = options.maxBytes || 96 * MIB;
    const idleTimeoutMs = options.idleTimeoutMs || 45000;
    const attempts = Math.max(1, options.attempts || 3);
    const onChunk = options.onChunk;
    const onProgress = options.onProgress;
    const onReset = options.onReset;
    const headers = { 'accept-encoding': 'identity', ...(options.headers || {}) };

    let lastError;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      if (attempt > 1 && onReset) onReset(attempt);
      const controller = new AbortController();
      let idleTimer = null;
      const arm = () => {
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = setTimeout(() => controller.abort(new Error('Registry download stalled for ' + Math.round(idleTimeoutMs / 1000) + 's')), idleTimeoutMs);
      };
      let received = 0, expected = 0;
      try {
        const target = registryTarget(url, origin);
        arm();
        const response = await fetchImpl(target.href, { credentials: 'omit', redirect: 'error', signal: controller.signal, headers });
        if (!response.ok) throw new Error('Registry returned HTTP ' + response.status + ' for ' + target.pathname);
        expected = Number(response.headers.get('content-length')) || 0;
        if (expected && expected > maxBytes) throw new Error('Registry response exceeds the package download budget');
        if (!response.body) throw new Error('Registry response has no readable body');
        const reader = response.body.getReader();
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          received += value.length;
          if (received > maxBytes) { try { await reader.cancel(); } catch { /* already closed */ } throw new Error('Registry response exceeds the package download budget'); }
          arm();
          if (onChunk) await onChunk(value, received, expected);
          if (onProgress) onProgress(received, expected);
        }
        if (expected && received !== expected) throw new Error('Registry download was truncated (' + received + '/' + expected + ' bytes)');
        return received;
      } catch (error) {
        lastError = error;
        const aborted = error && (error.name === 'AbortError' || /stalled/i.test(String(error.message)));
        if (attempt >= attempts || !retryableError(error) || (error.name === 'AbortError' && !aborted)) break;
        if (attempt < attempts) await sleep(Math.min(4000, 300 * attempt * attempt));
      } finally {
        if (idleTimer) clearTimeout(idleTimer);
        try { controller.abort(); } catch { /* ignore */ }
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError || 'Registry download failed'));
  }

  /* Range support has to be detectable without `Content-Range` or
   * `Content-Length`: browsers only expose CORS-safelisted response headers and
   * neither of those two is one of them. A single ranged GET is therefore the
   * whole probe: HTTP 206 means ranges work, HTTP 200 means they are ignored. */
  const rangeSupportCache = new Map();
  async function probeRangeSupport(target, options = {}) {
    const cached = rangeSupportCache.get(target.origin);
    if (cached && !options.refresh) return cached;
    const fetchImpl = options.fetch;
    const idleTimeoutMs = options.idleTimeoutMs || 45000;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('Registry range probe stalled')), idleTimeoutMs);
    try {
      const response = await fetchImpl(target.href, {
        credentials: 'omit', redirect: 'error', signal: controller.signal,
        headers: { ...(options.headers || {}), 'accept-encoding': 'identity', range: 'bytes=0-0' }
      });
      const supported = response.status === 206;
      try { await response.body?.cancel(); } catch { /* ignore */ }
      /* One probe per registry origin per page load: the answer cannot change
       * between packages. Network failures are not cached. */
      const result = { supported, status: response.status };
      if (supported || response.status === 200 || response.status === 416) rangeSupportCache.set(target.origin, result);
      return result;
    } catch {
      return { supported: false };
    } finally {
      clearTimeout(timer);
      try { controller.abort(); } catch { /* ignore */ }
    }
  }

  /* Segmented ("packet") download.
   *
   * The tarball is cut into fixed-size byte ranges that a small pool of parallel
   * requests fetches. No total size is needed: the resource is finished when a
   * range comes back shorter than requested (or the next range is rejected with
   * 416). Ranges are retried and resumed from the last received byte, and bytes
   * reach the consumer strictly in order, so peak memory stays around
   * concurrency x segmentBytes no matter how large the package is. */
  async function downloadInSegments(url, options = {}) {
    const fetchImpl = options.fetch || (typeof fetch === 'function' ? fetch : null);
    if (!fetchImpl) throw new Error('fetch is unavailable');
    const origin = options.origin || 'https://registry.npmjs.org';
    const maxBytes = options.maxBytes || 96 * MIB;
    const idleTimeoutMs = options.idleTimeoutMs || 45000;
    const attempts = Math.max(1, options.attempts || 3);
    const segmentBytes = Math.min(32 * MIB, Math.max(256 * 1024, options.segmentBytes || 4 * MIB));
    const concurrency = Math.min(6, Math.max(1, options.concurrency || 3));
    const headers = { 'accept-encoding': 'identity', ...(options.headers || {}) };
    const target = registryTarget(url, origin);

    const probe = await probeRangeSupport(target, { fetch: fetchImpl, headers, idleTimeoutMs });
    if (!probe.supported) return { supported: false, status: probe.status };

    const controller = new AbortController();
    const onChunk = options.onChunk;
    let received = 0, delivered = 0;

    /* Returns { chunks, last } - `last` marks the range that ended the resource. */
    const fetchSegment = async index => {
      const start = index * segmentBytes;
      const end = start + segmentBytes - 1;
      const chunks = [];
      let cursor = start;
      let attempt = 0;
      for (;;) {
        attempt++;
        try {
          while (cursor <= end) {
            if (controller.signal.aborted) throw controller.signal.reason || new Error('Download aborted');
            const request = new AbortController();
            const forwardAbort = () => request.abort(controller.signal.reason || new Error('Download aborted'));
            if (controller.signal.aborted) forwardAbort(); else controller.signal.addEventListener('abort', forwardAbort, { once: true });
            let idle = null;
            const arm = () => {
              if (idle) clearTimeout(idle);
              idle = setTimeout(() => request.abort(new Error('Registry download stalled for ' + Math.round(idleTimeoutMs / 1000) + 's')), idleTimeoutMs);
            };
            try {
              arm();
              const response = await fetchImpl(target.href, {
                credentials: 'omit', redirect: 'error', signal: request.signal,
                headers: { ...headers, range: 'bytes=' + cursor + '-' + end }
              });
              if (response.status === 200) { try { await response.body?.cancel(); } catch { /* ignore */ } throw rangeUnsupportedError(); }
              if (response.status === 416) {
                try { await response.body?.cancel(); } catch { /* ignore */ }
                return { chunks, last: true };
              }
              if (response.status !== 206) throw new Error('Registry returned HTTP ' + response.status + ' for a ranged download');
              /* A shorter body than requested is how the last packet announces
               * itself, so only an oversized declaration is an error. */
              const requested = end - cursor + 1;
              const declared = Number(response.headers.get('content-length'));
              if (Number.isFinite(declared) && declared > requested) {
                try { await response.body?.cancel(); } catch { /* ignore */ }
                throw new Error('Registry returned ' + declared + ' bytes for a ' + requested + ' byte range of ' + target.pathname);
              }
              /* Only used when the server happens to expose it (same-origin or Node). */
              const contentRange = parseContentRange(response.headers.get('content-range'));
              if (contentRange && (contentRange.start !== cursor || contentRange.end > end)) {
                try { await response.body?.cancel(); } catch { /* ignore */ }
                throw new Error('Registry returned an unexpected byte range for ' + target.pathname);
              }
              if (!response.body) throw new Error('Registry response has no readable body');
              arm();
              const beforeRequest = cursor;
              const reader = response.body.getReader();
              for (;;) {
                const { value, done } = await reader.read();
                if (done) break;
                if (!value || value.length === 0) continue;
                if (cursor + value.length > end + 1) throw new Error('Registry sent more bytes than the requested range');
                chunks.push(value);
                cursor += value.length;
                received += value.length;
                if (received > maxBytes) throw new Error('Registry tarball exceeds the package download budget (' + maxBytes + ' bytes)');
                arm();
              }
              /* An empty 206 is how some CDNs answer a range past the end of the
               * object; a response with no progress must end the download rather
               * than spin on the same offset. */
              if (cursor === beforeRequest) return { chunks, last: true };
            } finally {
              if (idle) clearTimeout(idle);
              controller.signal.removeEventListener('abort', forwardAbort);
              try { request.abort(); } catch { /* ignore */ }
            }
          }
          return { chunks, last: false };
        } catch (error) {
          if (error && error.code === 'ERR_RANGE_UNSUPPORTED') throw error;
          if (controller.signal.aborted) throw controller.signal.reason || error;
          if (attempt >= attempts || !retryableError(error)) {
            error.message = String(error.message || error) + ' (range ' + start + '-' + end + ', packet ' + index + ')';
            throw error;
          }
          await sleep(Math.min(4000, 300 * attempt * attempt));
        }
      }
    };

    const window = new Map();
    let nextStart = 0, nextFlush = 0, ended = false;
    const startSegment = index => {
      const promise = fetchSegment(index);
      promise.catch(() => { /* surfaced through the ordered await below */ });
      window.set(index, promise);
      nextStart = index + 1;
    };
    try {
      for (let index = 0; index < concurrency; index++) startSegment(nextStart);
      while (!ended) {
        const result = await window.get(nextFlush);
        window.delete(nextFlush);
        for (const chunk of result.chunks) {
          delivered += chunk.length;
          if (onChunk) await onChunk(chunk, received, 0);
        }
        /* One progress event per packet: the total size is unknown to a
         * cross-origin browser fetch, so callers must treat `total` as 0. */
        if (options.onProgress) options.onProgress(received, 0);
        nextFlush++;
        if (result.last) { ended = true; break; }
        if (nextStart < nextFlush + concurrency) startSegment(nextStart);
      }
    } catch (error) {
      try { controller.abort(error); } catch { /* ignore */ }
      await Promise.allSettled([...window.values()]);
      throw error;
    }
    try { controller.abort(); } catch { /* ignore */ }
    await Promise.allSettled([...window.values()]);
    if (!delivered) throw new Error('Registry returned no data for ' + target.pathname);
    return { supported: true, bytes: delivered, segments: nextFlush, segBytes: segmentBytes };
  }

  async function downloadToConsumer(url, options = {}) {
    const segments = Number(options.segments || 0);
    if (segments >= 2) {
      try {
        const result = await downloadInSegments(url, { ...options, segments });
        if (result.supported) return result.bytes;
        if (options.onRangeFallback) options.onRangeFallback(rangeUnsupportedError());
      } catch (error) {
        if (!error || error.code !== 'ERR_RANGE_UNSUPPORTED') throw error;
        if (options.onRangeFallback) options.onRangeFallback(error);
      }
    }
    return streamOnce(url, options);
  }

  /* ------------------------------------------------------------------ *
   * Full package stream: download -> integrity -> gunzip -> untar -> sink
   * ------------------------------------------------------------------ */
  async function streamPackage(options) {
    const pako = options.pako;
    if (!pako || typeof pako.Inflate !== 'function') throw new Error('A gzip implementation is required');
    const limits = {
      tarballBytes: options.maxTarballBytes || 96 * MIB,
      expandedBytes: options.maxExpandedBytes || 192 * MIB,
      entryBytes: options.maxEntryBytes || 64 * MIB,
      entries: options.maxEntries || 20000
    };
    const integrity = parseIntegrity(options.integrity);
    if (!integrity) throw new Error('Package has no supported integrity hash. Refusing an unverified download');
    let hash = null;
    let parser = null;
    let inflate = null;
    let decompressed = 0;
    const resetPipeline = () => {
      hash = createSha512();
      decompressed = 0;
      parser = createTarParser({
        onEntry: options.onEntry,
        onEntryData: options.onEntryData,
        onEntryEnd: options.onEntryEnd,
        onDirectory: options.onDirectory,
        maxEntries: limits.entries,
        maxEntryBytes: limits.entryBytes,
        maxTotalBytes: limits.expandedBytes
      });
      inflate = new pako.Inflate({ chunkSize: 64 * 1024 });
      inflate.onData = chunk => {
        decompressed += chunk.length;
        if (decompressed > limits.expandedBytes) throw new Error('Package expands beyond the install budget');
        parser.push(chunk);
      };
    };
    resetPipeline();

    const received = await downloadToConsumer(options.tarball, {
      fetch: options.fetch,
      origin: options.origin,
      maxBytes: limits.tarballBytes,
      idleTimeoutMs: options.idleTimeoutMs,
      attempts: options.attempts,
      headers: options.headers,
      onProgress: options.onProgress,
      segments: options.segments,
      segmentBytes: options.segmentBytes,
      concurrency: options.concurrency,
      onRangeFallback: options.onRangeFallback,
      onReset: () => {
        resetPipeline();
        if (typeof options.onReset === 'function') options.onReset();
      },
      onChunk: chunk => { hash.update(chunk); inflate.push(chunk, false); }
    });
    inflate.push(new Uint8Array(0), true);
    if (inflate.err) throw new Error('Invalid gzip archive: ' + (inflate.msg || inflate.err));
    parser.end();

    const digest = hash.digestBase64();
    if (integrity.algorithm !== 'sha512') {
      throw new Error('Only sha512 registry integrity is supported in streaming mode (received ' + integrity.algorithm + ')');
    }
    if (!integrity.digests.includes(digest)) throw new Error('Integrity verification failed for ' + options.tarball);

    return { bytes: received, expandedBytes: decompressed, files: parser.files, integrity: 'sha512-' + digest };
  }

  return Object.freeze({
    MIB,
    toBytes,
    concatBytes,
    toHex,
    toBase64,
    fromBase64,
    createSha512,
    parseIntegrity,
    createTarParser,
    streamOnce,
    probeRangeSupport,
    resetRangeProbe: () => rangeSupportCache.clear(),
    downloadInSegments,
    downloadToConsumer,
    streamPackage,
    looksLikeText,
    safeRelativePath
  });
});
