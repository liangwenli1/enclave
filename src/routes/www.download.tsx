import { createFileRoute } from "@tanstack/react-router";
import { WwwMain, WwwShell } from "@/components/www-shell";
import { APP_INSTALLERS, KERNEL_HASHES } from "@/lib/kernel-hashes";

export const Route = createFileRoute("/www/download")({
  component: WwwDownload,
  head: () => ({ meta: [{ title: "下载 — Enclave" }] }),
});

function WwwDownload() {
  return (
    <WwwShell>
      <WwwMain>
        <p className="www-kicker">Download</p>
        <h1>先核哈希，再安装。</h1>
        <p className="www-lead">
          客户下的是签过名的工作台安装包。内核由工作台按清单校验。安装包尚未签发，所以没有下载按钮。内核哈希来自官方 GitHub Release，可以先对照。
        </p>

        <section className="www-section">
          <h2>工作台安装包</h2>
          <div className="www-table-wrap">
            <table>
              <thead>
                <tr>
                  <th>平台</th>
                  <th>文件</th>
                  <th>SHA256</th>
                  <th>状态</th>
                </tr>
              </thead>
              <tbody>
                {APP_INSTALLERS.map((row) => (
                  <tr key={row.file}>
                    <td>{row.platform}</td>
                    <td className="www-mono">{row.file}</td>
                    <td>—</td>
                    <td className="www-warn">{row.status}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="www-hint">没有哈希的包不会开放下载。不提供未签名安装包。</p>
        </section>

        <section className="www-section">
          <h2>内核 148.0.7778.215</h2>
          <div className="www-table-wrap">
            <table>
              <thead>
                <tr>
                  <th>平台</th>
                  <th>通道</th>
                  <th>SHA256</th>
                  <th>bytes</th>
                </tr>
              </thead>
              <tbody>
                {KERNEL_HASHES.map((row) => (
                  <tr key={row.platform}>
                    <td>{row.platform}</td>
                    <td>{row.channel}</td>
                    <td className="www-mono">{row.sha256}</td>
                    <td className="www-mono">{row.bytes}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="www-hint">linux-x64 为 stable。win / mac 为 candidate，未在对应系统完成 spawn 基线前不得进 stable。</p>
        </section>
      </WwwMain>
    </WwwShell>
  );
}
