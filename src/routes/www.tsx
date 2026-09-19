import { createFileRoute, Link } from "@tanstack/react-router";
import { WwwMain, WwwShell } from "@/components/www-shell";

export const Route = createFileRoute("/www")({
  component: WwwHome,
  head: () => ({
    meta: [{ title: "Enclave — 本机多环境浏览器" }],
  }),
});

function WwwHome() {
  return (
    <WwwShell>
      <WwwMain>
        <p className="www-kicker">Desktop · native kernel</p>
        <h1>内核跑在你自己的电脑上。</h1>
        <p className="www-lead">
          Enclave 是本机多环境浏览器。安装包免费，额度由账号解锁。每个环境有独立的 Cookie、指纹和出口。实验室采集的是内核窗口，不是这张网页。
        </p>
        <div className="www-actions">
          <Link to="/www/download" className="www-btn www-btn-primary">
            下载与校验
          </Link>
          <Link to="/www/pricing" className="www-btn www-btn-ghost">
            套餐
          </Link>
        </div>
        <p className="www-hint">Windows / macOS 安装包尚未签发。没有哈希的文件不会开放下载。</p>

        <div className="www-grid www-grid-3">
          <article className="www-card">
            <h3>本机启动</h3>
            <p>fingerprint-chromium 在客户电脑 spawn。调试口只绑本机回环。哈希不符直接拒启。</p>
          </article>
          <article className="www-card">
            <h3>一环境一画像</h3>
            <p>种子锁定后重启稳定。WebRTC 默认不暴露真实 IP。代理失败给出原因码，不假绿灯。</p>
          </article>
          <article className="www-card">
            <h3>不承诺过站</h3>
            <p>内核基于 Ungoogled Chromium，BSD-3-Clause。不宣传已过某站，不宣传 100% 自研内核。</p>
          </article>
        </div>

        <section className="www-section">
          <h2>用法</h2>
          <div className="www-grid www-grid-2">
            {[
              "官网注册，选免费档或付费档。",
              "下载安装包，核 SHA256，安装。",
              "打开本机工作台，登录，同步额度。",
              "建环境、配代理、锁画像、启动。本机弹出独立内核窗口。",
              "实验室采集该窗口。失败则拒启。",
              "换电脑：安装并登录。云同步未做时导入环境包。",
            ].map((text, i) => (
              <div key={text} className="www-step">
                <b>{String(i + 1).padStart(2, "0")}</b>
                <span>{text}</span>
              </div>
            ))}
          </div>
        </section>
      </WwwMain>
    </WwwShell>
  );
}
