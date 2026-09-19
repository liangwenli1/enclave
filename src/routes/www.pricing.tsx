import { createFileRoute, Link } from "@tanstack/react-router";
import { WwwShell, WwwWrap } from "@/components/www-shell";
import { PLANS } from "@/lib/license";

export const Route = createFileRoute("/www/pricing")({
  component: WwwPricing,
  head: () => ({ meta: [{ title: "套餐 — Enclave" }] }),
});

function WwwPricing() {
  const rows = [
    { ...PLANS.free, price: "免费", apiText: "关", extra: "走完：下内核 → 开一个环境 → 实验室" },
    { ...PLANS.solo, price: "订阅", apiText: "本机只读发现", extra: "1 席位" },
    { ...PLANS.pro, price: "订阅", apiText: "完整本机 API", extra: "窗口同步开 · 2 设备" },
  ];
  return (
    <WwwShell>
      <WwwWrap>
        <h1 className="text-[28px] font-semibold tracking-tight">套餐</h1>
        <p className="mt-2 max-w-xl text-[14px] text-subtle">
          安装包不收费。按环境数 + 席位订阅。内核安全更新不对已付费用户锁在更高档。厂商账号未接时，工作台设置里的档位只用于验证本机上限。
        </p>
        <div className="mt-8 grid gap-3 md:grid-cols-3">
          {rows.map((p) => (
            <div key={p.id} className="flex flex-col rounded-xl border border-line bg-surface p-5">
              <div className="text-[13px] text-subtle">{p.label}</div>
              <div className="mt-1 text-[22px] font-semibold">{p.price}</div>
              <ul className="mt-4 grid gap-1.5 text-[13px] text-muted">
                <li>{p.envLimit} 个环境</li>
                <li>{p.seats} 席位 · {p.concurrent} 并发窗口</li>
                <li>API {p.apiText}</li>
                <li>{p.extra}</li>
              </ul>
              <Link
                to="/www/account"
                className="mt-6 inline-flex h-8 items-center justify-center rounded-md bg-accent text-[13px] font-medium text-accent-fg"
              >
                注册 {p.label}
              </Link>
            </div>
          ))}
        </div>
        <p className="mt-6 text-[12px] text-subtle">Team：200 环境起、3 席位起。结构不变，数字可调。未单列购买页。</p>
      </WwwWrap>
    </WwwShell>
  );
}
