'use strict';
const fs = require('node:fs'), path = require('node:path'), cp = require('node:child_process'), crypto = require('node:crypto');
const policy = require('./compatibility-policy.cjs');

/*
 * Package managers can report an exit status before a browser-backed mount has
 * made its linker output observable to a fresh process. This wrapper makes the
 * install a small transaction: retain the old graph, run the real manager in a
 * clean node_modules directory, prove the declared roots are materialized, then
 * write a durable guest-side receipt. The kernel only announces completion after
 * it has checkpointed that receipt and graph successfully.
 */
const startedAt = Date.now();
const INSTALL_BUDGET_MS = 285000; // leave time for receipt + checkpoint inside the five minute UI SLA
function memoryMiB() { try { const usage = process.memoryUsage(); return Math.round((usage.rss || 0) / 1024 / 1024); } catch { return null; } }
function trace(phase, detail = '') {
  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1), rss = memoryMiB();
  console.log('[beownir-install] phase=' + phase + ' elapsed=' + elapsed + 's' + (rss == null ? '' : ' rss=' + rss + 'MiB') + (detail ? ' ' + detail : ''));
}
function remainingInstallBudget() {
  return INSTALL_BUDGET_MS - (Date.now() - startedAt);
}
function ensureBudget(stage) {
  const left = remainingInstallBudget();
  if (left <= 0) throw Error('Install exceeded the five-minute browser operation budget during ' + stage + '. The prior dependency graph was restored.');
  return left;
}
function atomicWrite(file, value) {
  const temporary = file + '.tmp-' + crypto.randomBytes(6).toString('hex');
  fs.writeFileSync(temporary, value);
  try { const fd = fs.openSync(temporary, 'r'); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); } } catch { /* OPFS fsync may be intentionally a no-op. */ }
  fs.renameSync(temporary, file);
}

const manager = process.argv[2], args = process.argv.slice(3);
if (!['npm', 'pnpm'].includes(manager)) throw Error('Unsupported package manager');
let cwd = process.cwd();
for (let n = 0; n < args.length; n++) if (args[n] === '--prefix' && args[n + 1]) cwd = path.resolve(cwd, args[n + 1]);
if (cwd !== '/workspace' && !cwd.startsWith('/workspace/')) throw Error('Package operations must stay in the guest workspace');
const INSTALL_COMMANDS = new Set(['i', 'install', 'ci', 'add', 'update', 'up', 'remove', 'uninstall', 'rebuild']);
function packageCommand(values) {
  for (let index = 0; index < values.length; index++) {
    const value = String(values[index]);
    if (value === '--prefix' || value === '--dir' || value === '-C') { index++; continue; }
    if (value.startsWith('-')) continue;
    return value;
  }
  return 'install';
}
const command = packageCommand(args);
let installing = INSTALL_COMMANDS.has(command);
const locks = ['package.json', 'package-lock.json', 'npm-shrinkwrap.json', 'pnpm-lock.yaml'];
const lockBackup = new Map(locks.map(name => {
  const file = path.join(cwd, name);
  return [file, fs.existsSync(file) ? fs.readFileSync(file) : null];
}));
let graphBackup = null, transactionOpen = false;

function restoreLocks() {
  for (const [file, value] of lockBackup) {
    try { if (value) atomicWrite(file, value); else fs.rmSync(file, { force: true }); } catch { /* best effort during error recovery */ }
  }
}
function beginGraphTransaction() {
  if (!installing || transactionOpen) return;
  const modules = path.join(cwd, 'node_modules'), state = path.join(cwd, '.beownir');
  fs.mkdirSync(state, { recursive: true });
  graphBackup = path.join(state, 'install-backup-' + crypto.randomBytes(12).toString('hex'));
  if (fs.existsSync(modules)) fs.renameSync(modules, graphBackup);
  transactionOpen = true;
  trace('transaction-open', graphBackup ? 'previous_graph_retained=true' : 'previous_graph_retained=false');
}
function resetAttempt() {
  if (!transactionOpen) return;
  fs.rmSync(path.join(cwd, 'node_modules'), { recursive: true, force: true });
  restoreLocks();
}
function rollback() {
  if (!installing) return;
  try { fs.rmSync(path.join(cwd, 'node_modules'), { recursive: true, force: true }); } catch {}
  if (graphBackup) {
    try { fs.renameSync(graphBackup, path.join(cwd, 'node_modules')); } catch {}
  }
  restoreLocks();
  transactionOpen = false;
  trace('transaction-rolled-back');
}
function commitTransaction() {
  if (!transactionOpen) return;
  if (graphBackup) fs.rmSync(graphBackup, { recursive: true, force: true });
  transactionOpen = false;
  trace('transaction-committed');
}
function within(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative));
}
function verifyMaterialized(root) {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const declared = { ...manifest.dependencies, ...manifest.devDependencies };
  const names = Object.keys(declared);
  const modules = path.join(root, 'node_modules');
  if (names.length === 0) {
    let existingModules = null;
    try { const resolved = fs.realpathSync(modules); if (fs.statSync(resolved).isDirectory()) existingModules = resolved; } catch {}
    return { directDependencies: 0, packageManager: manager, nodeModules: existingModules };
  }
  let moduleRoot;
  try { moduleRoot = fs.realpathSync(modules); if (!fs.statSync(moduleRoot).isDirectory()) throw Error('not a directory'); }
  catch { throw Error('Package manager exited successfully but node_modules was not materialized.'); }
  const missing = [], invalid = [];
  for (const name of names) {
    const packageDir = path.join(modules, ...name.split('/'));
    const spec = String(declared[name] || '');
    const aliasMatch = /^npm:((?:@[^/@]+\/)?[^@]+)/.exec(spec);
    const expectedName = aliasMatch ? aliasMatch[1] : name;
    try {
      const actual = fs.realpathSync(packageDir);
      if (!within(root, actual)) throw Error('link escapes workspace');
      const file = path.join(actual, 'package.json');
      const value = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!value || (value.name !== name && value.name !== expectedName) || typeof value.version !== 'string') throw Error('invalid package metadata');
    } catch (error) {
      (error?.code === 'ENOENT' ? missing : invalid).push(name);
    }
  }
  if (missing.length || invalid.length) {
    const list = [...missing, ...invalid].slice(0, 12).join(', ');
    throw Error('Package manager exited but dependencies were not fully materialized: ' + list + ([...missing, ...invalid].length > 12 ? ' …' : ''));
  }
  // pnpm's isolated linker must expose its backing store as well as direct links.
  if (manager === 'pnpm' && names.length) {
    const pnpmStore = path.join(modules, '.pnpm');
    try { if (!fs.statSync(pnpmStore).isDirectory()) throw Error('missing .pnpm store'); }
    catch { throw Error('pnpm exited but its virtual store was not materialized.'); }
  }
  return { directDependencies: names.length, packageManager: manager, nodeModules: fs.realpathSync(modules) };
}
function writeMaterializationReceipt(verification) {
  const state = path.join(cwd, '.beownir');
  fs.mkdirSync(state, { recursive: true });
  const receipt = {
    schema: 1,
    manager,
    command,
    materializedAt: new Date().toISOString(),
    elapsedMs: Date.now() - startedAt,
    directDependencies: verification.directDependencies,
    nodeModules: verification.nodeModules
  };
  atomicWrite(path.join(state, 'install-materialized.json'), JSON.stringify(receipt));
  return receipt;
}
function runManagerOnce(env, attempt) {
  return new Promise((resolve, reject) => {
    const left = installing ? ensureBudget('package-manager attempt ' + attempt) : 900000;
    const executable = manager === 'npm' ? process.execPath : manager;
    const commandArgs = manager === 'npm' ? [require('./npm-bootstrap.cjs').ENTRY, ...args] : args;
    const child = cp.spawn(executable, commandArgs, { cwd, env, stdio: 'inherit' });
    let timedOut = false;
    const timer = installing ? setTimeout(() => {
      timedOut = true;
      console.error('[beownir-install] package-manager attempt reached its operation budget; stopping it safely.');
      try { child.kill('SIGTERM'); } catch {}
      setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 3000).unref?.();
    }, left) : null;
    child.once('error', error => { if (timer) clearTimeout(timer); reject(error); });
    child.once('close', code => { if (timer) clearTimeout(timer); resolve({ code: code ?? 1, timedOut }); });
  });
}

(async () => {
  installing = INSTALL_COMMANDS.has(command);
  trace(installing ? 'prepare' : 'command', 'manager=' + manager + ' command=' + JSON.stringify(args));
  const plan = installing ? await policy.prepare(cwd, args, manager) : { changes: [] };
  for (const change of plan.changes) console.log('[portable] ' + change.package + ' → ' + change.to + ' (' + change.type + ')');
  const allowScripts = !installing || args.some(value => value === '--ignore-scripts=false');
  if (!allowScripts && !args.includes('--ignore-scripts')) args.push('--ignore-scripts');
  if (installing && allowScripts) console.warn('[security] Install lifecycle scripts were explicitly enabled. They execute in this browser guest and may modify its workspace.');
  const env = {
    ...process.env,
    npm_config_cache: '/workspace/.beownir/npm-cache',
    npm_config_prefix: '/workspace/.beownir/global',
    npm_config_update_notifier: 'false',
    npm_config_fetch_retries: '3',
    npm_config_fetch_retry_mintimeout: '1000',
    npm_config_fetch_retry_maxtimeout: '4000',
    npm_config_fetch_timeout: '120000',
    PNPM_DISABLE_SELF_UPDATE_CHECK: '1',
    BEOWNIR_INSTALL_DIAGNOSTICS: installing ? '1' : '',
    ...(manager === 'pnpm'
      ? { npm_config_store_dir: '/workspace/.beownir/pnpm-store', npm_config_network_concurrency: '2', npm_config_fetch_retries: '3', npm_config_manage_package_manager_versions: 'false' }
      : { npm_config_maxsockets: '4' })
  };
  if (!installing) {
    const result = await runManagerOnce(env, 1);
    process.exitCode = result.code;
    return;
  }
  beginGraphTransaction();
  let result = { code: 1 }, attempt = 0;
  const heartbeat = setInterval(() => trace('manager-running', 'manager=' + manager + ' attempt=' + attempt), 15000);
  try {
    while (attempt < 2) {
      attempt++;
      if (attempt > 1) { trace('retry', 'attempt=' + attempt + ' after a transient or incomplete package-manager exit'); resetAttempt(); }
      trace('manager-start', 'manager=' + manager + ' attempt=' + attempt);
      result = await runManagerOnce(env, attempt);
      trace('manager-exit', 'manager=' + manager + ' attempt=' + attempt + ' code=' + result.code);
      if (result.code === 0) break;
      if (result.timedOut || remainingInstallBudget() < 15000) break;
    }
  } finally { clearInterval(heartbeat); }
  if (result.code !== 0) {
    rollback();
    process.exitCode = result.code || 1;
    return;
  }
  ensureBudget('filesystem materialization verification');
  trace('materialization-verify-start');
  const verification = verifyMaterialized(cwd);
  trace('materialization-verify-complete', 'directDependencies=' + verification.directDependencies);
  trace('portable-fixup-start');
  for (const action of policy.fixup(cwd)) console.log('[portable] ' + JSON.stringify(action));
  trace('portable-fixup-complete');
  const manifest = JSON.parse(fs.readFileSync(path.join(cwd, 'package.json'), 'utf8'));
  if (Object.keys(manifest.beownir?.nativeAddons || {}).length) {
    ensureBudget('portable native-addon build');
    trace('native-addon-build-start');
    await require('./native-addons.cjs').build(cwd);
    trace('native-addon-build-complete');
  }
  const receipt = writeMaterializationReceipt(verification);
  commitTransaction();
  trace('materialization-receipt-written', 'directDependencies=' + receipt.directDependencies);
  console.log('[beownir-install] Filesystem materialized and verified. Awaiting kernel checkpoint before reporting install completion.');
})().catch(error => {
  if (installing) rollback();
  console.error('[npm] ' + (error?.stack || error));
  process.exitCode = 1;
});
