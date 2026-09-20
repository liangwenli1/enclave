import { useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Badge, Button, Panel } from "@/components/ui";
import { admitKernel, getKernelView } from "@/lib/kernel/host-api";
import { t, type Locale } from "@/lib/i18n";
import { KERNEL_PIN, newEnvironment, profileFromSeed, randomSeed } from "@/lib/schema";
import { useEnclave } from "@/lib/store";

/**
 * 首次引导。三步，每一步都是用户真的要做的事：
 * 知道内核在哪跑 → 准入内核 → 建第一个环境。
 * 这里不选档位 —— 档位只能来自厂商签发的许可证。
 */
export function Onboarding() {
  const locale = useEnclave((s) => s.settings.locale) as Locale;
  const allowPreview = useEnclave((s) => s.settings.allowPreviewKernel);
  const onboarded = useEnclave((s) => s.settings.onboarded);
  const navigate = useNavigate();
  const [step, setStep] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [admitted, setAdmitted] = useState(false);
  // 这个平台的内核是不是还在预览通道。是的话要先拿到同意，否则准入必然被 Host 拒绝，
  // 而引导是全屏遮罩，用户到不了安全中心 —— 同意项必须就放在这一步里。
  const [previewChannel, setPreviewChannel] = useState(false);

  useEffect(() => {
    if (onboarded) return;
    void getKernelView().then((view) => {
      setPreviewChannel(Boolean(view.kernel && view.kernel.manifest.channel !== "stable"));
      if (view.status.state === "admitted") setAdmitted(true);
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
    const res = (await admitKernel(allowPreview)) as { code?: string; message?: string };
    if (res?.code) {
      // 被拒或连不上：直接说原因，不进下面的轮询（否则按钮会转十分钟）。
      setError(res.message ?? res.code);
      setBusy(false);
      return;
    }
    // 下载是后台进行的，这里轮询到准入或出错为止。
    for (let i = 0; i < 600; i += 1) {
      const view = await getKernelView();
      if (view.status.state === "admitted") {
        setAdmitted(true);
        break;
      }
      if (view.status.state === "hash_mismatch" || view.status.state === "error") {
        setError(view.status.error ?? "内核准入失败，去内核页看看详情。");
        break;
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
    setBusy(false);
  };

  return (
    <div className="fixed inset-0 z-40 grid place-items-center bg-canvas p-4">
      <Panel className="w-full max-w-lg p-6">
        <div className="text-xs font-semibold tracking-[1.5px] text-subtle uppercase">
          {t(locale, "onboard")} · {step + 1}/3
        </div>
        <h2 className="mt-2 text-2xl font-bold tracking-tight text-ink">
          {t(locale, "onboardTitle")}
        </h2>

        {step === 0 ? (
          <div className="mt-5 grid gap-3 text-[13px] leading-relaxed text-muted">
            <p>
              Enclave 在<span className="text-ink">你这台电脑上</span>启动独立的浏览器内核。
              每个环境有自己的 Cookie、指纹和出口，互不串数据。
            </p>
            <p>
              内核不在安装包里：下一步会按清单下载并校验哈希，大约 190 MB，只下一次。
              之后每次启动环境，都会重新核对磁盘上那个要执行的文件。
            </p>
          </div>
        ) : null}

        {step === 1 ? (
          <div className="mt-5 grid gap-4">
            <p className="text-[13px] leading-relaxed text-muted">{t(locale, "kernelNeed")}</p>
            {admitted ? <Badge tone="ok">已准入</Badge> : null}
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
                  这个平台的内核还在预览通道：哈希已核对，但还没做过完整行为测试。我同意使用。
                </span>
              </label>
            ) : null}
            {error ? <p className="text-[13px] text-bad">{error}</p> : null}
            <div>
              <Button
                variant="primary"
                disabled={busy || admitted || needsConsent}
                title={needsConsent ? "先勾选上面的同意项" : undefined}
                onClick={() => void admit()}
              >
                {busy ? "下载并校验中…" : admitted ? "已完成" : t(locale, "download")}
              </Button>
            </div>
          </div>
        ) : null}

        {step === 2 ? (
          <div className="mt-5 grid gap-4">
            <p className="text-[13px] leading-relaxed text-muted">{t(locale, "onboardSample")}</p>
            <div className="flex flex-wrap gap-2">
              <Button
                variant="primary"
                onClick={() => {
                  const store = useEnclave.getState();
                  if (store.environments.filter((e) => !e.deletedAt).length === 0) {
                    const env = newEnvironment({
                      name: locale === "zh" ? "第一个环境" : "First environment",
                      group: "default",
                      profile: profileFromSeed(randomSeed(), "windows"),
                      kernelPin: KERNEL_PIN,
                    });
                    store.upsertEnv(env);
                    store.addAudit({
                      action: "create_env",
                      target: env.id,
                      level: "info",
                      detail: "引导创建",
                    });
                  }
                  finish();
                  void navigate({ to: "/" });
                }}
              >
                建一个环境
              </Button>
            </div>
          </div>
        ) : null}

        <div className="mt-6 flex justify-between">
          <Button onClick={finish}>{t(locale, "onboardSkip")}</Button>
          {step < 2 ? (
            <Button
              variant={step === 1 && !admitted ? "secondary" : "primary"}
              onClick={() => setStep((s) => s + 1)}
            >
              {t(locale, "next")}
            </Button>
          ) : null}
        </div>
      </Panel>
    </div>
  );
}
