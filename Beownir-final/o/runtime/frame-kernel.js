/* Beownir virtual OS kernel, phase 1. Runs in an opaque-origin iframe.
 * Owns real browser Worker execution contexts, canonical VFS, IPC and virtual HTTP routes.
 * It is not a native OS kernel and deliberately does not expose privileged host APIs.
 */
(() => {
  'use strict';
  let initialized = false;
  window.addEventListener('message', event => {
    if (initialized || event.source !== parent || event.data?.type !== 'beownir-runtime' || !event.ports[0] || typeof event.data.source !== 'string') return;
    initialized = true;
    const host = event.ports[0], processes = new Map(), files = Object.create(null), versions = Object.create(null), listeners = new Map(), httpRoutes = new Map();
    let sourceURL, assets, nextPID = 2, sequence = 0, epoch = 0, stopped = false, inputPID = 1;
    const MAX_PROCESSES = 8, utf8 = new TextEncoder();
    // Same budget the kernel and the editor use; the host sends it with the
    // source, and these defaults apply only if a message arrives without it.
    const limits = { bytes: 64 * 1024 * 1024, perFile: 16 * 1024 * 1024, entries: 20000, recordChars: 24 * 1024 * 1024 };
    if (event.data.limits && typeof event.data.limits === 'object') {
      const positive = value => Number.isFinite(Number(value)) && Number(value) > 0 ? Math.floor(Number(value)) : 0;
      limits.bytes = positive(event.data.limits.bytes) || limits.bytes;
      limits.perFile = Math.min(positive(event.data.limits.perFile) || limits.perFile, limits.bytes);
      limits.entries = positive(event.data.limits.entries) || limits.entries;
      limits.recordChars = Math.min(384 * 1024 * 1024, Math.ceil(limits.perFile * 4 / 3) + 4096);
    }
    const sendHost = message => { if (!stopped) host.postMessage(message); };
    const error = (code, message) => Object.assign(new Error(message), { code });
    const recordError = e => ({ code: e?.code || 'ERR_VIRTUAL_OS', message: String(e?.message || e).slice(0, 4000) });
    const validPath = p => typeof p === 'string' && p.length <= 768 && !/[\\\x00-\x1f]/.test(p) && !p.includes('//') && !p.endsWith('/') && !p.split('/').some(s => s === '.' || s === '..') && (p === '/project' || p.startsWith('/project/') || p === '/tmp' || p.startsWith('/tmp/'));
    const sameEntry = (a, b) => a === b || (!!a && !!b && a.d === b.d && a.c === b.c);
    // UTF-8 bytes, exactly what the kernel charges, so both agree on the total.
    const fileSize = entry => entry?.d ? 0 : entry?.c ? utf8.encode(entry.c).length : 0;
    let usedBytes = 0;
    function table() { return [...processes.values()].map(p => ({ pid: p.pid, ppid: p.ppid, state: p.state, command: [p.command, ...p.args].join(' ').slice(0, 180), cwd: p.cwd, startedAt: p.startedAt, ports: [...listeners].filter(([, pid]) => pid === p.pid).map(([port]) => port) })); }
    function publishTable() {
      const data = table(); sendHost({ type: 'kernel-processes', processes: data, maxProcesses: MAX_PROCESSES, fsEpoch: epoch });
      for (const p of processes.values()) p.worker.postMessage({ type: 'kernel-table', processes: data });
    }
    function reply(process, id, result, failure) { if (processes.has(process.pid)) process.worker.postMessage({ type: 'kernel-reply', id, result, error: failure ? recordError(failure) : undefined }); }
    function childEvent(process, message) {
      const owner = processes.get(process.ppid);
      if (owner) owner.worker.postMessage({ type: 'kernel-child', pid: process.pid, ...message });
    }
    function fsUpdate(incoming, incomingVersions, authoritative, sourcePID) {
      if (!incoming || typeof incoming !== 'object' || Object.keys(incoming).length > 20000) throw error('EFBIG', 'Oversized virtual filesystem update.');
      const candidate = { ...files }, delta = Object.create(null), deltaVersions = Object.create(null);
      for (const [path, value] of Object.entries(incoming)) {
        if (!validPath(path)) continue;
        if (!authoritative && (Number(incomingVersions?.[path]) || 0) !== (versions[path] || 0)) continue;
        const entry = value === null ? null : value.d === true ? { d: true } : typeof value.c === 'string' && value.c.length <= limits.recordChars ? { c: value.c } : undefined;
        if (entry === undefined) throw error('EINVAL', 'Invalid virtual file record.');
        if ((path === '/project' || path === '/tmp') && !entry?.d) throw error('EPERM', 'The workspace and temporary roots cannot be removed.');
        if (fileSize(entry) > limits.perFile) throw error('EFBIG', 'Virtual file exceeds the ' + Math.round(limits.perFile / 1048576) + ' MiB per-file limit.');
        if (sameEntry(candidate[path], entry) && !authoritative) continue;
        if (entry === null) delete candidate[path]; else candidate[path] = entry;
        delta[path] = entry; deltaVersions[path] = authoritative ? Number(incomingVersions?.[path]) || 0 : versions[path] || 0;
      }
      // Charge the delta instead of re-measuring every file on every update.
      let projected = usedBytes, projectedEntries = Object.keys(files).length;
      for (const [path, entry] of Object.entries(delta)) {
        projected += fileSize(entry) - fileSize(files[path]);
        if (!files[path] && entry) projectedEntries++;
        if (files[path] && !entry) projectedEntries--;
      }
      if (projectedEntries > limits.entries || projected > limits.bytes) throw error('ENOSPC', 'Shared virtual filesystem quota exceeded (' + Math.round(limits.bytes / 1048576) + ' MiB budget, ' + Math.round(limits.perFile / 1048576) + ' MiB per file).');
      for (const path of Object.keys(candidate)) { const parentPath = path.slice(0, path.lastIndexOf('/')); if (parentPath && parentPath !== '/' && !candidate[parentPath]?.d) throw error('ENOTDIR', 'Missing shared filesystem directory: ' + parentPath); }
      if (!Object.keys(delta).length) return;
      for (const [path, value] of Object.entries(delta)) {
        versions[path] = deltaVersions[path];
        usedBytes += fileSize(value) - fileSize(files[path]);
        if (value === null) delete files[path]; else files[path] = value;
      }
      if (usedBytes < 0) usedBytes = 0;
      epoch++;
      for (const process of processes.values()) if (process.pid !== sourcePID) process.worker.postMessage({ type: 'setfiles', files: delta, versions: deltaVersions, kernelEpoch: epoch });
      if (!authoritative) {
        const visible = Object.fromEntries(Object.entries(delta).filter(([p]) => p === '/project' || p.startsWith('/project/')));
        if (Object.keys(visible).length) sendHost({ type: 'fssync', files: visible, versions: deltaVersions });
      }
    }
    function emitOutput(process, type, value) {
      const text = String(value).slice(0, 32768), now = performance.now();
      if (now - process.outputWindow > 1000) { process.outputWindow = now; process.outputMessages = 0; }
      if (++process.outputMessages > 256) return;
      if (process.pid === 1) return sendHost({ type, data: text });
      const mode = process.stdio[type === 'stdout' ? 1 : 2];
      if (mode === 'ignore') return;
      if (mode === 'inherit') { const owner = processes.get(process.ppid); if (owner) emitOutput(owner, type, text); else sendHost({ type, data: text }); }
      else childEvent(process, { event: type, data: text });
    }
    function finish(process, code = 0, signal = null, failure) {
      if (!processes.has(process.pid)) return;
      clearTimeout(process.bootTimeout); clearTimeout(process.killTimeout); process.worker.terminate(); processes.delete(process.pid);
      for (const [port, owner] of listeners) if (owner === process.pid) { listeners.delete(port); sendHost({ type: 'close', port }); }
      for (const [id, route] of httpRoutes) if (route.target === process.pid) { clearTimeout(route.timer); httpRoutes.delete(id); route.reject(error('ECONNRESET', 'The virtual HTTP process exited.')); }
      if (inputPID === process.pid) inputPID = 1;
      if (process.pid !== 1) {
        childEvent(process, { event: 'exit', code: signal ? null : Number(code) || 0, signal, error: failure ? recordError(failure) : undefined });
        for (const child of processes.values()) if (child.ppid === process.pid) { child.ppid = 1; child.ipc = false; child.worker.postMessage({ type: 'kernel-reparent', ppid: 1 }); child.worker.postMessage({ type: 'kernel-disconnect' }); }
      } else sendHost({ type: 'fatal', message: failure?.message || 'The interactive kernel process exited. Press Run to restart.' });
      publishTable();
    }
    function kill(pid, signal = 'SIGTERM', tree = false) {
      pid = Number(pid); const process = processes.get(pid);
      if (pid === 1) throw error('EPERM', 'PID 1 is the IDE shell. Use Stop to reset the entire virtual OS.');
      if (!process) throw error('ESRCH', 'No virtual process with PID ' + pid);
      if (!['SIGTERM', 'SIGINT', 'SIGKILL', 0, '0'].includes(signal)) throw error('EINVAL', 'Unsupported virtual signal: ' + signal);
      if (signal === 0 || signal === '0') return true;
      if (tree) for (const child of [...processes.values()]) if (child.ppid === pid) kill(child.pid, signal, true);
      if (signal === 'SIGKILL') finish(process, 137, signal);
      else {
        process.state = 'stopping'; process.worker.postMessage({ type: 'kernel-signal', signal });
        clearTimeout(process.killTimeout);
        process.killTimeout = setTimeout(() => finish(process, signal === 'SIGINT' ? 130 : 143, signal), 150);
        publishTable();
      }
      return true;
    }
    // WebSocket sessions are owned by the worker that accepted the open, so later frames follow it.
    const wsOwners = new Map();
    function wsRoute(message) {
      if (message.op === 'open') {
        const target = processes.get(listeners.get(Number(message.port)) || 1);
        if (!target || typeof message.url !== 'string' || !message.url.startsWith('/') || message.url.startsWith('//')) {
          sendHost({ type: 'wsevent', id: message.id, event: 'error', message: 'connect ECONNREFUSED 127.0.0.1:' + message.port });
          sendHost({ type: 'wsevent', id: message.id, event: 'close', code: 1006, reason: '' });
          return;
        }
        wsOwners.set(message.id, target.pid);
        target.worker.postMessage({ ...message, type: 'ws' });
        return;
      }
      const owner = processes.get(wsOwners.get(message.id));
      if (message.op === 'close') wsOwners.delete(message.id);
      if (owner) owner.worker.postMessage({ ...message, type: 'ws' });
    }
    function routeHTTP(message) {
      const target = processes.get(listeners.get(Number(message.port)) || 1);
      if (!target) return Promise.reject(error('ECONNREFUSED', 'No virtual runtime is available.'));
      if (typeof message.url !== 'string' || !message.url.startsWith('/') || message.url.startsWith('//') || message.url.length > 4096) return Promise.reject(error('EINVAL', 'Invalid virtual HTTP path.'));
      if ((message.body?.byteLength || message.body?.length || 0) > 1024 * 1024) return Promise.reject(error('EFBIG', 'Virtual request body exceeds 1 MiB.'));
      const id = 'kernel-http-' + ++sequence;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { httpRoutes.delete(id); reject(error('ETIMEDOUT', 'Virtual HTTP request timed out.')); }, 15000);
        httpRoutes.set(id, { target: target.pid, resolve, reject, timer });
        target.worker.postMessage({ ...message, type: 'http', id });
      });
    }
    function startWorker(pid, ppid, spec = {}) {
      if (processes.size >= MAX_PROCESSES) throw error('EAGAIN', 'Virtual process limit reached (' + MAX_PROCESSES + ' including the IDE shell).');
      const worker = new Worker(sourceURL, { name: 'Beownir process ' + pid });
      const process = { pid, ppid, worker, state: 'booting', command: spec.command || 'beownir shell', args: spec.args || [], cwd: spec.cwd || '/project', env: spec.env || {}, stdio: spec.stdio || ['inherit', 'inherit', 'inherit'], ipc: !!spec.ipc, prepared: spec.prepared || [], startedAt: Date.now(), outputWindow: performance.now(), outputMessages: 0, fsError: null };
      processes.set(pid, process);
      worker.onmessage = event => handleWorker(process, event.data);
      worker.onerror = event => { event.preventDefault(); finish(process, 1, null, error('ERR_WORKER', event.message || 'Virtual worker crashed.')); };
      worker.onmessageerror = () => finish(process, 1, null, error('ERR_IPC', 'Could not decode worker message.'));
      process.bootTimeout = setTimeout(() => finish(process, 1, null, error('ETIMEDOUT', 'Virtual process startup timed out.')), 12000);
      if (assets) initializeProcess(process);
      publishTable(); return process;
    }
    function initializeProcess(process) {
      if (process.initialized) return; process.initialized = true;
      const wasm = assets.wasm.slice().buffer;
      process.worker.postMessage({ type: 'init', files, versions, embeddedEsbuildWasm: wasm, embeddedEsbuildBrowser: assets.browser, embeddedPako: assets.pako, kernel: { pid: process.pid, ppid: process.ppid, cwd: process.cwd, env: process.env, ipc: process.ipc, stdio: process.stdio, prepared: process.prepared, epoch } }, [wasm]);
    }
    async function syscall(process, message) {
      const data = message.data || {};
      switch (message.op) {
        case 'barrier': if (process.fsError) { const failure = process.fsError; process.fsError = null; throw failure; } return { epoch };
        case 'fs-snapshot': return { files, versions, epoch };
        case 'ps': return table();
        case 'write-output': {
          if (!['stdout', 'stderr'].includes(data.stream) || !(data.bytes instanceof Uint8Array) || data.bytes.length > 8 * 1024 * 1024) throw error('EFBIG', 'Invalid virtual output bytes.');
          const index = data.stream === 'stdout' ? 1 : 2, mode = process.stdio[index];
          if (mode === 'ignore') return true;
          if (mode === 'pipe') { if (!processes.has(process.ppid)) throw error('EPIPE', 'Child output pipe is closed.'); childEvent(process, { event: data.stream, data: data.bytes }); }
          else emitOutput(process, data.stream, new TextDecoder().decode(data.bytes));
          return true;
        }
        case 'spawn': {
          if (!assets || typeof data.command !== 'string' || !Array.isArray(data.args) || data.args.some(a => typeof a !== 'string') || JSON.stringify(data.args).length > 16384) throw error('EINVAL', 'Invalid process arguments.');
          const command = data.command.split('/').pop();
          if (!['node', 'nodejs', 'npm', 'npx', 'esbuild', 'sh'].includes(command)) throw error('ENOENT', 'No browser executable named ' + command + '. Native OS binaries cannot be spawned.');
          if (!validPath(data.cwd) || !files[data.cwd]?.d) throw error('ENOENT', 'Child working directory does not exist.');
          if (JSON.stringify(data.env || {}).length > 65536 || !Array.isArray(data.prepared) || JSON.stringify(data.prepared).length > 16 * 1024 * 1024) throw error('EFBIG', 'Process environment or prepared module graph exceeds limit.');
          const child = startWorker(nextPID++, process.pid, { ...data, command });
          return { pid: child.pid };
        }
        case 'kill': return kill(data.pid, data.signal, data.tree === true);
        case 'signal-handled': clearTimeout(process.killTimeout); process.state = 'running'; publishTable(); return true;
        case 'ipc': {
          const targetPID = data.direction === 'parent' ? process.ppid : Number(data.pid), target = processes.get(targetPID);
          if (!target || !process.ipc && data.direction === 'parent' || data.direction !== 'parent' && (!target.ipc || target.ppid !== process.pid)) throw error('ERR_IPC_CHANNEL_CLOSED', 'The virtual IPC channel is closed.');
          if (JSON.stringify(data.message).length > 1024 * 1024) throw error('EFBIG', 'IPC messages are limited to JSON-compatible data up to 1 MiB.');
          if (data.direction === 'parent') childEvent(process, { event: 'message', message: data.message });
          else target.worker.postMessage({ type: 'kernel-ipc', message: data.message });
          return true;
        }
        case 'disconnect': {
          const target = data.pid ? processes.get(Number(data.pid)) : process;
          if (!target || data.pid && target.ppid !== process.pid) throw error('ERR_IPC_CHANNEL_CLOSED', 'IPC channel is not owned by this process.');
          target.ipc = false; target.worker.postMessage({ type: 'kernel-disconnect' }); childEvent(target, { event: 'disconnect' }); return true;
        }
        case 'stdin': {
          const target = processes.get(Number(data.pid)); if (!target || target.ppid !== process.pid) throw error('EPIPE', 'Child input is not writable.');
          if ((data.bytes?.byteLength || 0) > 1024 * 1024) throw error('EFBIG', 'Stdin chunk exceeds 1 MiB.');
          target.worker.postMessage({ type: 'kernel-stdin', bytes: data.bytes || null, end: !!data.end }); return true;
        }
        case 'bind-http': {
          let port = Number(data.port);
          if (port === 0) { port = 30000; while (listeners.has(port) && port < 65535) port++; }
          if (!Number.isInteger(port) || port < 1 || port > 65535) throw error('EINVAL', 'Invalid virtual port.');
          if (listeners.has(port)) throw error('EADDRINUSE', 'Virtual port already in use: ' + port);
          listeners.set(port, process.pid); publishTable(); return { port };
        }
        case 'unbind-http': if (listeners.get(Number(data.port)) === process.pid) { listeners.delete(Number(data.port)); sendHost({ type: 'close', port: Number(data.port) }); publishTable(); } return true;
        case 'http': return routeHTTP({ ...data, type: 'http' });
        default: throw error('ENOSYS', 'Unknown virtual OS syscall: ' + message.op);
      }
    }
    function handleWorker(process, message) {
      if (stopped || !processes.has(process.pid) || !message || typeof message !== 'object') return;
      if (message.type === 'kernel-call') { Promise.resolve().then(() => syscall(process, message)).then(result => reply(process, message.id, result), failure => reply(process, message.id, null, failure)); return; }
      if (message.type === 'kernel-exit') { if (process.pid !== 1) finish(process, message.code, message.signal || null); return; }
      if (message.type === 'stdout' || message.type === 'stderr') { emitOutput(process, message.type, message.data); return; }
      if (message.type === 'fssync') {
        try { fsUpdate(message.files, message.versions, false, process.pid); }
        catch (failure) { process.fsError = failure; emitOutput(process, 'stderr', failure.message + '\n'); }
        return;
      }
      if (message.type === 'ready') {
        if (process.ready) return; process.ready = true;
        clearTimeout(process.bootTimeout); process.state = 'running'; publishTable();
        if (process.pid === 1) sendHost({ type: 'ready' });
        else { childEvent(process, { event: 'spawn' }); process.worker.postMessage({ type: 'kernel-start', command: process.command, args: process.args }); }
        return;
      }
      if (message.type === 'wsevent') { if (message.event === 'close') wsOwners.delete(message.id); sendHost(message); return; }
      if (message.type === 'httpres') {
        const route = httpRoutes.get(message.id); if (!route || route.target !== process.pid) return;
        clearTimeout(route.timer); httpRoutes.delete(message.id);
        if (!(message.body instanceof Uint8Array) || message.body.length > 8 * 1024 * 1024) route.reject(error('EFBIG', 'Invalid or oversized HTTP response.'));
        else route.resolve({ status: message.status, statusMessage: message.statusMessage, headers: message.headers || {}, body: message.body }); return;
      }
      if (message.type === 'listen') { if (listeners.get(message.port) === process.pid) { sendHost(message); publishTable(); } return; }
      if (message.type === 'close') { if (listeners.get(message.port) === process.pid) { listeners.delete(message.port); sendHost(message); publishTable(); } return; }
      if (message.type === 'question') { inputPID = process.pid; sendHost(message); return; }
      if (message.type === 'questionend') { inputPID = 1; sendHost(message); return; }
      if (message.type === 'kernel-cwd') { if (validPath(message.cwd) && files[message.cwd]?.d) { process.cwd = message.cwd; publishTable(); } return; }
      if (message.type === 'fatal') { finish(process, 1, null, error('ERR_PROCESS', message.message)); return; }
      if (process.pid === 1 && ['done', 'clear', 'open', 'pkgdone', 'pong'].includes(message.type)) sendHost(message);
    }
    function shutdown() {
      if (stopped) return; stopped = true;
      for (const process of processes.values()) { clearTimeout(process.bootTimeout); clearTimeout(process.killTimeout); process.worker.terminate(); }
      for (const route of httpRoutes.values()) clearTimeout(route.timer);
      processes.clear(); httpRoutes.clear(); listeners.clear(); if (sourceURL) URL.revokeObjectURL(sourceURL);
      host.postMessage({ type: 'kernel-stopped' }); host.close();
    }
    try {
      sourceURL = URL.createObjectURL(new Blob([event.data.source], { type: 'text/javascript' })); startWorker(1, 0);
      host.onmessage = async event => {
        const message = event.data; if (!message || typeof message !== 'object' || stopped) return;
        try {
          if (message.type === 'terminate') return shutdown();
          if (message.type === 'init') {
            assets = { wasm: new Uint8Array(message.embeddedEsbuildWasm), browser: message.embeddedEsbuildBrowser, pako: message.embeddedPako };
            fsUpdate({ '/tmp': { d: true }, ...message.files }, message.versions, true, 1); initializeProcess(processes.get(1)); return;
          }
          if (message.type === 'setfiles') { fsUpdate(message.files, message.versions, true, -1); return; }
          if (message.type === 'http') {
            try { const response = await routeHTTP(message); sendHost({ ...response, type: 'httpres', id: message.id }); }
            catch (failure) { sendHost({ type: 'httpres', id: message.id, status: 502, headers: { 'content-type': 'text/plain' }, body: new TextEncoder().encode(failure.message) }); } return;
          }
          if (message.type === 'ws') { wsRoute(message); return; }
          if (message.type === 'kill-process') { kill(message.pid, message.signal || 'SIGTERM', message.tree === true); return; }
          if (['cmd', 'ping'].includes(message.type)) processes.get(1)?.worker.postMessage(message);
          if (message.type === 'stdin') (processes.get(inputPID) || processes.get(1))?.worker.postMessage(message);
        } catch (failure) { sendHost({ type: 'stderr', data: 'Virtual OS: ' + failure.message + '\n' }); }
      };
      host.start(); sendHost({ type: 'connected' }); window.addEventListener('pagehide', shutdown, { once: true });
    } catch (failure) { sendHost({ type: 'fatal', message: failure.message }); shutdown(); }
  });
})();
