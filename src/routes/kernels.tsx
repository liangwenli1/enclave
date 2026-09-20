import { createFileRoute, Link } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import { Badge, Button, CodeBlock, Panel, PanelHeader, PageHeader } from "@/components/ui";
import { useLocale } from "@/lib/use-locale";
import { admitKernel, getKernelView, type KernelView } from "@/lib/kernel/host-api";
import { t } from "@/lib/i18n";
import { KERNEL_PIN } from "@/lib/schema";
import { useEnclave } from "@/lib/store";

export const Route = createFileRoute("/kernels")({ component: KernelsPage });

/** 内部状态 → 用户能看懂的话。界面上不出现 admitted / hash_mismatch 这种词。 */
const STATE_LABEL: Record<string, { text: string; tone: "ok" | "warn" | "bad" }> = {
  absent: { text: "未下载", tone: "warn" },
  downloading: { text: "下载中", tone: "warn" },
  verifying: { text: "校验中", tone: "warn" },
  extracting: { text: "解压中", tone: "warn" },
  admitted: { text: "已准入", tone: "ok" },
  hash_mismatch: { text: "哈希不符，已拒用", tone: "bad" },
  error: { text: "出错了", tone: "bad" },
};

/** 只在出错时出现，所以写得具体一点：说清是什么、下一步做什么。 */
const ERROR_HINT: Record<string, string> = {
  KERNEL_HASH_MISMATCH: "文件和清单里的哈希对不上，已拒用。重新准入一次；反复出现请联系我们。",
  KERNEL_CHANNEL_BLOCKED: "这个平台的内核还在预览通道，要先到安全中心同意。",
  KERNEL_UNTRUSTED_SOURCE: "清单里没有这个平台的哈希，或者文件不在了。",
  HOST_UNAVAILABLE: "连不上本机服务。重启工作台再试。",
};

function KernelsPage() {
  const locale = useLocale();
  const allowPreview = useEnclave((s) => s.settings.allowPreviewKernel);
  const [view, setView] = useState<KernelView | null>(null);
  const [busy, setBusy] = useState(false);
  const [blocked, setBlocked] = useState<string | null>(null);

  const load = useCallback(async () => {
    setView(await getKernelView());
  }, []);

  useEffect(() => {
    void load();
    const id = window.setInterval(() => void load(), 1500);
    return () => window.clearInterval(id);
  }, [load]);

  const status = view?.status;
  const kernel = view?.kernel?.manifest;
  const caps = view?.capabilities;
  const state = status?.state ?? "absent";
  const label = STATE_LABEL[state] ?? STATE_LABEL.error;
  const isPreviewChannel = Boolean(kernel && kernel.channel !== "stable");
  const busyState = state === "downloading" || state === "verifying" || state === "extracting";
  const pct =
    status && status.bytesExpected
      ? Math.min(100, Math.round((status.bytesReceived / status.bytesExpected) * 100))
      : 0;

  const admit = async () => {
    setBusy(true);
    setBlocked(null);
    const res = (await admitKernel(allowPreview)) as { code?: string; message?: string };
    if (res?.code) setBlocked(ERROR_HINT[res.code] ?? res.message ?? res.code);
    useEnclave.getState().addAudit({
      action: "kernel_admit",
      level: res?.code ? "warn" : "info",
      detail: res?.code ?? KERNEL_PIN.version,
    });
    await load();
    setBusy(false);
  };

  if (view && !view.online) {
    return (
      <div className="mx-auto max-w-3xl px-8 py-6">
        <PageHeader title={t(locale, "kernelsTitle")} />
        <Panel className="p-6">
          <Badge tone="bad">连不上本机服务</Badge>
          <p className="mt-3 text-[13px] text-muted">重启工作台再试。</p>
        </Panel>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-3xl px-8 py-6">
      <PageHeader
        title={t(locale, "kernelsTitle")}
        status={`${kernel?.id ?? KERNEL_PIN.id} ${kernel?.version ?? KERNEL_PIN.version} · ${label.text}`}
      />

      <Panel>
        <PanelHeader
          title={`${kernel?.id ?? KERNEL_PIN.id} ${kernel?.version ?? KERNEL_PIN.version}`}
          hint={isPreviewChannel ? "预览通道" : "稳定通道"}
          actions={<Badge tone={label.tone}>{label.text}</Badge>}
        />
        <div className="grid gap-4 p-5">
          {busyState ? (
            <div>
              <div className="h-1 overflow-hidden rounded-full bg-surface-2">
                <div className="h-full bg-accent transition-[width]" style={{ width: `${pct}%` }} />
              </div>
              <div className="app-mono mt-2 text-xs text-subtle">
                {label.text} {pct}%
              </div>
            </div>
          ) : null}

          <CodeBlock label="清单哈希 SHA256" value={kernel?.sha256 ?? KERNEL_PIN.sha256} />

          {status?.exeSha256 ? (
            <CodeBlock label="本机可执行文件 SHA256" value={status.exeSha256} />
          ) : null}

          {status?.executable ? (
            <div className="text-[13px] text-subtle">
              安装位置 <span className="app-mono text-muted">{status.executable}</span>
            </div>
          ) : null}

          {state === "hash_mismatch" || status?.error ? (
            <p className="text-[13px] leading-relaxed text-bad">
              {ERROR_HINT[status?.error ?? ""] ?? status?.error ?? ERROR_HINT.KERNEL_HASH_MISMATCH}
            </p>
          ) : null}

          {blocked ? <p className="text-[13px] leading-relaxed text-warn">{blocked}</p> : null}

          {isPreviewChannel && !allowPreview ? (
            <div className="rounded-md border border-warn/30 bg-warn/10 px-4 py-3 text-[13px] text-warn">
              这个平台的内核还在预览通道。到
              <Link to="/security" className="mx-1 font-semibold underline">
                安全中心
              </Link>
              明确同意后才能准入。
            </div>
          ) : null}

          <div>
            <Button
              variant="primary"
              size="md"
              disabled={busy || busyState || state === "admitted" || (isPreviewChannel && !allowPreview)}
              title={
                state === "admitted"
                  ? "已经准入，不需要重复下载"
                  : isPreviewChannel && !allowPreview
                    ? "需要先在安全中心同意使用预览通道内核"
                    : undefined
              }
              onClick={() => void admit()}
            >
              {state === "admitted" ? t(locale, "admitted") : t(locale, "download")}
            </Button>
          </div>
        </div>
      </Panel>

      <Panel className="mt-4 p-5">
        <dl className="grid gap-2 text-[13px]">
          <Line k="窗口" v={caps?.headlessForced ? "无头（没有显示器）" : "可见窗口"} />
          <Line k="沙箱" v={caps?.sandboxLikely === false ? "本机可能无法启用" : "默认开启"} />
          <Line k="许可证" v="Ungoogled Chromium · BSD-3-Clause" />
        </dl>
      </Panel>
    </div>
  );
}

function Line({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex flex-wrap justify-between gap-3">
      <dt className="text-subtle">{k}</dt>
      <dd className="text-muted">{v}</dd>
    </div>
  );
}
