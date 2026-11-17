import test from 'node:test';
import assert from 'node:assert/strict';
import { loadRuntime, initToolchain } from './helpers/runtime.mjs';

/* The page's WebSocket reaches a virtual port through the worker's RFC 6455 client. This test
 * runs the worker's real message handler against a minimal in-runtime server that checks the
 * client's masking and answers with unmasked frames, then reads the events the page would get. */

/* Forward every worker message to the runtime's own handler, and keep the websocket events. */
function captureWsEvents(runtime) {
  const original = runtime.sandbox.self.postMessage;
  runtime.sandbox.self.postMessage = message => {
    if (message && message.type === 'wsevent') runtime.sandbox.__events.push(message);
    if (typeof original === 'function') return original(message);
  };
}

const rt = await initToolchain(loadRuntime());

test('a page WebSocket opens, echoes a text frame, and closes through the worker client', async () => {
  rt.sandbox.__events = [];
  await rt.evaluate(`(async () => {
    const http = CORE.http;
    const server = http.createServer(() => {});
    server.on('upgrade', (request, socket) => {
      let pending = Buffer.alloc(0);
      socket.write('HTTP/1.1 101 Switching Protocols\\r\\nUpgrade: websocket\\r\\nConnection: Upgrade\\r\\n\\r\\n');
      const reply = (opcode, payload) => socket.write(Buffer.concat([Buffer.from([0x80 | opcode, payload.length]), payload]));
      socket.on('data', chunk => {
        pending = Buffer.concat([pending, chunk]);
        while (pending.length >= 6) {
          const opcode = pending[0] & 15, masked = (pending[1] & 128) !== 0, length = pending[1] & 127;
          if (!masked) throw new Error('client frames must be masked');
          if (pending.length < 6 + length) return;
          const mask = pending.subarray(2, 6), body = Buffer.alloc(length);
          for (let i = 0; i < length; i++) body[i] = pending[6 + i] ^ mask[i & 3];
          pending = pending.subarray(6 + length);
          if (opcode === 1) reply(1, body);
          if (opcode === 8) { reply(8, body); socket.end(); }
        }
      });
    });
    await new Promise(resolve => server.listen(3341, '127.0.0.1', resolve));
    globalThis.__wsServer = server;
  })()`);

  const sandbox = rt.sandbox;
  captureWsEvents(rt);
  await sandbox.self.onmessage({ data: { type: 'ws', op: 'open', id: 'ws-1', port: 3341, url: '/hmr', protocols: ['vite-hmr'] } });
  const waitFor = async (predicate, label) => {
    for (let i = 0; i < 100; i++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 50)); }
    throw new Error('timed out waiting for ' + label + ': ' + JSON.stringify(sandbox.__events));
  };
  await waitFor(() => sandbox.__events.some(e => e.event === 'open'), 'open');
  await sandbox.self.onmessage({ data: { type: 'ws', op: 'send', id: 'ws-1', data: 'ping', binary: false } });
  await waitFor(() => sandbox.__events.some(e => e.event === 'message'), 'echo');
  await sandbox.self.onmessage({ data: { type: 'ws', op: 'close', id: 'ws-1', code: 1000, reason: 'done' } });
  await waitFor(() => sandbox.__events.some(e => e.event === 'close'), 'close');

  const events = sandbox.__events.map(e => ({ event: e.event, data: e.data, protocol: e.protocol, code: e.code }));
  assert.deepEqual(events.map(e => e.event), ['open', 'message', 'close']);
  assert.equal(events[1].data, 'ping');
  assert.equal(events[0].protocol, '');
  assert.equal(events[2].code, 1000);
  rt.evaluate('globalThis.__wsServer.close()');
});

test('a WebSocket to a port nobody listens on reports an error and closes', async () => {
  rt.sandbox.__events = [];
  captureWsEvents(rt);
  await rt.sandbox.self.onmessage({ data: { type: 'ws', op: 'open', id: 'ws-2', port: 3399, url: '/', protocols: [] } });
  for (let i = 0; i < 100 && !rt.sandbox.__events.some(e => e.event === 'close'); i++) await new Promise(resolve => setTimeout(resolve, 50));
  const kinds = rt.sandbox.__events.map(e => e.event);
  assert.ok(kinds.includes('error'), 'an error event must be sent');
  assert.equal(kinds[kinds.length - 1], 'close');
});
