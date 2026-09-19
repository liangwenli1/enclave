import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Badge, Button, Panel } from "@/components/ui";
import { useLocale } from "@/components/shell";
import { getKernelStatusFn, startKernelDownloadFn } from "@/lib/kernel/functions";
import { t } from "@/lib/i18n";
import { KERNEL_PIN } from "@/lib/schema";
import { useEnclave } from "@/lib/store";

export const Route = createFileRoute("/kernels")({ component: KernelsPage });

function KernelsPage() {
  const locale = useLocale();
  const [data, setData] = useState<Awaited<ReturnType<typeof getKernelStatusFn>> | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const refresh = async () => {
    try {
      setData(await getKernelStatusFn());
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };

  useEffect(() => {
    void refresh();
    const id = window.setInterval(() => void refresh(), 1500);
    return () => window.clearInterval(id);
  }, []);

  const status = data?.status;
  const kernel = data?.kernel.manifest;
  const pct =
    status && status.bytesExpected
      ? Math.min(100, Math.round((status.bytesReceived / status.bytesExpected) * 100))
      : 0;

  return (
    <div className="mx-auto max-w-3xl p-4 md:p-6">
      <h1 className="text-[20px] font-semibold tracking-tight">{t(locale, "kernelsTitle")}</h1>
      <p className="mt-1 text-[13px] text-subtle">{t(locale, "delaySource")}</p>

      <Panel className="mt-4 p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="text-[15px] font-medium">
              {kernel?.id ?? KERNEL_PIN.id} {kernel?.version ?? KERNEL_PIN.version}
            </div>
            <div className="mt-1 text-[12px] text-subtle">{kernel?.url}</div>
          </div>
          <Badge
            tone={
              status?.state === "admitted" ? "ok" : status?.state === "hash_mismatch" ? "bad" : "warn"
            }
          >
            {status?.state ?? "…"}
          </Badge>
        </div>
        <dl className="mt-4 grid gap-2 text-[12px]">
          <Row k={t(locale, "hash")} v={kernel?.sha256 ?? KERNEL_PIN.sha256} />
          <Row k="bytes" v={String(kernel?.bytes ?? "")} />
          <Row
            k={t(locale, "signatureMissing")}
            v={kernel?.signature === "missing" ? t(locale, "signatureMissing") : kernel?.signature ?? ""}
          />
          <Row k="publisher" v={kernel?.publisher ?? "adryfish"} />
          {status?.sha256Actual ? <Row k="actual" v={status.sha256Actual} /> : null}
          {status?.executable ? <Row k="exe" v={status.executable} /> : null}
        </dl>
        {status?.state === "downloading" || status?.state === "verifying" || status?.state === "extracting" ? (
          <div className="mt-4">
            <div className="h-1 overflow-hidden rounded-full bg-surface-3">
              <div className="h-full bg-accent" style={{ width: `${pct}%` }} />
            </div>
            <div className="mt-1 text-[11px] text-subtle tabular-nums">
              {status.state} {pct}%
            </div>
          </div>
        ) : null}
        {status?.error ? <div className="mt-3 text-[12px] text-bad">{status.error}</div> : null}
        {err ? <div className="mt-3 text-[12px] text-bad">{err}</div> : null}
        <div className="mt-5 flex flex-wrap gap-2">
          <Button
            variant="primary"
            disabled={status?.state === "downloading" || status?.state === "admitted"}
            onClick={async () => {
              await startKernelDownloadFn();
              useEnclave.getState().addAudit({
                action: "kernel_download",
                level: "info",
                detail: KERNEL_PIN.version,
              });
              await refresh();
            }}
          >
            {status?.state === "admitted" ? t(locale, "admitted") : t(locale, "download")}
          </Button>
          <Button disabled>{t(locale, "noRollback")}</Button>
        </div>
      </Panel>

      <Panel className="mt-3 p-4 text-[12px] text-subtle">
        <div>{t(locale, "license")}</div>
        <div className="mt-2">{t(locale, "hostHeadless")}</div>
        {data?.capabilities ? (
          <div className="mt-2 font-mono">
            host {data.capabilities.os}/{data.capabilities.arch} uid={String(data.capabilities.uid)} display=
            {String(data.capabilities.display)} sandboxLikely={String(data.capabilities.sandboxLikely)}
          </div>
        ) : null}
      </Panel>
    </div>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex justify-between gap-4">
      <dt className="shrink-0 text-subtle">{k}</dt>
      <dd className="break-all font-mono text-ink">{v}</dd>
    </div>
  );
}
