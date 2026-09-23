import type { ErrorComponentProps } from "@tanstack/react-router";
import { Button } from "@/components/ui";

/** 页面渲染抛错时的兜底。只说发生了什么、下一步做什么。 */
export function AppErrorComponent({ error }: ErrorComponentProps) {
  const message = error instanceof Error && error.message ? error.message : String(error);
  return (
    <main className="grid min-h-screen place-items-center bg-canvas px-6 text-center">
      <div className="grid max-w-md justify-items-center gap-3">
        <h1 className="text-xl font-bold tracking-tight text-ink">这个页面出错了</h1>
        <p className="text-[13px] text-muted">重新加载通常即可恢复，环境与设置不会丢失。</p>
        <p className="app-mono text-xs break-words text-subtle">{message}</p>
        <Button variant="primary" className="mt-2" onClick={() => window.location.reload()}>
          重新加载
        </Button>
      </div>
    </main>
  );
}
