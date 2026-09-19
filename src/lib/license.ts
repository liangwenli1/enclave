export type PlanId = "free" | "solo" | "pro";

export type Plan = {
  id: PlanId;
  label: string;
  envLimit: number;
  seats: number;
  concurrent: number;
  api: "off" | "discover" | "full";
  syncWindows: boolean;
};

export const PLANS: Record<PlanId, Plan> = {
  free: {
    id: "free",
    label: "Solo Free",
    envLimit: 3,
    seats: 1,
    concurrent: 1,
    api: "off",
    syncWindows: false,
  },
  solo: {
    id: "solo",
    label: "Solo",
    envLimit: 50,
    seats: 1,
    concurrent: 3,
    api: "discover",
    syncWindows: false,
  },
  pro: {
    id: "pro",
    label: "Pro",
    envLimit: 200,
    seats: 1,
    concurrent: 8,
    api: "full",
    syncWindows: true,
  },
};

export function planOf(id: PlanId | undefined): Plan {
  return PLANS[id ?? "free"];
}

export function envCount(environments: Array<{ deletedAt: number | null }>): number {
  return environments.filter((e) => !e.deletedAt).length;
}

export function runningCount(runtimes: Record<string, { status: string }>): number {
  return Object.values(runtimes).filter((r) => r.status === "running" || r.status === "starting").length;
}
