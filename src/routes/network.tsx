import { createFileRoute } from "@tanstack/react-router";
import { Globe } from "lucide-react";
import { useState } from "react";
import {
  Badge,
  Button,
  Dialog,
  DialogContent,
  Empty,
  Field,
  Input,
  Panel,
  Select,
} from "@/components/ui";
import { PageHeader } from "@/components/ui";
import { t } from "@/lib/i18n";
import { makeId, type ProxyItem } from "@/lib/schema";
import { canEdit } from "@/lib/session";
import { useEnclave } from "@/lib/store";
import { putSecret, removeSecret } from "@/lib/vault";

export const Route = createFileRoute("/network")({ component: NetworkPage });

function NetworkPage() {
  const proxies = useEnclave((s) => s.proxies);
  const environments = useEnclave((s) => s.environments);
  const [open, setOpen] = useState(false);
  const vault = useEnclave((s) => s.vault);
  // 操作员：代理是团队配好的，他只管用。改不了，也看不到密码存没存。
  const mayEdit = canEdit(useEnclave((s) => s.session.role));
  const [filling, setFilling] = useState<ProxyItem | null>(null);
  const [removing, setRemoving] = useState<{ id: string; name: string; used: number } | null>(null);

  const remove = (id: string) => {
    const name = proxies.find((p) => p.id === id)?.name ?? id;
    void removeSecret(`proxy:${id}`);
    useEnclave.getState().removeProxy(id);
    useEnclave
      .getState()
      .addAudit({ action: "proxy_remove", target: id, level: "warn", detail: name });
    setRemoving(null);
  };

  return (
    <div className="mx-auto max-w-[1280px] px-4 py-5 sm:px-8 sm:py-6">
      <PageHeader
        title={t("netTitle")}
        status={`${proxies.length} 个代理`}
        actions={
          proxies.length > 0 && mayEdit ? (
            <Button variant="primary" onClick={() => setOpen(true)}>
              {t("addProxy")}
            </Button>
          ) : undefined
        }
      />

      <Panel className="overflow-hidden">
        {proxies.length === 0 ? (
          <Empty
            icon={<Globe className="size-8" />}
            title="暂无代理"
            body={
              mayEdit
                ? "未绑定代理的环境将使用本机网络出网。"
                : "代理由团队所有者配置，配置完成后将同步至此。"
            }
            action={
              mayEdit ? (
                <Button variant="primary" onClick={() => setOpen(true)}>
                  {t("addProxy")}
                </Button>
              ) : undefined
            }
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="app-table min-w-[720px]">
              <thead>
                <tr>
                  <th>{t("name")}</th>
                  <th>地址</th>
                  <th>认证</th>
                  <th>被使用</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {proxies.map((p) => {
                  const used = environments.filter(
                    (e) => !e.deletedAt && e.proxyId === p.id,
                  ).length;
                  return (
                    <tr key={p.id}>
                      <td className="wrap">
                        <div className="font-medium text-ink">{p.name}</div>
                        {p.country ? <div className="text-xs text-subtle">{p.country}</div> : null}
                      </td>
                      <td className="wrap app-mono text-xs">
                        {p.protocol}://{p.host}:{p.port}
                      </td>
                      <td>
                        {!p.auth?.username ? (
                          <span className="text-subtle">不需要</span>
                        ) : mayEdit ? (
                          <Badge tone={p.auth.hasPassword ? "ok" : "warn"}>
                            <span className="max-w-[18ch] truncate" title={p.auth.username}>
                              {p.auth.username}
                            </span>
                            <span>· {p.auth.hasPassword ? "密码已保存" : "无密码"}</span>
                          </Badge>
                        ) : (
                          <span className="text-subtle">团队统一配置</span>
                        )}
                      </td>
                      <td className="text-subtle">{used ? `${used} 个环境` : "未使用"}</td>
                      <td>
                        <div className="flex justify-end gap-1.5">
                          {!mayEdit ? null : p.auth?.username && !p.auth.hasPassword ? (
                            <Button
                              disabled={!vault.unlocked}
                              title={vault.unlocked ? undefined : "应用锁已锁定，请先解锁"}
                              onClick={() => setFilling(p)}
                            >
                              填密码
                            </Button>
                          ) : null}
                          {mayEdit ? (
                            <Button
                              variant="danger"
                              onClick={() =>
                                used ? setRemoving({ id: p.id, name: p.name, used }) : remove(p.id)
                              }
                            >
                              {t("delete")}
                            </Button>
                          ) : null}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      {open ? <ProxyDialog onClose={() => setOpen(false)} /> : null}
      {filling ? <PasswordDialog proxy={filling} onClose={() => setFilling(null)} /> : null}

      {removing ? (
        <Dialog open onOpenChange={(o) => !o && setRemoving(null)}>
          <DialogContent title={`删除「${removing.name}」？`}>
            <p className="text-[13px] leading-relaxed text-muted">
              有 {removing.used} 个环境在用它。删除后，这些环境会改用
              <span className="text-bad">本机网络</span>出网。
            </p>
            <div className="mt-6 flex justify-end gap-2">
              <Button onClick={() => setRemoving(null)}>{t("cancel")}</Button>
              <Button variant="danger" onClick={() => remove(removing.id)}>
                {t("delete")}
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      ) : null}
    </div>
  );
}

/** 给已有的代理补密码：旧版本升级上来的、或导入时没带密码的代理都走这里。 */
function PasswordDialog({ proxy, onClose }: { proxy: ProxyItem; onClose: () => void }) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");

  const save = async () => {
    if (!password) {
      setError("请填写该代理的密码。");
      return;
    }
    try {
      await putSecret(`proxy:${proxy.id}`, password);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return;
    }
    const store = useEnclave.getState();
    store.upsertProxy({ ...proxy, auth: { username: proxy.auth!.username, hasPassword: true } });
    store.addAudit({
      action: "proxy_password",
      target: proxy.id,
      level: "info",
      detail: proxy.name,
    });
    onClose();
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent title={`「${proxy.name}」的密码`}>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <Field
            label={`用户名 ${proxy.auth?.username ?? ""}`}
            error={error}
            hint="仅以密文保存在本机，保存后页面无法读回明文"
          >
            <Input
              type="password"
              autoFocus
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </Field>
          <div className="mt-6 flex justify-end gap-2">
            <Button type="button" onClick={onClose}>
              {t("cancel")}
            </Button>
            <Button variant="primary" type="submit">
              {t("save")}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function ProxyDialog({ onClose }: { onClose: () => void }) {
  const [draft, setDraft] = useState({
    name: "",
    protocol: "http" as ProxyItem["protocol"],
    host: "",
    port: "8080",
    username: "",
    password: "",
    country: "",
  });
  const [errors, setErrors] = useState<{
    host?: string;
    port?: string;
    username?: string;
    password?: string;
  }>({});
  const vault = useEnclave((s) => s.vault);

  // 平时不用任何口令就能存；只有开着应用锁又没解锁时存不了。
  const canStorePassword = vault.unlocked;

  const save = async () => {
    const host = draft.host.trim();
    const port = Number(draft.port);
    const username = draft.username.trim();
    const found: typeof errors = {};
    if (!host) found.host = "请填写代理的域名或 IP。";
    else if (/[\s/:@]/.test(host) && !/^\[[0-9a-fA-F:]+\]$/.test(host))
      found.host = "仅填写域名或 IP，不含协议、端口与路径。";
    if (!/^\d+$/.test(draft.port.trim()) || port < 1 || port > 65535)
      found.port = "请填写 1–65535 之间的整数。";
    if (draft.password && !username) found.username = "填写密码时需同时填写用户名。";
    if (draft.password && !canStorePassword) found.password = "应用锁已锁定，请先解锁。";
    setErrors(found);
    if (Object.keys(found).length) return;
    const id = makeId("prx");
    if (draft.password) await putSecret(`proxy:${id}`, draft.password);
    useEnclave.getState().upsertProxy({
      id,
      name: draft.name.trim() || `${host}:${port}`,
      protocol: draft.protocol,
      host,
      port,
      country: draft.country.trim() || undefined,
      auth: username ? { username, hasPassword: Boolean(draft.password) } : undefined,
    });
    useEnclave.getState().addAudit({
      action: "proxy_add",
      target: id,
      level: "info",
      detail: `${draft.protocol}://${host}:${port}${draft.password ? "，密码已存入保险箱" : ""}`,
    });
    onClose();
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent title={t("addProxy")}>
        <div className="grid gap-4">
          <Field label={t("name")}>
            <Input
              value={draft.name}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              placeholder="留空则使用地址"
            />
          </Field>
          <div className="grid grid-cols-[1fr_2fr_1fr] gap-3">
            <Field label={t("protocol")}>
              <Select
                value={draft.protocol}
                onChange={(e) =>
                  setDraft({ ...draft, protocol: e.target.value as ProxyItem["protocol"] })
                }
              >
                <option value="http">HTTP</option>
                <option value="https">HTTPS</option>
                <option value="socks5">SOCKS5</option>
              </Select>
            </Field>
            <Field label={t("host")} error={errors.host}>
              <Input
                value={draft.host}
                onChange={(e) => setDraft({ ...draft, host: e.target.value })}
                placeholder="proxy.example.com"
              />
            </Field>
            <Field label={t("port")} error={errors.port}>
              <Input
                inputMode="numeric"
                value={draft.port}
                onChange={(e) => setDraft({ ...draft, port: e.target.value })}
              />
            </Field>
          </div>
          <Field label={t("username")} hint="无需认证时留空" error={errors.username}>
            <Input
              value={draft.username}
              onChange={(e) => setDraft({ ...draft, username: e.target.value })}
            />
          </Field>
          <Field
            label={t("password")}
            error={errors.password}
            hint={
              canStorePassword
                ? "仅以密文保存在本机，保存后页面无法读回明文；启动环境时由本机服务直接取用"
                : "应用锁已锁定，解锁后方可保存密码"
            }
          >
            <Input
              type="password"
              value={draft.password}
              onChange={(e) => setDraft({ ...draft, password: e.target.value })}
              disabled={!canStorePassword}
            />
          </Field>
          <Field label={t("country")}>
            <Input
              value={draft.country}
              onChange={(e) => setDraft({ ...draft, country: e.target.value.toUpperCase() })}
              placeholder="US"
            />
          </Field>
        </div>
        <div className="mt-6 flex justify-end gap-2">
          <Button onClick={onClose}>{t("cancel")}</Button>
          <Button variant="primary" onClick={() => void save()}>
            {t("save")}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
