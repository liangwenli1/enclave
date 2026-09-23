import { create } from "zustand";
import { persist } from "zustand/middleware";
import { BUILTIN_ENGINES, type CatalogEngine } from "@/lib/engines";
import { hostJson, type ExitInfo } from "@/lib/kernel/host-api";
import { runSync } from "@/lib/sync";
import { LOADING, type Session } from "@/lib/session";
import {
  type AppSettings,
  type AuditEvent,
  type Environment,
  type ExtensionItem,
  type LabSnapshot,
  type ProxyItem,
  type TimelineEvent,
  makeId, type Workflow } from "@/lib/schema";

type RuntimeView = {
  envId: string;
  pid: number | null;
  debugPort: number | null;
  debugAddress: "127.0.0.1";
  status: "starting" | "running" | "error" | "stopped";
  startedAt: number | null;
  hashOk: boolean;
  sha256?: string;
  /** 经代理出去之后外面看到的 IP 和位置。 */
  exit?: ExitInfo | null;
  /** 原因码，例如 KERNEL_HASH_MISMATCH。界面按它显示短标签。 */
  error?: string;
  /** 给人看的那句话：出了什么事、下一步做什么。 */
  detail?: string;
};

type LabState = {
  control?: LabSnapshot;
  lastByEnv: Record<string, LabSnapshot>;
  lastRunId: string | null;
};

type Store = {
  settings: AppSettings;
  environments: Environment[];
  proxies: ProxyItem[];
  workflows: Workflow[];
  extensions: ExtensionItem[];
  searchCatalog: CatalogEngine[];
  audit: AuditEvent[];
  runtimes: Record<string, RuntimeView>;
  lab: LabState;
  planNotice: { title: string; body: string } | null;
  /** 账号与额度。每次都是现问来的，不持久化——见 lib/session.ts。 */
  session: Session;
  /**
   * 环境和代理的真相在本机服务里（sqlite），这里是它在内存里的一份。
   * loaded = 已经从本机服务读到了；storeError = 最近一次读写失败的原因，界面要说出来。
   */
  loaded: boolean;
  storeError: string | null;
  /** 哪些密码存着（只有 id）。密码本身只在本机服务里，页面读不到。 */
  secretIds: string[];
  /** 上一次同步成功的时刻；没开同步时是 null。 */
  syncedAt: number | null;
  /** 同步有话要说时（读不了的条目、失败原因）。 */
  syncNote: string | null;
  /** 应用锁：exists = 开着应用锁，unlocked = 已经输过口令（没开应用锁时永远是 true）。由 lib/vault.ts 写入。 */
  vault: { exists: boolean; unlocked: boolean };
  /** 本机 API 的运行状态。令牌由 Host 生成，这里只在内存里留一份给设置页显示。 */
  api: { active: boolean; failed: boolean; token: string; baseUrl: string };
  setSession: (session: Session) => void;
  setPlanNotice: (notice: { title: string; body: string } | null) => void;
  patchSettings: (patch: Partial<AppSettings>) => void;
  upsertEnv: (env: Environment) => void;
  patchEnv: (id: string, patch: Partial<Environment>, event?: TimelineEvent) => void;
  removeEnv: (id: string) => void;
  restoreEnv: (id: string) => void;
  destroyEnv: (id: string) => void;
  upsertProxy: (proxy: ProxyItem) => void;
  removeProxy: (id: string) => void;
  putWorkflow: (wf: Workflow) => void;
  removeWorkflow: (id: string) => void;
  upsertExt: (ext: ExtensionItem) => void;
  removeExt: (id: string) => void;
  upsertEngine: (engine: CatalogEngine) => void;
  removeEngine: (id: string) => void;
  addAudit: (event: Omit<AuditEvent, "id" | "at"> & { at?: number }) => void;
  setRuntime: (envId: string, runtime: RuntimeView | null) => void;
  setControlSnap: (snap: LabSnapshot) => void;
  setEnvSnap: (envId: string, snap: LabSnapshot) => void;
};

const initialSettings: AppSettings = {
  allowNoSandboxHost: false,
  allowPreviewKernel: false,
  apiEnabled: false,
  onboarded: false,
  theme: "system",
};

export const useEnclave = create<Store>()(
  persist(
    (set) => ({
      settings: initialSettings,
      environments: [],
      proxies: [],
      workflows: [],
      extensions: [],
      searchCatalog: BUILTIN_ENGINES,
      audit: [],
      runtimes: {},
      lab: { lastByEnv: {}, lastRunId: null },
      planNotice: null,
      session: LOADING,
      loaded: false,
      storeError: null,
      secretIds: [],
      syncedAt: null,
      syncNote: null,
      vault: { exists: false, unlocked: true },
      api: { active: false, failed: false, token: "", baseUrl: "" },
      setSession: (session) => set({ session }),
      setPlanNotice: (planNotice) => set({ planNotice }),
      patchSettings: (patch) =>
        set((s) => ({ settings: { ...s.settings, ...patch } })),
      upsertEnv: (env) => {
        set((s) => ({
          environments: [env, ...s.environments.filter((e) => e.id !== env.id)],
        }));
        saveSoon("environments", env.id);
      },
      patchEnv: (id, patch, event) => {
        saveSoon("environments", id);
        set((s) => ({
          environments: s.environments.map((e) =>
            e.id === id
              ? {
                  ...e,
                  ...patch,
                  updatedAt: Date.now(),
                  timeline: event ? [event, ...e.timeline].slice(0, 200) : e.timeline,
                }
              : e,
          ),
        }));
      },
      removeEnv: (id) => {
        saveSoon("environments", id);
        set((s) => ({
          environments: s.environments.map((e) =>
            e.id === id
              ? {
                  ...e,
                  deletedAt: Date.now(),
                  timeline: [
                    {
                      at: Date.now(),
                      kind: "trash",
                      message: "已移入回收站",
                      level: "warn",
                    },
                    ...e.timeline,
                  ],
                }
              : e,
          ),
        }));
      },
      restoreEnv: (id) => {
        saveSoon("environments", id);
        set((s) => ({
          environments: s.environments.map((e) =>
            e.id === id ? { ...e, deletedAt: null, updatedAt: Date.now() } : e,
          ),
        }));
      },
      destroyEnv: (id) => {
        set((s) => ({
          environments: s.environments.filter((e) => e.id !== id),
        }));
        saveSoon("environments", id);
      },
      upsertProxy: (proxy) => {
        set((s) => ({
          proxies: s.proxies.some((p) => p.id === proxy.id)
            ? s.proxies.map((p) => (p.id === proxy.id ? proxy : p))
            : [proxy, ...s.proxies],
        }));
        saveSoon("proxies", proxy.id);
      },
      removeProxy: (id) =>
        set((s) => {
          // 绑着这个代理的环境一起改，也要一起存。本机服务删代理时会把它的密码一起删掉。
          for (const e of s.environments) if (e.proxyId === id) saveSoon("environments", e.id);
          saveSoon("proxies", id);
          return {
            proxies: s.proxies.filter((p) => p.id !== id),
            secretIds: s.secretIds.filter((x) => x !== `proxy:${id}`),
            environments: s.environments.map((e) => (e.proxyId === id ? { ...e, proxyId: null } : e)),
          };
        }),
      putWorkflow: (wf) => {
        set((s) => ({
          workflows: s.workflows.some((w) => w.id === wf.id)
            ? s.workflows.map((w) => (w.id === wf.id ? wf : w))
            : [wf, ...s.workflows],
        }));
        saveSoon("workflows", wf.id);
      },
      removeWorkflow: (id) => {
        set((s) => ({ workflows: s.workflows.filter((w) => w.id !== id) }));
        saveSoon("workflows", id);
      },
      upsertExt: (ext) =>
        set((s) => ({
          extensions: [ext, ...s.extensions.filter((e) => e.id !== ext.id)],
        })),
      removeExt: (id) =>
        set((s) => ({ extensions: s.extensions.filter((e) => e.id !== id) })),
      upsertEngine: (engine) =>
        set((s) => ({
          searchCatalog: [engine, ...s.searchCatalog.filter((e) => e.id !== engine.id)],
        })),
      removeEngine: (id) =>
        set((s) => ({ searchCatalog: s.searchCatalog.filter((e) => e.id !== id || e.builtin) })),
      addAudit: (event) =>
        set((s) => ({
          audit: [
            {
              id: makeId("aud"),
              at: event.at ?? Date.now(),
              action: event.action,
              target: event.target,
              level: event.level,
              detail: event.detail,
            },
            ...s.audit,
          ].slice(0, 500),
        })),
      setRuntime: (envId, runtime) =>
        set((s) => {
          const next = { ...s.runtimes };
          if (!runtime) delete next[envId];
          else next[envId] = runtime;
          return { runtimes: next };
        }),
      setControlSnap: (snap) =>
        set((s) => ({ lab: { ...s.lab, control: snap, lastRunId: makeId("lab") } })),
      setEnvSnap: (envId, snap) =>
        set((s) => ({
          lab: {
            ...s.lab,
            lastByEnv: { ...s.lab.lastByEnv, [envId]: snap },
            lastRunId: makeId("lab"),
          },
        })),
    }),
    {
      name: "enclave.v1",
      // 环境和代理不在这里：它们的真相在本机服务里。这里只留界面自己的东西。
      partialize: (s) => ({
        settings: s.settings,
        extensions: s.extensions,
        searchCatalog: s.searchCatalog?.length ? s.searchCatalog : BUILTIN_ENGINES,
        audit: s.audit,
        lab: { control: s.lab.control, lastByEnv: s.lab.lastByEnv, lastRunId: s.lab.lastRunId },
      }),
      merge: (persisted, current) => {
        // 环境和代理的真相在本机服务里：就算旧版本往 localStorage 里存过，也不从这里读。
        const { environments: _e, proxies: _p, ...p } = (persisted ?? {}) as Partial<Store>;
        return {
          ...current,
          ...p,
          settings: { ...initialSettings, ...p.settings },
          searchCatalog: p.searchCatalog?.length ? p.searchCatalog : BUILTIN_ENGINES,
        };
      },
    },
  ),
);

/* ── 环境和代理：写穿到本机服务 ─────────────────────────────────────
   界面上的每一次改动先落在内存里（不卡输入），随后存到本机服务。
   同一条记录短时间内的多次改动（比如一个字一个字地改名字）合成一次写。 */

type Table = "environments" | "proxies" | "workflows";
const pending = new Map<string, number>();

function saveSoon(table: Table, id: string): void {
  const key = `${table}/${id}`;
  window.clearTimeout(pending.get(key));
  pending.set(
    key,
    window.setTimeout(() => {
      pending.delete(key);
      void flush(table, id);
    }, 250),
  );
}

async function flush(table: Table, id: string): Promise<void> {
  const state = useEnclave.getState();
  const doc =
    table === "environments"
      ? state.environments.find((e) => e.id === id)
      : table === "proxies"
        ? state.proxies.find((p) => p.id === id)
        : state.workflows.find((w) => w.id === id);
  const path = `/v1/store/${table}/${encodeURIComponent(id)}`;
  // 内存里已经没有了 = 被删了。
  const res = doc ? await hostJson<{ ok: true }>(path, "PUT", doc) : await hostJson<{ ok: true }>(path, "DELETE");
  useEnclave.setState({ storeError: res.ok ? null : `刚才的改动没存上：${res.message}` });
}

/** 把还没写出去的改动立刻写完。关窗口、导出之前用。 */
export async function flushStore(): Promise<void> {
  const keys = [...pending.keys()];
  for (const key of keys) {
    window.clearTimeout(pending.get(key));
    pending.delete(key);
    const [table, id] = key.split("/") as [Table, string];
    await flush(table, id);
  }
}

type StoreDump = { ok: true; environments: Environment[]; proxies: ProxyItem[]; workflows?: Workflow[]; secretIds: string[] };

/** "已保存密码"以本机服务里真的有为准，不照抄记录里的标记。 */
function withPasswordFlags(proxies: ProxyItem[], secretIds: string[]): ProxyItem[] {
  return proxies.map((p) =>
    p.auth ? { ...p, auth: { ...p.auth, hasPassword: secretIds.includes(`proxy:${p.id}`) } } : p,
  );
}

/** 跑一轮同步，拉下来的东西反映到界面上。改动先写完再同步，免得刚改的那一笔被漏掉。 */
export async function syncNow(): Promise<void> {
  await flushStore();
  const res = await runSync();
  if (!res.ok) {
    useEnclave.setState({ syncNote: `同步没成功：${res.message}` });
    return;
  }
  if (res.enabled && res.hasKey && ((res.pulled ?? 0) > 0 || (res.stale ?? 0) > 0)) await loadStore();
  useEnclave.setState({
    syncNote:
      res.enabled && res.hasKey && (res.unreadable ?? 0) > 0
        ? `有 ${res.unreadable} 条是用别的密钥加密的，暂时读不了。到设置页重新取一次密钥。`
        : null,
    syncedAt: res.enabled && res.hasKey ? Date.now() : null,
  });
}

/** 从本机服务读出全部环境和代理。工作台登录后做一次。 */
export async function loadStore(): Promise<boolean> {
  const res = await hostJson<StoreDump>("/v1/store");
  if (!res.ok) {
    useEnclave.setState({ storeError: `读不出本机数据：${res.message}` });
    return false;
  }
  useEnclave.setState({
    environments: res.environments,
    proxies: withPasswordFlags(res.proxies, res.secretIds),
    workflows: res.workflows ?? [],
    secretIds: res.secretIds,
    loaded: true,
    storeError: null,
  });
  return true;
}

// 哪些密码存着变了，代理上的"已保存密码"标记跟着变。
useEnclave.subscribe((state, prev) => {
  if (state.secretIds === prev.secretIds) return;
  useEnclave.setState({ proxies: withPasswordFlags(state.proxies, state.secretIds) });
});
