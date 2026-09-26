import { Link, useNavigate, useRouterState } from "@tanstack/react-router";
import { Command } from "cmdk";
import {
  Box,
  Cpu,
  FlaskConical,
  Workflow,
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
import { BrandMark } from "@/components/brand-mark";
import { Button, Dialog, DialogContent, Input } from "@/components/ui";
import { Onboarding } from "@/components/onboarding";
import { cn } from "@/lib/cn";
import { configureApi, getKernelView, hostBaseUrl, type ExitInfo } from "@/lib/kernel/host-api";
import { launchSpec, stopEnv } from "@/lib/host";
import { t } from "@/lib/i18n";
import { syncNow, useEnclave } from "@/lib/store";
import { lockVault, resetVault, unlockVault } from "@/lib/vault";

const NAV_GROUPS = [
  {
    label: "工作区",
    items: [
      { to: "/", key: "navEnv" as const, icon: Box },
      { to: "/network", key: "navNet" as const, icon: Globe },
      { to: "/automation", key: "navAutomation" as const, icon: Workflow },
    ],
  },
  {
    label: "资源",
    items: [
      { to: "/engines", key: "navEngines" as const, icon: SearchCode },
      { to: "/extensions", key: "navExt" as const, icon: Puzzle },
    ],
  },
  {
    label: "系统",
    items: [
      { to: "/kernels", key: "navKernels" as const, icon: Cpu },
      { to: "/security", key: "navSecurity" as const, icon: Shield },
      { to: "/lab", key: "navLab" as const, icon: FlaskConical, preview: true },
    ],
  },
] as const;

const NAV = [...NAV_GROUPS[0].items, ...NAV_GROUPS[1].items, ...NAV_GROUPS[2].items];

export function AppShell({ children }: { children: ReactNode }) {
  // 锁没锁只有一个事实来源：本机服务说开着应用锁、而且还没输过口令。
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
    <div className="flex h-full min-h-full bg-canvas text-muted">
      <aside className="hidden w-[232px] shrink-0 flex-col border-r border-line bg-canvas md:flex">
        <div className="flex h-14 items-center gap-2.5 px-5">
          <BrandMark />
          <span className="text-[17px] font-bold tracking-[-0.03em] text-ink">Enclave</span>
        </div>
        <nav className="app-nav min-h-0 flex-1 overflow-auto">
          {NAV_GROUPS.map((group, index) => (
            <div key={group.label} className={index ? "mt-4" : undefined}>
              <p className="px-4 pb-1 text-[11px] font-medium tracking-wide text-faint">
                {group.label}
              </p>
              {group.items.map((item) => (
                <Link
                  key={item.to}
                  to={item.to}
                  data-active={pathname === item.to ? "true" : "false"}
                >
                  <item.icon className="size-4" />
                  <span>{t(item.key)}</span>
                  {"preview" in item && item.preview ? (
                    <span className="ml-auto rounded-sm bg-surface-2 px-1.5 py-0.5 text-[10px] text-subtle">
                      预览
                    </span>
                  ) : null}
                </Link>
              ))}
            </div>
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
        <header className="sticky top-0 z-10 flex h-14 items-center gap-2 border-b border-line bg-canvas px-4">
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
              className="inline-flex h-9 items-center gap-2 rounded-md border border-line px-3 text-[13px] text-subtle hover:border-ink hover:text-ink"
            >
              <Search className="size-3.5" />
              <kbd className="hidden font-mono text-[10px] md:inline">
                {/Mac/.test(navigator.platform) ? "⌘K" : "Ctrl K"}
              </kbd>
            </button>
            <LockButton />
          </div>
        </header>

        {mobileNav ? (
          <div className="grid gap-3 border-b border-line px-3 py-3 md:hidden">
            {NAV_GROUPS.map((group) => (
              <div key={group.label}>
                <p className="mb-1 px-1 text-[11px] font-medium tracking-wide text-faint">
                  {group.label}
                </p>
                <div className="flex flex-wrap gap-1.5">
                  {group.items.map((item) => (
                    <Link
                      key={item.to}
                      to={item.to}
                      onClick={() => setMobileNav(false)}
                      className={cn(
                        "inline-flex min-h-10 shrink-0 items-center rounded-md px-4 text-[13px]",
                        pathname === item.to
                          ? "bg-ink font-semibold text-canvas"
                          : "bg-surface-2 text-muted",
                      )}
                    >
                      {t(item.key)}
                    </Link>
                  ))}
                </div>
              </div>
            ))}
            <Link
              to="/account"
              onClick={() => setMobileNav(false)}
              className={cn(
                "inline-flex min-h-10 w-fit items-center rounded-md px-4 text-[13px]",
                pathname === "/account"
                  ? "bg-ink font-semibold text-canvas"
                  : "bg-surface-2 text-muted",
              )}
            >
              {t("navAccount")}
            </Link>
          </div>
        ) : null}

        <main className="min-h-0 flex-1 overflow-auto">{children}</main>
      </div>

      <CommandPalette open={cmdOpen} onOpenChange={setCmdOpen} />
      {locked ? <LockScreen /> : null}
      <Onboarding />
      <PlanNotice />
      <StoreError />
      <HostSync />
      <CloudSync />
      <ApiSync />
    </div>
  );
}

/** 侧栏底部：当前是谁、什么档。 */
function AccountChip() {
  const session = useEnclave((s) => s.session);
  return (
    <Link
      to="/account"
      className="mx-2 mb-2 block rounded-md border border-line px-3 py-2.5 hover:bg-surface-2"
    >
      <div className="truncate text-[13px] font-medium text-ink">{session.email}</div>
      <div className={cn("mt-0.5 text-xs", session.online ? "text-subtle" : "text-warn")}>
        {session.plan && session.usage
          ? `${session.plan.label}，${session.usage.profiles} / ${session.plan.envLimit} 个环境`
          : "无法连接服务器"}
      </div>
    </Link>
  );
}

/** 没开应用锁就不显示锁按钮：那把锁是假的。 */
function LockButton() {
  const exists = useEnclave((s) => s.vault.exists);
  if (!exists) return null;
  return (
    <Button
      variant="ghost"
      size="icon"
      title={t("lockNow")}
      onClick={() => {
        void lockVault();
      }}
    >
      <Lock className="size-3.5" />
    </Button>
  );
}

/** 把用户选的外观写到 <html data-theme>。选"跟随系统"就什么都不写，交给 CSS 的媒体查询。 */
export function ThemeSync() {
  const theme = useEnclave((s) => s.settings.theme);
  useEffect(() => {
    const root = document.documentElement;
    if (theme === "system") root.removeAttribute("data-theme");
    else root.setAttribute("data-theme", theme);
  }, [theme]);
  return null;
}

/** 改动没存进本机服务：必须让用户知道，否则关掉工作台这些改动就没了。 */
function StoreError() {
  const message = useEnclave((s) => s.storeError);
  if (!message) return null;
  return (
    <div className="fixed inset-x-0 bottom-0 z-[60] border-t border-bad/40 bg-canvas px-6 py-3 text-[13px] text-bad">
      {message}
    </div>
  );
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
          <Button onClick={() => useEnclave.getState().setPlanNotice(null)}>{t("gotIt")}</Button>
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
 * 本机 API 的配置跟着工作台的状态走：环境、代理、扩展、档位任何一项变了，就把最新的一份推给 Host。
 * 推过去的只有「用哪个代理」，没有密码：密码 Host 自己取，取不到（锁着、没存）它会拒启并说明原因。
 */
function ApiSync() {
  const environments = useEnclave((s) => s.environments);
  const proxies = useEnclave((s) => s.proxies);
  const extensions = useEnclave((s) => s.extensions);
  const settings = useEnclave((s) => s.settings);
  const apiLevel = useEnclave((s) => s.session.plan?.api ?? "off");
  const vaultUnlocked = useEnclave((s) => s.vault.unlocked);

  useEffect(() => {
    const timer = window.setTimeout(async () => {
      // 档位允不允许由 Host 自己问服务器；这里只是档位不含 API 时不把环境清单推过去。
      const enabled = settings.apiEnabled && apiLevel !== "off";
      const result = await configureApi({
        enabled,
        environments: enabled
          ? environments
              .filter((e) => !e.deletedAt)
              .map((e) => ({ id: e.id, name: e.name, folderId: e.folderId, spec: launchSpec(e) }))
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
  }, [environments, proxies, extensions, settings, apiLevel, vaultUnlocked]);

  return null;
}

/** 把 Host 里真实的运行态同步进界面。界面永远不自己编造 Running。 */
/** 开着工作台时定时同步一轮；切回窗口时也来一次（另一台电脑刚改过的能早点看到）。 */
function CloudSync() {
  useEffect(() => {
    const tick = () => void syncNow();
    const id = window.setInterval(tick, 60_000);
    window.addEventListener("focus", tick);
    return () => {
      window.clearInterval(id);
      window.removeEventListener("focus", tick);
    };
  }, []);
  return null;
}

function HostSync() {
  useEffect(() => {
    let alive = true;
    const tick = async () => {
      const view = await getKernelView();
      if (!alive || !view.online) return;
      const known = new Set(
        useEnclave
          .getState()
          .environments.filter((e) => !e.deletedAt)
          .map((e) => e.id),
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
  exit?: ExitInfo | null;
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
    exit: r.exit,
  };
}

/** 真锁：解锁 = 本机服务用口令解开数据密钥。口令不对就是不对。 */
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
          <KeyRound className="size-4 text-accent-text" />
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
                  void resetVault();
                  useEnclave.getState().addAudit({
                    action: "vault_reset",
                    level: "warn",
                    detail: "已重置应用锁口令，此前保存的代理密码已清空",
                  });
                }}
              >
                重置应用锁
              </Button>
            </div>
          </div>
        ) : (
          <button
            type="button"
            className="mt-4 w-full text-center text-[13px] text-subtle hover:text-ink"
            onClick={() => setForgot(true)}
          >
            忘记应用锁口令？
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
            <Command.Group heading={t("pages")} className="px-1 text-[13px] text-subtle">
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
              <Command.Group heading={t("navEnv")} className="mt-3 px-1 text-[13px] text-subtle">
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
