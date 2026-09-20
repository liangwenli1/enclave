import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
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

  if (onboarded) return null;

  const finish = () => {
    useEnclave.getState().patchSettings({ onboarded: true });
  };

  const admit = async () => {
    setBusy(true);
    setError(null);
    const res = (await admitKernel(allowPreview)) as { code?: string; message?: string };
    if (res?.code === "KERNEL_CHANNEL_BLOCKED") {
      setError("这个平台的内核还在预览通道，需要先到安全中心同意使用。");
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
            {error ? <p className="text-[13px] text-bad">{error}</p> : null}
            <div>
              <Button variant="primary" disabled={busy || admitted} onClick={() => void admit()}>
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
            <Button variant="primary" onClick={() => setStep((s) => s + 1)}>
              {t(locale, "next")}
            </Button>
          ) : null}
        </div>
      </Panel>
    </div>
  );
}
