import { Link, useNavigate, useRouterState } from "@tanstack/react-router";
import { Command } from "cmdk";
import {
  Box,
  Cpu,
  FlaskConical,
  Globe,
  KeyRound,
  Lock,
  Menu as MenuIcon,
  Puzzle,
  Search,
  SearchCode,
  Settings,
  Shield,
  UserRound,
} from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Button, Dialog, DialogContent, Input } from "@/components/ui";
import { Onboarding } from "@/components/onboarding";
import { cn } from "@/lib/cn";
import { configureApi, getKernelView, hostBaseUrl } from "@/lib/kernel/host-api";
import { currentAccount, refresh } from "@/lib/license/client";
import { launchSpec, needsLockedSecret, stopEnv } from "@/lib/host";
import { t } from "@/lib/i18n";
import { useEnclave } from "@/lib/store";
import { lockVault, resetVault, unlockVault } from "@/lib/vault";

const NAV = [
  { to: "/", key: "navEnv" as const, icon: Box },
  { to: "/network", key: "navNet" as const, icon: Globe },
  { to: "/engines", key: "navEngines" as const, icon: SearchCode },
  { to: "/extensions", key: "navExt" as const, icon: Puzzle },
  { to: "/lab", key: "navLab" as const, icon: FlaskConical },
  { to: "/kernels", key: "navKernels" as const, icon: Cpu },
  { to: "/security", key: "navSecurity" as const, icon: Shield },
];

export function AppShell({ children }: { children: ReactNode }) {
  // 锁没锁只有一个事实来源：保险箱建了、但密钥不在内存里。重启后天然就是这个状态。
  const locked = useEnclave((s) => s.vault.exists && !s.vault.unlocked);
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const [cmdOpen, setCmdOpen] = useState(false);
  const [mobileNav, setMobileNav] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setCmdOpen(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div
      className="flex h-full min-h-full bg-canvas text-muted"
    >
      <aside className="hidden w-[232px] shrink-0 flex-col border-r border-line bg-canvas md:flex">
        <div className="flex h-16 items-center gap-2.5 px-5">
          <Mark />
          <span className="text-base font-bold tracking-tight text-ink">Enclave</span>
        </div>
        <nav className="app-nav min-h-0 flex-1 overflow-auto">
          {NAV.map((item) => (
            <Link key={item.to} to={item.to} data-active={pathname === item.to ? "true" : "false"}>
              <item.icon className="size-4" />
              {t(item.key)}
            </Link>
          ))}
        </nav>
        <div className="app-nav-foot">
          <nav className="app-nav">
            <Link to="/account" data-active={pathname === "/account" ? "true" : "false"}>
              <UserRound className="size-4" />
              {t("navAccount")}
            </Link>
            <Link to="/settings" data-active={pathname === "/settings" ? "true" : "false"}>
              <Settings className="size-4" />
              {t("navSettings")}
            </Link>
          </nav>
          <AccountChip />
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-10 flex h-16 items-center gap-2 border-b border-line bg-canvas px-4">
          <button
            className="grid size-9 place-items-center rounded-md text-subtle hover:bg-surface hover:text-ink md:hidden"
            onClick={() => setMobileNav((v) => !v)}
            aria-label={t("menu")}
          >
            <MenuIcon className="size-4" />
          </button>
          <div className="ml-auto flex items-center gap-2">
            <button
              onClick={() => setCmdOpen(true)}
              title={t("command")}
              className="inline-flex h-9 items-center gap-2 rounded-md border border-line bg-surface px-3 text-[13px] text-subtle hover:bg-surface-2 hover:text-ink"
            >
              <Search className="size-3.5" />
              <kbd className="hidden font-mono text-[10px] md:inline">Ctrl K</kbd>
            </button>
            <LockButton />
          </div>
        </header>

        {mobileNav ? (
          <div className="flex flex-wrap gap-1.5 border-b border-line px-3 py-2.5 md:hidden">
            {[...NAV, { to: "/account", key: "navAccount" as const, icon: UserRound }].map((item) => (
              <Link
                key={item.to}
                to={item.to}
                onClick={() => setMobileNav(false)}
                className={cn(
                  "inline-flex min-h-10 shrink-0 items-center rounded-full bg-surface px-4 text-[13px]",
                  pathname === item.to ? "text-ink" : "text-subtle",
                )}
              >
                {t(item.key)}
              </Link>
            ))}
          </div>
        ) : null}

        <main className="min-h-0 flex-1 overflow-auto">{children}</main>
      </div>

      <CommandPalette open={cmdOpen} onOpenChange={setCmdOpen} />
      {locked ? <LockScreen /> : null}
      <Onboarding />
      <PlanNotice />
      <AccountSync />
      <HostSync />
      <ApiSync />
    </div>
  );
}

function Mark() {
  return (
    <span className="grid size-6 place-items-center rounded-md bg-accent">
      <span className="size-2 rounded-[2px] bg-accent-fg" />
    </span>
  );
}

/** 侧栏底部：当前是谁、什么档。没登录就直说没登录。 */
function AccountChip() {
  const account = useEnclave((s) => s.account);
  return (
    <Link
      to="/account"
      className="mx-2 mb-2 block rounded-md border border-line bg-surface px-3 py-2.5 hover:bg-surface-2"
    >
      <div className="truncate text-[13px] font-medium text-ink">
        {account.signedIn ? account.email : "未登录"}
      </div>
      <div className="mt-0.5 text-xs text-subtle">
        {account.limits.label} · {account.limits.envLimit} 个环境
      </div>
    </Link>
  );
}

/** 保险箱没建起来之前不显示锁按钮：那把锁是假的。 */
function LockButton() {
  const exists = useEnclave((s) => s.vault.exists);
  if (!exists) return null;
  return (
    <Button
      variant="ghost"
      size="icon"
      title={t("lockNow")}
      onClick={() => {
        lockVault();
      }}
    >
      <Lock className="size-3.5" />
    </Button>
  );
}

/** 启动时读一次本地许可证，然后按许可证里的 refreshAfter 去续签。 */
function AccountSync() {
  useEffect(() => {
    let alive = true;
    const apply = (next: Awaited<ReturnType<typeof currentAccount>>) => {
      if (alive) useEnclave.getState().setAccount(next);
    };
    void currentAccount().then(apply);
    void refresh().then(apply);
    const id = window.setInterval(() => void refresh().then(apply), 6 * 3600_000);
    return () => {
      alive = false;
      window.clearInterval(id);
    };
  }, []);
  return null;
}

function PlanNotice() {
  const navigate = useNavigate();
  const notice = useEnclave((s) => s.planNotice);
  if (!notice) return null;
  return (
    <Dialog open onOpenChange={(open) => !open && useEnclave.getState().setPlanNotice(null)}>
      <DialogContent title={notice.title} className="z-[70]">
        <p className="text-sm leading-relaxed text-muted">{notice.body}</p>
        <div className="mt-6 flex justify-end gap-2">
          <Button onClick={() => useEnclave.getState().setPlanNotice(null)}>
            {t("gotIt")}
          </Button>
          <Button
            variant="primary"
            onClick={() => {
              useEnclave.getState().setPlanNotice(null);
              void navigate({ to: "/account" });
            }}
          >
            {t("seePlans")}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/**
 * 本机 API 的配置跟着工作台的状态走：环境、代理、扩展、档位、保险箱任何一项变了，
 * 就把最新的一份推给 Host。代理密码在锁着的保险箱里的环境不推 —— 拿不到密码就不能
 * 让脚本启动它，否则它会用本机网络出网。
 */
function ApiSync() {
  const environments = useEnclave((s) => s.environments);
  const proxies = useEnclave((s) => s.proxies);
  const extensions = useEnclave((s) => s.extensions);
  const settings = useEnclave((s) => s.settings);
  const limits = useEnclave((s) => s.account.limits);
  const vaultUnlocked = useEnclave((s) => s.vault.unlocked);

  useEffect(() => {
    const timer = window.setTimeout(async () => {
      const enabled = settings.apiEnabled && limits.api !== "off";
      const result = await configureApi({
        enabled,
        level: limits.api,
        concurrent: limits.concurrent,
        environments: enabled
          ? environments
              .filter((e) => !e.deletedAt && !needsLockedSecret(e))
              .map((e) => ({ id: e.id, name: e.name, group: e.group, spec: launchSpec(e) }))
          : [],
      });
      useEnclave.setState({
        api: {
          active: Boolean(result?.enabled),
          // 想开却没开成（本机服务没应答）：设置页要说出来，而不是只显示「未开启」。
          failed: enabled && !result,
          token: result?.token ?? "",
          baseUrl: (await hostBaseUrl()) ?? "",
        },
      });
    }, 400);
    return () => window.clearTimeout(timer);
  }, [environments, proxies, extensions, settings, limits, vaultUnlocked]);

  return null;
}

/** 把 Host 里真实的运行态同步进界面。界面永远不自己编造 Running。 */
function HostSync() {
  useEffect(() => {
    let alive = true;
    const tick = async () => {
      const view = await getKernelView();
      if (!alive || !view.online) return;
      const known = new Set(
        useEnclave.getState().environments.filter((e) => !e.deletedAt).map((e) => e.id),
      );
      const live: Record<string, ReturnType<typeof runtimeRow>> = {};
      for (const r of view.runtimes) {
        if (!known.has(r.envId)) {
          void stopEnv(r.envId);
          continue;
        }
        live[r.envId] = runtimeRow(r);
      }
      useEnclave.setState((s) => {
        const next = { ...s.runtimes };
        for (const [id, rt] of Object.entries(next)) {
          if (rt.status === "running" && !live[id]) delete next[id];
        }
        return { runtimes: { ...next, ...live } };
      });
    };
    void tick();
    const id = window.setInterval(() => void tick(), 2500);
    return () => {
      alive = false;
      window.clearInterval(id);
    };
  }, []);
  return null;
}

function runtimeRow(r: {
  envId: string;
  pid: number;
  port: number;
  startedAt: number;
  sha256: string;
}) {
  return {
    envId: r.envId,
    pid: r.pid,
    debugPort: r.port,
    debugAddress: "127.0.0.1" as const,
    status: "running" as const,
    startedAt: r.startedAt,
    hashOk: true,
    sha256: r.sha256,
  };
}

/** 真锁：解锁 = 用主密码解开保险箱。密码不对就是不对。 */
function LockScreen() {
  const [value, setValue] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [forgot, setForgot] = useState(false);

  const submit = async () => {
    setBusy(true);
    setError("");
    const ok = await unlockVault(value);
    setBusy(false);
    if (!ok) {
      setError(t("wrongMasterPw"));
      return;
    }
    setValue("");
  };

  return (
    <div className="fixed inset-0 z-[80] grid place-items-center bg-canvas">
      <form
        className="w-[min(380px,calc(100vw-24px))] rounded-lg border border-line bg-surface p-6"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <div className="mb-1 flex items-center gap-2 text-ink">
          <KeyRound className="size-4 text-accent" />
          <h1 className="text-lg font-bold tracking-tight">{t("locked")}</h1>
        </div>
        <p className="mb-5 text-[13px] text-subtle">{t("masterPwHint")}</p>
        <Input
          type="password"
          autoFocus
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder={t("masterPw")}
        />
        {error ? <p className="mt-2 text-[13px] text-bad">{error}</p> : null}
        <Button variant="primary" size="md" className="mt-4 w-full" type="submit" disabled={busy}>
          {t("unlock")}
        </Button>
        {forgot ? (
          <div className="mt-5 border-t border-line pt-4">
            <p className="text-[13px] leading-relaxed text-muted">
              清空后，保存过的<span className="text-bad">代理密码会全部删除</span>
              ，要到代理页重新填。环境和其他设置不受影响。
            </p>
            <div className="mt-3 flex justify-end gap-2">
              <Button type="button" onClick={() => setForgot(false)}>
                {t("cancel")}
              </Button>
              <Button
                type="button"
                variant="danger"
                onClick={() => {
                  resetVault();
                  useEnclave.getState().addAudit({
                    action: "vault_reset",
                    level: "warn",
                    detail: "忘记主密码，保险箱已清空",
                  });
                }}
              >
                清空保险箱
              </Button>
            </div>
          </div>
        ) : (
          <button
            type="button"
            className="mt-4 w-full text-center text-[13px] text-subtle hover:text-ink"
            onClick={() => setForgot(true)}
          >
            忘了主密码
          </button>
        )}
      </form>
    </div>
  );
}

function CommandPalette({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const navigate = useNavigate();
  const environments = useEnclave((s) => s.environments);
  const envs = useMemo(() => environments.filter((e) => !e.deletedAt), [environments]);
  const pages = useMemo(
    () => [
      ...NAV.map((n) => ({ to: n.to, label: t(n.key) })),
      { to: "/account", label: t("navAccount") },
      { to: "/settings", label: t("navSettings") },
    ],
    [],
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="overflow-hidden p-0">
        <Command className="text-sm" shouldFilter>
          <Command.Input
            placeholder={t("search")}
            className="h-12 w-full border-b border-line bg-transparent px-4 text-ink outline-none placeholder:text-faint"
          />
          <Command.List className="max-h-80 overflow-auto p-2">
            <Command.Empty className="px-2 py-8 text-center text-[13px] text-subtle">
              {t("noMatch")}
            </Command.Empty>
            <Command.Group
              heading={t("pages")}
              className="px-1 text-xs font-semibold tracking-[1.5px] text-subtle uppercase"
            >
              {pages.map((p) => (
                <Command.Item
                  key={p.to}
                  value={`page ${p.label}`}
                  className="mt-1 cursor-pointer rounded-md px-2.5 py-2 text-[13px] text-muted aria-selected:bg-surface-2 aria-selected:text-ink"
                  onSelect={() => {
                    void navigate({ to: p.to });
                    onOpenChange(false);
                  }}
                >
                  {p.label}
                </Command.Item>
              ))}
            </Command.Group>
            {envs.length ? (
              <Command.Group
                heading={t("navEnv")}
                className="mt-3 px-1 text-xs font-semibold tracking-[1.5px] text-subtle uppercase"
              >
                {envs.map((env) => (
                  <Command.Item
                    key={env.id}
                    value={`env ${env.name}`}
                    className="mt-1 cursor-pointer rounded-md px-2.5 py-2 text-[13px] text-muted aria-selected:bg-surface-2 aria-selected:text-ink"
                    onSelect={() => {
                      void navigate({ to: "/environments/$id", params: { id: env.id } });
                      onOpenChange(false);
                    }}
                  >
                    {env.name}
                  </Command.Item>
                ))}
              </Command.Group>
            ) : null}
          </Command.List>
        </Command>
      </DialogContent>
    </Dialog>
  );
}
