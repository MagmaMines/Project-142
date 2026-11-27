import test from 'node:test';
import assert from 'node:assert/strict';
import nodeCrypto from 'node:crypto';
import { loadRuntime } from './helpers/runtime.mjs';

/* node:crypto is one of the biggest compatibility surfaces, so this suite uses
 * the host's real OpenSSL implementation as the oracle: every cipher, digest,
 * HMAC, prime and Diffie-Hellman result below is compared byte-for-byte with
 * what Node 22 produces for the same inputs. */

const rt = loadRuntime();
const CRYPTO = rt.CRYPTO;
// The runtime has its own Buffer realm, so normalise everything to hex text.
const hex = value => Buffer.from(value).toString('hex');
const text = value => Buffer.from(value).toString('utf8');
const isBuffer = value => rt.evaluate(`value => Buffer.isBuffer(value)`)(value);

const vectors = [
  { algorithm: 'aes-256-cbc', key: Buffer.alloc(32, 1), iv: Buffer.alloc(16, 2) },
  { algorithm: 'aes-128-cbc', key: Buffer.alloc(16, 7), iv: Buffer.alloc(16, 9) },
  { algorithm: 'aes-192-ecb', key: Buffer.alloc(24, 3) },
  { algorithm: 'aes-256-ecb', key: Buffer.alloc(32, 5) },
  { algorithm: 'aes-128-ctr', key: Buffer.alloc(16, 4), iv: Buffer.alloc(16, 6) },
  { algorithm: 'aes-256-ctr', key: Buffer.alloc(32, 8), iv: Buffer.alloc(16, 1) },
  { algorithm: 'aes-128-cfb', key: Buffer.alloc(16, 2), iv: Buffer.alloc(16, 3) },
  { algorithm: 'aes-256-ofb', key: Buffer.alloc(32, 9), iv: Buffer.alloc(16, 4) },
];
const payloads = ['beownir production grade', '', 'x', 'sixteen-byte-msg', 'a'.repeat(64), 'b'.repeat(1000)];

test('AES ciphers match OpenSSL exactly for every mode, key size and length', () => {
  for (const { algorithm, key, iv } of vectors) {
    for (const payload of payloads) {
      const reference = nodeCrypto.createCipheriv(algorithm, key, iv ?? null);
      const expected = hex(Buffer.concat([reference.update(payload), reference.final()]));
      const ours = CRYPTO.createCipheriv(algorithm, key, iv ?? null);
      const actual = hex(Buffer.concat([ours.update(payload), ours.final()]));
      assert.equal(actual, expected, algorithm + ' length ' + payload.length);
      const decipher = CRYPTO.createDecipheriv(algorithm, key, iv ?? null);
      const back = Buffer.concat([decipher.update(Buffer.from(expected, 'hex')), decipher.final()]);
      assert.equal(text(back), payload, algorithm + ' round trip');
    }
  }
});

test('the AES block core matches the FIPS-197 vector', () => {
  const ecb = CRYPTO.createCipheriv('aes-128-ecb', Buffer.alloc(16), null);
  ecb.setAutoPadding(false);
  assert.equal(hex(Buffer.concat([ecb.update(Buffer.alloc(16)), ecb.final()])), '66e94bd4ef8a2c3b884cfa59ca342b2e');
});

test('AES-GCM produces the same ciphertext, tag and AAD handling as OpenSSL', () => {
  // The canonical NIST vector: all-zero key, all-zero IV, 16 zero bytes.
  const nist = CRYPTO.createCipheriv('aes-128-gcm', Buffer.alloc(16), Buffer.alloc(12));
  const nistCipher = Buffer.concat([nist.update(Buffer.alloc(16)), nist.final()]);
  assert.equal(hex(nistCipher), '0388dace60b6a392f328c2b971b2fe78');
  assert.equal(hex(nist.getAuthTag()), 'ab6e47d42cec13bdf53a67b21257bddf');

  for (const bits of [128, 192, 256]) {
    const algorithm = 'aes-' + bits + '-gcm';
    const key = Buffer.alloc(bits / 8, 0x11);
    const iv = Buffer.alloc(12, 0x03);
    for (const aad of ['', 'hdr', 'additional authenticated data']) {
      const reference = nodeCrypto.createCipheriv(algorithm, key, iv);
      if (aad) reference.setAAD(Buffer.from(aad));
      const expected = hex(Buffer.concat([reference.update('beownir production grade'), reference.final()]));
      const expectedTag = hex(reference.getAuthTag());

      const ours = CRYPTO.createCipheriv(algorithm, key, iv);
      if (aad) ours.setAAD(Buffer.from(aad));
      const actual = Buffer.concat([ours.update('beownir production grade'), ours.final()]);
      assert.equal(hex(actual), expected, algorithm + ' ciphertext');
      assert.equal(hex(ours.getAuthTag()), expectedTag, algorithm + ' tag');

      const decipher = CRYPTO.createDecipheriv(algorithm, key, iv);
      if (aad) decipher.setAAD(Buffer.from(aad));
      decipher.setAuthTag(Buffer.from(expectedTag, 'hex'));
      assert.equal(text(Buffer.concat([decipher.update(actual), decipher.final()])), 'beownir production grade');

      const tampered = CRYPTO.createDecipheriv(algorithm, key, iv);
      if (aad) tampered.setAAD(Buffer.from(aad));
      tampered.setAuthTag(Buffer.from(expectedTag, 'hex'));
      const corrupt = Buffer.from(actual); corrupt[0] ^= 0xff;
      tampered.update(corrupt);
      assert.throws(() => tampered.final(), error => error.code === 'ERR_OSSL_BAD_DECRYPT');
    }
  }
});

test('createCipheriv streams like Node and rejects invalid keys and IVs', () => {
  const key = Buffer.alloc(32, 1), iv = Buffer.alloc(16, 2);
  const cipher = CRYPTO.createCipheriv('aes-256-cbc', key, iv);
  const first = cipher.update('beownir ');
  const second = cipher.update('production grade');
  const tail = cipher.final();
  assert.equal(Buffer.from(first).length, 0, 'CBC with PKCS#7 padding holds the partial block, like OpenSSL');
  const reference = nodeCrypto.createCipheriv('aes-256-cbc', key, iv);
  assert.equal(hex(Buffer.concat([first, second, tail])), hex(Buffer.concat([reference.update('beownir production grade'), reference.final()])));

  // A string output encoding has to work for update() and final() too.
  const textCipher = CRYPTO.createCipheriv('aes-256-cbc', key, iv);
  const textOut = textCipher.update('beownir production grade', 'utf8', 'base64') + textCipher.final('base64');
  const referenceBase64 = nodeCrypto.createCipheriv('aes-256-cbc', key, iv);
  const expectedBase64 = referenceBase64.update('beownir production grade', 'utf8', 'base64') + referenceBase64.final('base64');
  assert.equal(textOut, expectedBase64);

  // GCM streams its ciphertext out of update(), one byte at a time if asked.
  for (const size of [5, 16, 24, 40]) {
    const payload = Buffer.alloc(size, 'q');
    const half = Math.ceil(size / 2);
    const gcmKey = Buffer.alloc(32, 7), gcmIv = Buffer.alloc(12, 9);
    const oursStream = CRYPTO.createCipheriv('aes-256-gcm', gcmKey, gcmIv);
    const oursChunks = [half, size - half].map((length, index) => Buffer.from(oursStream.update(payload.subarray(index ? half : 0, index ? size : half))));
    oursChunks.push(Buffer.from(oursStream.final()));
    const referenceStream = nodeCrypto.createCipheriv('aes-256-gcm', gcmKey, gcmIv);
    const referenceChunks = [half, size - half].map((length, index) => referenceStream.update(payload.subarray(index ? half : 0, index ? size : half)));
    referenceChunks.push(referenceStream.final());
    assert.deepEqual(oursChunks.map(part => part.toString('hex')), referenceChunks.map(part => part.toString('hex')), 'GCM chunking for ' + size);
    assert.equal(hex(oursStream.getAuthTag()), referenceStream.getAuthTag().toString('hex'), 'GCM streamed tag for ' + size);
  }

  assert.throws(() => CRYPTO.createCipheriv('aes-256-cbc', Buffer.alloc(31), Buffer.alloc(16)), error => error.code === 'ERR_CRYPTO_INVALID_KEYLEN');
  assert.throws(() => CRYPTO.createCipheriv('aes-256-cbc', Buffer.alloc(32), Buffer.alloc(8)), error => error.code === 'ERR_CRYPTO_INVALID_IV');
  assert.throws(() => CRYPTO.createCipheriv('des-ede3', Buffer.alloc(24), Buffer.alloc(8)), error => error.code === 'ERR_CRYPTO_UNKNOWN_CIPHER');

  const unpadded = CRYPTO.createCipheriv('aes-128-ecb', Buffer.alloc(16, 3), null, { padding: false });
  const referenceNoPadding = nodeCrypto.createCipheriv('aes-128-ecb', Buffer.alloc(16, 3), null);
  referenceNoPadding.setAutoPadding(false);
  assert.equal(hex(Buffer.concat([unpadded.update('a'.repeat(16)), unpadded.final()])), hex(Buffer.concat([referenceNoPadding.update('a'.repeat(16)), referenceNoPadding.final()])));

  // A corrupted final padding block must fail instead of returning junk.
  const decrypted = CRYPTO.createDecipheriv('aes-128-ecb', Buffer.alloc(16, 3), null);
  decrypted.update(Buffer.from('00'.repeat(16), 'hex'));
  assert.throws(() => decrypted.final(), error => error.code === 'ERR_OSSL_BAD_DECRYPT');
  assert.equal(CRYPTO.getCiphers().includes('aes-256-gcm'), true);
});

test('Hash and Hmac are real classes with copy(), streaming and write() support', () => {
  assert.equal(CRYPTO.createHash('sha256') instanceof CRYPTO.Hash, true, 'createHash returns a Hash');
  assert.equal(CRYPTO.createHmac('sha256', 'k') instanceof CRYPTO.Hmac, true, 'createHmac returns a Hmac');
  assert.equal(typeof CRYPTO.Hash, 'function');
  for (const algorithm of ['sha1', 'sha256', 'sha384', 'sha512', 'md5']) {
    const data = 'beownir production grade crypto';
    assert.equal(CRYPTO.createHash(algorithm).update(data).digest('hex'), nodeCrypto.createHash(algorithm).update(data).digest('hex'), algorithm);
    assert.equal(CRYPTO.createHash(algorithm).update(data).digest('base64'), nodeCrypto.createHash(algorithm).update(data).digest('base64'));
    assert.ok(isBuffer(CRYPTO.createHash(algorithm).update(data).digest()), algorithm + ' digest() without encoding is a Buffer');
  }
  // copy() must fork the state instead of consuming it.
  const base = CRYPTO.createHash('sha256').update('shared-');
  assert.equal(base.copy().update('left').digest('hex'), nodeCrypto.createHash('sha256').update('shared-left').digest('hex'));
  assert.equal(base.copy().update('right').digest('hex'), nodeCrypto.createHash('sha256').update('shared-right').digest('hex'));
  assert.equal(base.update('tail').digest('hex'), nodeCrypto.createHash('sha256').update('shared-tail').digest('hex'));
  assert.throws(() => base.digest(), error => error.code === 'ERR_CRYPTO_HASH_FINALIZED');

  // Stream writes feed the same accumulator, so piping into a hash works.
  const streamed = CRYPTO.createHash('sha256');
  streamed.write('beownir ');
  streamed.write('production grade crypto');
  streamed.end();
  assert.equal(streamed.digest('hex'), nodeCrypto.createHash('sha256').update('beownir production grade crypto').digest('hex'));

  for (const key of ['short', 'k'.repeat(64), Buffer.alloc(100, 7)]) {
    for (const algorithm of ['sha1', 'sha256', 'sha512']) {
      assert.equal(CRYPTO.createHmac(algorithm, key).update('payload').digest('hex'), nodeCrypto.createHmac(algorithm, key).update('payload').digest('hex'), algorithm + ' key ' + String(key).length);
    }
  }
  const hmac = CRYPTO.createHmac('sha256', 'k').update('split-');
  assert.equal(hmac.copy().update('one').digest('hex'), nodeCrypto.createHmac('sha256', 'k').update('split-one').digest('hex'));
  assert.equal(hmac.update('two').digest('hex'), nodeCrypto.createHmac('sha256', 'k').update('split-two').digest('hex'));
});

test('crypto.hash and crypto.hkdf follow the Node helpers', async () => {
  assert.equal(CRYPTO.hash('sha256', 'abc'), nodeCrypto.hash('sha256', 'abc'));
  assert.equal(CRYPTO.hash('sha256', 'abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.ok(isBuffer(CRYPTO.hash('sha256', 'abc', 'buffer')));
  assert.equal(hex(CRYPTO.hash('sha256', 'abc', 'buffer')), nodeCrypto.hash('sha256', 'abc', 'buffer').toString('hex'));
  assert.equal(CRYPTO.hash('sha256', 'abc', 'base64'), nodeCrypto.hash('sha256', 'abc', 'base64'));
  assert.equal(hex(CRYPTO.hash('sha512', 'abc', 'buffer')), nodeCrypto.hash('sha512', 'abc', 'buffer').toString('hex'));

  const reference = Buffer.from(nodeCrypto.hkdfSync('sha256', 'key', 'salt', 'info', 32)).toString('hex');
  assert.equal(hex(CRYPTO.hkdfSync('sha256', 'key', 'salt', 'info', 32)), reference);
  const derived = await new Promise((resolve, reject) => {
    CRYPTO.hkdf('sha256', 'key', 'salt', 'info', 32, (error, value) => (error ? reject(error) : resolve(value)));
  });
  assert.equal(hex(derived), reference);
});

test('prime helpers agree with OpenSSL modulo their randomness', async () => {
  for (const prime of ['0d', '11', '6b', '07', '1a', 'ac1f', 'fffffffb']) {
    assert.equal(CRYPTO.checkPrimeSync(Buffer.from(prime, 'hex')), nodeCrypto.checkPrimeSync(Buffer.from(prime, 'hex'), { checks: 24 }), 'prime ' + prime);
  }
  assert.equal(CRYPTO.checkPrimeSync(15n), false);
  assert.equal(CRYPTO.checkPrimeSync(13n), true);
  assert.equal(CRYPTO.checkPrimeSync(2n), true);
  assert.equal(CRYPTO.checkPrimeSync(1n), false);

  const generated = CRYPTO.generatePrimeSync(64, { bigint: true });
  assert.equal(typeof generated, 'bigint');
  assert.equal(generated.toString(2).length, 64);
  assert.equal(nodeCrypto.checkPrimeSync(generated, { checks: 32 }), true, 'generated prime is prime');
  // Node returns an ArrayBuffer here, not a Buffer.
  const generatedBuffer = CRYPTO.generatePrimeSync(32);
  assert.equal(Object.prototype.toString.call(generatedBuffer), Object.prototype.toString.call(nodeCrypto.generatePrimeSync(32)));
  assert.equal(nodeCrypto.checkPrimeSync(Buffer.from(generatedBuffer)), true);
  assert.equal(CRYPTO.generatePrimeSync(32, { bigint: true }).toString(2).length, 32);
  assert.equal(CRYPTO.checkPrimeSync(CRYPTO.generatePrimeSync(64, { bigint: true })), true);
  const asyncPrime = await new Promise((resolve, reject) => CRYPTO.generatePrime(32, { bigint: true }, (error, value) => (error ? reject(error) : resolve(value))));
  assert.equal(typeof asyncPrime, 'bigint');
  const checked = await new Promise((resolve, reject) => CRYPTO.checkPrime(13n, (error, value) => (error ? reject(error) : resolve(value))));
  assert.equal(checked, true);
});

test('Diffie-Hellman negotiates the same shared secret as Node', () => {
  const ours = CRYPTO.createDiffieHellman(512, 2);
  const ourPublic = Buffer.from(ours.generateKeys());
  const reference = nodeCrypto.createDiffieHellman(Buffer.from(ours.getPrime()));
  reference.generateKeys();
  assert.equal(hex(ours.computeSecret(reference.getPublicKey())), reference.computeSecret(ourPublic).toString('hex'));
  assert.equal(hex(ours.getPrime()), reference.getPrime().toString('hex'));

  for (const group of ['modp1', 'modp2', 'modp5', 'modp14', 'modp15', 'modp16', 'modp17', 'modp18']) {
    const oursGroup = CRYPTO.getDiffieHellman(group);
    const nodeGroup = nodeCrypto.getDiffieHellman(group);
    assert.equal(hex(oursGroup.getPrime()), nodeGroup.getPrime().toString('hex'), group + ' prime');
    assert.equal(hex(oursGroup.getGenerator()), nodeGroup.getGenerator().toString('hex'), group + ' generator');
    assert.ok(oursGroup instanceof CRYPTO.DiffieHellmanGroup);
    assert.throws(() => oursGroup.generateKeys(), error => error.code === 'ERR_CRYPTO_INVALID_STATE');
  }
  const custom = CRYPTO.getDiffieHellman('modp14');
  const peer = CRYPTO.createDiffieHellman(Buffer.from(custom.getPrime()), Buffer.from(custom.getGenerator()));
  peer.generateKeys();
  const mine = CRYPTO.createDiffieHellman(Buffer.from(custom.getPrime()), Buffer.from(custom.getGenerator()));
  mine.generateKeys();
  assert.equal(hex(mine.computeSecret(Buffer.from(peer.getPublicKey()))), hex(peer.computeSecret(Buffer.from(mine.getPublicKey()))));

  assert.throws(() => CRYPTO.getDiffieHellman('modp99'), error => error.code === 'ERR_CRYPTO_UNKNOWN_DH_GROUP');
  // An honest failure beats a fabricated modp14 fallback nobody asked for.
  assert.throws(() => CRYPTO.diffieHellman({ privateKey: 'x', publicKey: 'y' }), error => error.code === 'ERR_CRYPTO_INVALID_KEYTYPE');
  assert.throws(() => CRYPTO.diffieHellman({}), error => error.code === 'ERR_INVALID_ARG_TYPE');
});

test('KeyObject, createSecretKey and the FIPS helpers behave like Node', () => {
  const key = CRYPTO.createSecretKey('beownir-secret');
  assert.equal(key instanceof CRYPTO.KeyObject, true);
  assert.equal(key.type, 'secret');
  assert.equal(key.symmetricKeySize, 14);
  assert.equal(text(key.export()), 'beownir-secret');
  assert.equal(key.export({ format: 'jwk' }).kty, 'oct');
  assert.equal(key.equals(CRYPTO.createSecretKey('beownir-secret')), true);
  assert.equal(key.equals(CRYPTO.createSecretKey('other')), false);
  assert.equal(key.toString(), '[KeyObject]');
  assert.equal(CRYPTO.KeyObject.from(Buffer.alloc(4)).type, 'secret');
  assert.throws(() => CRYPTO.createSecretKey(''), error => error.code === 'ERR_CRYPTO_INVALID_KEYLEN');
  assert.equal(CRYPTO.getFips(), 0);
  assert.throws(() => CRYPTO.setFips(true), error => error.code === 'ERR_CRYPTO_FIPS_UNAVAILABLE');
  const heap = CRYPTO.secureHeapUsed();
  assert.equal(heap.total, 0);
  assert.equal(heap.used, 0);
  assert.equal(heap.min, 0);
});

test('getCipherInfo matches the OpenSSL metadata for the ciphers we implement', () => {
  const names = CRYPTO.getCiphers();
  assert.ok(names.length >= 16, 'the AES family is advertised');
  for (const name of names) {
    assert.equal(JSON.stringify(CRYPTO.getCipherInfo(name)), JSON.stringify(nodeCrypto.getCipherInfo(name)), name);
  }
  assert.equal(CRYPTO.getCipherInfo(427).name, 'aes-256-cbc');
  assert.equal(CRYPTO.getCipherInfo('not-a-cipher'), undefined);
});

/* scrypt and ECDH used to throw "not available in the browser runtime". Both are
 * now implemented in-house and compared here against the host's OpenSSL, which
 * is the only oracle that matters: a KDF or a key agreement that is merely
 * self-consistent is worse than one that refuses to run. */

const scryptVectors = [
  { label: 'RFC 7914 empty password/salt, N=16 r=1 p=1', password: '', salt: '', keylen: 64, N: 16, r: 1, p: 1 },
  { label: 'RFC 7914 pleaseletmein, N=1024 r=8 p=16', password: 'pleaseletmein', salt: 'SodiumChloride', keylen: 64, N: 1024, r: 8, p: 16 },
  { label: 'password/salty, N=16384 r=8 p=1', password: 'password', salt: 'salty', keylen: 32, N: 16384, r: 8, p: 1 },
  { label: 'tiny N with r>1 and p>1', password: 'pw', salt: 'salt', keylen: 48, N: 2, r: 3, p: 2 },
];

test('scrypt matches OpenSSL byte for byte, including the RFC 7914 vectors', () => {
  for (const vector of scryptVectors) {
    const options = { N: vector.N, r: vector.r, p: vector.p };
    const expected = hex(nodeCrypto.scryptSync(vector.password, vector.salt, vector.keylen, options));
    assert.equal(hex(CRYPTO.scryptSync(vector.password, vector.salt, vector.keylen, options)), expected, vector.label);
  }
  // Node's defaults are N=16384, r=8, p=1; a bare call must agree too.
  assert.equal(hex(CRYPTO.scryptSync('a', 'b', 32)), hex(nodeCrypto.scryptSync('a', 'b', 32)));
});

test('scrypt callback form resolves off the current tick with the same key', async () => {
  let syncReturn = true;
  const key = await new Promise((resolve, reject) => {
    CRYPTO.scrypt('password', 'salty', 32, { N: 16, r: 1, p: 1 }, (error, value) => {
      assert.equal(syncReturn, false, 'the callback must not run synchronously');
      if (error) reject(error); else resolve(value);
    });
    syncReturn = false;
  });
  assert.equal(hex(key), hex(nodeCrypto.scryptSync('password', 'salty', 32, { N: 16, r: 1, p: 1 })));
});

test('scrypt rejects bad parameters and runaway memory the way Node does', () => {
  const code = error => error.code;
  assert.throws(() => CRYPTO.scryptSync('a', 'b', 32, { N: 1000 }), error => code(error) === 'ERR_CRYPTO_INVALID_SCRYPT_PARAMS', 'N must be a power of two');
  assert.throws(() => CRYPTO.scryptSync('a', 'b', 32, { N: 2 ** 20, r: 8, p: 1 }), error => code(error) === 'ERR_CRYPTO_INVALID_SCRYPT_PARAMS', 'the default 32 MiB cap applies');
  assert.throws(() => CRYPTO.scryptSync('a', 'b', 32, { N: 4, r: 0 }), error => code(error) === 'ERR_CRYPTO_INVALID_SCRYPT_PARAMS');
  // The same numbers Node accepts must be accepted here, cap included.
  assert.doesNotThrow(() => CRYPTO.scryptSync('a', 'b', 16, { N: 2 ** 20, r: 8, p: 1, maxmem: 2 ** 31 }));
});

for (const curve of ['prime256v1', 'secp384r1', 'secp521r1']) {
  test('crypto.createECDH(' + curve + ') public keys and shared secrets match OpenSSL', () => {
    const scalar = Buffer.from('1234567890abcdef1234567890abcdef', 'hex');
    const ours = CRYPTO.createECDH(curve);
    const reference = nodeCrypto.createECDH(curve);
    ours.setPrivateKey(scalar);
    reference.setPrivateKey(scalar);
    assert.equal(hex(ours.getPublicKey()), hex(reference.getPublicKey()), 'uncompressed public key');
    assert.equal(hex(ours.getPublicKey(undefined, 'compressed')), hex(reference.getPublicKey(undefined, 'compressed')), 'compressed public key');
    const peer = nodeCrypto.createECDH(curve);
    peer.generateKeys();
    assert.equal(hex(ours.computeSecret(peer.getPublicKey())), hex(reference.computeSecret(peer.getPublicKey())), 'shared secret');
    assert.equal(hex(ours.computeSecret(peer.getPublicKey(undefined, 'compressed'))), hex(reference.computeSecret(peer.getPublicKey(undefined, 'compressed'))), 'shared secret from a compressed peer key');
  });
}

test('ECDH two-party agreement is symmetric and the private key survives a round trip', () => {
  for (const curve of ['prime256v1', 'secp384r1']) {
    const first = CRYPTO.createECDH(curve), second = CRYPTO.createECDH(curve);
    first.generateKeys();
    second.generateKeys();
    assert.equal(hex(first.computeSecret(second.getPublicKey())), hex(second.computeSecret(first.getPublicKey())), curve);
    const restored = CRYPTO.createECDH(curve);
    restored.setPrivateKey(first.getPrivateKey());
    assert.equal(restored.getPublicKey().length, first.getPublicKey().length);
    assert.equal(hex(restored.getPublicKey()), hex(first.getPublicKey()), curve + ' private key round trip');
  }
});

test('ECDH rejects unknown curves and invalid keys with the Node error codes', () => {
  assert.throws(() => CRYPTO.createECDH('ed25519'), error => error.code === 'ERR_CRYPTO_INVALID_CURVE');
  const ecdh = CRYPTO.createECDH('prime256v1');
  assert.throws(() => ecdh.computeSecret(Buffer.alloc(65, 4)), error => error.code === 'ERR_CRYPTO_INVALID_STATE', 'no private key yet');
  ecdh.generateKeys();
  assert.throws(() => ecdh.computeSecret(Buffer.alloc(65, 9)), error => error.code === 'ERR_CRYPTO_INVALID_KEYTYPE', 'not a curve point');
  assert.throws(() => ecdh.setPrivateKey(Buffer.alloc(32)), error => error.code === 'ERR_CRYPTO_INVALID_KEYTYPE', 'zero scalar');
  assert.throws(() => ecdh.getPublicKey(undefined, 'weird'), error => error.code === 'ERR_INVALID_ARG_VALUE');
});

test('ECDH.convertKey re-serialises peer points the way Node does', () => {
  const peer = nodeCrypto.createECDH('prime256v1');
  peer.generateKeys();
  const compressed = peer.getPublicKey(undefined, 'compressed');
  assert.equal(hex(CRYPTO.ECDH.convertKey(compressed, 'prime256v1')), hex(nodeCrypto.ECDH.convertKey(compressed, 'prime256v1')), 'compressed to uncompressed');
  assert.equal(hex(CRYPTO.ECDH.convertKey(peer.getPublicKey(), 'prime256v1', undefined, undefined, 'compressed')), hex(nodeCrypto.ECDH.convertKey(peer.getPublicKey(), 'prime256v1', undefined, undefined, 'compressed')), 'uncompressed to compressed');
  assert.ok(CRYPTO.createECDH('prime256v1') instanceof CRYPTO.ECDH, 'createECDH returns an ECDH');
});
