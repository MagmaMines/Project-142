import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { loadRuntime } from './helpers/runtime.mjs';

function makeSelfSigned(cn = 'localhost') {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beownir-tls-'));
  try {
    const keyPath = path.join(tmp, 'key.pem');
    const certPath = path.join(tmp, 'cert.pem');
    execFileSync('openssl', [
      'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
      '-keyout', keyPath, '-out', certPath,
      '-days', '2', '-subj', `/CN=${cn}`,
      '-addext', `subjectAltName=DNS:${cn},IP:127.0.0.1`,
    ], { stdio: 'ignore' });
    return {
      key: fs.readFileSync(keyPath, 'utf8'),
      cert: fs.readFileSync(certPath, 'utf8'),
    };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

test('node:tls virtual loopback supports createServer/connect, ALPN, SNI, X.509 cert verification, and raw external block', async () => {
  const { key, cert } = makeSelfSigned('localhost');
  const { key: sniKey, cert: sniCert } = makeSelfSigned('alt.local');
  const expectedFp256 = new crypto.X509Certificate(cert).fingerprint256;

  const rt = loadRuntime({ keep: true });
  rt.sandbox.__KEY = key;
  rt.sandbox.__CERT = cert;
  rt.sandbox.__SNI_KEY = sniKey;
  rt.sandbox.__SNI_CERT = sniCert;

  const res = await rt.evaluate(`(async () => {
    const tls = require('tls');
    const net = require('net');

    const srv = tls.createServer({
      key: globalThis.__KEY,
      cert: globalThis.__CERT,
      ALPNProtocols: ['h2', 'http/1.1'],
    }, (sock) => {
      sock.on('data', chunk => sock.write('echo:' + sock.alpnProtocol + ':' + (sock.servername || '') + ':' + chunk.toString()));
    });
    srv.addContext('alt.local', { key: globalThis.__SNI_KEY, cert: globalThis.__SNI_CERT });

    await new Promise(r => srv.listen(7443, '127.0.0.1', r));

    // Verified client connection matching CA + ALPN + getPeerCertificate
    const c1 = await new Promise((resolve, reject) => {
      let data = '';
      const sock = tls.connect({
        port: 7443,
        host: '127.0.0.1',
        ca: globalThis.__CERT,
        ALPNProtocols: ['http/1.1', 'h2'],
        servername: 'localhost',
      }, () => {
        const peer = sock.getPeerCertificate();
        sock.write('ping', () => {});
        sock.on('data', d => {
          data += d.toString();
          sock.end();
          resolve({
            authorized: sock.authorized,
            encrypted: sock.encrypted,
            alpn: sock.alpnProtocol,
            fp256: peer.fingerprint256,
            data,
          });
        });
      });
      sock.on('error', reject);
    });

    // SNI context selection switches certificate when servername matches addContext()
    const cSni = await new Promise((resolve, reject) => {
      const sock = tls.connect({
        port: 7443,
        host: '127.0.0.1',
        servername: 'alt.local',
        ca: globalThis.__SNI_CERT,
        ALPNProtocols: ['http/1.1'],
      }, () => {
        const peer = sock.getPeerCertificate();
        sock.end();
        resolve({ authorized: sock.authorized, subjectCN: peer.subject?.CN });
      });
      sock.on('error', reject);
    });

    // Untrusted certificate fails when rejectUnauthorized !== false
    let rejectCode = null;
    await new Promise((resolve) => {
      const sock = tls.connect({ port: 7443, host: '127.0.0.1' }, () => resolve());
      sock.on('error', err => { rejectCode = err.code || err.message; resolve(); });
    });

    // Plain net.connect to a TLS port emits ERR_SSL_WRONG_VERSION_NUMBER on TLS client
    const plainSrv = net.createServer(s => s.write('HTTP/1.1 200 OK\\r\\n\\r\\nplain'));
    await new Promise(r => plainSrv.listen(7444, '127.0.0.1', r));
    let wrongVer = null;
    await new Promise((resolve) => {
      const s = tls.connect({ port: 7444, host: '127.0.0.1', rejectUnauthorized: false }, () => resolve());
      s.on('error', err => { wrongVer = err.code || err.message; resolve(); });
    });

    // External raw TLS sockets still fail with ERR_BROWSER_RAW_TLS_UNSUPPORTED
    let extCode = null;
    await new Promise((resolve) => {
      const s = tls.connect({ port: 443, host: 'example.com' }, () => resolve());
      s.on('error', err => { extCode = err.code; resolve(); });
    });

    await new Promise(r => srv.close(r));
    await new Promise(r => plainSrv.close(r));
    return { c1, cSni, rejectCode, wrongVer, extCode };
  })()`);

  assert.equal(res.c1.authorized, true);
  assert.equal(res.c1.encrypted, true);
  assert.equal(res.c1.alpn, 'http/1.1');
  assert.equal(res.c1.fp256, expectedFp256);
  assert.equal(res.c1.data, 'echo:http/1.1:localhost:ping');
  assert.equal(res.cSni.authorized, true);
  assert.equal(res.cSni.subjectCN, 'alt.local');
  assert.match(String(res.rejectCode), /SELF_SIGNED|CERT|ERR_TLS/i);
  assert.equal(res.wrongVer, 'ERR_SSL_WRONG_VERSION_NUMBER');
  assert.equal(res.extCode, 'ERR_BROWSER_RAW_TLS_UNSUPPORTED');
});

test('https.createServer and https.request run over virtual loopback with encrypted socket', async () => {
  const { key, cert } = makeSelfSigned('localhost');
  const rt = loadRuntime({ keep: true });
  rt.sandbox.__KEY = key;
  rt.sandbox.__CERT = cert;

  const res = await rt.evaluate(`(async () => {
    const https = require('https');
    const srv = https.createServer({ key: globalThis.__KEY, cert: globalThis.__CERT }, (req, res) => {
      res.writeHead(200, { 'content-type': 'application/json', 'x-enc': String(Boolean(req.socket?.encrypted)) });
      res.end(JSON.stringify({ url: req.url, encrypted: Boolean(req.socket?.encrypted) }));
    });
    await new Promise(r => srv.listen(8443, '127.0.0.1', r));
    const reply = await new Promise((resolve, reject) => {
      https.get('https://127.0.0.1:8443/hello', { ca: globalThis.__CERT }, (res) => {
        let body = '';
        res.on('data', d => body += d);
        res.on('end', () => resolve({ status: res.statusCode, xEnc: res.headers['x-enc'], body: JSON.parse(body) }));
      }).on('error', reject);
    });
    await new Promise(r => srv.close(r));
    return reply;
  })()`);

  assert.equal(res.status, 200);
  assert.equal(res.xEnc, 'true');
  assert.equal(res.body.url, '/hello');
  assert.equal(res.body.encrypted, true);
});

test('node:http2 virtual loopback supports createServer, createSecureServer, connect, GET/POST streams, ECONNREFUSED, and cross-worker routing', async () => {
  const { key, cert } = makeSelfSigned('localhost');
  const rt = loadRuntime({ keep: true });
  rt.sandbox.__KEY = key;
  rt.sandbox.__CERT = cert;

  const res = await rt.evaluate(`(async () => {
    const http2 = require('http2');

    const h2c = http2.createServer();
    h2c.on('stream', (stream, headers) => {
      const chunks = [];
      stream.on('data', c => chunks.push(c));
      stream.on('end', () => {
        stream.respond({ ':status': 200, 'content-type': 'application/json' });
        stream.end(JSON.stringify({
          method: headers[':method'],
          path: headers[':path'],
          body: Buffer.concat(chunks).toString(),
          tls: Boolean(stream.session.encrypted),
        }));
      });
    });
    await new Promise(r => h2c.listen(8082, '127.0.0.1', r));

    const client = http2.connect('http://127.0.0.1:8082');
    const getRes = await new Promise((resolve, reject) => {
      const req = client.request({ ':path': '/info', ':method': 'GET' });
      let out = '', status = 0;
      req.on('response', h => { status = h[':status']; });
      req.on('data', c => out += c);
      req.on('end', () => resolve({ status, body: JSON.parse(out) }));
      req.on('error', reject);
      req.end();
    });

    const postRes = await new Promise((resolve, reject) => {
      const req = client.request({ ':path': '/submit', ':method': 'POST' });
      let out = '', status = 0;
      req.on('response', h => { status = h[':status']; });
      req.on('data', c => out += c);
      req.on('end', () => resolve({ status, body: JSON.parse(out) }));
      req.on('error', reject);
      req.end('hello-h2');
    });
    client.close();

    // Secure HTTP/2 server
    const h2s = http2.createSecureServer({ key: globalThis.__KEY, cert: globalThis.__CERT }, (req, res) => {
      res.writeHead(201, { 'content-type': 'text/plain' });
      res.end('secure:' + req.url);
    });
    await new Promise(r => h2s.listen(8444, '127.0.0.1', r));
    const secClient = http2.connect('https://127.0.0.1:8444', { ca: globalThis.__CERT });
    const secRes = await new Promise((resolve, reject) => {
      const req = secClient.request({ ':path': '/sec' });
      let out = '', status = 0;
      req.on('response', h => { status = h[':status']; });
      req.on('data', c => out += c);
      req.on('end', () => resolve({ status, out, encrypted: secClient.encrypted }));
      req.on('error', reject);
      req.end();
    });
    secClient.close();

    // Closed port yields ECONNREFUSED on client session
    let refused = null;
    await new Promise((resolve) => {
      const dead = http2.connect('http://127.0.0.1:19999');
      dead.on('error', e => { refused = e.code; resolve(); });
    });

    // External HTTP/2 host still returns clean ERR_BROWSER_RAW_HTTP2_UNSUPPORTED
    let extH2 = null;
    await new Promise((resolve) => {
      const ext = http2.connect('https://example.com');
      ext.on('error', e => { extH2 = e.code; resolve(); });
    });

    await new Promise(r => h2c.close(r));
    await new Promise(r => h2s.close(r));
    return { getRes, postRes, secRes, refused, extH2 };
  })()`);

  assert.equal(res.getRes.status, 200);
  assert.equal(res.getRes.body.method, 'GET');
  assert.equal(res.getRes.body.path, '/info');
  assert.equal(res.getRes.body.tls, false);
  assert.equal(res.postRes.status, 200);
  assert.equal(res.postRes.body.method, 'POST');
  assert.equal(res.postRes.body.body, 'hello-h2');
  assert.equal(res.secRes.status, 201);
  assert.equal(res.secRes.out, 'secure:/sec');
  assert.equal(res.secRes.encrypted, true);
  assert.equal(res.refused, 'ECONNREFUSED');
  assert.equal(res.extH2, 'ERR_BROWSER_RAW_HTTP2_UNSUPPORTED');
});
