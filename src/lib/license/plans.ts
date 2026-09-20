/**
 * 档位定义。
 *
 * 这张表只在**完全没有许可证**时兜底（等于免费档）。
 * 登录之后，一切上限以厂商签名的许可证里写的数字为准 —— 客户端不能自己给自己放宽。
 * 改这里的数字必须同时改 apps/vendor/src/license.js，否则两边会对不上。
 */
export type PlanId = "free" | "solo" | "pro" | "team";

export type PlanLimits = {
  plan: PlanId;
  label: string;
  envLimit: number;
  concurrent: number;
  seats: number;
  api: "off" | "discover" | "full";
  syncWindows: boolean;
  deviceLimit: number;
};

export const PLANS: Record<PlanId, PlanLimits> = {
  free: { plan: "free", label: "Solo Free", envLimit: 3, concurrent: 1, seats: 1, api: "off", syncWindows: false, deviceLimit: 1 },
  solo: { plan: "solo", label: "Solo", envLimit: 50, concurrent: 3, seats: 1, api: "discover", syncWindows: false, deviceLimit: 1 },
  pro: { plan: "pro", label: "Pro", envLimit: 200, concurrent: 8, seats: 1, api: "full", syncWindows: true, deviceLimit: 2 },
  team: { plan: "team", label: "Team", envLimit: 200, concurrent: 8, seats: 3, api: "full", syncWindows: true, deviceLimit: 6 },
};

export const FREE = PLANS.free;

export function planOf(id: string | undefined | null): PlanLimits {
  return (id && PLANS[id as PlanId]) || FREE;
}

export function envCount(environments: Array<{ deletedAt: number | null }>): number {
  return environments.filter((e) => !e.deletedAt).length;
}

export function runningCount(runtimes: Record<string, { status: string }>): number {
  return Object.values(runtimes).filter((r) => r.status === "running" || r.status === "starting")
    .length;
}
