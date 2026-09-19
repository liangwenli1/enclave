import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { WwwMain, WwwShell } from "@/components/www-shell";
import { SignedIn, SignedOut } from "@/lib/auth/gates";
import { PLANS, type PlanId } from "@/lib/license";
import { setMyLicenseFn } from "@/lib/license-api";
import { useEnclave } from "@/lib/store";

export const Route = createFileRoute("/www/pricing")({
  component: WwwPricing,
  head: () => ({ meta: [{ title: "套餐 — Enclave" }] }),
});

const COPY: Record<PlanId, { price: string; points: string[] }> = {
  free: {
    price: "免费",
    points: ["3 个环境", "1 席位 · 1 并发", "本机工作台"],
  },
  solo: {
    price: "订阅",
    points: ["50 个环境", "1 席位 · 3 并发", "本机只读 API"],
  },
  pro: {
    price: "订阅",
    points: ["200 个环境", "1 席位 · 8 并发", "完整本机 API"],
  },
};

function WwwPricing() {
  return (
    <WwwShell>
      <WwwMain>
        <p className="www-kicker">Pricing</p>
        <h1>按环境数订阅。</h1>
        <p className="www-lead">
          安装包不收费。登录后档位写到账号，工作台启动时读取。环境数据仍只在本机。
        </p>
        <div className="www-grid www-grid-3">
          {(Object.keys(PLANS) as PlanId[]).map((id) => (
            <article key={id} className="www-card">
              <p className="www-kicker">{PLANS[id].label}</p>
              <p className="www-price">{COPY[id].price}</p>
              <ul>
                {COPY[id].points.map((p) => (
                  <li key={p}>{p}</li>
                ))}
              </ul>
              <SignedOut>
                <Link to="/login" className="www-btn www-btn-primary">
                  登录后订阅 {PLANS[id].label}
                </Link>
              </SignedOut>
              <SignedIn>
                <SubscribeButton plan={id} />
              </SignedIn>
            </article>
          ))}
        </div>
      </WwwMain>
    </WwwShell>
  );
}

function SubscribeButton({ plan }: { plan: PlanId }) {
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const current = useEnclave((s) => s.settings.plan);
  return (
    <button
      type="button"
      className="www-btn www-btn-primary"
      disabled={busy || current === plan}
      onClick={() => {
        setBusy(true);
        void setMyLicenseFn({ data: plan })
          .catch(() => ({ plan }))
          .then((lic) => {
            useEnclave.getState().patchSettings({ plan: lic.plan });
            setBusy(false);
            void navigate({ to: "/" });
          });
      }}
    >
      {current === plan ? "当前档位" : `使用 ${PLANS[plan].label}`}
    </button>
  );
}
