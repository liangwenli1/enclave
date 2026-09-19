import { createFileRoute } from "@tanstack/react-router";
import { WwwMain, WwwShell } from "@/components/www-shell";

export const Route = createFileRoute("/www/docs")({
  component: WwwDocs,
  head: () => ({ meta: [{ title: "文档 — Enclave" }] }),
});

const TOC = [
  ["#install", "安装"],
  ["#env", "创建环境"],
  ["#proxy", "代理"],
  ["#lab", "实验室"],
  ["#api", "API"],
  ["#security", "安全"],
];

function WwwDocs() {
  return (
    <WwwShell>
      <WwwMain>
        <p className="www-kicker">Docs</p>
        <h1>中文用户文档。</h1>
        <p className="www-lead">合同要求：安装、创建环境、代理、实验室、API、安全说明。以下按客户在自己电脑上的用法写。安装包未签发的步骤会标明。</p>
        <nav className="www-toc">
          {TOC.map(([href, label]) => (
            <a key={href} href={href}>
              {label}
            </a>
          ))}
        </nav>
        <article className="www-doc">
          <h3 id="install">安装</h3>
          <p>打开官网下载页，核对本机系统对应安装包的 SHA256。哈希为空则不要装。安装后打开本机工作台并登录。内核不预置在安装包里：第一次启动前由内核管理器按清单下载并校验。Linux 验证机可以走工作台里的内核页完成准入，那不是客户 1.0 路径。</p>
          <h3 id="env">创建环境</h3>
          <p>工作台首页新建环境。来源可选空白、模板或复制。生成画像后锁定种子。档位上限在创建时强制：Free 3、Solo 50、Pro 200。超限只能升级，不会偷偷建出第 N+1 个。启动前内核必须已准入，否则原因码 KERNEL_UNTRUSTED_SOURCE。</p>
          <h3 id="proxy">代理</h3>
          <p>网络页添加 HTTP / HTTPS / SOCKS5。密码只存保险箱引用，不进配置明文、不进日志。环境绑定一个代理。探测出口是工作台自己的网络，不等于内核出口；内核走启动参数里的代理。失败会停在错误态，不显示 Running。</p>
          <h3 id="lab">实验室</h3>
          <p>先启动环境。对照采集当前页，内核采集走 CDP，目标是该环境的内核页面。无显示器时内核 headless，文案会标明 runtime: native。差异按字段列出，不把对照页冒充成内核窗口。</p>
          <h3 id="api">API</h3>
          <p>默认关闭。Free 不能开。开启后只监听本机回环并要求 token。危险操作二次确认。不要把 Host 端口暴露到公网，也不要把工作台当网站卖。</p>
          <h3 id="security">安全说明</h3>
          <p>启动前磁盘哈希必须匹配。调试口只绑 127.0.0.1。默认开沙箱；--no-sandbox 必须在安全中心明确勾选并写入审计。不承诺过某站风控，不承诺国家级完整控机。披露邮箱 security@enclave.local（草稿）。完整威胁模型见安全与法律页。</p>
        </article>
      </WwwMain>
    </WwwShell>
  );
}
