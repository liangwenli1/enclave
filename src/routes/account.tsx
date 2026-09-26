import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { Badge, Button, Panel, PanelHeader, PageHeader } from "@/components/ui";
import { applySession, refreshSession } from "@/lib/host";
import { t } from "@/lib/i18n";
import { getSession, logoutSession, openSite } from "@/lib/kernel/host-api";
import { useEnclave } from "@/lib/store";

export const Route = createFileRoute("/account")({ component: AccountPage });

function fmtDate(ms: number | null): string {
  return ms ? new Date(ms).toLocaleString("zh-CN") : "不过期";
}

/** 账号页。这里的数字都是刚问来的：订阅、升级、解绑设备在官网做，这边下一次问到就是新的。 */
function AccountPage() {
  const session = useEnclave((s) => s.session);
  const running = useEnclave(
    (s) => Object.values(s.runtimes).filter((r) => r.status === "running").length,
  );
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);

  const doSignOut = async () => {
    setBusy(true);
    const email = session.email ?? "";
    await logoutSession();
    const store = useEnclave.getState();
    for (const id of Object.keys(store.runtimes)) store.setRuntime(id, null);
    store.addAudit({ action: "sign_out", target: email, level: "info", detail: "已退出登录" });
    applySession(await getSession());
    setBusy(false);
  };

  const { plan, usage } = session;

  return (
    <div className="mx-auto max-w-[1280px] px-4 py-5 sm:px-8 sm:py-6 *:max-w-3xl">
      <PageHeader
        title={t("navAccount")}
        status={plan ? `${session.email}，${plan.label}` : (session.email ?? "")}
      />

      <div className="grid gap-4">
        {session.online ? null : (
          <Panel className="p-5">
            <div className="flex items-start gap-3">
              <Badge tone="warn">无法连接服务器</Badge>
              <p className="text-[13px] leading-relaxed text-muted">
                {session.error} 已经在运行的环境不受影响；新建和启动要等连上之后。
              </p>
            </div>
          </Panel>
        )}

        <Panel>
          <PanelHeader
            title="档位"
            actions={
              <Button onClick={() => void refreshSession()} disabled={busy}>
                刷新
              </Button>
            }
          />
          <dl className="grid gap-px bg-line">
            <Row label="账号" value={session.email ?? ""} />
            <Row label="档位" value={plan?.label ?? "—"} />
            {session.role === "owner" ? null : (
              <Row label="团队角色" value={session.role === "admin" ? "管理员" : "操作员"} />
            )}
            <Row
              label="环境"
              value={
                plan && usage ? `${usage.profiles} / ${plan.envLimit}（账号下所有电脑合计）` : "—"
              }
            />
            <Row
              label="同时运行"
              value={
                plan && usage ? `${usage.running} / ${plan.concurrent}（账号下所有电脑合计）` : "—"
              }
            />
            <Row label="可登录设备" value={plan ? `${plan.deviceLimit} 台` : "—"} />
            <Row label="订阅到期" value={plan ? fmtDate(session.expiresAt) : "—"} />
          </dl>
        </Panel>

        <div className="flex flex-wrap gap-2">
          <Button variant="primary" onClick={() => void openSite("pricing")}>
            升级档位
          </Button>
          <Button onClick={() => void openSite("account")}>在官网管理订阅和设备</Button>
        </div>
        <p className="text-[13px] leading-relaxed text-subtle">
          订阅、更换支付方式、取消订阅与解绑其他设备均在官网完成，将在浏览器中打开。新建和启动环境始终以服务器当前状态为准；本页数字最多延迟一分钟，点击「刷新」可立即更新。
        </p>

        <div className="mt-4">
          {confirming ? (
            <div className="grid gap-3">
              <p className="text-[13px] leading-relaxed text-warn">
                退出后要重新登录才能继续用。
                {running ? `正在运行的 ${running} 个环境会被停掉。` : ""}
                环境数据留在这台电脑上，不会删。
              </p>
              <div className="flex gap-2">
                <Button variant="danger" disabled={busy} onClick={() => void doSignOut()}>
                  {busy ? "退出中…" : "确认退出"}
                </Button>
                <Button disabled={busy} onClick={() => setConfirming(false)}>
                  取消
                </Button>
              </div>
            </div>
          ) : (
            <Button variant="danger" onClick={() => setConfirming(true)}>
              退出登录
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-3 bg-surface px-5 py-3">
      <dt className="text-[13px] text-subtle">{label}</dt>
      <dd className="app-mono text-[13px] text-muted">{value}</dd>
    </div>
  );
}
