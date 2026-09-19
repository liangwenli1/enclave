import { createServerFn } from "@tanstack/react-start";
import { authMiddleware } from "@/lib/auth/middleware";
import { getSql } from "@/lib/db";
import { planOf, type PlanId } from "@/lib/license";

function asPlan(value: string | null | undefined): PlanId {
  if (value === "solo" || value === "pro" || value === "free") return value;
  return "free";
}

export const getMyLicenseFn = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    const sql = await getSql();
    const rows = await sql<{ plan: string }>`
      select plan from licenses where user_id = ${context.userId} limit 1
    `;
    const plan = asPlan(rows[0]?.plan);
    return { plan, label: planOf(plan).label };
  });

export const setMyLicenseFn = createServerFn({ method: "POST" })
  .validator((plan: PlanId) => asPlan(plan))
  .middleware([authMiddleware])
  .handler(async ({ context, data: plan }) => {
    const sql = await getSql();
    await sql`
      insert into licenses (user_id, plan, updated_at)
      values (${context.userId}, ${plan}, ${Date.now()})
      on conflict (user_id) do update set plan = excluded.plan, updated_at = excluded.updated_at
    `;
    return { plan, label: planOf(plan).label };
  });
