import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { loadRuntime } from './helpers/runtime.mjs';

/* Guards the Node compatibility surface that bundlers, npm and frameworks
 * touch: filesystem helpers, web streams, crypto, readline and dns promises. */

const rt = loadRuntime();
const fs = rt.CORE.fs;

async function withScratch(fn) {
  rt.restore();
  await rt.run('mkdir -p /project/scratch');
  try { await fn(); } finally { rt.restore(); }
}

test('fs exposes the copy, temp and metadata helpers packages call', () => withScratch(async () => {
  const write = (path, text) => rt.evaluate(`FS[${JSON.stringify(path)}] = { c: ${JSON.stringify(text)}, m: Date.now() }`);
  write('/project/scratch/a.txt', 'alpha');

  fs.copyFileSync('/project/scratch/a.txt', '/project/scratch/b.txt');
  assert.equal(fs.readFileSync('/project/scratch/b.txt', 'utf8'), 'alpha');

  fs.mkdirSync('/project/scratch/tree/nested', { recursive: true });
  write('/project/scratch/tree/nested/deep.txt', 'deep');
  fs.cpSync('/project/scratch/tree', '/project/scratch/copy', { recursive: true });
  assert.equal(fs.readFileSync('/project/scratch/copy/nested/deep.txt', 'utf8'), 'deep');

  await fs.promises.cp('/project/scratch/tree', '/project/scratch/copy2', { recursive: true });
  assert.equal(fs.readFileSync('/project/scratch/copy2/nested/deep.txt', 'utf8'), 'deep');

  const directory = fs.mkdtempSync('/project/scratch/tmp-');
  assert.ok(directory.startsWith('/project/scratch/tmp-'));
  assert.equal(fs.statSync(directory).isDirectory(), true);
  const promised = await fs.promises.mkdtemp('/project/scratch/promise-');
  assert.equal(fs.statSync(promised).isDirectory(), true);

  fs.chmodSync('/project/scratch/a.txt', 0o600);
  assert.equal(rt.FS['/project/scratch/a.txt'].mode, 0o600);
  fs.utimesSync('/project/scratch/a.txt', new Date(0), new Date(1_000_000));
  assert.equal(rt.FS['/project/scratch/a.txt'].m, 1_000_000);
  fs.truncateSync('/project/scratch/a.txt', 2);
  assert.equal(fs.readFileSync('/project/scratch/a.txt', 'utf8'), 'al');
  assert.ok(fs.statfsSync().blocks > 0);
}));

test('fs links and directory handles behave well enough for .bin shims', () => withScratch(async () => {
  rt.evaluate("FS['/project/scratch/tool.js'] = { c: '#!/usr/bin/env node\\n', m: Date.now() }");
  fs.symlinkSync('tool.js', '/project/scratch/link.js');
  assert.equal(fs.readlinkSync('/project/scratch/link.js'), 'tool.js');
  assert.equal(fs.readFileSync('/project/scratch/link.js', 'utf8'), '#!/usr/bin/env node\n');
  fs.linkSync('/project/scratch/tool.js', '/project/scratch/hard.js');
  assert.equal(fs.readFileSync('/project/scratch/hard.js', 'utf8'), '#!/usr/bin/env node\n');

  const directory = fs.opendirSync('/project/scratch');
  const names = [];
  for (let entry = directory.readSync(); entry; entry = directory.readSync()) names.push(entry.name);
  assert.ok(names.includes('tool.js'));
  assert.ok(names.includes('link.js'));
  assert.equal(typeof directory.closeSync, 'function');
}));

test('stream/web re-exports the browser stream classes', () => {
  const web = rt.CORE['stream/web'];
  assert.equal(web.ReadableStream, ReadableStream);
  assert.equal(web.WritableStream, WritableStream);
  assert.equal(web.TransformStream, TransformStream);
  assert.equal(web.CompressionStream, CompressionStream);
  assert.equal(rt.STREAM.web.ReadableStream, ReadableStream);
});

test('crypto covers randomness, kdf and honest failures for signing', () => {
  const local = rt.CORE.crypto;
  assert.equal(local.randomInt(5, 6), 5);
  const filled = new Uint8Array(8);
  local.randomFillSync(filled);
  assert.ok(filled.some(byte => byte !== 0));

  const expected = crypto.pbkdf2Sync('password', 'salt', 1000, 32, 'sha256').toString('hex');
  assert.equal(local.pbkdf2Sync('password', 'salt', 1000, 32, 'sha256').toString('hex'), expected);
  const expectedHkdf = Buffer.from(crypto.hkdfSync('sha256', 'key', 'salt', 'info', 32)).toString('hex');
  assert.equal(Buffer.from(local.hkdfSync('sha256', 'key', 'salt', 'info', 32)).toString('hex'), expectedHkdf);
  assert.ok(local.getHashes().includes('sha256'));
  assert.ok(local.getCiphers().length > 0);
  assert.equal(typeof local.constants, 'object');

  assert.equal(local.createHash('sha256').update('x').digest('hex'), crypto.createHash('sha256').update('x').digest('hex'));
  // RSA signing and encryption are implemented in test/crypto-asymmetric.test.mjs;
  // what still needs OpenSSL must say so instead of faking it.
  for (const name of ['generateKeyPairSync', 'generateKeyPair']) {
    assert.throws(() => local[name](), error => error.code === 'ERR_CRYPTO_OPERATION_FAILED', name + ' fails predictably');
  }
  // ECDH is implemented for the NIST prime curves; the agreement itself is
  // checked against OpenSSL in test/crypto.test.mjs.
  assert.equal(typeof local.createECDH, 'function');
  const ecdh = local.createECDH('prime256v1');
  assert.ok(ecdh.generateKeys().length > 0);
  assert.throws(() => local.createECDH('nope'), error => error.code === 'ERR_CRYPTO_INVALID_CURVE');
  // scrypt is implemented in-house (RFC 7914 vectors live in crypto.test.mjs).
  assert.equal(local.scryptSync('p', 's', 16, { N: 16, r: 1, p: 1 }).toString('hex'), crypto.scryptSync('p', 's', 16, { N: 16, r: 1, p: 1 }).toString('hex'));
  assert.equal(typeof local.createSign, 'function');
  assert.equal(typeof local.createVerify, 'function');
  assert.equal(typeof local.createPrivateKey, 'function');
  assert.equal(typeof local.createPublicKey, 'function');
  // Symmetric ciphers are implemented in-house; test/crypto.test.mjs checks them
  // against OpenSSL byte for byte, so here only the surface matters.
  assert.equal(typeof local.createCipheriv, 'function');
  assert.equal(typeof local.createDecipheriv, 'function');
});

test('readline/promises, dns/promises and util extras are present', async () => {
  const rl = rt.CORE['readline/promises'];
  assert.equal(typeof rl.createInterface, 'function');
  const iface = rl.createInterface({ input: {}, output: {} });
  assert.equal(typeof iface.question, 'function');
  assert.equal(typeof iface.close, 'function');

  const dns = rt.CORE['dns/promises'];
  // The test sandbox has no network, so lookup reports a resolver failure rather
  // than pretending to have an address (test/dns.test.mjs covers the success path).
  await assert.rejects(dns.lookup('example.com'), error => ['ENOTSUP', 'EAI_AGAIN', 'ENOTFOUND'].includes(error.code));

  assert.equal(typeof rt.CORE.util.aborted, 'function');
  assert.equal(typeof rt.CORE.util.setTraceSigIntHandler, 'function');
  assert.equal(typeof rt.CORE.util.transferableAbortController, 'function');
  assert.equal(typeof rt.CORE['stream/promises'].pipeline, 'function');
  assert.ok(rt.CORE.worker_threads, 'worker_threads keeps its compatibility surface');
});
