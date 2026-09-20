import { defaultPlatformVersion } from "@/lib/os";

export const PROFILE_SCHEMA = "fingerprint-profile/v1" as const;

export type PlatformId = "windows" | "macos" | "linux";
export type BrowserBrand = "Chrome" | "Edge" | "Opera" | "Vivaldi";
export type WebrtcMode = "replace" | "disable";
export type EnvStatus = "stopped" | "starting" | "running" | "error";

export type FingerprintProfile = {
  schema: typeof PROFILE_SCHEMA;
  seed: string;
  seedLocked: boolean;
  platform: PlatformId;
  platformVersion: string;
  brand: BrowserBrand;
  brandVersion: string;
  hardwareConcurrency: number;
  locale: string;
  languages: string[];
  timezone: string;
  screen: { width: number; height: number };
  webrtc: { mode: WebrtcMode };
  disableSpoofing: string[];
};

/**
 * 代理认证。**密码不在这里**：它只以密文存在保险箱里（见 lib/vault.ts），
 * 键是 `proxy:<代理 id>`。这里只记有没有存过密码，界面据此显示状态。
 */
export type ProxyAuth = {
  username: string;
  hasPassword: boolean;
};

export type ProxyItem = {
  id: string;
  name: string;
  protocol: "http" | "https" | "socks5";
  host: string;
  port: number;
  auth?: ProxyAuth;
  country?: string;
  city?: string;
};

export type ExtensionItem = {
  id: string;
  name: string;
  source: "local-crx" | "local-dir";
  path: string;
  version?: string;
  permissions: string[];
  highRisk: boolean;
};

export type TimelineEvent = {
  at: number;
  kind: string;
  message: string;
  level: "info" | "warn" | "bad";
};

export type Environment = {
  id: string;
  name: string;
  group: string;
  tags: string[];
  note: string;
  profile: FingerprintProfile;
  proxyId: string | null;
  searchEngine: string;
  searchProvider?: { name: string; keyword: string; url: string; suggestUrl?: string };
  extensionIds: string[];
  kernelPin: { id: string; version: string; sha256: string };
  allowNoSandbox: boolean;
  extraFlags: string[];
  deletedAt: number | null;
  lastIntegrity?: { at: number; ok: boolean; reason?: string };
  lastLab?: { at: number; pass: boolean; summary: string };
  createdAt: number;
  updatedAt: number;
  timeline: TimelineEvent[];
};

export type AuditEvent = {
  id: string;
  at: number;
  action: string;
  target?: string;
  level: "info" | "warn" | "bad";
  detail: string;
};

export type LabSnapshot = {
  userAgent: string;
  platform: string;
  vendor: string;
  language: string;
  languages: string[];
  hardwareConcurrency: number;
  deviceMemory: number | null;
  maxTouchPoints: number;
  hardware: { screenW: number; screenH: number; colorDepth: number; dpr: number };
  timezone: string;
  locale: string;
  webdriver: boolean | null;
  canvasHash: string;
  webglVendor: string;
  webglRenderer: string;
  webrtcIps: string[];
  collectedAt: number;
  source: "page" | "cdp";
};

export type AppSettings = {
  locale: "zh" | "en";
  allowNoSandboxHost: boolean;
  /** 内核还在预览通道时，用户明确同意后才允许准入和启动。 */
  allowPreviewKernel: boolean;
  /** 用户想不想开本机 API。真正能不能开还要看档位。 */
  apiEnabled: boolean;
  onboarded: boolean;
};

export function makeId(prefix: string): string {
  const t = Date.now().toString(36);
  const r = crypto.randomUUID().replace(/-/g, "").slice(0, 10);
  return `${prefix}_${t}${r}`;
}

export function randomSeed(): string {
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  const n = buf[0] === 0 ? 1 : buf[0];
  return String(n);
}

function mulberry32(a: number) {
  return function next() {
    let t = (a += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const SCREENS = [
  { width: 1920, height: 1080 },
  { width: 2560, height: 1440 },
  { width: 1680, height: 1050 },
  { width: 1440, height: 900 },
  { width: 1512, height: 982 },
];
export const CORES = [4, 6, 8, 12, 16];

export function profileFromSeed(
  seed: string,
  platform: PlatformId,
  extras?: Partial<FingerprintProfile>,
): FingerprintProfile {
  const n = Number.parseInt(seed, 10) >>> 0;
  const rnd = mulberry32(n || 1);
  const pick = <T,>(arr: T[]) => arr[Math.floor(rnd() * arr.length)] as T;
  const screen = pick(SCREENS);
  const locale = extras?.locale ?? "en-US";
  return {
    schema: PROFILE_SCHEMA,
    seed,
    seedLocked: true,
    platform,
    platformVersion: extras?.platformVersion ?? defaultPlatformVersion(platform),
    brand: extras?.brand ?? "Chrome",
    brandVersion: extras?.brandVersion ?? "148.0.7778.215",
    hardwareConcurrency: extras?.hardwareConcurrency ?? pick(CORES),
    locale,
    languages: extras?.languages ?? [locale, locale.split("-")[0] ?? "en"],
    timezone: extras?.timezone ?? "America/Los_Angeles",
    screen: extras?.screen ?? screen,
    webrtc: extras?.webrtc ?? { mode: "replace" },
    disableSpoofing: extras?.disableSpoofing ?? [],
  };
}

export const KERNEL_PIN = {
  id: "fingerprint-chromium",
  version: "148.0.7778.215",
  sha256: "70d239830332e5820aa34dfcb284161cac0429eee25da642830afe04bda717f4",
};

export const TIMEZONES = [
  "America/Los_Angeles",
  "America/New_York",
  "America/Chicago",
  "America/Sao_Paulo",
  "Europe/London",
  "Europe/Berlin",
  "Europe/Paris",
  "Europe/Moscow",
  "Asia/Shanghai",
  "Asia/Tokyo",
  "Asia/Singapore",
  "Asia/Kolkata",
  "Australia/Sydney",
  "UTC",
] as const;

export const PROXY_GEO_TZ: Record<string, string[]> = {
  US: ["America/Los_Angeles", "America/New_York", "America/Chicago", "America/Denver"],
  GB: ["Europe/London"],
  DE: ["Europe/Berlin"],
  FR: ["Europe/Paris"],
  JP: ["Asia/Tokyo"],
  CN: ["Asia/Shanghai"],
  SG: ["Asia/Singapore"],
  IN: ["Asia/Kolkata"],
  BR: ["America/Sao_Paulo"],
  AU: ["Australia/Sydney"],
  RU: ["Europe/Moscow"],
};

export function newEnvironment(partial?: Partial<Environment>): Environment {
  const now = Date.now();
  const seed = randomSeed();
  return {
    id: makeId("env"),
    name: partial?.name ?? "Untitled",
    group: partial?.group ?? "default",
    tags: partial?.tags ?? [],
    note: partial?.note ?? "",
    profile: partial?.profile ?? profileFromSeed(seed, "windows"),
    proxyId: partial?.proxyId ?? null,
    searchEngine: partial?.searchEngine ?? "none",
    extensionIds: partial?.extensionIds ?? [],
    kernelPin: KERNEL_PIN,
    allowNoSandbox: false,
    extraFlags: [],
    deletedAt: null,
    createdAt: now,
    updatedAt: now,
    timeline: [
      {
        at: now,
        kind: "created",
        message: "Environment created",
        level: "info",
      },
    ],
    ...omitDefined(partial, [
      "name",
      "group",
      "tags",
      "note",
      "profile",
      "proxyId",
      "searchEngine",
      "searchProvider",
      "extensionIds",
    ]),
  };
}

function omitDefined<T extends object, K extends keyof T>(
  value: Partial<T> | undefined,
  _keys: K[],
): Partial<T> {
  if (!value) return {};
  const next = { ...value };
  return next;
}
