'use strict';
// Runtime capability probe executed inside the actual Wasmer/WASIX guest.
// This deliberately checks behavior, not merely API names. Each capability is
// independent so missing socket/thread support is reported instead of hiding
// otherwise working native execution.
const fs = require('node:fs');
const net = require('node:net');
const result = {
  nodeVersion: process.versions && process.versions.node || null,
  wasm: typeof WebAssembly === 'object',
  filesystem: false,
  tcpLoopback: false,
  workerThreads: false,
};

async function checkFilesystem() {
  const file = (process.env.BEOWNIR_PROBE_ROOT || '/workspace/.beownir') + '/.native-runtime-probe';
  try {
    fs.writeFileSync(file, 'runtime-probe');
    result.filesystem = fs.readFileSync(file, 'utf8') === 'runtime-probe';
  } finally {
    try { fs.unlinkSync(file); } catch {}
  }
}

async function checkTcpLoopback() {
  const server = net.createServer(socket => socket.once('data', data => socket.end(data)));
  let client;
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('listen timeout')), 2500);
      server.once('error', error => { clearTimeout(timer); reject(error); });
      server.listen(0, '127.0.0.1', () => { clearTimeout(timer); resolve(); });
    });
    const port = server.address().port;
    result.tcpLoopback = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('echo timeout')), 2500);
      client = net.connect(port, '127.0.0.1');
      client.once('connect', () => client.write('beownir-loopback'));
      client.once('data', data => { clearTimeout(timer); resolve(data.toString() === 'beownir-loopback'); });
      client.once('error', error => { clearTimeout(timer); reject(error); });
    });
  } finally {
    client?.destroy();
    await new Promise(resolve => server.close(() => resolve()));
  }
}

async function checkWorkerThreads() {
  const { Worker } = require('node:worker_threads');
  const worker = new Worker('const { parentPort } = require("node:worker_threads"); parentPort.postMessage("worker-ok")', { eval: true });
  try {
    result.workerThreads = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('worker timeout')), 3000);
      worker.once('message', value => { clearTimeout(timer); resolve(value === 'worker-ok'); });
      worker.once('error', error => { clearTimeout(timer); reject(error); });
    });
  } finally {
    await worker.terminate();
  }
}

(async () => {
  for (const [name, check] of [['filesystem', checkFilesystem], ['tcpLoopback', checkTcpLoopback], ['workerThreads', checkWorkerThreads]]) {
    try { await check(); }
    catch (error) { result[name + 'Error'] = String(error && (error.code || error.message) || error).slice(0, 240); }
  }
  process.stdout.write(JSON.stringify(result) + '\n');
})().catch(error => {
  process.stderr.write(String(error && (error.stack || error.message) || error) + '\n');
  process.exitCode = 1;
});
