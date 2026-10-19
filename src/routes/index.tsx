import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { BatchBar } from "@/components/batch-bar";
import { DEFAULT_FOLDER, folderName, useFolders } from "@/lib/folders";
import { FolderBar } from "@/components/folder-bar";
import { Boxes, Play, Plus, Search, Square, Trash2 } from "lucide-react";
import { EnvGlyph } from "@/components/env-glyph";
import { useEffect, useMemo, useState } from "react";
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
import { purgeEnv, registerEnv, restoreEnv, startEnv, stopEnv, trashEnv } from "@/lib/host";
import { runtimeLabel, t } from "@/lib/i18n";
import { engineToProvider, findEngine } from "@/lib/engines";
import { ENGINE_CLASSES, ENGINE_META } from "@/lib/engines-meta";
import type { EngineClass } from "@/lib/kernel/host-api";
import { kernelOptionLabel, useKernels } from "@/lib/kernel/use-kernels";
import { canEdit, limitText } from "@/lib/session";
import { defaultPlatformVersion, platformLabel, thisPlatform } from "@/lib/os";
import { REGIONS, regionOfCountry, regionOfTimezone } from "@/lib/regions";
import {
  BUNDLED_KERNEL_VERSION,
  newEnvironment,
  profileFromSeed,
  regionFields,
  randomSeed,
  type PlatformId,
} from "@/lib/schema";
import { useEnclave } from "@/lib/store";

export const Route = createFileRoute("/")({ component: EnvironmentsPage });

function EnvironmentsPage() {
  const navigate = useNavigate();
  const environments = useEnclave((s) => s.environments);
  const plan = useEnclave((s) => s.session.plan);
  const role = useEnclave((s) => s.session.role);
  const runtimes = useEnclave((s) => s.runtimes);
  const proxies = useEnclave((s) => s.proxies);
  const [query, setQuery] = useState("");
  const [trash, setTrash] = useState(false);
  const [wizard, setWizard] = useState(false);
  const [purging, setPurging] = useState<{ id: string; name: string; error?: string } | null>(null);
  const [trashing, setTrashing] = useState<{ id: string; name: string } | null>(null);
  // 批量选中的环境。换搜索、进出回收站都清空——选了看不见的东西最容易出事。
  const [picked, setPicked] = useState<string[]>([]);
  const { folders, reload: reloadFolders } = useFolders();
  const [folderFilter, setFolderFilter] = useState("");
  const [restoreNote, setRestoreNote] = useState<{ id: string; message: string } | null>(null);

  const live = useMemo(() => environments.filter((e) => !e.deletedAt), [environments]);
  const runningNow = Object.values(runtimes).filter((r) => r.status === "running").length;

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    return environments.filter((e) => {
      if (trash !== Boolean(e.deletedAt)) return false;
      if (folderFilter && e.folderId !== folderFilter) return false;
      if (!q) return true;
      return `${e.name} ${folderName(folders, e.folderId)} ${e.tags.join(" ")} ${e.profile.platform}`
        .toLowerCase()
        .includes(q);
    });
  }, [environments, query, trash, folderFilter, folders]);

  useEffect(() => {
    setPicked([]);
  }, [query, trash, folderFilter]);

  useEffect(() => {
    const open = () => {
      if (sessionStorage.getItem("enclave-create") !== "1") return;
      sessionStorage.removeItem("enclave-create");
      if (canEdit(useEnclave.getState().session.role)) setWizard(true);
    };
    open();
    window.addEventListener("enclave-create", open);
    return () => window.removeEventListener("enclave-create", open);
  }, []);

  // 芯片上的数量来自服务器登记。环境在第一次启动时才登记上，所以环境数或运行数一变就重取，
  // 不然刚跑完流程还显示「默认 0」。
  useEffect(() => {
    void reloadFolders();
  }, [live.length, runningNow, reloadFolders]);

  const tryCreate = () => {
    setWizard(true);
  };

  // 团队里的操作员只能打开分配给他的环境，建不了新的。本机服务和服务器各自还会再拒一次。
  const mayEdit = canEdit(role);

  return (
    <div className="mx-auto max-w-[1280px] px-4 py-5 sm:px-8 sm:py-6">
      <PageHeader
        title={t("navEnv")}
        status={`${live.length} / ${limitText(plan, (p) => p.envLimit)} 个环境，${runningNow} / ${limitText(plan, (p) => p.concurrent)} 个运行中${plan ? `，${plan.label}` : ""}`}
        actions={
          <>
            <Button
              onClick={() => {
                if (!trash) setFolderFilter("");
                setTrash((v) => !v);
              }}
            >
              {trash ? t("navEnv") : t("trash")}
            </Button>
            {live.length > 0 && mayEdit ? (
              <Button variant={picked.length > 0 && !trash ? "secondary" : "primary"} onClick={tryCreate}>
                <Plus className="size-3.5" />
                {t("newEnv")}
              </Button>
            ) : null}
          </>
        }
      />

      {live.length > 0 || trash ? (
        <div className="relative mb-4 max-w-sm">
          <Search
            className="pointer-events-none absolute top-1/2 left-3 size-3.5 -translate-y-1/2 text-faint"
            aria-hidden="true"
          />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("searchList")}
            aria-label={t("searchList")}
            className="pl-9"
          />
        </div>
      ) : null}

      {!trash ? (
        <FolderBar
          folders={folders}
          picked={folderFilter}
          onPick={setFolderFilter}
          onChanged={reloadFolders}
          mayEdit={mayEdit}
        />
      ) : null}

      {!trash && rows.length > 0 ? (
        <BatchBar selected={picked} environments={live} onClear={() => setPicked([])} />
      ) : null}

      <Panel className="overflow-hidden">
        {rows.length === 0 && query.trim() ? (
          <Empty
            title={t("noMatch")}
            body={`没有名称、文件夹、标签或平台里带「${query.trim()}」的环境。`}
            action={<Button onClick={() => setQuery("")}>清除搜索</Button>}
          />
        ) : rows.length === 0 && folderFilter && !trash ? (
          <Empty
            title="这个文件夹里没有环境"
            body="换一个文件夹，或显示全部。"
            action={<Button onClick={() => setFolderFilter("")}>显示全部</Button>}
          />
        ) : rows.length === 0 ? (
          <Empty
            icon={<Boxes className="size-8" />}
            title={trash ? "回收站为空" : mayEdit ? t("emptyEnv") : "尚未分配环境"}
            body={
              trash
                ? "删除的环境会先放在这里。可以恢复，也可以彻底删除。"
                : mayEdit
                  ? t("emptyEnvHint")
                  : "当前角色为操作员。团队所有者分配环境后，将在此处显示。"
            }
            action={
              trash || !mayEdit || live.length > 0 ? undefined : (
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
                  {trash ? null : (
                    <th className="w-10">
                      <input
                        type="checkbox"
                        aria-label="全选"
                        className="size-4 accent-[var(--enclave-accent)]"
                        checked={picked.length > 0 && picked.length === rows.length}
                        ref={(el) => {
                          // 选了一部分时显示成"半选"，比打勾更贴近实际。
                          if (el)
                            el.indeterminate = picked.length > 0 && picked.length < rows.length;
                        }}
                        onChange={(e) => setPicked(e.target.checked ? rows.map((r) => r.id) : [])}
                      />
                    </th>
                  )}
                  <th>{t("name")}</th>
                  <th>{t("platform")}</th>
                  <th>{t("kernelVersion")}</th>
                  <th>{t("proxy")}</th>
                  <th>{t("statusCol")}</th>
                  <th className="pin-end" />
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
                    <tr key={env.id} data-running={status === "running"}>
                      {trash ? null : (
                        <td>
                          <input
                            type="checkbox"
                            aria-label={`选择 ${env.name}`}
                            className="size-4 accent-[var(--enclave-accent)]"
                            checked={picked.includes(env.id)}
                            onChange={(e) =>
                              setPicked((old) =>
                                e.target.checked
                                  ? [...old, env.id]
                                  : old.filter((id) => id !== env.id),
                              )
                            }
                          />
                        </td>
                      )}
                      <td className="wrap">
                        <div className="flex items-center gap-3">
                          <EnvGlyph seed={env.profile.seed} />
                          <div className="min-w-0">
                            <Link
                              to="/environments/$id"
                              params={{ id: env.id }}
                              className="font-semibold text-ink underline-offset-4 hover:text-accent-text hover:underline"
                            >
                              {env.name}
                            </Link>
                            <div className="text-[13px] text-subtle">
                              {folderName(folders, env.folderId)}
                            </div>
                          </div>
                        </div>
                      </td>
                      <td>{platformLabel(env.profile)}</td>
                      <td>{env.kernelVersion.split(".")[0]}</td>
                      <td className="text-subtle">
                        {proxies.find((p) => p.id === env.proxyId)?.name ?? t("noProxy")}
                        {rt?.exit ? (
                          <div className="text-[13px] text-accent-text">
                            {[rt.exit.country, rt.exit.city].filter(Boolean).join(" ") ||
                              rt.exit.ip}
                          </div>
                        ) : null}
                      </td>
                      <td>
                        <span className="inline-flex items-center gap-2">
                          <StatusDot tone={tone} />
                          <span
                            className={
                              status === "error"
                                ? "font-medium text-bad"
                                : status === "running"
                                  ? "font-semibold text-accent-text"
                                  : undefined
                            }
                            title={rt?.detail}
                          >
                            {runtimeLabel(status, rt?.error)}
                          </span>
                        </span>
                      </td>
                      <td className="pin-end">
                        <div className="flex items-center justify-end gap-2">
                          {trash ? (
                            <>
                              <Button
                                onClick={() => {
                                  void restoreEnv(env).then((res) => {
                                    if (!res.ok && res.code !== "PLAN_ENV_LIMIT") {
                                      setRestoreNote({ id: env.id, message: res.message });
                                    }
                                  });
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
                                  <Square className="size-3.5 fill-current" />
                                  {t("stop")}
                                </Button>
                              ) : (
                                <Button
                                  variant="primary"
                                  disabled={status === "starting"}
                                  title={status === "starting" ? t("starting") : undefined}
                                  onClick={() => void startEnv(env)}
                                >
                                  <Play className="size-3.5 fill-current" />
                                  {status === "starting" ? t("starting") : t("start")}
                                </Button>
                              )}
                              <Button
                                variant="ghost"
                                size="icon"
                                title="移入回收站"
                                aria-label="移入回收站"
                                className="ml-1 text-subtle hover:text-bad"
                                onClick={() => setTrashing({ id: env.id, name: env.name })}
                              >
                                <Trash2 className="size-3.5" />
                              </Button>
                            </>
                          )}
                        </div>
                        {restoreNote?.id === env.id ? (
                          <p className="mt-1 text-right text-[13px] whitespace-normal text-bad">
                            {restoreNote.message}
                          </p>
                        ) : null}
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

      {trashing ? (
        <Dialog open onOpenChange={(o) => !o && setTrashing(null)}>
          <DialogContent title={`把「${trashing.name}」移入回收站？`}>
            <p className="text-sm text-muted">正在运行的浏览器会先停止。之后可以在回收站恢复。</p>
            <div className="mt-6 flex justify-end gap-2">
              <Button onClick={() => setTrashing(null)}>{t("cancel")}</Button>
              <Button
                variant="danger"
                onClick={() => {
                  const id = trashing.id;
                  setTrashing(null);
                  void trashEnv(id);
                }}
              >
                移入回收站
              </Button>
            </div>
          </DialogContent>
        </Dialog>
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
  const { folders } = useFolders();

  const [step, setStep] = useState(0);
  const [source, setSource] = useState<"blank" | "copy">("blank");
  const [name, setName] = useState("");
  const [folderId, setFolderId] = useState(DEFAULT_FOLDER);
  const [platform, setPlatform] = useState<PlatformId>(thisPlatform());
  const [winEdition, setWinEdition] = useState<"10" | "11">("11");
  const [engineId, setEngineId] = useState("none");
  const [country, setCountry] = useState("US");
  const [followExit, setFollowExit] = useState(true);
  const [proxyId, setProxyId] = useState("");
  const [copyId, setCopyId] = useState("");
  const [error, setError] = useState("");
  // 没选过就用默认版本；问不到本机服务时退回安装包自带的那个。
  const { kernels: allKernels, defaultVersions } = useKernels();
  const [engine, setEngine] = useState<EngineClass>("chromium");
  // 版本只在选定的那一类里挑。
  const kernels = allKernels.filter((k) => k.record.engine === engine);
  const [pickedKernel, setPickedKernel] = useState<string | null>(null);
  const kernelVersion = pickedKernel ?? defaultVersions[engine] ?? BUNDLED_KERNEL_VERSION;

  const [busy, setBusy] = useState(false);

  const create = async () => {
    setBusy(true);
    try {
      if (!name.trim()) {
        setError("请先填写环境名称。");
        setStep(1);
        return;
      }
      const store = useEnclave.getState();
      const region = regionOfCountry(country);
      // 名额由服务器数：登记成了才落到本机。满了的话提示已经弹出来，这里收起向导。
      const register = async (env: Parameters<typeof registerEnv>[0]) => {
        const res = await registerEnv(env);
        if (res.ok) return true;
        if (res.code === "PLAN_ENV_LIMIT") onClose();
        else setError(res.message);
        return false;
      };
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
            folderId,
            tags: [...src.tags],
            note: src.note,
            proxyId: proxyId || null,
            profile: {
              ...src.profile,
              seed: randomSeed(),
              seedLocked: true,
              // 时区和语言成对改；原环境的时区在选的这个国家里就留着。
              ...(region ? regionFields(region, src.profile.timezone) : {}),
              brandVersion: kernelVersion,
            },
            followExit,
            engine,
            kernelVersion,
            searchEngine: src.searchEngine,
            searchProvider: src.searchProvider,
            extensionIds: [...src.extensionIds],
          }),
          extraFlags: [...src.extraFlags],
        };
        copy.timeline[0] = {
          at: Date.now(),
          kind: "created",
          message: `复制自 ${src.name}`,
          level: "info",
        };
        if (!(await register(copy))) return;
        store.upsertEnv(copy);
        store.addAudit({
          action: "create_env",
          target: copy.id,
          level: "info",
          detail: `${copy.name} ← ${src.name}`,
        });
        onCreated(copy.id);
        return;
      }
      const searchEngine = findEngine(Array.isArray(catalog) ? catalog : [], engineId);
      const env = newEnvironment({
        name: name.trim(),
        folderId,
        proxyId: proxyId || null,
        profile: profileFromSeed(
          randomSeed(),
          platform,
          {
            ...(region ? regionFields(region) : {}),
            platformVersion: defaultPlatformVersion(platform, winEdition),
            // 画像报的浏览器版本必须和真正跑的内核一致，否则 UA 和内核特征对不上。
            brandVersion: kernelVersion,
          },
          engine,
        ),
        followExit,
        engine,
        kernelVersion,
        // 默认搜索引擎是靠 Chromium 扩展设的，Firefox 类没有这个机制。
        searchEngine: engine === "firefox" ? "none" : (searchEngine?.id ?? "none"),
        searchProvider:
          engine === "firefox" || !searchEngine ? undefined : engineToProvider(searchEngine),
      });
      env.timeline[0] = {
        at: Date.now(),
        kind: "created",
        message: "已创建",
        level: "info",
      };
      if (!(await register(env))) return;
      store.upsertEnv(env);
      store.addAudit({ action: "create_env", target: env.id, level: "info", detail: env.name });
      onCreated(env.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const steps = [t("step1"), t("step2"), t("step3")];
  const sourceOptions = existing.length
    ? ([
        ["blank", t("blank")],
        ["copy", t("fromCopy")],
      ] as const)
    : ([["blank", t("blank")]] as const);

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent title={t("createTitle")}>
        <ol className="mb-5 flex items-center gap-2">
          {steps.map((label, i) => (
            <li key={label} className="flex items-center gap-2">
              {i > 0 ? <span className="h-px w-5 bg-line-strong" aria-hidden="true" /> : null}
              <span
                className={
                  i === step
                    ? "inline-flex items-center gap-1.5 text-[13px] font-semibold text-accent-text"
                    : i < step
                      ? "inline-flex items-center gap-1.5 text-[13px] font-medium text-ink"
                      : "inline-flex items-center gap-1.5 text-[13px] font-medium text-subtle"
                }
              >
                <span
                  className={
                    i === step
                      ? "grid size-5 place-items-center rounded-full border border-accent bg-accent-wash text-[11px] font-semibold text-accent-text"
                      : i < step
                        ? "grid size-5 place-items-center rounded-full bg-accent-wash text-[11px] font-semibold text-accent-text"
                        : "grid size-5 place-items-center rounded-full bg-surface-2 text-[11px] font-semibold text-subtle"
                  }
                >
                  {i + 1}
                </span>
                {label}
              </span>
            </li>
          ))}
        </ol>

        {step === 0 ? (
          <div className="grid grid-cols-2 gap-2">
            {sourceOptions.map(([id, label]) => (
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
            <Field label={t("folder")} hint={t("folderHint")}>
              <Select value={folderId} onChange={(e) => setFolderId(e.target.value)}>
                {folders.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.name}
                  </option>
                ))}
              </Select>
            </Field>
            {source === "copy" ? (
              <Field label={t("fromCopy")}>
                <Select
                  value={copyId}
                  onChange={(e) => {
                    setCopyId(e.target.value);
                    // 下一步的地区和代理先带上原环境的，用户可以再改。
                    const src = existing.find((x) => x.id === e.target.value);
                    if (!src) return;
                    setEngine(src.engine);
                    setPickedKernel(src.kernelVersion);
                    setFolderId(src.folderId);
                    setCountry(regionOfTimezone(src.profile.timezone)?.country ?? country);
                    setFollowExit(src.followExit);
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
                <div className="rounded-md border border-line bg-surface-2 px-3 py-3 text-[13px] leading-relaxed text-muted">
                  <span className="font-medium text-ink">推荐配置：</span>
                  {ENGINE_META[engine].label}，使用本机系统，兼容多数网站。
                </div>
                <details className="rounded-md border border-line bg-surface">
                  <summary className="cursor-pointer px-3 py-2.5 text-[13px] font-medium text-muted hover:text-ink">
                    高级设置
                  </summary>
                  <div className="grid gap-4 border-t border-line p-3">
                    <Field label="浏览器内核" hint={ENGINE_META[engine].summary}>
                      <Select
                        value={engine}
                        onChange={(e) => {
                          // 换类就是换了另一个浏览器：之前挑的版本不属于新的这一类。
                          const next = e.target.value as EngineClass;
                          setEngine(next);
                          setPickedKernel(null);
                          // Chrome 内核的平台只能是本机，换回这一类时归位。
                          if (next === "chromium") setPlatform(thisPlatform());
                        }}
                      >
                        {ENGINE_CLASSES.map((c) => (
                          <option key={c} value={c}>
                            {ENGINE_META[c].label}（{ENGINE_META[c].build}）
                          </option>
                        ))}
                      </Select>
                    </Field>
                    <Field
                      label={t("platform")}
                      hint={engine === "chromium" ? t("platformPinnedHint") : undefined}
                    >
                      {engine === "chromium" ? (
                        <p className="rounded-md border border-line bg-surface-2 px-3 py-2 text-sm">
                          {platformLabel({
                            platform,
                            platformVersion: defaultPlatformVersion(platform, winEdition),
                            brand: "Chrome",
                          })}
                          <span className="ml-2 text-subtle">{t("platformPinned")}</span>
                        </p>
                      ) : (
                        <Select
                          value={platform}
                          onChange={(e) => setPlatform(e.target.value as PlatformId)}
                        >
                          <option value="windows">Windows</option>
                          <option value="macos">macOS</option>
                          <option value="linux">Linux</option>
                        </Select>
                      )}
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
                    {/* 默认搜索引擎是靠 Chromium 扩展设的，Firefox 类没有这一项。 */}
                    {engine === "chromium" ? (
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
                    ) : null}
                  </div>
                </details>
              </>
            )}
          </div>
        ) : null}

        {step === 2 ? (
          <div className="grid gap-4">
            <Field
              label="地区"
              hint={
                followExit
                  ? "已配置代理时，将根据出口地区设置时区与语言；无法识别时使用此处选择的地区。"
                  : "用于设置浏览器时区与语言。"
              }
            >
              <Select value={country} onChange={(e) => setCountry(e.target.value)}>
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
                  onChange={(e) => setFollowExit(e.target.checked)}
                />
                时区和语言跟着代理出口走
              </span>
            </Field>
            <Field
              label={t("kernelVersion")}
              hint={
                kernels.find((k) => k.record.version === kernelVersion)?.status.state === "admitted"
                  ? undefined
                  : "该版本尚未下载，启动前请先前往内核管理下载"
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
              hint={proxies.length ? undefined : "暂无代理。可先创建环境，之后在网络页添加。"}
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

        <div className="sticky -bottom-6 z-10 -mx-6 -mb-6 mt-6 flex justify-between border-t border-line bg-surface px-6 py-4">
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
            <Button type="button" variant="primary" disabled={busy} onClick={() => void create()}>
              {busy ? "正在创建…" : "创建环境"}
            </Button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
