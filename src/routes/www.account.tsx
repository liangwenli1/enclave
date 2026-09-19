import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { WwwMain, WwwShell } from "@/components/www-shell";
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
      <WwwMain>
        <p className="www-kicker">Account</p>
        <h1>账号在本机演示。</h1>
        <p className="www-lead">
          厂商许可证 API 还没接。这里只保存邮箱和档位到浏览器，用来走通「选套餐 → 打开工作台」。不是付费通道。
        </p>
        <div className="www-card www-card-narrow">
          {account ? (
            <>
              <p className="www-kicker">已登录</p>
              <h3>{account.email}</h3>
              <p className="www-mono">
                {PLANS[account.plan].label} · {PLANS[account.plan].envLimit} 环境
              </p>
              <div className="www-actions">
                <button
                  type="button"
                  className="www-btn www-btn-primary"
                  onClick={() => {
                    useEnclave.getState().patchSettings({ plan: account.plan });
                    void navigate({ to: "/" });
                  }}
                >
                  打开工作台
                </button>
                <button
                  type="button"
                  className="www-btn www-btn-ghost"
                  onClick={() => {
                    clearSiteAccount();
                    setAccount(null);
                  }}
                >
                  退出
                </button>
              </div>
            </>
          ) : (
            <form
              className="www-form"
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
              <label>
                邮箱
                <input
                  type="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@company.com"
                />
              </label>
              <label>
                档位
                <select value={plan} onChange={(e) => setPlan(e.target.value as PlanId)}>
                  {(Object.keys(PLANS) as PlanId[]).map((id) => (
                    <option key={id} value={id}>
                      {PLANS[id].label}
                    </option>
                  ))}
                </select>
              </label>
              <button type="submit" className="www-btn www-btn-primary">
                注册并进入工作台
              </button>
            </form>
          )}
        </div>
      </WwwMain>
    </WwwShell>
  );
}
