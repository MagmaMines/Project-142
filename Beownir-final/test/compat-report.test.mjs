import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { buildReport, summarize, baselineFile } from '../tools/compat-report.mjs';

/* The report is the evidence behind the compatibility claim, so it is tested
 * like any other product surface: it must run, and the committed baseline must
 * not drift away from what the runtime actually provides. */

const report = await buildReport();

test('the report measures real modules against the running Node', () => {
  assert.ok(report.modules >= 40, 'at least 40 Node modules are measured');
  assert.ok(report.nodeExports > 1000, 'the denominator is the real Node export count');
  assert.ok(report.overall > 0.5, 'the runtime covers more than half of the measured surface');
  assert.ok(report.perModule.path.coverage === 1, 'path is complete');
  assert.ok(report.perModule.fs.coverage > 0.6, 'fs is mostly complete');
});

test('unsupported modules still expose honest stubs instead of nothing', () => {
  for (const name of ['crypto', 'http', 'net', 'zlib', 'worker_threads']) {
    const entry = report.perModule[name];
    assert.ok(entry, name + ' is measured');
    assert.ok(entry.runtimeExports > 5, name + ' has a real surface');
  }
});

test('the committed baseline matches the current runtime', () => {
  assert.ok(fs.existsSync(baselineFile), 'o/compat/node-compat.json is committed');
  const committed = JSON.parse(fs.readFileSync(baselineFile, 'utf8'));
  const current = summarize(report);
  assert.equal(committed.modules, current.modules);
  for (const [name, entry] of Object.entries(current.perModule)) {
    const previous = committed.perModule[name];
    assert.ok(previous, name + ' exists in the baseline');
    assert.ok(entry.coverage >= previous.coverage - 0.0001, name + ' did not regress (baseline ' + previous.coverage + ', now ' + entry.coverage + ')');
  }
  assert.ok(current.overall >= committed.overall - 0.0001, 'overall coverage did not regress');
});
