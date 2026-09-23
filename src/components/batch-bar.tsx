import { useEffect, useState } from "react";
import { Button, Field, Input, Panel, PanelHeader, Select, Badge } from "@/components/ui";
import { t } from "@/lib/i18n";
import { launchSpec } from "@/lib/host";
import { useEnclave } from "@/lib/store";
import {
  cancelBatch,
  listBatchRuns,
  runBatch,
  type BatchItemState,
  type BatchRun,
} from "@/lib/kernel/host-api";
import type { Environment } from "@/lib/schema";

/* 批量执行：选一批环境，一次对它们做同一件事。
   排队的规矩在本机服务那边（同时几个、同一代理隔多久、哪些原因值得再试一次），
   这里只负责发起、显示进度、以及把「为什么还在等」如实说出来。 */

const STATE_LABEL: Record<BatchItemState, string> = {
  waiting: t("batchWaiting"),
  running: t("batchRunning"),
  done: t("batchDone"),
  failed: t("batchFailed"),
  skipped: t("batchSkipped"),
};

const STATE_TONE: Record<BatchItemState, "ok" | "warn" | "bad" | "neutral"> = {
  waiting: "neutral",
  running: "warn",
  done: "ok",
  failed: "bad",
  skipped: "neutral",
};

/** 还在跑的那一批。没有就返回最近结束的那一批，好让用户看到结果。 */
function current(runs: BatchRun[]): BatchRun | null {
  return runs.find((r) => r.finishedAt === null) ?? runs[0] ?? null;
}

export function BatchBar({
  selected,
  environments,
  onClear,
}: {
  selected: string[];
  environments: Environment[];
  onClear: () => void;
}) {
  const [runs, setRuns] = useState<BatchRun[]>([]);
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [openUrl, setOpenUrl] = useState("");
  const workflows = useEnclave((s) => s.workflows);
  const [running, setRunning] = useState(false);
  const [workflowId, setWorkflowId] = useState("");
  const [stopAfter, setStopAfter] = useState(true);
  const [concurrency, setConcurrency] = useState("3");
  const [retries, setRetries] = useState("2");

  const run = current(runs);
  const live = run?.finishedAt === null;

  // 跑着的时候一秒一看，跑完就慢下来——它只是内存里的一点状态，不值得一直问。
  useEffect(() => {
    let alive = true;
    const tick = async () => {
      const list = await listBatchRuns();
      if (alive) setRuns(list);
    };
    void tick();
    const id = window.setInterval(() => void tick(), live ? 1000 : 5000);
    return () => {
      alive = false;
      window.clearInterval(id);
    };
  }, [live]);

  const go = async (action: "start" | "stop" | "workflow") => {
    setError("");
    setBusy(true);
    const picked = environments.filter((e) => selected.includes(e.id));
    const res = await runBatch({
      action,
      items: picked.map((e) => ({
        envId: e.id,
        spec: action === "stop" ? undefined : launchSpec(e),
      })),
      concurrency: Number(concurrency) || 3,
      retries: action === "stop" ? 0 : Number(retries) || 0,
      openUrl: action === "start" && openUrl.trim() ? openUrl.trim() : undefined,
      workflowId: action === "workflow" ? workflowId : undefined,
      stopAfter: action === "workflow" ? stopAfter : undefined,
    });
    setBusy(false);
    if (!res.ok) {
      setError(res.message ?? "未能开始，请稍后再试。");
      return;
    }
    setOpening(false);
    setRunning(false);
    onClear();
    setRuns(await listBatchRuns());
  };

  const nameOf = (id: string) => environments.find((e) => e.id === id)?.name ?? id;

  return (
    <div className="mb-4 grid gap-4">
      {selected.length > 0 ? (
        <Panel>
          <div className="flex flex-wrap items-center gap-3 p-4">
            <span className="text-sm font-semibold text-ink">
              已选 {selected.length} 个环境
            </span>
            <div className="flex flex-wrap gap-2">
              <Button variant="primary" onClick={() => { setOpening((v) => !v); setRunning(false); }}>
                {t("batchStart")}
              </Button>
              <Button disabled={busy} onClick={() => void go("stop")}>
                {t("batchStop")}
              </Button>
              <Button onClick={() => { setRunning((v) => !v); setOpening(false); }}>
                {t("batchWorkflow")}
              </Button>
              <Button variant="ghost" onClick={onClear}>
                {t("batchClear")}
              </Button>
            </div>
          </div>

          {opening ? (
            <div className="grid gap-4 border-t border-line p-4">
              <Field label={t("batchOpenUrl")} hint={t("batchOpenUrlHint")}>
                <Input
                  value={openUrl}
                  onChange={(e) => setOpenUrl(e.target.value)}
                  placeholder="https://example.com"
                />
              </Field>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label={t("batchConcurrency")} hint={t("batchGateNote")}>
                  <Select
                    value={concurrency}
                    onChange={(e) => setConcurrency(e.target.value)}
                  >
                    {[1, 2, 3, 4, 5, 6, 7, 8].map((n) => (
                      <option key={n} value={String(n)}>
                        {n}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label={t("batchRetries")} hint={t("batchRetriesHint")}>
                  <Select value={retries} onChange={(e) => setRetries(e.target.value)}>
                    {[0, 1, 2, 3, 4, 5].map((n) => (
                      <option key={n} value={String(n)}>
                        {n}
                      </option>
                    ))}
                  </Select>
                </Field>
              </div>
              <div className="flex gap-2">
                <Button variant="primary" disabled={busy} onClick={() => void go("start")}>
                  {busy ? "…" : t("batchGo")}
                </Button>
                <Button variant="ghost" onClick={() => setOpening(false)}>
                  {t("cancel")}
                </Button>
              </div>
            </div>
          ) : null}

          {running ? (
            <div className="grid gap-4 border-t border-line p-4">
              {workflows.length === 0 ? (
                <p className="text-[13px] text-subtle">{t("batchWorkflowNone")}</p>
              ) : (
                <>
                  <Field label={t("batchWorkflowPick")}>
                    <Select value={workflowId} onChange={(e) => setWorkflowId(e.target.value)}>
                      <option value="">—</option>
                      {workflows.map((w) => (
                        <option key={w.id} value={w.id}>
                          {w.name}（{w.steps.length} 步）
                        </option>
                      ))}
                    </Select>
                  </Field>
                  <label className="flex items-center gap-2 text-[13px] text-muted">
                    <input
                      type="checkbox"
                      className="size-4 accent-[var(--enclave-accent)]"
                      checked={stopAfter}
                      onChange={(e) => setStopAfter(e.target.checked)}
                    />
                    {t("batchStopAfter")}
                  </label>
                  <Field label={t("batchConcurrency")} hint={t("batchGateNote")}>
                    <Select value={concurrency} onChange={(e) => setConcurrency(e.target.value)}>
                      {[1, 2, 3, 4, 5, 6, 7, 8].map((n) => (
                        <option key={n} value={String(n)}>
                          {n}
                        </option>
                      ))}
                    </Select>
                  </Field>
                  <div className="flex gap-2">
                    <Button variant="primary" disabled={busy || !workflowId} onClick={() => void go("workflow")}>
                      {busy ? "…" : t("batchGo")}
                    </Button>
                    <Button variant="ghost" onClick={() => setRunning(false)}>
                      {t("cancel")}
                    </Button>
                  </div>
                </>
              )}
            </div>
          ) : null}

          {error ? <p className="px-4 pb-4 text-[13px] text-bad">{error}</p> : null}
        </Panel>
      ) : null}

      {run ? (
        <Panel>
          <PanelHeader
            title={t("batchTitle")}
            actions={
              <div className="flex items-center gap-3">
                <span className="text-[13px] text-subtle">
                  {run.action === "start" ? t("batchStart") : run.action === "workflow" ? t("batchWorkflow") : t("batchStop")} ·{" "}
                  {run.done} / {run.total} {t("batchDone")}
                  {run.failed > 0 ? `，${run.failed} ${t("batchFailed")}` : ""}
                  {run.cancelled ? `（${t("batchCancelled")}）` : ""}
                </span>
                {live && !run.cancelled ? (
                  <Button
                    onClick={() => {
                      void cancelBatch(run.id).then(async () => setRuns(await listBatchRuns()));
                    }}
                  >
                    {t("batchCancelRun")}
                  </Button>
                ) : null}
              </div>
            }
          />
          <div className="overflow-x-auto">
            <table className="app-table min-w-[640px]">
              <tbody>
                {run.items.map((item) => (
                  <tr key={item.envId}>
                    <td className="wrap">{nameOf(item.envId)}</td>
                    <td className="w-28 whitespace-nowrap">
                      <Badge tone={STATE_TONE[item.state]}>{STATE_LABEL[item.state]}</Badge>
                    </td>
                    <td className="wrap text-subtle">
                      {item.message}
                      {item.tries > 0 ? `（已重试 ${item.tries} 次）` : ""}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="px-5 pb-4 text-[13px] text-subtle">{t("batchNote")}</p>
        </Panel>
      ) : null}
    </div>
  );
}
