import test from 'node:test';
import assert from 'node:assert/strict';
import { loadRuntime } from './helpers/runtime.mjs';

/* Regression tests for four runtime defects that broke real tooling:
 *   1. fs.statSync/lstatSync ignored { throwIfNoEntry: false } (stylelint);
 *   2. stream.Readable never called _read(), so pull-style producers stalled
 *      (readdirp, chokidar's directory walk);
 *   3. process lacked EventEmitter methods such as listenerCount (mocha);
 *   4. process.stdout lacked the TTY window-size API (mocha's reporters). */

const rt = loadRuntime();

test('statSync and lstatSync return undefined for a missing path when throwIfNoEntry is false', () => {
  const fs = rt.CORE.fs;
  assert.equal(fs.statSync('/project/no-such-file', { throwIfNoEntry: false }), undefined);
  assert.equal(fs.lstatSync('/project/no-such-file', { throwIfNoEntry: false }), undefined);
  assert.throws(() => fs.statSync('/project/no-such-file'), { code: 'ENOENT' });
  assert.throws(() => fs.lstatSync('/project/no-such-file'), { code: 'ENOENT' });
});

test('a pull-style Readable receives _read(highWaterMark) and streams to end', async () => {
  const result = await rt.evaluate(`(async () => {
    const { Readable } = require('stream');
    const sizes = []; let n = 0;
    class Pull extends Readable {
      constructor() { super({ objectMode: true }); }
      _read(size) { sizes.push(typeof size); if (n++ < 3) this.push({ i: n }); else this.push(null); }
    }
    const chunks = [];
    await new Promise((resolve, reject) => {
      const s = new Pull();
      s.on('data', d => chunks.push(d.i));
      s.on('end', resolve);
      s.on('error', reject);
    });
    return JSON.stringify({ chunks, sizes });
  })()`);
  const parsed = JSON.parse(result);
  assert.deepEqual(parsed.chunks, [1, 2, 3]);
  assert.ok(parsed.sizes.length >= 3 && parsed.sizes.every(type => type === 'number'));
});

test('process exposes the full EventEmitter listener surface', () => {
  const listenerCount = rt.evaluate(`(() => {
    const handler = () => {};
    process.addListener('beownir-probe', handler);
    const before = process.listenerCount('beownir-probe');
    process.removeListener('beownir-probe', handler);
    return before + ':' + process.listenerCount('beownir-probe') + ':' + typeof process.eventNames;
  })()`);
  assert.equal(listenerCount, '1:0:function');
});

test('process.stdout reports a terminal window size and colour support', () => {
  const info = rt.evaluate(`JSON.stringify({
    size: process.stdout.getWindowSize(),
    colors: process.stdout.hasColors(),
    rows: process.stdout.rows,
    columns: process.stdout.columns
  })`);
  assert.deepEqual(JSON.parse(info), { size: [80, 24], colors: true, rows: 24, columns: 80 });
});
