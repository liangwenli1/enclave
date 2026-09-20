import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { Badge, Button, Panel } from "@/components/ui";
import { collectEnvCdp } from "@/lib/host";
import { t } from "@/lib/i18n";
import { collectPageFingerprint, diffSnaps, snapshotChecks, staticConsistency } from "@/lib/lab";
import { useEnclave } from "@/lib/store";

type LabSearch = { env?: string };

export const Route = createFileRoute("/lab")({
  validateSearch: (search: Record<string, unknown>): LabSearch => ({
    env: typeof search.env === "string" ? search.env : undefined,
  }),
  component: LabPage,
});

function LabPage() {
  const { env: envFromSearch } = Route.useSearch();
  const allEnvironments = useEnclave((s) => s.environments);
  const environments = useMemo(
    () => allEnvironments.filter((e) => !e.deletedAt),
    [allEnvironments],
  );
  const proxies = useEnclave((s) => s.proxies);
  const runtimes = useEnclave((s) => s.runtimes);
  const lab = useEnclave((s) => s.lab);
  const [envId, setEnvId] = useState(envFromSearch ?? environments[0]?.id ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const env = environments.find((e) => e.id === envId);
  const proxy = proxies.find((p) => p.id === env?.proxyId);
  const staticChecks = env ? staticConsistency(env, proxy) : [];
  const envSnap = envId ? lab.lastByEnv[envId] : undefined;
  const liveChecks = env && envSnap ? snapshotChecks(env.profile, envSnap) : [];
  const rows = diffSnaps(lab.control, envSnap);

  return (
    <div className="mx-auto max-w-[1280px] px-8 py-6">
      <h1 className="text-[32px] leading-tight font-bold tracking-tight text-ink">
        {t("labTitle")}
      </h1>
      <p className="mt-2 text-[13px] text-subtle">对照是工作台这一页，另一边是真正的内核窗口。</p>
      <div className="mt-5 flex flex-wrap items-center gap-2">
        <select
          className="h-8 rounded-md border border-line-strong bg-surface px-2.5 text-[13px] text-ink"
          value={envId}
          onChange={(e) => setEnvId(e.target.value)}
        >
          <option value="">{t("env")}</option>
          {environments.map((e) => (
            <option key={e.id} value={e.id}>
              {e.name}
            </option>
          ))}
        </select>
        <Button
          onClick={async () => {
            setBusy(true);
            setError("");
            try {
              const snap = await collectPageFingerprint("page");
              useEnclave.getState().setControlSnap(snap);
            } catch (err) {
              setError(`采集对照失败：${err instanceof Error ? err.message : String(err)}`);
            } finally {
              setBusy(false);
            }
          }}
        >
          {t("collectPage")}
        </Button>
        <Button
          variant="primary"
          title={
            !env
              ? "先选一个环境"
              : runtimes[envId]?.status !== "running"
                ? "这个环境还没运行，先在环境页启动它"
                : undefined
          }
          disabled={!env || runtimes[envId]?.status !== "running" || busy}
          onClick={async () => {
            if (!env) return;
            setBusy(true);
            setError("");
            try {
              await collectEnvCdp(env.id);
            } catch (err) {
              setError(`采集内核窗口失败：${err instanceof Error ? err.message : String(err)}`);
            } finally {
              setBusy(false);
            }
          }}
        >
          {t("collectCdp")}
        </Button>
      </div>

      {error ? <p className="mt-3 text-[13px] text-bad">{error}</p> : null}

      <div className="mt-4 grid gap-3 lg:grid-cols-2">
        <Panel className="p-4">
          <div className="mb-2 text-[13px] font-medium">{t("control")}</div>
          {lab.control ? (
            <Meta snap={lab.control} />
          ) : (
            <p className="text-[13px] text-subtle">{t("notRun")}</p>
          )}
        </Panel>
        <Panel className="p-4">
          <div className="mb-2 text-[13px] font-medium">{t("kernelWindow")}</div>
          {envSnap ? (
            <Meta snap={envSnap} />
          ) : (
            <p className="text-[13px] text-subtle">
              {runtimes[envId]?.status === "running" ? t("notRun") : t("runtimeEmpty")}
            </p>
          )}
        </Panel>
      </div>

      <Panel className="mt-3 p-4">
        <div className="mb-2 text-[13px] font-medium">{t("consistency")}</div>
        <ul className="grid gap-1 text-[13px]">
          {staticChecks.map((c) => (
            <li key={c.id} className="flex justify-between gap-3">
              <span>{c.label}</span>
              <span className={c.ok ? "text-ok" : c.warn ? "text-warn" : "text-bad"}>{c.detail}</span>
            </li>
          ))}
          {liveChecks.map((c) => (
            <li key={`live-${c.id}`} className="flex justify-between gap-3">
              <span>{c.label}</span>
              <span className={c.ok ? "text-ok" : c.warn ? "text-warn" : "text-bad"}>{c.detail}</span>
            </li>
          ))}
        </ul>
      </Panel>

      <Panel className="mt-3 overflow-x-auto p-4">
        <div className="mb-2 text-[13px] font-medium">{t("diff")}</div>
        {rows.length === 0 ? (
          <p className="text-[13px] text-subtle">{t("notRun")}</p>
        ) : (
          <table className="w-full min-w-[640px] text-left text-[13px]">
            <thead className="text-subtle">
              <tr>
                <th className="py-1">项目</th>
                <th>{t("control")}</th>
                <th>{t("env")}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.field} className="border-t border-line">
                  <td className="py-1 font-mono">{r.field}</td>
                  <td className="max-w-[280px] truncate pr-3">{r.a}</td>
                  <td className="max-w-[280px] truncate">
                    {r.b} {r.same ? <Badge tone="ok">一致</Badge> : <Badge tone="warn">不同</Badge>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>
    </div>
  );
}

function Meta({ snap }: { snap: { userAgent: string; timezone: string; canvasHash: string; webdriver: boolean | null; webglRenderer: string } }) {
  return (
    <dl className="grid gap-1 text-[13px]">
      <div className="truncate text-muted">{snap.userAgent}</div>
      <div className="flex justify-between">
        <span className="text-subtle">时区</span>
        <span>{snap.timezone}</span>
      </div>
      <div className="flex justify-between">
        <span className="text-subtle">Canvas</span>
        <span className="font-mono">{snap.canvasHash.slice(0, 12)}</span>
      </div>
      <div className="flex justify-between">
        <span className="text-subtle">webdriver 标记</span>
        <span>{snap.webdriver === true ? "暴露了" : "未暴露"}</span>
      </div>
      <div className="truncate text-subtle">{snap.webglRenderer}</div>
    </dl>
  );
}
