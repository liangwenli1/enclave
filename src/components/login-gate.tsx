import { useEffect, useState, type ReactNode } from "react";
import { BrandMark } from "@/components/brand-mark";
import { Button, CodeBlock, Field, Input } from "@/components/ui";
import { applySession, refreshSession } from "@/lib/host";
import { beginLogin, completeLogin } from "@/lib/kernel/host-api";
import { codeFromDeepLink } from "@/lib/session";
import { loadStore, syncNow, useEnclave } from "@/lib/store";
import { refreshVault } from "@/lib/vault";

/**
 * 工作台要登录后才能用。没登录时整个界面只有这一屏。
 *
 * 密码不在这里输：点「登录」会在系统浏览器里打开官网，在官网登录并点「允许」，
 * 浏览器再把一次性授权码交回来。深链接没反应的话，可以把官网显示的授权码贴进来。
 */
export function LoginGate({ children }: { children: ReactNode }) {
  const session = useEnclave((s) => s.session);

  useEffect(() => {
    void refreshSession();
    // 订阅在官网一变，这里最多一分钟后看到；切回工作台窗口时立刻再问一次。
    const id = window.setInterval(() => void refreshSession(), 60_000);
    const onFocus = () => void refreshSession();
    window.addEventListener("focus", onFocus);
    return () => {
      window.clearInterval(id);
      window.removeEventListener("focus", onFocus);
    };
  }, []);

  const signedIn = session.state === "signed-in";
  const loaded = useEnclave((s) => s.loaded);
  const storeError = useEnclave((s) => s.storeError);
  // 登录之后先把环境和代理从本机服务读出来，再让界面出现：不然首页会先闪一下"还没有环境"。
  useEffect(() => {
    if (!signedIn) return;
    void refreshVault();
    void loadStore().then((loaded) => {
      if (loaded) void syncNow();
    });
  }, [signedIn]);

  if (signedIn && loaded) return <>{children}</>;

  return (
    <div className="flex h-full min-h-full items-center justify-center bg-canvas px-6 text-muted">
      <div className="w-full max-w-[420px]">
        <div className="mb-8 flex items-center gap-2.5">
          <BrandMark size={28} />
          <span className="text-[19px] font-bold tracking-[-0.03em] text-ink">Enclave</span>
        </div>
        {session.state === "loading" ? (
          <p className="text-sm text-subtle">正在读取账号状态…</p>
        ) : null}
        {signedIn && !storeError ? (
          <p className="text-sm text-subtle">正在读取这台电脑上的环境…</p>
        ) : null}
        {signedIn && storeError ? (
          <Notice
            title="无法读取本机数据"
            body={storeError}
            action={<Button onClick={() => void loadStore()}>重试</Button>}
          />
        ) : null}
        {session.state === "host-down" ? (
          <Notice
            title="无法连接本机服务"
            body="后台服务未响应。请完全退出 Enclave 后重新打开；若仍无法连接，请重新安装。"
            action={<Button onClick={() => void refreshSession()}>重试</Button>}
          />
        ) : null}
        {session.state === "unconfigured" ? (
          <Notice
            title="该安装包无法登录"
            body="安装包中未写入服务器地址。请从官网下载正式版本。"
          />
        ) : null}
        {session.state === "signed-out" ? <SignIn reason={session.error} /> : null}
      </div>
    </div>
  );
}

function Notice({ title, body, action }: { title: string; body: string; action?: ReactNode }) {
  return (
    <div className="grid gap-3">
      <h1 className="text-2xl font-bold tracking-[-0.03em] text-ink">{title}</h1>
      <p className="text-sm leading-relaxed">{body}</p>
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  );
}

function SignIn({ reason }: { reason: string | null }) {
  const [waiting, setWaiting] = useState<{ url: string; opened: boolean } | null>(null);
  const [code, setCode] = useState("");
  const [error, setError] = useState(reason ?? "");
  const [busy, setBusy] = useState(false);

  const finish = async (value: string) => {
    setBusy(true);
    setError("");
    const res = await completeLogin(value.trim());
    if (res.ok) {
      const next = applySession(res);
      useEnclave.getState().addAudit({
        action: "sign_in",
        target: next.email ?? "",
        level: "info",
        detail: next.plan?.label ?? "",
      });
    } else {
      setError(res.message);
    }
    setBusy(false);
  };

  // 桌面壳收到 enclave://auth?code=… 时转进来的事件。
  useEffect(() => {
    const onLink = (e: Event) => {
      const link = (e as CustomEvent<string>).detail;
      const value = typeof link === "string" ? codeFromDeepLink(link) : null;
      if (value) void finish(value);
    };
    window.addEventListener("enclave:deeplink", onLink);
    return () => window.removeEventListener("enclave:deeplink", onLink);
  }, []);

  const begin = async () => {
    setBusy(true);
    setError("");
    const res = await beginLogin();
    if (res.ok) setWaiting({ url: res.url, opened: res.opened });
    else setError(res.message);
    setBusy(false);
  };

  if (!waiting) {
    return (
      <div className="grid gap-4">
        <h1 className="text-2xl font-bold tracking-[-0.03em] text-ink">登录后开始使用</h1>
        <p className="text-sm leading-relaxed">
          点下面的按钮会在浏览器里打开官网，在那里登录或注册，再点「允许登录」。密码只在官网输入，工作台不经手。
          注册即是免费档：3 个环境、同时运行 1 个。
        </p>
        {error ? <p className="text-[13px] leading-relaxed text-bad">{error}</p> : null}
        <div>
          <Button variant="primary" size="md" disabled={busy} onClick={() => void begin()}>
            {busy ? "正在打开浏览器…" : "登录 / 注册"}
          </Button>
        </div>
        <p className="text-[13px] leading-relaxed text-subtle">
          默认情况下，指纹配置、代理和 Cookie
          只保存在本机。开启加密同步后，数据会先在本机加密，再上传密文。
        </p>
      </div>
    );
  }

  return (
    <div className="grid gap-4">
      <h1 className="text-2xl font-bold tracking-[-0.03em] text-ink">在浏览器里完成登录</h1>
      <p className="text-sm leading-relaxed">
        {waiting.opened
          ? "官网已在浏览器中打开。登录后点击「允许登录」，浏览器将询问是否打开 Enclave，请选择「打开」。"
          : "浏览器未能自动打开。请将下方地址复制到浏览器中，登录后点击「允许登录」。"}
      </p>
      {waiting.opened ? null : <CodeBlock value={waiting.url} />}
      <form
        className="grid gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          void finish(code);
        }}
      >
        <Field label="未自动返回？请粘贴官网显示的授权码" error={error}>
          <Input
            value={code}
            onChange={(e) => setCode(e.target.value)}
            placeholder="授权码"
            autoComplete="off"
            spellCheck={false}
            className="app-mono"
          />
        </Field>
        <div className="flex flex-wrap gap-2">
          <Button variant="primary" type="submit" disabled={busy || !code.trim()}>
            {busy ? "登录中…" : "完成登录"}
          </Button>
          <Button type="button" disabled={busy} onClick={() => void begin()}>
            重新打开官网
          </Button>
        </div>
      </form>
    </div>
  );
}
