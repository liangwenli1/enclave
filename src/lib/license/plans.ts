/**
 * 额度的形状，和"没有许可证时"的兜底值。
 *
 * 付费档位**只在许可证服务里定义**（apps/vendor/src/license.js）。
 * 客户端不保留那张表：上限永远来自厂商签名的许可证，这里只有免费档这一个兜底。
 */
export type PlanId = "free" | "solo" | "pro" | "team";

export type PlanLimits = {
  plan: PlanId;
  label: string;
  envLimit: number;
  concurrent: number;
  /** 给脚本用的本机 API：关 / 只读 / 完整 */
  api: "off" | "discover" | "full";
  deviceLimit: number;
};

export const FREE: PlanLimits = {
  plan: "free",
  label: "Solo Free",
  envLimit: 3,
  concurrent: 1,
  api: "off",
  deviceLimit: 1,
};

export function envCount(environments: Array<{ deletedAt: number | null }>): number {
  return environments.filter((e) => !e.deletedAt).length;
}

export function runningCount(runtimes: Record<string, { status: string }>): number {
  return Object.values(runtimes).filter((r) => r.status === "running" || r.status === "starting")
    .length;
}
