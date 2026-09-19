import { Link, useNavigate, useRouterState } from "@tanstack/react-router";
import { Command } from "cmdk";
import {
  Box,
  FlaskConical,
  Globe,
  Lock,
  Puzzle,
  Search,
  Settings,
  Shield,
  Cpu,
} from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Button, Dialog, DialogContent, Input } from "@/components/ui";
import { cn } from "@/lib/cn";
import { getKernelStatusFn } from "@/lib/kernel/functions";
import { t, type Locale } from "@/lib/i18n";
import { useEnclave } from "@/lib/store";
import { Onboarding } from "@/components/onboarding";

const NAV = [
  { to: "/", key: "navEnv" as const, icon: Box },
  { to: "/network", key: "navNet" as const, icon: Globe },
  { to: "/extensions", key: "navExt" as const, icon: Puzzle },
  { to: "/lab", key: "navLab" as const, icon: FlaskConical },
  { to: "/kernels", key: "navKernels" as const, icon: Cpu },
  { to: "/security", key: "navSecurity" as const, icon: Shield },
];

export function useLocale(): Locale {
  return useEnclave((s) => s.settings.locale);
}

export function AppShell({ children }: { children: ReactNode }) {
  const locale = useLocale();
  const theme = useEnclave((s) => s.settings.theme);
  const density = useEnclave((s) => s.settings.density);
  const locked = useEnclave((s) => s.locked);
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const [cmdOpen, setCmdOpen] = useState(false);
  const [mobileNav, setMobileNav] = useState(false);

  useEffect(() => {
    document.documentElement.classList.toggle("light", theme === "light");
    document.documentElement.lang = locale === "zh" ? "zh-CN" : "en";
  }, [theme, locale]);

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
      className={cn(
        "flex min-h-dvh bg-canvas text-ink",
        density === "comfortable" && "text-[15px]",
      )}
    >
      <aside className="hidden w-[220px] shrink-0 flex-col border-r border-line bg-surface md:flex">
        <div className="flex h-12 items-center gap-2 border-b border-line px-4">
          <Mark />
          <div className="leading-tight">
            <div className="text-[13px] font-semibold tracking-tight">{t(locale, "app")}</div>
            <div className="text-[10px] text-subtle">148 · stable</div>
          </div>
        </div>
        <nav className="flex flex-1 flex-col gap-0.5 p-2">
          {NAV.map((item) => (
            <Link
              key={item.to}
              to={item.to}
              className={cn(
                "flex items-center gap-2 rounded-md px-2 py-1.5 text-[13px] text-muted hover:bg-surface-2 hover:text-ink",
                pathname === item.to && "bg-surface-2 text-ink",
              )}
            >
              <item.icon className="size-3.5" />
              {t(locale, item.key)}
            </Link>
          ))}
        </nav>
        <div className="border-t border-line p-2">
          <Link
            to="/settings"
            className={cn(
              "flex items-center gap-2 rounded-md px-2 py-1.5 text-[13px] text-muted hover:bg-surface-2 hover:text-ink",
              pathname === "/settings" && "bg-surface-2 text-ink",
            )}
          >
            <Settings className="size-3.5" />
            {t(locale, "navSettings")}
          </Link>
        </div>
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-12 items-center gap-2 border-b border-line bg-surface px-3">
          <button
            className="rounded-md p-2 text-muted md:hidden"
            onClick={() => setMobileNav((v) => !v)}
            aria-label="Menu"
          >
            <Box className="size-4" />
          </button>
          <button
            onClick={() => setCmdOpen(true)}
            className="flex h-8 min-w-0 flex-1 items-center gap-2 rounded-md border border-line bg-canvas px-2 text-left text-[12px] text-subtle md:max-w-md"
          >
            <Search className="size-3.5" />
            <span className="truncate">{t(locale, "search")}</span>
            <kbd className="ml-auto hidden rounded border border-line px-1 font-mono text-[10px] md:inline">
              ⌘K
            </kbd>
          </button>
          <Button variant="ghost" size="icon" onClick={() => useEnclave.getState().setLocked(true)}>
            <Lock className="size-3.5" />
          </Button>
        </header>
        {mobileNav ? (
          <div className="flex gap-1 overflow-x-auto border-b border-line px-2 py-2 md:hidden">
            {NAV.map((item) => (
              <Link
                key={item.to}
                to={item.to}
                onClick={() => setMobileNav(false)}
                className={cn(
                  "shrink-0 rounded-full border border-line px-3 py-1 text-[12px] text-muted",
                  pathname === item.to && "bg-surface-2 text-ink",
                )}
              >
                {t(locale, item.key)}
              </Link>
            ))}
          </div>
        ) : null}
        <main className="min-h-0 flex-1 overflow-auto">{children}</main>
      </div>
      <CommandPalette open={cmdOpen} onOpenChange={setCmdOpen} />
      {locked ? <LockScreen /> : null}
      <Onboarding />
      <HostSync />
    </div>
  );
}

function HostSync() {
  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const data = await getKernelStatusFn();
        if (!alive) return;
        const live: Record<
          string,
          {
            envId: string;
            pid: number | null;
            debugPort: number | null;
            debugAddress: "127.0.0.1";
            status: "running";
            startedAt: number | null;
            hashOk: boolean;
            sha256?: string;
          }
        > = {};
        for (const r of data.runtimes) {
          live[r.envId] = {
            envId: r.envId,
            pid: r.pid,
            debugPort: r.port,
            debugAddress: "127.0.0.1",
            status: "running",
            startedAt: r.startedAt,
            hashOk: true,
            sha256: r.sha256,
          };
        }
        useEnclave.setState((s) => {
          const next = { ...s.runtimes };
          for (const [id, rt] of Object.entries(next)) {
            if (rt.status === "running" && !live[id]) delete next[id];
          }
          return { runtimes: { ...next, ...live } };
        });
      } catch {
        /* host unreachable */
      }
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

function Mark() {
  return (
    <span className="grid size-7 place-items-center rounded-md border border-line-strong bg-canvas">
      <span className="size-3 rounded-[2px] border border-accent/80" />
    </span>
  );
}

function LockScreen() {
  const locale = useLocale();
  const [value, setValue] = useState("");
  return (
    <div className="fixed inset-0 z-[80] grid place-items-center bg-canvas/95">
      <div className="w-[min(360px,calc(100vw-24px))] rounded-xl border border-line bg-surface p-5">
        <div className="mb-3 text-[15px] font-semibold">{t(locale, "locked")}</div>
        <p className="mb-4 text-[12px] text-subtle">{t(locale, "masterPwHint")}</p>
        <Input
          type="password"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder={t(locale, "masterPw")}
        />
        <Button
          variant="primary"
          className="mt-3 w-full"
          onClick={() => useEnclave.getState().setLocked(false)}
        >
          {t(locale, "unlock")}
        </Button>
      </div>
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
  const locale = useLocale();
  const navigate = useNavigate();
  const environments = useEnclave((s) => s.environments);
  const envs = useMemo(() => environments.filter((e) => !e.deletedAt), [environments]);
  const pages = useMemo(
    () => [
      { to: "/", label: t(locale, "navEnv") },
      { to: "/network", label: t(locale, "navNet") },
      { to: "/extensions", label: t(locale, "navExt") },
      { to: "/lab", label: t(locale, "navLab") },
      { to: "/kernels", label: t(locale, "navKernels") },
      { to: "/security", label: t(locale, "navSecurity") },
      { to: "/settings", label: t(locale, "navSettings") },
    ],
    [locale],
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title={t(locale, "command")} className="p-0">
        <Command className="text-[13px]" shouldFilter>
          <Command.Input
            placeholder={t(locale, "search")}
            className="h-11 w-full border-b border-line bg-transparent px-4 outline-none"
          />
          <Command.List className="max-h-80 overflow-auto p-2">
            <Command.Empty className="px-2 py-6 text-center text-subtle">—</Command.Empty>
            <Command.Group heading={t(locale, "navEnv")} className="text-[11px] text-subtle">
              {pages.map((p) => (
                <Command.Item
                  key={p.to}
                  value={p.label}
                  className="rounded-md px-2 py-1.5 text-ink aria-selected:bg-surface-2"
                  onSelect={() => {
                    void navigate({ to: p.to });
                    onOpenChange(false);
                  }}
                >
                  {p.label}
                </Command.Item>
              ))}
            </Command.Group>
            <Command.Group heading={t(locale, "env")} className="mt-2 text-[11px] text-subtle">
              {envs.map((env) => (
                <Command.Item
                  key={env.id}
                  value={env.name}
                  className="rounded-md px-2 py-1.5 text-ink aria-selected:bg-surface-2"
                  onSelect={() => {
                    void navigate({ to: "/environments/$id", params: { id: env.id } });
                    onOpenChange(false);
                  }}
                >
                  {env.name}
                </Command.Item>
              ))}
            </Command.Group>
          </Command.List>
        </Command>
      </DialogContent>
    </Dialog>
  );
}
