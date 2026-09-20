import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Badge, Button, Panel, PanelHeader, PageHeader } from "@/components/ui";
import { getKernelView, type KernelView } from "@/lib/kernel/host-api";
import { eventLabel, t } from "@/lib/i18n";
import { useEnclave } from "@/lib/store";

export const Route = createFileRoute("/security")({ component: SecurityPage });

function SecurityPage() {
  const settings = useEnclave((s) => s.settings);
  const audit = useEnclave((s) => s.audit);
  const [view, setView] = useState<KernelView | null>(null);
  const hasVault = useEnclave((s) => s.vault.exists);

  useEffect(() => {
    void getKernelView().then(setView);
  }, []);

  // 连不上本机服务时，内核的状态是"不知道"，不是"没准入"，更不是"正常"。
  const online = view?.online ?? false;
  const kernels = view?.kernels ?? [];
  const admitted = kernels.some((k) => k.status.state === "admitted");
  // 已经下载的版本里有预览通道的，或者一个都没下、而默认版本是预览通道。
  const inUse = admitted
    ? kernels.filter((k) => k.status.state === "admitted")
    : kernels.filter((k) => k.record.version === view?.defaultVersion);
  const previewChannel = inUse.some((k) => k.record.channel !== "stable");

  return (
    <div className="mx-auto max-w-[1280px] px-8 py-6 *:max-w-3xl">
      <PageHeader title={t("securityTitle")} />

      <div className="grid gap-4">
        <Panel className="overflow-hidden">
          <PanelHeader title="当前状态" />
          <ul className="grid gap-px bg-line">
            <Check
              ok={online}
              label="本机接口"
              detail={online ? "仅 127.0.0.1 · 需要令牌 · 限工作台来源" : "连不上本机服务，重启工作台再试"}
            />
            <Check
              ok={admitted}
              neutral={!online}
              label="内核完整性"
              detail={
                !online
                  ? "未知"
                  : admitted
                    ? "每次启动前核对可执行文件哈希"
                    : "还没有下载任何内核，环境无法启动"
              }
            />
            <Check
              ok={!settings.allowNoSandboxHost}
              label="内核沙箱"
              detail={
settings.allowNoSandboxHost ? "你已允许关闭沙箱" : "开启"
              }
            />
            <Check
              ok={hasVault}
              label="保险箱"
              detail={
hasVault ? "代理密码以密文保存" : "没设主密码，代理密码不会被保存"
              }
            />
            <Check
              ok={!previewChannel || !settings.allowPreviewKernel}
              neutral={!online}
              label="内核通道"
              detail={
                !online
                  ? "未知"
                  : previewChannel
                  ? settings.allowPreviewKernel
                    ? "预览通道，你已同意使用"
                    : "预览通道，需要你同意后才能用"
                  : "稳定通道"
              }
            />
            <Check ok={false} neutral label="安装包签名" detail="未签名，请用下载页的 SHA256 核对" />
          </ul>
        </Panel>

        <Panel>
          <PanelHeader title="你可以自己关掉的保护" />
          <div className="grid gap-4 p-5">
            <Consent
              checked={settings.allowNoSandboxHost}
              title="允许在启动时关闭内核沙箱"
              body="关掉后，网页里的漏洞更容易影响到你的系统。"
              onChange={(checked) => {
                useEnclave.getState().patchSettings({ allowNoSandboxHost: checked });
                useEnclave.getState().addAudit({
                  action: "sandbox_consent",
                  level: "warn",
                  detail: checked ? "允许 --no-sandbox" : "已撤销",
                });
              }}
            />
            <Consent
              checked={settings.allowPreviewKernel}
              title="允许使用预览通道的内核"
              body="哈希已核对，但还没在这个平台上做过完整行为测试。"
              onChange={(checked) => {
                useEnclave.getState().patchSettings({ allowPreviewKernel: checked });
                useEnclave.getState().addAudit({
                  action: "preview_kernel_consent",
                  level: "warn",
                  detail: checked ? "允许预览通道内核" : "已撤销",
                });
              }}
            />
          </div>
        </Panel>

        <Panel>
          <PanelHeader
            title="诊断包"
            hint="不含 Cookie、密码和网址"
            actions={
              <Button
                onClick={() => {
                  const blob = new Blob(
                    [
                      JSON.stringify(
                        {
                          exportedAt: new Date().toISOString(),
                          contains: ["本机运行条件", "内核状态", "最近 50 条审计"],
                          excludes: ["Cookie", "密码", "访问过的网址", "环境内容"],
                          capabilities: view?.capabilities ?? null,
                          kernels: kernels.map((k) => ({
                            version: k.record.version,
                            channel: k.record.channel,
                            ...k.status,
                          })),
                          audit: audit.slice(0, 50),
                        },
                        null,
                        2,
                      ),
                    ],
                    { type: "application/json" },
                  );
                  const url = URL.createObjectURL(blob);
                  const a = document.createElement("a");
                  a.href = url;
                  a.download = "enclave-diagnostic.json";
                  a.click();
                  URL.revokeObjectURL(url);
                }}
              >
                导出诊断包
              </Button>
            }
          />
        </Panel>

        <Panel>
          <PanelHeader title={t("audit")} />
          {audit.length === 0 ? (
            <p className="px-5 py-8 text-center text-[13px] text-subtle">还没有需要记录的操作。</p>
          ) : (
            <ol className="max-h-96 overflow-auto">
              {audit.map((ev) => (
                <li key={ev.id} className="border-t border-line px-5 py-3 first:border-t-0">
                  <div className="flex flex-wrap justify-between gap-2 text-[13px]">
                    <span className="font-medium text-ink">{eventLabel(ev.action)}</span>
                    <span className="app-mono text-xs text-subtle">
                      {new Date(ev.at).toLocaleString("zh-CN")}
                    </span>
                  </div>
                  <div
                    className={
                      ev.level === "bad"
                        ? "mt-0.5 text-[13px] text-bad"
                        : ev.level === "warn"
                          ? "mt-0.5 text-[13px] text-warn"
                          : "mt-0.5 text-[13px] text-subtle"
                    }
                  >
                    {ev.detail}
                  </div>
                </li>
              ))}
            </ol>
          )}
        </Panel>

      </div>
    </div>
  );
}

function Check({
  ok,
  neutral,
  label,
  detail,
}: {
  ok: boolean;
  /** 不算好也不算坏：没连上所以不知道，或者这一项本来就没有。优先于 ok。 */
  neutral?: boolean;
  label: string;
  detail: string;
}) {
  const unknown = neutral && detail === "未知";
  return (
    <li className="flex flex-wrap items-start justify-between gap-3 bg-surface px-5 py-4">
      <div className="min-w-0">
        <div className="text-[13px] font-medium text-ink">{label}</div>
        <p className="mt-1 max-w-[62ch] text-[13px] leading-relaxed text-subtle">{detail}</p>
      </div>
      <Badge tone={neutral ? "neutral" : ok ? "ok" : "warn"}>
        {neutral ? (unknown ? "未知" : "未提供") : ok ? "正常" : "需要注意"}
      </Badge>
    </li>
  );
}

function Consent({
  checked,
  title,
  body,
  onChange,
}: {
  checked: boolean;
  title: string;
  body: string;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="flex cursor-pointer items-start gap-3">
      <input
        type="checkbox"
        className="mt-1 size-4 flex-none accent-[var(--enclave-accent)]"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span>
        <span className={checked ? "text-[13px] font-medium text-warn" : "text-[13px] font-medium text-ink"}>
          {title}
        </span>
        <span className="mt-1 block max-w-[62ch] text-[13px] leading-relaxed text-subtle">{body}</span>
      </span>
    </label>
  );
}
