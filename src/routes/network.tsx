import { createFileRoute, Link } from "@tanstack/react-router";
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
import { useLocale } from "@/lib/use-locale";
import { t } from "@/lib/i18n";
import { makeId, type ProxyItem } from "@/lib/schema";
import { useEnclave } from "@/lib/store";
import { putSecret, removeSecret } from "@/lib/vault";

export const Route = createFileRoute("/network")({ component: NetworkPage });

function NetworkPage() {
  const locale = useLocale();
  const proxies = useEnclave((s) => s.proxies);
  const environments = useEnclave((s) => s.environments);
  const [open, setOpen] = useState(false);
  const [removing, setRemoving] = useState<{ id: string; name: string; used: number } | null>(null);

  const remove = (id: string) => {
    const name = proxies.find((p) => p.id === id)?.name ?? id;
    void removeSecret(`proxy:${id}`);
    useEnclave.getState().removeProxy(id);
    useEnclave.getState().addAudit({ action: "proxy_remove", target: id, level: "warn", detail: name });
    setRemoving(null);
  };

  return (
    <div className="mx-auto max-w-4xl px-8 py-6">
      <PageHeader
        title={t(locale, "netTitle")}
        status={`${proxies.length} 个代理`}
        actions={
          proxies.length > 0 ? (
            <Button variant="primary" onClick={() => setOpen(true)}>
              {t(locale, "addProxy")}
            </Button>
          ) : undefined
        }
      />

      <Panel className="overflow-hidden">
        {proxies.length === 0 ? (
          <Empty
            icon={<Globe className="size-8" />}
            title="还没有代理"
            body="不绑代理的环境走本机网络出网。"
            action={
              <Button variant="primary" onClick={() => setOpen(true)}>
                {t(locale, "addProxy")}
              </Button>
            }
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="app-table min-w-[720px]">
              <thead>
                <tr>
                  <th>{t(locale, "name")}</th>
                  <th>地址</th>
                  <th>认证</th>
                  <th>被使用</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {proxies.map((p) => {
                  const used = environments.filter((e) => !e.deletedAt && e.proxyId === p.id).length;
                  return (
                    <tr key={p.id}>
                      <td>
                        <div className="font-medium text-ink">{p.name}</div>
                        {p.country ? <div className="text-xs text-subtle">{p.country}</div> : null}
                      </td>
                      <td className="app-mono text-xs">
                        {p.protocol}://{p.host}:{p.port}
                      </td>
                      <td>
                        {p.auth?.username ? (
                          <Badge tone={p.auth.hasPassword ? "ok" : "warn"}>
                            {p.auth.hasPassword ? `${p.auth.username} · 密码已保存` : `${p.auth.username} · 没有密码`}
                          </Badge>
                        ) : (
                          <span className="text-subtle">不需要</span>
                        )}
                      </td>
                      <td className="text-subtle">{used ? `${used} 个环境` : "未使用"}</td>
                      <td>
                        <div className="flex justify-end">
                          <Button
                            variant="danger"
                            onClick={() =>
                              used ? setRemoving({ id: p.id, name: p.name, used }) : remove(p.id)
                            }
                          >
                            {t(locale, "delete")}
                          </Button>
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

      {removing ? (
        <Dialog open onOpenChange={(o) => !o && setRemoving(null)}>
          <DialogContent title={`删除「${removing.name}」？`}>
            <p className="text-[13px] leading-relaxed text-muted">
              有 {removing.used} 个环境在用它。删除后，这些环境会改用
              <span className="text-bad">本机网络</span>出网。
            </p>
            <div className="mt-6 flex justify-end gap-2">
              <Button onClick={() => setRemoving(null)}>{t(locale, "cancel")}</Button>
              <Button variant="danger" onClick={() => remove(removing.id)}>
                {t(locale, "delete")}
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      ) : null}
    </div>
  );
}

function ProxyDialog({ onClose }: { onClose: () => void }) {
  const locale = useLocale();
  const [draft, setDraft] = useState({
    name: "",
    protocol: "http" as ProxyItem["protocol"],
    host: "",
    port: "8080",
    username: "",
    password: "",
    country: "",
  });
  const [errors, setErrors] = useState<{ host?: string; port?: string; username?: string; password?: string }>({});
  const vault = useEnclave((s) => s.vault);

  const canStorePassword = vault.exists && vault.unlocked;

  const save = async () => {
    const host = draft.host.trim();
    const port = Number(draft.port);
    const username = draft.username.trim();
    const found: typeof errors = {};
    if (!host) found.host = "填代理的域名或 IP。";
    else if (/[\s/:@]/.test(host) && !/^\[[0-9a-fA-F:]+\]$/.test(host))
      found.host = "只填域名或 IP，不带协议、端口和路径。";
    if (!/^\d+$/.test(draft.port.trim()) || port < 1 || port > 65535) found.port = "1–65535 的整数。";
    if (draft.password && !username) found.username = "填了密码就要填用户名。";
    if (draft.password && !canStorePassword)
      found.password = vault.exists ? "保险箱锁着，先解锁。" : "先在设置页设主密码。";
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
      detail: `${draft.protocol}://${host}:${port}${draft.password ? " · 密码存入保险箱" : ""}`,
    });
    onClose();
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent title={t(locale, "addProxy")}>
        <div className="grid gap-4">
          <Field label={t(locale, "name")}>
            <Input
              value={draft.name}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              placeholder="留空就用地址"
            />
          </Field>
          <div className="grid grid-cols-[1fr_2fr_1fr] gap-3">
            <Field label={t(locale, "protocol")}>
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
            <Field label={t(locale, "host")} error={errors.host}>
              <Input
                value={draft.host}
                onChange={(e) => setDraft({ ...draft, host: e.target.value })}
                placeholder="proxy.example.com"
              />
            </Field>
            <Field label={t(locale, "port")} error={errors.port}>
              <Input
                inputMode="numeric"
                value={draft.port}
                onChange={(e) => setDraft({ ...draft, port: e.target.value })}
              />
            </Field>
          </div>
          <Field label={t(locale, "username")} hint="不需要认证就留空" error={errors.username}>
            <Input
              value={draft.username}
              onChange={(e) => setDraft({ ...draft, username: e.target.value })}
            />
          </Field>
          <Field
            label={t(locale, "password")}
            error={errors.password}
            hint={
              canStorePassword
                ? "存进保险箱，只以密文落盘"
                : vault.exists
                  ? "保险箱锁着，解锁后才能保存密码"
                  : "需要先在设置页设主密码"
            }
          >
            <Input
              type="password"
              value={draft.password}
              onChange={(e) => setDraft({ ...draft, password: e.target.value })}
              disabled={!canStorePassword}
            />
          </Field>
          {!vault.exists ? (
            <Link to="/settings" className="text-[13px] font-medium text-accent underline">
              去设置主密码
            </Link>
          ) : null}
          <Field label={t(locale, "country")}>
            <Input
              value={draft.country}
              onChange={(e) => setDraft({ ...draft, country: e.target.value.toUpperCase() })}
              placeholder="US"
            />
          </Field>
        </div>
        <div className="mt-6 flex justify-end gap-2">
          <Button onClick={onClose}>{t(locale, "cancel")}</Button>
          <Button variant="primary" onClick={() => void save()}>
            {t(locale, "save")}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
