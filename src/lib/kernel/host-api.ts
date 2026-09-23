/**
 * 本机 Host 客户端。工作台里所有"真正动内核"的操作都从这里走。
 *
 * 只有一条链路：浏览器 → http://127.0.0.1:<port> → Rust Host → fingerprint-chromium。
 * 开发和打包后走的是同一条，没有第二套实现。
 *
 * 令牌：
 *   - 桌面版由 Tauri 壳注入 `window.__ENCLAVE_HOST__`；
 *   - `npm run dev` 时从开发服务器的 /__enclave/host-token 取（只在 vite dev 存在）。
 * 拿不到令牌就直接显示"无法连接本机服务"，不会去试无鉴权调用。
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

/**
 * 内核分两类，每一类有自己的一串版本。
 * 两类的指纹给法、能伪装的项都不一样（见 lib/engines-meta.ts），但下载、校验、准入是同一条路。
 */
export type EngineClass = "chromium" | "firefox";

export type KernelRecord = {
  id: string;
  engine: EngineClass;
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

/** 经代理出去之后，外面看到的是谁、在哪。 */
export type ExitInfo = { ip: string; country?: string; city?: string; timezone?: string };

export type RuntimeRow = {
  envId: string;
  kernelVersion: string;
  exit?: ExitInfo | null;
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
      exit: ExitInfo | null;
      /** 实际用来启动的时区和语言：开了"跟着出口走"时可能和画像里的不一样。 */
      timezone: string;
      locale: string;
      languages: string[];
      debugAddress: "127.0.0.1";
      sha256: string;
      warned: string[];
      userDataDir: string;
    }
  | { ok: false; code: string; message: string };

/** 一个内核版本：清单里的记录，加上它在这台机器上的状态。 */
export type KernelEntry = {
  record: KernelRecord;
  status: KernelStatus;
  /** 厂商已经下架，只是本机还留着下载好的文件：能用、能删，不能再下载。 */
  withdrawn: boolean;
};

export type KernelView = {
  /** 这个系统能用的全部版本，新的在前。 */
  kernels: KernelEntry[];
  /** 每一类内核新建环境默认用的版本：最新的稳定版，没有稳定版就是最新的；这个系统上没有这一类时是 null。 */
  defaultVersions: Record<EngineClass, string | null>;
  capabilities: Capabilities | null;
  runtimes: RuntimeRow[];
  /** Host 起没起来。false 时界面要说"无法连接本机服务"，而不是显示空数据。 */
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
  if (!conn) throw new HostUnavailable("无法连接本机服务。");
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
    throw new HostUnavailable("无法连接本机服务。");
  }
  if (res.status === 401 || res.status === 403) {
    cached = null;
    throw new HostUnavailable("本机服务拒绝了这次调用，请重启工作台。");
  }
  return (await res.json()) as T;
}

/**
 * 调本机服务的一个 JSON 接口。连不上时回一个和业务失败同样形状的结果，调用方不用到处 try/catch。
 */
export async function hostJson<T extends { ok: true }>(
  path: string,
  method: "GET" | "POST" | "PUT" | "DELETE" = "GET",
  body?: unknown,
): Promise<T | CloudFailure> {
  try {
    return await call<T | CloudFailure>(path, {
      method,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    return { ok: false, code: "HOST_UNAVAILABLE", message: "无法连接本机服务。" };
  }
}

const OFFLINE_VIEW: KernelView = {
  kernels: [],
  defaultVersions: { chromium: null, firefox: null },
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

export function kernelEntry(view: KernelView, version: string | null): KernelEntry | undefined {
  return view.kernels.find((k) => k.record.version === version);
}

/** 开始下载并准入一个版本。被拒或连不上时带 code；成功时只是"已经开始"，进度看 getKernelView。 */
export async function admitKernel(
  version: string,
  allowPreviewChannel: boolean,
): Promise<{ code?: string; message?: string }> {
  try {
    return await call("/v1/kernel/admit", {
      method: "POST",
      body: JSON.stringify({ version, allowPreviewChannel }),
    });
  } catch {
    return { code: "HOST_UNAVAILABLE", message: "无法连接本机服务。" };
  }
}

/** 让本机服务去服务器取一次管理员上架的内核清单。取、验签、生效都在那边，页面不经手。 */
export async function syncKernelFeed(): Promise<{ ok: boolean; code?: string; message?: string }> {
  try {
    return await call("/v1/kernel/feed", { method: "POST", body: "{}" });
  } catch {
    return { ok: false, code: "HOST_UNAVAILABLE", message: "无法连接本机服务。" };
  }
}

/** 删掉一个已下载的版本。还有环境在用它运行时 Host 会拒绝。 */
export async function removeKernel(version: string): Promise<{ ok: boolean; message?: string }> {
  try {
    return await call("/v1/kernel/remove", { method: "POST", body: JSON.stringify({ version }) });
  } catch {
    return { ok: false, message: "无法连接本机服务。" };
  }
}

export async function startEnvironment(input: {
  envId: string;
  kernelVersion: string;
  profile: FingerprintProfile;
  extraFlags: string[];
  allowNoSandbox: boolean;
  allowPreviewChannel: boolean;
  /** 绑定的代理。地址和账号密码由本机服务自己取，页面不经手密码。 */
  proxyId?: string;
  /** 时区和语言跟着代理出口走。 */
  followExit: boolean;
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
      message: err instanceof Error ? err.message : "无法连接本机服务。",
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

/** 删掉一个环境在磁盘上的全部数据（Cookie、登录态、缓存）。 */
export async function purgeEnvironment(envId: string): Promise<{ ok: boolean; message?: string }> {
  try {
    return await call("/v1/environments/purge", { method: "POST", body: JSON.stringify({ envId }) });
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : "无法连接本机服务。" };
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

/* ── 启动参数 ─────────────────────────────────────────────────────── */

export type ClassifiedFlag = {
  raw: string;
  name: string;
  cls: "allow" | "warn" | "reject";
  /** 给用户看的一句话：为什么行、为什么不行。 */
  reason: string;
};

/**
 * 问本机服务这些启动参数能不能用。规则只有 Host 里那一份（启动时用的也是它），界面不自己判。
 * 返回 null = 问不到；这时不能保存，因为没人能保证这些参数是安全的。
 */
export async function classifyFlags(flags: string[]): Promise<ClassifiedFlag[] | null> {
  if (flags.length === 0) return [];
  try {
    const res = await call<{ ok: boolean; flags: ClassifiedFlag[] }>("/v1/flags/classify", {
      method: "POST",
      body: JSON.stringify({ flags }),
    });
    return res.ok ? res.flags : null;
  } catch {
    return null;
  }
}

/* ── 给脚本用的本机 API ────────────────────────────────────────────── */

export type ApiEnvEntry = {
  id: string;
  name: string;
  folderId: string;
  spec: Omit<Parameters<typeof startEnvironment>[0], "envId">;
};

/**
 * 把开关和环境清单推给 Host。环境的启动参数里有带密码的代理地址，
 * Host 只放内存，不落盘。返回 API 令牌（由 Host 生成和保存）。
 * 档位不在这里：脚本能做什么，Host 自己问服务器。
 */
export async function configureApi(input: {
  enabled: boolean;
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

/* ── 账号与额度 ──────────────────────────────────────────────────────
   和服务器说话的只有 Host。设备令牌在系统钥匙串里，页面拿不到，也不直接连服务器。 */

export type PlanLimits = {
  plan: string;
  label: string;
  envLimit: number;
  concurrent: number;
  deviceLimit: number;
  /** 给脚本用的本机 API：关 / 只读 / 完整 */
  api: "off" | "discover" | "full";
};

export type CloudFailure = { ok: false; code: string; message: string };

/** Host 对「现在是谁、什么档」的回答。登录了的话，每次都是它现问服务器得来的。 */
export type SessionView = {
  ok: true;
  /** 这个版本有没有写入服务器地址。没有就登录不了。 */
  configured: boolean;
  signedIn: boolean;
  /** 登录着，但这一次没连上服务器。 */
  online: boolean;
  email?: string;
  /** 在团队里的角色：owner / admin / operator。一个人用的账号永远是 owner。 */
  role?: string;
  plan?: PlanLimits;
  expiresAt?: number | null;
  /** 账号下所有电脑合起来：登记了几个环境、此刻有几个在运行。 */
  profiles?: number;
  running?: number;
  /** 租约丢了、已经被 Host 停掉的环境。只报一次。 */
  lost: Array<{ envId: string; code: string; message: string }>;
  error?: CloudFailure;
};

const HOST_DOWN: CloudFailure = { ok: false, code: "HOST_UNAVAILABLE", message: "无法连接本机服务。" };

async function cloud<T>(path: string, init?: RequestInit): Promise<T | CloudFailure> {
  try {
    return await call<T | CloudFailure>(path, init);
  } catch {
    return HOST_DOWN;
  }
}

export const getSession = () => cloud<SessionView>("/v1/session");

/** 开始登录：Host 在系统浏览器里打开官网。`opened` 为 false 时要把地址给用户自己打开。 */
export const beginLogin = () =>
  cloud<{ ok: true; url: string; opened: boolean }>("/v1/session/login", { method: "POST", body: "{}" });

/** 官网交回来的一次性授权码，交给 Host 去换设备令牌。 */
export const completeLogin = (code: string) =>
  cloud<SessionView>("/v1/session/complete", { method: "POST", body: JSON.stringify({ code }) });

export const logoutSession = () => cloud<{ ok: true }>("/v1/session/logout", { method: "POST", body: "{}" });

/** 在系统浏览器里打开官网的某一页。只能是这几页，不接受任意地址。 */
export const openSite = (page: "account" | "pricing") =>
  cloud<{ ok: true }>("/v1/session/site", { method: "POST", body: JSON.stringify({ page }) });

/** 在账号下登记一个环境（或更新名字）。新登记占一个名额，名额由服务器数。 */
export const putProfile = (env: { id: string; name: string; folderId: string; kernelVersion: string; os: string }) =>
  cloud<{ ok: true; profiles: number }>(`/v1/profiles/${encodeURIComponent(env.id)}`, {
    method: "PUT",
    body: JSON.stringify({ name: env.name, folderId: env.folderId, engineVersion: env.kernelVersion, os: env.os }),
  });

/** 停掉并注销登记，名额还回去。 */
export const deleteProfile = (envId: string) =>
  cloud<{ ok: true; profiles: number }>(`/v1/profiles/${encodeURIComponent(envId)}`, { method: "DELETE" });

export async function hostBaseUrl(): Promise<string | null> {
  return (await connection())?.base ?? null;
}

/* ── 批量执行 ────────────────────────────────────────────────
   一次对一批环境做同一件事。排队的规矩在本机服务那边：同时几个、
   同一代理隔多久、哪些原因码值得等一下再试，页面只管发起和看进度。 */

export type BatchItemState = "waiting" | "running" | "done" | "failed" | "skipped";

export type BatchItem = {
  envId: string;
  state: BatchItemState;
  code: string;
  message: string;
  tries: number;
};

export type BatchRun = {
  id: string;
  action: "start" | "stop" | "workflow";
  items: BatchItem[];
  startedAt: number;
  finishedAt: number | null;
  cancelled: boolean;
  done: number;
  failed: number;
  total: number;
};

export async function runBatch(input: {
  action: "start" | "stop" | "workflow";
  items: { envId: string; spec?: unknown }[];
  concurrency: number;
  retries: number;
  openUrl?: string;
  /** action 为 workflow 时：跑哪个流程，跑完要不要停掉环境。 */
  workflowId?: string;
  stopAfter?: boolean;
}): Promise<{ ok: boolean; runId?: string; code?: string; message?: string }> {
  try {
    return await call("/v1/batch/run", { method: "POST", body: JSON.stringify(input) });
  } catch {
    return { ok: false, code: "HOST_UNAVAILABLE", message: "无法连接本机服务。" };
  }
}

/** 最近几批。只在本机服务的内存里，关掉工作台就没了。 */
export async function listBatchRuns(): Promise<BatchRun[]> {
  try {
    const body = await call<{ runs?: BatchRun[] }>("/v1/batch/runs");
    return body.runs ?? [];
  } catch {
    return [];
  }
}

export async function cancelBatch(runId: string): Promise<boolean> {
  try {
    const body = await call<{ ok?: boolean }>("/v1/batch/cancel", {
      method: "POST",
      body: JSON.stringify({ runId }),
    });
    return body.ok === true;
  } catch {
    return false;
  }
}

/* ── 文件夹 ──────────────────────────────────────────────
   授权的单位：文件夹开给谁，里面的环境他就看得到，之后新建进去的也自动跟着。
   规则全在服务器那边，这里只是转一手——本机不复制一份"谁能改"的判断。 */

export type Folder = { id: string; name: string; profiles: number; createdAt: number };

export async function listFolders(): Promise<Folder[]> {
  const body = await hostJson<{ ok: true; folders: Folder[] }>("/v1/folders");
  return "folders" in body ? body.folders : [];
}

export const putFolder = (id: string, name: string) =>
  hostJson<{ ok: true; id: string; name: string }>(
    `/v1/folders/${encodeURIComponent(id)}`,
    "PUT",
    { name },
  );

export const deleteFolder = (id: string) =>
  hostJson<{ ok: true }>(`/v1/folders/${encodeURIComponent(id)}`, "DELETE");
