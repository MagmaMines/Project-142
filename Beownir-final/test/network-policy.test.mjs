import test from 'node:test';
import assert from 'node:assert/strict';
import { loadRuntime } from './helpers/runtime.mjs';

test('file:// fetch resolves VFS files with MIME types and escapes null-byte virtual IDs cleanly', async () => {
  const rt = loadRuntime({ keep: true });
  const r = await rt.evaluate(`(async () => {
    FS['/project/hello.txt'] = { c: 'hello-file-fetch', m: Date.now() };
    FS['/project/mod.wasm'] = { c: '__BEOWNIR_WASM64__:' + Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]).toString('base64'), m: Date.now() };

    const txtRes = await fetch('file:///project/hello.txt');
    const txtStatus = txtRes.status;
    const txtBody = await txtRes.text();

    const wasmRes = await fetch(new URL('file:///project/mod.wasm'));
    const wasmType = wasmRes.headers.get('content-type');
    const wasmBytes = new Uint8Array(await wasmRes.arrayBuffer());

    const missRes = await fetch('file:///project/does-not-exist.txt');

    const meta = importMetaFor('\\0virtual:vite/client.mjs');
    return {
      txtStatus,
      txtBody,
      wasmStatus: wasmRes.status,
      wasmType,
      wasmMagic: [...wasmBytes.slice(0, 4)],
      missStatus: missRes.status,
      metaUrl: meta.url,
      hasNullByte: meta.url.includes('\\0'),
    };
  })()`);

  assert.equal(r.txtStatus, 200);
  assert.equal(r.txtBody, 'hello-file-fetch');
  assert.equal(r.wasmStatus, 200);
  assert.equal(r.wasmType, 'application/wasm');
  assert.deepEqual([...r.wasmMagic], [0, 97, 115, 109]);
  assert.equal(r.missStatus, 404);
  assert.equal(r.hasNullByte, false);
  assert.equal(r.metaUrl, 'file:///virtual:vite/client.mjs');
});

test('runtimeFetch honors allowedFetchDomains, rewrites corsProxy URLs, and blocks private/unlisted hosts', async () => {
  const seen = [];
  const rt = loadRuntime({
    keep: true,
    globals: {
      fetch: async (url, init) => {
        seen.push({ url: String(url), method: init?.method || 'GET' });
        return new Response('ok:' + url, {
          status: 200,
          headers: { 'content-type': 'text/plain' },
        });
      },
    },
  });

  const out = await rt.evaluate(`(async () => {
    const errors = {};
    try { await fetch('https://api.github.com/users/octocat'); } catch (e) { errors.defaultBlocked = e.message; }

    setNetworkConfig({
      allowedFetchDomains: ['api.github.com', '*.example.org'],
      corsProxy: 'https://proxy.beownir.test/fetch?url={url}',
    });

    const r1 = await fetch('https://api.github.com/zen');
    const t1 = await r1.text();
    const r2 = await fetch('https://sub.example.org/data.json');
    const t2 = await r2.text();

    for (const [key, badUrl] of [
      ['private10', 'https://10.0.0.1/secret'],
      ['private192', 'https://192.168.1.50/admin'],
      ['meta169', 'https://169.254.169.254/latest'],
      ['unlisted', 'https://evil.other.com/steal'],
      ['creds', 'https://user:pw@api.github.com/'],
    ]) {
      try { await fetch(badUrl); } catch (e) { errors[key] = e.message; }
    }

    // Kernel-level self.fetch and npm registry remain reachable directly without corsProxy rewrite
    const npmRes = await fetch('https://registry.npmjs.org/lodash');
    const npmText = await npmRes.text();

    return { errors, t1, t2, npmText };
  })()`);

  assert.match(out.errors.defaultBlocked, /Network restricted/i);
  assert.equal(out.t1, 'ok:https://proxy.beownir.test/fetch?url=https%3A%2F%2Fapi.github.com%2Fzen');
  assert.equal(out.t2, 'ok:https://proxy.beownir.test/fetch?url=https%3A%2F%2Fsub.example.org%2Fdata.json');
  assert.match(out.errors.private10, /Network restricted/i);
  assert.match(out.errors.private192, /Network restricted/i);
  assert.match(out.errors.meta169, /Network restricted/i);
  assert.match(out.errors.unlisted, /Network restricted/i);
  assert.match(out.errors.creds, /embedded credentials/i);
  assert.equal(out.npmText, 'ok:https://registry.npmjs.org/lodash');
  assert.equal(seen.length, 3);
});

test('http/https ClientRequest forwards multi-value Set-Cookie headers cleanly', async () => {
  const rt = loadRuntime({
    keep: true,
    globals: {
      fetch: async () => {
        const headers = new Headers();
        headers.append('set-cookie', 'a=1; Path=/; HttpOnly');
        headers.append('set-cookie', 'b=2; Path=/; SameSite=Lax');
        headers.set('content-type', 'text/plain');
        return new Response('done', { status: 200, headers });
      },
    },
  });

  const result = await rt.evaluate(`(async () => {
    setNetworkConfig({ allowedFetchDomains: ['api.example.com'] });
    const https = CORE.https;
    return await new Promise((resolve, reject) => {
      const req = https.get('https://api.example.com/cookies', res => {
        let body = '';
        res.on('data', chunk => { body += chunk; });
        res.on('end', () => resolve({ status: res.statusCode, setCookie: res.headers['set-cookie'], body }));
      });
      req.on('error', reject);
    });
  })()`);

  assert.equal(result.status, 200);
  assert.equal(result.body, 'done');
  assert.deepEqual(result.setCookie, ['a=1; Path=/; HttpOnly', 'b=2; Path=/; SameSite=Lax']);
});

test('relative corsProxy paths relay through kernel host-fetch instead of failing in opaque blob workers', async () => {
  const rt = loadRuntime({ keep: true });
  const relayedCalls = [];
  const origOnMsg = rt.sandbox.self.onmessage;
  const origPost = rt.sandbox.self.postMessage;
  rt.sandbox.self.postMessage = msg => {
    if (msg && msg.type === 'kernel-call' && msg.op === 'host-fetch') {
      relayedCalls.push(msg.data);
      setTimeout(() => origOnMsg({
        data: {
          type: 'kernel-reply',
          id: msg.id,
          result: { status: 200, statusText: 'OK', headers: { 'content-type': 'application/json' }, body: new TextEncoder().encode(JSON.stringify({ relayed: true, url: msg.data.url })) },
        },
      }), 0);
      return;
    }
    return origPost(msg);
  };
  const out = await rt.evaluate(`(async () => {
    setNetworkConfig({ allowedFetchDomains: ['api.github.com'], corsProxy: '/__beownir_cors_proxy__' });
    const res = await fetch('https://api.github.com/zen');
    return await res.json();
  })()`);
  assert.equal(out.relayed, true);
  assert.equal(out.url, 'https://api.github.com/zen');
  assert.equal(relayedCalls.length, 1);
});
