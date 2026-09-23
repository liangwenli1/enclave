import {
  collectCdp,
  deleteProfile,
  getKernelView,
  getSession,
  kernelEntry,
  purgeEnvironment,
  putProfile,
  startEnvironment,
  stopEnvironment,
  type CloudFailure,
  type SessionView,
} from "@/lib/kernel/host-api";
import { fitWindow, windowBoundsOf, type Environment } from "@/lib/schema";
import { toSession, type Session } from "@/lib/session";
import { useEnclave } from "@/lib/store";

/** 一个环境的完整启动参数。工作台点启动、推给本机 API，用的都是这一份。 */
export function launchSpec(env: Environment) {
  const store = useEnclave.getState();
  // 只告诉本机服务「用哪个代理」：地址和账号密码它自己从存储里取，页面不经手密码。
  const proxyId = env.proxyId ?? undefined;
  // 内核只能加载解压后的文件夹，添加扩展时已经挡掉 .crx。
  const extensionPaths = env.extensionIds
    .map((id) => store.extensions.find((x) => x.id === id)?.path)
    .filter((p): p is string => Boolean(p));
  // Firefox 类：额外启动参数、Chromium 扩展、默认搜索引擎都是 Chromium 的机制，这一类没有。
  // 窗口要同时放得进伪装出来的屏幕和这台显示器（按环境的缩放折算）。
  if (env.engine === "firefox") {
    const p = env.profile;
    return {
      kernelVersion: env.kernelVersion,
      profile: { ...p, window: fitWindow(p.window, windowBoundsOf(env)) },
      extraFlags: [],
      allowNoSandbox: false,
      allowPreviewChannel: store.settings.allowPreviewKernel,
      proxyId,
      followExit: env.followExit,
      searchEngine: "none",
      searchProvider: undefined,
    };
  }
  return {
    kernelVersion: env.kernelVersion,
    // 窗口不能比这台电脑的屏幕大（环境可能是从大屏电脑导过来的）。
    profile: { ...env.profile, window: fitWindow(env.profile.window) },
    extraFlags: extensionPaths.length
      ? [...env.extraFlags, `--load-extension=${extensionPaths.join(",")}`]
      : env.extraFlags,
    allowNoSandbox: env.allowNoSandbox || store.settings.allowNoSandboxHost,
    allowPreviewChannel: store.settings.allowPreviewKernel,
    proxyId,
    followExit: env.followExit,
    searchEngine: env.searchEngine ?? "none",
    searchProvider: env.searchProvider,
  };
}

/** 把本机服务的回答写进 store。它顺带报上来的「已被停掉的环境」在这里落到时间线和审计里。 */
export function applySession(view: SessionView | CloudFailure): Session {
  const store = useEnclave.getState();
  const next = toSession(view);
  store.setSession(next);
  if (!view.ok) return next;
  for (const lost of view.lost) {
    const env = store.environments.find((e) => e.id === lost.envId);
    store.setRuntime(lost.envId, null);
    store.patchEnv(lost.envId, {}, { at: Date.now(), kind: "stop", message: lost.message, level: "warn" });
    store.addAudit({
      action: "stopped_by_server",
      target: lost.envId,
      level: "warn",
      detail: `${env?.name ?? lost.envId}，${lost.message}`,
    });
    store.setPlanNotice({ title: `「${env?.name ?? lost.envId}」已停止`, body: lost.message });
  }
  return next;
}

export async function refreshSession(): Promise<Session> {
  return applySession(await getSession());
}

/** 服务器因为额度拒绝了：弹升级提示，记审计。新建、复制、导入、恢复、启动都走这里。 */
function planBlocked(title: string, failure: CloudFailure, action: string, target?: string) {
  const store = useEnclave.getState();
  store.setPlanNotice({ title, body: failure.message });
  store.addAudit({ action, target, level: "warn", detail: failure.message });
}

/**
 * 在账号下登记一个环境。所有让环境数 +1 的路径（新建、复制、向导、导入、从回收站恢复）
 * 都先过这里，成了才落到本机：名额由服务器数，所有电脑合起来算。
 */
export async function registerEnv(env: Environment): Promise<{ ok: true } | CloudFailure> {
  const res = await putProfile({
    id: env.id,
    name: env.name,
    folderId: env.folderId,
    kernelVersion: env.kernelVersion,
    os: env.profile.platform,
  });
  if (res.ok) {
    void refreshSession();
    return { ok: true };
  }
  if (res.code === "PLAN_ENV_LIMIT") planBlocked("环境数量已达上限", res, "create_blocked", env.id);
  return res;
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

  // 已经在启动了就别再来一次。
  if (store.runtimes[env.id]?.status === "starting") {
    return { ok: false as const, code: "ALREADY_STARTING", message: "正在启动" };
  }

  // 同时运行数不在这里数：那是服务器的事（所有电脑合起来算），本机服务启动前会去问。

  // 代理密码的事归本机服务管：锁着、密码不在这台电脑上、代理已经不存在，它会各给各的原因码并拒启，
  // 不会拿空密码去连（那样认证失败后流量走向不可控）。

  // 1. 内核必须已准入
  const view = await getKernelView();
  if (!view.online) {
    const code = "HOST_UNAVAILABLE";
    failRuntime(env.id, code, "无法连接本机服务，请重启工作台。");
    store.addAudit({ action: "start_blocked", target: env.id, level: "bad", detail: `${env.name}，连不上本机服务` });
    return { ok: false as const, code, message: "无法连接本机服务" };
  }
  // 环境绑定哪个版本就用哪个，不会悄悄换成别的：换内核等于换了浏览器版本。
  const kernel = kernelEntry(view, env.kernelVersion);
  if (kernel?.status.state !== "admitted") {
    const code = "KERNEL_UNTRUSTED_SOURCE";
    const detail = kernel
      ? `内核 ${env.kernelVersion} 还没下载，先到内核页下载。`
      : `内核 ${env.kernelVersion} 已经不在清单里了，到环境详情页换一个版本。`;
    failRuntime(env.id, code, detail, false);
    store.addAudit({
      action: "start_blocked",
      target: env.id,
      level: "bad",
      detail: `${env.name}，内核 ${env.kernelVersion} ${kernel ? "未下载" : "不在清单里"}`,
    });
    return { ok: false as const, code, message: detail };
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

  let result = await startEnvironment({ envId: env.id, ...launchSpec(env) });
  // 这个环境还没在账号下登记过（旧版本建的、或者导入时没登记上）：登记了再试一次。
  if (!result.ok && result.code === "PROFILE_UNKNOWN") {
    const registered = await registerEnv(env);
    result = registered.ok ? await startEnvironment({ envId: env.id, ...launchSpec(env) }) : registered;
  }

  if (!result.ok) {
    if (result.code === "PLAN_CONCURRENT_LIMIT" || result.code === "PLAN_ENV_LIMIT") {
      planBlocked(
        result.code === "PLAN_ENV_LIMIT" ? "这个环境超出了当前档位" : "同时运行已达上限",
        result,
        "start_blocked",
        env.id,
      );
    }
    // 登录失效了：回到登录页，而不是只在这一行显示个错误。
    if (result.code === "DEVICE_REVOKED" || result.code === "NOT_SIGNED_IN") void refreshSession();
    failRuntime(env.id, result.code, result.message, result.code !== "KERNEL_HASH_MISMATCH");
    store.addAudit({
      action: "start_failed",
      target: env.id,
      level: "bad",
      detail: `${env.name}，${result.message}`,
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
    exit: result.exit,
  });
  store.addAudit({
    action: "start",
    target: env.id,
    level: env.allowNoSandbox ? "warn" : "info",
    detail: env.name,
  });
  void refreshSession();
  // 跟着出口走时，Host 实际用的时区和语言可能和画像里的不一样：把画像改成真实用的，
  // 界面、导出、一致性检查看到的才是浏览器里的样子。
  const aligned =
    result.timezone !== env.profile.timezone ||
    result.locale !== env.profile.locale ||
    result.languages.join() !== env.profile.languages.join();
  store.patchEnv(
    env.id,
    aligned
      ? {
          profile: {
            ...env.profile,
            timezone: result.timezone,
            locale: result.locale,
            languages: result.languages,
          },
        }
      : {},
    {
      at: Date.now(),
      kind: "running",
      message: aligned
        ? `已启动，按出口改为 ${result.timezone}，${result.locale}`
        : result.exit
          ? `已启动，出口 ${result.exit.ip}`
          : "已启动",
      level: env.allowNoSandbox ? "warn" : "info",
    },
  );
  return result;
}

export async function stopEnv(envId: string) {
  await stopEnvironment(envId);
  const store = useEnclave.getState();
  const name = store.environments.find((e) => e.id === envId)?.name ?? envId;
  // 没在运行的环境（比如直接移进回收站）不记"已停止"：审计不能写没发生过的事。
  const wasLive = Boolean(store.runtimes[envId]);
  store.setRuntime(envId, null);
  if (!wasLive) return;
  store.patchEnv(envId, {}, { at: Date.now(), kind: "stop", message: "已停止", level: "info" });
  store.addAudit({ action: "stop", target: envId, level: "info", detail: name });
  void refreshSession();
}

/** 移进回收站：名额马上还回去。这一步连不上服务器也照样移，名额可以之后在官网账号页释放。 */
export async function trashEnv(envId: string) {
  await stopEnv(envId);
  await deleteProfile(envId);
  useEnclave.getState().removeEnv(envId);
  void refreshSession();
}

/** 从回收站恢复：要重新占一个名额，服务器说行才恢复。 */
export async function restoreEnv(env: Environment): Promise<{ ok: true } | CloudFailure> {
  const res = await registerEnv(env);
  if (res.ok) useEnclave.getState().restoreEnv(env.id);
  return res;
}

/** 彻底删除：磁盘上的数据删掉了，才把它从列表里拿走。删不掉就留着并说明原因。 */
export async function purgeEnv(envId: string): Promise<{ ok: boolean; message?: string }> {
  const result = await purgeEnvironment(envId);
  if (!result.ok) return result;
  await deleteProfile(envId);
  const store = useEnclave.getState();
  const name = store.environments.find((e) => e.id === envId)?.name ?? envId;
  store.setRuntime(envId, null);
  store.destroyEnv(envId);
  store.addAudit({ action: "purge_env", target: envId, level: "warn", detail: `${name}，磁盘数据已删除` });
  return { ok: true };
}

export async function collectEnvCdp(envId: string) {
  const snap = await collectCdp(envId);
  useEnclave.getState().setEnvSnap(envId, snap);
  return snap;
}
