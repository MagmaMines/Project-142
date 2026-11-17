import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { readSite } from './helpers/embedded.mjs';

/* The app reports its version in six places (banner, license, release matrix,
   the origins fallback, the scaffolded README and the host). They drifted to
   rc.3 while package.json said rc.4, so the terminal greeted you with a stale
   version. This test keeps one source of truth. */

const site = readSite();
const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

test('every release-candidate string in the app matches package.json', () => {
  // Two spellings ship: the semver in code paths and the "3.0 RC.N" one in the
  // <title>. Both must name the version in package.json.
  const semver = new Set((site.match(/\b3\.0\.0-rc\.\d+\b/g) || []));
  assert.deepEqual([...semver], [pkg.version], 'index.html must not carry a stale version: ' + [...semver].join(', '));
  const [, rc] = /3\.0\.0-rc\.(\d+)/.exec(pkg.version);
  const titles = new Set(site.match(/Beownir 3\.0 RC\.\d+/g) || []);
  assert.deepEqual([...titles], ['Beownir 3.0 RC.' + rc], 'the window title must match: ' + [...titles].join(', '));
});

test('the built host carries the same version as package.json', () => {
  const host = fs.readFileSync(new URL('../o/host/beownir-host.mjs', import.meta.url), 'utf8');
  const literal = new Set((host.match(/["']3\.0\.0-rc\.\d+["']/g) || []).map(text => text.slice(1, -1)));
  assert.deepEqual([...literal], [pkg.version], 'rebuild the host after a version bump: ' + [...literal].join(', '));
});
