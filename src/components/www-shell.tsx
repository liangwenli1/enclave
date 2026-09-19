import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";

const NAV = [
  { to: "/www", label: "产品", exact: true },
  { to: "/www/pricing", label: "套餐" },
  { to: "/www/download", label: "下载" },
  { to: "/www/docs", label: "文档" },
  { to: "/www/account", label: "账号" },
] as const;

export function WwwShell({ children }: { children: ReactNode }) {
  return (
    <div className="www">
      <header className="www-header">
        <div className="www-bar">
          <Link to="/www" className="www-brand">
            <span className="www-mark">
              <i />
            </span>
            Enclave
          </Link>
          <nav className="www-nav">
            {NAV.map((item) => (
              <Link
                key={item.to}
                to={item.to}
                activeOptions={{ exact: "exact" in item && item.exact }}
                activeProps={{ "data-active": "true" }}
              >
                {item.label}
              </Link>
            ))}
            <Link to="/" className="www-nav-ghost">
              工作台
            </Link>
          </nav>
        </div>
      </header>
      {children}
      <footer className="www-footer">
        <div className="www-foot">
          <div>
            内核 BSD-3-Clause · fingerprint-chromium
            {" · "}
            <Link to="/www/legal">安全与法律</Link>
          </div>
          <div>安装包不收费。功能靠账号额度解锁。</div>
        </div>
      </footer>
    </div>
  );
}

export function WwwMain({ children }: { children: ReactNode }) {
  return <main className="www-main">{children}</main>;
}
