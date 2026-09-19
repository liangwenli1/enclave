import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Badge, Button, Panel } from "@/components/ui";
import { useLocale } from "@/components/shell";
import { getKernelStatusFn } from "@/lib/kernel/functions";
import { t } from "@/lib/i18n";
import { useEnclave } from "@/lib/store";

export const Route = createFileRoute("/security")({ component: SecurityPage });

function SecurityPage() {
  const locale = useLocale();
  const settings = useEnclave((s) => s.settings);
  const audit = useEnclave((s) => s.audit);
  const [kernelState, setKernelState] = useState("…");
  const [caps, setCaps] = useState<string>("");

  useEffect(() => {
    void getKernelStatusFn().then((d) => {
      setKernelState(d.status.state);
      setCaps(
        `${d.capabilities.os} uid=${d.capabilities.uid} sandboxLikely=${d.capabilities.sandboxLikely}`,
      );
    });
  }, []);

  return (
    <div className="mx-auto max-w-3xl p-4 md:p-6">
      <h1 className="text-[20px] font-semibold tracking-tight">{t(locale, "securityTitle")}</h1>
      <div className="mt-4 grid gap-3">
        <Panel className="p-4">
          <div className="mb-3 text-[13px] font-medium">{t(locale, "integrity")}</div>
          <ul className="grid gap-2 text-[13px]">
            <li className="flex justify-between">
              <span className="text-subtle">kernel</span>
              <Badge tone={kernelState === "admitted" ? "ok" : "warn"}>{kernelState}</Badge>
            </li>
            <li className="flex justify-between">
              <span className="text-subtle">{t(locale, "signatureMissing")}</span>
              <Badge tone="warn">{t(locale, "signatureMissing")}</Badge>
            </li>
            <li className="flex justify-between">
              <span className="text-subtle">API</span>
              <Badge tone={settings.apiEnabled ? "warn" : "ok"}>
                {settings.apiEnabled ? t(locale, "apiOn") : t(locale, "apiOff")}
              </Badge>
            </li>
            <li className="flex justify-between">
              <span className="text-subtle">{t(locale, "masterPw")}</span>
              <span className="text-muted">
                {settings.masterPasswordSet ? t(locale, "pass") : t(locale, "masterPwHint")}
              </span>
            </li>
          </ul>
          <p className="mt-3 font-mono text-[11px] text-subtle">{caps}</p>
        </Panel>

        <Panel className="p-4">
          <div className="text-[13px] font-medium">{t(locale, "sandboxWarn")}</div>
          <label className="mt-3 flex items-start gap-2 text-[13px]">
            <input
              type="checkbox"
              className="mt-1"
              checked={settings.allowNoSandboxHost}
              onChange={(e) => {
                useEnclave.getState().patchSettings({ allowNoSandboxHost: e.target.checked });
                useEnclave.getState().addAudit({
                  action: "host_sandbox_ack",
                  level: "warn",
                  detail: e.target.checked ? "allow --no-sandbox on host" : "revoked",
                });
              }}
            />
            <span className="text-warn">{t(locale, "sandboxAck")}</span>
          </label>
        </Panel>

        <Panel className="p-4">
          <div className="mb-2 text-[13px] font-medium">{t(locale, "diagnostic")}</div>
          <p className="text-[12px] text-subtle">{t(locale, "diagnosticHint")}</p>
          <Button
            className="mt-3"
            onClick={() => {
              const blob = new Blob(
                [
                  JSON.stringify(
                    {
                      redacted: true,
                      classes: ["host capabilities", "kernel status (no cookies)", "audit (secrets masked)"],
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
            {t(locale, "diagnostic")}
          </Button>
        </Panel>

        <Panel className="p-4">
          <div className="mb-2 text-[13px] font-medium">{t(locale, "audit")}</div>
          <ol className="grid max-h-80 gap-2 overflow-auto">
            {audit.length === 0 ? (
              <li className="text-[12px] text-subtle">{t(locale, "none")}</li>
            ) : (
              audit.map((ev) => (
                <li key={ev.id} className="border-b border-line pb-2 text-[12px]">
                  <div className="flex justify-between gap-2">
                    <span className="font-medium">{ev.action}</span>
                    <span className="text-subtle tabular-nums">{new Date(ev.at).toLocaleString()}</span>
                  </div>
                  <div className={ev.level === "bad" ? "text-bad" : ev.level === "warn" ? "text-warn" : "text-muted"}>
                    {ev.detail}
                  </div>
                </li>
              ))
            )}
          </ol>
        </Panel>

        <Panel className="p-4 text-[12px] text-subtle">
          <div>{t(locale, "noTelemetry")}</div>
          <div className="mt-2">{t(locale, "delaySource")}</div>
          <div className="mt-2">{t(locale, "disclose")}</div>
          <div className="mt-2">{t(locale, "license")}</div>
        </Panel>
      </div>
    </div>
  );
}
