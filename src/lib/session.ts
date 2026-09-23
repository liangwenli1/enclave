/**
 * 账号与额度。
 *
 * 订阅状态以服务器为准：这里不存档位，也不存任何"几天内有效"的凭据。
 * 每次都是问本机服务，本机服务现问服务器——所以官网那边一改档，这里下一次问到的就是新的。
 * 新建环境、启动环境由服务器当场决定能不能做；这里的数字只用来显示。
 */
import type { CloudFailure, PlanLimits, SessionView } from "@/lib/kernel/host-api";

export type Role = "owner" | "admin" | "operator";

/** 操作员只能打开分配给他的环境：不能改团队的配置，也不能把东西导出去。 */
export const canEdit = (role: Role): boolean => role !== "operator";

export type Session = {
  state:
    | "loading"
    /** 本机服务没应答 */
    | "host-down"
    /** 这个版本没有写入服务器地址 */
    | "unconfigured"
    | "signed-out"
    | "signed-in";
  email: string | null;
  /**
   * 在团队里的角色：owner / admin / operator。一个人用的账号永远是 owner。
   * 界面按它决定显示什么，但**判定不在这里**——本机服务和服务器各自会再拒一次。
   */
  role: Role;
  /** 服务器这一次没答上来（断网）时是 null：不拿旧数字冒充现在的。 */
  plan: PlanLimits | null;
  expiresAt: number | null;
  /** 账号下所有电脑合起来的用量。 */
  usage: { profiles: number; running: number } | null;
  online: boolean;
  /** 需要让用户知道的一句话：登录失效的原因、连不上的原因。 */
  error: string | null;
};

export const LOADING: Session = {
  state: "loading",
  email: null,
  role: "owner",
  plan: null,
  expiresAt: null,
  usage: null,
  online: true,
  error: null,
};

export function toSession(view: SessionView | CloudFailure): Session {
  if (!view.ok) return { ...LOADING, state: "host-down", error: view.message };
  if (!view.configured) return { ...LOADING, state: "unconfigured" };
  if (!view.signedIn) return { ...LOADING, state: "signed-out", error: view.error?.message ?? null };
  return {
    state: "signed-in",
    email: view.email ?? null,
    role: view.role === "admin" || view.role === "operator" ? view.role : "owner",
    plan: view.plan ?? null,
    expiresAt: view.expiresAt ?? null,
    usage:
      view.profiles === undefined || view.running === undefined
        ? null
        : { profiles: view.profiles, running: view.running },
    online: view.online,
    error: view.online ? null : (view.error?.message ?? "无法连接服务器。"),
  };
}

/** 界面上显示额度用。服务器没答上来就显示一条横线，不显示旧数字。 */
export function limitText(plan: PlanLimits | null, pick: (p: PlanLimits) => number): string {
  return plan ? String(pick(plan)) : "—";
}

/** 官网交回来的深链接：enclave://auth?code=…。别的形状一律不认。 */
export function codeFromDeepLink(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "enclave:" || url.hostname !== "auth") return null;
  const code = url.searchParams.get("code") ?? "";
  return /^[A-Za-z0-9_-]{20,128}$/.test(code) ? code : null;
}
