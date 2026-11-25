import test from 'node:test';
import assert from 'node:assert/strict';
import { loadRuntime } from './helpers/runtime.mjs';

/* http.request over the virtual loopback. Dev-server proxies (Vite,
 * http-proxy-middleware, webpack-dev-server) are built on exactly this, so the
 * Node contract is what matters: 'finish', auth, query paths, ECONNREFUSED and
 * stream piping. */

const rt = loadRuntime();
const http = rt.CORE.http;

const listen = handler => new Promise(resolve => {
  const server = http.createServer(handler);
  server.listen(0 + 4000 + Math.floor(Math.random() * 900));
  resolve(server);
});

const request = (options, body) => new Promise((resolve, reject) => {
  const req = http.request(options, response => {
    const chunks = [];
    response.on('data', chunk => chunks.push(Buffer.from(chunk)));
    response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks).toString('utf8'), raw: response }));
  });
  req.on('error', reject);
  if (body) req.write(body);
  req.end();
});

test('a loopback GET carries the path, query and headers', async () => {
  const server = await listen((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json', 'x-echo': req.headers['x-probe'] || '' });
    res.end(JSON.stringify({ url: req.url, method: req.method, host: req.headers.host }));
  });
  try {
    const response = await request({ port: server.port, path: '/api/items?limit=2&sort=asc', headers: { 'x-probe': 'yes' } });
    assert.equal(response.status, 200);
    assert.equal(response.headers['x-echo'], 'yes');
    const body = JSON.parse(response.body);
    assert.equal(body.url, '/api/items?limit=2&sort=asc');
    assert.equal(body.method, 'GET');
    assert.equal(body.host, 'localhost:' + server.port);
  } finally { server.close(); }
});

test('a POST body arrives intact and finish fires before the response', async () => {
  const server = await listen((req, res) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(Buffer.from(chunk)));
    req.on('end', () => res.end('received:' + Buffer.concat(chunks).toString('utf8')));
  });
  try {
    const sequence = [];
    const result = await new Promise((resolve, reject) => {
      const req = http.request({ port: server.port, method: 'POST', path: '/submit', headers: { 'content-type': 'text/plain' } }, res => {
        const chunks = [];
        res.on('data', chunk => chunks.push(Buffer.from(chunk)));
        res.on('end', () => { sequence.push('response'); resolve(Buffer.concat(chunks).toString('utf8')); });
      });
      req.on('error', reject);
      req.on('finish', () => sequence.push('finish'));
      req.write('hello ');
      req.end('world');
    });
    assert.equal(result, 'received:hello world');
    assert.deepEqual(sequence, ['finish', 'response']);
  } finally { server.close(); }
});

test('a readable stream pipes into the request like a proxy does', async () => {
  const server = await listen((req, res) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(Buffer.from(chunk)));
    req.on('end', () => res.end('piped:' + Buffer.concat(chunks).toString('utf8')));
  });
  try {
    const source = new rt.STREAM.Readable();
    const pending = new Promise((resolve, reject) => {
      const req = http.request({ port: server.port, method: 'PUT', path: '/upload' }, res => {
        const chunks = [];
        res.on('data', chunk => chunks.push(Buffer.from(chunk)));
        res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      });
      req.on('error', reject);
      source.pipe(req);
    });
    source.push('stream-');
    source.push('body');
    source.push(null);
    assert.equal(await pending, 'piped:stream-body');
  } finally { server.close(); }
});

test('auth becomes a Basic authorization header', async () => {
  const server = await listen((req, res) => res.end(req.headers.authorization || ''));
  try {
    const response = await request({ port: server.port, auth: 'user:pass' });
    assert.equal(response.body, 'Basic ' + Buffer.from('user:pass').toString('base64'));
  } finally { server.close(); }
});

test('a closed port fails with ECONNREFUSED, not a fake response', async () => {
  const server = await listen((req, res) => res.end('ok'));
  const port = server.port;
  server.close();
  await assert.rejects(request({ port }), error => error.code === 'ECONNREFUSED' && /ECONNREFUSED/.test(error.message));
});

test('a slow server emits timeout and leaves destruction to the caller', async () => {
  const server = await listen(() => { /* never responds */ });
  try {
    // Node parity: setTimeout() only emits 'timeout'; it does not destroy the
    // request. Proxies listen for it and call destroy() themselves.
    const error = await new Promise((resolve, reject) => {
      const req = http.request({ port: server.port, path: '/' }, () => reject(new Error('unexpected response')));
      let fired = false;
      req.setTimeout(30, () => { fired = true; req.destroy(Object.assign(new Error('socket hang up'), { code: 'ETIMEDOUT' })); });
      req.on('error', failure => { if (fired) resolve(failure); else reject(failure); });
      req.end();
      setTimeout(() => { if (!fired) reject(new Error('no timeout event')); }, 500);
    });
    assert.equal(error.code, 'ETIMEDOUT');
  } finally { server.close(); }
});

test('an explicit path wins over pathname and search exactly like Node', async () => {
  const server = await listen((req, res) => res.end(req.url));
  try {
    const probe = options => request({ port: server.port, ...options }).then(response => response.body);
    assert.equal(await probe({ path: '/a?b=1', search: '?c=2' }), '/a?b=1');
    assert.equal(await probe({ pathname: '/a', search: '?c=2' }), '/a?c=2');
    assert.equal(await probe({ path: '/plain' }), '/plain');
  } finally { server.close(); }
});

test('abort() rejects a pending proxy request with ECONNRESET', async () => {
  const server = await listen(() => { /* never responds */ });
  try {
    const error = await new Promise((resolve, reject) => {
      const req = http.request({ port: server.port, path: '/' }, () => reject(new Error('unexpected response')));
      req.on('error', resolve);
      req.end();
      req.abort();
    });
    assert.equal(error.code, 'ECONNRESET');
    assert.equal(error.message, 'socket hang up');
  } finally { server.close(); }
});

test('https.request over loopback uses the same virtual transport', async () => {
  const server = await listen((req, res) => res.end('secure:' + req.url));
  try {
    const response = await new Promise((resolve, reject) => {
      const req = rt.CORE.https.get({ port: server.port, path: '/tls' }, res => {
        const chunks = [];
        res.on('data', chunk => chunks.push(Buffer.from(chunk)));
        res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      });
      req.on('error', reject);
    });
    assert.equal(response, 'secure:/tls');
  } finally { server.close(); }
});

test('the server reports address, listening state and close', async () => {
  const server = await listen((req, res) => res.end('x'));
  assert.equal(server.listening, true);
  assert.equal(server.address().port, server.port);
  assert.equal(server.address().family, 'IPv4');
  await new Promise(resolve => server.close(resolve));
  assert.equal(server.listening, false);
  assert.equal(rt.evaluate('SERVERS').has(server.port), false);
});

test('a URL string target works the way proxy code passes it', async () => {
  const server = await listen((req, res) => res.end('url:' + req.url));
  try {
    const body = await new Promise((resolve, reject) => {
      const req = http.request('http://localhost:' + server.port + '/from-url?x=1', res => {
        const chunks = [];
        res.on('data', chunk => chunks.push(Buffer.from(chunk)));
        res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      });
      req.on('error', reject);
      req.end();
    });
    assert.equal(body, 'url:/from-url?x=1');
  } finally { server.close(); }
});

test('responses expose the Node metadata and setEncoding returns strings', async () => {
  const server = await listen((req, res) => {
    res.writeHead(201, 'Made It', { 'x-meta': 'yes', 'content-type': 'text/plain' });
    res.end('héllo');
  });
  try {
    const response = await new Promise((resolve, reject) => {
      const req = http.request({ port: server.port, path: '/' }, res => {
        res.setEncoding('utf8');
        const chunks = [];
        res.on('data', chunk => chunks.push(chunk));
        res.on('end', () => resolve({ res, body: chunks.join('') }));
      });
      req.on('error', reject);
      req.end();
    });
    assert.equal(response.res.statusCode, 201);
    assert.equal(response.res.statusMessage, 'Made It');
    assert.equal(response.res.httpVersion, '1.1');
    assert.equal(response.res.headers['x-meta'], 'yes');
    assert.ok(response.res.rawHeaders.includes('x-meta'));
    assert.equal(response.body, 'héllo');
    assert.equal(response.res.req.port, server.port);
  } finally { server.close(); }
});

test('a port owned by another virtual process is reached through the kernel', async () => {
  // Simulates the real topology: the dev server runs in its own worker, so the
  // proxy's http.request must be relayed by the kernel instead of failing.
  const peer = rt.serveRemote(4999, request => ({
    status: 203,
    statusMessage: 'From Peer',
    headers: { 'x-peer': 'yes', 'content-type': 'text/plain' },
    body: Buffer.from('peer:' + request.method + ':' + request.url + ':' + (request.body ? request.body.toString('utf8') : '')),
  }));
  try {
    assert.equal(rt.evaluate('SERVERS').has(4999), false);
    const response = await request({ port: 4999, method: 'POST', path: '/relay?x=1' }, 'payload');
    assert.equal(response.status, 203);
    assert.equal(response.raw.statusMessage, 'From Peer');
    assert.equal(response.headers['x-peer'], 'yes');
    assert.equal(response.body, 'peer:POST:/relay?x=1:payload');
  } finally { peer.close(); }
  await assert.rejects(request({ port: 4999 }), error => error.code === 'ECONNREFUSED');
});

test('a gateway proxies to a backend the way http-proxy-middleware does', async () => {
  const backend = await listen((req, res) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(Buffer.from(chunk)));
    req.on('end', () => {
      res.writeHead(207, 'Multi-Status', { 'content-type': 'application/json', 'x-backend': 'yes' });
      res.end(JSON.stringify({ path: req.url, body: Buffer.concat(chunks).toString('utf8'), inbound: req.headers['x-inbound'] }));
    });
  });
  const gateway = await listen((req, res) => {
    const upstream = http.request({
      port: backend.port,
      method: req.method,
      path: req.url,
      headers: { ...req.headers, host: 'localhost:' + backend.port, 'x-inbound': 'through-gateway' },
    }, upstreamResponse => {
      res.writeHead(upstreamResponse.statusCode, upstreamResponse.statusMessage, upstreamResponse.headers);
      upstreamResponse.pipe(res);
    });
    upstream.on('error', error => { res.writeHead(502); res.end(error.message); });
    req.pipe(upstream);
  });
  try {
    const response = await request({ port: gateway.port, method: 'POST', path: '/proxy/echo?x=1' }, 'body-through-proxy');
    assert.equal(response.status, 207);
    assert.equal(response.raw.statusMessage, 'Multi-Status');
    assert.equal(response.headers['x-backend'], 'yes');
    assert.deepEqual(JSON.parse(response.body), { path: '/proxy/echo?x=1', body: 'body-through-proxy', inbound: 'through-gateway' });
  } finally { gateway.close(); backend.close(); }
});

test('assignSocket()/detachSocket() let an injector take over the connection', async () => {
  // @hapi/shot (hapi, and anything else built on it) fakes a request by
  // attaching its own socket to the response, then detaches it again.
  const seen = [];
  const server = await listen((req, res) => {
    const original = res.socket;
    const proxy = res.assignSocket({ writable: true, marker: 'proxy-socket' });
    seen.push({ identity: res.socket === proxy, connection: res.connection === proxy, returned: proxy.marker });
    res.detachSocket({ marker: 'unrelated' });
    seen.push({ kept: res.socket === proxy });
    res.detachSocket(proxy);
    seen.push({ fresh: res.socket !== proxy && res.socket !== original, addressable: typeof res.socket.address === 'function' });
    res.end(JSON.stringify({ ok: true }));
  });
  try {
    const response = await request({ port: server.port, path: '/swap' });
    assert.equal(response.status, 200);
    assert.deepEqual(JSON.parse(response.body), { ok: true });
    assert.deepEqual(seen, [
      { identity: true, connection: true, returned: 'proxy-socket' },
      { kept: true },
      { fresh: true, addressable: true },
    ]);
  } finally { server.close(); }
});

test('ClientRequest emits socket before end, supports appendHeader, and pipes already-ended IncomingMessage after async delay', async () => {
  const backend = await listen((req, res) => {
    res.appendHeader('x-multi', 'one');
    res.appendHeader('x-multi', 'two');
    res.end('ok:' + req.headers['x-forwarded-for']);
  });
  const gateway = await listen((req, res) => {
    // Async middleware yields before httpxy-style proxy wires req.pipe(proxyReq) inside 'socket'.
    setTimeout(() => {
      const proxyReq = http.request({ port: backend.port, method: req.method, path: req.url }, upstreamRes => {
        res.writeHead(upstreamRes.statusCode, upstreamRes.headers);
        upstreamRes.pipe(res);
      });
      proxyReq.appendHeader('x-forwarded-for', '10.0.0.1');
      proxyReq.appendHeader('x-forwarded-for', '10.0.0.2');
      proxyReq.once('socket', () => { req.pipe(proxyReq); });
    }, 20);
  });
  try {
    const response = await request({ port: gateway.port, path: '/async-proxy' });
    assert.equal(response.status, 200);
    assert.equal(response.body, 'ok:10.0.0.1, 10.0.0.2');
    assert.deepEqual(JSON.parse(JSON.stringify(response.headers['x-multi'])), ['one', 'two']);
  } finally { gateway.close(); backend.close(); }
});

test('net Unix domain sockets support listen, stat/chmod, connect IPC, close, and ENOENT', async () => {
  const result = await rt.evaluate(`(async () => {
    const fs = CORE.fs;
    const net = CORE.net;
    const sockPath = '/tmp/beownir-ipc-test.sock';
    fs.mkdirSync('/tmp', { recursive: true });
    let addr = null, isSock = false, existsBefore = false, existsAfter = true;
    const server = net.createServer(conn => {
      conn.on('data', chunk => conn.end('echo:' + chunk.toString('utf8')));
    });
    await new Promise(resolve => server.listen(sockPath, resolve));
    addr = server.address();
    existsBefore = fs.existsSync(sockPath);
    isSock = fs.statSync(sockPath).isSocket();
    fs.chmodSync(sockPath, 0o600);
    const modeAfter = fs.statSync(sockPath).mode & 0o777;
    const reply = await new Promise((resolve, reject) => {
      const chunks = [];
      const client = net.connect(sockPath, () => client.write('ping'));
      client.on('data', chunk => chunks.push(chunk));
      client.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      client.on('error', reject);
    });
    await new Promise(resolve => server.close(resolve));
    existsAfter = fs.existsSync(sockPath);
    const enoentCode = await new Promise(resolve => {
      const client = net.connect(sockPath);
      client.on('error', err => resolve(err.code));
    });
    return { addr, existsBefore, isSock, modeAfter, reply, existsAfter, enoentCode };
  })()`);
  assert.deepEqual(JSON.parse(JSON.stringify(result)), {
    addr: '/tmp/beownir-ipc-test.sock',
    existsBefore: true,
    isSock: true,
    modeAfter: 0o600,
    reply: 'echo:ping',
    existsAfter: false,
    enoentCode: 'ENOENT',
  });
});

test('worker_threads Worker forwards workerData and threadId', async () => {
  const result = await rt.evaluate(`(async () => {
    const fs = CORE.fs;
    fs.writeFileSync('/project/worker-data-probe.mjs', "import { parentPort, workerData, threadId } from 'node:worker_threads';\\nparentPort.postMessage({ workerData, threadId });\\n");
    const { Worker } = CORE.worker_threads;
    return await new Promise((resolve, reject) => {
      const w = new Worker('/project/worker-data-probe.mjs', { workerData: { tag: 'nuxt-ipc', port: 30000 } });
      w.on('message', msg => resolve(msg));
      w.on('error', reject);
    });
  })()`);
  assert.equal(result.workerData.tag, 'nuxt-ipc');
  assert.equal(result.workerData.port, 30000);
  assert.ok(result.threadId > 0);
});

test('server.listen(cb), listen(null, cb) and multiple listen(0) calls assign distinct ports', async () => {
  const s1 = http.createServer((req, res) => res.end('one'));
  const s2 = http.createServer((req, res) => res.end('two'));
  const s3 = http.createServer((req, res) => res.end('three'));
  try {
    await new Promise(resolve => s1.listen(resolve));
    await new Promise(resolve => s2.listen(null, resolve));
    await new Promise(resolve => s3.listen(0, resolve));
    assert.notEqual(s1.port, s2.port);
    assert.notEqual(s2.port, s3.port);
    assert.notEqual(s1.port, s3.port);
    assert.equal((await request({ port: s1.port })).body, 'one');
    assert.equal((await request({ port: s2.port })).body, 'two');
    assert.equal((await request({ port: s3.port })).body, 'three');
  } finally {
    s1.close();
    s2.close();
    s3.close();
  }
});
