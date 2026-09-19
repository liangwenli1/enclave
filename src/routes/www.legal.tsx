import { createFileRoute } from "@tanstack/react-router";
import { WwwShell, WwwWrap } from "@/components/www-shell";

export const Route = createFileRoute("/www/legal")({
  component: WwwLegal,
  head: () => ({ meta: [{ title: "安全与法律 — Enclave" }] }),
});

function WwwLegal() {
  return (
    <WwwShell>
      <WwwWrap className="max-w-2xl">
        <h1 className="text-[28px] font-semibold tracking-tight">安全与法律</h1>
        <section className="mt-6 grid gap-2 text-[13px] text-muted">
          <h2 className="text-[15px] font-medium text-ink">内核许可</h2>
          <p>fingerprint-chromium 基于 Ungoogled Chromium，BSD-3-Clause。不是 100% 自研内核。补丁源码若延迟，不得宣传已完整审计。</p>
        </section>
        <section className="mt-6 grid gap-2 text-[13px] text-muted">
          <h2 className="text-[15px] font-medium text-ink">第一版必须防</h2>
          <ul className="list-disc pl-5">
            <li>恶意内核镜像：哈希不符拒启</li>
            <li>假安装包：1.0 必须签名（尚未交付）</li>
            <li>CDP / 本机 API 被扫：只绑 127.0.0.1，API 默认关</li>
            <li>环境串数据：独立 user-data</li>
            <li>代理密码进日志：只存 passwordRef</li>
          </ul>
        </section>
        <section className="mt-6 grid gap-2 text-[13px] text-muted">
          <h2 className="text-[15px] font-medium text-ink">不承诺</h2>
          <p>不承诺过某站风控。不承诺国家级完整控机。用户主动关闭沙箱后的后果自行承担。</p>
        </section>
        <section className="mt-6 grid gap-2 text-[13px] text-muted">
          <h2 className="text-[15px] font-medium text-ink">披露</h2>
          <p>security@enclave.local（渠道草稿，正式域名未上。）</p>
        </section>
      </WwwWrap>
    </WwwShell>
  );
}
