#!/usr/bin/env node
/* Measures the embedded runtime's Node API surface against the Node that runs
 * this script, so "Node compatibility" is a number with a diff attached instead
 * of a claim. The report is committed as a baseline: coverage may improve
 * freely, and CI fails if any module regresses. */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadRuntime } from '../test/helpers/runtime.mjs';

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const baselineFile = path.join(root, 'o', 'compat', 'node-compat.json');

/** Exports of the Node builtin with this name, or null when Node has no such module. */
/* Own property names on both sides: a namespace export and a shim property are
 * the same contract whether or not it is enumerable, and Node exposes a few
 * (process.pid, util.setTraceSigInt) as own non-enumerable members in places. */
const surfaceOf = object => new Set(
  typeof object === 'object' || typeof object === 'function'
    ? Object.getOwnPropertyNames(object).filter(key => key !== 'default' && !key.startsWith('__beownir'))
    : [],
);

async function nodeExports(name) {
  try {
    const module = await import('node:' + name);
    return surfaceOf(module);
  } catch {
    return null;
  }
}

/** Every builtin the running Node advertises, split into public modules and the
 * deprecated `_`-prefixed internals. `node:test` is a builtin that
 * `builtinModules` does not list, so it is added explicitly. */
export function nodeBuiltins(moduleApi) {
  const listed = moduleApi.builtinModules || [];
  const publicNames = [...new Set([...listed.filter(name => !name.startsWith('_')), 'test'])].sort();
  const internalNames = listed.filter(name => name.startsWith('_')).sort();
  return { publicNames, internalNames };
}

async function measure(names, runtime) {
  const modules = {};
  for (const name of names) {
    const expected = await nodeExports(name);
    // A name the running Node cannot import is not part of this Node's contract.
    if (!expected || !expected.size) continue;
    const present = Object.hasOwn(runtime.CORE, name) && runtime.CORE[name] != null;
    const actual = surfaceOf(present ? runtime.CORE[name] : {});
    const missing = [...expected].filter(key => !actual.has(key)).sort();
    const extra = [...actual].filter(key => !expected.has(key)).sort();
    const covered = expected.size - missing.length;
    modules[name] = {
      present,
      nodeExports: expected.size,
      runtimeExports: actual.size,
      coverage: Number((covered / expected.size).toFixed(4)),
      missing,
      extra,
    };
  }
  const entries = Object.values(modules);
  const expectedTotal = entries.reduce((sum, entry) => sum + entry.nodeExports, 0);
  const coveredTotal = entries.reduce((sum, entry) => sum + Math.round(entry.coverage * entry.nodeExports), 0);
  return {
    modules,
    implemented: entries.filter(entry => entry.present).length,
    total: entries.length,
    nodeExports: expectedTotal,
    covered: coveredTotal,
    overall: expectedTotal ? Number((coveredTotal / expectedTotal).toFixed(4)) : 1,
  };
}

export async function buildReport() {
  const runtime = loadRuntime();
  const { publicNames, internalNames } = nodeBuiltins(await import('node:module'));
  /* Scoring starts from Node's own module list, not from `Object.keys(CORE)`.
   * That was the blind spot that let six builtins go missing without moving the
   * number: an absent module was invisible instead of scoring zero. */
  const scored = await measure(publicNames, runtime);
  const internals = await measure(internalNames, runtime);
  const unimplemented = Object.entries(scored.modules).filter(([, entry]) => !entry.present).map(([name]) => name);
  const skipped = Object.keys(runtime.CORE).filter(name => !Object.hasOwn(scored.modules, name));
  return {
    generatedAt: new Date().toISOString(),
    node: process.versions.node,
    runtime: runtime.processObj.version,
    modules: scored.total,
    implementedModules: scored.implemented,
    unimplementedModules: unimplemented,
    // Browser-only entries with no Node counterpart (crypto/webcrypto).
    skippedRuntimeModules: skipped,
    nodeExports: scored.nodeExports,
    covered: scored.covered,
    overall: scored.overall,
    internals: {
      modules: internals.total,
      implementedModules: internals.implemented,
      nodeExports: internals.nodeExports,
      covered: internals.covered,
      overall: internals.overall,
      perModule: internals.modules,
    },
    perModule: scored.modules,
  };
}

/** Compact form committed to the repository: coverage plus the first gaps. */
export function summarize(report) {
  const perModule = {};
  for (const [name, entry] of Object.entries(report.perModule)) {
    perModule[name] = { coverage: entry.coverage, missingCount: entry.missing.length, missing: entry.missing.slice(0, 12) };
  }
  return {
    generatedAt: report.generatedAt,
    node: report.node,
    runtime: report.runtime,
    modules: report.modules,
    implementedModules: report.implementedModules,
    unimplementedModules: report.unimplementedModules,
    skippedRuntimeModules: report.skippedRuntimeModules,
    nodeExports: report.nodeExports,
    covered: report.covered,
    overall: report.overall,
    internals: { modules: report.internals.modules, implementedModules: report.internals.implementedModules, nodeExports: report.internals.nodeExports, covered: report.internals.covered, overall: report.internals.overall },
    baseline: report.overall,
    perModule,
  };
}

function printTable(report) {
  const rows = Object.entries(report.perModule).sort((a, b) => a[1].coverage - b[1].coverage || a[0].localeCompare(b[0]));
  const width = Math.max(...rows.map(([name]) => name.length), 6);
  console.log('module'.padEnd(width) + '  cover   runtime/node   first gaps');
  for (const [name, entry] of rows) {
    const percent = (entry.coverage * 100).toFixed(1).padStart(5);
    const counts = String(entry.runtimeExports).padStart(6) + ' /' + String(entry.nodeExports).padEnd(5);
    console.log(name.padEnd(width) + '  ' + percent + '%' + '  ' + counts + '   ' + entry.missing.slice(0, 6).join(', '));
  }
  console.log('\noverall ' + (report.overall * 100).toFixed(1) + '% of ' + report.nodeExports + ' Node exports across ' + report.modules + ' modules (' + report.implementedModules + ' implemented) on Node ' + report.node);
  if (report.unimplementedModules.length) console.log('not implemented at all (scored 0%): ' + report.unimplementedModules.join(', '));
  if (report.skippedRuntimeModules.length) console.log('runtime-only modules with no Node counterpart: ' + report.skippedRuntimeModules.join(', '));
  console.log('deprecated internals (_*): ' + (report.internals.overall * 100).toFixed(1) + '% of ' + report.internals.nodeExports + ' exports across ' + report.internals.modules + ' modules, reported separately');
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const report = await buildReport();
  if (process.argv.includes('--json')) { console.log(JSON.stringify(report, null, 2)); }
  else {
    printTable(report);
    if (process.argv.includes('--write')) {
      fs.mkdirSync(path.dirname(baselineFile), { recursive: true });
      fs.writeFileSync(baselineFile, JSON.stringify(summarize(report), null, 2) + '\n');
      console.log('\nwrote ' + path.relative(root, baselineFile));
    }
    const failUnder = process.argv.indexOf('--fail-under');
    if (failUnder >= 0) {
      const threshold = Number(process.argv[failUnder + 1]);
      if (!Number.isFinite(threshold)) { console.error('--fail-under needs a number (0..1)'); process.exitCode = 2; }
      else if (report.overall < threshold) { console.error('compatibility regressed: ' + (report.overall * 100).toFixed(1) + '% < ' + (threshold * 100).toFixed(1) + '%'); process.exitCode = 1; }
    }
  }
}
