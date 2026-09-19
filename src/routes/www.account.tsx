import { createFileRoute, Link } from "@tanstack/react-router";
import { WwwMain, WwwShell } from "@/components/www-shell";
import { SignedIn, SignedOut, UserButton } from "@/lib/auth/gates";
import { useCurrentUser } from "@/lib/auth/use-current-user";
import { PLANS } from "@/lib/license";
import { getMyLicenseFn } from "@/lib/license-api";
import { useEnclave } from "@/lib/store";
import { useEffect, useState } from "react";

export const Route = createFileRoute("/www/account")({
  component: WwwAccount,
  head: () => ({ meta: [{ title: "账号 — Enclave" }] }),
});

function WwwAccount() {
  return (
    <WwwShell>
      <WwwMain>
        <p className="www-kicker">Account</p>
        <h1>账号与订阅</h1>
        <p className="www-lead">
          登录后工作台读取你的档位。环境、Cookie、代理只存在这台电脑，不会上传。
        </p>
        <div className="www-card www-card-narrow">
          <SignedOut>
            <p>还没有登录。</p>
            <div className="www-actions">
              <Link to="/login" className="www-btn www-btn-primary">
                登录或注册
              </Link>
              <Link to="/www/pricing" className="www-btn www-btn-ghost">
                查看套餐
              </Link>
            </div>
          </SignedOut>
          <SignedIn>
            <LoggedInAccount />
          </SignedIn>
        </div>
      </WwwMain>
    </WwwShell>
  );
}

function LoggedInAccount() {
  const user = useCurrentUser();
  const planId = useEnclave((s) => s.settings.plan);
  const plan = PLANS[planId];
  const [status, setStatus] = useState("");

  useEffect(() => {
    void getMyLicenseFn()
      .then((lic) => {
        useEnclave.getState().patchSettings({ plan: lic.plan });
        setStatus("");
      })
      .catch(() => setStatus("本机离线时沿用上次档位。"));
  }, []);

  return (
    <>
      <div className="mb-4">
        <UserButton />
      </div>
      <p className="www-kicker">当前订阅</p>
      <h3>{plan.label}</h3>
      <p className="www-mono">
        {plan.envLimit} 个环境 · {plan.concurrent} 并发
        {user?.primaryEmail ? ` · ${user.primaryEmail}` : ""}
      </p>
      {status ? <p className="www-hint">{status}</p> : null}
      <div className="www-actions">
        <Link to="/" className="www-btn www-btn-primary">
          打开工作台
        </Link>
        <Link to="/www/pricing" className="www-btn www-btn-ghost">
          更改套餐
        </Link>
      </div>
    </>
  );
}
