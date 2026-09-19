import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { Plus, Play, Square, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";
import { Button, Dialog, DialogContent, Field, Input, StatusDot } from "@/components/ui";
import { startEnv, stopEnv } from "@/lib/host";
import { t } from "@/lib/i18n";
import { KERNEL_PIN, TIMEZONES, newEnvironment, profileFromSeed, randomSeed, type PlatformId } from "@/lib/schema";
import { envCount, planOf } from "@/lib/license";
import { useEnclave } from "@/lib/store";
import { useLocale } from "@/components/shell";

export const Route = createFileRoute("/")({ component: EnvironmentsPage });

function EnvironmentsPage() {
  const locale = useLocale();
  const navigate = useNavigate();
  const environments = useEnclave((s) => s.environments);
  const planId = useEnclave((s) => s.settings.plan);
  const runtimes = useEnclave((s) => s.runtimes);
  const selected = useEnclave((s) => s.selectedIds);
  const [query, setQuery] = useState("");
  const [trash, setTrash] = useState(false);
  const [wizard, setWizard] = useState(false);

  const rows = useMemo(() => {
    return environments.filter((e) => {
      const inTrash = Boolean(e.deletedAt);
      if (trash !== inTrash) return false;
      const q = query.trim().toLowerCase();
      if (!q) return true;
      return `${e.name} ${e.group} ${e.tags.join(" ")} ${e.profile.platform}`.toLowerCase().includes(q);
    });
  }, [environments, query, trash]);

  return (
    <div className="mx-auto flex max-w-[1400px] flex-col gap-4 p-4 md:p-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-[20px] font-semibold tracking-tight">{t(locale, "navEnv")}</h1>
          <p className="mt-1 max-w-xl text-[13px] text-subtle">
            {t(locale, "tagline")} · {t(locale, "plan")} {planOf(planId).label}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button onClick={() => setTrash((v) => !v)}>{trash ? t(locale, "navEnv") : t(locale, "trash")}</Button>
          <Button
            variant="primary"
            onClick={() => {
              const store = useEnclave.getState();
              const plan = planOf(store.settings.plan);
              if (envCount(store.environments) >= plan.envLimit) {
                store.addAudit({
                  action: "create_blocked",
                  level: "warn",
                  detail: `PLAN_ENV_LIMIT ${plan.label} max ${plan.envLimit}`,
                });
                return;
              }
              setWizard(true);
            }}
          >
            <Plus className="size-3.5" />
            {t(locale, "newEnv")}
          </Button>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t(locale, "search")}
          className="max-w-sm"
        />
        {selected.length ? (
          <span className="text-[12px] text-subtle">
            {t(locale, "selected")} {selected.length}
          </span>
        ) : null}
      </div>

      {rows.length === 0 ? (
        <div className="grid place-items-center rounded-xl border border-dashed border-line py-20 text-center">
          <div className="text-[15px] font-medium">{t(locale, "emptyEnv")}</div>
          <p className="mt-2 max-w-md text-[13px] text-subtle">{t(locale, "emptyEnvHint")}</p>
          <Button variant="primary" className="mt-4" onClick={() => setWizard(true)}>
            {t(locale, "newEnv")}
          </Button>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-line">
          <table className="w-full min-w-[720px] text-left text-[13px]">
            <thead className="bg-surface-2 text-[11px] uppercase tracking-wide text-subtle">
              <tr>
                <th className="w-8 px-3 py-2">
                  <input
                    type="checkbox"
                    checked={rows.length > 0 && rows.every((r) => selected.includes(r.id))}
                    onChange={(e) =>
                      useEnclave.getState().setSelected(e.target.checked ? rows.map((r) => r.id) : [])
                    }
                  />
                </th>
                <th className="px-3 py-2">{t(locale, "name")}</th>
                <th className="px-3 py-2">{t(locale, "platform")}</th>
                <th className="px-3 py-2">{t(locale, "proxy")}</th>
                <th className="px-3 py-2">{t(locale, "webrtc")}</th>
                <th className="px-3 py-2">{t(locale, "runtime")}</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {rows.map((env) => {
                const rt = runtimes[env.id];
                const status = rt?.status ?? "stopped";
                const tone =
                  status === "running" ? "run" : status === "error" ? "bad" : status === "starting" ? "warn" : "idle";
                return (
                  <tr key={env.id} className="border-t border-line hover:bg-surface-2/60">
                    <td className="px-3 py-2">
                      <input
                        type="checkbox"
                        checked={selected.includes(env.id)}
                        onChange={(e) => {
                          const next = e.target.checked
                            ? [...selected, env.id]
                            : selected.filter((id) => id !== env.id);
                          useEnclave.getState().setSelected(next);
                        }}
                      />
                    </td>
                    <td className="px-3 py-2">
                      <Link
                        to="/environments/$id"
                        params={{ id: env.id }}
                        className="font-medium hover:underline"
                      >
                        {env.name}
                      </Link>
                      <div className="text-[11px] text-subtle">{env.group}</div>
                    </td>
                    <td className="px-3 py-2 capitalize">{env.profile.platform}</td>
                    <td className="px-3 py-2 text-subtle">
                      {useEnclave.getState().proxies.find((p) => p.id === env.proxyId)?.name ??
                        t(locale, "noProxy")}
                    </td>
                    <td className="px-3 py-2">{env.profile.webrtc.mode}</td>
                    <td className="px-3 py-2">
                      <span className="inline-flex items-center gap-1.5">
                        <StatusDot tone={tone} />
                        {status === "running"
                          ? t(locale, "running")
                          : status === "starting"
                            ? t(locale, "starting")
                            : status === "error"
                              ? t(locale, "error")
                              : t(locale, "stopped")}
                      </span>
                    </td>
                    <td className="px-3 py-2">
                      <div className="flex justify-end gap-1">
                        {trash ? (
                          <>
                            <Button onClick={() => useEnclave.getState().restoreEnv(env.id)}>
                              {t(locale, "restore")}
                            </Button>
                            <Button variant="danger" onClick={() => useEnclave.getState().destroyEnv(env.id)}>
                              {t(locale, "destroy")}
                            </Button>
                          </>
                        ) : (
                          <>
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
                              variant="ghost"
                              onClick={() => {
                                useEnclave.getState().removeEnv(env.id);
                              }}
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

      {wizard ? (
        <CreateWizard
          onClose={() => setWizard(false)}
          onCreated={(id) => {
            setWizard(false);
            void navigate({ to: "/environments/$id", params: { id } });
          }}
        />
      ) : null}

      {rows.some((r) => runtimes[r.id]?.error === "KERNEL_UNTRUSTED_SOURCE") ? (
        <div className="flex items-center justify-between gap-3 rounded-lg border border-warn/30 bg-warn/10 px-3 py-2 text-[13px]">
          <span>{t(locale, "kernelNeed")}</span>
          <Link to="/kernels" className="underline">
            {t(locale, "goKernels")}
          </Link>
        </div>
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
  const locale = useLocale();
  const proxies = useEnclave((s) => s.proxies);
  const allEnvs = useEnclave((s) => s.environments);
  const existing = useMemo(() => allEnvs.filter((e) => !e.deletedAt), [allEnvs]);
  const [step, setStep] = useState(0);
  const [source, setSource] = useState<"blank" | "exit" | "template" | "copy">("blank");
  const [name, setName] = useState("");
  const [group, setGroup] = useState("default");
  const [platform, setPlatform] = useState<PlatformId>("windows");
  const [timezone, setTimezone] = useState("America/Los_Angeles");
  const [proxyId, setProxyId] = useState<string>("");
  const [copyId, setCopyId] = useState("");

  const create = () => {
    const store = useEnclave.getState();
    const plan = planOf(store.settings.plan);
    if (envCount(store.environments) >= plan.envLimit) {
      store.addAudit({
        action: "create_blocked",
        level: "warn",
        detail: `PLAN_ENV_LIMIT ${plan.label} max ${plan.envLimit}`,
      });
      return;
    }
    if (source === "copy" && copyId) {
      const copy = store.duplicateEnv(copyId);
      if (copy) {
        store.patchEnv(copy.id, { name: name || copy.name });
        onCreated(copy.id);
      }
      return;
    }
    const seed = randomSeed();
    const env = newEnvironment({
      name: name || (locale === "zh" ? "未命名环境" : "Untitled"),
      group,
      proxyId: proxyId || null,
      profile: profileFromSeed(seed, platform, { timezone }),
      kernelPin: KERNEL_PIN,
    });
    env.timeline[0] = {
      at: Date.now(),
      kind: "created",
      message: `source=${source}`,
      level: "info",
    };
    store.upsertEnv(env);
    store.addAudit({ action: "create_env", target: env.id, level: "info", detail: env.name });
    onCreated(env.id);
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent title={t(locale, "createTitle")}>
        <div className="mb-4 flex gap-2 text-[11px] text-subtle">
          <span className={step === 0 ? "text-ink" : ""}>1 {t(locale, "step1")}</span>
          <span>/</span>
          <span className={step === 1 ? "text-ink" : ""}>2 {t(locale, "step2")}</span>
          <span>/</span>
          <span className={step === 2 ? "text-ink" : ""}>3 {t(locale, "step3")}</span>
        </div>
        {step === 0 ? (
          <div className="grid grid-cols-2 gap-2">
            {(
              [
                ["blank", t(locale, "blank")],
                ["exit", t(locale, "fromExit")],
                ["template", t(locale, "template")],
                ["copy", t(locale, "fromCopy")],
              ] as const
            ).map(([id, label]) => (
              <button
                key={id}
                onClick={() => setSource(id)}
                className={`rounded-lg border px-3 py-4 text-left text-[13px] ${
                  source === id ? "border-line-strong bg-surface-2" : "border-line"
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        ) : null}
        {step === 1 ? (
          <div className="grid gap-3">
            <Field label={t(locale, "name")}>
              <Input value={name} onChange={(e) => setName(e.target.value)} />
            </Field>
            <Field label={t(locale, "group")}>
              <Input value={group} onChange={(e) => setGroup(e.target.value)} />
            </Field>
            <Field label={t(locale, "platform")}>
              <select
                className="h-8 w-full rounded-md border border-line bg-surface px-2 text-[13px]"
                value={platform}
                onChange={(e) => setPlatform(e.target.value as PlatformId)}
              >
                <option value="windows">Windows</option>
                <option value="macos">macOS</option>
                <option value="linux">Linux</option>
              </select>
            </Field>
            {source === "copy" ? (
              <Field label={t(locale, "fromCopy")}>
                <select
                  className="h-8 w-full rounded-md border border-line bg-surface px-2 text-[13px]"
                  value={copyId}
                  onChange={(e) => setCopyId(e.target.value)}
                >
                  <option value="">—</option>
                  {existing.map((e) => (
                    <option key={e.id} value={e.id}>
                      {e.name}
                    </option>
                  ))}
                </select>
              </Field>
            ) : null}
          </div>
        ) : null}
        {step === 2 ? (
          <div className="grid gap-3">
            <Field label={t(locale, "timezone")}>
              <select
                className="h-8 w-full rounded-md border border-line bg-surface px-2 text-[13px]"
                value={timezone}
                onChange={(e) => setTimezone(e.target.value)}
              >
                {TIMEZONES.map((tz) => (
                  <option key={tz} value={tz}>
                    {tz}
                  </option>
                ))}
              </select>
            </Field>
            <Field label={t(locale, "proxy")}>
              <select
                className="h-8 w-full rounded-md border border-line bg-surface px-2 text-[13px]"
                value={proxyId}
                onChange={(e) => setProxyId(e.target.value)}
              >
                <option value="">{t(locale, "noProxy")}</option>
                {proxies.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </Field>
            <div className="rounded-md border border-line bg-canvas px-3 py-2 text-[12px] text-subtle">
              kernel {KERNEL_PIN.id} {KERNEL_PIN.version}
            </div>
          </div>
        ) : null}
        <div className="mt-5 flex justify-between">
          <Button onClick={step === 0 ? onClose : () => setStep((s) => s - 1)}>
            {step === 0 ? t(locale, "cancel") : t(locale, "back")}
          </Button>
          {step < 2 ? (
            <Button variant="primary" onClick={() => setStep((s) => s + 1)}>
              {t(locale, "next")}
            </Button>
          ) : (
            <Button variant="primary" onClick={create}>
              {t(locale, "create")}
            </Button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
