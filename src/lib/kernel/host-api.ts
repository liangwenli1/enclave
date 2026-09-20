/**
 * 本机 Host 客户端。工作台里所有"真正动内核"的操作都从这里走。
 *
 * 只有一条链路：浏览器 → http://127.0.0.1:<port> → Rust Host → fingerprint-chromium。
 * 开发和打包后走的是同一条，没有第二套实现。
 *
 * 令牌：
 *   - 桌面版由 Tauri 壳注入 `window.__ENCLAVE_HOST__`；
 *   - `npm run dev` 时从开发服务器的 /__enclave/host-token 取（只在 vite dev 存在）。
 * 拿不到令牌就直接显示"连不上本机服务"，不会去试无鉴权调用。
 */
import type { FingerprintProfile, LabSnapshot } from "@/lib/schema";

export type KernelStatus = {
  state:
    | "absent"
    | "downloading"
    | "verifying"
    | "extracting"
    | "admitted"
    | "hash_mismatch"
    | "error";
  bytesReceived: number;
  bytesExpected: number;
  sha256Expected: string;
  sha256Actual?: string;
  /** 实际被执行的那个文件的哈希。准入时记录，启动时核对。 */
  exeSha256?: string;
  executable?: string;
  error?: string;
  admittedAt?: number;
};

export type KernelRecord = {
  id: string;
  version: string;
  platform: string;
  channel: string;
  url: string;
  filename: string;
  sha256: string;
  bytes: number;
  publisher: string;
  releasedAt: string;
  upstream: string;
  license: string;
  notes: string;
};

export type Capabilities = {
  os: string;
  arch: string;
  headlessForced: boolean;
  sandboxLikely: boolean;
};

export type RuntimeRow = {
  envId: string;
  pid: number;
  port: number;
  debugAddress: "127.0.0.1";
  startedAt: number;
  sha256: string;
  userDataDir: string;
};

export type SearchEngineRow = {
  id: string;
  name: string;
  keyword: string;
  url: string;
  suggestUrl: string;
  isDefault: boolean;
};

export type StartResult =
  | {
      ok: true;
      pid: number;
      port: number;
      debugAddress: "127.0.0.1";
      sha256: string;
      warned: string[];
      userDataDir: string;
    }
  | { ok: false; code: string; message: string };

export type KernelView = {
  status: KernelStatus;
  kernel: {
    manifest: KernelRecord;
    kernels: KernelRecord[];
    channel: string;
  } | null;
  capabilities: Capabilities | null;
  runtimes: RuntimeRow[];
  /** Host 起没起来。false 时界面要说"连不上本机服务"，而不是显示空数据。 */
  online: boolean;
};

declare global {
  interface Window {
    __ENCLAVE_HOST__?: { token: string; port: number };
  }
}

const DEFAULT_PORT = 17891;

let cached: { token: string; base: string } | null = null;

async function connection(): Promise<{ token: string; base: string } | null> {
  if (cached) return cached;

  const injected = typeof window !== "undefined" ? window.__ENCLAVE_HOST__ : undefined;
  if (injected?.token) {
    cached = { token: injected.token, base: `http://127.0.0.1:${injected.port || DEFAULT_PORT}` };
    return cached;
  }

  if (import.meta.env.DEV) {
    try {
      const res = await fetch("/__enclave/host-token", { signal: AbortSignal.timeout(3000) });
      if (res.ok) {
        const body = (await res.json()) as { token: string; port: number };
        if (body.token) {
          cached = { token: body.token, base: `http://127.0.0.1:${body.port || DEFAULT_PORT}` };
          return cached;
        }
      }
    } catch {
      /* 开发服务器没起 host */
    }
  }
  return null;
}

export class HostUnavailable extends Error {
  code = "HOST_UNAVAILABLE";
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const conn = await connection();
  if (!conn) throw new HostUnavailable("连不上本机服务。");
  let res: Response;
  try {
    res = await fetch(`${conn.base}${path}`, {
      ...init,
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        authorization: `Bearer ${conn.token}`,
        ...(init?.headers ?? {}),
      },
      signal: init?.signal ?? AbortSignal.timeout(30_000),
    });
  } catch {
    cached = null;
    throw new HostUnavailable("连不上本机服务。");
  }
  if (res.status === 401 || res.status === 403) {
    cached = null;
    throw new HostUnavailable("本机服务拒绝了这次调用，请重启工作台。");
  }
  return (await res.json()) as T;
}

const OFFLINE_VIEW: KernelView = {
  status: {
    state: "error",
    bytesReceived: 0,
    bytesExpected: 0,
    sha256Expected: "",
    error: "HOST_UNAVAILABLE",
  },
  kernel: null,
  capabilities: null,
  runtimes: [],
  online: false,
};

export async function getKernelView(): Promise<KernelView> {
  try {
    const body = await call<Omit<KernelView, "online">>("/v1/kernel");
    return { ...body, runtimes: body.runtimes ?? [], online: true };
  } catch {
    return OFFLINE_VIEW;
  }
}

export async function admitKernel(allowPreviewChannel: boolean): Promise<KernelStatus & { code?: string; message?: string }> {
  return call("/v1/kernel/admit", {
    method: "POST",
    body: JSON.stringify({ allowPreviewChannel }),
  });
}

export async function startEnvironment(input: {
  envId: string;
  profile: FingerprintProfile;
  extraFlags: string[];
  allowNoSandbox: boolean;
  allowPreviewChannel: boolean;
  proxyServer?: string;
  searchEngine?: string;
  searchProvider?: { name: string; keyword: string; url: string; suggestUrl?: string };
}): Promise<StartResult> {
  try {
    return await call<StartResult>("/v1/environments/start", {
      method: "POST",
      body: JSON.stringify(input),
    });
  } catch (err) {
    return {
      ok: false,
      code: "HOST_UNAVAILABLE",
      message: err instanceof Error ? err.message : "连不上本机服务。",
    };
  }
}

export async function stopEnvironment(envId: string): Promise<void> {
  try {
    await call("/v1/environments/stop", { method: "POST", body: JSON.stringify({ envId }) });
  } catch {
    /* Host 不在：运行态本来就没了 */
  }
}

export async function listSearchEngines(envId: string): Promise<SearchEngineRow[]> {
  try {
    const body = await call<{ ok: boolean; engines: SearchEngineRow[] }>(
      `/v1/search-engines?envId=${encodeURIComponent(envId)}`,
    );
    return body.engines ?? [];
  } catch {
    return [];
  }
}

export async function collectCdp(envId: string): Promise<LabSnapshot> {
  const body = await call<{ ok: boolean; snapshot?: LabSnapshot; message?: string }>(
    "/v1/lab/collect",
    { method: "POST", body: JSON.stringify({ envId }) },
  );
  if (!body.ok || !body.snapshot) throw new Error(body.message ?? "CDP_HANDSHAKE_FAILED");
  return body.snapshot;
}

/* ── 给脚本用的本机 API ────────────────────────────────────────────── */

export type ApiEnvEntry = {
  id: string;
  name: string;
  group: string;
  spec: Omit<Parameters<typeof startEnvironment>[0], "envId">;
};

/**
 * 把开关、档位和环境清单推给 Host。环境的启动参数里有带密码的代理地址，
 * Host 只放内存，不落盘。返回 API 令牌（由 Host 生成和保存）。
 */
export async function configureApi(input: {
  enabled: boolean;
  level: "off" | "discover" | "full";
  concurrent: number;
  environments: ApiEnvEntry[];
}): Promise<{ enabled: boolean; token: string } | null> {
  try {
    return await call("/v1/api/config", { method: "POST", body: JSON.stringify(input) });
  } catch {
    return null;
  }
}

export async function rotateApiToken(): Promise<string | null> {
  try {
    const res = await call<{ token: string }>("/v1/api/rotate", { method: "POST", body: "{}" });
    return res.token;
  } catch {
    return null;
  }
}

export async function hostBaseUrl(): Promise<string | null> {
  return (await connection())?.base ?? null;
}
