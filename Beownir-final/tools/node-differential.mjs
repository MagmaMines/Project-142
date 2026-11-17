#!/usr/bin/env node
// Runs every snippet in tools/node-differential-checks.mjs twice — once in the
// Node that is executing this file, once inside the single-file runtime — and
// compares the serialised results. `npm run differential` prints the report;
// test/node-differential.test.mjs asserts that nothing regressed.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { checks } from './node-differential-checks.mjs';

const fixtureDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'test', 'fixtures');
const fixtures = {
  'key.pem': fs.readFileSync(path.join(fixtureDir, 'rsa-2048.pem'), 'utf8'),
  'key.pub.pem': fs.readFileSync(path.join(fixtureDir, 'rsa-2048.pub.pem'), 'utf8'),
  'data.json': '{ "answer": 42 }\n',
  'reassign.js': 'exports.a = 1; module.exports = { b: 2 };\n',
  'circ.js': 'exports.seen = require("./circ").partial;\nexports.partial = "second";\n',
};

export async function runDifferential({ loadRuntime, label = 'runtime' } = {}) {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'beownir-diff-'));
  try {
    for (const [name, text] of Object.entries(fixtures)) fs.writeFileSync(path.join(workDir, name), text);
    checks.forEach(([, code], index) => fs.writeFileSync(path.join(workDir, `check-${index}.js`), `module.exports = (async () => (${code}))();\n`));
    const hostScript = path.join(workDir, 'run-host.cjs');
    fs.writeFileSync(hostScript, `
const process_ = process;
process_.chdir(${JSON.stringify(workDir)});
(async () => {
  const out = {};
  for (let index = 0; index < ${checks.length}; index++) {
    try { out[index] = { value: JSON.parse(JSON.stringify(await require('./check-' + index + '.js') ?? null)) }; }
    catch (error) { out[index] = { error: String((error && error.message) || error).split('\\n')[0].slice(0, 160) }; }
  }
  process_.stdout.write(JSON.stringify(out));
})();
`);
    const host = JSON.parse(execFileSync(process.execPath, [hostScript], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }));

    const rt = loadRuntime();
    rt.evaluate(`globalThis.__inject = (prefix, files) => {
      const touched = new Set();
      for (const name of Object.keys(files)) {
        let current = prefix + name;
        while (current !== '/' && current !== '') { const parent = current.slice(0, current.lastIndexOf('/')) || '/'; touched.add(parent); current = parent; }
      }
      for (const dir of touched) if (!__internal.FS[dir]) __internal.FS[dir] = { d: true, m: Date.now() };
      for (const [name, value] of Object.entries(files)) __internal.FS[prefix + name] = { c: value, m: Date.now() };
      return Object.keys(files).length;
    };`);
    // Every generated module has to exist in the virtual tree, not just the fixtures.
    const injected = {};
    for (const name of fs.readdirSync(workDir)) {
      if (name === 'run-host.cjs') continue;
      const full = path.join(workDir, name);
      if (fs.statSync(full).isFile()) injected[name] = fs.readFileSync(full, 'utf8');
    }
    rt.sandbox.__inject('/project/', injected);
    const runtimeRaw = await rt.evaluate(`(async () => {
      const require = CORE.module.createRequire('/project/run.js');
      const out = {};
      for (let index = 0; index < ${checks.length}; index++) {
        try {
          const value = await require('./check-' + index + '.js');
          out[index] = { value: JSON.parse(JSON.stringify(value === undefined ? null : value)) };
        } catch (error) { out[index] = { error: String((error && error.message) || error).split('\\n')[0].slice(0, 160) }; }
      }
      return JSON.stringify(out);
    })()`);
    const runtime = JSON.parse(runtimeRaw);

    const normalize = text => typeof text === 'string'
      ? text.replaceAll(workDir, '/project').replaceAll(hostScript, '/project/run.js')
      : text;
    const rows = checks.map(([name], index) => {
      const expected = JSON.parse(normalize(JSON.stringify(host[index])));
      const actual = runtime[index];
      return { name, ok: JSON.stringify(expected) === JSON.stringify(actual), expected, actual };
    });
    return { rows, passed: rows.filter(row => row.ok).length, total: rows.length, label };
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

if (process.argv[1] && process.argv[1].endsWith('node-differential.mjs')) {
  const { loadRuntime } = await import('../test/helpers/runtime.mjs');
  const report = await runDifferential({ loadRuntime });
  for (const row of report.rows) {
    if (row.ok) continue;
    console.log(`✗ ${row.name}\n  node:    ${JSON.stringify(row.expected)}\n  runtime: ${JSON.stringify(row.actual)}`);
  }
  console.log(`\n${report.passed}/${report.total} behaviours match Node ${process.versions.node}\n`);
  process.exitCode = report.passed === report.total ? 0 : 1;
}
