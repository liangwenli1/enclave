import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Button, Panel } from "@/components/ui";
import { useLocale } from "@/components/shell";
import { getHostTokenFn } from "@/lib/kernel/functions";
import { t } from "@/lib/i18n";
import { PLANS, type PlanId } from "@/lib/license";
import { useEnclave } from "@/lib/store";

export const Route = createFileRoute("/settings")({ component: SettingsPage });

function SettingsPage() {
  const locale = useLocale();
  const settings = useEnclave((s) => s.settings);
  const patch = useEnclave((s) => s.patchSettings);
  const [token, setToken] = useState("");

  useEffect(() => {
    if (!settings.apiEnabled) return;
    void getHostTokenFn().then((d) => {
      if (d.ok) setToken(d.token);
    });
  }, [settings.apiEnabled]);

  return (
    <div className="mx-auto max-w-xl p-4 md:p-6">
      <h1 className="text-[20px] font-semibold tracking-tight">{t(locale, "settingsTitle")}</h1>
      <div className="mt-4 grid gap-3">
        <Panel className="p-4">
          <div className="mb-3 text-[13px] font-medium">{t(locale, "plan")}</div>
          <p className="mb-3 text-[12px] text-subtle">{t(locale, "onboardPlanHint")}</p>
          <div className="flex flex-wrap gap-2">
            {(Object.keys(PLANS) as PlanId[]).map((id) => (
              <Button
                key={id}
                variant={settings.plan === id ? "primary" : "secondary"}
                onClick={() => {
                  patch({ plan: id, apiEnabled: PLANS[id].api === "full" ? settings.apiEnabled : false });
                  useEnclave.getState().addAudit({
                    action: "plan_set",
                    level: "info",
                    detail: id,
                  });
                }}
              >
                {PLANS[id].label}
              </Button>
            ))}
          </div>
          <p className="mt-3 font-mono text-[11px] text-subtle">
            {PLANS[settings.plan].envLimit} env · {PLANS[settings.plan].concurrent} concurrent · API{" "}
            {PLANS[settings.plan].api}
          </p>
        </Panel>
        <Panel className="p-4">
          <div className="mb-3 text-[13px] font-medium">{t(locale, "language")}</div>
          <div className="flex gap-2">
            <Button variant={settings.locale === "zh" ? "primary" : "secondary"} onClick={() => patch({ locale: "zh" })}>
              中文
            </Button>
            <Button variant={settings.locale === "en" ? "primary" : "secondary"} onClick={() => patch({ locale: "en" })}>
              English
            </Button>
          </div>
        </Panel>
        <Panel className="p-4">
          <div className="mb-3 text-[13px] font-medium">{t(locale, "theme")}</div>
          <div className="flex gap-2">
            <Button variant={settings.theme === "dark" ? "primary" : "secondary"} onClick={() => patch({ theme: "dark" })}>
              {t(locale, "dark")}
            </Button>
            <Button variant={settings.theme === "light" ? "primary" : "secondary"} onClick={() => patch({ theme: "light" })}>
              {t(locale, "light")}
            </Button>
          </div>
        </Panel>
        <Panel className="p-4">
          <div className="mb-3 text-[13px] font-medium">{t(locale, "density")}</div>
          <div className="flex gap-2">
            <Button
              variant={settings.density === "compact" ? "primary" : "secondary"}
              onClick={() => patch({ density: "compact" })}
            >
              {t(locale, "compact")}
            </Button>
            <Button
              variant={settings.density === "comfortable" ? "primary" : "secondary"}
              onClick={() => patch({ density: "comfortable" })}
            >
              {t(locale, "comfortable")}
            </Button>
          </div>
        </Panel>
        <Panel className="p-4">
          <div className="mb-3 text-[13px] font-medium">{t(locale, "masterPw")}</div>
          <p className="text-[12px] text-subtle">{t(locale, "masterPwHint")}</p>
          <Button
            className="mt-3"
            variant={settings.masterPasswordSet ? "secondary" : "primary"}
            onClick={() => {
              patch({ masterPasswordSet: !settings.masterPasswordSet });
              useEnclave.getState().addAudit({
                action: "master_password",
                level: "info",
                detail: settings.masterPasswordSet ? "cleared" : "set",
              });
            }}
          >
            {settings.masterPasswordSet ? t(locale, "pass") : t(locale, "masterPw")}
          </Button>
        </Panel>
        <Panel className="p-4">
          <div className="mb-2 text-[13px] font-medium">API</div>
          <p className="text-[12px] text-subtle">{settings.apiEnabled ? t(locale, "apiOn") : t(locale, "apiOff")}</p>
          <label className="mt-3 flex items-center gap-2 text-[13px]">
            <input
              type="checkbox"
              checked={settings.apiEnabled}
              disabled={PLANS[settings.plan].api === "off"}
              onChange={(e) => {
                patch({ apiEnabled: e.target.checked });
                useEnclave.getState().addAudit({
                  action: "api_toggle",
                  level: e.target.checked ? "warn" : "info",
                  detail: e.target.checked ? "API enabled loopback+token" : "API disabled",
                });
              }}
            />
            {t(locale, "apiOn")}
          </label>
          {settings.apiEnabled && token ? (
            <pre className="mt-3 overflow-auto rounded-md bg-canvas p-2 font-mono text-[11px]">{token}</pre>
          ) : null}
        </Panel>
        <Panel className="p-4 text-[12px] text-subtle">
          <div className="text-[13px] font-medium text-ink">{t(locale, "about")}</div>
          <p className="mt-2">{t(locale, "tagline")}</p>
          <p className="mt-2">{t(locale, "license")}</p>
          <p className="mt-2">{t(locale, "delaySource")}</p>
        </Panel>
      </div>
    </div>
  );
}
