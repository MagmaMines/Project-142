import {
  COOP_HEADER,
  COEP_HEADER,
  CORP_HEADER,
  ORIGIN_AGENT_HEADER,
  SW_ALLOWED_HEADER,
  getCrossOriginIsolationHeaders,
  resolveEmbedAssets,
} from './shared.mjs';

export { resolveEmbedAssets, getCrossOriginIsolationHeaders };

/**
 * Returns Next.js `headers()` entries adding COOP/COEP isolation headers and
 * Service Worker scope headers for `/coi-sw.js`.
 */
export function getBeownirHeaders(options = {}) {
  const source = typeof options.source === 'string' && options.source ? options.source : '/(.*)';
  const iso = getCrossOriginIsolationHeaders(options);
  const headerEntries = Object.entries(iso).map(([key, value]) => ({ key, value }));
  return [
    {
      source,
      headers: headerEntries,
    },
    {
      source: '/coi-sw.js',
      headers: [
        { key: SW_ALLOWED_HEADER, value: '/' },
        { key: 'Cache-Control', value: 'no-cache' },
        { key: 'Content-Type', value: 'application/javascript; charset=utf-8' },
        { key: COOP_HEADER, value: iso[COOP_HEADER] },
        { key: COEP_HEADER, value: iso[COEP_HEADER] },
        { key: CORP_HEADER, value: iso[CORP_HEADER] },
        { key: ORIGIN_AGENT_HEADER, value: iso[ORIGIN_AGENT_HEADER] },
      ],
    },
  ];
}

/**
 * Next.js config wrapper injecting Cross-Origin Isolation headers while
 * preserving existing `headers()` rules on `nextConfig`.
 */
export function withBeownir(nextConfig = {}, options = {}) {
  const existingHeaders = typeof nextConfig.headers === 'function' ? nextConfig.headers : null;
  const rules = getBeownirHeaders(options);
  return {
    ...nextConfig,
    async headers() {
      const prior = existingHeaders ? await existingHeaders() : [];
      const list = Array.isArray(prior) ? prior : [];
      return [...list, ...rules];
    },
  };
}

export default withBeownir;
