import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { ArrowLeft, FlaskConical, Play, Square } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Badge, Button, Field, Input, Panel, Select, Textarea } from "@/components/ui";
import { EnvGlyph } from "@/components/env-glyph";
import { ENGINE_META } from "@/lib/engines-meta";
import { classifyFlags, type ClassifiedFlag, type EngineClass } from "@/lib/kernel/host-api";
import { kernelOptionLabel, useKernels } from "@/lib/kernel/use-kernels";
import { collectEnvCdp, registerEnv, startEnv, stopEnv } from "@/lib/host";
import { eventLabel, t, runtimeLabel } from "@/lib/i18n";
import { engineToProvider } from "@/lib/engines";
import { defaultPlatformVersion, defaultWinVersion, platformLabel, windowsEdition } from "@/lib/os";
import { useFolders } from "@/lib/folders";
import { canEdit } from "@/lib/session";
import { staticConsistency } from "@/lib/consistency";
import { REGIONS, regionOfTimezone } from "@/lib/regions";
import {
  CORES_BY_PLATFORM,
  deviceLabel,
  deviceWindowBounds,
  realScreen,
  usableDevices,
  windowBoundsOf,
  type Device,
  regionFields,
  windowSizesThatFit,
  type FingerprintProfile,
  type PlatformId,
  type WebrtcMode,
} from "@/lib/schema";
import { useEnclave } from "@/lib/store";

export const Route = createFileRoute("/environments/$id")({ component: EnvDetail });

function EnvDetail() {
  const { id } = Route.useParams();
  const navigate = useNavigate();
  const env = useEnclave((s) => s.environments.find((e) => e.id === id));
  const proxies = useEnclave((s) => s.proxies);
  const runtime = useEnclave((s) => s.runtimes[id]);
  const mayEdit = canEdit(useEnclave((s) => s.session.role));
  const { folders } = useFolders();
  const [tab, setTab] = useState<"overview" | "fingerprint" | "flags" | "timeline">("overview");
  const [collect, setCollect] = useState<{ busy: boolean; note?: string; bad?: boolean }>({ busy: false });

  if (!env) {
    return (
      <div className="p-8 text-subtle">
        这个环境不存在了。<Link to="/" className="text-accent-text underline">回到环境列表</Link>
      </div>
    );
  }

  const proxy = proxies.find((p) => p.id === env.proxyId);
  const checks = staticConsistency(env, proxy, { exitCountry: runtime?.exit?.country, screen: windowBoundsOf(env) });
  const failed = checks.filter((c) => !c.ok && !c.warn);
  const status = runtime?.status ?? "stopped";

  return (
    <div className="mx-auto grid max-w-[1280px] gap-4 px-8 py-6 lg:grid-cols-[1fr_320px]">
      <div className="min-w-0">
        <div className="mb-4 flex flex-wrap items-center gap-3">
          <Button variant="ghost" onClick={() => void navigate({ to: "/" })}>
            <ArrowLeft className="size-3.5" />
            {t("back")}
          </Button>
          <EnvGlyph seed={env.profile.seed} size={44} />
          <h1 className="min-w-0 text-2xl font-bold tracking-[-0.03em] text-ink [overflow-wrap:anywhere]">
            {env.name}
          </h1>
          <Badge tone={status === "running" ? "ok" : status === "error" ? "bad" : "neutral"}>
            {runtimeLabel(status, runtime?.error)}
          </Badge>
          <div className="ml-auto flex gap-2">
            {status === "running" ? (
              <Button onClick={() => void stopEnv(env.id)}>
                <Square className="size-3" />
                {t("stop")}
              </Button>
            ) : (
              <Button
                variant="primary"
                disabled={status === "starting"}
                title={status === "starting" ? t("starting") : undefined}
                onClick={() => void startEnv(env)}
              >
                <Play className="size-3" />
                {status === "starting" ? t("starting") : t("start")}
              </Button>
            )}
            <Button
              onClick={() => {
                void navigate({ to: "/lab", search: { env: env.id } });
              }}
            >
              <FlaskConical className="size-3.5" />
              {t("sendLab")}
            </Button>
          </div>
        </div>

        <div className="mb-3 flex gap-1 border-b border-line">
          {(["overview", "fingerprint", "flags", "timeline"] as const)
            .filter((key) => key !== "flags" || env.engine === "chromium")
            .map((key) => (
            <button
              key={key}
              onClick={() => setTab(key)}
              className={`px-3 py-2 text-[13px] ${tab === key ? "border-b-2 border-accent text-ink" : "text-subtle"}`}
            >
              {t(key === "flags" ? "flags" : key)}
            </button>
          ))}
        </div>

        {tab === "overview" ? (
          <div className="grid gap-3 md:grid-cols-2">
            <Field label={t("name")}>
              <Input
                value={env.name}
                onChange={(e) => useEnclave.getState().patchEnv(env.id, { name: e.target.value })}
                // 官网账号页按名字列出环境，改完名告诉服务器一声。已登记的环境不会再占名额。
                onBlur={() => void registerEnv(env)}
              />
            </Field>
            <Field label={t("folder")} hint={t("folderHint")}>
              <Select
                value={env.folderId}
                disabled={!mayEdit}
                onChange={(e) =>
                  useEnclave.getState().patchEnv(env.id, { folderId: e.target.value })
                }
              >
                {folders.length === 0 ? (
                  <option value={env.folderId}>{env.folderId}</option>
                ) : (
                  folders.map((f) => (
                    <option key={f.id} value={f.id}>
                      {f.name}
                    </option>
                  ))
                )}
              </Select>
            </Field>
            <Field label={t("proxy")}>
              <Select
                value={env.proxyId ?? ""}
                onChange={(e) =>
                  useEnclave.getState().patchEnv(env.id, { proxyId: e.target.value || null })
                }
              >
                <option value="">{t("noProxy")}</option>
                {proxies.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </Select>
            </Field>
            {/* 默认搜索引擎、扩展、额外启动参数都是 Chromium 的机制，Firefox 类没有。 */}
            {env.engine === "chromium" ? (
              <Field label={t("searchEngine")}>
                <EngineSelect envId={env.id} value={env.searchEngine ?? "none"} />
              </Field>
            ) : null}
            <Field
              label={`${t("kernelVersion")}（${ENGINE_META[env.engine].label}）`}
              hint="更换版本后，网站将看到该设备的浏览器版本发生变化"
            >
              <KernelSelect envId={env.id} engine={env.engine} value={env.kernelVersion} disabled={status !== "stopped" && status !== "error"} />
            </Field>
            <Field label={t("note")}>
              <Textarea
                value={env.note}
                onChange={(e) => useEnclave.getState().patchEnv(env.id, { note: e.target.value })}
              />
            </Field>
            {env.engine === "chromium" ? (
              <ExtensionPicker envId={env.id} selected={env.extensionIds} />
            ) : null}
            <Field
              label="登录态"
              hint="名称、指纹与代理配置照常同步；更换电脑后环境仍在，但需重新登录站点"
            >
              <label className="flex items-center gap-2 text-[13px] text-muted">
                <input
                  type="checkbox"
                  className="size-4 accent-[var(--enclave-accent)]"
                  checked={env.localOnly ?? false}
                  onChange={(e) =>
                    useEnclave.getState().patchEnv(env.id, { localOnly: e.target.checked })
                  }
                />
                只留在这台电脑上，不同步
              </label>
            </Field>
            <Panel className="md:col-span-2 p-4">
              <div className="mb-2 text-[13px] font-medium">{t("consistency")}</div>
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
                  {t("pass")}
                </Badge>
              ) : (
                <Badge tone="bad" className="mt-3">
                  {t("fail")}
                </Badge>
              )}
            </Panel>
          </div>
        ) : null}

        {tab === "fingerprint" ? <FingerprintForm envId={env.id} engine={env.engine} profile={env.profile} followExit={env.followExit} /> : null}


        {tab === "flags" ? <FlagsForm envId={env.id} extraFlags={env.extraFlags} allowNoSandbox={env.allowNoSandbox} /> : null}

        {tab === "timeline" ? (
          <ol className="grid gap-2">
            {env.timeline.map((ev, i) => (
              <li key={`${ev.at}-${i}`} className="rounded-md border border-line px-3 py-2 text-[13px]">
                <div className="flex justify-between gap-3">
                  <span className="font-medium">{eventLabel(ev.kind)}</span>
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
          <div className="mb-2 text-sm font-medium">{t("runtime")}</div>
          <p className={runtime?.status === "error" ? "text-sm text-bad" : "text-sm text-subtle"}>
            {runtimeLabel(runtime?.status ?? "stopped", runtime?.error)}
          </p>
          {runtime?.status === "error" && runtime.detail ? (
            <p className="mt-2 text-[13px] text-muted">{runtime.detail}</p>
          ) : null}
          {runtime?.status === "error" && runtime.error ? (
            <p className="app-mono mt-2 text-xs text-subtle">{runtime.error}</p>
          ) : null}
          {runtime?.status === "running" && runtime.exit ? (
            <p className="mt-2 text-[13px] text-muted">
              出口 <span className="app-mono">{runtime.exit.ip}</span>
              {runtime.exit.city || runtime.exit.country
                ? `，${[runtime.exit.country, runtime.exit.city].filter(Boolean).join(" ")}`
                : ""}
            </p>
          ) : null}
          {runtime?.status === "running" ? (
            <p className="app-mono mt-2 text-xs text-subtle">
              pid {runtime.pid}，127.0.0.1:{runtime.debugPort}
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
                  setCollect({ busy: false, note: "采集完成，可前往实验室查看对比。" });
                } catch (err) {
                  setCollect({
                    busy: false,
                    bad: true,
                    note: `采集失败：${err instanceof Error ? err.message : String(err)}`,
                  });
                }
              }}
            >
              {collect.busy ? "采集中…" : t("collectPage")}
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

/** 环境绑定的内核版本。只有用户自己改才会变；画像里的浏览器版本跟着一起改。 */
function KernelSelect({
  envId,
  engine,
  value,
  disabled,
}: {
  envId: string;
  engine: EngineClass;
  value: string;
  disabled: boolean;
}) {
  // 只能在同一类里换版本：换类等于换了另一个浏览器，指纹的给法都不一样。
  const kernels = useKernels().kernels.filter((k) => k.record.engine === engine);
  // 列表为空是因为问不到本机服务，不能因此说这个版本"不在清单里"。
  const listed = kernels.length === 0 || kernels.some((k) => k.record.version === value);
  return (
    <Select
      value={value}
      disabled={disabled}
      title={disabled ? "请先停止该环境，再更换内核" : undefined}
      onChange={(e) => {
        const version = e.target.value;
        const store = useEnclave.getState();
        const env = store.environments.find((x) => x.id === envId);
        if (!env) return;
        store.patchEnv(
          envId,
          { kernelVersion: version, profile: { ...env.profile, brandVersion: version } },
          { at: Date.now(), kind: "kernel", message: `内核 ${value} → ${version}`, level: "warn" },
        );
        store.addAudit({
          action: "kernel_change",
          target: envId,
          level: "warn",
          detail: `${env.name}，${value} → ${version}`,
        });
      }}
    >
      {kernels.length === 0 ? <option value={value}>{value}</option> : null}
      {listed ? null : <option value={value}>{value}（已不在清单里）</option>}
      {kernels.map((k) => (
        <option key={k.record.version} value={k.record.version}>
          {kernelOptionLabel(k)}
        </option>
      ))}
    </Select>
  );
}

function EngineSelect({ envId, value }: { envId: string; value: string }) {
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
      <option value="none">{t("searchEngineNone")}</option>
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

function FingerprintForm({
  envId,
  engine,
  profile,
  followExit,
}: {
  envId: string;
  engine: EngineClass;
  profile: FingerprintProfile;
  followExit: boolean;
}) {
  const patch = (next: Partial<FingerprintProfile>) => {
    useEnclave.getState().patchEnv(envId, { profile: { ...profile, ...next } });
  };
  // 种子只在输入合法时才落库，草稿另存，避免半截输入把环境写坏。
  const [seedDraft, setSeedDraft] = useState(profile.seed);
  const seedBad = !/^\d{1,10}$/.test(seedDraft);
  const firefox = engine === "firefox";
  // Firefox 类：屏幕、缩放、显卡、核数来自同一台真机，成套换，不单独改。只列这台显示器上用得了的。
  const deviceList = firefox ? usableDevices(profile.platform) : [];
  const sameDevice = (d: Device) =>
    d.screen.width === profile.screen?.width &&
    d.screen.height === profile.screen?.height &&
    d.dpr === profile.devicePixelRatio &&
    d.webgl.renderer === profile.webgl?.renderer &&
    d.cores === profile.hardwareConcurrency;
  const deviceIndex = deviceList.findIndex(sameDevice);
  const applyDevice = (d: Device, platform = profile.platform) => {
    const bounds = deviceWindowBounds(d);
    const fits = profile.window.width <= bounds.width && profile.window.height <= bounds.height;
    return {
      platform,
      hardwareConcurrency: d.cores,
      screen: d.screen,
      devicePixelRatio: d.dpr,
      webgl: d.webgl,
      window: fits ? profile.window : windowSizesThatFit(bounds).at(-1)!,
    };
  };
  // 下拉框里只有这个平台上真实存在的配置；环境现有的值（导入的、旧的）不在表里时照样列出来，不会被悄悄改掉。
  const presetCores = [...new Set(CORES_BY_PLATFORM[profile.platform])];
  const cores = presetCores.includes(profile.hardwareConcurrency)
    ? presetCores
    : [profile.hardwareConcurrency, ...presetCores];
  const fitting = windowSizesThatFit(
    firefox && profile.screen && profile.devicePixelRatio
      ? deviceWindowBounds({ screen: profile.screen, dpr: profile.devicePixelRatio })
      : realScreen(),
  );
  const sizes = fitting.some((w) => w.width === profile.window.width && w.height === profile.window.height)
    ? fitting
    : [profile.window, ...fitting];
  const region = regionOfTimezone(profile.timezone);
  const screen = realScreen();
  const dpr = typeof window === "undefined" ? 1 : window.devicePixelRatio;

  return (
    <div className="grid gap-3 md:grid-cols-2">
      <Field
        label={t("seed")}
        hint={profile.seedLocked ? undefined : t("seedHint")}
        error={seedBad ? t("seedBad") : undefined}
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
            {profile.seedLocked ? t("unlockSeed") : t("lockSeed")}
          </Button>
        </div>
      </Field>
      <Field
        label={t("platform")}
        hint={firefox ? undefined : t("platformPinnedHint")}
      >
        {firefox ? (
          <Select
            value={profile.platform}
            onChange={(e) => {
              const platform = e.target.value as PlatformId;
              // 换平台就是换了一台机器：整台设备一起换成新平台上的。
              const next = usableDevices(platform)[0];
              if (next)
                patch({
                  ...applyDevice(next, platform),
                  platformVersion: defaultPlatformVersion(platform),
                });
            }}
          >
            <option value="windows">Windows</option>
            <option value="macos">macOS</option>
            <option value="linux">Linux</option>
          </Select>
        ) : (
          <p className="rounded-md border border-line bg-raised px-3 py-2 text-sm">
            {platformLabel(profile)}
            <span className="ml-2 text-subtle">{t("platformPinned")}</span>
          </p>
        )}
      </Field>
      {/* Firefox 的 UA 里 Windows 10 和 11 都是 "Windows NT 10.0"，这一类选了也没有区别，不出这一项。 */}
      {profile.platform === "windows" && !firefox ? (
        <Field label={t("osVersion")}>
          <Select
            value={windowsEdition(profile.platformVersion)}
            onChange={(e) => patch({ platformVersion: defaultWinVersion(e.target.value as "10" | "11") })}
          >
            <option value="10">{t("win10")}</option>
            <option value="11">{t("win11")}</option>
          </Select>
          <p className="text-xs text-subtle">{t("osHint")}</p>
        </Field>
      ) : null}
      {firefox ? (
        <Field
          label="设备"
          hint={`屏幕、缩放、显卡、核数来自同一台真机，成套换。只列出这台显示器上用得了的（${deviceList.length} 台）`}
        >
          <Select
            value={deviceIndex}
            onChange={(e) => {
              const next = deviceList[Number(e.target.value)];
              if (next) patch(applyDevice(next));
            }}
          >
            {deviceIndex < 0 && profile.screen ? (
              <option value={-1}>
                {profile.screen.width}×{profile.screen.height}
                {profile.devicePixelRatio === 1 ? "" : ` @${profile.devicePixelRatio}x`}，{profile.hardwareConcurrency} 核（不在可选设备里）
              </option>
            ) : null}
            {deviceList.map((d, index) => (
              <option key={index} value={index}>
                {deviceLabel(d)}
              </option>
            ))}
          </Select>
        </Field>
      ) : (
        <>
          <Field label={t("brand")}>
            <Select
              value={profile.brand}
              onChange={(e) => patch({ brand: e.target.value as FingerprintProfile["brand"] })}
            >
              {["Chrome", "Edge", "Opera", "Vivaldi"].map((b) => (
                <option key={b}>{b}</option>
              ))}
            </Select>
          </Field>
          <Field label={t("cores")}>
            <Select
              value={profile.hardwareConcurrency}
              onChange={(e) => patch({ hardwareConcurrency: Number(e.target.value) })}
            >
              {cores.map((n) => (
                <option key={n}>{n}</option>
              ))}
            </Select>
          </Field>
          <Field
            label="Canvas"
            hint="两种策略各有适用场景：加噪声让每个环境的 Canvas 互不相同，保持真实则更接近普通用户。"
          >
            <Select
              value={profile.disableSpoofing.includes("canvas") ? "real" : "noise"}
              onChange={(e) =>
                patch({
                  disableSpoofing:
                    e.target.value === "real"
                      ? [...new Set([...profile.disableSpoofing, "canvas"])]
                      : profile.disableSpoofing.filter((x) => x !== "canvas"),
                })
              }
            >
              <option value="noise">加噪声（每个环境不同，跟着种子走，重启不变）</option>
              <option value="real">真实（这台电脑的；同一台电脑上选了真实的环境彼此相同）</option>
            </Select>
          </Field>
        </>
      )}
      <Field
        label="地理位置"
        hint={
          profile.geolocation.mode === "exit"
            ? "网站请求定位时，返回代理出口所在的位置；未配置代理时返回本机真实位置"
            : profile.geolocation.mode === "blocked"
              ? "网站无法获取位置，效果等同于拒绝授权"
              : profile.geolocation.mode === "real"
                ? "网站将获取本机的真实位置"
                : "无论代理位于何处，均返回此处填写的位置"
        }
      >
        <Select
          value={profile.geolocation.mode}
          onChange={(e) => {
            const mode = e.target.value;
            patch({
              geolocation:
                mode === "custom"
                  ? { mode: "custom", latitude: 0, longitude: 0 }
                  : { mode: mode as "exit" | "real" | "blocked" },
            });
          }}
        >
          <option value="exit">跟着代理出口走（推荐）</option>
          <option value="custom">自己填经纬度</option>
          <option value="blocked">禁用：不让网站拿到位置</option>
          <option value="real">用这台电脑真实的位置</option>
        </Select>
      </Field>
      {profile.geolocation.mode === "custom" ? (
        <Field label="经纬度" hint="纬度 -90～90，经度 -180～180">
          <div className="flex gap-2">
            <Input
              type="number"
              step="0.0001"
              value={profile.geolocation.latitude}
              onChange={(e) =>
                patch({
                  geolocation: {
                    mode: "custom",
                    latitude: Number(e.target.value),
                    longitude:
                      profile.geolocation.mode === "custom" ? profile.geolocation.longitude : 0,
                  },
                })
              }
            />
            <Input
              type="number"
              step="0.0001"
              value={profile.geolocation.longitude}
              onChange={(e) =>
                patch({
                  geolocation: {
                    mode: "custom",
                    latitude:
                      profile.geolocation.mode === "custom" ? profile.geolocation.latitude : 0,
                    longitude: Number(e.target.value),
                  },
                })
              }
            />
          </div>
        </Field>
      ) : null}
      <Field
        label="地区"
        hint={
          followExit
            ? "启动时按代理出口所在国家设置时区与语言；未配置代理或无法识别时，使用此处选择的地区"
            : "时区与语言需成对设置：时区在东京而语言为英语，是最常被检测到的矛盾之一"
        }
      >
        <Select
          value={region?.country ?? ""}
          disabled={followExit}
          onChange={(e) => {
            const next = REGIONS.find((r) => r.country === e.target.value);
            if (next) patch(regionFields(next));
          }}
        >
          {region ? null : <option value="">{profile.timezone}（不在预设里）</option>}
          {REGIONS.map((r) => (
            <option key={r.country} value={r.country}>
              {r.name}
            </option>
          ))}
        </Select>
        <span className="flex items-center gap-2 text-[13px] text-muted">
          <input
            type="checkbox"
            className="size-4 accent-[var(--enclave-accent)]"
            checked={followExit}
            onChange={(e) => useEnclave.getState().patchEnv(envId, { followExit: e.target.checked })}
          />
          时区和语言跟着代理出口走
        </span>
      </Field>
      <Field label={t("timezone")} hint={`语言 ${profile.languages.join("、")}`}>
        <Select
          value={profile.timezone}
          disabled={followExit || !region || region.timezones.length < 2}
          onChange={(e) => patch({ timezone: e.target.value })}
        >
          {(region?.timezones ?? [profile.timezone]).map((tz) => (
            <option key={tz}>{tz}</option>
          ))}
        </Select>
      </Field>
      <Field label={t("webrtc")}>
        <Select
          value={profile.webrtc.mode}
          onChange={(e) => patch({ webrtc: { mode: e.target.value as WebrtcMode } })}
        >
          <option value="replace">{t("webrtcReplace")}</option>
          <option value="disable">{t("webrtcDisable")}</option>
        </Select>
        <p className="text-xs text-subtle">{t("webrtcHint")}</p>
      </Field>
      <Field
        label="窗口大小"
        hint={firefox ? "仅列出同时适配该环境屏幕与本机显示器（按缩放折算）的尺寸" : "仅列出适配本机屏幕的尺寸"}
      >
        <Select
          value={`${profile.window.width}x${profile.window.height}`}
          onChange={(e) => {
            const [width, height] = e.target.value.split("x").map(Number);
            patch({ window: { width: width!, height: height! } });
          }}
        >
          {sizes.map((w) => (
            <option key={`${w.width}x${w.height}`} value={`${w.width}x${w.height}`}>
              {w.width} × {w.height}
            </option>
          ))}
        </Select>
      </Field>
      <div className="md:col-span-2 rounded-md border border-line px-4 py-3 text-[13px] leading-relaxed text-muted">
        <p className="font-semibold text-ink">哪些是这个环境独有的，哪些来自这台电脑</p>
        {firefox ? (
          <>
            <p className="mt-1">
              由内核按环境生效：平台、核数、屏幕{profile.screen ? `（${profile.screen.width} × ${profile.screen.height}）` : ""}
              、缩放{profile.devicePixelRatio ? `（${profile.devicePixelRatio}）` : ""}、显卡字符串、地区、WebRTC、字体名单，以及由种子决定的字体间距。
              缩放是真的缩放——页面会按这个比例显示，这样网站用媒体查询去量也对得上。
            </p>
            <p className="mt-1">
              Canvas 不加噪声：同一台电脑上所有 Firefox 类环境的像素级 Canvas 指纹相同（上游认为像素噪声本身会被识别，已经去掉）。
              每次启动 toDataURL 的哈希会变，那是 Firefox 自己的保护，真实用户也一样。需要 Canvas 噪声就用 Chromium 类。
            </p>
          </>
        ) : (
          <>
            <p className="mt-1">
              上面这些由内核按环境生效：平台、系统版本、浏览器、核数、地区、WebRTC，以及由种子决定的
              Canvas、文字测量（字体）、ClientRects 的噪声和内存大小。
            </p>
            <p className="mt-1">
              屏幕分辨率和缩放来自这台电脑，内核改不了
              {screen ? `（现在是 ${window.screen.width} × ${window.screen.height}，缩放 ${dpr}）` : ""}
              ：同一台电脑上的所有环境，网站看到的屏幕是同一个。要按环境给屏幕和显卡，用 Firefox 类。
            </p>
          </>
        )}
      </div>
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
  const [draft, setDraft] = useState(extraFlags.join("\n"));
  const flags = useMemo(() => draft.split(/\s+/).filter(Boolean), [draft]);
  // 判定来自本机服务（启动时用的就是同一份规则）。checkedFor 记着这份判定对应的是哪一版输入：
  // 输入变了、新的判定还没回来时不能保存。
  const [verdict, setVerdict] = useState<{ checkedFor: string; flags: ClassifiedFlag[] | null }>({
    checkedFor: "",
    flags: [],
  });
  const key = flags.join("\n");
  useEffect(() => {
    let alive = true;
    const timer = window.setTimeout(() => {
      void classifyFlags(flags).then((result) => alive && setVerdict({ checkedFor: key, flags: result }));
    }, 200);
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, [flags, key]);
  const checked = verdict.checkedFor === key;
  const classified = checked ? (verdict.flags ?? []) : [];
  const unreachable = checked && verdict.flags === null;
  const rejected = classified.filter((f) => f.cls === "reject").length;
  const dirty = key !== extraFlags.join("\n");
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
                message: e.target.checked ? "允许无沙箱启动" : "取消无沙箱启动",
                level: e.target.checked ? "warn" : "info",
              },
            );
            useEnclave.getState().addAudit({
              action: "sandbox_flag",
              target: envId,
              level: e.target.checked ? "warn" : "info",
              detail: e.target.checked ? "允许 --no-sandbox" : "已撤销",
            });
          }}
        />
        {t("noSandboxFlag")}
      </label>
      <Field label={t("extraFlags")}>
        <Textarea value={draft} onChange={(e) => setDraft(e.target.value)} />
      </Field>
      <p className="text-[13px] text-subtle">{t("extraFlagsHint")}</p>
      <ul className="grid gap-1 text-[13px]">
        {classified.map((f) => (
          <li key={f.raw} className="flex justify-between gap-2 border-b border-line py-1">
            <span className="font-mono">{f.raw}</span>
            <span className={f.cls === "reject" ? "text-bad" : f.cls === "warn" ? "text-warn" : "text-ok"}>
              {t(f.cls === "reject" ? "rejected" : f.cls === "warn" ? "warn" : "allowed")}，{f.reason}
            </span>
          </li>
        ))}
      </ul>
      {rejected ? (
        <p className="text-[13px] text-bad">有 {rejected} 个参数不允许，删掉才能保存。</p>
      ) : null}
      {unreachable ? (
        <p className="text-[13px] text-bad">无法连接本机服务，暂时无法校验这些参数，保存已停用。</p>
      ) : null}
      <div className="flex items-center gap-3">
        <Button
          disabled={!dirty || !checked || unreachable || rejected > 0}
          onClick={() => {
            useEnclave.getState().patchEnv(
              envId,
              { extraFlags: flags },
              { at: Date.now(), kind: "flag", message: "启动参数已更新", level: "info" },
            );
          }}
        >
          {t("save")}
        </Button>
        {!dirty && extraFlags.length ? (
          <span className="text-[13px] text-subtle">已保存，重新启动后生效。</span>
        ) : null}
      </div>
    </div>
  );
}


