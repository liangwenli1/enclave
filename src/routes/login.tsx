import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { GROK_PROVIDERS, authClient, authEnabled, signIn } from "@/lib/auth/client";
import { Button, Field, Input } from "@/components/ui";

export const Route = createFileRoute("/login")({
  component: Login,
  head: () => ({ meta: [{ title: "登录 — Enclave" }] }),
});

function Login() {
  const navigate = useNavigate();
  const [mode, setMode] = useState<"in" | "up">("in");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  return (
    <main className="grid min-h-full place-items-center bg-canvas p-6 text-ink">
      <div className="w-full max-w-sm rounded-xl border border-line bg-surface p-6 shadow-panel">
        <p className="text-xs tracking-wide text-subtle">Enclave</p>
        <h1 className="mt-1 text-xl font-semibold tracking-tight">
          {mode === "in" ? "登录" : "注册"}
        </h1>
        <p className="mt-2 text-sm text-muted">登录后工作台读取订阅档位。环境数据仍只在本机。</p>
        {authEnabled ? (
          <div className="mt-5 grid gap-2">
            {GROK_PROVIDERS.map((p) => (
              <Button
                key={p.providerId}
                className="w-full"
                onClick={() => signIn(p.providerId, { callbackURL: "/" })}
              >
                使用 {p.label} 继续
              </Button>
            ))}
            <div className="my-2 text-center text-xs text-subtle">或邮箱密码</div>
            <form
              className="grid gap-3"
              onSubmit={(e) => {
                e.preventDefault();
                setError("");
                setBusy(true);
                const run =
                  mode === "up"
                    ? authClient.signUp.email({ email, password, name: email.split("@")[0] ?? "user" })
                    : authClient.signIn.email({ email, password });
                void run.then(({ error: err }) => {
                  setBusy(false);
                  if (err) {
                    setError(err.message || "登录失败");
                    return;
                  }
                  void navigate({ to: "/" });
                });
              }}
            >
              <Field label="邮箱">
                <Input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
              </Field>
              <Field label="密码">
                <Input
                  type="password"
                  required
                  minLength={8}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
              </Field>
              {error ? <p className="text-sm text-bad">{error}</p> : null}
              <Button variant="primary" type="submit" disabled={busy} className="w-full">
                {mode === "in" ? "登录" : "创建账号"}
              </Button>
            </form>
            <button
              type="button"
              className="text-sm text-muted underline-offset-4 hover:underline"
              onClick={() => setMode((m) => (m === "in" ? "up" : "in"))}
            >
              {mode === "in" ? "没有账号？注册" : "已有账号？登录"}
            </button>
          </div>
        ) : (
          <p className="mt-4 text-sm text-subtle">登录未开启。</p>
        )}
        <Link to="/www" className="mt-6 inline-block text-sm text-subtle hover:text-ink">
          返回官网
        </Link>
      </div>
    </main>
  );
}
