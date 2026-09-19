import { create } from "zustand";
import { persist } from "zustand/middleware";
import { BUILTIN_ENGINES, type CatalogEngine } from "@/lib/engines";
import {
  type AppSettings,
  type AuditEvent,
  type Environment,
  type ExtensionItem,
  type LabSnapshot,
  type ProxyItem,
  type TimelineEvent,
  makeId,
  newEnvironment,
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
  error?: string;
  probe?: { ok: boolean; detail: string };
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
  locked: boolean;
  selectedIds: string[];
  setLocale: (locale: AppSettings["locale"]) => void;
  setTheme: (theme: AppSettings["theme"]) => void;
  setDensity: (density: AppSettings["density"]) => void;
  setLocked: (locked: boolean) => void;
  patchSettings: (patch: Partial<AppSettings>) => void;
  upsertEnv: (env: Environment) => void;
  patchEnv: (id: string, patch: Partial<Environment>, event?: TimelineEvent) => void;
  removeEnv: (id: string) => void;
  restoreEnv: (id: string) => void;
  destroyEnv: (id: string) => void;
  duplicateEnv: (id: string) => Environment | null;
  setSelected: (ids: string[]) => void;
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
  theme: "dark",
  density: "compact",
  masterPasswordSet: false,
  apiEnabled: false,
  apiPort: 18765,
  confirmDangerousApi: true,
  allowNoSandboxHost: false,
  plan: "free",
  onboarded: false,
};

export const useEnclave = create<Store>()(
  persist(
    (set, get) => ({
      settings: initialSettings,
      environments: [],
      proxies: [],
      extensions: [],
      searchCatalog: BUILTIN_ENGINES,
      audit: [],
      runtimes: {},
      lab: { lastByEnv: {}, lastRunId: null },
      locked: false,
      selectedIds: [],
      setLocale: (locale) =>
        set((s) => ({ settings: { ...s.settings, locale } })),
      setTheme: (theme) =>
        set((s) => ({ settings: { ...s.settings, theme } })),
      setDensity: (density) =>
        set((s) => ({ settings: { ...s.settings, density } })),
      setLocked: (locked) => set({ locked }),
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
                      message: "Moved to trash",
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
          selectedIds: s.selectedIds.filter((x) => x !== id),
        })),
      duplicateEnv: (id) => {
        const src = get().environments.find((e) => e.id === id);
        if (!src) return null;
        const copy = newEnvironment({
          name: `${src.name} copy`,
          group: src.group,
          tags: [...src.tags],
          profile: { ...src.profile, seed: src.profile.seed },
          proxyId: src.proxyId,
          extensionIds: [...src.extensionIds],
        });
        set((s) => ({ environments: [copy, ...s.environments] }));
        return copy;
      },
      setSelected: (ids) => set({ selectedIds: ids }),
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
