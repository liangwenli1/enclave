import { createFileRoute, Link } from "@tanstack/react-router";
import { WwwShell, WwwWrap } from "@/components/www-shell";

export const Route = createFileRoute("/www")({
  component: WwwHome,
  head: () => ({
    meta: [{ title: "Enclave — 本机多环境浏览器" }],
  }),
});

function WwwHome() {
  return (
    <WwwShell>
      <WwwWrap>
        <p className="text-[12px] uppercase tracking-[0.16em] text-subtle">Desktop · Native kernel</p>
        <h1 className="mt-3 max-w-3xl text-[36px] font-semibold leading-[1.15] tracking-tight md:text-[44px]">
          内核跑在你自己的电脑上。
          <br />
          不是网页里开 Chrome。
        </h1>
        <p className="mt-4 max-w-2xl text-[15px] text-muted">
          Enclave 是本机多环境浏览器工作台。安装包免费下载，额度由账号解锁。Cookie、指纹、出口按环境隔离。实验室采集的是内核窗口，不是工作台自己的页面。
        </p>
        <div className="mt-6 flex flex-wrap gap-2">
          <Link
            to="/www/download"
            className="inline-flex h-9 items-center rounded-md bg-accent px-4 text-[13px] font-medium text-accent-fg"
          >
            下载与校验
          </Link>
          <Link
            to="/www/pricing"
            className="inline-flex h-9 items-center rounded-md border border-line bg-surface-2 px-4 text-[13px]"
          >
            看套餐
          </Link>
        </div>
        <p className="mt-3 text-[12px] text-subtle">Windows / macOS 安装包尚未签发。当前仓库是 Linux 验证机与源码。</p>
      </WwwWrap>

      <WwwWrap className="grid gap-3 py-0 pb-12 md:grid-cols-3">
        {[
          { t: "本机 spawn", d: "fingerprint-chromium 在客户电脑启动。调试口只绑 127.0.0.1。哈希不符拒启。" },
          { t: "一环境一画像", d: "种子锁定后重启稳定。WebRTC 默认不暴露真实 IP。代理失败有人话原因码。" },
          { t: "不卖过站承诺", d: "内核基于 Ungoogled Chromium 补丁，BSD-3-Clause。不宣传已过某站、不宣传 100% 自研内核。" },
        ].map((c) => (
          <div key={c.t} className="rounded-xl border border-line bg-surface p-4">
            <div className="text-[14px] font-medium">{c.t}</div>
            <p className="mt-2 text-[13px] text-subtle">{c.d}</p>
          </div>
        ))}
      </WwwWrap>

      <WwwWrap className="py-0 pb-16">
        <h2 className="text-[18px] font-semibold">客户用法</h2>
        <ol className="mt-4 grid gap-2 text-[13px] text-muted md:grid-cols-2">
          {[
            "打开官网，注册，选免费档或付费档。",
            "下载对应系统的安装包，校验 SHA256，安装。",
            "打开本机工作台，登录账号，额度同步。",
            "新建环境 → 配代理 → 锁定画像 → 启动。本机弹出独立内核窗口。",
            "实验室采集该内核窗口。失败则拒启并显示原因码。",
            "换电脑：装客户端并登录。云同步未做时只能导入环境包。",
          ].map((s, i) => (
            <li key={s} className="rounded-lg border border-line bg-surface-2 px-3 py-2">
              <span className="mr-2 font-mono text-[11px] text-subtle">{i + 1}</span>
              {s}
            </li>
          ))}
        </ol>
      </WwwWrap>
    </WwwShell>
  );
}
