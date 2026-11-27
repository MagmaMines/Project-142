export interface BeownirIntegrationOptions {
  basePath?: string;
  coep?: 'require-corp' | 'credentialless';
  corp?: 'same-origin' | 'same-site' | 'cross-origin';
  coop?: 'same-origin' | 'same-origin-allow-popups';
  exclude?: string | RegExp | ((pathname: string) => boolean) | Array<string | RegExp | ((pathname: string) => boolean)>;
  serveRootKernel?: boolean;
  extraHeaders?: Record<string, string>;
}

export function getCrossOriginIsolationHeaders(options?: BeownirIntegrationOptions): Record<string, string>;
export function beownir(options?: BeownirIntegrationOptions): {
  name: string;
  configureServer(server: { middlewares: { use: (fn: unknown) => void } }): void;
  configurePreviewServer(server: { middlewares: { use: (fn: unknown) => void } }): void;
};
export default beownir;
