import { createRootRoute, Outlet } from "@tanstack/react-router";
import { LoginGate } from "@/components/login-gate";
import { AppShell, ThemeSync } from "@/components/shell";

export const Route = createRootRoute({ component: RootDocument });

function RootDocument() {
  return (
    <>
      {/* 外观在登录之前就要生效；没登录时整个界面只有登录那一屏。 */}
      <ThemeSync />
      <LoginGate>
        <AppShell>
      <Outlet />
        </AppShell>
      </LoginGate>
    </>
  );
}
