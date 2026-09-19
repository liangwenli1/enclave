import { createFileRoute } from "@tanstack/react-router";
import { WwwShell, WwwWrap } from "@/components/www-shell";
import { APP_INSTALLERS, KERNEL_HASHES } from "@/lib/kernel-hashes";

export const Route = createFileRoute("/www/download")({
  component: WwwDownload,
  head: () => ({ meta: [{ title: "下载 — Enclave" }] }),
});

function WwwDownload() {
  return (
    <WwwShell>
      <WwwWrap>
        <h1 className="text-[28px] font-semibold tracking-tight">下载与 SHA256</h1>
        <p className="mt-2 max-w-2xl text-[14px] text-subtle">
          1.0 客户下的是签过名的工作台安装包，再由内核管理器校验 fingerprint-chromium。下面两项必须分开看：安装包还没签发；内核哈希来自官方 GitHub Release，已经公示。
        </p>

        <h2 className="mt-10 text-[15px] font-medium">工作台安装包</h2>
        <div className="mt-3 overflow-x-auto rounded-lg border border-line">
          <table className="w-full min-w-[640px] text-left text-[13px]">
            <thead className="bg-surface-2 text-[11px] uppercase text-subtle">
              <tr>
                <th className="px-3 py-2">平台</th>
                <th className="px-3 py-2">文件</th>
                <th className="px-3 py-2">SHA256</th>
                <th className="px-3 py-2">状态</th>
              </tr>
            </thead>
            <tbody>
              {APP_INSTALLERS.map((row) => (
                <tr key={row.file} className="border-t border-line">
                  <td className="px-3 py-2">{row.platform}</td>
                  <td className="px-3 py-2 font-mono text-[12px]">{row.file}</td>
                  <td className="px-3 py-2 font-mono text-[12px] text-subtle">—</td>
                  <td className="px-3 py-2 text-warn">{row.status}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-2 text-[12px] text-subtle">没有哈希的安装包不会开放下载按钮。不提供未签名包。</p>

        <h2 className="mt-10 text-[15px] font-medium">已准入 / 候选内核</h2>
        <div className="mt-3 overflow-x-auto rounded-lg border border-line">
          <table className="w-full min-w-[720px] text-left text-[13px]">
            <thead className="bg-surface-2 text-[11px] uppercase text-subtle">
              <tr>
                <th className="px-3 py-2">平台</th>
                <th className="px-3 py-2">通道</th>
                <th className="px-3 py-2">SHA256</th>
                <th className="px-3 py-2">bytes</th>
              </tr>
            </thead>
            <tbody>
              {KERNEL_HASHES.map((row) => (
                <tr key={row.platform} className="border-t border-line">
                  <td className="px-3 py-2">{row.platform}</td>
                  <td className="px-3 py-2">{row.channel}</td>
                  <td className="px-3 py-2 font-mono text-[11px]">{row.sha256}</td>
                  <td className="px-3 py-2 font-mono text-[12px]">{row.bytes}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-2 text-[12px] text-subtle">
          linux-x64 为 stable。win / mac 为 candidate：哈希来自 GitHub Release digest，未在对应系统完成 spawn 基线前不得进 stable。
        </p>
      </WwwWrap>
    </WwwShell>
  );
}
