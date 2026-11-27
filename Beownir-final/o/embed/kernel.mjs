import './beownir-kernel.js';

const api = globalThis.BeownirKernel;
if (!api) {
  throw new Error('BeownirKernel failed to register on globalThis.');
}

export const version = api.version;
export const create = api.create;
export const BeownirKernel = api.BeownirKernel;
export const VirtualCookieJar = api.VirtualCookieJar;
export const PreviewInspector = api.PreviewInspector;
export const PreviewNotAttachedError = api.PreviewNotAttachedError;
export const PreviewInspectionTimeoutError = api.PreviewInspectionTimeoutError;
export const PreviewAgentUnavailableError = api.PreviewAgentUnavailableError;
export const normalisePath = api.normalisePath;
export const capabilities = api.capabilities;
export default api;
