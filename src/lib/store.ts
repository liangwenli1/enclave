import { create } from "zustand";
import { persist } from "zustand/middleware";
import { BUILTIN_ENGINES, type CatalogEngine } from "@/lib/engines";
import { SIGNED_OUT, type AccountState } from "@/lib/license/client";
import {
  type AppSettings,
  type AuditEvent,
  type Environment,
  type ExtensionItem,
  type LabSnapshot,
  type ProxyItem,
  type TimelineEvent,
  makeId,
} from "@/lib/schema";

type RuntimeView = {
  envId: string;
  pid: number | null;
  debugPort: number | null;
  debugAddress: "127.0.0.1";
  status: "starting" | "running" | "error" | "stopped";
  startedAt: number | null;
  hashOk: boolean;
  sha256?: string;
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
  extensions: ExtensionItem[];
  searchCatalog: CatalogEngine[];
  audit: AuditEvent[];
  runtimes: Record<string, RuntimeView>;
  lab: LabState;
  planNotice: { title: string; body: string } | null;
  /** 账号与额度。来自厂商签名的许可证，不持久化在这里——见 lib/license/client.ts。 */
  account: AccountState;
  /** 保险箱是否已建、是否已解锁。由 lib/vault.ts 写入。 */
  vault: { exists: boolean; unlocked: boolean };
  /** 本机 API 的运行状态。令牌由 Host 生成，这里只在内存里留一份给设置页显示。 */
  api: { active: boolean; failed: boolean; token: string; baseUrl: string };
  setAccount: (account: AccountState) => void;
  setLocale: (locale: AppSettings["locale"]) => void;
  setPlanNotice: (notice: { title: string; body: string } | null) => void;
  patchSettings: (patch: Partial<AppSettings>) => void;
  upsertEnv: (env: Environment) => void;
  patchEnv: (id: string, patch: Partial<Environment>, event?: TimelineEvent) => void;
  removeEnv: (id: string) => void;
  restoreEnv: (id: string) => void;
  destroyEnv: (id: string) => void;
  upsertProxy: (proxy: ProxyItem) => void;
  removeProxy: (id: string) => void;
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
  locale: "zh",
  allowNoSandboxHost: false,
  allowPreviewKernel: false,
  apiEnabled: false,
  onboarded: false,
};

export const useEnclave = create<Store>()(
  persist(
    (set) => ({
      settings: initialSettings,
      environments: [],
      proxies: [],
      extensions: [],
      searchCatalog: BUILTIN_ENGINES,
      audit: [],
      runtimes: {},
      lab: { lastByEnv: {}, lastRunId: null },
      planNotice: null,
      account: SIGNED_OUT,
      vault: { exists: false, unlocked: false },
      api: { active: false, failed: false, token: "", baseUrl: "" },
      setAccount: (account) => set({ account }),
      setLocale: (locale) =>
        set((s) => ({ settings: { ...s.settings, locale } })),
      setPlanNotice: (planNotice) => set({ planNotice }),
      patchSettings: (patch) =>
        set((s) => ({ settings: { ...s.settings, ...patch } })),
      upsertEnv: (env) =>
        set((s) => ({
          environments: [env, ...s.environments.filter((e) => e.id !== env.id)],
        })),
      patchEnv: (id, patch, event) =>
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
        })),
      removeEnv: (id) =>
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
        })),
      restoreEnv: (id) =>
        set((s) => ({
          environments: s.environments.map((e) =>
            e.id === id ? { ...e, deletedAt: null, updatedAt: Date.now() } : e,
          ),
        })),
      destroyEnv: (id) =>
        set((s) => ({
          environments: s.environments.filter((e) => e.id !== id),
        })),
      upsertProxy: (proxy) =>
        set((s) => ({
          proxies: [proxy, ...s.proxies.filter((p) => p.id !== proxy.id)],
        })),
      removeProxy: (id) =>
        set((s) => ({
          proxies: s.proxies.filter((p) => p.id !== id),
          environments: s.environments.map((e) =>
            e.proxyId === id ? { ...e, proxyId: null } : e,
          ),
        })),
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
      partialize: (s) => ({
        settings: s.settings,
        environments: s.environments,
        proxies: s.proxies,
        extensions: s.extensions,
        searchCatalog: s.searchCatalog?.length ? s.searchCatalog : BUILTIN_ENGINES,
        audit: s.audit,
        lab: { control: s.lab.control, lastByEnv: s.lab.lastByEnv, lastRunId: s.lab.lastRunId },
      }),
      merge: (persisted, current) => {
        const p = (persisted ?? {}) as Partial<Store>;
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

export function liveEnvironments() {
  return useEnclave.getState().environments.filter((e) => !e.deletedAt);
}
