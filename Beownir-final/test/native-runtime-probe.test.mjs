import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const probe = fileURLToPath(new URL('../o/native/runtime-probe.cjs', import.meta.url));

test('browser kernel reports its pinned Wasmer package when acquisition fails', () => {
  const kernel = fs.readFileSync(fileURLToPath(new URL('../o/native/native-kernel.mjs', import.meta.url)), 'utf8');
  assert.match(kernel, /Unable to acquire the browser WASIX runtime package wasmer\/edgejs@=0\.2\.5 from registry\.wasmer\.io after 3 attempts/);
  assert.match(kernel, /client\.packages\.load\('wasmer\/edgejs@=0\.2\.5'\)/);
  assert.match(kernel, /nativeProbe\.stdout\.text\(\)\.trim\(\)\.split\(\/\\r\?\\n\/\)/);
});

test('an isolated execution-group failure preserves its root cause in rejected operations', () => {
  const supervisor = fs.readFileSync(fileURLToPath(new URL('../o/native/native-supervisor.mjs', import.meta.url)), 'utf8');
  assert.match(supervisor, /retire\(engine,'Execution group failed: '/);
  assert.match(supervisor, /String\(error\?\.message\|\|error\)\.slice\(0,1200\)/);
});

test('native runtime probe exercises filesystem, TCP loopback, and worker threads independently', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'beownir-native-probe-'));
  try {
    const output = execFileSync(process.execPath, [probe], {
      encoding: 'utf8',
      timeout: 12000,
      env: { ...process.env, BEOWNIR_PROBE_ROOT: root },
    });
    const result = JSON.parse(output.trim().split('\n').at(-1));
    assert.equal(result.nodeVersion, process.versions.node);
    assert.equal(result.filesystem, true);
    assert.equal(result.tcpLoopback, true);
    assert.equal(result.workerThreads, true);
    assert.equal(fs.existsSync(path.join(root, '.native-runtime-probe')), false, 'probe cleans up its temporary file');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
