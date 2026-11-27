import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const COOP_HEADER = 'Cross-Origin-Opener-Policy';
export const COEP_HEADER = 'Cross-Origin-Embedder-Policy';
export const CORP_HEADER = 'Cross-Origin-Resource-Policy';
export const ORIGIN_AGENT_HEADER = 'Origin-Agent-Cluster';
export const SW_ALLOWED_HEADER = 'Service-Worker-Allowed';
export const DEFAULT_BASE_PATH = '/__beownir__';

const EMBED_DIR = path.dirname(fileURLToPath(import.meta.url));
const SITE_DIR = path.resolve(EMBED_DIR, '..', 'site');

export function resolveEmbedAssets() {
  return {
    embedDir: EMBED_DIR,
    siteDir: SITE_DIR,
    kernelPath: path.join(EMBED_DIR, 'beownir-kernel.js'),
    swPath: path.join(SITE_DIR, 'coi-sw.js'),
  };
}

export function normalizeBasePath(basePath = DEFAULT_BASE_PATH) {
  const raw = String(basePath || DEFAULT_BASE_PATH).trim();
  if (!raw || raw === '/') return '';
  const withLead = raw.startsWith('/') ? raw : '/' + raw;
  return withLead.replace(/\/+$/, '');
}

export function getCrossOriginIsolationHeaders(options = {}) {
  const coep = options.coep === 'credentialless' ? 'credentialless' : 'require-corp';
  const corp = options.corp === 'cross-origin' ? 'cross-origin' : options.corp === 'same-site' ? 'same-site' : 'same-origin';
  const coop = options.coop === 'same-origin-allow-popups' ? 'same-origin-allow-popups' : 'same-origin';
  const headers = {
    [COOP_HEADER]: coop,
    [COEP_HEADER]: coep,
    [CORP_HEADER]: corp,
    [ORIGIN_AGENT_HEADER]: '?1',
  };
  if (options.extraHeaders && typeof options.extraHeaders === 'object') {
    for (const [k, v] of Object.entries(options.extraHeaders)) {
      if (v !== undefined && v !== null) headers[k] = String(v);
    }
  }
  return headers;
}

export function shouldExcludePath(pathname, exclude) {
  if (!exclude) return false;
  if (typeof exclude === 'function') return Boolean(exclude(pathname));
  if (exclude instanceof RegExp) return exclude.test(pathname);
  if (Array.isArray(exclude)) return exclude.some(item => shouldExcludePath(pathname, item));
  if (typeof exclude === 'string') return pathname.startsWith(exclude);
  return false;
}

export function applyNodeIsolationHeaders(res, headersMap) {
  if (!res || typeof res.setHeader !== 'function') return;
  for (const [key, value] of Object.entries(headersMap)) {
    res.setHeader(key, value);
  }
}

export function createAssetHandler(options = {}) {
  const assets = resolveEmbedAssets();
  const basePath = normalizeBasePath(options.basePath);
  const kernelFile = options.kernelPath ? path.resolve(options.kernelPath) : assets.kernelPath;
  const swFile = options.swPath ? path.resolve(options.swPath) : assets.swPath;
  const isoHeaders = getCrossOriginIsolationHeaders(options);

  const kernelRoute = basePath + '/beownir-kernel.js';
  const baseSwRoute = basePath + '/coi-sw.js';
  const rootSwRoute = '/coi-sw.js';
  const cache = new Map();

  function readCached(filePath) {
    let entry = cache.get(filePath);
    if (!entry) {
      const body = fs.readFileSync(filePath);
      entry = { body };
      cache.set(filePath, entry);
    }
    return entry.body;
  }

  function matchAsset(rawUrl) {
    let pathname = '/';
    try {
      pathname = decodeURIComponent(new URL(String(rawUrl || '/'), 'http://localhost').pathname);
    } catch {
      return null;
    }
    if (pathname === kernelRoute || (options.serveRootKernel && pathname === '/beownir-kernel.js')) {
      return { kind: 'kernel', filePath: kernelFile, pathname };
    }
    if (pathname === rootSwRoute || pathname === baseSwRoute) {
      return { kind: 'sw', filePath: swFile, pathname };
    }
    return null;
  }

  return {
    basePath,
    kernelRoute,
    swRoute: rootSwRoute,
    isolationHeaders: isoHeaders,
    matchAsset,
    readAssetBytes(filePath) {
      return readCached(filePath);
    },
    serveNode(req, res) {
      const method = String(req?.method || 'GET').toUpperCase();
      if (method !== 'GET' && method !== 'HEAD') return false;
      const hit = matchAsset(req?.url || '/');
      if (!hit) return false;
      const body = readCached(hit.filePath);
      applyNodeIsolationHeaders(res, isoHeaders);
      res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Content-Length', String(body.byteLength));
      if (hit.kind === 'sw') {
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader(SW_ALLOWED_HEADER, '/');
      } else {
        res.setHeader('Cache-Control', 'public, max-age=300');
      }
      res.statusCode = 200;
      if (method === 'HEAD') res.end();
      else res.end(body);
      return true;
    },
  };
}
