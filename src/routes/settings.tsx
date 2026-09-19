import { createFileRoute } from "@tanstack/react-router";
import { Button, Panel } from "@/components/ui";
import { useLocale } from "@/components/shell";
import { t } from "@/lib/i18n";
import { useEnclave } from "@/lib/store";

export const Route = createFileRoute("/settings")({ component: SettingsPage });

function SettingsPage() {
  const locale = useLocale();
  const settings = useEnclave((s) => s.settings);
  const patch = useEnclave((s) => s.patchSettings);

  return (
    <div className="mx-auto max-w-xl p-4 md:p-6">
      <h1 className="text-[20px] font-semibold tracking-tight">{t(locale, "settingsTitle")}</h1>
      <div className="mt-4 grid gap-3">
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
          <div className="mb-2 text-[13px] font-medium">API</div>
          <p className="text-[12px] text-subtle">{settings.apiEnabled ? t(locale, "apiOn") : t(locale, "apiOff")}</p>
          <label className="mt-3 flex items-center gap-2 text-[13px]">
            <input
              type="checkbox"
              checked={settings.apiEnabled}
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
