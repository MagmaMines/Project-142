import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { satisfies, maxSatisfying } from '../tools/framework-core.mjs';

/* The framework matrix installs packages from the npm registry, so it runs as
 * `npm run matrix` (network). What can run offline — and therefore on every
 * `npm run verify` — is the range matcher that decides which version npm would
 * install, plus the shape of the committed evidence. */

test('the range matcher agrees with npm for the ranges packages actually use', () => {
  assert.equal(satisfies('4.21.2', '^4.17.21'), true);
  assert.equal(satisfies('5.0.0', '^4.17.21'), false);
  assert.equal(satisfies('1.2.9', '~1.2.3'), true);
  assert.equal(satisfies('1.3.0', '~1.2.3'), false);
  assert.equal(satisfies('2.1.4', '>= 2.1.2 < 3.0.0'), true);
  assert.equal(satisfies('3.0.1', '>= 2.1.2 < 3.0.0'), false);
  assert.equal(satisfies('0.2.9', '^0.2.3'), true);
  assert.equal(satisfies('0.3.0', '^0.2.3'), false);
  assert.equal(satisfies('1.5.0', '1.x'), true);
  assert.equal(satisfies('2.0.0', '1.x'), false);
  assert.equal(satisfies('1.0.0', '^2.0.0 || ^1.0.0'), true);
  assert.equal(satisfies('3.0.0', '^2.0.0 || ^1.0.0'), false);
  assert.equal(satisfies('9.9.9', '*'), true);
  assert.equal(satisfies('1.0.0', '=1.0.0'), true);
});

test('prereleases only satisfy ranges that opt into them', () => {
  assert.equal(satisfies('2.0.0-beta.1', '^2.0.0'), false);
  assert.equal(satisfies('2.0.0-beta.1', '>=2.0.0-beta.0'), true);
});

test('version selection picks the highest match, not the newest release', () => {
  const versions = ['18.2.0', '18.3.1', '19.0.0', '19.1.0-rc.1', '17.0.2'];
  assert.equal(maxSatisfying(versions, '^18.0.0').text, '18.3.1');
  assert.equal(maxSatisfying(versions, '>=17 <20').text, '19.0.0');
  assert.equal(maxSatisfying(versions, '20.0.0'), undefined);
});

test('the committed matrix is real evidence, not a placeholder', () => {
  const document = JSON.parse(fs.readFileSync(new URL('../o/compat/framework-matrix.json', import.meta.url), 'utf8'));
  assert.ok(document.results.length >= 20, 'at least twenty frameworks on record');
  for (const result of document.results) {
    assert.ok(result.name, 'every row is named');
    assert.ok(result.packages > 0, result.name + ' installed packages');
    assert.ok(result.versions.length > 0, result.name + ' records the installed version');
    assert.match(result.detail, /served|rendered|answered|compiled|loaded|parsed|executed|handshake|upgraded|update after|transformed|produced|emitted|built|styled|dev HTTP|passes=|warnings=|events=|messages=|formatted|Cannot|Error/, result.name + ' records what happened');
  }
  const passing = document.results.filter(result => result.passed);
  assert.equal(passing.length, document.results.length, 'every committed row passes; --write refreshes the evidence');
  assert.ok(document.results.some(result => /ESM/i.test(result.note || '')), 'the ESM-only rows are labelled');
});
