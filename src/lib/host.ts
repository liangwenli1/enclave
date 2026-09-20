import {
  collectCdp,
  getKernelView,
  startEnvironment,
  stopEnvironment,
} from "@/lib/kernel/host-api";
import { runningCount } from "@/lib/license/plans";
import type { Environment, ProxyItem } from "@/lib/schema";
import { useEnclave } from "@/lib/store";
import { getSecret } from "@/lib/vault";

/**
 * 代理地址。密码来自保险箱，保险箱锁着就拿不到 —— 这时宁可报错，
 * 也不会静默地用一个没有密码的代理去连（那会直接以本机 IP 出网）。
 */
export function proxyUrl(proxy: ProxyItem | undefined): string | undefined {
  if (!proxy) return undefined;
  if (!proxy.auth?.username) return `${proxy.protocol}://${proxy.host}:${proxy.port}`;
  const user = encodeURIComponent(proxy.auth.username);
  const pass = encodeURIComponent(getSecret(`proxy:${proxy.id}`) ?? "");
  return `${proxy.protocol}://${user}:${pass}@${proxy.host}:${proxy.port}`;
}

/** 一个环境的完整启动参数。工作台点启动、推给本机 API，用的都是这一份。 */
export function launchSpec(env: Environment) {
  const store = useEnclave.getState();
  const proxy = store.proxies.find((p) => p.id === env.proxyId);
  // 内核只能加载解压后的文件夹，添加扩展时已经挡掉 .crx。
  const extensionPaths = env.extensionIds
    .map((id) => store.extensions.find((x) => x.id === id)?.path)
    .filter((p): p is string => Boolean(p));
  return {
    profile: env.profile,
    extraFlags: extensionPaths.length
      ? [...env.extraFlags, `--load-extension=${extensionPaths.join(",")}`]
      : env.extraFlags,
    allowNoSandbox: env.allowNoSandbox || store.settings.allowNoSandboxHost,
    allowPreviewChannel: store.settings.allowPreviewKernel,
    proxyServer: proxyUrl(proxy),
    searchEngine: env.searchEngine ?? "none",
    searchProvider: env.searchProvider,
  };
}

/** 代理要密码、而保险箱锁着：这时拿不到密码，不能启动。 */
export function needsLockedSecret(env: Environment): boolean {
  const store = useEnclave.getState();
  const proxy = store.proxies.find((p) => p.id === env.proxyId);
  return Boolean(proxy?.auth?.hasPassword) && !store.vault.unlocked;
}

function failRuntime(envId: string, error: string, detail: string, hashOk = true) {
  useEnclave.getState().setRuntime(envId, {
    envId,
    pid: null,
    debugPort: null,
    debugAddress: "127.0.0.1",
    status: "error",
    startedAt: null,
    hashOk,
    error,
    detail,
  });
}

export async function startEnv(env: Environment) {
  const store = useEnclave.getState();
  const limits = store.account.limits;

  // 1. 档位：同时运行数
  const alreadyRunning = store.runtimes[env.id]?.status === "running";
  if (!alreadyRunning && runningCount(store.runtimes) >= limits.concurrent) {
    const code = "PLAN_CONCURRENT_LIMIT";
    failRuntime(env.id, code, `${limits.label} 最多同时运行 ${limits.concurrent} 个环境。`);
    store.setPlanNotice({
      title: "同时运行已达上限",
      body: `${limits.label} 最多同时运行 ${limits.concurrent} 个环境。先停掉一个正在运行的环境，或者升级档位。`,
    });
    store.addAudit({
      action: "start_blocked",
      target: env.id,
      level: "warn",
      detail: `${code} ${limits.label} max ${limits.concurrent}`,
    });
    return { ok: false as const, code, message: `${limits.label} 同时运行上限 ${limits.concurrent}` };
  }

  // 2. 代理密码：保险箱锁着就先解锁，别让用户以为在走代理
  if (needsLockedSecret(env)) {
    const code = "VAULT_LOCKED";
    failRuntime(env.id, code, "代理密码在锁着的保险箱里，先解锁。");
    return { ok: false as const, code, message: "代理密码在锁着的保险箱里" };
  }

  // 3. 内核必须已准入
  const view = await getKernelView();
  if (!view.online) {
    const code = "HOST_UNAVAILABLE";
    failRuntime(env.id, code, "连不上本机服务，重启工作台再试。");
    store.addAudit({ action: "start_blocked", target: env.id, level: "bad", detail: code });
    return { ok: false as const, code, message: "连不上本机服务" };
  }
  if (view.status.state !== "admitted") {
    const code = "KERNEL_UNTRUSTED_SOURCE";
    failRuntime(env.id, code, "内核还没准入，先到内核页准入。", false);
    store.addAudit({ action: "start_blocked", target: env.id, level: "bad", detail: "内核未准入" });
    return { ok: false as const, code, message: "内核还没准入" };
  }

  store.setRuntime(env.id, {
    envId: env.id,
    pid: null,
    debugPort: null,
    debugAddress: "127.0.0.1",
    status: "starting",
    startedAt: Date.now(),
    hashOk: true,
  });
  store.patchEnv(env.id, {}, { at: Date.now(), kind: "start", message: "已请求启动", level: "info" });

  const result = await startEnvironment({ envId: env.id, ...launchSpec(env) });

  if (!result.ok) {
    failRuntime(env.id, result.code, result.message, result.code !== "KERNEL_HASH_MISMATCH");
    store.addAudit({
      action: "start_failed",
      target: env.id,
      level: "bad",
      detail: `${result.code}: ${result.message}`,
    });
    store.patchEnv(env.id, {}, {
      at: Date.now(),
      kind: "start_failed",
      message: `${result.code}: ${result.message}`,
      level: "bad",
    });
    return result;
  }

  store.setRuntime(env.id, {
    envId: env.id,
    pid: result.pid,
    debugPort: result.port,
    debugAddress: "127.0.0.1",
    status: "running",
    startedAt: Date.now(),
    hashOk: true,
    sha256: result.sha256,
  });
  store.addAudit({
    action: "start",
    target: env.id,
    level: env.allowNoSandbox ? "warn" : "info",
    detail: `pid ${result.pid} port ${result.port}`,
  });
  store.patchEnv(
    env.id,
    { lastIntegrity: { at: Date.now(), ok: true } },
    {
      at: Date.now(),
      kind: "running",
      message: `pid ${result.pid}`,
      level: env.allowNoSandbox ? "warn" : "info",
    },
  );
  return result;
}

export async function stopEnv(envId: string) {
  await stopEnvironment(envId);
  const store = useEnclave.getState();
  store.setRuntime(envId, null);
  store.patchEnv(envId, {}, { at: Date.now(), kind: "stop", message: "已停止", level: "info" });
  store.addAudit({ action: "stop", target: envId, level: "info", detail: "stopped" });
}

export async function trashEnv(envId: string) {
  await stopEnv(envId);
  useEnclave.getState().removeEnv(envId);
}

export async function purgeEnv(envId: string) {
  await stopEnv(envId);
  useEnclave.getState().destroyEnv(envId);
}

export async function collectEnvCdp(envId: string) {
  const snap = await collectCdp(envId);
  useEnclave.getState().setEnvSnap(envId, snap);
  return snap;
}
