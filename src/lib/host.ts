import { collectCdpFn, getKernelStatusFn, startEnvFn, stopEnvFn } from "@/lib/kernel/functions";
import { planOf, runningCount } from "@/lib/license";
import type { Environment, ProxyItem } from "@/lib/schema";
import { useEnclave } from "@/lib/store";

export function proxyUrl(proxy: ProxyItem | undefined): string | undefined {
  if (!proxy) return undefined;
  const auth = proxy.auth
    ? `${encodeURIComponent(proxy.auth.username)}:${encodeURIComponent("vault")}`
    : "";
  const creds = auth ? `${auth}@` : "";
  return `${proxy.protocol}://${creds}${proxy.host}:${proxy.port}`;
}

export async function startEnv(env: Environment) {
  const store = useEnclave.getState();
  const plan = planOf(store.settings.plan);
  if (runningCount(store.runtimes) >= plan.concurrent && store.runtimes[env.id]?.status !== "running") {
    const code = "PLAN_CONCURRENT_LIMIT";
    store.setRuntime(env.id, {
      envId: env.id,
      pid: null,
      debugPort: null,
      debugAddress: "127.0.0.1",
      status: "error",
      startedAt: null,
      hashOk: true,
      error: code,
    });
    store.addAudit({
      action: "start_blocked",
      target: env.id,
      level: "warn",
      detail: `${code} ${plan.label} max ${plan.concurrent}`,
    });
    return { ok: false as const, code, message: `${plan.label} concurrent limit ${plan.concurrent}` };
  }
  const kernel = await getKernelStatusFn();
  if (kernel.status.state !== "admitted") {
    store.setRuntime(env.id, {
      envId: env.id,
      pid: null,
      debugPort: null,
      debugAddress: "127.0.0.1",
      status: "error",
      startedAt: null,
      hashOk: false,
      error: "KERNEL_UNTRUSTED_SOURCE",
    });
    store.addAudit({
      action: "start_blocked",
      target: env.id,
      level: "bad",
      detail: "Kernel not admitted",
    });
    return { ok: false as const, code: "KERNEL_UNTRUSTED_SOURCE", message: "Kernel not admitted" };
  }
  const proxy = store.proxies.find((p) => p.id === env.proxyId);
  store.setRuntime(env.id, {
    envId: env.id,
    pid: null,
    debugPort: null,
    debugAddress: "127.0.0.1",
    status: "starting",
    startedAt: Date.now(),
    hashOk: true,
  });
  store.patchEnv(env.id, {}, {
    at: Date.now(),
    kind: "start",
    message: "Start requested",
    level: "info",
  });
  const allowNoSandbox = env.allowNoSandbox || store.settings.allowNoSandboxHost;
  const result = await startEnvFn({
    data: {
      envId: env.id,
      profile: env.profile,
      extraFlags: env.extraFlags,
      allowNoSandbox,
      proxyServer: proxyUrl(proxy),
      searchEngine: env.searchEngine ?? "none",
      searchProvider: env.searchProvider,
    },
  });
  if (!result.ok) {
    store.setRuntime(env.id, {
      envId: env.id,
      pid: null,
      debugPort: null,
      debugAddress: "127.0.0.1",
      status: "error",
      startedAt: null,
      hashOk: result.code !== "KERNEL_HASH_MISMATCH",
      error: result.message,
    });
    store.addAudit({
      action: "start_failed",
      target: env.id,
      level: "bad",
      detail: `${result.code}: ${result.message}`,
    });
    store.patchEnv(env.id, {}, {
      at: Date.now(),
      kind: "start_failed",
      message: result.message,
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
    detail: `pid ${result.pid} port ${result.port} runtime=native`,
  });
  store.patchEnv(
    env.id,
    {
      lastIntegrity: { at: Date.now(), ok: true },
    },
    {
      at: Date.now(),
      kind: "running",
      message: `pid ${result.pid} · runtime=native`,
      level: env.allowNoSandbox ? "warn" : "info",
    },
  );
  return result;
}

export async function stopEnv(envId: string) {
  await stopEnvFn({ data: { envId } });
  const store = useEnclave.getState();
  store.setRuntime(envId, null);
  store.patchEnv(envId, {}, {
    at: Date.now(),
    kind: "stop",
    message: "Stopped",
    level: "info",
  });
  store.addAudit({ action: "stop", target: envId, level: "info", detail: "stopped" });
}

export async function collectEnvCdp(envId: string) {
  const snap = await collectCdpFn({ data: { envId } });
  useEnclave.getState().setEnvSnap(envId, snap);
  return snap;
}
