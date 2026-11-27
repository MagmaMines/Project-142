import type { IncomingMessage, ServerResponse } from 'node:http';
import type { BeownirIntegrationOptions } from './vite.js';

export function getCrossOriginIsolationHeaders(options?: BeownirIntegrationOptions): Record<string, string>;
export function resolveEmbedAssets(): { embedDir: string; siteDir: string; kernelPath: string; swPath: string };
export function applyIsolationHeaders(res: ServerResponse, options?: BeownirIntegrationOptions): void;
export function createBeownirMiddleware(options?: BeownirIntegrationOptions): (req: IncomingMessage, res: ServerResponse, next?: () => void) => void;
export function createWebAssetResponse(request: Request, options?: BeownirIntegrationOptions): Response | null;
