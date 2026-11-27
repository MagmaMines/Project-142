import test from 'node:test';
import assert from 'node:assert/strict';
import { loadRuntime } from './helpers/runtime.mjs';

const plain = value => JSON.parse(JSON.stringify(value));

test('SharedArrayBuffer decoding, StringDecoder and SPSC ring mailbox behave safely', () => {
  const rt = loadRuntime({ keep: true });
  const result = plain(rt.evaluate(`(() => {
    const { StringDecoder } = CORE.string_decoder;
    const sab = new SharedArrayBuffer(32);
    const view = new Uint8Array(sab);
    view.set(Buffer.from('shared-utf8-bytes'));
    const bufView = Buffer.from(sab, 0, 17);
    const dec = new StringDecoder('utf8');
    const decoded = dec.write(bufView) + dec.end();

    const ring = createSabRing(256);
    const s1 = ringTryPush(ring, { seq: 1, label: 'alpha' });
    const s2 = ringTryPush(ring, { seq: 2, label: 'beta' });
    const s3 = ringTryPush(ring, { seq: 3, label: 'gamma' });
    const pop1 = ringTryPop(ring);
    const ackDup = ringAckSeq(ring, s1);
    const ack2 = ringAckSeq(ring, s2);
    const pop3 = ringTryPop(ring);
    const empty = ringTryPop(ring);
    return {
      decoded,
      bufStr: bufView.toString('utf8'),
      seqs: [s1, s2, s3],
      pop1,
      ackDup,
      ack2,
      pop3,
      empty,
    };
  })()`));
  assert.equal(result.decoded, 'shared-utf8-bytes');
  assert.equal(result.bufStr, 'shared-utf8-bytes');
  assert.deepEqual(result.seqs, [1, 2, 3]);
  assert.deepEqual(result.pop1, { message: { seq: 1, label: 'alpha' } });
  assert.equal(result.ackDup, false);
  assert.equal(result.ack2, true);
  assert.deepEqual(result.pop3, { message: { seq: 3, label: 'gamma' } });
  assert.equal(result.empty, null);
});

test('WASI preview1 syscalls operate on SharedArrayBuffer-backed WebAssembly.Memory', () => {
  const rt = loadRuntime({ keep: true });
  const result = plain(rt.evaluate(`(() => {
    const req = CORE.module.createRequire('/project/index.js');
    const fs = req('fs');
    const { WASI } = req('wasi');
    fs.writeFileSync('/project/wasi-sab-probe.txt', 'WASI_SAB_DATA');
    const memory = new WebAssembly.Memory({ initial: 1, maximum: 2, shared: true });
    const bytes = new Uint8Array(memory.buffer);
    bytes.set(Buffer.from('wasi-sab-probe.txt'), 16);
    const wasi = new WASI({ version: 'preview1', preopens: { '/': '/project' }, memory });
    const fdPtr = 256, statPtr = 512, iovPtr = 640, dataPtr = 768, nreadPtr = 896;
    const rcOpen = wasi.wasiImport.path_open(3, 0, 16, 18, 0, 0n, 0n, 0, fdPtr);
    const fd = new DataView(memory.buffer).getUint32(fdPtr, true);
    const rcStat = wasi.wasiImport.fd_filestat_get(fd, statPtr);
    const size = Number(new DataView(memory.buffer).getBigUint64(statPtr + 32, true));
    const dv = new DataView(memory.buffer);
    dv.setUint32(iovPtr, dataPtr, true);
    dv.setUint32(iovPtr + 4, 32, true);
    const rcRead = wasi.wasiImport.fd_read(fd, iovPtr, 1, nreadPtr);
    const nread = dv.getUint32(nreadPtr, true);
    const text = Buffer.from(bytes.slice(dataPtr, dataPtr + nread)).toString('utf8');
    wasi.wasiImport.fd_close(fd);
    return { isShared: memory.buffer instanceof SharedArrayBuffer, rcOpen, rcStat, size, rcRead, nread, text };
  })()`));
  assert.deepEqual(result, {
    isShared: true,
    rcOpen: 0,
    rcStat: 0,
    size: 13,
    rcRead: 0,
    nread: 13,
    text: 'WASI_SAB_DATA',
  });
});

test('worker_threads MessageChannel, receiveMessageOnPort, clone guards and assert.throws predicates', async () => {
  const rt = loadRuntime({ keep: true });
  const result = plain(await rt.evaluate(`(async () => {
    const assertMod = CORE.assert;
    const wt = CORE.worker_threads;
    const {
      Worker, MessageChannel, receiveMessageOnPort,
      BroadcastChannel, getEnvironmentData, setEnvironmentData,
      postMessageToThread, SHARE_ENV, markAsUncloneable, isMarkedAsUncloneable,
      markAsUntransferable, isMarkedAsUntransferable, isMainThread, threadId,
    } = wt;

    // Arrow predicate + class constructor checks in assert.throws
    assertMod.throws(() => { throw Object.assign(new Error('nope'), { code: 25 }); }, err => err.code === 25);
    let mismatchedClass = false;
    try { assertMod.throws(() => { throw new RangeError('x'); }, TypeError); }
    catch { mismatchedClass = true; }

    // Uncloneable & untransferable validation
    const fnErr = (() => {
      try { new Worker('1', { eval: true, workerData: () => {} }); return null; }
      catch (e) { return { name: e.name, code: e.code }; }
    })();
    const sab = new SharedArrayBuffer(8);
    const sabTransferErr = (() => {
      try { new Worker('1', { eval: true, workerData: sab, transferList: [sab] }); return null; }
      catch (e) { return { name: e.name, code: e.code }; }
    })();
    const customObj = { ok: true };
    markAsUncloneable(customObj);
    const markedUnclone = isMarkedAsUncloneable(customObj);
    const customAb = new ArrayBuffer(8);
    markAsUntransferable(customAb);
    const markedUntransfer = isMarkedAsUntransferable(customAb);

    // Same-thread postMessageToThread rejection
    let sameThreadCode = null;
    try { await postMessageToThread(0, { x: 1 }); }
    catch (e) { sameThreadCode = e.code; }

    // MessageChannel: sync receiveMessageOnPort + async listener auto-start via .once('message')
    const ch = new MessageChannel();
    ch.port2.postMessage({ n: 10 });
    ch.port2.postMessage({ n: 20 });
    const syncFirst = receiveMessageOnPort(ch.port1);
    const asyncSecond = await new Promise(resolve => ch.port1.once('message', resolve));
    ch.port1.close();
    ch.port2.close();

    // Missing file emits error asynchronously with MODULE_NOT_FOUND
    const wMiss = new Worker('/project/definitely-missing-worker.js');
    const missErr = await new Promise(resolve => wMiss.once('error', resolve));

    // Shared environment data + BroadcastChannel + postMessageToThread + terminate()
    setEnvironmentData('suite', { active: true, count: 3 });
    const bc = new BroadcastChannel('wt-unit-chan');
    const bcPromise = new Promise(resolve => { bc.onmessage = ev => resolve(ev.data); });
    const directPromise = new Promise(resolve => CORE.process.once('workerMessage', (val, tid) => resolve({ val, tid })));

    const w = new Worker(\`
      const { parentPort, BroadcastChannel, getEnvironmentData, postMessageToThread, threadId, isMainThread, threadName } = require('worker_threads');
      const envCfg = getEnvironmentData('suite');
      const c = new BroadcastChannel('wt-unit-chan');
      c.postMessage({ threadId, envCfg });
      c.close();
      postMessageToThread(0, { direct: 'pong', threadId });
      parentPort.postMessage({ isMainThread, threadId, threadName, envCfg });
    \`, { eval: true, name: 'unit-worker', env: SHARE_ENV });

    const events = [];
    w.on('online', () => events.push('online'));
    const [wMsg, bcMsg, directMsg, exitCode] = await Promise.all([
      new Promise(resolve => w.once('message', msg => { events.push('message'); resolve(msg); })),
      bcPromise,
      directPromise,
      new Promise(resolve => w.once('exit', code => { events.push('exit:' + code); resolve(code); })),
    ]);
    bc.close();

    const wTerm = new Worker('setInterval(() => {}, 50);', { eval: true });
    await new Promise(resolve => wTerm.once('online', resolve));
    const termCode = await wTerm.terminate();

    return {
      isMainThread,
      threadId,
      mismatchedClass,
      fnErr,
      sabTransferErr,
      markedUnclone,
      markedUntransfer,
      sameThreadCode,
      syncFirst,
      asyncSecond,
      missCode: missErr.code,
      wMsg,
      bcMsg,
      directMsg,
      exitCode,
      events,
      termCode,
      missingEnv: getEnvironmentData('nonexistent'),
    };
  })()`));

  assert.equal(result.isMainThread, true);
  assert.equal(result.threadId, 0);
  assert.equal(result.mismatchedClass, true);
  assert.equal(result.fnErr.code, 25);
  assert.equal(result.sabTransferErr.code, 25);
  assert.equal(result.markedUnclone, true);
  assert.equal(result.markedUntransfer, true);
  assert.equal(result.sameThreadCode, 'ERR_WORKER_MESSAGING_SAME_THREAD');
  assert.deepEqual(result.syncFirst, { message: { n: 10 } });
  assert.deepEqual(result.asyncSecond, { n: 20 });
  assert.equal(result.missCode, 'MODULE_NOT_FOUND');
  assert.equal(result.wMsg.isMainThread, false);
  assert.equal(result.wMsg.threadName, 'unit-worker');
  assert.deepEqual(result.wMsg.envCfg, { active: true, count: 3 });
  assert.deepEqual(result.bcMsg.envCfg, { active: true, count: 3 });
  assert.equal(result.directMsg.val.direct, 'pong');
  assert.equal(result.exitCode, 0);
  assert.deepEqual(result.events, ['online', 'message', 'exit:0']);
  assert.equal(result.termCode, 1);
  assert.equal(result.missingEnv, undefined);
});

test('worker_threads works cleanly when SharedArrayBuffer is unavailable (plain HTTP fallback)', async () => {
  const rt = loadRuntime({ keep: true, globals: { SharedArrayBuffer: undefined } });
  const result = plain(await rt.evaluate(`(async () => {
    const { Worker, MessageChannel, receiveMessageOnPort } = CORE.worker_threads;
    const hasSab = typeof SharedArrayBuffer !== 'undefined';
    const ch = new MessageChannel();
    ch.port2.postMessage({ degraded: true });
    const popped = receiveMessageOnPort(ch.port1);
    ch.port1.close();
    ch.port2.close();
    const w = new Worker("require('worker_threads').parentPort.postMessage('fallback-ok');", { eval: true });
    const msg = await new Promise(resolve => w.once('message', resolve));
    const code = await new Promise(resolve => w.once('exit', resolve));
    return { hasSab, popped, msg, code };
  })()`));
  assert.equal(result.hasSab, false);
  assert.deepEqual(result.popped, { message: { degraded: true } });
  assert.equal(result.msg, 'fallback-ok');
  assert.equal(result.code, 0);
});

test('spawnSync/execSync/execFileSync reject with ERR_NOT_SUPPORTED when COI kernel channel is unavailable', async () => {
  const rt = loadRuntime({ keep: true, globals: { SharedArrayBuffer: undefined } });
  const codes = plain(await rt.evaluate(`(() => {
    const cp = require('child_process');
    const codeOf = fn => { try { fn(); return 'no-throw'; } catch (e) { return e.code; } };
    return [
      codeOf(() => cp.spawnSync('echo', ['hi'])),
      codeOf(() => cp.execSync('echo hi')),
      codeOf(() => cp.execFileSync('sh', ['-c', 'echo hi'])),
    ];
  })()`));
  assert.deepEqual(codes, ['ERR_NOT_SUPPORTED', 'ERR_NOT_SUPPORTED', 'ERR_NOT_SUPPORTED']);
});

test('worker_threads preserves Map, Set, Date, RegExp and Uint8Array across MessageChannel and Worker', async () => {
  const rt = loadRuntime({ keep: true });
  const r = plain(await rt.evaluate(`(async () => {
    const { Worker, MessageChannel, receiveMessageOnPort } = CORE.worker_threads;
    const ch = new MessageChannel();
    const payload = {
      routes: new Map([['/a', { prerender: true }]]),
      tags: new Set(['x', 'y']),
      stamp: new Date(1700000000000),
      pat: /^kit-[0-9]+$/i,
      bin: new Uint8Array([9, 8, 7]),
    };
    ch.port1.postMessage(payload);
    const got = receiveMessageOnPort(ch.port2).message;
    ch.port1.close(); ch.port2.close();
    const w = new Worker("const { parentPort } = require('worker_threads'); parentPort.on('message', m => { parentPort.postMessage({ isMap: m.routes instanceof Map, routeEntries: [...m.routes], isSet: m.tags instanceof Set, isDate: m.stamp instanceof Date, isRe: m.pat instanceof RegExp, bytes: [...m.bin], back: m }); parentPort.close(); });", { eval: true });
    w.postMessage(payload);
    const reply = await new Promise(resolve => w.once('message', resolve));
    const exit = await new Promise(resolve => w.once('exit', resolve));
    return {
      chanIsMap: got.routes instanceof Map,
      chanEntries: [...got.routes],
      chanIsSet: got.tags instanceof Set,
      chanDateMs: got.stamp.getTime(),
      chanRe: got.pat.source + '/' + got.pat.flags,
      chanBytes: [...got.bin],
      replyIsMap: reply.isMap,
      replyEntries: reply.routeEntries,
      replyIsSet: reply.isSet,
      replyIsDate: reply.isDate,
      replyIsRe: reply.isRe,
      replyBytes: reply.bytes,
      backIsMap: reply.back.routes instanceof Map,
      backEntries: [...reply.back.routes],
      exit,
    };
  })()`));
  assert.equal(r.chanIsMap, true);
  assert.deepEqual(r.chanEntries, [['/a', { prerender: true }]]);
  assert.equal(r.chanIsSet, true);
  assert.equal(r.chanDateMs, 1700000000000);
  assert.equal(r.chanRe, '^kit-[0-9]+$/i');
  assert.deepEqual(r.chanBytes, [9, 8, 7]);
  assert.equal(r.replyIsMap, true);
  assert.deepEqual(r.replyEntries, [['/a', { prerender: true }]]);
  assert.equal(r.replyIsSet, true);
  assert.equal(r.replyIsDate, true);
  assert.equal(r.replyIsRe, true);
  assert.deepEqual(r.replyBytes, [9, 8, 7]);
  assert.equal(r.backIsMap, true);
  assert.deepEqual(r.backEntries, [['/a', { prerender: true }]]);
  assert.equal(r.exit, 0);
});

test('worker_threads preserves WebAssembly.Module, avoids double onmessage dispatch, scopes async timers and decodes SAB globally', async () => {
  const rt = loadRuntime({ keep: true });
  const r = plain(await rt.evaluate(`(async () => {
    const { Worker, MessageChannel } = CORE.worker_threads;
    const wasmBytes = new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);
    const wasmMod = new WebAssembly.Module(wasmBytes);

    // 1. Global TextDecoder safely decodes SharedArrayBuffer views
    let sabDecoded = '';
    if (typeof SharedArrayBuffer === 'function') {
      const sab = new SharedArrayBuffer(5);
      new Uint8Array(sab).set([104, 101, 108, 108, 111]);
      sabDecoded = new TextDecoder().decode(new Uint8Array(sab));
    } else {
      sabDecoded = 'hello';
    }

    // 2. MessagePort deduplicates onmessage vs EventEmitter listener & supports addEventListener/removeEventListener
    const ch = new MessageChannel();
    const events = [];
    const domFn = ev => events.push('dom:' + ev.data);
    ch.port1.onmessage = ev => events.push('prop:' + ev.data);
    ch.port1.addEventListener('message', domFn);
    ch.port1.postMessage; // keep ref
    ch.port2.postMessage('one');
    await new Promise(resolve => setTimeout(resolve, 20));
    ch.port1.removeEventListener('message', domFn);
    ch.port2.postMessage('two');
    await new Promise(resolve => setTimeout(resolve, 20));
    ch.port1.close(); ch.port2.close();

    // 3. Worker passes WebAssembly.Module + scopes setTimeout with isMainThread === false
    const w = new Worker([
      "const { parentPort, workerData, isMainThread } = require('worker_threads');",
      "const modOk = workerData.mod instanceof WebAssembly.Module;",
      "setTimeout(() => {",
      "  const asyncMain = require('worker_threads').isMainThread;",
      "  parentPort.postMessage({ modOk, initMain: isMainThread, asyncMain, mod: workerData.mod });",
      "  parentPort.close();",
      "}, 5);",
    ].join('\\n'), { eval: true, workerData: { mod: wasmMod } });

    let workerOnCount = 0;
    w.onmessage = () => { workerOnCount++; };
    const workerReply = await new Promise(resolve => {
      w.on('message', m => { workerOnCount++; resolve(m); });
    });
    const exit = await new Promise(resolve => w.once('exit', resolve));

    return {
      sabDecoded,
      events,
      workerOnCount,
      modOk: workerReply.modOk,
      replyModInstance: workerReply.mod instanceof WebAssembly.Module,
      initMain: workerReply.initMain,
      asyncMain: workerReply.asyncMain,
      exit,
    };
  })()`));
  assert.equal(r.sabDecoded, 'hello');
  assert.deepEqual(r.events, ['dom:one', 'prop:two']);
  assert.equal(r.workerOnCount, 1);
  assert.equal(r.modOk, true);
  assert.equal(r.replyModInstance, true);
  assert.equal(r.initMain, false);
  assert.equal(r.asyncMain, false);
  assert.equal(r.exit, 0);
});
