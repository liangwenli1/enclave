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

  return (
    <div className="mx-auto max-w-4xl px-8 py-6">
      <PageHeader
        title={t(locale, "netTitle")}
        status={`${proxies.length} 个代理`}
        actions={
          <Button variant="primary" onClick={() => setOpen(true)}>
            {t(locale, "addProxy")}
          </Button>
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
                            onClick={() => {
                              void removeSecret(`proxy:${p.id}`);
                              useEnclave.getState().removeProxy(p.id);
                            }}
                            title={used ? "删除后这些环境会退回用本机网络出网" : undefined}
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
    </div>
  );
}

function ProxyDialog({ onClose }: { onClose: () => void }) {
  const locale = useLocale();
  const [draft, setDraft] = useState({
    name: "",
    protocol: "http" as ProxyItem["protocol"],
    host: "",
    port: 8080,
    username: "",
    password: "",
    country: "",
  });
  const [error, setError] = useState("");
  const vault = useEnclave((s) => s.vault);

  const canStorePassword = vault.exists && vault.unlocked;

  const save = async () => {
    setError("");
    if (!draft.host.trim()) {
      setError("请填写代理地址。");
      return;
    }
    if (draft.password && !canStorePassword) {
      setError(
        vault.exists
          ? "保险箱是锁着的，先解锁再保存带密码的代理。"
          : "要保存代理密码，得先在设置页设一个主密码。密码只会以密文存在本机。",
      );
      return;
    }
    const id = makeId("prx");
    if (draft.password) await putSecret(`proxy:${id}`, draft.password);
    useEnclave.getState().upsertProxy({
      id,
      name: draft.name.trim() || `${draft.host}:${draft.port}`,
      protocol: draft.protocol,
      host: draft.host.trim(),
      port: draft.port,
      country: draft.country || undefined,
      auth: draft.username
        ? { username: draft.username.trim(), hasPassword: Boolean(draft.password) }
        : undefined,
    });
    useEnclave.getState().addAudit({
      action: "proxy_add",
      target: id,
      level: "info",
      detail: `${draft.protocol}://${draft.host}:${draft.port}${draft.password ? " · 密码存入保险箱" : ""}`,
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
            <Field label={t(locale, "host")}>
              <Input
                value={draft.host}
                onChange={(e) => setDraft({ ...draft, host: e.target.value })}
                placeholder="proxy.example.com"
              />
            </Field>
            <Field label={t(locale, "port")}>
              <Input
                type="number"
                value={draft.port}
                onChange={(e) => setDraft({ ...draft, port: Number(e.target.value) })}
              />
            </Field>
          </div>
          <Field label={t(locale, "username")} hint="不需要认证就留空">
            <Input
              value={draft.username}
              onChange={(e) => setDraft({ ...draft, username: e.target.value })}
            />
          </Field>
          <Field
            label={t(locale, "password")}
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
          {!canStorePassword ? (
            <Link to="/settings" className="text-[13px] font-medium text-accent underline">
              去设置主密码
            </Link>
          ) : null}
          <Field label={t(locale, "country")} error={error}>
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
