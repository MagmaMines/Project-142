import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadRuntime, initToolchain } from './helpers/runtime.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const rt = await initToolchain(loadRuntime({ keep: true }));
const strip = text => String(text).replace(/\u001b\[[0-9;]*m/g, '');
const write = (file, text) => {
  const parent = file.slice(0, file.lastIndexOf('/'));
  if (parent) rt.CORE.fs.mkdirSync(parent, { recursive: true });
  rt.CORE.fs.writeFileSync(file, text);
};

test('which reports yarn, bun, bunx and continues to exclude git', async () => {
  for (const bin of ['yarn', 'bun', 'bunx']) {
    const res = await rt.run('which ' + bin);
    assert.equal(res.code, 0, bin + ' should resolve in which');
    assert.equal(strip(res.stdout).trim(), '/usr/bin/' + bin + ' (virtual)');
  }
  const gitWhich = await rt.run('which git');
  assert.equal(gitWhich.code, 1, 'git must remain absent from shell commands');
  await assert.rejects(() => rt.run('git status'), /Unknown command: git/);
});

test('yarn CLI exposes version, help, init, scripts (explicit and bare), and listing', async () => {
  const ver = await rt.run('yarn --version');
  assert.equal(ver.code, 0);
  assert.match(strip(ver.stdout).trim(), /^\d+\.\d+\.\d+/);

  const help = await rt.run('yarn --help');
  assert.equal(help.code, 0);
  assert.match(strip(help.stdout), /yarn \[install\|add/);

  write('/project/package.json', JSON.stringify({
    name: 'yarn-demo',
    version: '1.0.0',
    scripts: { greet: 'node greet.js', build: 'node -e "console.log(\'BUILD_YARN_OK\')"' },
  }, null, 2));
  write('/project/greet.js', "console.log('YARN_GREET:' + process.argv.slice(2).join(','));\n");

  const runExplicit = await rt.run('yarn run greet one two');
  assert.equal(runExplicit.code, 0);
  assert.match(strip(runExplicit.stdout), /YARN_GREET:one,two/);

  const runBare = await rt.run('yarn build');
  assert.equal(runBare.code, 0);
  assert.match(strip(runBare.stdout), /BUILD_YARN_OK/);

  const list = await rt.run('yarn list');
  assert.equal(list.code, 0);
});

test('bun CLI runs JS, TS, inline -e, package scripts, and bunx resolves workspace binaries', async () => {
  const ver = await rt.run('bun --version');
  assert.equal(ver.code, 0);
  assert.match(strip(ver.stdout).trim(), /^\d+\.\d+\.\d+/);

  const help = await rt.run('bun --help');
  assert.equal(help.code, 0);
  assert.match(strip(help.stdout), /bun \[install\|add/);

  const evalRes = await rt.run('bun -e "console.log(21 * 2)"');
  assert.equal(evalRes.code, 0);
  assert.equal(strip(evalRes.stdout).trim(), '42');

  write('/project/typed.ts', 'const greeting: string = "BUN_TS_OK";\nconsole.log(greeting, process.argv.slice(2).join(","));\n');
  const tsRun = await rt.run('bun run typed.ts alpha beta');
  assert.equal(tsRun.code, 0);
  assert.equal(strip(tsRun.stdout).trim(), 'BUN_TS_OK alpha,beta');

  const tsDirect = await rt.run('bun typed.ts direct');
  assert.equal(tsDirect.code, 0);
  assert.equal(strip(tsDirect.stdout).trim(), 'BUN_TS_OK direct');

  write('/project/package.json', JSON.stringify({
    name: 'bun-demo',
    version: '1.0.0',
    scripts: { hello: 'node -e "console.log(\'BUN_SCRIPT_OK\')"' },
  }, null, 2));
  const scriptRun = await rt.run('bun run hello');
  assert.equal(scriptRun.code, 0);
  assert.match(strip(scriptRun.stdout), /BUN_SCRIPT_OK/);

  write('/project/node_modules/mini-tool/package.json', JSON.stringify({ name: 'mini-tool', version: '1.0.0', bin: { 'mini-tool': 'cli.js' } }));
  write('/project/node_modules/mini-tool/cli.js', "console.log('BUNX_OK:' + process.argv.slice(2).join(','));\n");
  const bunxRun = await rt.run('bunx mini-tool ping');
  assert.equal(bunxRun.code, 0);
  assert.match(strip(bunxRun.stdout), /BUNX_OK:ping/);
});

test('frame-kernel allowlists yarn, bun, and bunx while excluding git, and npmInstall accepts yarn/bun flags', () => {
  const frameSrc = fs.readFileSync(path.join(root, 'o', 'runtime', 'frame-kernel.js'), 'utf8');
  assert.match(frameSrc, /'npm',\s*'pnpm',\s*'yarn',\s*'bun',\s*'bunx',\s*'npx'/);
  assert.ok(!frameSrc.includes("'git'"), 'git must stay absent from frame-kernel allowlists');

  const workerSrc = fs.readFileSync(path.join(root, 'o', 'runtime', 'worker-runtime.js'), 'utf8');
  assert.match(workerSrc, /IGNORED_INSTALL_FLAGS = new Set\([^)]*'-d'[^)]*'--dev'[^)]*'-E'[^)]*'--exact'/);
});
