import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { Badge, Button, Dialog, DialogContent, Field, Input, Panel } from "@/components/ui";
import { useLocale } from "@/components/shell";
import { probeProxyFn } from "@/lib/kernel/functions";
import { t } from "@/lib/i18n";
import { makeId, type ProxyItem } from "@/lib/schema";
import { useEnclave } from "@/lib/store";

export const Route = createFileRoute("/network")({ component: NetworkPage });

function NetworkPage() {
  const locale = useLocale();
  const proxies = useEnclave((s) => s.proxies);
  const [open, setOpen] = useState(false);

  return (
    <div className="mx-auto max-w-5xl p-4 md:p-6">
      <div className="mb-4 flex items-center justify-between">
        <div>
          <h1 className="text-[20px] font-semibold tracking-tight">{t(locale, "netTitle")}</h1>
          <p className="mt-1 text-[13px] text-subtle">{t(locale, "passwordStored")}</p>
        </div>
        <Button variant="primary" onClick={() => setOpen(true)}>
          {t(locale, "addProxy")}
        </Button>
      </div>
      <div className="grid gap-2">
        {proxies.length === 0 ? (
          <Panel className="p-8 text-center text-[13px] text-subtle">{t(locale, "none")}</Panel>
        ) : (
          proxies.map((p) => (
            <Panel key={p.id} className="flex flex-wrap items-center justify-between gap-3 p-4">
              <div>
                <div className="font-medium">{p.name}</div>
                <div className="font-mono text-[12px] text-subtle">
                  {p.protocol}://{p.host}:{p.port}
                </div>
              </div>
              <div className="flex items-center gap-2">
                {p.lastProbe ? (
                  <Badge tone={p.lastProbe.ok ? "ok" : "bad"}>
                    {p.lastProbe.ok ? t(locale, "probeOk") : t(locale, "probeFail")}
                    {p.lastProbe.exitIp ? ` · ${p.lastProbe.exitIp}` : ""}
                  </Badge>
                ) : null}
                <Button
                  onClick={async () => {
                    const res = await probeProxyFn({
                      data: { protocol: p.protocol, host: p.host, port: p.port },
                    });
                    useEnclave.getState().upsertProxy({
                      ...p,
                      lastProbe: {
                        at: Date.now(),
                        ok: res.ok,
                        latencyMs: res.latencyMs,
                        exitIp: "exitIp" in res ? res.exitIp : undefined,
                        error: "error" in res ? res.error : undefined,
                      },
                    });
                  }}
                >
                  {t(locale, "probe")}
                </Button>
                <Button variant="danger" onClick={() => useEnclave.getState().removeProxy(p.id)}>
                  {t(locale, "delete")}
                </Button>
              </div>
            </Panel>
          ))
        )}
      </div>
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
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent title={t(locale, "addProxy")}>
        <div className="grid gap-3">
          <Field label={t(locale, "name")}>
            <Input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
          </Field>
          <div className="grid grid-cols-3 gap-2">
            <Field label={t(locale, "protocol")}>
              <select
                className="h-8 w-full rounded-md border border-line bg-surface px-2 text-[13px]"
                value={draft.protocol}
                onChange={(e) => setDraft({ ...draft, protocol: e.target.value as ProxyItem["protocol"] })}
              >
                <option value="http">HTTP</option>
                <option value="https">HTTPS</option>
                <option value="socks5">SOCKS5</option>
              </select>
            </Field>
            <Field label={t(locale, "host")}>
              <Input value={draft.host} onChange={(e) => setDraft({ ...draft, host: e.target.value })} />
            </Field>
            <Field label={t(locale, "port")}>
              <Input
                type="number"
                value={draft.port}
                onChange={(e) => setDraft({ ...draft, port: Number(e.target.value) })}
              />
            </Field>
          </div>
          <Field label={t(locale, "username")}>
            <Input value={draft.username} onChange={(e) => setDraft({ ...draft, username: e.target.value })} />
          </Field>
          <Field label={t(locale, "password")}>
            <Input
              type="password"
              value={draft.password}
              onChange={(e) => setDraft({ ...draft, password: e.target.value })}
            />
          </Field>
          <Field label={t(locale, "country")}>
            <Input
              value={draft.country}
              onChange={(e) => setDraft({ ...draft, country: e.target.value.toUpperCase() })}
              placeholder="US"
            />
          </Field>
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <Button onClick={onClose}>{t(locale, "cancel")}</Button>
          <Button
            variant="primary"
            onClick={() => {
              const id = makeId("prx");
              useEnclave.getState().upsertProxy({
                id,
                name: draft.name || `${draft.host}:${draft.port}`,
                protocol: draft.protocol,
                host: draft.host,
                port: draft.port,
                country: draft.country || undefined,
                auth: draft.username
                  ? { username: draft.username, password: draft.password }
                  : undefined,
              });
              useEnclave.getState().addAudit({
                action: "proxy_add",
                target: id,
                level: "info",
                detail: "proxy stored",
              });
              onClose();
            }}
          >
            {t(locale, "save")}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
