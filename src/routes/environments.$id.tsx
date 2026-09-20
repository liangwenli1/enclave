import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { ArrowLeft, FlaskConical, Play, Square } from "lucide-react";
import { useMemo, useState } from "react";
import { Badge, Button, Field, Input, Panel, Select, Textarea } from "@/components/ui";
import { useLocale } from "@/lib/use-locale";
import { classifyAll } from "@/lib/kernel/flags";
import { collectEnvCdp, startEnv, stopEnv } from "@/lib/host";
import { t, runtimeLabel } from "@/lib/i18n";
import { engineToProvider } from "@/lib/engines";
import { defaultPlatformVersion, defaultWinVersion, windowsEdition } from "@/lib/os";
import { staticConsistency } from "@/lib/lab";
import {
  CORES,
  SCREENS,
  TIMEZONES,
  type FingerprintProfile,
  type PlatformId,
  type WebrtcMode,
} from "@/lib/schema";
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
  const [collect, setCollect] = useState<{ busy: boolean; note?: string; bad?: boolean }>({ busy: false });

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
              <Button
                variant="primary"
                disabled={status === "starting"}
                title={status === "starting" ? t(locale, "starting") : undefined}
                onClick={() => void startEnv(env)}
              >
                <Play className="size-3" />
                {status === "starting" ? t(locale, "starting") : t(locale, "start")}
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
          <p className={runtime?.status === "error" ? "text-sm text-bad" : "text-sm text-subtle"}>
            {runtimeLabel(locale, runtime?.status ?? "stopped", runtime?.error)}
          </p>
          {runtime?.status === "error" && runtime.detail ? (
            <p className="mt-2 text-[13px] text-muted">{runtime.detail}</p>
          ) : null}
          {runtime?.status === "error" && runtime.error ? (
            <p className="app-mono mt-2 text-xs text-subtle">{runtime.error}</p>
          ) : null}
          {runtime?.status === "running" ? (
            <p className="app-mono mt-2 text-xs text-subtle">
              pid {runtime.pid} · 127.0.0.1:{runtime.debugPort}
            </p>
          ) : null}
          {runtime?.status === "running" ? (
            <Button
              className="mt-3 w-full"
              disabled={collect.busy}
              onClick={async () => {
                setCollect({ busy: true });
                try {
                  await collectEnvCdp(env.id);
                  setCollect({ busy: false, note: "已采集，到实验室看对比。" });
                } catch (err) {
                  setCollect({
                    busy: false,
                    bad: true,
                    note: `采集失败：${err instanceof Error ? err.message : String(err)}`,
                  });
                }
              }}
            >
              {collect.busy ? "采集中…" : t(locale, "collectPage")}
            </Button>
          ) : null}
          {runtime?.status === "running" && collect.note ? (
            <p className={`mt-2 text-[13px] ${collect.bad ? "text-bad" : "text-subtle"}`}>{collect.note}</p>
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
    useEnclave.getState().patchEnv(envId, { profile: { ...profile, ...next } });
  };
  // 种子只在输入合法时才落库，草稿另存，避免半截输入把环境写坏。
  const [seedDraft, setSeedDraft] = useState(profile.seed);
  const seedBad = !/^\d{1,10}$/.test(seedDraft);
  const screens = SCREENS.some(
    (s) => s.width === profile.screen.width && s.height === profile.screen.height,
  )
    ? SCREENS
    : [profile.screen, ...SCREENS];
  const cores = CORES.includes(profile.hardwareConcurrency)
    ? CORES
    : [profile.hardwareConcurrency, ...CORES];

  return (
    <div className="grid gap-3 md:grid-cols-2">
      <Field
        label={t(locale, "seed")}
        hint={profile.seedLocked ? undefined : t(locale, "seedHint")}
        error={seedBad ? t(locale, "seedBad") : undefined}
      >
        <div className="flex gap-2">
          <Input
            className="app-mono"
            inputMode="numeric"
            value={seedDraft}
            readOnly={profile.seedLocked}
            onChange={(e) => {
              const seed = e.target.value.trim();
              setSeedDraft(seed);
              if (/^\d{1,10}$/.test(seed)) patch({ seed });
            }}
          />
          <Button
            disabled={seedBad}
            onClick={() => patch({ seedLocked: !profile.seedLocked })}
          >
            {profile.seedLocked ? t(locale, "unlockSeed") : t(locale, "lockSeed")}
          </Button>
        </div>
      </Field>
      <Field label={t(locale, "platform")}>
        <Select
          value={profile.platform}
          onChange={(e) => {
            const platform = e.target.value as PlatformId;
            patch({ platform, platformVersion: defaultPlatformVersion(platform) });
          }}
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
        <Select
          value={profile.hardwareConcurrency}
          onChange={(e) => patch({ hardwareConcurrency: Number(e.target.value) })}
        >
          {cores.map((n) => (
            <option key={n}>{n}</option>
          ))}
        </Select>
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
        <Select
          value={`${profile.screen.width}x${profile.screen.height}`}
          onChange={(e) => {
            const [width, height] = e.target.value.split("x").map(Number);
            patch({ screen: { width: width!, height: height! } });
          }}
        >
          {screens.map((sc) => (
            <option key={`${sc.width}x${sc.height}`} value={`${sc.width}x${sc.height}`}>
              {sc.width} × {sc.height}
            </option>
          ))}
        </Select>
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
  const rejected = classified.filter((f) => f.cls === "reject").length;
  const dirty = classified.map((f) => f.raw).join("\n") !== extraFlags.join("\n");
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
      {rejected ? (
        <p className="text-[13px] text-bad">有 {rejected} 个参数不允许，删掉才能保存。</p>
      ) : null}
      <div className="flex items-center gap-3">
        <Button
          disabled={!dirty || rejected > 0}
          onClick={() => {
            useEnclave.getState().patchEnv(
              envId,
              { extraFlags: classified.map((f) => f.raw) },
              { at: Date.now(), kind: "flag", message: "启动参数已更新", level: "info" },
            );
          }}
        >
          {t(locale, "save")}
        </Button>
        {!dirty && extraFlags.length ? (
          <span className="text-[13px] text-subtle">已保存，重新启动后生效。</span>
        ) : null}
      </div>
    </div>
  );
}


