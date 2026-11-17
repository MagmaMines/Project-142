/* Storage governor for the browser-WASM runtime.
 *
 * Origin storage is a single shared budget for OPFS (the guest workspace),
 * IndexedDB (snapshots and checkpoints) and the Cache API. A Next.js tree is
 * big enough that the default budget is easy to exhaust while `.next` is being
 * written, which surfaced as "Storage capacity quota exceeded" in the router.
 *
 * This module keeps that budget visible and reclaimable:
 *   - isQuotaError(): recognises every browser's wording for a full disk;
 *   - report(): usage/quota from navigator.storage.estimate();
 *   - sweep(): removes dead execution mounts and rebuildable caches;
 *   - ensureCapacity(): preflight with one sweep + retry before big writes.
 *
 * Everything takes its environment by argument so it can be unit tested with a
 * fake navigator, in Node, without a browser.
 */

export const MIB = 1024 * 1024;

/** Chrome/Safari/Firefox all phrase a full disk differently; names are unreliable
 * for errors that cross worker and WASIX boundaries, so both are checked. */
export function isQuotaError(error) {
  if (!error) return false;
  const name = String(error.name || '');
  const code = String(error.code || '');
  const message = String(error.message || error);
  if (name === 'QuotaExceededError' || code === 'ENOSPC' || code === 'QUOTA_EXCEEDED_ERR') return true;
  return /quota|storage capacity|storage is full|no space left|disk full|ENOSPC/i.test(message);
}

export function formatBytes(bytes) {
  const value = Number(bytes);
  if (!Number.isFinite(value) || value < 0) return '?';
  if (value < 1024) return value + ' B';
  const units = ['KiB', 'MiB', 'GiB', 'TiB'];
  let size = value / 1024, unit = 0;
  while (size >= 1024 && unit < units.length - 1) { size /= 1024; unit++; }
  return (size >= 100 ? size.toFixed(0) : size.toFixed(1)) + ' ' + units[unit];
}

/** Normalises navigator.storage.estimate() into the numbers the UI reasons about. */
export function describeStorage(estimate, persisted = false) {
  const usage = Math.max(0, Number(estimate?.usage) || 0);
  const quota = Math.max(0, Number(estimate?.quota) || 0);
  const available = quota > 0 ? Math.max(0, quota - usage) : 0;
  const usedRatio = quota > 0 ? Math.min(1, usage / quota) : 0;
  return {
    usage,
    quota,
    available,
    usedRatio,
    persisted: Boolean(persisted),
    // Unknown quota (some private modes report 0) is reported as 'unknown'.
    level: quota <= 0 ? 'unknown' : usedRatio >= 0.9 ? 'critical' : usedRatio >= 0.75 ? 'low' : 'ok'
  };
}

/** Hard rule used before an install/build: never plan into the last 10%. */
export function capacityVerdict(report, needBytes, headroom = 0.9) {
  const need = Math.max(0, Number(needBytes) || 0);
  if (!report || report.quota <= 0) return { ok: true, reason: 'unknown-quota', need, report };
  const budget = Math.floor(report.quota * headroom);
  const ok = report.usage + need <= budget;
  return {
    ok,
    reason: ok ? 'fits' : 'over-budget',
    need,
    budget,
    overBy: Math.max(0, report.usage + need - budget),
    report
  };
}

export function capacityMessage(verdict, label = 'This command') {
  const { report } = verdict;
  const usage = formatBytes(report.usage);
  const quota = formatBytes(report.quota);
  return label + ' needs about ' + formatBytes(verdict.need) + ' more storage, but this browser has used '
    + usage + ' of its ' + quota + ' origin quota for Beownir ('
    + Math.round(report.usedRatio * 100) + '%).\n'
    + 'Free space first: run `storage gc` here, or open Help → Storage and press "Free space".\n'
    + 'If that is not enough, remove `node_modules`/`.next` for unused projects, or run the command with a smaller dependency set.';
}

async function readEstimate(nav) {
  try {
    if (typeof nav?.storage?.estimate !== 'function') return null;
    return await nav.storage.estimate();
  } catch {
    return null;
  }
}

async function readPersisted(nav) {
  try {
    if (typeof nav?.storage?.persisted !== 'function') return false;
    return await nav.storage.persisted();
  } catch {
    return false;
  }
}

/** Asks the browser not to evict this origin. Best effort: some browsers deny. */
export async function ensurePersistence(nav = globalThis.navigator) {
  try {
    if (typeof nav?.storage?.persisted !== 'function' || typeof nav?.storage?.persist !== 'function') return { persisted: false, granted: false };
    if (await nav.storage.persisted()) return { persisted: true, granted: true };
    return { persisted: await nav.storage.persist(), granted: true };
  } catch (error) {
    return { persisted: false, granted: false, error: String(error?.message || error) };
  }
}

const isDirectoryHandle = value => Boolean(value) && typeof value === 'object' && typeof value.removeEntry === 'function' && typeof value.entries === 'function';

/**
 * Removes everything under `root` that can be rebuilt, keeping the namespaces
 * listed in `keep` (the mounts of execution groups that are still alive).
 * Returns the names of removed entries so the caller can report them.
 */
export async function sweepOpfs(root, { keep = new Set(), prefix = 'workspace-' } = {}) {
  const removed = [];
  if (!isDirectoryHandle(root)) return removed;
  const names = [];
  for await (const [name, handle] of root.entries()) names.push({ name, handle });
  for (const { name, handle } of names) {
    if (handle.kind !== 'directory') continue;
    if (!name.startsWith(prefix)) continue;
    if (keep.has(name)) continue;
    try {
      await root.removeEntry(name, { recursive: true });
      removed.push(name);
    } catch (error) {
      if (error?.name !== 'NotFoundError') throw error;
    }
  }
  return removed;
}

export function createStorageManager({ nav = globalThis.navigator, opfsNamespace = 'beownir-wasix-v1', log = () => {}, headroom = 0.9 } = {}) {
  let lastReport = null;

  async function report() {
    const estimate = await readEstimate(nav);
    lastReport = describeStorage(estimate, await readPersisted(nav));
    return lastReport;
  }

  async function persist() {
    const result = await ensurePersistence(nav);
    return { ...result, report: await report() };
  }

  /** Frees OPFS namespaces that no live execution group owns. */
  async function sweep(keep = new Set()) {
    const removed = [];
    try {
      if (typeof nav?.storage?.getDirectory !== 'function') return removed;
      const origin = await nav.storage.getDirectory();
      let base = null;
      try { base = await origin.getDirectoryHandle(opfsNamespace); } catch (error) { if (error?.name !== 'NotFoundError') throw error; }
      if (base) {
        const keepNames = new Set([...keep].map(value => String(value)));
        removed.push(...await sweepOpfs(base, { keep: keepNames }));
      }
    } catch (error) {
      log('storage sweep failed: ' + String(error?.message || error));
    }
    return removed;
  }

  /**
   * Preflight for a command that is about to write `needBytes`.
   * A cheap sweep runs first when the budget is tight, so a nearly full origin
   * recovers instead of failing halfway through an install.
   */
  async function ensureCapacity(needBytes, label = 'This command', { keep = new Set(), allowSweep = true } = {}) {
    let current = await report();
    let verdict = capacityVerdict(current, needBytes, headroom);
    if (verdict.ok) return verdict;
    if (allowSweep) {
      const removed = await sweep(keep);
      if (removed.length) log('freed ' + removed.length + ' stale mount(s): ' + removed.join(', '));
      current = await report();
      verdict = capacityVerdict(current, needBytes, headroom);
      if (verdict.ok) return { ...verdict, swept: removed };
    }
    return verdict;
  }

  return {
    report,
    persist,
    sweep,
    ensureCapacity,
    get lastReport() { return lastReport; },
    capacityVerdict: needBytes => capacityVerdict(lastReport, needBytes, headroom)
  };
}
