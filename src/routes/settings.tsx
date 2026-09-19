import { createFileRoute, Link } from "@tanstack/react-router";
import { Button, Panel } from "@/components/ui";
import { useLocale } from "@/components/shell";
import { t } from "@/lib/i18n";
import { PLANS } from "@/lib/license";
import { useEnclave } from "@/lib/store";

export const Route = createFileRoute("/settings")({ component: SettingsPage });

function SettingsPage() {
  const locale = useLocale();
  const settings = useEnclave((s) => s.settings);
  const patch = useEnclave((s) => s.patchSettings);
  const plan = PLANS[settings.plan];

  return (
    <div className="mx-auto max-w-xl p-4 md:p-6">
      <h1 className="text-xl font-semibold tracking-tight">{t(locale, "settingsTitle")}</h1>
      <div className="mt-4 grid gap-3">
        <Panel className="p-4">
          <div className="mb-2 text-sm font-medium">{t(locale, "accountTitle")}</div>
          <p className="text-sm text-subtle">{t(locale, "accountBody")}</p>
          <p className="mt-3 text-sm">
            {t(locale, "accountLocal")} · {plan.label} · {plan.envLimit}
          </p>
          <Link to="/www/account" className="mt-3 inline-flex">
            <Button variant="primary">{t(locale, "openAccount")}</Button>
          </Link>
        </Panel>
        <Panel className="p-4">
          <div className="mb-3 text-sm font-medium">{t(locale, "language")}</div>
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
          <div className="mb-3 text-sm font-medium">{t(locale, "theme")}</div>
          <div className="flex gap-2">
            <Button variant={settings.theme === "dark" ? "primary" : "secondary"} onClick={() => patch({ theme: "dark" })}>
              {t(locale, "dark")}
            </Button>
            <Button variant={settings.theme === "light" ? "primary" : "secondary"} onClick={() => patch({ theme: "light" })}>
              {t(locale, "light")}
            </Button>
          </div>
        </Panel>
      </div>
    </div>
  );
}
