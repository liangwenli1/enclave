import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { ArrowLeft, FlaskConical, Play, Square } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Badge, Button, Field, Input, Panel, StatusDot, Textarea } from "@/components/ui";
import { useLocale } from "@/components/shell";
import { classifyAll } from "@/lib/kernel/flags";
import { listSearchEnginesFn } from "@/lib/kernel/functions";
import { collectEnvCdp, startEnv, stopEnv } from "@/lib/host";
import { t } from "@/lib/i18n";
import { staticConsistency } from "@/lib/lab";
import { TIMEZONES, type FingerprintProfile, type PlatformId, type WebrtcMode } from "@/lib/schema";
import { useEnclave } from "@/lib/store";

export const Route = createFileRoute("/environments/$id")({ component: EnvDetail });

function EnvDetail() {
  const { id } = Route.useParams();
  const locale = useLocale();
  const navigate = useNavigate();
  const env = useEnclave((s) => s.environments.find((e) => e.id === id));
  const proxies = useEnclave((s) => s.proxies);
  const runtime = useEnclave((s) => s.runtimes[id]);
  const [tab, setTab] = useState<"overview" | "fingerprint" | "flags" | "timeline">("overview");

  if (!env) {
    return (
      <div className="p-8 text-subtle">
        Missing environment. <Link to="/">Back</Link>
      </div>
    );
  }

  const proxy = proxies.find((p) => p.id === env.proxyId);
  const checks = staticConsistency(env, proxy);
  const failed = checks.filter((c) => !c.ok && !c.warn);
  const status = runtime?.status ?? "stopped";

  return (
    <div className="mx-auto grid max-w-[1400px] gap-4 p-4 lg:grid-cols-[1fr_320px] md:p-6">
      <div className="min-w-0">
        <div className="mb-4 flex flex-wrap items-center gap-3">
          <Button variant="ghost" onClick={() => void navigate({ to: "/" })}>
            <ArrowLeft className="size-3.5" />
            {t(locale, "back")}
          </Button>
          <h1 className="text-[18px] font-semibold tracking-tight">{env.name}</h1>
          <Badge tone={status === "running" ? "ok" : status === "error" ? "bad" : "neutral"}>
            <StatusDot tone={status === "running" ? "run" : status === "error" ? "bad" : "idle"} />
            {status}
          </Badge>
          <div className="ml-auto flex gap-2">
            {status === "running" ? (
              <Button onClick={() => void stopEnv(env.id)}>
                <Square className="size-3" />
                {t(locale, "stop")}
              </Button>
            ) : (
              <Button variant="primary" onClick={() => void startEnv(env)}>
                <Play className="size-3" />
                {t(locale, "start")}
              </Button>
            )}
            <Button
              onClick={() => {
                void navigate({ to: "/lab", search: { env: env.id } });
              }}
            >
              <FlaskConical className="size-3.5" />
              {t(locale, "sendLab")}
            </Button>
          </div>
        </div>

        <div className="mb-3 flex gap-1 border-b border-line">
          {(["overview", "fingerprint", "flags", "timeline"] as const).map((key) => (
            <button
              key={key}
              onClick={() => setTab(key)}
              className={`px-3 py-2 text-[13px] ${tab === key ? "border-b-2 border-accent text-ink" : "text-subtle"}`}
            >
              {t(locale, key === "flags" ? "flags" : key)}
            </button>
          ))}
        </div>

        {tab === "overview" ? (
          <div className="grid gap-3 md:grid-cols-2">
            <Field label={t(locale, "name")}>
              <Input
                value={env.name}
                onChange={(e) => useEnclave.getState().patchEnv(env.id, { name: e.target.value })}
              />
            </Field>
            <Field label={t(locale, "group")}>
              <Input
                value={env.group}
                onChange={(e) => useEnclave.getState().patchEnv(env.id, { group: e.target.value })}
              />
            </Field>
            <Field label={t(locale, "proxy")}>
              <select
                className="h-8 w-full rounded-md border border-line bg-surface px-2 text-[13px]"
                value={env.proxyId ?? ""}
                onChange={(e) =>
                  useEnclave.getState().patchEnv(env.id, { proxyId: e.target.value || null })
                }
              >
                <option value="">{t(locale, "noProxy")}</option>
                {proxies.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label={t(locale, "searchEngine")}>
              <SearchEnginePanel envId={env.id} running={status === "running"} />
            </Field>
            <Field label={t(locale, "note")}>
              <Textarea
                value={env.note}
                onChange={(e) => useEnclave.getState().patchEnv(env.id, { note: e.target.value })}
              />
            </Field>
            <Panel className="md:col-span-2 p-4">
              <div className="mb-2 text-[12px] font-medium">{t(locale, "consistency")}</div>
              <div className="grid gap-2">
                {checks.map((c) => (
                  <div key={c.id} className="flex items-start justify-between gap-3 text-[12px]">
                    <span className="text-muted">{c.label}</span>
                    <span className={c.ok ? "text-ok" : c.warn ? "text-warn" : "text-bad"}>
                      {c.detail}
                    </span>
                  </div>
                ))}
              </div>
              {failed.length === 0 ? (
                <Badge tone="ok" className="mt-3">
                  {t(locale, "pass")}
                </Badge>
              ) : (
                <Badge tone="bad" className="mt-3">
                  {t(locale, "fail")}
                </Badge>
              )}
            </Panel>
          </div>
        ) : null}

        {tab === "fingerprint" ? <FingerprintForm envId={env.id} profile={env.profile} /> : null}

        {tab === "flags" ? <FlagsForm envId={env.id} extraFlags={env.extraFlags} allowNoSandbox={env.allowNoSandbox} /> : null}

        {tab === "timeline" ? (
          <ol className="grid gap-2">
            {env.timeline.map((ev, i) => (
              <li key={`${ev.at}-${i}`} className="rounded-md border border-line px-3 py-2 text-[12px]">
                <div className="flex justify-between gap-3">
                  <span className="font-medium">{ev.kind}</span>
                  <span className="text-subtle tabular-nums">{new Date(ev.at).toLocaleString()}</span>
                </div>
                <div className={ev.level === "bad" ? "text-bad" : ev.level === "warn" ? "text-warn" : "text-muted"}>
                  {ev.message}
                </div>
              </li>
            ))}
          </ol>
        ) : null}
      </div>

      <aside className="grid h-fit gap-3">
        <Panel className="p-4">
          <div className="mb-2 text-[12px] font-medium">{t(locale, "runtime")}</div>
          {runtime?.status === "running" ? (
            <dl className="grid gap-2 text-[12px]">
              <Row k={t(locale, "pid")} v={String(runtime.pid)} />
              <Row k={t(locale, "debugPort")} v={`127.0.0.1:${runtime.debugPort}`} />
              <Row k={t(locale, "hash")} v={runtime.hashOk ? t(locale, "hashOk") : t(locale, "hashFail")} />
              <Row k="SHA256" v={(runtime.sha256 ?? "").slice(0, 16)} />
            </dl>
          ) : (
            <p className="text-[12px] text-subtle">{runtime?.error ?? t(locale, "runtimeEmpty")}</p>
          )}
          {runtime?.status === "running" ? (
            <Button
              className="mt-3 w-full"
              onClick={() => void collectEnvCdp(env.id)}
            >
              {t(locale, "collectCdp")}
            </Button>
          ) : null}
        </Panel>
        <Panel className="p-4 text-[12px] text-subtle">
          <div>{t(locale, "bindLoopback")}</div>
          <div className="mt-2">{t(locale, "hostHeadless")}</div>
        </Panel>
      </aside>
    </div>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex justify-between gap-3">
      <dt className="text-subtle">{k}</dt>
      <dd className="font-mono text-ink">{v}</dd>
    </div>
  );
}

function FingerprintForm({ envId, profile }: { envId: string; profile: FingerprintProfile }) {
  const locale = useLocale();
  const patch = (next: Partial<FingerprintProfile>) => {
    const locked = new Set(profile.lockedFields);
    const filtered = { ...next };
    if (locked.has("seed")) delete filtered.seed;
    if (locked.has("platform") && filtered.platform && filtered.platform !== profile.platform) {
      delete filtered.platform;
    }
    useEnclave.getState().patchEnv(envId, { profile: { ...profile, ...filtered } });
  };

  return (
    <div className="grid gap-3 md:grid-cols-2">
      <Field label={t(locale, "seed")}>
        <div className="flex gap-2">
          <Input value={profile.seed} readOnly={profile.seedLocked} onChange={(e) => patch({ seed: e.target.value })} />
          <Button
            onClick={() =>
              patch({
                seedLocked: !profile.seedLocked,
              })
            }
          >
            {profile.seedLocked ? t(locale, "seedLocked") : t(locale, "unlockSeed")}
          </Button>
        </div>
      </Field>
      <Field label={t(locale, "platform")}>
        <select
          className="h-8 w-full rounded-md border border-line bg-surface px-2 text-[13px]"
          value={profile.platform}
          onChange={(e) => patch({ platform: e.target.value as PlatformId })}
        >
          <option value="windows">Windows</option>
          <option value="macos">macOS</option>
          <option value="linux">Linux</option>
        </select>
      </Field>
      <Field label={t(locale, "brand")}>
        <select
          className="h-8 w-full rounded-md border border-line bg-surface px-2 text-[13px]"
          value={profile.brand}
          onChange={(e) => patch({ brand: e.target.value as FingerprintProfile["brand"] })}
        >
          {["Chrome", "Edge", "Opera", "Vivaldi"].map((b) => (
            <option key={b}>{b}</option>
          ))}
        </select>
      </Field>
      <Field label={t(locale, "cores")}>
        <Input
          type="number"
          value={profile.hardwareConcurrency}
          onChange={(e) => patch({ hardwareConcurrency: Number(e.target.value) })}
        />
      </Field>
      <Field label={t(locale, "timezone")}>
        <select
          className="h-8 w-full rounded-md border border-line bg-surface px-2 text-[13px]"
          value={profile.timezone}
          onChange={(e) => patch({ timezone: e.target.value })}
        >
          {TIMEZONES.map((tz) => (
            <option key={tz}>{tz}</option>
          ))}
        </select>
      </Field>
      <Field label={t(locale, "locale")}>
        <Input value={profile.locale} onChange={(e) => patch({ locale: e.target.value })} />
      </Field>
      <Field label={t(locale, "webrtc")}>
        <select
          className="h-8 w-full rounded-md border border-line bg-surface px-2 text-[13px]"
          value={profile.webrtc.mode}
          onChange={(e) => patch({ webrtc: { mode: e.target.value as WebrtcMode } })}
        >
          <option value="replace">replace</option>
          <option value="disable">disable</option>
        </select>
      </Field>
      <Field label={t(locale, "screen")}>
        <Input
          value={`${profile.screen.width}x${profile.screen.height}@${profile.screen.pixelRatio}`}
          onChange={(e) => {
            const m = e.target.value.match(/(\d+)x(\d+)@([\d.]+)/);
            if (!m) return;
            patch({
              screen: {
                width: Number(m[1]),
                height: Number(m[2]),
                pixelRatio: Number(m[3]),
                colorDepth: 24,
              },
            });
          }}
        />
      </Field>
    </div>
  );
}

function FlagsForm({
  envId,
  extraFlags,
  allowNoSandbox,
}: {
  envId: string;
  extraFlags: string[];
  allowNoSandbox: boolean;
}) {
  const locale = useLocale();
  const [draft, setDraft] = useState(extraFlags.join("\n"));
  const classified = useMemo(() => classifyAll(draft.split(/\s+/).filter(Boolean)), [draft]);
  return (
    <div className="grid gap-3">
      <label className="flex items-center gap-2 text-[13px]">
        <input
          type="checkbox"
          checked={allowNoSandbox}
          onChange={(e) => {
            useEnclave.getState().patchEnv(
              envId,
              { allowNoSandbox: e.target.checked },
              {
                at: Date.now(),
                kind: "flag",
                message: e.target.checked ? "--no-sandbox enabled" : "--no-sandbox cleared",
                level: e.target.checked ? "warn" : "info",
              },
            );
            useEnclave.getState().addAudit({
              action: "sandbox_flag",
              target: envId,
              level: e.target.checked ? "warn" : "info",
              detail: e.target.checked ? "allow --no-sandbox" : "disallow --no-sandbox",
            });
          }}
        />
        {t(locale, "noSandboxFlag")}
      </label>
      <Field label={t(locale, "extraFlags")}>
        <Textarea value={draft} onChange={(e) => setDraft(e.target.value)} />
      </Field>
      <p className="text-[12px] text-subtle">{t(locale, "extraFlagsHint")}</p>
      <ul className="grid gap-1 text-[12px]">
        {classified.map((f) => (
          <li key={f.raw} className="flex justify-between gap-2 border-b border-line py-1">
            <span className="font-mono">{f.raw}</span>
            <span className={f.cls === "reject" ? "text-bad" : f.cls === "warn" ? "text-warn" : "text-ok"}>
              {t(locale, f.cls === "reject" ? "rejected" : f.cls === "warn" ? "warn" : "allowed")} · {f.reason}
            </span>
          </li>
        ))}
      </ul>
      <Button
        onClick={() => {
          if (classified.some((f) => f.cls === "reject")) return;
          useEnclave.getState().patchEnv(envId, {
            extraFlags: classified.map((f) => f.raw),
          });
        }}
      >
        {t(locale, "save")}
      </Button>
    </div>
  );
}

type EngineRow = {
  id: string;
  name: string;
  keyword: string;
  url: string;
  suggestUrl: string;
  isDefault: boolean;
};

function SearchEnginePanel({ envId, running }: { envId: string; running: boolean }) {
  const locale = useLocale();
  const env = useEnclave((s) => s.environments.find((e) => e.id === envId));
  const [engines, setEngines] = useState<EngineRow[]>([]);
  const refresh = async () => {
    const res = await listSearchEnginesFn({ data: { envId } });
    setEngines(res.engines ?? []);
  };
  useEffect(() => {
    void refresh();
  }, [envId]);
  if (!env) return null;
  const current = env.searchEngine ?? "none";
  const setDefault = (row: EngineRow) => {
    useEnclave.getState().patchEnv(envId, {
      searchEngine: row.id,
      searchProvider:
        row.id === "none"
          ? undefined
          : {
              name: row.name,
              keyword: row.keyword,
              url: row.url,
              suggestUrl: row.suggestUrl,
            },
    });
  };
  return (
    <div className="grid gap-2">
      <p className="text-[12px] text-subtle">{t(locale, "searchEngineHint")}</p>
      <div className="overflow-x-auto rounded-md border border-line">
        <table className="w-full text-left text-[12px]">
          <thead className="bg-surface-2 text-[11px] text-subtle">
            <tr>
              <th className="px-2 py-1">{t(locale, "name")}</th>
              <th className="px-2 py-1">keyword</th>
              <th className="px-2 py-1" />
            </tr>
          </thead>
          <tbody>
            {engines.map((row) => {
              const selected = current === row.id || (current === "none" && row.id === "none");
              return (
                <tr key={`${row.id}-${row.keyword}`} className="border-t border-line">
                  <td className="px-2 py-1.5">
                    {row.name}
                    {row.isDefault ? (
                      <span className="ml-2 text-[11px] text-ok">{t(locale, "searchCurrent")}</span>
                    ) : null}
                  </td>
                  <td className="px-2 py-1.5 font-mono text-subtle">{row.keyword}</td>
                  <td className="px-2 py-1.5 text-right">
                    <Button
                      variant={selected && row.id !== "none" ? "primary" : "ghost"}
                      onClick={() => setDefault(row)}
                    >
                      {t(locale, "searchSetDefault")}
                    </Button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="flex items-center gap-2">
        <Button onClick={() => void refresh()}>{t(locale, "searchRefresh")}</Button>
        {running ? <span className="text-[12px] text-warn">{t(locale, "searchEngineHint")}</span> : null}
      </div>
    </div>
  );
}
