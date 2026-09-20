import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { ArrowLeft, FlaskConical, Play, Square } from "lucide-react";
import { useMemo, useState } from "react";
import { Badge, Button, Field, Input, Panel, Select, Textarea } from "@/components/ui";
import { useLocale } from "@/lib/use-locale";
import { classifyAll } from "@/lib/kernel/flags";
import { collectEnvCdp, startEnv, stopEnv } from "@/lib/host";
import { t, runtimeLabel } from "@/lib/i18n";
import { engineToProvider } from "@/lib/engines";
import { defaultWinVersion, windowsEdition } from "@/lib/os";
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
        这个环境不存在了。<Link to="/" className="text-accent underline">回到环境列表</Link>
      </div>
    );
  }

  const proxy = proxies.find((p) => p.id === env.proxyId);
  const checks = staticConsistency(env, proxy);
  const failed = checks.filter((c) => !c.ok && !c.warn);
  const status = runtime?.status ?? "stopped";

  return (
    <div className="mx-auto grid max-w-[1280px] gap-4 px-8 py-6 lg:grid-cols-[1fr_320px]">
      <div className="min-w-0">
        <div className="mb-4 flex flex-wrap items-center gap-3">
          <Button variant="ghost" onClick={() => void navigate({ to: "/" })}>
            <ArrowLeft className="size-3.5" />
            {t(locale, "back")}
          </Button>
          <h1 className="text-2xl font-bold tracking-tight text-ink">{env.name}</h1>
          <Badge tone={status === "running" ? "ok" : status === "error" ? "bad" : "neutral"}>
            {runtimeLabel(locale, status, runtime?.error)}
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
              <Select
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
              </Select>
            </Field>
            <Field label={t(locale, "searchEngine")}>
              <EngineSelect envId={env.id} value={env.searchEngine ?? "none"} />
            </Field>
            <Field label={t(locale, "note")}>
              <Textarea
                value={env.note}
                onChange={(e) => useEnclave.getState().patchEnv(env.id, { note: e.target.value })}
              />
            </Field>
            <ExtensionPicker envId={env.id} selected={env.extensionIds} />
            <Panel className="md:col-span-2 p-4">
              <div className="mb-2 text-[13px] font-medium">{t(locale, "consistency")}</div>
              <div className="grid gap-2">
                {checks.map((c) => (
                  <div key={c.id} className="flex items-start justify-between gap-3 text-[13px]">
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
              <li key={`${ev.at}-${i}`} className="rounded-md border border-line px-3 py-2 text-[13px]">
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
          <div className="mb-2 text-sm font-medium">{t(locale, "runtime")}</div>
          <p className="text-sm text-subtle">
            {runtime?.status === "running"
              ? t(locale, "running")
              : runtimeLabel(locale, runtime?.status ?? "stopped", runtime?.error)}
          </p>
          {runtime?.status === "running" ? (
            <Button className="mt-3 w-full" onClick={() => void collectEnvCdp(env.id)}>
              {t(locale, "collectPage")}
            </Button>
          ) : null}
        </Panel>
      </aside>
    </div>
  );
}

function EngineSelect({ envId, value }: { envId: string; value: string }) {
  const locale = useLocale();
  const catalog = useEnclave((s) => s.searchCatalog);
  return (
    <Select
      value={value}
      onChange={(e) => {
        const id = e.target.value;
        const engine = catalog.find((item) => item.id === id);
        useEnclave.getState().patchEnv(envId, {
          searchEngine: id,
          searchProvider: engine ? engineToProvider(engine) : undefined,
        });
      }}
    >
      <option value="none">{t(locale, "searchEngineNone")}</option>
      {catalog.map((engine) => (
        <option key={engine.id} value={engine.id}>
          {engine.name}
        </option>
      ))}
    </Select>
  );
}

/** 环境用哪些扩展。改完下次启动生效 —— 文案直接说清楚，别让人以为热更新。 */
function ExtensionPicker({ envId, selected }: { envId: string; selected: string[] }) {
  const extensions = useEnclave((s) => s.extensions);
  if (extensions.length === 0) return null;

  return (
    <Panel className="p-4 md:col-span-2">
      <div className="mb-1 text-[13px] font-medium text-ink">扩展</div>
      <p className="mb-3 text-[13px] text-subtle">重新启动后生效。</p>
      <div className="grid gap-2">
        {extensions.map((ext) => (
          <label key={ext.id} className="flex cursor-pointer items-start gap-2.5 text-[13px]">
            <input
              type="checkbox"
              className="mt-0.5 size-4 flex-none accent-[var(--enclave-accent)]"
              checked={selected.includes(ext.id)}
              onChange={(e) => {
                const next = e.target.checked
                  ? [...selected, ext.id]
                  : selected.filter((id) => id !== ext.id);
                useEnclave.getState().patchEnv(envId, { extensionIds: next });
              }}
            />
            <span>
              <span className="text-ink">{ext.name}</span>
              {ext.highRisk ? (
                <Badge tone="warn" className="ml-2">
                  权限较大
                </Badge>
              ) : null}
              <span className="app-mono mt-0.5 block text-xs break-all text-subtle">{ext.path}</span>
            </span>
          </label>
        ))}
      </div>
    </Panel>
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
        <Select
          value={profile.platform}
          onChange={(e) => patch({ platform: e.target.value as PlatformId })}
        >
          <option value="windows">Windows</option>
          <option value="macos">macOS</option>
          <option value="linux">Linux</option>
        </Select>
      </Field>
      {profile.platform === "windows" ? (
        <Field label={t(locale, "osVersion")}>
          <Select
            value={windowsEdition(profile.platformVersion)}
            onChange={(e) => patch({ platformVersion: defaultWinVersion(e.target.value as "10" | "11") })}
          >
            <option value="10">{t(locale, "win10")}</option>
            <option value="11">{t(locale, "win11")}</option>
          </Select>
          <p className="text-xs text-subtle">{t(locale, "osHint")}</p>
        </Field>
      ) : null}
      <Field label={t(locale, "brand")}>
        <Select
          value={profile.brand}
          onChange={(e) => patch({ brand: e.target.value as FingerprintProfile["brand"] })}
        >
          {["Chrome", "Edge", "Opera", "Vivaldi"].map((b) => (
            <option key={b}>{b}</option>
          ))}
        </Select>
      </Field>
      <Field label={t(locale, "cores")}>
        <Input
          type="number"
          value={profile.hardwareConcurrency}
          onChange={(e) => patch({ hardwareConcurrency: Number(e.target.value) })}
        />
      </Field>
      <Field label={t(locale, "timezone")}>
        <Select value={profile.timezone} onChange={(e) => patch({ timezone: e.target.value })}>
          {TIMEZONES.map((tz) => (
            <option key={tz}>{tz}</option>
          ))}
        </Select>
      </Field>
      <Field label={t(locale, "locale")}>
        <Input value={profile.locale} onChange={(e) => patch({ locale: e.target.value })} />
      </Field>
      <Field label={t(locale, "webrtc")}>
        <Select
          value={profile.webrtc.mode}
          onChange={(e) => patch({ webrtc: { mode: e.target.value as WebrtcMode } })}
        >
          <option value="replace">{t(locale, "webrtcReplace")}</option>
          <option value="disable">{t(locale, "webrtcDisable")}</option>
        </Select>
        <p className="text-xs text-subtle">{t(locale, "webrtcHint")}</p>
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
      <p className="text-[13px] text-subtle">{t(locale, "extraFlagsHint")}</p>
      <ul className="grid gap-1 text-[13px]">
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


