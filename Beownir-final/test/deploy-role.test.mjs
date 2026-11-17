import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanOrigin, resolveOrigins, headersFor, injectOrigins } from '../tools/deploy-role.mjs';

const origins = { ide: 'https://ide.example.app', runtime: 'https://runtime.example.app', preview: 'https://preview.example.app' };

test('origins are accepted only as bare https origins (or http on localhost)', () => {
  assert.equal(cleanOrigin('https://runtime.example.app/', 'runtime'), 'https://runtime.example.app');
  assert.equal(cleanOrigin('http://localhost:8080', 'runtime'), 'http://localhost:8080');
  assert.throws(() => cleanOrigin('http://runtime.example.app', 'runtime'), /https/);
  assert.throws(() => cleanOrigin('https://runtime.example.app/path', 'runtime'), /bare origin/);
  assert.throws(() => cleanOrigin('https://runtime.example.app?x=1', 'runtime'), /bare origin/);
  assert.throws(() => cleanOrigin('https://user:pw@runtime.example.app', 'runtime'), /bare origin/);
  assert.throws(() => cleanOrigin('not a url', 'runtime'), /not a valid URL/);
});

test('the three origins must be distinct', () => {
  assert.throws(() => resolveOrigins({ ide: origins.ide, runtime: origins.ide, preview: origins.preview }), /distinct/);
  assert.throws(() => resolveOrigins({ ide: origins.ide, runtime: origins.runtime, preview: origins.runtime }), /distinct/);
  assert.deepEqual(resolveOrigins(origins), origins);
});

test('origins are baked into the page meta tag in the format the page reads', () => {
  const html = '<head><meta name="beownir-origins" content=""></head>';
  const out = injectOrigins(html, origins);
  assert.match(out, /<meta name="beownir-origins" content="runtime=https:\/\/runtime\.example\.app;preview=https:\/\/preview\.example\.app">/);
  assert.throws(() => injectOrigins('<head></head>', origins), /exactly one empty/);
  assert.throws(() => injectOrigins('<meta name="beownir-origins" content=""><meta name="beownir-origins" content="">', origins), /exactly one empty/);
});

test('the IDE site is cross-origin isolated and allows only the runtime and preview to be embedded in its permissions', () => {
  const headers = headersFor('ide', origins);
  assert.match(headers, /Cross-Origin-Embedder-Policy: require-corp/);
  assert.match(headers, /Cross-Origin-Resource-Policy: same-origin/);
  assert.match(headers, /cross-origin-isolated=\(self "https:\/\/runtime\.example\.app" "https:\/\/preview\.example\.app"\)/);
  assert.match(headers, /Service-Worker-Allowed: \//);
});

test('the runtime and preview sites are cross-origin resources framed only by the IDE', () => {
  for (const role of ['runtime', 'preview']) {
    const headers = headersFor(role, origins);
    assert.match(headers, /Cross-Origin-Resource-Policy: cross-origin/, role + ' must be embeddable by the IDE');
    assert.match(headers, /Content-Security-Policy: frame-ancestors https:\/\/ide\.example\.app/, role + ' must only be framed by the IDE');
    assert.match(headers, /Cross-Origin-Embedder-Policy: require-corp/);
    assert.doesNotMatch(headers, /Resource-Policy: same-origin/);
  }
});

test('an unknown role is rejected', () => {
  assert.throws(() => headersFor('admin', origins), /unknown role/);
});
