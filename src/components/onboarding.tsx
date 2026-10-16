import { useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Badge, Button, Panel } from "@/components/ui";
import { admitKernel, getKernelView, kernelEntry, type KernelStatus } from "@/lib/kernel/host-api";
import { registerEnv } from "@/lib/host";
import { t } from "@/lib/i18n";
import { newEnvironment, profileFromSeed, randomSeed } from "@/lib/schema";
import { thisPlatform } from "@/lib/os";
import { useEnclave } from "@/lib/store";

/**
 * 首次引导。三步，每一步都是用户真的要做的事：
 * 知道内核在哪跑 → 准入内核 → 建第一个环境。
 * 这里不选档位 —— 档位只能来自厂商签发的许可证。
 */
export function Onboarding() {
  const allowPreview = useEnclave((s) => s.settings.allowPreviewKernel);
  const onboarded = useEnclave((s) => s.settings.onboarded);
  const navigate = useNavigate();
  const [step, setStep] = useState(0);
  const [busy, setBusy] = useState(false);
  const [creating, setCreating] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);
  // 轮询结束时还在下载：按钮保持停用，避免再点一次又下一份。
  const [stalled, setStalled] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [admitted, setAdmitted] = useState(false);
  // 这个平台的内核是不是还在预览通道。是的话要先拿到同意，否则准入必然被 Host 拒绝，
  // 而引导是全屏遮罩，用户到不了安全中心 —— 同意项必须就放在这一步里。
  const [previewChannel, setPreviewChannel] = useState(false);
  // 引导里下载的是默认版本；别的版本之后在内核页管理。
  const [version, setVersion] = useState<string | null>(null);

  useEffect(() => {
    if (onboarded) return;
    void getKernelView().then((view) => {
      // 引导走 Chromium 类：包小、稳定通道。另一类在内核页自己选。
      const kernel = kernelEntry(view, view.defaultVersions.chromium);
      setVersion(view.defaultVersions.chromium);
      setPreviewChannel(Boolean(kernel && kernel.record.channel !== "stable"));
      if (kernel?.status.state === "admitted") setAdmitted(true);
    });
  }, [onboarded]);

  if (onboarded) return null;
  const needsConsent = previewChannel && !allowPreview;

  const finish = () => {
    useEnclave.getState().patchSettings({ onboarded: true });
  };

  const admit = async () => {
    setBusy(true);
    setError(null);
    if (!version) {
      setError("无法连接本机服务，请重启工作台。");
      setBusy(false);
      return;
    }
    const res = await admitKernel(version, allowPreview);
    if (res.code) {
      // 被拒或连不上：直接说原因，不进下面的轮询（否则按钮会转十分钟）。
      setError(res.message ?? res.code);
      setBusy(false);
      return;
    }
    // 下载是后台进行的，这里轮询到准入或出错为止，并把进度留在按钮上。
    let settled = false;
    for (let i = 0; i < 600; i += 1) {
      const status = kernelEntry(await getKernelView(), version)?.status;
      setProgress(downloadProgress(status));
      if (status?.state === "admitted") {
        setAdmitted(true);
        settled = true;
        break;
      }
      if (!status || status.state === "hash_mismatch" || status.state === "error") {
        setError(status?.error ?? "内核下载失败，请到内核管理页查看原因。");
        settled = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
    if (!settled) {
      setStalled(true);
      setError("仍在下载，可到内核管理查看。");
    }
    setBusy(false);
  };

  return (
    <div className="fixed inset-0 z-40 grid place-items-center bg-canvas p-4">
      <Panel className="w-full max-w-lg p-6">
        <div className="text-[13px] text-subtle">
          {t("onboard")}，第 {step + 1} 步，共 3 步
        </div>
        <h2 className="mt-2 text-2xl font-bold tracking-tight text-ink">
          {t("onboardTitle")}
        </h2>

        {step === 0 ? (
          <div className="mt-5 grid gap-3 text-[13px] leading-relaxed text-muted">
            <p>
              Enclave 在<span className="text-ink">本机</span>启动独立的浏览器内核。
              每个环境拥有自己的 Cookie、指纹与出口，互不串用数据。
            </p>
            <p>
              浏览器内核不在安装包里。下一步会下载并核对文件是否完整，大约 190 MB，只需一次。
              之后每次启动环境，都会再核对一次本机上的文件。
            </p>
          </div>
        ) : null}

        {step === 1 ? (
          <div className="mt-5 grid gap-4">
            <p className="text-[13px] leading-relaxed text-muted">{t("kernelNeed")}</p>
            {admitted ? <Badge tone="ok">{t("admitted")}</Badge> : null}
            {previewChannel && !admitted ? (
              <label className="flex cursor-pointer items-start gap-2.5 text-[13px]">
                <input
                  type="checkbox"
                  className="mt-0.5 size-4 flex-none accent-[var(--enclave-accent)]"
                  checked={allowPreview}
                  onChange={(e) => {
                    useEnclave.getState().patchSettings({ allowPreviewKernel: e.target.checked });
                    useEnclave.getState().addAudit({
                      action: "preview_kernel_consent",
                      level: "warn",
                      detail: e.target.checked ? "允许预览通道内核" : "已撤销",
                    });
                  }}
                />
                <span className="text-muted">
                  这个平台的内核还在预览通道：文件已经核对过，但还没做过完整测试。我同意使用。
                </span>
              </label>
            ) : null}
            {error ? <p className="text-[13px] text-bad">{error}</p> : null}
            <div>
              <Button
                variant={admitted ? "secondary" : "primary"}
                disabled={busy || admitted || needsConsent || stalled}
                title={needsConsent ? "请先勾选上方的同意项" : undefined}
                onClick={() => void admit()}
              >
                {busy
                  ? progress
                    ? `下载并校验中 ${progress}`
                    : "下载并校验中…"
                  : admitted
                    ? "已完成"
                    : stalled
                      ? "仍在下载"
                      : t("download")}
              </Button>
            </div>
          </div>
        ) : null}

        {step === 2 ? (
          <div className="mt-5 grid gap-4">
            <p className="text-[13px] leading-relaxed text-muted">{t("onboardSample")}</p>
            {error ? <p className="text-[13px] text-bad">{error}</p> : null}
            <div className="flex flex-wrap gap-2">
              <Button
                variant="primary"
                disabled={creating}
                onClick={async () => {
                  if (creating) return;
                  const store = useEnclave.getState();
                  const existing = store.environments.find((e) => !e.deletedAt);
                  // 已经有环境就直接去它的页面，启动按钮在那里。
                  if (existing) {
                    finish();
                    void navigate({ to: "/environments/$id", params: { id: existing.id } });
                    return;
                  }
                  setCreating(true);
                  const env = newEnvironment({
                    name: "第一个环境",
                    folderId: "default",
                    profile: profileFromSeed(randomSeed(), thisPlatform(), {
                      brandVersion: version ?? undefined,
                    }),
                    kernelVersion: version ?? undefined,
                  });
                  // 名额由服务器数。没登记上（满了、连不上）就不建，原因留在这一步让用户看到。
                  const registered = await registerEnv(env);
                  if (!registered.ok) {
                    setError(registered.message);
                    setCreating(false);
                    return;
                  }
                  store.upsertEnv(env);
                  store.addAudit({
                    action: "create_env",
                    target: env.id,
                    level: "info",
                    detail: "引导创建",
                  });
                  finish();
                  void navigate({ to: "/environments/$id", params: { id: env.id } });
                }}
              >
                {creating ? "正在创建…" : "建一个环境"}
              </Button>
            </div>
          </div>
        ) : null}

        <div className="mt-6 flex justify-between">
          <Button onClick={finish}>{t("onboardSkip")}</Button>
          {step < 2 ? (
            <Button
              variant={step === 1 && !admitted ? "secondary" : "primary"}
              onClick={() => setStep((s) => s + 1)}
            >
              {step === 1 && !admitted ? "稍后下载" : t("next")}
            </Button>
          ) : null}
        </div>
      </Panel>
    </div>
  );
}

function downloadProgress(status: KernelStatus | undefined): string | null {
  if (!status) return null;
  if (status.state === "verifying") return "正在校验";
  if (status.state === "extracting") return "正在解压";
  if (status.state !== "downloading" || status.bytesExpected <= 0) return null;
  const pct = Math.min(99, Math.round((status.bytesReceived / status.bytesExpected) * 100));
  return `${pct}%`;
}
