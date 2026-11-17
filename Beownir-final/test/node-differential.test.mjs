import test from 'node:test';
import assert from 'node:assert/strict';
import { runDifferential } from '../tools/node-differential.mjs';
import { loadRuntime } from './helpers/runtime.mjs';

/* Every snippet in tools/node-differential-checks.mjs runs in this Node process
 * and inside the single-file runtime; the serialised results must be identical.
 * This is the evidence behind the "behaves like Node" claims in the README. */

const report = await runDifferential({ loadRuntime });

test(`all ${report.total} runtime behaviours match Node ${process.versions.node}`, () => {
  const mismatches = report.rows.filter(row => !row.ok)
    .map(row => `${row.name}: node=${JSON.stringify(row.expected)} runtime=${JSON.stringify(row.actual)}`);
  assert.deepEqual(mismatches, [], mismatches.join('\n'));
  assert.equal(report.passed, report.total);
});
