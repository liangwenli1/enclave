import { createFileRoute, Link } from "@tanstack/react-router";
import { WwwMain, WwwShell } from "@/components/www-shell";
import { PLANS, type PlanId } from "@/lib/license";

export const Route = createFileRoute("/www/pricing")({
  component: WwwPricing,
  head: () => ({ meta: [{ title: "套餐 — Enclave" }] }),
});

const COPY: Record<PlanId, { price: string; points: string[] }> = {
  free: {
    price: "免费",
    points: ["3 个环境", "1 席位 · 1 并发", "API 关闭", "走完下内核、开环境、进实验室"],
  },
  solo: {
    price: "订阅",
    points: ["50 个环境", "1 席位 · 3 并发", "本机只读 API 发现"],
  },
  pro: {
    price: "订阅",
    points: ["200 个环境", "1 席位 · 8 并发", "完整本机 API · 窗口同步 · 2 设备"],
  },
};

function WwwPricing() {
  return (
    <WwwShell>
      <WwwMain>
        <p className="www-kicker">Pricing</p>
        <h1>按环境数订阅。</h1>
        <p className="www-lead">
          安装包不收费。内核安全更新不对已付费用户锁在更高档。厂商许可证未接时，工作台设置里的档位只用于验证本机上限。
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
              <Link to="/www/account" className="www-btn www-btn-primary">
                注册 {PLANS[id].label}
              </Link>
            </article>
          ))}
        </div>
        <p className="www-hint">Team：200 环境起、3 席位起。结构不变，数字可调。</p>
      </WwwMain>
    </WwwShell>
  );
}
