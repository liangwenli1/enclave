import { createFileRoute, Link } from "@tanstack/react-router";
import { WwwShell, WwwWrap } from "@/components/www-shell";

export const Route = createFileRoute("/www/docs")({
  component: WwwDocs,
  head: () => ({ meta: [{ title: "文档 — Enclave" }] }),
});

function WwwDocs() {
  return (
    <WwwShell>
      <WwwWrap className="max-w-2xl">
        <h1 className="text-[28px] font-semibold tracking-tight">文档</h1>
        <p className="mt-2 text-[14px] text-subtle">安装、环境、代理、实验室、API、安全。1.0 完整文档跟安装包走。这里是现在能公开的部分。</p>
        <ul className="mt-6 grid gap-2 text-[13px]">
          {[
            ["下载与 SHA256", "/www/download", "安装包哈希（未签发）与内核 GitHub Release digest"],
            ["套餐与额度", "/www/pricing", "Free / Solo / Pro。安装包免费，功能靠登录解锁"],
            ["安全说明", "/www/legal", "威胁模型摘要、披露邮箱、不承诺事项"],
          ].map(([title, to, d]) => (
            <li key={to}>
              <Link to={to} className="block rounded-lg border border-line bg-surface px-4 py-3 hover:bg-surface-2">
                <div className="font-medium">{title}</div>
                <div className="mt-1 text-subtle">{d}</div>
              </Link>
            </li>
          ))}
        </ul>
        <div className="mt-8 rounded-lg border border-line bg-surface-2 p-4 text-[13px] text-muted">
          <div className="font-medium text-ink">API 默认关闭</div>
          <p className="mt-2">开启后仅 127.0.0.1 + token。危险操作二次确认。不提供把内核挂到公网的部署说明。</p>
        </div>
      </WwwWrap>
    </WwwShell>
  );
}
