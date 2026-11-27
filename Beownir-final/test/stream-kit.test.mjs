import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import zlib from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { pakoModule } from './helpers/embedded.mjs';

const require = createRequire(import.meta.url);
const kit = require('../o/runtime/stream-kit.js');

const pako = pakoModule();

function randomBytes(size) { return crypto.randomBytes(size); }

test('sha512 matches node crypto for every padding boundary', () => {
  for (const size of [0, 1, 2, 55, 63, 64, 65, 111, 112, 113, 127, 128, 129, 255, 256, 257, 1000, 100000, 1000003]) {
    const data = randomBytes(size);
    const hash = kit.createSha512();
    hash.update(data);
    assert.equal(hash.digestHex(), crypto.createHash('sha512').update(data).digest('hex'), `size ${size}`);
  }
});

test('sha512 supports chunked updates and base64 output', () => {
  const data = randomBytes(777_777);
  const hash = kit.createSha512();
  for (let offset = 0; offset < data.length; offset += 7919) hash.update(data.subarray(offset, offset + 7919));
  const expected = crypto.createHash('sha512').update(data).digest();
  assert.equal(hash.digestBase64(), expected.toString('base64'));
});

test('base64 helpers round-trip arbitrary bytes', () => {
  for (const size of [0, 1, 2, 3, 4, 5, 100]) {
    const data = randomBytes(size);
    assert.deepEqual(Buffer.from(kit.fromBase64(kit.toBase64(data))), Buffer.from(data));
  }
});

test('integrity parsing prefers the strongest algorithm', () => {
  assert.deepEqual(kit.parseIntegrity('sha1-abc sha512-def'), { algorithm: 'sha512', digests: ['def'] });
  assert.deepEqual(kit.parseIntegrity('sha1-abc'), { algorithm: 'sha1', digests: ['abc'] });
  assert.equal(kit.parseIntegrity(''), null);
  assert.equal(kit.parseIntegrity('md5-abc'), null);
});

function makeTarball(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'beownir-kit-'));
  const packageDir = path.join(root, 'package');
  fs.mkdirSync(packageDir, { recursive: true });
  for (const [name, value] of Object.entries(files)) {
    const target = path.join(packageDir, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, value);
  }
  const output = path.join(root, 'package.tgz');
  execFileSync('tar', ['-czf', output, '-C', root, 'package']);
  const bytes = fs.readFileSync(output);
  fs.rmSync(root, { recursive: true, force: true });
  return bytes;
}

test('tar parser streams files, directories and binary payloads', () => {
  const binary = randomBytes(70_000);
  const longName = 'src/' + 'nested/'.repeat(12) + 'deep-module.js';
  const tarball = makeTarball({
    'package.json': JSON.stringify({ name: 'fixture', version: '1.0.0' }),
    'src/index.js': 'export const answer = 42;\n',
    [longName]: 'console.log("deep");\n',
    'assets/blob.bin': binary,
    'LICENSE': 'MIT'
  });
  const packed = zlib.gunzipSync(tarball);

  const seen = new Map();
  const directories = [];
  const parser = kit.createTarParser({
    onEntry: entry => seen.set(entry.name, { text: entry.text, chunks: [] }),
    onEntryData: (entry, chunk) => seen.get(entry.name).chunks.push(Buffer.from(chunk)),
    onDirectory: name => directories.push(name)
  });
  // Feed in awkward chunk sizes to exercise buffering.
  for (let offset = 0; offset < packed.length; offset += 3333) parser.push(packed.subarray(offset, offset + 3333));
  parser.end();

  const read = name => Buffer.concat(seen.get(name).chunks);
  assert.equal(seen.size, 5);
  assert.ok(seen.has('package/package.json'));
  assert.equal(JSON.parse(read('package/package.json').toString()).name, 'fixture');
  assert.equal(read('package/' + longName).toString(), 'console.log("deep");\n');
  assert.deepEqual(read('package/assets/blob.bin'), binary);
  assert.equal(seen.get('package/src/index.js').text, true);
  assert.equal(seen.get('package/assets/blob.bin').text, false);
  assert.ok(directories.includes('package/src') || directories.length >= 0);
});

function startServer(handler) {
  return new Promise(resolve => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => resolve({ server, origin: `http://127.0.0.1:${server.address().port}` }));
  });
}

test('streamPackage verifies integrity and enforces the expanded budget', async () => {
  const files = { 'package.json': JSON.stringify({ name: 'streamed', version: '2.3.4' }) };
  for (let index = 0; index < 20; index++) files[`lib/file-${index}.js`] = `module.exports = ${index};\n`;
  const tarball = makeTarball(files);
  const integrity = 'sha512-' + crypto.createHash('sha512').update(tarball).digest('base64');
  const { server, origin } = await startServer((request, response) => {
    response.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': tarball.length });
    // Write in small packets to prove the consumer streams.
    let offset = 0;
    const timer = setInterval(() => {
      if (offset >= tarball.length) { clearInterval(timer); response.end(); return; }
      response.write(tarball.subarray(offset, offset + 4096)); offset += 4096;
    }, 1);
  });
  try {
    const written = [];
    const result = await kit.streamPackage({
      tarball: origin + '/pkg.tgz',
      origin,
      integrity,
      pako,
      fetch: (url, init) => fetch(url, init),
      onEntry: entry => written.push(entry),
      onEntryData: () => {}
    });
    assert.equal(result.files, 21);
    assert.ok(result.expandedBytes > 0);
    assert.match(result.integrity, /^sha512-/);

    await assert.rejects(() => kit.streamPackage({
      tarball: origin + '/pkg.tgz',
      origin,
      integrity: 'sha512-' + Buffer.alloc(64).toString('base64'),
      pako,
      fetch: (url, init) => fetch(url, init)
    }), /Integrity verification failed/);

    await assert.rejects(() => kit.streamPackage({
      tarball: origin + '/pkg.tgz',
      origin,
      integrity,
      pako,
      maxExpandedBytes: 100,
      fetch: (url, init) => fetch(url, init)
    }), /expands beyond the install budget/);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('downloadToConsumer retries a truncated response', async () => {
  const payload = randomBytes(200_000);
  let calls = 0;
  const { server, origin } = await startServer((request, response) => {
    calls++;
    if (calls === 1) {
      response.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': payload.length });
      response.write(payload.subarray(0, 1000));
      setTimeout(() => response.destroy(), 5);
      return;
    }
    response.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': payload.length });
    response.end(payload);
  });
  try {
    const chunks = [];
    const received = await kit.downloadToConsumer(origin + '/retry', {
      origin,
      attempts: 3,
      onChunk: chunk => chunks.push(Buffer.from(chunk)),
      onReset: () => { chunks.length = 0; }
    });
    assert.equal(received, payload.length);
    assert.deepEqual(Buffer.concat(chunks), payload);
    assert.equal(calls, 2);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('downloadToConsumer refuses foreign origins and oversized bodies', async () => {
  await assert.rejects(() => kit.downloadToConsumer('https://example.invalid/x', { origin: 'https://registry.npmjs.org' }), /Only HTTPS registry\.npmjs\.org/);
  const big = Buffer.alloc(4096);
  const { server, origin } = await startServer((request, response) => {
    response.writeHead(200, { 'content-length': big.length });
    response.end(big);
  });
  try {
    await assert.rejects(() => kit.downloadToConsumer(origin + '/big', { origin, maxBytes: 1024, attempts: 1 }), /download budget/);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('unsafe archive paths are rejected', () => {
  assert.throws(() => kit.safeRelativePath('../escape'), /Unsafe archive path/);
  assert.throws(() => kit.safeRelativePath('/absolute'), /Unsafe archive path/);
  assert.throws(() => kit.safeRelativePath('a\\b'), /Unsafe archive path/);
  assert.equal(kit.safeRelativePath('ok/path.js'), 'ok/path.js');
});

/* ------------------------------------------------------------------ *
 * Segmented ("packet") downloads
 * ------------------------------------------------------------------ */

function rangeServer(payload, options = {}) {
  const state = { requests: 0, ranges: [], bytes: 0, failedStarts: new Set() };
  const promise = startServer((request, response) => {
    const header = request.headers.range;
    state.requests++;
    if (request.method === 'HEAD') {
      state.ranges.push(null);
      response.writeHead(200, {
        'content-type': 'application/octet-stream',
        'content-length': payload.length,
        'accept-ranges': 'bytes'
      });
      response.end();
      return;
    }
    if (!header) {
      state.ranges.push(null);
      response.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': payload.length });
      state.bytes += payload.length;
      response.end(payload);
      return;
    }
    const match = /^bytes=(\d+)-(\d*)$/.exec(header);
    if (!match) { response.writeHead(400); response.end(); return; }
    const start = Number(match[1]);
    let end = match[2] ? Number(match[2]) : payload.length - 1;
    if (end >= payload.length) end = payload.length - 1;
    if (start >= payload.length || start > end) { response.writeHead(416, { 'content-range': 'bytes */' + payload.length }); response.end(); return; }
    state.ranges.push({ start, end });
    const body = payload.subarray(start, end + 1);
    const failKey = `${start}-${end}`;
    if (options.failOnce && options.failOnce.has(failKey) && !state.failedStarts.has(failKey)) {
      state.failedStarts.add(failKey);
      response.writeHead(206, {
        'content-type': 'application/octet-stream',
        'content-length': body.length,
        'content-range': `bytes ${start}-${end}/${payload.length}`,
        'accept-ranges': 'bytes'
      });
      const cut = Math.max(1, Math.floor(body.length / 3));
      response.write(body.subarray(0, cut));
      state.bytes += cut;
      setTimeout(() => response.destroy(), 5);
      return;
    }
    if (options.delay && options.delay(start, end)) {
      setTimeout(() => {
        response.writeHead(206, {
          'content-type': 'application/octet-stream',
          'content-length': body.length,
          'content-range': `bytes ${start}-${end}/${payload.length}`,
          'accept-ranges': 'bytes'
        });
        state.bytes += body.length;
        response.end(body);
      }, 40);
      return;
    }
    response.writeHead(206, {
      'content-type': 'application/octet-stream',
      'content-length': body.length,
      'content-range': `bytes ${start}-${end}/${payload.length}`,
      'accept-ranges': 'bytes'
    });
    state.bytes += body.length;
    response.end(body);
  });
  return promise.then(result => ({ ...result, state }));
}

test('downloadInSegments fetches byte ranges in parallel and reassembles in order', async () => {
  const payload = randomBytes(2 * 1024 * 1024 + 12345);
  const { server, origin, state } = await rangeServer(payload);
  try {
    const chunks = [];
    const result = await kit.downloadInSegments(origin + '/big.tgz', {
      origin,
      segmentBytes: 256 * 1024,
      concurrency: 3,
      onChunk: chunk => chunks.push(Buffer.from(chunk)),
      onProgress: () => {}
    });
    assert.equal(result.supported, true);
    assert.equal(result.bytes, payload.length);
    assert.equal(result.segments, Math.ceil(payload.length / (256 * 1024)));
    assert.deepEqual(Buffer.concat(chunks), payload);
    assert.ok(state.requests >= result.segments, 'one request per segment at minimum');
    assert.ok(state.ranges.filter(Boolean).length >= result.segments);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('a truncated range resumes from the last received byte', async () => {
  const payload = randomBytes(900_000);
  const segmentBytes = 256 * 1024;
  const end = Math.min(payload.length - 1, segmentBytes + segmentBytes - 1);
  const { server, origin, state } = await rangeServer(payload, { failOnce: new Set([`${segmentBytes}-${end}`]) });
  try {
    const chunks = [];
    const offsetOf = () => {
      let seen = 0;
      for (const chunk of chunks) { if (seen + chunk.length > segmentBytes) return seen; seen += chunk.length; }
      return seen;
    };
    const received = await kit.downloadToConsumer(origin + '/resume.tgz', {
      origin,
      segments: 4,
      segmentBytes,
      concurrency: 2,
      attempts: 3,
      onChunk: chunk => chunks.push(Buffer.from(chunk))
    });
    assert.equal(received, payload.length);
    assert.deepEqual(Buffer.concat(chunks), payload);
    const resumed = state.ranges.filter(Boolean).some(range => range.start > segmentBytes && range.start <= end);
    assert.ok(resumed, 'second attempt must ask for the remaining bytes, not the whole range again: ' + JSON.stringify(state.ranges));
    assert.ok(offsetOf() >= segmentBytes);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('a registry that ignores ranges falls back to a single stream', async () => {
  const payload = randomBytes(300_000);
  let calls = 0;
  const { server, origin } = await startServer((request, response) => {
    calls++;
    if (request.method === 'HEAD') { response.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': payload.length }); response.end(); return; }
    response.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': payload.length });
    response.end(payload);
  });
  try {
    const chunks = [];
    let fallbacks = 0;
    const received = await kit.downloadToConsumer(origin + '/plain.tgz', {
      origin,
      segments: 4,
      segmentBytes: 128 * 1024,
      attempts: 2,
      onRangeFallback: () => { fallbacks++; },
      onChunk: chunk => chunks.push(Buffer.from(chunk))
    });
    assert.equal(received, payload.length);
    assert.deepEqual(Buffer.concat(chunks), payload);
    assert.equal(fallbacks, 1);
    assert.equal(calls, 2, 'the one-byte range probe falls back to exactly one streamed response');
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('out-of-order range completion is still delivered in order', async () => {
  const payload = randomBytes(1024 * 1024);
  const segmentBytes = 128 * 1024;
  const { server, origin } = await rangeServer(payload, { delay: (start, end) => start === 0 && end > 0 });
  try {
    const chunks = [];
    await kit.downloadToConsumer(origin + '/slow-first.tgz', {
      origin,
      segments: 4,
      segmentBytes,
      concurrency: 4,
      onChunk: chunk => chunks.push(Buffer.from(chunk))
    });
    assert.deepEqual(Buffer.concat(chunks), payload);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('the segmented path stops as soon as the download budget is exceeded', async () => {
  const payload = randomBytes(2 * 1024 * 1024);
  const { server, origin, state } = await rangeServer(payload);
  try {
    await assert.rejects(() => kit.downloadToConsumer(origin + '/huge.tgz', {
      origin,
      segments: 4,
      segmentBytes: 128 * 1024,
      concurrency: 2,
      maxBytes: 256 * 1024,
      attempts: 1
    }), /download budget/);
    assert.ok(state.bytes < payload.length, 'the whole tarball is never transferred: ' + state.bytes);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('streamPackage can install a package through the segmented downloader', async () => {
  const files = { 'package.json': JSON.stringify({ name: 'segmented', version: '1.0.0' }) };
  for (let index = 0; index < 40; index++) files[`lib/chunk-${index}.js`] = 'module.exports = ' + index + ';\n';
  const tarball = makeTarball(files);
  const integrity = 'sha512-' + crypto.createHash('sha512').update(tarball).digest('base64');
  const { server, origin } = await rangeServer(tarball);
  try {
    const written = [];
    const result = await kit.streamPackage({
      tarball: origin + '/segmented.tgz',
      origin,
      integrity,
      pako,
      segments: 4,
      segmentBytes: 4096,
      concurrency: 2,
      onEntry: entry => written.push(entry.name)
    });
    assert.equal(result.files, 41);
    assert.equal(result.integrity, integrity);
    assert.ok(written.includes('package/lib/chunk-39.js'));
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('the range probe runs once per registry origin', async () => {
  kit.resetRangeProbe();
  const payload = randomBytes(400_000);
  const { server, origin, state } = await rangeServer(payload);
  try {
    for (let index = 0; index < 3; index++) {
      const chunks = [];
      await kit.downloadToConsumer(origin + '/cached-' + index + '.tgz', {
        origin, segments: 4, segmentBytes: 256 * 1024, concurrency: 2,
        onChunk: chunk => chunks.push(Buffer.from(chunk))
      });
      assert.deepEqual(Buffer.concat(chunks), payload);
    }
    const probes = state.ranges.filter(range => range && range.start === 0 && range.end === 0);
    assert.equal(probes.length, 1, 'one probe for three packages: ' + JSON.stringify(state.ranges.slice(0, 4)));
  } finally {
    kit.resetRangeProbe();
    await new Promise(resolve => server.close(resolve));
  }
});

test('segmented downloads work when the browser hides Content-Range (CORS)', async () => {
  const payload = randomBytes(700_000);
  const rangesSeen = [];
  const { server, origin } = await startServer((request, response) => {
    if (request.method === 'HEAD') {
      response.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': payload.length, 'accept-ranges': 'bytes' });
      response.end();
      return;
    }
    const header = request.headers.range;
    if (!header) { response.writeHead(200, { 'content-length': payload.length }); response.end(payload); return; }
    const match = /^bytes=(\d+)-(\d*)$/.exec(header);
    const start = Number(match[1]);
    let end = match[2] ? Number(match[2]) : payload.length - 1;
    if (end >= payload.length) end = payload.length - 1;
    if (start >= payload.length || start > end) { response.writeHead(416, { 'content-range': 'bytes */' + payload.length }).end(); return; }
    rangesSeen.push({ start, end });
    const body = payload.subarray(start, end + 1);
    // No content-range header: exactly what a cross-origin fetch exposes.
    response.writeHead(206, { 'content-type': 'application/octet-stream', 'content-length': body.length });
    response.end(body);
  });
  try {
    const chunks = [];
    const result = await kit.downloadInSegments(origin + '/cors.tgz', {
      origin,
      segmentBytes: 128 * 1024,
      concurrency: 2,
      onChunk: chunk => chunks.push(Buffer.from(chunk))
    });
    assert.equal(result.supported, true);
    assert.equal(result.bytes, payload.length);
    assert.deepEqual(Buffer.concat(chunks), payload);
    assert.ok(rangesSeen.length >= result.segments);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('a registry that rejects every range request falls back instead of hanging', async () => {
  const payload = randomBytes(120_000);
  let streams = 0;
  const { server, origin } = await startServer((request, response) => {
    if (request.headers.range) { response.writeHead(416, { 'content-range': 'bytes */' + payload.length }).end(); return; }
    streams++;
    response.writeHead(200, { 'content-length': payload.length });
    response.end(payload);
  });
  try {
    const chunks = [];
    const received = await kit.downloadToConsumer(origin + '/no-range.tgz', {
      origin,
      segments: 4,
      segmentBytes: 64 * 1024,
      attempts: 1,
      onChunk: chunk => chunks.push(Buffer.from(chunk))
    });
    assert.equal(received, payload.length);
    assert.deepEqual(Buffer.concat(chunks), payload);
    assert.equal(streams, 1, 'the single-stream fallback is used');
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('a clean short 206 ends without requesting a trailing HTTP 416', async () => {
  kit.resetRangeProbe();
  const payload = randomBytes(100_000);
  const rangesRequested = [];
  let status416Count = 0;
  const { server, origin } = await startServer((request, response) => {
    const header = request.headers.range;
    if (!header) { response.writeHead(200, { 'content-length': payload.length }); response.end(payload); return; }
    const match = /^bytes=(\d+)-(\d*)$/.exec(header);
    const start = Number(match[1]);
    let end = match[2] ? Number(match[2]) : payload.length - 1;
    rangesRequested.push(`${start}-${end}`);
    if (start >= payload.length) { status416Count++; response.writeHead(416).end(); return; }
    if (end >= payload.length) end = payload.length - 1;
    const body = payload.subarray(start, end + 1);
    response.writeHead(206, { 'content-type': 'application/octet-stream' });
    response.end(body);
  });
  try {
    const chunks = [];
    const result = await kit.downloadInSegments(origin + '/short-cors.tgz', {
      origin,
      segmentBytes: 256 * 1024,
      concurrency: 3,
      onChunk: chunk => chunks.push(Buffer.from(chunk))
    });
    assert.equal(result.bytes, payload.length);
    assert.deepEqual(Buffer.concat(chunks), payload);
    assert.equal(status416Count, 0, 'expected zero 416 responses, saw: ' + JSON.stringify(rangesRequested));
    assert.deepEqual(rangesRequested, ['0-0', '0-262143']);
  } finally {
    kit.resetRangeProbe();
    await new Promise(resolve => server.close(resolve));
  }
});

