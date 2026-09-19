import { useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { Button, Panel } from "@/components/ui";
import { startKernelDownloadFn, getKernelStatusFn } from "@/lib/kernel/functions";
import { t } from "@/lib/i18n";
import { PLANS, type PlanId } from "@/lib/license";
import { KERNEL_PIN, newEnvironment, profileFromSeed, randomSeed } from "@/lib/schema";
import { useEnclave } from "@/lib/store";
import type { Locale } from "@/lib/i18n";

export function Onboarding() {
  const locale = useEnclave((s) => s.settings.locale) as Locale;
  const navigate = useNavigate();
  const settings = useEnclave((s) => s.settings);
  const [step, setStep] = useState(0);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [kernelState, setKernelState] = useState("…");

  if (settings.onboarded) return null;

  const finish = () => {
    useEnclave.getState().patchSettings({ onboarded: true });
    void navigate({ to: "/lab" });
  };

  return (
    <div className="fixed inset-0 z-40 grid place-items-center bg-canvas/90 p-4">
      <Panel className="w-full max-w-lg p-5">
        <div className="text-[11px] uppercase tracking-wide text-subtle">
          {t(locale, "onboard")} · {step + 1}/3
        </div>
        <h2 className="mt-1 text-[18px] font-semibold tracking-tight">{t(locale, "onboardTitle")}</h2>
        {step === 0 ? (
          <div className="mt-4 grid gap-2">
            <p className="text-[13px] text-subtle">{t(locale, "onboardPlanHint")}</p>
            {(Object.keys(PLANS) as PlanId[]).map((id) => {
              const p = PLANS[id];
              const active = settings.plan === id;
              return (
                <button
                  key={id}
                  onClick={() => useEnclave.getState().patchSettings({ plan: id })}
                  className={`rounded-lg border px-3 py-2 text-left ${active ? "border-accent bg-surface-2" : "border-line"}`}
                >
                  <div className="text-[13px] font-medium">{p.label}</div>
                  <div className="text-[11px] text-subtle">
                    {p.envLimit} env · {p.concurrent} concurrent · API {p.api}
                  </div>
                </button>
              );
            })}
          </div>
        ) : null}
        {step === 1 ? (
          <div className="mt-4 grid gap-3">
            <p className="text-[13px] text-subtle">{t(locale, "kernelNeed")}</p>
            <div className="font-mono text-[12px] text-muted">{kernelState}</div>
            {err ? <div className="text-[12px] text-bad">{err}</div> : null}
            <Button
              variant="primary"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                setErr(null);
                try {
                  await startKernelDownloadFn();
                  const d = await getKernelStatusFn();
                  setKernelState(d.status.state);
                  if (d.status.state !== "admitted" && d.status.state !== "downloading") {
                    setErr(d.status.error ?? d.status.state);
                  }
                } catch (e) {
                  setErr(e instanceof Error ? e.message : String(e));
                } finally {
                  setBusy(false);
                }
              }}
            >
              {t(locale, "download")}
            </Button>
          </div>
        ) : null}
        {step === 2 ? (
          <div className="mt-4 grid gap-3">
            <p className="text-[13px] text-subtle">{t(locale, "onboardSample")}</p>
            <Button
              variant="primary"
              onClick={() => {
                const store = useEnclave.getState();
                if (store.environments.filter((e) => !e.deletedAt).length === 0) {
                  const env = newEnvironment({
                    name: locale === "zh" ? "样例 · 结账" : "Sample · checkout",
                    group: "sample",
                    profile: profileFromSeed(randomSeed(), "windows"),
                    kernelPin: KERNEL_PIN,
                  });
                  store.upsertEnv(env);
                  store.addAudit({ action: "create_env", target: env.id, level: "info", detail: "onboarding sample" });
                }
                finish();
              }}
            >
              {t(locale, "onboardGoLab")}
            </Button>
          </div>
        ) : null}
        <div className="mt-5 flex justify-between">
          <Button
            onClick={() => {
              useEnclave.getState().patchSettings({ onboarded: true });
            }}
          >
            {t(locale, "onboardSkip")}
          </Button>
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
