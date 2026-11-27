import {
  createAssetHandler,
  shouldExcludePath,
  applyNodeIsolationHeaders,
} from './shared.mjs';

export { getCrossOriginIsolationHeaders } from './shared.mjs';

/**
 * Vite plugin enabling Cross-Origin Isolation (`SharedArrayBuffer` / WASIX
 * threads) and serving Beownir's self-contained runtime assets locally with
 * zero external CDN requests.
 */
export function beownir(options = {}) {
  const handler = createAssetHandler(options);
  const attachMiddleware = middlewares => {
    middlewares.use((req, res, next) => {
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
    });
  };

  return {
    name: 'beownir:cross-origin-isolation',
    configureServer(server) {
      if (server && server.middlewares) attachMiddleware(server.middlewares);
    },
    configurePreviewServer(server) {
      if (server && server.middlewares) attachMiddleware(server.middlewares);
    },
  };
}

export default beownir;
