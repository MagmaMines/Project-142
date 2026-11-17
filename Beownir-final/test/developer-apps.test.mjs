import test from 'node:test';
import assert from 'node:assert/strict';
import { loadRuntime } from './helpers/runtime.mjs';

/* "Compatible" is not an export count. These are small but real programs, of the
 * kind a developer writes on the first day after moving Node code into the
 * browser: a JSON API, a CLI that parses argv and stdin, a stream pipeline, a
 * signed-token helper, an ESM module graph and a timer-driven job queue. Each is
 * written into the virtual project and run through the terminal, so the module
 * loader, the shell, process.exitCode and stdout all take part. */

const rt = loadRuntime();
const plain = value => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));
const evaluate = async code => plain(await rt.evaluate(code));
const write = (path, lines) => evaluate(`(() => {
  const fs = require('fs');
  fs.mkdirSync(${JSON.stringify(path.slice(0, path.lastIndexOf('/')))}, { recursive: true });
  fs.writeFileSync(${JSON.stringify(path)}, ${JSON.stringify(lines.join('\n') + '\n')});
  return true;
})()`);
const read = path => evaluate(`require('fs').readFileSync(${JSON.stringify(path)}, 'utf8')`);
const run = async line => rt.run(line);

/* The shell returns as soon as the entry file has been evaluated; timers and
 * virtual servers keep running afterwards, exactly as a real Node process
 * would. Poll the terminal stream until the program says it finished. */
const runAndWait = async (line, marker, timeout = 3000) => {
  const from = rt.posts.length;
  const result = await rt.run(line);
  const collected = () => {
    const messages = rt.posts.slice(from);
    return {
      stdout: messages.filter(message => message.type === 'stdout').map(message => String(message.data)).join(''),
      stderr: messages.filter(message => message.type === 'stderr').map(message => String(message.data)).join(''),
    };
  };
  const deadline = Date.now() + timeout;
  while (!collected().stdout.includes(marker) && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 15));
  }
  return { ...result, ...collected() };
};

test.beforeEach(() => rt.restore());

test('a JSON API server answers a routed request end to end', async () => {
  await write('/project/api/server.js', [
    "const http = require('node:http');",
    '',
    'const routes = {',
    "  'GET /health': (req, res) => res.end(JSON.stringify({ ok: true, pid: process.pid })),",
    "  'GET /items': (req, res) => {",
    "    const url = new URL(req.url, 'http://localhost');",
    "    const limit = Number(url.searchParams.get('limit') || 3);",
    "    res.writeHead(200, { 'content-type': 'application/json' });",
    '    res.end(JSON.stringify({ items: Array.from({ length: limit }, (_, index) => ({ id: index + 1 })) }));',
    '  },',
    '};',
    '',
    'const server = http.createServer((req, res) => {',
    '  const key = req.method + " " + req.url.split("?")[0];',
    '  const handler = routes[key];',
    '  if (!handler) { res.statusCode = 404; res.end(JSON.stringify({ error: "not found", route: key })); return; }',
    '  handler(req, res);',
    '});',
    '',
    'server.listen(0, async () => {',
    '  const port = server.address().port;',
    "  const get = path => new Promise((resolve, reject) => {",
    "    require('node:http').get({ port, path }, response => {",
    "      let body = '';",
    "      response.on('data', chunk => { body += chunk; });",
    "      response.on('end', () => resolve({ status: response.statusCode, body }));",
    '    }).on("error", reject);',
    '  });',
    "  const health = await get('/health');",
    "  const items = await get('/items?limit=2');",
    "  const missing = await get('/nope');",
    '  console.log(JSON.stringify({',
    '    health: [health.status, JSON.parse(health.body).ok, typeof JSON.parse(health.body).pid],',
    '    items: [items.status, JSON.parse(items.body).items.length],',
    '    missing: [missing.status, JSON.parse(missing.body).error],',
    '  }));',
    '  server.close();',
    '});',
    '',
  ]);
  const result = await runAndWait('node api/server.js', '"missing"');
  assert.equal(result.code, 0, result.stderr);
  const report = JSON.parse(result.stdout.trim());
  assert.deepEqual(report.health, [200, true, 'number']);
  assert.deepEqual(report.items, [200, 2]);
  assert.deepEqual(report.missing, [404, 'not found']);
});

test('a CLI parses flags, positionals and stdin like a Node script', async () => {
  await write('/project/data/sales.csv', [
    'region,amount',
    'north,10',
    'south,25',
    'north,5',
    'east,7',
  ]);
  await write('/project/tools/sum.js', [
    '#!/usr/bin/env node',
    "const fs = require('node:fs');",
    '',
    'const args = process.argv.slice(2);',
    'let field = 1;',
    'let source = null;',
    'for (let index = 0; index < args.length; index += 1) {',
    "  if (args[index] === '--field') field = Number(args[index + 1]);",
    "  else if (args[index] === '--json') source = 'json';",
    "  else if (!args[index].startsWith('-')) source = args[index];",
    '}',
    '',
    "const text = source && source !== 'json' ? fs.readFileSync(source, 'utf8') : fs.readFileSync(0, 'utf8');",
    'const rows = text.trim().split("\\n").slice(1).map(line => line.split(","));',
    'const total = rows.reduce((sum, row) => sum + Number(row[field]), 0);',
    'if (args.includes("--json")) console.log(JSON.stringify({ rows: rows.length, total }));',
    "else console.log(rows.length + ' rows, total ' + total);",
    '',
  ]);

  const fromFile = await run('node tools/sum.js --field 1 data/sales.csv');
  assert.equal(fromFile.code, 0, fromFile.stderr);
  assert.match(fromFile.stdout, /4 rows, total 47/);

  const fromStdin = await run('cat data/sales.csv | node tools/sum.js --field 1 --json');
  assert.equal(fromStdin.code, 0, fromStdin.stderr);
  assert.deepEqual(JSON.parse(fromStdin.stdout.trim()), { rows: 4, total: 47 });

  // A failing script sets a non-zero exit code and stops an && chain.
  await write('/project/tools/fail.js', [
    "console.error('boom');",
    'process.exitCode = 3;',
    '',
  ]);
  const failure = await run('node tools/fail.js && echo unreachable');
  assert.equal(failure.code, 3);
  assert.match(failure.stderr, /boom/);
  assert.ok(!/unreachable/.test(failure.stdout), 'the && chain stopped');
});

test('a stream pipeline compresses a file and reads it back', async () => {
  await write('/project/streams/input.txt', Array.from({ length: 50 }, (_, index) => 'line ' + (index + 1)));
  await write('/project/streams/pipeline.js', [
    "const fs = require('node:fs');",
    "const zlib = require('node:zlib');",
    "const { pipeline } = require('node:stream');",
    "const { Transform } = require('node:stream');",
    '',
    'const source = fs.createReadStream("/project/streams/input.txt");',
    "const upper = new Transform({ transform(chunk, encoding, callback) { callback(null, chunk.toString().toUpperCase()); } });",
    'const gzip = zlib.createGzip();',
    'const target = fs.createWriteStream("/project/streams/output.txt.gz");',
    '',
    'pipeline(source, upper, gzip, target, error => {',
    '  if (error) { console.error(error.message); process.exitCode = 1; return; }',
    '  const compressed = fs.readFileSync("/project/streams/output.txt.gz");',
    '  const restored = zlib.gunzipSync(compressed).toString();',
    '  console.log(JSON.stringify({ bytes: compressed.length, lines: restored.trim().split("\\n").length, upper: restored.includes("LINE 50") }));',
    '});',
    '',
  ]);
  const result = await runAndWait('node streams/pipeline.js', '"upper"');
  assert.equal(result.code, 0, result.stderr);
  const report = JSON.parse(result.stdout.trim());
  assert.equal(report.lines, 50);
  assert.equal(report.upper, true);
  assert.ok(report.bytes > 0);
});

test('a signed-token helper round-trips and rejects tampering', async () => {
  await write('/project/auth/token.js', [
    "const crypto = require('node:crypto');",
    '',
    "const SECRET = 'dev-secret';",
    'const sign = payload => crypto.createHmac("sha256", SECRET).update(payload).digest("base64url");',
    'const issue = data => {',
    '  const body = Buffer.from(JSON.stringify(data)).toString("base64url");',
    '  return body + "." + sign(body);',
    '};',
    'const verify = token => {',
    '  const [body, signature] = String(token).split(".");',
    '  if (!body || !signature) return { ok: false, reason: "malformed" };',
    '  const expected = Buffer.from(sign(body));',
    '  const actual = Buffer.from(signature);',
    '  if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) return { ok: false, reason: "bad-signature" };',
    '  return { ok: true, data: JSON.parse(Buffer.from(body, "base64url").toString()) };',
    '};',
    '',
    'const token = issue({ user: "ada", role: "admin" });',
    'const good = verify(token);',
    'const tampered = token.slice(0, -2) + (token.endsWith("A") ? "BB" : "AA");',
    'const bad = verify(tampered);',
    'const random = crypto.randomBytes(8).toString("hex");',
    'console.log(JSON.stringify({ good: [good.ok, good.data.user, good.data.role], bad: [bad.ok, bad.reason], tokenParts: token.split(".").length, randomLength: random.length }));',
    '',
  ]);
  const result = await run('node auth/token.js');
  assert.equal(result.code, 0, result.stderr);
  const report = JSON.parse(result.stdout.trim());
  assert.deepEqual(report.good, [true, 'ada', 'admin']);
  assert.deepEqual(report.bad, [false, 'bad-signature']);
  assert.equal(report.tokenParts, 2);
  assert.equal(report.randomLength, 16);
});

test('an ESM app with named exports and top-level await runs', async () => {
  await write('/project/esm/math.mjs', [
    'export const add = (a, b) => a + b;',
    'export const double = value => value * 2;',
    'export default { name: "math" };',
  ]);
  await write('/project/esm/app.mjs', [
    "import { add, double } from './math.mjs';",
    "import path from 'node:path';",
    "import { fileURLToPath } from 'node:url';",
    '',
    'const delay = ms => new Promise(resolve => setTimeout(resolve, ms));',
    'await delay(5);',
    'const total = double(add(1, 2));',
    "console.log(JSON.stringify({ total, dir: path.basename('/project/esm/app.mjs') }));",
    '',
  ]);
  const result = await run('node esm/app.mjs');
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout.trim()), { total: 6, dir: 'app.mjs' });
});

test('a timer-driven job queue drains in order and exits by itself', async () => {
  await write('/project/queue/queue.js', [
    "const { EventEmitter } = require('node:events');",
    '',
    'class Queue extends EventEmitter {',
    '  constructor(limit) { super(); this.limit = limit; this.running = 0; this.pending = []; this.done = []; }',
    '  add(job) { this.pending.push(job); this.pump(); return this; }',
    '  pump() {',
    '    while (this.running < this.limit && this.pending.length) {',
    '      const job = this.pending.shift();',
    '      this.running += 1;',
    '      setTimeout(() => {',
    '        job.run(() => {',
    '          this.running -= 1;',
    '          this.done.push(job.name);',
    '          this.emit("done", job.name);',
    '          this.pump();',
    '        });',
    '      }, job.delay);',
    '    }',
    '    if (!this.running && !this.pending.length) this.emit("drain", this.done);',
    '  }',
    '}',
    '',
    'const queue = new Queue(2);',
    'const finished = [];',
    'queue.on("done", name => finished.push(name));',
    'queue.on("drain", names => console.log(JSON.stringify({ finished, drained: names.length })));',
    "[['a', 5], ['b', 1], ['c', 3], ['d', 1]].forEach(([name, delay]) => queue.add({ name, delay, run: done => setTimeout(done, delay) }));",
    '',
  ]);
  const result = await runAndWait('node queue/queue.js', '"drained"');
  assert.equal(result.code, 0, result.stderr);
  const report = JSON.parse(result.stdout.trim());
  assert.equal(report.drained, 4);
  assert.equal(report.finished.length, 4);
  assert.deepEqual([...report.finished].sort(), ['a', 'b', 'c', 'd']);
});

test('a program that throws mid-run reports the stack and exits 1', async () => {
  await write('/project/tools/crash.js', [
    'function parse(config) {',
    '  return JSON.parse(config);',
    '}',
    "parse('{ nope }');",
    '',
  ]);
  const result = await run('node tools/crash.js');
  assert.equal(result.code, 1);
  assert.match(result.stderr, /SyntaxError/);
  assert.match(result.stderr, /at parse/);
  assert.match(result.stderr, /crash\.js/);
});

test('a program that reads a missing config fails the way Node does', async () => {
  await write('/project/tools/config.js', [
    "const fs = require('node:fs');",
    'try {',
    '  fs.readFileSync("/project/config.json", "utf8");',
    '} catch (error) {',
    '  console.error(error.code, error.syscall);',
    '  process.exit(2);',
    '}',
    '',
  ]);
  const result = await run('node tools/config.js');
  assert.equal(result.code, 2);
  assert.match(result.stderr, /ENOENT/);
  assert.match(result.stderr, /open/);
});

test('a script piped into node runs the way it does in Node', async () => {
  await write('/project/pipes/script.js', [
    "const fs = require('node:fs');",
    'const total = [1, 2, 3, 4].reduce((a, b) => a + b, 0);',
    'console.log("total " + total);',
    'console.error("from stderr");',
  ]);
  const piped = await run('cat pipes/script.js | node');
  assert.equal(piped.code, 0, piped.stderr);
  assert.match(piped.stdout, /total 10/);
  assert.match(piped.stderr, /from stderr/);

  // argv matches Node exactly: `node < script` has no argv[1], while `node - a b`
  // reports '-' and the trailing arguments.
  await write('/project/pipes/argv.js', [
    'console.log(JSON.stringify({ script: process.argv[1] ?? null, extra: process.argv.slice(2) }));',
  ]);
  const implicit = await run('cat pipes/argv.js | node');
  assert.equal(implicit.code, 0, implicit.stderr);
  assert.deepEqual(JSON.parse(implicit.stdout.trim()), { script: null, extra: [] });
  const explicit = await run('cat pipes/argv.js | node - x y');
  assert.equal(explicit.code, 0, explicit.stderr);
  assert.deepEqual(JSON.parse(explicit.stdout.trim()), { script: '-', extra: ['x', 'y'] });
});
