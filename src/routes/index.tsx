import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { AppWindow, Boxes, Play, Plus, Square, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";
import {
  Button,
  Dialog,
  DialogContent,
  Empty,
  Field,
  Input,
  Panel,
  PageHeader,
  Select,
  StatusDot,
} from "@/components/ui";
import { purgeEnv, startEnv, stopEnv, trashEnv } from "@/lib/host";
import { runtimeLabel, t } from "@/lib/i18n";
import { engineToProvider, findEngine } from "@/lib/engines";
import { kernelOptionLabel, useKernels } from "@/lib/kernel/use-kernels";
import { envCount } from "@/lib/license/plans";
import { defaultPlatformVersion, platformLabel } from "@/lib/os";
import {
  BUNDLED_KERNEL_VERSION,
  TIMEZONES,
  newEnvironment,
  profileFromSeed,
  randomSeed,
  type PlatformId,
} from "@/lib/schema";
import { useEnclave } from "@/lib/store";

export const Route = createFileRoute("/")({ component: EnvironmentsPage });

/**
 * 环境数到上限了吗。到了就弹升级提示并记审计。
 * 新建、向导最后一步、从回收站恢复 —— 所有让活动环境 +1 的路径都走这一个检查。
 */
function atEnvLimit(): boolean {
  const store = useEnclave.getState();
  const limits = store.account.limits;
  if (envCount(store.environments) < limits.envLimit) return false;
  store.setPlanNotice({
    title: "环境数量已达上限",
    body: `${limits.label} 最多 ${limits.envLimit} 个环境。删掉不用的，或者升级档位。`,
  });
  store.addAudit({
    action: "create_blocked",
    level: "warn",
    detail: `${limits.label} 最多 ${limits.envLimit} 个环境`,
  });
  return true;
}

function EnvironmentsPage() {
  const navigate = useNavigate();
  const environments = useEnclave((s) => s.environments);
  const limits = useEnclave((s) => s.account.limits);
  const runtimes = useEnclave((s) => s.runtimes);
  const proxies = useEnclave((s) => s.proxies);
  const [query, setQuery] = useState("");
  const [trash, setTrash] = useState(false);
  const [wizard, setWizard] = useState(false);
  const [purging, setPurging] = useState<{ id: string; name: string; error?: string } | null>(null);

  const live = useMemo(() => environments.filter((e) => !e.deletedAt), [environments]);
  const runningNow = Object.values(runtimes).filter((r) => r.status === "running").length;

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    return environments.filter((e) => {
      if (trash !== Boolean(e.deletedAt)) return false;
      if (!q) return true;
      return `${e.name} ${e.group} ${e.tags.join(" ")} ${e.profile.platform}`
        .toLowerCase()
        .includes(q);
    });
  }, [environments, query, trash]);

  const tryCreate = () => {
    if (!atEnvLimit()) setWizard(true);
  };

  return (
    <div className="mx-auto max-w-[1280px] px-8 py-6">
      <PageHeader
        title={t("navEnv")}
        status={`${live.length} / ${limits.envLimit} 个环境 · ${runningNow} / ${limits.concurrent} 个运行中 · ${limits.label}`}
        actions={
          <>
            <Button onClick={() => setTrash((v) => !v)}>
              {trash ? t("navEnv") : t("trash")}
            </Button>
            {live.length > 0 ? (
              <Button variant="primary" onClick={tryCreate}>
                <Plus className="size-3.5" />
                {t("newEnv")}
              </Button>
            ) : null}
          </>
        }
      />

      {live.length > 0 || trash ? (
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t("search")}
          className="mb-4 max-w-sm"
        />
      ) : null}

      <Panel className="overflow-hidden">
        {rows.length === 0 && query.trim() ? (
          <Empty
            title={t("noMatch")}
            body={`没有名字、分组或标签里带「${query.trim()}」的环境。`}
            action={<Button onClick={() => setQuery("")}>清除搜索</Button>}
          />
        ) : rows.length === 0 ? (
          <Empty
            icon={<Boxes className="size-8" />}
            title={trash ? "回收站是空的" : t("emptyEnv")}
            body={trash ? "删掉的环境会先进这里，可以恢复或彻底销毁。" : t("emptyEnvHint")}
            action={
              trash ? undefined : (
                <Button variant="primary" onClick={tryCreate}>
                  {t("newEnv")}
                </Button>
              )
            }
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="app-table min-w-[820px]">
              <thead>
                <tr>
                  <th>{t("name")}</th>
                  <th>{t("platform")}</th>
                  <th>{t("proxy")}</th>
                  <th>{t("statusCol")}</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows.map((env) => {
                  const rt = runtimes[env.id];
                  const status = rt?.status ?? "stopped";
                  const tone =
                    status === "running"
                      ? "ok"
                      : status === "error"
                        ? "bad"
                        : status === "starting"
                          ? "warn"
                          : "idle";
                  return (
                    <tr key={env.id}>
                      <td className="wrap">
                        <Link
                          to="/environments/$id"
                          params={{ id: env.id }}
                          className="font-medium text-ink hover:text-accent"
                        >
                          {env.name}
                        </Link>
                        <div className="text-xs text-subtle">{env.group}</div>
                      </td>
                      <td>
                        <span className="inline-flex items-center gap-2">
                          <AppWindow className="size-4 text-faint" />
                          {platformLabel(env.profile)}
                        </span>
                      </td>
                      <td className="text-subtle">
                        {proxies.find((p) => p.id === env.proxyId)?.name ?? t("noProxy")}
                      </td>
                      <td>
                        <span className="inline-flex items-center gap-2">
                          <StatusDot tone={tone} />
                          <span
                            className={status === "error" ? "text-bad" : undefined}
                            title={rt?.detail}
                          >
                            {runtimeLabel(status, rt?.error)}
                          </span>
                        </span>
                      </td>
                      <td>
                        <div className="flex justify-end gap-1.5">
                          {trash ? (
                            <>
                              <Button
                                onClick={() => {
                                  if (!atEnvLimit()) useEnclave.getState().restoreEnv(env.id);
                                }}
                              >
                                {t("restore")}
                              </Button>
                              <Button
                                variant="danger"
                                onClick={() => setPurging({ id: env.id, name: env.name })}
                              >
                                {t("destroy")}
                              </Button>
                            </>
                          ) : (
                            <>
                              {status === "running" ? (
                                <Button onClick={() => void stopEnv(env.id)}>
                                  <Square className="size-3" />
                                  {t("stop")}
                                </Button>
                              ) : (
                                <Button
                                  disabled={status === "starting"}
                                  title={status === "starting" ? t("starting") : undefined}
                                  onClick={() => void startEnv(env)}
                                >
                                  <Play className="size-3 text-accent" />
                                  {status === "starting" ? t("starting") : t("start")}
                                </Button>
                              )}
                              <Button
                                variant="ghost"
                                size="icon"
                                title={t("trash")}
                                onClick={() => void trashEnv(env.id)}
                              >
                                <Trash2 className="size-3.5" />
                              </Button>
                            </>
                          )}
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

      {rows.some((r) => runtimes[r.id]?.error?.startsWith("KERNEL_")) ? (
        <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-warn/30 bg-warn/10 px-4 py-3 text-[13px] text-warn">
          <span>{t("kernelNeed")}</span>
          <Link to="/kernels" className="font-semibold underline">
            {t("goKernels")}
          </Link>
        </div>
      ) : null}

      {purging ? (
        <Dialog open onOpenChange={(o) => !o && setPurging(null)}>
          <DialogContent title={`彻底删除「${purging.name}」`}>
            <p className="text-sm text-muted">
              这个环境的 Cookie、登录态和缓存会从磁盘上删掉，无法恢复。
            </p>
            {purging.error ? <p className="mt-3 text-[13px] text-bad">{purging.error}</p> : null}
            <div className="mt-6 flex justify-end gap-2">
              <Button onClick={() => setPurging(null)}>{t("cancel")}</Button>
              <Button
                variant="danger"
                onClick={async () => {
                  const res = await purgeEnv(purging.id);
                  if (res.ok) setPurging(null);
                  else setPurging({ ...purging, error: res.message ?? "删除失败。" });
                }}
              >
                {t("destroy")}
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      ) : null}

      {wizard ? (
        <CreateWizard
          onClose={() => setWizard(false)}
          onCreated={(id) => {
            setWizard(false);
            void navigate({ to: "/environments/$id", params: { id } });
          }}
        />
      ) : null}
    </div>
  );
}

function CreateWizard({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const proxies = useEnclave((s) => s.proxies);
  const allEnvs = useEnclave((s) => s.environments);
  const existing = useMemo(() => allEnvs.filter((e) => !e.deletedAt), [allEnvs]);
  const catalog = useEnclave((s) => s.searchCatalog) ?? [];

  const [step, setStep] = useState(0);
  const [source, setSource] = useState<"blank" | "copy">("blank");
  const [name, setName] = useState("");
  const [group, setGroup] = useState("default");
  const [platform, setPlatform] = useState<PlatformId>("windows");
  const [winEdition, setWinEdition] = useState<"10" | "11">("11");
  const [engineId, setEngineId] = useState("none");
  const [timezone, setTimezone] = useState("America/Los_Angeles");
  const [proxyId, setProxyId] = useState("");
  const [copyId, setCopyId] = useState("");
  const [error, setError] = useState("");
  // 没选过就用默认版本；问不到本机服务时退回安装包自带的那个。
  const { kernels, defaultVersion } = useKernels();
  const [pickedKernel, setPickedKernel] = useState<string | null>(null);
  const kernelVersion = pickedKernel ?? defaultVersion ?? BUNDLED_KERNEL_VERSION;

  const create = () => {
    try {
      if (!name.trim()) {
        setError("请先填写环境名称。");
        setStep(1);
        return;
      }
      if (atEnvLimit()) {
        onClose();
        return;
      }
      const store = useEnclave.getState();
      if (source === "copy") {
        if (!copyId) {
          setError("请选择要复制的环境。");
          setStep(1);
          return;
        }
        const src = existing.find((e) => e.id === copyId);
        if (!src) return;
        // 复制的是设置，不是身份：种子必须是新的，否则两个环境指纹完全相同、可被关联。
        // --no-sandbox 的同意是逐环境给的，不跟着复制。
        const copy = {
          ...newEnvironment({
            name: name.trim(),
            group,
            tags: [...src.tags],
            note: src.note,
            proxyId: proxyId || null,
            profile: {
              ...src.profile,
              seed: randomSeed(),
              seedLocked: true,
              timezone,
              brandVersion: kernelVersion,
            },
            kernelVersion,
            searchEngine: src.searchEngine,
            searchProvider: src.searchProvider,
            extensionIds: [...src.extensionIds],
          }),
          extraFlags: [...src.extraFlags],
        };
        copy.timeline[0] = { at: Date.now(), kind: "created", message: `复制自 ${src.name}`, level: "info" };
        store.upsertEnv(copy);
        store.addAudit({ action: "create_env", target: copy.id, level: "info", detail: `${copy.name} ← ${src.name}` });
        onCreated(copy.id);
        return;
      }
      const engine = findEngine(Array.isArray(catalog) ? catalog : [], engineId);
      const env = newEnvironment({
        name: name.trim(),
        group,
        proxyId: proxyId || null,
        profile: profileFromSeed(randomSeed(), platform, {
          timezone,
          platformVersion: defaultPlatformVersion(platform, winEdition),
          // 画像报的浏览器版本必须和真正跑的内核一致，否则 UA 和内核特征对不上。
          brandVersion: kernelVersion,
        }),
        kernelVersion,
        searchEngine: engine?.id ?? "none",
        searchProvider: engine ? engineToProvider(engine) : undefined,
      });
      env.timeline[0] = {
        at: Date.now(),
        kind: "created",
        message: "已创建",
        level: "info",
      };
      store.upsertEnv(env);
      store.addAudit({ action: "create_env", target: env.id, level: "info", detail: env.name });
      onCreated(env.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const steps = [t("step1"), t("step2"), t("step3")];

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent title={t("createTitle")}>
        <div className="mb-5 flex items-center gap-2">
          {steps.map((label, i) => (
            <span
              key={label}
              className={
                i === step
                  ? "rounded-full bg-accent px-3 py-1 text-xs font-semibold text-accent-fg"
                  : "rounded-full bg-surface-2 px-3 py-1 text-xs font-medium text-subtle"
              }
            >
              {i + 1} {label}
            </span>
          ))}
        </div>

        {step === 0 ? (
          <div className="grid grid-cols-2 gap-2">
            {(
              [
                ["blank", t("blank")],
                ["copy", t("fromCopy")],
              ] as const
            ).map(([id, label]) => (
              <button
                key={id}
                type="button"
                onClick={() => setSource(id)}
                className={
                  source === id
                    ? "rounded-lg border border-accent bg-surface-2 px-3 py-4 text-left text-sm text-ink"
                    : "rounded-lg border border-line bg-surface px-3 py-4 text-left text-sm text-muted hover:bg-surface-2"
                }
              >
                {label}
              </button>
            ))}
          </div>
        ) : null}

        {step === 1 ? (
          <div className="grid gap-4">
            <Field label={t("name")}>
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={"例如 shop-us-01"}
                required
              />
            </Field>
            <Field label={t("group")}>
              <Input value={group} onChange={(e) => setGroup(e.target.value)} />
            </Field>
            {source === "copy" ? (
              <Field label={t("fromCopy")}>
                <Select
                  value={copyId}
                  onChange={(e) => {
                    setCopyId(e.target.value);
                    // 下一步的时区和代理先带上原环境的，用户可以再改。
                    const src = existing.find((x) => x.id === e.target.value);
                    if (!src) return;
                    setPickedKernel(src.kernelVersion);
                    setGroup(src.group);
                    setTimezone(src.profile.timezone);
                    setProxyId(src.proxyId ?? "");
                  }}
                >
                  <option value="">—</option>
                  {existing.map((e) => (
                    <option key={e.id} value={e.id}>
                      {e.name}
                    </option>
                  ))}
                </Select>
              </Field>
            ) : (
              <>
                <Field label={t("platform")}>
                  <Select
                    value={platform}
                    onChange={(e) => setPlatform(e.target.value as PlatformId)}
                  >
                    <option value="windows">Windows</option>
                    <option value="macos">macOS</option>
                    <option value="linux">Linux</option>
                  </Select>
                </Field>
                {platform === "windows" ? (
                  <Field label={t("osVersion")} hint={t("osHint")}>
                    <Select
                      value={winEdition}
                      onChange={(e) => setWinEdition(e.target.value as "10" | "11")}
                    >
                      <option value="10">{t("win10")}</option>
                      <option value="11">{t("win11")}</option>
                    </Select>
                  </Field>
                ) : null}
                <Field label={t("searchEngine")}>
                  <Select value={engineId} onChange={(e) => setEngineId(e.target.value)}>
                    <option value="none">{t("searchEngineNone")}</option>
                    {catalog.map((engine) => (
                      <option key={engine.id} value={engine.id}>
                        {engine.name}
                      </option>
                    ))}
                  </Select>
                </Field>
              </>
            )}
          </div>
        ) : null}

        {step === 2 ? (
          <div className="grid gap-4">
            <Field label={t("timezone")}>
              <Select value={timezone} onChange={(e) => setTimezone(e.target.value)}>
                {TIMEZONES.map((tz) => (
                  <option key={tz} value={tz}>
                    {tz}
                  </option>
                ))}
              </Select>
            </Field>
            <Field
              label={t("kernelVersion")}
              hint={
                kernels.find((k) => k.record.version === kernelVersion)?.status.state === "admitted"
                  ? undefined
                  : "这个版本还没下载，启动前要先到内核页下载"
              }
            >
              <Select value={kernelVersion} onChange={(e) => setPickedKernel(e.target.value)}>
                {kernels.length === 0 ? <option>{kernelVersion}</option> : null}
                {kernels.map((k) => (
                  <option key={k.record.version} value={k.record.version}>
                    {kernelOptionLabel(k)}
                  </option>
                ))}
              </Select>
            </Field>
            <Field
              label={t("proxy")}
              hint={proxies.length ? undefined : "还没有代理。可以先建环境，之后在网络页加。"}
            >
              <Select value={proxyId} onChange={(e) => setProxyId(e.target.value)}>
                <option value="">{t("noProxy")}</option>
                {proxies.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
        ) : null}

        {error ? <p className="mt-4 text-[13px] text-bad">{error}</p> : null}

        <div className="mt-6 flex justify-between">
          <Button type="button" onClick={step === 0 ? onClose : () => setStep((s) => s - 1)}>
            {step === 0 ? t("cancel") : t("back")}
          </Button>
          {step < 2 ? (
            <Button
              type="button"
              variant="primary"
              onClick={() => {
                if (step === 1 && !name.trim()) {
                  setError("请先填写环境名称。");
                  return;
                }
                if (step === 1 && source === "copy" && !copyId) {
                  setError("请选择要复制的环境。");
                  return;
                }
                setError("");
                setStep((s) => s + 1);
              }}
            >
              {t("next")}
            </Button>
          ) : (
            <Button type="button" variant="primary" onClick={create}>
              {t("create")}
            </Button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
