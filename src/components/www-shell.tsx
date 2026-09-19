import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

const NAV = [
  { to: "/www", label: "产品" },
  { to: "/www/pricing", label: "套餐" },
  { to: "/www/download", label: "下载" },
  { to: "/www/docs", label: "文档" },
  { to: "/www/account", label: "账号" },
] as const;

export function WwwShell({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-dvh bg-canvas text-ink">
      <header className="sticky top-0 z-20 border-b border-line bg-canvas/90 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-5xl items-center justify-between px-4">
          <Link to="/www" className="flex items-center gap-2">
            <span className="grid size-7 place-items-center rounded-md border border-line-strong bg-surface">
              <span className="size-3 rounded-[2px] border border-accent/80" />
            </span>
            <span className="text-[14px] font-semibold tracking-tight">Enclave</span>
          </Link>
          <nav className="flex items-center gap-1 text-[13px]">
            {NAV.map((item) => (
              <Link
                key={item.to}
                to={item.to}
                className="rounded-md px-2.5 py-1.5 text-muted hover:bg-surface-2 hover:text-ink"
                activeProps={{ className: "text-ink bg-surface-2" }}
              >
                {item.label}
              </Link>
            ))}
            <Link
              to="/"
              className="ml-2 rounded-md border border-line bg-surface-2 px-2.5 py-1.5 text-[12px] text-ink"
            >
              工作台
            </Link>
          </nav>
        </div>
      </header>
      <main>{children}</main>
      <footer className="border-t border-line py-8 text-[12px] text-subtle">
        <div className="mx-auto flex max-w-5xl flex-wrap justify-between gap-3 px-4">
          <div>
            内核 BSD-3-Clause · Ungoogled Chromium · fingerprint-chromium
            <Link to="/www/legal" className="ml-3 text-ink underline">
              安全与法律
            </Link>
          </div>
          <div>安装包不收费。功能靠账号额度解锁。不宣传过某站风控。</div>
        </div>
      </footer>
    </div>
  );
}

export function WwwWrap({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cn("mx-auto max-w-5xl px-4 py-10 md:py-16", className)}>{children}</div>;
}
