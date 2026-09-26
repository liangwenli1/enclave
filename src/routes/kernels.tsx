import { createFileRoute, Link } from "@tanstack/react-router";
import { ENGINE_CLASSES, ENGINE_META } from "@/lib/engines-meta";
import { useCallback, useEffect, useState } from "react";
import {
  Badge,
  Button,
  CodeBlock,
  Dialog,
  DialogContent,
  Panel,
  PanelHeader,
  PageHeader,
} from "@/components/ui";
import {
  admitKernel,
  getKernelView,
  removeKernel,
  type KernelEntry,
  type KernelView,
} from "@/lib/kernel/host-api";
import { t } from "@/lib/i18n";
import { useEnclave } from "@/lib/store";

export const Route = createFileRoute("/kernels")({ component: KernelsPage });

/** 内部状态 → 用户能看懂的话。界面上不出现 admitted / hash_mismatch 这种词。 */
const STATE_LABEL: Record<string, { text: string; tone: "ok" | "warn" | "bad" | "neutral" }> = {
  absent: { text: "未下载", tone: "neutral" },
  downloading: { text: "下载中", tone: "warn" },
  verifying: { text: "校验中", tone: "warn" },
  extracting: { text: "解压中", tone: "warn" },
  admitted: { text: "已下载", tone: "ok" },
  hash_mismatch: { text: "哈希不符，已拒用", tone: "bad" },
  error: { text: "出错", tone: "bad" },
};

/** 只在出错时出现，所以写得具体一点：说清是什么、下一步做什么。 */
const ERROR_HINT: Record<string, string> = {
  KERNEL_HASH_MISMATCH: "文件哈希与清单不符，已拒绝使用。请重新下载；若反复出现，请联系我们。",
  KERNEL_CHANNEL_BLOCKED: "该版本处于预览通道，请先在安全中心确认同意。",
  KERNEL_UNTRUSTED_SOURCE: "清单中不存在该版本，或文件已失效。",
  KERNEL_WITHDRAWN: "该版本已下架，无法继续下载。",
  HOST_UNAVAILABLE: "无法连接本机服务，请重启工作台。",
};

function KernelsPage() {
  const [view, setView] = useState<KernelView | null>(null);
  const [removing, setRemoving] = useState<{ version: string; error?: string } | null>(null);
  const environments = useEnclave((s) => s.environments);

  const load = useCallback(async () => {
    setView(await getKernelView());
  }, []);

  useEffect(() => {
    void load();
    const id = window.setInterval(() => void load(), 1500);
    return () => window.clearInterval(id);
  }, [load]);

  if (view && !view.online) {
    return (
      <div className="mx-auto max-w-[1280px] px-4 py-5 sm:px-8 sm:py-6 *:max-w-3xl">
        <PageHeader title={t("kernelsTitle")} />
        <Panel className="p-6">
          <Badge tone="bad">无法连接本机服务</Badge>
          <p className="mt-3 text-[13px] text-muted">重启工作台再试。</p>
        </Panel>
      </div>
    );
  }

  const kernels = view?.kernels ?? [];
  const downloaded = kernels.filter((k) => k.status.state === "admitted").length;
  const boundTo = (version: string) =>
    environments.filter((e) => !e.deletedAt && e.kernelVersion === version).length;
  const caps = view?.capabilities;

  const remove = async (version: string) => {
    const res = await removeKernel(version);
    if (!res.ok) {
      setRemoving({ version, error: res.message ?? "删除失败。" });
      return;
    }
    useEnclave.getState().addAudit({ action: "kernel_remove", level: "warn", detail: version });
    setRemoving(null);
    await load();
  };

  return (
    <div className="mx-auto max-w-[1280px] px-4 py-5 sm:px-8 sm:py-6 *:max-w-3xl">
      <PageHeader
        title={t("kernelsTitle")}
        status={`${kernels.length} 个版本，${downloaded} 个已下载`}
      />

      {/* 内核分两类，每一类有自己的一串版本。 */}
      <div className="grid gap-8">
        {ENGINE_CLASSES.map((engine) => {
          const ofClass = kernels.filter((k) => k.record.engine === engine);
          const meta = ENGINE_META[engine];
          return (
            <section key={engine} className="grid gap-3">
              <div>
                <h2 className="text-lg font-bold tracking-tight text-ink">
                  {meta.label}
                  <span className="ml-2 text-[13px] font-normal text-subtle">{meta.build}</span>
                </h2>
                <p className="mt-1 text-[13px] leading-relaxed text-muted">{meta.summary}</p>
              </div>
              {ofClass.length === 0 ? (
                <p className="text-[13px] text-subtle">这个系统上还没有这一类的版本。</p>
              ) : null}
              {ofClass.map((kernel) => (
                <KernelCard
                  key={kernel.record.version}
                  kernel={kernel}
                  isDefault={kernel.record.version === view?.defaultVersions[engine]}
                  // 一屏一个主操作：还没有任何版本可用时，是 Chromium 类默认版本的下载按钮。
                  primary={
                    downloaded === 0 &&
                    engine === "chromium" &&
                    kernel.record.version === view?.defaultVersions.chromium
                  }
                  bound={boundTo(kernel.record.version)}
                  onChanged={load}
                  onRemove={() => setRemoving({ version: kernel.record.version })}
                />
              ))}
            </section>
          );
        })}
      </div>

      <Panel className="mt-4 p-5">
        <dl className="grid gap-2 text-[13px]">
          <Line k="窗口" v={caps?.headlessForced ? "无头模式（无显示器）" : "可见窗口"} />
          <Line k="沙箱" v={caps?.sandboxLikely === false ? "本机可能无法启用" : "默认开启"} />
          {ENGINE_CLASSES.map((engine) => (
            <Line
              key={engine}
              k={`${ENGINE_META[engine].label}许可证`}
              v={ENGINE_META[engine].license}
            />
          ))}
        </dl>
      </Panel>

      {removing ? (
        <Dialog open onOpenChange={(o) => !o && setRemoving(null)}>
          <DialogContent title={`删除内核 ${removing.version}？`}>
            <p className="text-[13px] leading-relaxed text-muted">
              {boundTo(removing.version) > 0 ? (
                <>
                  有 {boundTo(removing.version)} 个环境绑定这个版本，删除后它们
                  <span className="text-bad">启动不了</span>，除非重新下载，或在环境里换一个版本。
                </>
              ) : (
                "将删除该版本的压缩包与解压文件，之后仍可重新下载。"
              )}
            </p>
            {removing.error ? <p className="mt-3 text-[13px] text-bad">{removing.error}</p> : null}
            <div className="mt-6 flex justify-end gap-2">
              <Button onClick={() => setRemoving(null)}>{t("cancel")}</Button>
              <Button variant="danger" onClick={() => void remove(removing.version)}>
                {t("delete")}
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      ) : null}
    </div>
  );
}

function KernelCard({
  kernel,
  isDefault,
  primary,
  bound,
  onChanged,
  onRemove,
}: {
  kernel: KernelEntry;
  isDefault: boolean;
  primary: boolean;
  bound: number;
  onChanged: () => Promise<void>;
  onRemove: () => void;
}) {
  const allowPreview = useEnclave((s) => s.settings.allowPreviewKernel);
  const [busy, setBusy] = useState(false);
  const [blocked, setBlocked] = useState<string | null>(null);

  const { record, status } = kernel;
  const state = status.state;
  const label = STATE_LABEL[state] ?? STATE_LABEL.error;
  const preview = record.channel !== "stable";
  const working = state === "downloading" || state === "verifying" || state === "extracting";
  const needsConsent = preview && !allowPreview;
  const pct = status.bytesExpected
    ? Math.min(100, Math.round((status.bytesReceived / status.bytesExpected) * 100))
    : 0;

  const admit = async () => {
    setBusy(true);
    setBlocked(null);
    const res = await admitKernel(record.version, allowPreview);
    if (res.code) setBlocked(ERROR_HINT[res.code] ?? res.message ?? res.code);
    useEnclave.getState().addAudit({
      action: "kernel_admit",
      level: res.code ? "warn" : "info",
      detail: res.code ? `${record.version}，${res.code}` : record.version,
    });
    await onChanged();
    setBusy(false);
  };

  return (
    <Panel>
      <PanelHeader
        title={record.version}
        hint={[
          kernel.withdrawn ? "已下架，删除后无法重新下载" : null,
          preview ? "预览通道" : "稳定通道",
          isDefault ? "新建环境的默认版本" : null,
          bound ? `${bound} 个环境在用` : null,
        ]
          .filter(Boolean)
          .join("，")}
        actions={<Badge tone={label.tone}>{label.text}</Badge>}
      />
      <div className="grid gap-4 p-5">
        {working ? (
          <div>
            <div className="h-1 overflow-hidden rounded-full bg-surface-2">
              <div className="h-full bg-accent transition-[width]" style={{ width: `${pct}%` }} />
            </div>
            <div className="app-mono mt-2 text-xs text-subtle">
              {label.text} {pct}%
            </div>
          </div>
        ) : null}

        <CodeBlock label="清单哈希 SHA256" value={record.sha256} />

        {status.exeSha256 ? (
          <CodeBlock label="本机可执行文件 SHA256" value={status.exeSha256} />
        ) : null}

        {status.executable && state === "admitted" ? (
          <div className="text-[13px] text-subtle">
            安装位置 <span className="app-mono break-all text-muted">{status.executable}</span>
          </div>
        ) : null}

        {state === "hash_mismatch" || status.error ? (
          <p className="text-[13px] leading-relaxed text-bad">
            {ERROR_HINT[status.error ?? ""] ?? status.error ?? ERROR_HINT.KERNEL_HASH_MISMATCH}
          </p>
        ) : null}

        {blocked ? <p className="text-[13px] leading-relaxed text-warn">{blocked}</p> : null}

        {needsConsent && state !== "admitted" ? (
          <div className="rounded-md border border-warn/30 bg-warn/10 px-4 py-3 text-[13px] text-warn">
            这个版本还在预览通道。到
            <Link to="/security" className="mx-1 font-semibold underline">
              安全中心
            </Link>
            明确同意后才能下载。
          </div>
        ) : null}

        <div className="flex gap-2">
          {state === "admitted" ? (
            <Button variant="danger" onClick={onRemove}>
              {t("delete")}
            </Button>
          ) : (
            <Button
              variant={primary ? "primary" : "secondary"}
              size={primary ? "md" : "sm"}
              disabled={busy || working || needsConsent}
              title={
                needsConsent
                  ? "请先在安全中心同意使用预览通道内核"
                  : working
                    ? "正在进行，请稍候"
                    : undefined
              }
              onClick={() => void admit()}
            >
              {state === "absent" ? t("download") : "重新下载"}
            </Button>
          )}
        </div>
      </div>
    </Panel>
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
