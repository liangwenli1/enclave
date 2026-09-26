import { createFileRoute } from "@tanstack/react-router";
import { useRef, useState } from "react";
import {
  Badge,
  Button,
  CodeBlock,
  Field,
  Input,
  Panel,
  PanelHeader,
  PageHeader,
} from "@/components/ui";
import { registerEnv } from "@/lib/host";
import { rotateApiToken } from "@/lib/kernel/host-api";
import { t } from "@/lib/i18n";
import { useEnclave } from "@/lib/store";
import { buildExport, downloadExport, importSecrets, parseExport } from "@/lib/transfer";
import { SyncPanel } from "@/components/sync-panel";
import { canEdit } from "@/lib/session";
import { removeAppLock, setAppLock } from "@/lib/vault";

export const Route = createFileRoute("/settings")({ component: SettingsPage });

function SettingsPage() {
  const role = useEnclave((s) => s.session.role);
  // 操作员：同步是团队的钥匙，导出是把团队资产带走的出口，这两块都不给他看。
  // 界面只是不显示，真正拦住的是本机服务和服务器。
  const mayEdit = canEdit(role);
  return (
    <div className="mx-auto max-w-[1280px] px-4 py-5 sm:px-8 sm:py-6 *:max-w-[1080px]">
      <PageHeader title={t("settingsTitle")} status={mayEdit ? undefined : "当前角色为操作员"} />

      <div className="grid gap-4">
        <div className="grid items-start gap-4 xl:grid-cols-2">
          <AppearancePanel />
          <VaultPanel />
        </div>
        {mayEdit ? <SyncPanel /> : <OperatorPanel />}
        <details className="rounded border border-line bg-surface">
          <summary className="cursor-pointer px-5 py-4 text-sm font-semibold text-ink hover:bg-surface-2">
            高级设置
          </summary>
          <div className="grid gap-4 border-t border-line p-4 xl:grid-cols-2">
            <ApiPanel />
            {mayEdit ? <TransferPanel /> : null}
          </div>
        </details>
      </div>
    </div>
  );
}

/** 操作员看到的那一块：说清楚他能做什么、不能做什么，而不是留一片空白。 */
function OperatorPanel() {
  return (
    <Panel>
      <PanelHeader title="同步" actions={<Badge tone="ok">由团队统一管理</Badge>} />
      <div className="grid gap-3 p-5 text-[13px] leading-relaxed text-muted">
        <p>
          团队分配的环境与登录状态会自动同步。在其他已授权设备上打开同一环境时，可以继续使用已有登录状态。
        </p>
        <p>
          当前角色为<b>操作员</b>
          。可以打开已分配的环境，但不能新建或修改环境、查看代理密码或导出环境包。
        </p>
      </div>
    </Panel>
  );
}

/**
 * 应用锁：可选。平时不需要任何口令——加密代理密码用的钥匙在系统钥匙串里，由操作系统账号保护。
 * 和别人共用一台电脑的系统账号时才需要开：开了之后每次打开工作台要输口令。
 */
function VaultPanel() {
  const { exists, unlocked } = useEnclave((s) => s.vault);
  const [next, setNext] = useState("");
  const [again, setAgain] = useState("");
  const [error, setError] = useState("");
  const [done, setDone] = useState("");
  // 口令要过一遍 Argon2id（故意慢，防暴力猜），按下去之后得让人看得出在处理。
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setError("");
    setDone("");
    if (next !== again) {
      setError("两次输入的口令不一致。");
      return;
    }
    setBusy(true);
    try {
      await setAppLock(next);
      setNext("");
      setAgain("");
      setDone(exists ? "口令已更新。" : "应用锁已开启，下次打开工作台需输入此口令。");
    } catch (err) {
      setError(err instanceof Error ? err.message : "设置失败。");
    }
    setBusy(false);
  };

  return (
    <Panel>
      <PanelHeader
        title="应用锁"
        actions={
          <Badge tone={exists ? "ok" : "neutral"}>
            {exists ? (unlocked ? "已开启" : "已锁定") : "未开启"}
          </Badge>
        }
      />
      <form
        className="grid gap-4 p-5"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <p className="text-[13px] leading-relaxed text-muted">
          代理密码默认使用系统钥匙串保护。多人共用同一系统账号时，可启用应用锁增加访问控制。
        </p>
        <p className="text-[13px] text-warn">
          应用锁口令无法找回。重置后需要重新填写已保存的代理密码。
        </p>
        <Field label={exists ? "新口令（至少 8 位）" : "口令（至少 8 位）"}>
          <Input
            type="password"
            value={next}
            onChange={(e) => setNext(e.target.value)}
            autoComplete="new-password"
            minLength={8}
            required
          />
        </Field>
        <Field label="确认口令" error={error}>
          <Input
            type="password"
            value={again}
            onChange={(e) => setAgain(e.target.value)}
            autoComplete="new-password"
            required
          />
        </Field>
        {done ? <p className="text-[13px] text-ok">{done}</p> : null}
        <div className="flex flex-wrap gap-2">
          <Button variant="primary" type="submit" disabled={busy}>
            {busy ? "处理中…" : exists ? "更换口令" : "开启应用锁"}
          </Button>
          {exists ? (
            <Button
              type="button"
              onClick={() => {
                setError("");
                removeAppLock().then(
                  () => setDone("应用锁已关闭，密钥已交还系统钥匙串。"),
                  (err: Error) => setError(err.message),
                );
              }}
            >
              关闭应用锁
            </Button>
          ) : null}
        </div>
      </form>
    </Panel>
  );
}

function AppearancePanel() {
  const theme = useEnclave((s) => s.settings.theme);
  const options = [
    ["system", "跟随系统"],
    ["light", "亮色"],
    ["dark", "暗色"],
  ] as const;
  return (
    <Panel>
      <PanelHeader title="外观" />
      <div className="p-5">
        <div
          className="inline-flex rounded-md border border-line-strong"
          role="group"
          aria-label="外观"
        >
          {options.map(([id, label]) => (
            <button
              key={id}
              type="button"
              aria-pressed={theme === id}
              onClick={() => useEnclave.getState().patchSettings({ theme: id })}
              className={
                theme === id
                  ? "bg-ink px-4 py-1.5 text-[13px] font-semibold text-canvas first:rounded-l-[2px] last:rounded-r-[2px]"
                  : "px-4 py-1.5 text-[13px] text-muted hover:bg-surface-2 hover:text-ink"
              }
            >
              {label}
            </button>
          ))}
        </div>
      </div>
    </Panel>
  );
}

/** 给脚本用的本机 API。能不能开、开到什么程度，由档位决定。 */
function ApiPanel() {
  const enabled = useEnclave((s) => s.settings.apiEnabled);
  const level = useEnclave((s) => s.session.plan?.api ?? "off");
  const label = useEnclave((s) => s.session.plan?.label ?? "当前档位");
  const api = useEnclave((s) => s.api);
  const locked = level === "off";

  return (
    <Panel>
      <PanelHeader
        title="本机 API"
        actions={
          <Badge tone={api.active ? "ok" : api.failed ? "bad" : "neutral"}>
            {api.active
              ? level === "full"
                ? "已开启，完整"
                : "已开启，只读"
              : api.failed
                ? "开启失败"
                : "未开启"}
          </Badge>
        }
      />
      <div className="grid gap-4 p-5">
        <label className="flex cursor-pointer items-center gap-3 text-[13px]">
          <input
            type="checkbox"
            className="size-4 accent-[var(--enclave-accent)]"
            checked={enabled && !locked}
            disabled={locked}
            onChange={(e) => {
              useEnclave.getState().patchSettings({ apiEnabled: e.target.checked });
              useEnclave.getState().addAudit({
                action: "api_toggle",
                level: "warn",
                detail: e.target.checked ? "开启本机 API" : "关闭本机 API",
              });
            }}
          />
          <span className={locked ? "text-subtle" : "text-ink"}>
            {locked ? `${label} 不含本机 API` : "允许本机脚本调用"}
          </span>
        </label>

        {api.failed ? (
          <p className="text-[13px] text-bad">无法连接本机服务，API 未能开启。请重启工作台。</p>
        ) : null}

        {api.active ? (
          <>
            <CodeBlock label="API 令牌" value={api.token} />
            <CodeBlock
              label="示例"
              value={`curl -H "Authorization: Bearer ${api.token}" ${api.baseUrl}/api/v1/environments`}
            />
            <div>
              <Button
                onClick={async () => {
                  const token = await rotateApiToken();
                  if (!token) return;
                  useEnclave.setState((s) => ({ api: { ...s.api, token } }));
                  useEnclave.getState().addAudit({
                    action: "api_token_rotate",
                    level: "warn",
                    detail: "旧令牌已失效",
                  });
                }}
              >
                重置令牌
              </Button>
            </div>
          </>
        ) : null}
      </div>
    </Panel>
  );
}

/** 换电脑 / 备份。 */
function TransferPanel() {
  const environments = useEnclave((s) => s.environments);
  const proxies = useEnclave((s) => s.proxies);
  const engines = useEnclave((s) => s.searchCatalog);
  const fileInput = useRef<HTMLInputElement>(null);
  const [passphrase, setPassphrase] = useState("");
  const [importPass, setImportPass] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  const doExport = async () => {
    setError("");
    const file = await buildExport({ environments, proxies, engines, passphrase });
    downloadExport(file);
    setMessage(
      file.secrets
        ? "已导出，代理密码以导出口令加密保存在文件中。"
        : "已导出，文件中不含任何密码。",
    );
    setPassphrase("");
  };

  const doImport = async (text: string) => {
    setError("");
    setMessage("");
    try {
      const file = parseExport(text);
      const store = useEnclave.getState();
      const existing = new Set(store.environments.map((e) => e.id));
      const incoming = file.environments.filter((e) => !existing.has(e.id));
      // 先导密码，再导代理："已保存密码"以保险箱里真有为准，不照抄文件里的标记。
      const secretCount = file.secrets && importPass ? await importSecrets(file, importPass) : 0;
      for (const proxy of file.proxies) {
        // "已保存密码"以本机服务里真的有为准（store 会按 secretIds 重算），不照抄文件里的标记。
        store.upsertProxy(
          proxy.auth
            ? {
                ...proxy,
                auth: { ...proxy.auth, hasPassword: store.secretIds.includes(`proxy:${proxy.id}`) },
              }
            : proxy,
        );
      }
      for (const engine of file.engines ?? []) store.upsertEngine(engine);
      // 每个新环境都要在账号下占一个名额，服务器说行才导进来。中途满了就停在那里，已经导进来的留着。
      let imported = 0;
      for (const env of incoming) {
        const registered = await registerEnv(env);
        if (!registered.ok) {
          setError(`导入了 ${imported} / ${incoming.length} 个环境后停下了：${registered.message}`);
          return;
        }
        store.upsertEnv(env);
        imported += 1;
      }
      if (file.secrets && !importPass) {
        setMessage(
          `已导入 ${incoming.length} 个环境。文件里还有加密的代理密码，填上导出口令再导入一次即可带上密码。`,
        );
        return;
      }
      store.addAudit({
        action: "import",
        level: "info",
        detail: `${incoming.length} 个环境，${file.proxies.length} 个代理，${secretCount} 条密码`,
      });
      setMessage(
        `已导入 ${incoming.length} 个环境、${file.proxies.length} 个代理${secretCount ? `、${secretCount} 条代理密码` : ""}。`,
      );
      setImportPass("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "导入失败。");
    }
  };

  return (
    <Panel>
      <PanelHeader title="导出 / 导入环境包" />
      <div className="grid gap-5 p-5">
        <p className="text-[13px] text-subtle">不含 Cookie 和浏览记录。</p>

        <div className="grid gap-3">
          <Field label="导出口令" hint="填写后方会包含代理密码">
            <Input
              type="password"
              value={passphrase}
              onChange={(e) => setPassphrase(e.target.value)}
              placeholder="留空则不导出任何密码"
              autoComplete="off"
            />
          </Field>
          <div className="flex flex-wrap gap-2">
            <Button onClick={() => void doExport()}>导出环境包</Button>
            <Button onClick={() => fileInput.current?.click()}>选择文件导入</Button>
            <input
              ref={fileInput}
              type="file"
              accept=".json,application/json"
              className="hidden"
              onChange={async (e) => {
                const f = e.target.files?.[0];
                if (!f) return;
                await doImport(await f.text());
                e.target.value = "";
              }}
            />
          </div>
          <Field label="导入口令" hint="仅当文件包含密码时需要">
            <Input
              type="password"
              value={importPass}
              onChange={(e) => setImportPass(e.target.value)}
              autoComplete="off"
            />
          </Field>
        </div>

        {message ? <p className="text-[13px] text-ok">{message}</p> : null}
        {error ? <p className="text-[13px] text-bad">{error}</p> : null}
      </div>
    </Panel>
  );
}
