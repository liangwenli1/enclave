import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Button, Field, Input } from "@/components/ui";
import { WwwShell, WwwWrap } from "@/components/www-shell";
import { type PlanId, PLANS } from "@/lib/license";
import { type SiteAccount, clearSiteAccount, readSiteAccount, writeSiteAccount } from "@/lib/site-account";
import { useEnclave } from "@/lib/store";

export const Route = createFileRoute("/www/account")({
  component: WwwAccount,
  head: () => ({ meta: [{ title: "账号 — Enclave" }] }),
});

function WwwAccount() {
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [plan, setPlan] = useState<PlanId>("free");
  const [account, setAccount] = useState<SiteAccount | null>(null);

  useEffect(() => {
    setAccount(readSiteAccount());
  }, []);

  return (
    <WwwShell>
      <WwwWrap className="max-w-lg">
        <h1 className="text-[28px] font-semibold tracking-tight">账号</h1>
        <p className="mt-2 text-[13px] text-subtle">
          厂商许可证 API 还没接。此页是官网注册/登录结构，账号存在你的浏览器本机，用来走通「选套餐 → 打开工作台」。不是付费通道。
        </p>
        {account ? (
          <div className="mt-6 rounded-xl border border-line bg-surface p-5">
            <div className="text-[13px] text-subtle">已登录（本机演示）</div>
            <div className="mt-1 text-[16px] font-medium">{account.email}</div>
            <div className="mt-1 font-mono text-[12px] text-muted">
              {PLANS[account.plan].label} · {PLANS[account.plan].envLimit} 环境
            </div>
            <div className="mt-4 flex gap-2">
              <button
                type="button"
                className="inline-flex h-8 items-center rounded-md bg-accent px-3 text-[13px] font-medium text-accent-fg"
                onClick={() => {
                  useEnclave.getState().patchSettings({ plan: account.plan });
                  void navigate({ to: "/" });
                }}
              >
                打开工作台
              </button>
              <Button
                onClick={() => {
                  clearSiteAccount();
                  setAccount(null);
                }}
              >
                退出
              </Button>
            </div>
          </div>
        ) : (
          <form
            className="mt-6 grid gap-3 rounded-xl border border-line bg-surface p-5"
            onSubmit={(e) => {
              e.preventDefault();
              if (!email.includes("@")) return;
              const next = { email: email.trim().toLowerCase(), plan, createdAt: Date.now() };
              writeSiteAccount(next);
              useEnclave.getState().patchSettings({ plan });
              setAccount(next);
              void navigate({ to: "/" });
            }}
          >
            <Field label="邮箱">
              <Input
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@company.com"
              />
            </Field>
            <Field label="档位">
              <select
                className="h-8 w-full rounded-md border border-line bg-surface px-2 text-[13px]"
                value={plan}
                onChange={(e) => setPlan(e.target.value as PlanId)}
              >
                {(Object.keys(PLANS) as PlanId[]).map((id) => (
                  <option key={id} value={id}>
                    {PLANS[id].label}
                  </option>
                ))}
              </select>
            </Field>
            <Button variant="primary" type="submit">
              注册并进入
            </Button>
          </form>
        )}
      </WwwWrap>
    </WwwShell>
  );
}
