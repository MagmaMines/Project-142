import {
  SW_ALLOWED_HEADER,
  createAssetHandler,
  shouldExcludePath,
  applyNodeIsolationHeaders,
  getCrossOriginIsolationHeaders,
  resolveEmbedAssets,
} from './shared.mjs';

export { getCrossOriginIsolationHeaders, resolveEmbedAssets };

/** Applies Beownir Cross-Origin Isolation headers onto a Node HTTP response. */
export function applyIsolationHeaders(res, options = {}) {
  applyNodeIsolationHeaders(res, getCrossOriginIsolationHeaders(options));
}

/**
 * Express / Connect / Node HTTP middleware enforcing COOP/COEP headers and
 * serving local `/__beownir__/beownir-kernel.js` and `/coi-sw.js` assets.
 */
export function createBeownirMiddleware(options = {}) {
  const handler = createAssetHandler(options);
  return function beownirMiddleware(req, res, next) {
    let pathname = '/';
    try {
      pathname = new URL(String(req?.url || '/'), 'http://localhost').pathname;
    } catch {
      pathname = '/';
    }
    if (handler.serveNode(req, res)) return;
    if (!shouldExcludePath(pathname, options.exclude)) {
      applyNodeIsolationHeaders(res, handler.isolationHeaders);
    }
    if (typeof next === 'function') next();
  };
}

/**
 * Web-standard Fetch handler helper returning a `Response` when the incoming
 * `Request` targets `/__beownir__/beownir-kernel.js` or `/coi-sw.js`, or `null`
 * otherwise. Suitable for Next App Router route handlers, Hono, Remix, and
 * SvelteKit hooks.
 */
export function createWebAssetResponse(request, options = {}) {
  const handler = createAssetHandler(options);
  const method = String(request?.method || 'GET').toUpperCase();
  if (method !== 'GET' && method !== 'HEAD') return null;
  const hit = handler.matchAsset(request?.url || '/');
  if (!hit) return null;
  const body = handler.readAssetBytes(hit.filePath);
  const headers = new Headers(handler.isolationHeaders);
  headers.set('Content-Type', 'application/javascript; charset=utf-8');
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('Content-Length', String(body.byteLength));
  if (hit.kind === 'sw') {
    headers.set('Cache-Control', 'no-cache');
    headers.set(SW_ALLOWED_HEADER, '/');
  } else {
    headers.set('Cache-Control', 'public, max-age=300');
  }
  return new Response(method === 'HEAD' ? null : body, { status: 200, headers });
}
