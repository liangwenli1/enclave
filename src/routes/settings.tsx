import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { Badge, Button, Field, Input, Panel, PanelHeader, PageHeader } from "@/components/ui";
import { useLocale } from "@/lib/use-locale";
import { t } from "@/lib/i18n";
import { envCount } from "@/lib/license/plans";
import { useEnclave } from "@/lib/store";
import { buildExport, downloadExport, importSecrets, parseExport } from "@/lib/transfer";
import { setMasterPassword, subscribeVault, vaultExists, vaultUnlocked } from "@/lib/vault";

export const Route = createFileRoute("/settings")({ component: SettingsPage });

function SettingsPage() {
  const locale = useLocale();
  const settings = useEnclave((s) => s.settings);
  const patch = useEnclave((s) => s.patchSettings);

  return (
    <div className="mx-auto max-w-2xl px-8 py-6">
      <PageHeader title={t(locale, "settingsTitle")} />

      <div className="grid gap-4">
        <Panel className="p-5">
          <h2 className="mb-4 text-base font-semibold text-ink">{t(locale, "language")}</h2>
          <div className="inline-flex gap-1 rounded-md bg-surface-2 p-1">
            {(
              [
                ["zh", "中文"],
                ["en", "English"],
              ] as const
            ).map(([id, label]) => (
              <button
                key={id}
                type="button"
                onClick={() => patch({ locale: id })}
                className={
                  settings.locale === id
                    ? "rounded-[6px] bg-surface-3 px-4 py-1.5 text-[13px] font-semibold text-ink"
                    : "rounded-[6px] px-4 py-1.5 text-[13px] font-medium text-subtle hover:text-ink"
                }
              >
                {label}
              </button>
            ))}
          </div>
        </Panel>

        <VaultPanel />
        <TransferPanel />

        <Panel className="p-5">
          <h2 className="text-base font-semibold text-ink">数据放在哪</h2>
          <p className="mt-2 text-[13px] leading-relaxed text-subtle">
            环境定义、画像和代理配置存在本机的工作台数据目录；每个环境的 Cookie
            和缓存存在各自独立的 user-data 目录；代理密码只以密文存在保险箱里。
            这些数据都不会上传 —— 工作台只在登录和续签许可证时联网。
          </p>
        </Panel>
      </div>
    </div>
  );
}

/** 主密码：保险箱的唯一钥匙。没设之前不保存任何代理密码。 */
function VaultPanel() {
  const [exists, setExists] = useState(false);
  const [unlocked, setUnlocked] = useState(false);
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [again, setAgain] = useState("");
  const [error, setError] = useState("");
  const [done, setDone] = useState("");

  useEffect(() => {
    const sync = () => {
      setExists(vaultExists());
      setUnlocked(vaultUnlocked());
    };
    sync();
    return subscribeVault(sync);
  }, []);

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
        hint="代理密码只以密文存在本机"
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
        <p className="text-[13px] leading-relaxed text-subtle">
          主密码经过 PBKDF2 派生成 AES-GCM 密钥，只在内存里；锁定或关掉工作台就丢掉。
          {exists ? "" : " 没有设置主密码之前，工作台不会保存任何代理密码。"}
          <br />
          主密码忘了没有找回途径 —— 只能清空保险箱重新填写各个代理的密码。
        </p>
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
      <PanelHeader title="导出 / 导入环境包" hint="换电脑或备份用" />
      <div className="grid gap-5 p-5">
        <p className="text-[13px] leading-relaxed text-subtle">
          环境包里是环境定义、画像、代理和搜索引擎配置。
          <span className="text-muted"> Cookie、缓存和浏览记录不在里面</span>
          ，换机器后需要重新登录各个站点。
        </p>

        <div className="grid gap-3">
          <Field label="导出口令（可选，填了才会带上代理密码）">
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
          <Field label="导入口令（文件里带密码时才需要）">
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
