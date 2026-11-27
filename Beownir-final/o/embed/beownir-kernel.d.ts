export interface BeownirNetworkConfig {
  allowedFetchDomains?: string[];
  corsProxy?: string;
  useHostProxy?: boolean;
}

export interface BeownirKernelOptions {
  files?: Record<string, string | { content?: string; c?: string; directory?: boolean; d?: boolean } | null>;
  container?: HTMLElement | string;
  limits?: { bytes?: number; perFile?: number; entries?: number };
  network?: BeownirNetworkConfig;
  previewOrigin?: string;
  previewSessionId?: string;
  profiler?: boolean | { enabled?: boolean; maxSpans?: number };
  hostFetch?: (url: string, init?: { method?: string; headers?: Record<string, string>; body?: unknown }) => Promise<Response>;
  autostart?: boolean;
}

export interface PreviewInspectWaitUntil {
  selector?: string;
  timeout?: number;
}

export type PreviewWaitUntilCondition = 'domcontentloaded' | 'load' | 'settled' | PreviewInspectWaitUntil;

export interface PreviewActionSpec {
  action: 'click' | 'fill' | 'select' | 'press';
  ref?: string;
  selector?: string;
  value?: string;
  key?: string;
}

export class PreviewNotAttachedError extends Error {
  readonly code: 'PREVIEW_NOT_ATTACHED';
  readonly port: number;
}

export class PreviewInspectionTimeoutError extends Error {
  readonly code: 'PREVIEW_TIMEOUT';
  readonly port: number;
  readonly op: string;
}

export class PreviewAgentUnavailableError extends Error {
  readonly code: 'PREVIEW_AGENT_UNAVAILABLE';
  readonly port: number;
}

export class PreviewInspector {
  constructor(options?: { timeoutMs?: number });
  attach(port: number, iframe: HTMLIFrameElement, options?: { token?: string }): this;
  detach(port: number): this;
  isAttached(port: number): boolean;
  ping(port: number, opts?: { timeoutMs?: number; retry?: boolean }): Promise<{ ready: boolean; readyState: string; url: string; title: string; mutationVersion: number }>;
  metrics(port: number, opts?: { timeoutMs?: number }): Promise<Record<string, unknown>>;
  text(port: number, opts?: { selector?: string; maxLength?: number; timeoutMs?: number }): Promise<{ text: string; length: number; truncated: boolean }>;
  console(port: number, opts?: { clear?: boolean; timeoutMs?: number }): Promise<Array<{ level: string; args: string[]; timestamp: number }>>;
  errors(port: number, opts?: { clear?: boolean; timeoutMs?: number }): Promise<Array<{ type: string; message: string; stack?: string; timestamp: number }>>;
  networkFailures(port: number, opts?: { clear?: boolean; timeoutMs?: number }): Promise<Array<{ method: string; url: string; status: number; timestamp: number }>>;
  query(port: number, selector: string, opts?: { limit?: number; computedStyles?: string[]; timeoutMs?: number }): Promise<Array<Record<string, unknown>>>;
  dom(port: number, opts?: { selector?: string; maxDepth?: number; maxChildren?: number; timeoutMs?: number }): Promise<Record<string, unknown> | null>;
  interactive(port: number, opts?: { limit?: number; timeoutMs?: number }): Promise<Array<Record<string, unknown>>>;
  act(port: number, spec: PreviewActionSpec, opts?: { timeoutMs?: number }): Promise<{ ok: boolean; action: string; ref?: string; mutationVersion: number }>;
  waitUntil(port: number, condition: PreviewWaitUntilCondition, opts?: { timeoutMs?: number }): Promise<Record<string, unknown>>;
  snapshot(port: number, opts?: { waitUntil?: PreviewWaitUntilCondition; selector?: string; limit?: number; timeoutMs?: number }): Promise<Record<string, unknown>>;
  destroy(): void;
}

export interface ProfilerSpan {
  name: string;
  category: string;
  source: string;
  pid: number;
  threadId: number;
  startMs: number;
  durationMs: number;
  detail: Record<string, unknown> | null;
}

export interface ProfilerReport {
  startedAt: number;
  endedAt: number;
  durationMs: number;
  spans: ProfilerSpan[];
  aggregates: Record<string, { count: number; totalMs: number; minMs: number; maxMs: number; avgMs: number; p95Ms: number }>;
  summary: {
    totalSpans: number;
    byCategory: Record<string, { count: number; totalMs: number }>;
    slowSpanCount: number;
    slowSpans: ProfilerSpan[];
    warnings: string[];
  };
  environment: {
    version: string;
    userAgent: string;
    crossOriginIsolated: boolean;
  };
}

export interface MountedPreviewHandle {
  readonly port: number;
  readonly path: string;
  readonly inspector: PreviewInspector | null;
  reload(nextPath?: string): Promise<void>;
  destroy(): void;
}

export class BeownirKernel {
  constructor(options?: BeownirKernelOptions);
  readonly state: string;
  readonly ready: boolean;
  readonly ports: number[];
  readonly files: Record<string, { c?: string; d?: boolean }>;
  start(): Promise<this>;
  stop(): void;
  destroy(): void;
  whenReady(): Promise<this>;
  on(type: string, handler: (payload: unknown) => void): () => void;
  off(type: string, handler: (payload: unknown) => void): this;
  setFiles(files: NonNullable<BeownirKernelOptions['files']>): Promise<{ files: Record<string, unknown> }>;
  writeFile(path: string, content: string): Promise<{ path: string }>;
  writeFileBytes(path: string, bytes: Uint8Array | ArrayBuffer | ArrayBufferView | string): Promise<{ path: string }>;
  readFile(path: string): string | null;
  exists(path: string): boolean;
  removeFile(path: string): Promise<{ path: string }>;
  run(command: string, options?: { timeoutMs?: number; onData?: (chunk: { stream: string; data: string }) => void }): Promise<{ code: number; stdout: string; stderr: string; cwd?: string }>;
  sendInput(data: string): void;
  kill(pid: number, signal?: string): Promise<boolean>;
  http(input: string, init?: RequestInit): Promise<{ status: number; headers: Record<string, string | string[]>; bytes: Uint8Array; body: string }>;
  httpJson(input: string, init?: RequestInit): Promise<unknown>;
  waitForServer(port: number, options?: { path?: string; timeoutMs?: number; intervalMs?: number }): Promise<unknown>;
  resolvePreviewUrl(port: number, path?: string): string;
  setNetworkConfig(network: BeownirNetworkConfig): BeownirNetworkConfig | null;
  createInspector(): PreviewInspector;
  mountPreview(iframe: HTMLIFrameElement, options?: { port?: number; path?: string; inspector?: PreviewInspector | false }): Promise<MountedPreviewHandle>;
  startProfile(options?: { maxSpans?: number }): Promise<{ enabled: boolean; startedAt: number }>;
  getProfile(): Promise<ProfilerReport>;
  stopProfile(): Promise<ProfilerReport>;
}

export const version: string;
export function create(options?: BeownirKernelOptions): BeownirKernel;
export function normalisePath(input: string, options?: { relativeTo?: string }): string;
export function capabilities(): Record<string, boolean>;
declare const BeownirApi: {
  version: string;
  create: typeof create;
  BeownirKernel: typeof BeownirKernel;
  PreviewInspector: typeof PreviewInspector;
  PreviewNotAttachedError: typeof PreviewNotAttachedError;
  PreviewInspectionTimeoutError: typeof PreviewInspectionTimeoutError;
  PreviewAgentUnavailableError: typeof PreviewAgentUnavailableError;
  normalisePath: typeof normalisePath;
  capabilities: typeof capabilities;
};
export default BeownirApi;
