import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Badge, Button, Field, Input, Panel, PanelHeader, PageHeader } from "@/components/ui";
import { t } from "@/lib/i18n";
import {
  currentAccount,
  refresh,
  signIn,
  signOut,
  vendorConfigured,
  VendorError,
} from "@/lib/license/client";
import { VENDOR_URL } from "@/lib/license/vendor-url";
import { useEnclave } from "@/lib/store";

export const Route = createFileRoute("/account")({ component: AccountPage });

function fmtDate(ms: number | null | undefined): string {
  return ms ? new Date(ms).toLocaleString("zh-CN") : "不过期";
}

function AccountPage() {
  const account = useEnclave((s) => s.account);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void currentAccount().then((a) => useEnclave.getState().setAccount(a));
  }, []);

  const doSignIn = async () => {
    setBusy(true);
    setError("");
    try {
      const next = await signIn(email.trim().toLowerCase(), password);
      useEnclave.getState().setAccount(next);
      setPassword("");
      useEnclave.getState().addAudit({
        action: "sign_in",
        target: next.email ?? "",
        level: "info",
        detail: next.limits.label,
      });
    } catch (err) {
      setError(err instanceof VendorError ? err.message : "登录失败，请重试。");
    }
    setBusy(false);
  };

  const doSignOut = async () => {
    setBusy(true);
    const next = await signOut();
    useEnclave.getState().setAccount(next);
    setBusy(false);
  };

  const doRefresh = async () => {
    setBusy(true);
    const next = await refresh(true);
    useEnclave.getState().setAccount(next);
    setBusy(false);
  };

  return (
    <div className="mx-auto max-w-[1280px] px-8 py-6 *:max-w-3xl">
      <PageHeader
        title={t("navAccount")}
        status={
          account.signedIn
            ? `${account.email} · ${account.limits.label}`
            : "未登录 · Solo Free"
        }
      />

      {account.signedIn ? (
        <div className="grid gap-4">
          <Panel>
            <PanelHeader
              title="档位"
              actions={
                <Button onClick={() => void doRefresh()} disabled={busy}>
                  同步
                </Button>
              }
            />
            <dl className="grid gap-px bg-line">
              <Row label="账号" value={account.email ?? ""} />
              <Row label="档位" value={account.limits.label} />
              <Row
                label="额度"
                value={`${account.limits.envLimit} 个环境 · ${account.limits.concurrent} 个同时运行 · ${account.limits.deviceLimit} 台设备`}
              />
              <Row label="订阅到期" value={fmtDate(account.license?.expiresAt ?? null)} />
              <Row
                label="离线可用至"
                value={
                  account.license
                    ? `${fmtDate(account.license.validUntil)}（断网后还能用 ${account.license.graceDays} 天）`
                    : "—"
                }
              />
              <Row label="上次同步" value={fmtDate(account.lastSyncAt)} />
            </dl>
          </Panel>

          {account.reason !== "ok" ? (
            <Panel className="p-5">
              <div className="flex items-start gap-3">
                <Badge tone="bad">许可证不可用</Badge>
                <p className="text-[13px] leading-relaxed text-muted">
                  {account.reason === "expired"
                    ? "本机这张许可证已经过了离线宽限期，额度已回落到免费档。连上网点「同步」即可恢复。"
                    : account.reason === "unsupported"
                      ? "这个系统的浏览器内核不支持许可证验签，额度按免费档执行。升级系统后重试。"
                      : "许可证验签没通过，已按免费档执行。点「同步」重新获取。"}
                </p>
              </div>
            </Panel>
          ) : null}

          <p className="text-[13px] text-subtle">升级在官网账号页申请，开通后点「同步」生效。</p>

          <div>
            <Button onClick={() => void doSignOut()} disabled={busy} variant="danger">
              退出登录
            </Button>
            <p className="mt-2 text-[13px] text-subtle">退出后额度回到免费档，本机环境不受影响。</p>
          </div>
        </div>
      ) : (
        <div className="grid gap-4">
          <Panel className="max-w-md p-6">
            <h2 className="text-lg font-bold text-ink">登录</h2>
            <div className="mb-5" />
            {vendorConfigured ? (
              <form
                className="grid gap-4"
                onSubmit={(e) => {
                  e.preventDefault();
                  void doSignIn();
                }}
              >
                <Field label="邮箱">
                  <Input
                    type="email"
                    required
                    autoComplete="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="you@company.com"
                  />
                </Field>
                <Field label="密码" error={error}>
                  <Input
                    type="password"
                    required
                    autoComplete="current-password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                  />
                </Field>
                <Button variant="primary" size="md" type="submit" disabled={busy}>
                  {busy ? "登录中…" : "登录"}
                </Button>
              </form>
            ) : (
              <p className="text-[13px] leading-relaxed text-warn">
                这个版本没有配置账号服务地址，暂时不能登录。工作台按免费档正常使用。
              </p>
            )}
          </Panel>

          {vendorConfigured ? (
            <p className="text-[13px] text-subtle">
              没有账号？在 <span className="app-mono text-muted select-all">{VENDOR_URL}</span> 注册。
            </p>
          ) : null}
        </div>
      )}

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
