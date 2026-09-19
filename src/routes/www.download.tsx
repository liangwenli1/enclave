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
          Windows 预览包已放出，自签名，不是 1.0。下载后核发布页说明。macOS 尚未签发。
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
                    <td className="www-mono">
                      {row.href ? (
                        <a href={row.href} target="_blank" rel="noreferrer">
                          {row.file}
                        </a>
                      ) : (
                        row.file
                      )}
                    </td>
                    <td>—</td>
                    <td className="www-warn">{row.status}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="www-hint">Windows 预览包是自签名。其他机器仍会提示未知发布者。</p>
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
