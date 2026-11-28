import test from 'node:test';
import assert from 'node:assert/strict';
import { loadRuntime } from './helpers/runtime.mjs';

/* The `node` command inside the shell is what developers actually type, so this
 * suite drives it the way a terminal does and asserts on exit codes and on the
 * exact reporter output (file:line, source line, caret, version trailer). */

const rt = loadRuntime();
const write = (path, text) => {
  const parent = path.slice(0, path.lastIndexOf('/'));
  if (parent) rt.CORE.fs.mkdirSync(parent, { recursive: true });
  rt.CORE.fs.writeFileSync(path, text);
};
const strip = text => String(text).replace(/\u001b\[[0-9;]*m/g, '');
const settle = () => new Promise(resolve => setTimeout(resolve, 60));

test.beforeEach(() => { rt.restore(); });

test('node runs a CJS entry, resolves siblings and reports argv', async () => {
  write('/project/dep.js', 'module.exports = { value: 42, doubled: n => n * 2 };\n');
  write('/project/main.js', [
    "const dep = require('./dep.js');",
    "console.log('value', dep.value, dep.doubled(21));",
    "console.log('argv', JSON.stringify(process.argv.slice(1)));",
    "console.log('main', require.main === module);",
    "console.log('dirname', __dirname, 'file', __filename);",
    "console.log('json', require('./data.json').answer);",
  ].join('\n'));
  write('/project/data.json', '{ "answer": 42 }\n');
  const result = await rt.run('node main.js extra --flag');
  const lines = strip(result.stdout).trim().split('\n');
  assert.equal(result.code, 0);
  assert.equal(lines[0], 'value 42 42');
  assert.equal(lines[1], 'argv ["/project/main.js","extra","--flag"]');
  assert.equal(lines[2], 'main true');
  assert.equal(lines[3], 'dirname /project file /project/main.js');
  assert.equal(lines[4], 'json 42');
});

test('node -e and node -p evaluate inline code', async () => {
  const evalResult = await rt.run('node -e "console.log(6 * 7)"');
  assert.equal(evalResult.code, 0);
  assert.equal(strip(evalResult.stdout).trim().split('\n')[0], '42');
  const printResult = await rt.run('node -p "6 * 7"');
  assert.equal(printResult.code, 0);
  assert.equal(strip(printResult.stdout).trim().split('\n')[0], '42');
  const withRequire = await rt.run('node -e "console.log(typeof require(\\"path\\").join)"');
  assert.equal(strip(withRequire.stdout).trim().split('\n')[0], 'function');
});

test('a throwing entry exits 1 with the Node crash report', async () => {
  write('/project/boom.js', "console.log('before');\nthrow new Error('kaboom');\n");
  const result = await rt.run('node boom.js');
  assert.equal(result.code, 1);
  assert.equal(strip(result.stdout).trim().split('\n')[0], 'before');
  const error = strip(result.stderr);
  assert.match(error, /\/project\/boom\.js:2/, 'prints file:line');
  assert.match(error, /throw new Error\('kaboom'\);/, 'prints the source line');
  assert.match(error, /\n\s*\^/, 'prints the caret');
  assert.match(error, /Error: kaboom/);
  assert.match(error, /Node\.js v\d+\./, 'prints the version trailer');
});

test('process.exitCode drives the exit status without aborting the script', async () => {
  write('/project/status.js', "process.exitCode = 3;\nconsole.log('still running');\n");
  const result = await rt.run('node status.js');
  assert.equal(result.code, 3);
  assert.match(strip(result.stdout), /still running/);
});

test('an exception thrown from a timer is reported, not swallowed', async () => {
  write('/project/late.js', "setTimeout(() => { throw new Error('later'); }, 5);\nconsole.log('scheduled');\n");
  const from = rt.posts.length;
  const result = await rt.run('node late.js');
  await settle();
  // The crash arrives after the command returned, exactly like Node's event loop.
  const late = strip(rt.posts.slice(from).filter(message => message.type === 'stderr').map(message => String(message.data)).join(''));
  const error = late;
  assert.match(error, /\/project\/late\.js:1/, 'late failures point at their file');
  assert.match(error, /Error: later/);
  assert.equal(rt.evaluate('SHELL.lastCode'), 1);
});

test('ESM entries import builtins and local modules', async () => {
  write('/project/esm-dep.mjs', 'export const answer = 21;\nexport default n => n * 2;\n');
  write('/project/esm.mjs', [
    "import { readFileSync } from 'node:fs';",
    "import def, { answer } from './esm-dep.mjs';",
    "console.log('esm', answer, def(answer));",
    "console.log('fs', typeof readFileSync);",
  ].join('\n'));
  const result = await rt.run('node esm.mjs');
  const lines = strip(result.stdout).trim().split('\n');
  assert.equal(result.code, 0);
  assert.equal(lines[0], 'esm 21 42');
  assert.equal(lines[1], 'fs function');
});

test('node -v, node --version and a missing entry behave like the real CLI', async () => {
  const version = await rt.run('node -v');
  assert.match(strip(version.stdout).trim(), /^v\d+\.\d+\.\d+/);
  const longVersion = await rt.run('node --version');
  assert.equal(strip(longVersion.stdout).trim(), strip(version.stdout).trim());
  const missing = await rt.run('node nope.js');
  assert.notEqual(missing.code, 0);
  assert.match(strip(missing.stderr) + strip(missing.stdout), /nope\.js/);
});

test('npm ls and npm run work from the project', async () => {
  write('/project/package.json', JSON.stringify({ name: 'demo', version: '1.0.0', scripts: { hello: 'node hello.js' } }, null, 2));
  write('/project/hello.js', "console.log('hello from a script');\n");
  const listing = await rt.run('npm ls');
  assert.equal(listing.code, 0);
  const script = await rt.run('npm run hello');
  assert.equal(script.code, 0);
  assert.match(strip(script.stdout), /hello from a script/);
});

test('package manager --help flags and bare node print full CLI help without disclaimers', async () => {
  const bareNode = strip((await rt.run('node')).stdout);
  assert.match(bareNode, /Usage: node <file>/);
  assert.doesNotMatch(bareNode, /not embedded/);

  const npmHelp = strip((await rt.run('npm --help')).stdout);
  assert.match(npmHelp, /npm ci/);
  assert.doesNotMatch(npmHelp, /browser-native subset/);

  const pnpmHelp = strip((await rt.run('pnpm --help')).stdout);
  assert.match(pnpmHelp, /pnpm dlx/);

  const yarnHelp = strip((await rt.run('yarn --help')).stdout);
  assert.match(yarnHelp, /yarn remove/);
  assert.doesNotMatch(yarnHelp, /not the yarn executable/);

  const bunHelp = strip((await rt.run('bun --help')).stdout);
  assert.match(bunHelp, /bun <file\.ts\|file\.js>/);

  const viteHelp = strip((await rt.run('npx vite --help')).stdout);
  assert.match(viteHelp, /Usage: vite/);
  const serveHelp = strip((await rt.run('npx serve --help')).stdout);
  assert.match(serveHelp, /Usage: serve/);
});

test('local bin symlinks (relative and absolute), serve dir, and vite dev flags work cleanly', async () => {
  write('/project/tools/abs-cli.js', "console.log('abs-ok', process.argv.slice(2).join(','));\n");
  rt.CORE.fs.mkdirSync('/project/node_modules/.bin', { recursive: true });
  rt.CORE.fs.symlinkSync('/project/tools/abs-cli.js', '/project/node_modules/.bin/abs-cli');
  const absRes = await rt.run('abs-cli one two');
  assert.equal(absRes.code, 0);
  assert.match(strip(absRes.stdout), /abs-ok one,two/);

  write('/project/pub/index.html', '<h1>Served Dir</h1>\n');
  const serveRes = await rt.run('npx serve /project/pub --port 4567');
  assert.equal(serveRes.code, 0);
  assert.match(strip(serveRes.stdout), /Serving \/project\/pub on http:\/\/127\.0\.0\.1:4567\//);
  assert.doesNotMatch(strip(serveRes.stdout), /No HMR/);
  const fetched = await rt.evaluate('(async () => { const r = await fetch("http://127.0.0.1:4567/"); return { status: r.status, text: await r.text() }; })()');
  assert.equal(fetched.status, 200);
  assert.match(fetched.text, /Served Dir/);
  await rt.run('close-port 4567');

  write('/project/node_modules/vite/package.json', JSON.stringify({ name: 'vite', version: '6.4.6', main: 'index.js' }));
  write('/project/node_modules/vite/index.js', [
    'const calls = globalThis.__viteCalls = [];',
    'module.exports = {',
    "  version: '6.4.6',",
    '  async createServer(cfg) { calls.push(cfg); return { httpServer: { address: () => ({ port: cfg.server.port }) }, async listen() {} }; },',
    '  async build(cfg) { calls.push(cfg); return { output: [{ fileName: "app.js" }] }; },',
    '};',
  ].join('\n'));
  const viteRes = await rt.run('npx vite dev --host -p 4568 --open --clearScreen=false');
  assert.equal(viteRes.code, 0);
  assert.match(strip(viteRes.stdout), /VITE v6\.4\.6 ready at http:\/\/127\.0\.0\.1:4568\//);
  const calls = rt.evaluate('globalThis.__viteCalls');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].root, '/project');
  assert.equal(calls[0].server.host, '127.0.0.1');
  assert.equal(calls[0].server.port, 4568);
});
