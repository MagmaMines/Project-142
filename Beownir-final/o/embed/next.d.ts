import type { BeownirIntegrationOptions } from './vite.js';

export interface BeownirNextOptions extends BeownirIntegrationOptions {
  source?: string;
}

export interface NextHeaderRule {
  source: string;
  headers: Array<{ key: string; value: string }>;
}

export function getCrossOriginIsolationHeaders(options?: BeownirIntegrationOptions): Record<string, string>;
export function getBeownirHeaders(options?: BeownirNextOptions): NextHeaderRule[];
export function resolveEmbedAssets(): { embedDir: string; siteDir: string; kernelPath: string; swPath: string };
export function withBeownir<T extends { headers?: () => Promise<NextHeaderRule[]> }>(nextConfig?: T, options?: BeownirNextOptions): T & { headers: () => Promise<NextHeaderRule[]> };
export default withBeownir;
