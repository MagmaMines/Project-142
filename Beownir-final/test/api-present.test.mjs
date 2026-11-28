import test from 'node:test';
import assert from 'node:assert/strict';
import { loadRuntime } from './helpers/runtime.mjs';

/* Regression coverage for the production API system (BeownirAPI) and the
 * shared presentation kit (BeownirPresent). The API is exercised through the
 * real message seam a host page uses — { type:'api', id, method, args } posts
 * and { type:'api-reply', id, result|error } replies — and the presentation
 * kit is checked directly, so both layers stay honest as they evolve. */

const rt = loadRuntime({ keep: true });
const strip = text => String(text).replace(/\u001b\[[0-9;]*m/g, '');

/** Sends an API call through the worker's onmessage seam and awaits its reply. */
async function callApi(method, args = []) {
  const id = 'api-' + Math.random().toString(36).slice(2);
  const from = rt.posts.length;
  rt.sandbox.self.onmessage({ data: { type: 'api', id, method, args } });
  // Wait until the api-reply for this id lands (or a test-timeout throws).
  let reply = null;
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const found = rt.posts.slice(from).find(message => message.type === 'api-reply' && message.id === id);
    if (found) { reply = found; break; }
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.ok(reply, 'expected an api-reply for ' + method);
  return reply;
}

test('the runtime API reports its version and a stable method surface', async () => {
  const runtime = rt.sandbox.self.beownirAPI();
  assert.equal(typeof runtime.describe, 'function');
  const described = runtime.describe();
  assert.equal(described.apiVersion, '1.0.0');
  assert.equal(described.runtime.version, rt.processObj.versions.node);
  // Top-level runners are functions; the npm/fs/http/present namespaces are objects.
  for (const method of ['exec', 'spawn', 'shell', 'run']) {
    assert.equal(typeof runtime[method], 'function', 'method ' + method + ' should be a function');
  }
  for (const namespace of ['npm', 'fs', 'http', 'present']) {
    assert.equal(typeof runtime[namespace], 'object', namespace + ' should be a namespace object');
  }
  assert.equal(typeof runtime.npm.install, 'function');
  assert.equal(typeof runtime.npm.run, 'function');
  assert.equal(typeof runtime.fs.readFile, 'function');
  assert.equal(typeof runtime.fs.writeFile, 'function');
  assert.equal(typeof runtime.http.serve, 'function');
  assert.equal(typeof runtime.http.request, 'function');
});

test('fs.readFile and fs.writeFile round-trip through the virtual filesystem', async () => {
  const api = rt.sandbox.self.beownirAPI();
  await api.fs.writeFile('/project/api-demo.txt', 'hello from the api');
  const text = await api.fs.readFile('/project/api-demo.txt', 'utf8');
  assert.equal(text, 'hello from the api');
  assert.equal(await api.fs.exists('/project/api-demo.txt'), true);
  assert.equal(await api.fs.exists('/project/api-demo-missing.txt'), false);
});

test('exec runs a command and returns code, stdout and stderr', async () => {
  const reply = await callApi('exec', ['node', ['-e', 'process.stdout.write("api-exec-out"); process.stderr.write("api-exec-err")']]);
  assert.equal(reply.error, undefined);
  assert.equal(reply.result.code, 0);
  assert.equal(reply.result.stdout, 'api-exec-out');
  assert.equal(reply.result.stderr, 'api-exec-err');
});

test('exec resolves a non-zero exit as a result, and rejects a bad command', async () => {
  const failing = await callApi('exec', ['node', ['-e', 'process.exit(3)']]);
  assert.equal(failing.error, undefined);
  assert.equal(failing.result.code, 3);

  const missing = await callApi('exec', ['definitely-not-a-real-binary-xyz']);
  assert.ok(missing.error, 'a missing binary rejects with an error');
});

test('an unknown API method is answered with a structured error', async () => {
  const reply = await callApi('noSuchMethod');
  assert.ok(reply.error, 'expected an error for an unknown method');
  assert.equal(reply.error.code, 'ERR_API_UNSUPPORTED');
  assert.match(reply.error.message, /Unknown API method/);
});

test('the presentation kit paints only when color is enabled and strips cleanly', () => {
  const P = rt.sandbox.self.BeownirPresent;
  assert.ok(P, 'BeownirPresent is installed on the worker global');

  // Color off by default in a non-TTY: paint is a passthrough.
  P.setColorMode('never');
  assert.equal(P.enabled(), false);
  assert.equal(P.paint('plain', 'green'), 'plain');
  assert.equal(P.strip(P.paint('plain', 'green')), 'plain');

  // Forced color turns painting on even without a TTY — the web-page path.
  P.setColorMode('always');
  assert.equal(P.enabled(), true);
  const painted = P.paint('colored', 'green');
  assert.notEqual(painted, 'colored');
  assert.equal(P.strip(painted), 'colored');

  // Composition helpers render and strip back to their text.
  P.setColorMode('always');
  const banner = P.banner('Title', []);
  assert.match(banner, /Title/);
  assert.match(P.strip(banner), /Title/);
  const table = P.table([{ a: '1', b: '2' }, { a: '3', b: '4' }], { header: ['a', 'b'] });
  assert.match(table, /1/);
  assert.match(table, /4/);
  P.setColorMode('auto');
});

test('help text is structured, comma-punctuated and example-bearing', async () => {
  for (const [line, patterns] of [
    ['npm help', [/npm install/, /npm ci/, /npm run/, /npx/]],
    ['pnpm help', [/pnpm install/, /pnpm dlx/]],
    ['yarn help', [/yarn \[install\|add/, /yarn remove/]],
    ['bun help', [/bun \[install\|add/, /bun <file\.ts\|file\.js>/]],
  ]) {
    const res = await rt.run(line);
    assert.equal(res.code, 0, line + ' should succeed');
    const out = strip(res.stdout);
    for (const pattern of patterns) assert.match(out, pattern, line + ' help should contain ' + pattern);
    // Structured help carries an examples section rather than a flat command list.
    assert.match(out, /Examples/, line + ' help should include an Examples section');
  }
});

test('version output stays parseable while identity lines stay styled', async () => {
  for (const [line, pattern] of [
    ['npm --version', /^\d+\.\d+\.\d+\n$/],
    ['pnpm --version', /^\d+\.\d+\.\d+\n$/],
    ['yarn --version', /^\d+\.\d+\.\d+\n$/],
    ['bun --version', /^\d+\.\d+\.\d+\n$/],
  ]) {
    const res = await rt.run(line);
    assert.equal(res.code, 0);
    assert.match(strip(res.stdout), pattern, line + ' should print a bare version');
  }
  const identity = await rt.run('npm --beownir');
  assert.match(strip(identity.stdout), /not the npm executable/);
});
