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
import { rotateApiToken } from "@/lib/kernel/host-api";
import { t } from "@/lib/i18n";
import { envCount } from "@/lib/license/plans";
import { useEnclave } from "@/lib/store";
import { buildExport, downloadExport, importSecrets, parseExport } from "@/lib/transfer";
import { setMasterPassword } from "@/lib/vault";

export const Route = createFileRoute("/settings")({ component: SettingsPage });

function SettingsPage() {
  return (
    <div className="mx-auto max-w-2xl px-8 py-6">
      <PageHeader title={t("settingsTitle")} />

      <div className="grid gap-4">
        <VaultPanel />
        <ApiPanel />
        <TransferPanel />

      </div>
    </div>
  );
}

/** 主密码：保险箱的唯一钥匙。没设之前不保存任何代理密码。 */
function VaultPanel() {
  const { exists, unlocked } = useEnclave((s) => s.vault);
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [again, setAgain] = useState("");
  const [error, setError] = useState("");
  const [done, setDone] = useState("");

  const submit = async () => {
    setError("");
    setDone("");
    if (next !== again) {
      setError("两次输入的主密码不一样。");
      return;
    }
    try {
      await setMasterPassword(next, current || undefined);
      setCurrent("");
      setNext("");
      setAgain("");
      setDone(exists ? "主密码已更新，保险箱里的密码已用新密码重新加密。" : "主密码已设置，保险箱已解锁。");
    } catch (err) {
      setError(err instanceof Error ? err.message : "设置失败。");
    }
  };

  return (
    <Panel>
      <PanelHeader
        title="主密码与保险箱"
        actions={
          exists ? (
            <Badge tone={unlocked ? "ok" : "warn"}>{unlocked ? "已解锁" : "已锁定"}</Badge>
          ) : (
            <Badge tone="warn">未设置</Badge>
          )
        }
      />
      <form
        className="grid gap-4 p-5"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <p className="text-[13px] text-warn">主密码无法找回，忘了只能清空保险箱重填。</p>
        {exists && !unlocked ? (
          <Field label="当前主密码">
            <Input
              type="password"
              value={current}
              onChange={(e) => setCurrent(e.target.value)}
              autoComplete="current-password"
            />
          </Field>
        ) : null}
        <Field label={exists ? "新主密码（至少 8 位）" : "主密码（至少 8 位）"}>
          <Input
            type="password"
            value={next}
            onChange={(e) => setNext(e.target.value)}
            autoComplete="new-password"
            minLength={8}
            required
          />
        </Field>
        <Field label="再输一次" error={error}>
          <Input
            type="password"
            value={again}
            onChange={(e) => setAgain(e.target.value)}
            autoComplete="new-password"
            required
          />
        </Field>
        {done ? <p className="text-[13px] text-ok">{done}</p> : null}
        <div>
          <Button variant="primary" type="submit">
            {exists ? "更新主密码" : "设置主密码"}
          </Button>
        </div>
      </form>
    </Panel>
  );
}

/** 给脚本用的本机 API。能不能开、开到什么程度，由档位决定。 */
function ApiPanel() {
  const enabled = useEnclave((s) => s.settings.apiEnabled);
  const level = useEnclave((s) => s.account.limits.api);
  const label = useEnclave((s) => s.account.limits.label);
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
                ? "已开启 · 完整"
                : "已开启 · 只读"
              : api.failed
                ? "没开成"
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
          <p className="text-[13px] text-bad">连不上本机服务，API 没开成。重启工作台再试。</p>
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
  const limits = useEnclave((s) => s.account.limits);
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
        ? "已导出，代理密码用你填的导出口令加密在文件里。"
        : "已导出。文件里不含任何密码。",
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
      const room = limits.envLimit - envCount(store.environments);
      if (incoming.length > room) {
        setError(
          `这个包里有 ${incoming.length} 个新环境，当前档位 ${limits.label} 还能再放 ${Math.max(0, room)} 个。先清理或升级档位。`,
        );
        return;
      }
      for (const proxy of file.proxies) store.upsertProxy(proxy);
      for (const engine of file.engines ?? []) store.upsertEngine(engine);
      for (const env of incoming) store.upsertEnv(env);

      let secretCount = 0;
      if (file.secrets) {
        if (!importPass) {
          setMessage(
            `已导入 ${incoming.length} 个环境。文件里还有加密的代理密码，填上导出口令再导入一次即可带上密码。`,
          );
          return;
        }
        secretCount = await importSecrets(file, importPass);
      }
      store.addAudit({
        action: "import",
        level: "info",
        detail: `${incoming.length} 个环境 · ${file.proxies.length} 个代理 · ${secretCount} 条密码`,
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
          <Field label="导出口令" hint="填了才会带上代理密码">
            <Input
              type="password"
              value={passphrase}
              onChange={(e) => setPassphrase(e.target.value)}
              placeholder="不填则不导出任何密码"
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
          <Field label="导入口令" hint="文件里带密码时才需要">
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
