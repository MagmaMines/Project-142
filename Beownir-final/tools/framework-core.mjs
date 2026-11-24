// Dependency resolution + virtual-FS installation, shared by the matrix tool.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';

const REGISTRY = 'https://registry.npmjs.org';
const cacheDir = path.join(os.tmpdir(), 'beownir-matrix-cache');

const encode = name => name.startsWith('@') ? '@' + encodeURIComponent(name.slice(1)) : encodeURIComponent(name);
const cachePath = url => path.join(cacheDir, encodeURIComponent(url).replace(/%/g, '_'));

async function getJson(url, headers = { accept: 'application/json' }, attempt = 0) {
  try {
    const response = await fetch(url, { headers });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error('registry ' + response.status + ' for ' + url);
    return await response.json();
  } catch (failure) {
    if (attempt >= 2) throw failure;
    await new Promise(resolve => setTimeout(resolve, 400 * (attempt + 1)));
    return getJson(url, headers, attempt + 1);
  }
}

async function getTarball(url) {
  fs.mkdirSync(cacheDir, { recursive: true });
  const file = cachePath(url);
  if (fs.existsSync(file)) return file;
  const response = await fetch(url);
  if (!response.ok) throw new Error('tarball ' + response.status + ' for ' + url);
  const bytes = Buffer.from(await response.arrayBuffer());
  fs.writeFileSync(file, bytes);
  return file;
}

const parseVersion = text => {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(String(text).trim());
  if (!match) return null;
  return { text: String(text).trim(), parts: [+match[1], +match[2], +match[3]], pre: match[4] || '' };
};

const compareVersions = (a, b) => {
  for (let index = 0; index < 3; index++) if (a.parts[index] !== b.parts[index]) return a.parts[index] - b.parts[index];
  if (a.pre === b.pre) return 0;
  if (!a.pre) return 1;
  if (!b.pre) return -1;
  return a.pre < b.pre ? -1 : 1;
};

const wildcard = value => value === undefined || value === '' || value === '*' || value === 'x' || value === 'X';

const comparatorHolds = (version, comparator) => {
  const match = /^(\^|~|>=|<=|>|<|=)?\s*v?(\d+|[xX*])(?:\.(\d+|[xX*]))?(?:\.(\d+|[xX*]))?(?:-([0-9A-Za-z.-]+))?$/.exec(comparator);
  if (!match) return true;
  const [, operator = '', major, minor, patch, pre] = match;
  if (wildcard(major)) return true;
  const target = { parts: [+major, wildcard(minor) ? 0 : +minor, wildcard(patch) ? 0 : +patch], pre: pre || '' };
  const cmp = compareVersions(version, target);
  if (operator === '>=') return cmp >= 0;
  if (operator === '>') return cmp > 0;
  if (operator === '<=') return cmp <= 0;
  if (operator === '<') return cmp < 0;
  if (operator === '~') return cmp >= 0 && version.parts[0] === target.parts[0] && version.parts[1] === target.parts[1];
  if (operator === '^') {
    if (cmp < 0) return false;
    // ^1.2.3 := >=1.2.3 <2.0.0 ; ^0.1.0 := >=0.1.0 <0.2.0 ; ^0.0.3 := =0.0.3
    if (version.parts[0] !== target.parts[0]) return false;
    if (target.parts[0] !== 0) return true;
    if (version.parts[1] !== target.parts[1]) return false;
    if (target.parts[1] !== 0) return true;
    return version.parts[2] === target.parts[2];
  }
  return wildcard(minor) ? version.parts[0] === target.parts[0]
    : wildcard(patch) ? version.parts[0] === target.parts[0] && version.parts[1] === target.parts[1]
    : cmp === 0;
};

/** A deliberately small semver range matcher: enough for npm dependency ranges. */
export const satisfies = (version, range) => {
  const parsed = parseVersion(version);
  if (!parsed) return false;
  const alternatives = String(range || '*').split('||').map(part => part.trim()).filter(Boolean);
  const matched = alternatives.some(alternative => {
    if (/^(?:file|link|git|github|https?|workspace):/.test(alternative) || alternative === 'latest' || alternative === '*') return alternative === 'latest' || alternative === '*';
    if (!parsed.pre && alternative.includes('-') === false) { /* prereleases are opt-in below */ }
    const hyphen = /^(\S+)\s+-\s+(\S+)$/.exec(alternative);
    if (hyphen) return compareVersions(parsed, parseVersion(hyphen[1]) || parsed) >= 0 && compareVersions(parsed, parseVersion(hyphen[2]) || parsed) <= 0;
    return alternative.replace(/(\^|~|>=|<=|>|<|=)\s+/g, '$1').split(/\s+/).every(comparator => comparatorHolds(parsed, comparator));
  });
  if (!matched) return false;
  // Prereleases only satisfy ranges that mention a prerelease.
  if (parsed.pre && !String(range).includes('-')) return false;
  return true;
};

export const maxSatisfying = (versions, range) => versions
  .map(parseVersion)
  .filter(version => version && satisfies(version.text, range))
  .sort(compareVersions)
  .pop();

const packuments = new Map();
export async function packument(name) {
  if (packuments.has(name)) return packuments.get(name);
  const promise = getJson(REGISTRY + '/' + encode(name), { accept: 'application/vnd.npm.install-v1+json' });
  packuments.set(name, promise);
  return promise;
}

/** Resolves one dependency range to concrete version metadata. */
export async function resolveRange(name, range) {
  if (typeof range !== 'string' || /^(?:file|link|git|github|https?|workspace):/.test(range)) return { skipped: true, reason: 'unsupported range ' + range };
  if (range === 'latest' || range === '*') {
    const meta = await getJson(REGISTRY + '/' + encode(name) + '/latest');
    if (!meta || !meta.dist) return { skipped: true, reason: 'no latest version' };
    return meta;
  }
  const document = await packument(name);
  if (!document || !document.versions) return { skipped: true, reason: 'package not found' };
  const chosen = maxSatisfying(Object.keys(document.versions), range);
  if (!chosen) return { skipped: true, reason: 'no version matches ' + range };
  return document.versions[chosen.text];
}

function unpack(tarball, into) {
  fs.mkdirSync(into, { recursive: true });
  execFileSync('tar', ['-xzf', tarball, '-C', into, '--strip-components=1'], { stdio: 'ignore' });
}

const looksLikeText = buffer => {
  const text = buffer.toString('utf8');
  return Buffer.from(text, 'utf8').equals(buffer) ? text : null;
};

/** Downloads and unpacks a package, returning { path: contents } for the virtual FS. */
export async function fetchPackage(meta) {
  const tarball = await getTarball(meta.dist?.tarball || meta.tarball);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beownir-pkg-'));
  unpack(tarball, dir);
  const files = {};
  const walk = current => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      const relative = path.relative(dir, full).split(path.sep).join('/');
      const buffer = fs.readFileSync(full);
      const text = looksLikeText(buffer);
      files[relative] = text === null ? '__BEOWNIR_WASM64__:' + buffer.toString('base64') : text;
    }
  };
  walk(dir);
  fs.rmSync(dir, { recursive: true, force: true });
  return { files, version: meta.version, bytes: fs.statSync(tarball).size };
}

/**
 * Resolves a dependency graph breadth-first and returns the install plan.
 * Flat install, first version wins — the same shape npm produces for the
 * overwhelming majority of framework trees. When a later dependent needs a
 * version the hoisted one cannot satisfy (SvelteKit: svelte wants
 * is-reference ^3, @rollup/plugin-commonjs pins 1.2.1), the alternate is
 * recorded in `nested` and installed under its dependent's node_modules,
 * the way npm resolves the conflict.
 */
const RUNTIME_OS = ['browser', 'wasi'];
const RUNTIME_CPU = ['wasm32'];
function platformAccepts(list, values) {
  if (!Array.isArray(list) || list.length === 0) return true;
  const wanted = Array.isArray(values) ? values : [values];
  const blocked = list.filter(item => item.startsWith('!')).map(item => item.slice(1));
  if (wanted.some(value => blocked.includes(value))) return false;
  const allowed = list.filter(item => !item.startsWith('!'));
  return allowed.length === 0 || wanted.some(value => allowed.includes(value));
}

// npm does not install a peer dependency that peerDependenciesMeta marks optional.
function requiredPeers(meta) {
  const meta2 = meta.peerDependenciesMeta || {};
  return Object.fromEntries(Object.entries(meta.peerDependencies || {}).filter(([name]) => !(meta2[name] && meta2[name].optional)));
}

const NEST_DEPTH_LIMIT = 5;
const NESTED_CAP = 160;
function nestDepth(dir) { return (dir.match(/node_modules/g) || []).length - 1; }

export async function resolveTree(roots, { concurrency = 8, maxPackages = 400, log = () => {} } = {}) {
  const resolved = new Map();
  /* key = install dir (relative), value = { name, version, tarball, dir, dependencies }. */
  const nested = new Map();
  const queue = roots.map(({ name, range }) => ({ name, range, from: '<root>' }));
  const failures = [];
  let active = 0;
  let done = false;
  /* Every dependent re-checks its ranges against the hoisted tree (that is how
   * conflicts are discovered), so identical (name, range) lookups repeat
   * constantly. Memoize the registry lookups by promise. */
  const rangeCache = new Map();
  const cachedResolve = (name, range) => {
    const key = name + '\u0000' + range;
    let entry = rangeCache.get(key);
    if (!entry) { entry = resolveRange(name, range); rangeCache.set(key, entry); }
    return entry;
  };

  /* Record an alternate version at `dir` and enqueue its own dependencies
   * (a nested package may need versions that differ from the hoisted tree,
   * e.g. lazystream's readable-stream@2 wanting process-nextick-args). */
  const recordNested = (job, meta, dir) => {
    if (nested.has(dir) || nested.size >= NESTED_CAP || nestDepth(dir) > NEST_DEPTH_LIMIT) return false;
    nested.set(dir, { name: job.name, version: meta.version, tarball: meta.dist.tarball, dir, dependencies: meta.dependencies || {} });
    log('nested ' + job.name + '@' + meta.version + ' at ' + dir);
    for (const [dep, depRange] of Object.entries(meta.dependencies || {})) {
      queue.push({ name: dep, range: depRange, from: job.name, nestedDir: dir });
    }
    return true;
  };

  return await new Promise(resolve => {
    const pump = () => {
      if (done) return;
      while (active < concurrency && queue.length) {
        const job = queue.shift();
        active++;
        cachedResolve(job.name, job.range).then(meta => {
          active--;
          if (meta.skipped) { failures.push({ name: job.name, range: job.range, from: job.from, reason: meta.reason }); return pump(); }
          // npm installs an optional dependency only when its os/cpu fields accept the platform.
          // The runtime identifies as browser/wasm32 (WASI-compatible), so native-only binaries are skipped.
          if (job.soft && (!platformAccepts(meta.os, RUNTIME_OS) || !platformAccepts(meta.cpu, RUNTIME_CPU))) { pump(); return; }
          if (resolved.has(job.name)) {
            const hoisted = resolved.get(job.name);
            if (!maxSatisfying([hoisted.version], job.range) && job.from !== '<root>' && meta.version !== hoisted.version) {
              /* The dependent is itself nested: keep drilling down inside it.
               * Otherwise npm semantics: nest beside the dependent's files. */
              const dir = job.nestedDir ? job.nestedDir + '/node_modules/' + job.name : 'node_modules/' + job.from + '/node_modules/' + job.name;
              recordNested(job, meta, dir);
            }
            pump(); return;
          }
          if (resolved.size >= maxPackages) { failures.push({ name: job.name, range: job.range, reason: 'package cap reached' }); return pump(); }
          resolved.set(job.name, { name: job.name, version: meta.version, tarball: meta.dist.tarball, dependencies: meta.dependencies || {}, optional: meta.optionalDependencies || {}, peer: meta.peerDependencies || {} });
          log('resolved ' + job.name + '@' + meta.version);
          /* Enqueue unconditionally: a dep whose name is already hoisted may
           * still need a different version (path-scurry wants lru-cache ^10
           * while cacache's ^7 got hoisted) — the handler records the conflict. */
          for (const [dep, depRange] of Object.entries({ ...(meta.dependencies || {}) })) queue.push({ name: dep, range: depRange, from: job.name, nestedDir: job.nestedDir });
          for (const [dep, depRange] of Object.entries({ ...(meta.optionalDependencies || {}), ...requiredPeers(meta) })) if (!resolved.has(dep)) queue.push({ name: dep, range: depRange, from: job.name, soft: true });
          pump();
        }).catch(failure => {
          active--;
          if (!job.soft) failures.push({ name: job.name, range: job.range, from: job.from, reason: failure.message });
          pump();
        });
      }
      if (active === 0 && queue.length === 0) { done = true; resolve({ packages: resolved, failures, nested }); }
    };
    pump();
  });
}

/** Downloads every resolved package and returns a virtual-FS file map. */
export async function installTree(packages, { concurrency = 6, log = () => {}, nested = [] } = {}) {
  const files = {};
  const installed = [];
  const failures = [];
  const jobs = [...packages.values()];
  for (const entry of nested) jobs.push({ ...entry, nestedUnder: entry.dir });
  let index = 0;
  const worker = async () => {
    while (index < jobs.length) {
      const job = jobs[index++];
      try {
        const pkg = await fetchPackage(job);
        /* A nested entry's dir already names the full install path including
         * the package itself: node_modules/<dependent>/node_modules/<name>. */
        const prefix = job.nestedUnder ? job.nestedUnder + '/' : 'node_modules/' + job.name + '/';
        for (const [relative, contents] of Object.entries(pkg.files)) files[prefix + relative] = contents;
        installed.push({ name: job.name, version: job.version, bytes: pkg.bytes, nestedUnder: job.nestedUnder || null });
        log('fetched ' + job.name + '@' + job.version + (job.nestedUnder ? ' under ' + job.nestedUnder : ''));
      } catch (failure) {
        failures.push({ name: job.name, version: job.version, reason: failure.message });
      }
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
  return { files, installed, failures };
}
