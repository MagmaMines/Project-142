import test from 'node:test';
import assert from 'node:assert/strict';
import { loadRuntime } from './helpers/runtime.mjs';

/* Production-grade npm CLI surface: argument separators, manifest error
 * reporting, dependency listing and registry error wrapping. Every behavior
 * here is checked against the real runtime the browser ships, not a copy. */

const rt = loadRuntime({ keep: true });
const strip = text => String(text).replace(/\[[0-9;]*m/g, '');
// npm-style runners echo the executed command with a ">" prefix before
// the script's own output; assertions care about the script's output line.
const lastLine = text => strip(text).trim().split('\n').pop();
const write = (file, text) => {
  const parent = file.slice(0, file.lastIndexOf('/'));
  if (parent) rt.CORE.fs.mkdirSync(parent, { recursive: true });
  rt.CORE.fs.writeFileSync(file, text);
};
const resetProject = () => {
  try { rt.CORE.fs.rmSync('/project/node_modules', { recursive: true, force: true }); } catch { /* absent */ }
};
const manifest = obj => write('/project/package.json', JSON.stringify(obj, null, 2) + '\n');

test('npm run passes a leading -- separator and preserves later -- script args', async () => {
  write('/project/args.js', "console.log(process.argv.slice(2).join(','));\n");
  manifest({ name: 'args-demo', version: '1.0.0', scripts: { show: 'node args.js' } });

  const withSep = await rt.run('npm run show -- alpha --beta gamma');
  assert.equal(withSep.code, 0);
  assert.equal(lastLine(withSep.stdout), 'alpha,--beta,gamma');

  const noSep = await rt.run('npm run show alpha --beta');
  assert.equal(noSep.code, 0);
  assert.equal(lastLine(noSep.stdout), 'alpha,--beta');

  const onlySep = await rt.run('npm run show -- --flag value');
  assert.equal(onlySep.code, 0);
  assert.equal(lastLine(onlySep.stdout), '--flag,value');
});

test('npm start/dev/build/test resolve the script name and forward args', async () => {
  write('/project/args.js', "console.log('SCRIPT:' + process.argv.slice(2).join(','));\n");
  manifest({
    name: 'scripts-demo', version: '1.0.0',
    scripts: { start: 'node args.js', dev: 'node args.js', build: 'node args.js', test: 'node args.js' },
  });
  for (const cmd of ['start', 'dev', 'build', 'test']) {
    const res = await rt.run('npm ' + cmd + ' one two');
    assert.equal(res.code, 0, cmd + ' should run');
    assert.equal(lastLine(res.stdout), 'SCRIPT:one,two', cmd + ' should forward args');
  }
});

test('npm run without a script lists the manifest scripts', async () => {
  manifest({ name: 'list-demo', version: '1.0.0', scripts: { greet: 'node -e "1"', build: 'node -e "2"' } });
  const res = await rt.run('npm run');
  assert.equal(res.code, 0);
  assert.match(strip(res.stdout), /greet/);
  assert.match(strip(res.stdout), /build/);
});

test('npm run rejects an unknown script with a clear error', async () => {
  manifest({ name: 'unknown-demo', version: '1.0.0', scripts: {} });
  await assert.rejects(() => rt.run('npm run nope'), /No package script named nope/);
});

test('npm exec treats only the first -- as the separator and keeps later -- args', async () => {
  write('/project/args.js', "console.log(process.argv.slice(2).join(','));\n");
  const withSep = await rt.run('npm exec -- node args.js alpha --beta gamma');
  assert.equal(withSep.code, 0);
  assert.equal(lastLine(withSep.stdout), 'alpha,--beta,gamma');

  const noSep = await rt.run('npm exec node args.js alpha --beta');
  assert.equal(noSep.code, 0);
  assert.equal(lastLine(noSep.stdout), 'alpha,--beta');
});

test('npm ls reports declared versions and marks undeclared trees extraneous', async () => {
  manifest({ name: 'ls-demo', version: '1.0.0', dependencies: { leftpad: '1.0.0' } });
  write('/project/node_modules/leftpad/package.json', JSON.stringify({ name: 'leftpad', version: '1.0.0' }));
  write('/project/node_modules/undeclared/package.json', JSON.stringify({ name: 'undeclared', version: '2.0.0' }));

  const res = await rt.run('npm ls');
  assert.equal(res.code, 0);
  const out = strip(res.stdout);
  assert.match(out, /leftpad@1\.0\.0/);
  assert.match(out, /undeclared \(extraneous\)/);
});

test('npm ls warns when declared dependencies are not installed', async () => {
  resetProject();
  manifest({ name: 'ls-missing-demo', version: '1.0.0', dependencies: { leftpad: '1.0.0' } });
  const res = await rt.run('npm ls');
  assert.equal(res.code, 0);
  assert.match(strip(res.stdout), /Dependencies declared but not installed/);
});

test('npm view wraps a registry 404 as "no such package on the registry"', async () => {
  const previous = rt.sandbox.fetch;
  rt.sandbox.fetch = async () => new Response('{"error":"Not found"}', { status: 404, headers: { 'content-type': 'application/json' } });
  try {
    await assert.rejects(() => rt.run('npm view no-such-package-xyz'), /no such package on the registry/);
  } finally {
    rt.sandbox.fetch = previous;
  }
});

test('npm view prints name, latest version and description from the registry', async () => {
  const previous = rt.sandbox.fetch;
  rt.sandbox.fetch = async () => new Response(JSON.stringify({
    name: 'demo-pkg', 'dist-tags': { latest: '3.2.1' }, description: 'A demo package',
  }), { status: 200, headers: { 'content-type': 'application/json' } });
  try {
    const res = await rt.run('npm view demo-pkg');
    assert.equal(res.code, 0);
    const out = strip(res.stdout);
    assert.match(out, /demo-pkg/);
    assert.match(out, /3\.2\.1/);
    assert.match(out, /A demo package/);
  } finally {
    rt.sandbox.fetch = previous;
  }
});

test('npm run surfaces a missing package.json as an actionable error', async () => {
  rt.evaluate("delete __internal.getFS()['/project/package.json']");
  await assert.rejects(() => rt.run('npm run build'), /No package\.json in \/project/);
  manifest({ name: 'restore', version: '1.0.0', scripts: {} });
});

test('npm run surfaces a corrupt package.json as a JSON parse error', async () => {
  write('/project/package.json', '{ this is not json');
  await assert.rejects(() => rt.run('npm run build'), /package\.json is not valid JSON/);
  manifest({ name: 'restore', version: '1.0.0', scripts: {} });
});

test('npm run surfaces a non-object package.json root', async () => {
  write('/project/package.json', '[]');
  await assert.rejects(() => rt.run('npm run build'), /package\.json must contain a JSON object/);
  manifest({ name: 'restore', version: '1.0.0', scripts: {} });
});

test('pnpm script-name fallback surfaces manifest errors instead of "Unsupported command"', async () => {
  write('/project/package.json', '{ broken');
  await assert.rejects(() => rt.run('pnpm greet'), /package\.json is not valid JSON/);
  rt.evaluate("delete __internal.getFS()['/project/package.json']");
  await assert.rejects(() => rt.run('pnpm greet'), /No package\.json in \/project/);
  manifest({ name: 'pnpm-demo', version: '1.0.0', scripts: { greet: 'node -e "console.log(42)"' } });
  const ok = await rt.run('pnpm greet');
  assert.equal(ok.code, 0);
  assert.equal(lastLine(ok.stdout), '42');
});

test('yarn script-name fallback surfaces manifest errors instead of "Unsupported command"', async () => {
  write('/project/package.json', '{ broken');
  await assert.rejects(() => rt.run('yarn greet'), /package\.json is not valid JSON/);
  rt.evaluate("delete __internal.getFS()['/project/package.json']");
  await assert.rejects(() => rt.run('yarn greet'), /No package\.json in \/project/);
  manifest({ name: 'yarn-demo', version: '1.0.0', scripts: { greet: 'node -e "console.log(43)"' } });
  const ok = await rt.run('yarn greet');
  assert.equal(ok.code, 0);
  assert.equal(lastLine(ok.stdout), '43');
});

test('bun script-name fallback surfaces manifest errors instead of "Unsupported command"', async () => {
  write('/project/package.json', '{ broken');
  await assert.rejects(() => rt.run('bun greet'), /package\.json is not valid JSON/);
  rt.evaluate("delete __internal.getFS()['/project/package.json']");
  await assert.rejects(() => rt.run('bun greet'), /No package\.json in \/project/);
  manifest({ name: 'bun-demo', version: '1.0.0', scripts: { greet: 'node -e "console.log(44)"' } });
  const ok = await rt.run('bun greet');
  assert.equal(ok.code, 0);
  assert.equal(lastLine(ok.stdout), '44');
});

test('npm uninstall removes a dependency from the manifest and reinstalls', async () => {
  manifest({ name: 'uninstall-demo', version: '1.0.0', dependencies: { leftpad: '1.0.0' } });
  write('/project/node_modules/leftpad/package.json', JSON.stringify({ name: 'leftpad', version: '1.0.0' }));
  const res = await rt.run('npm uninstall leftpad');
  assert.equal(res.code, 0);
  const after = JSON.parse(rt.CORE.fs.readFileSync('/project/package.json', 'utf8'));
  assert.equal(after.dependencies?.leftpad, undefined);
});
