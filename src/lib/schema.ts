// 相对路径 + 扩展名：这条引用链（schema → os / regions）要能直接在 node 里跑测试。
import { defaultPlatformVersion } from "./os.ts";
import { REGIONS, type Region } from "./regions.ts";
import type { EngineClass } from "./kernel/host-api.ts";
import devices from "./firefox-devices.json" with { type: "json" };

export const PROFILE_SCHEMA = "fingerprint-profile/v1" as const;

export type PlatformId = "windows" | "macos" | "linux";
/** Firefox 类的环境永远是 "Firefox"；其余四个是 Chromium 类能报的品牌。 */
export type BrowserBrand = "Chrome" | "Edge" | "Opera" | "Vivaldi" | "Firefox";
export type WebrtcMode = "replace" | "disable";

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
  /**
   * 浏览器窗口的大小。不是屏幕分辨率：实测内核 148 改不了 screen.width/height，
   * 网页在每个环境里看到的都是这台电脑真实的显示器。
   */
  window: { width: number; height: number };
  /**
   * 下面三项只有 Firefox 类的环境有：那一类的内核能按环境给屏幕、缩放和显卡字符串（实测）。
   * 三项来自同一台真机（lib/firefox-devices.json），成套给，不单独改。
   */
  screen?: DeviceScreen;
  devicePixelRatio?: number;
  webgl?: { vendor: string; renderer: string };
  webrtc: { mode: WebrtcMode };
  /**
   * 网页问"我在哪"的时候给什么。默认跟着代理出口走——时区和语言都跟了，
   * 定位不跟就是个一查就发现的矛盾。
   */
  geolocation: Geolocation;
  disableSpoofing: string[];
};

export type Geolocation =
  /** 跟着代理出口。没配代理、或者查不到出口坐标，就不动它。 */
  | { mode: "exit" }
  /** 自己填的经纬度。 */
  | { mode: "custom"; latitude: number; longitude: number }
  /** 不动它：网页问到的是这台电脑真实的位置。 */
  | { mode: "real" }
  /** 整个禁掉：网页根本要不到位置，和用户点了"拒绝"一样。 */
  | { mode: "blocked" };

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
  /** 属于哪个文件夹。授权就是按它算的：文件夹开给谁，里面的环境他就看得到。 */
  folderId: string;
  tags: string[];
  note: string;
  profile: FingerprintProfile;
  proxyId: string | null;
  searchEngine: string;
  searchProvider?: { name: string; keyword: string; url: string; suggestUrl?: string };
  extensionIds: string[];
  /** 用哪一类内核。建好之后不能改：两类的指纹给法不一样，换类等于换了一台机器上的另一个浏览器。 */
  engine: EngineClass;
  /** 这个环境绑定的内核版本（属于上面那一类）。不会自动跟着新版本走：换内核等于换浏览器版本，由用户决定。 */
  kernelVersion: string;
  /** 时区和语言跟着代理出口走（成对改）。关掉就用画像里手选的地区。 */
  followExit: boolean;
  /**
   * 这个环境的登录态只留在这台电脑上，不同步到云端。
   * 配置（名字、画像、绑的代理）照常同步——不然换电脑之后连这个环境都看不到。
   */
  localOnly?: boolean;
  allowNoSandbox: boolean;
  extraFlags: string[];
  deletedAt: number | null;
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
  hardware: {
    screenW: number;
    screenH: number;
    colorDepth: number;
    dpr: number;
    /** 浏览器窗口的外框。真机上它不可能比屏幕大。 */
    outerW: number;
    outerH: number;
  };
  timezone: string;
  locale: string;
  webdriver: boolean | null;
  canvasHash: string;
  webglVendor: string;
  webglRenderer: string;
  webrtcIps: string[];
  collectedAt: number;
  /** kernel = 在内核窗口里采的（CDP 或 BiDi）；page = 工作台自己页面上的对照组。 */
  source: "page" | "kernel";
};

export type AppSettings = {
  allowNoSandboxHost: boolean;
  /** 内核还在预览通道时，用户明确同意后才允许准入和启动。 */
  allowPreviewKernel: boolean;
  /** 用户想不想开本机 API。真正能不能开还要看档位。 */
  apiEnabled: boolean;
  onboarded: boolean;
  /** 外观。system = 跟着操作系统走。 */
  theme: "system" | "light" | "dark";
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

/**
 * 成套预设：一个平台上真实存在的配置才会被抽到。
 * 核数按机型给——macOS 这几年都是 Apple 芯片（8 核起），Windows 从 4 核的办公本到 24 核的台式机都有。
 */
export const CORES_BY_PLATFORM: Record<PlatformId, number[]> = {
  windows: [4, 6, 8, 8, 12, 12, 16, 16, 20, 24],
  macos: [8, 8, 10, 10, 12, 14, 16],
  linux: [4, 8, 8, 12, 16],
};

/** 常见的窗口大小。新建时只从放得进这台电脑屏幕的里面抽。 */
export const WINDOW_SIZES = [
  { width: 1280, height: 720 },
  { width: 1366, height: 768 },
  { width: 1440, height: 900 },
  { width: 1536, height: 864 },
  { width: 1600, height: 900 },
  { width: 1920, height: 1080 },
];

type Size = { width: number; height: number };

export type DeviceScreen = {
  width: number;
  height: number;
  availWidth: number;
  availHeight: number;
  colorDepth: number;
};

/** 一台真机上成套的几项：核数、屏幕、缩放、显卡。数据来自 Camoufox 项目收集的真实设备（MIT 许可）。 */
export type Device = {
  cores: number;
  screen: DeviceScreen;
  dpr: number;
  webgl: { vendor: string; renderer: string };
};

export const FIREFOX_DEVICES: Record<PlatformId, Device[]> = devices;

/** 这台电脑显示器的物理像素。拿不到（测试里）就是 null。 */
export function realPhysical(): Size | null {
  const s = realScreen();
  if (!s || typeof window === "undefined") return null;
  const dpr = window.devicePixelRatio || 1;
  return { width: Math.round(window.screen.width * dpr), height: Math.round(window.screen.height * dpr) };
}

/** 一个像样的浏览器窗口至少这么宽。缩放太大、窗口放不下，这台设备在这台显示器上就用不了。 */
const MIN_WINDOW_WIDTH = 1280;

/**
 * 这台显示器上用得了的设备。Firefox 类的缩放是真的缩放（页面真的按那个比例显示，
 * 这样 devicePixelRatio 和媒体查询才对得上），所以 2 倍缩放的设备放不进一块 1920 的显示器。
 */
export function usableDevices(platform: PlatformId, physical: Size | null = realPhysical()): Device[] {
  const all = FIREFOX_DEVICES[platform];
  if (!physical) return all;
  const fit = all.filter((d) => physical.width / d.dpr >= MIN_WINDOW_WIDTH);
  return fit.length ? fit : all.filter((d) => d.dpr === Math.min(...all.map((x) => x.dpr)));
}

/** Firefox 类的窗口要同时放得进伪装出来的屏幕、和这台显示器按缩放折算后的大小。 */
export function deviceWindowBounds(device: Pick<Device, "screen" | "dpr">, physical: Size | null = realPhysical()): Size {
  const byScreen = { width: device.screen.availWidth, height: device.screen.availHeight };
  if (!physical) return byScreen;
  return {
    width: Math.min(byScreen.width, Math.floor(physical.width / device.dpr)),
    height: Math.min(byScreen.height, Math.floor(physical.height / device.dpr)),
  };
}

/** 一个环境的窗口最大能多大。Chromium 类看这台电脑的屏幕；Firefox 类还要看它自己的屏幕和缩放。 */
export function windowBoundsOf(env: Pick<Environment, "engine" | "profile">): Size | null {
  const p = env.profile;
  if (env.engine === "firefox" && p.screen && p.devicePixelRatio) {
    return deviceWindowBounds({ screen: p.screen, dpr: p.devicePixelRatio });
  }
  return realScreen();
}

export function deviceLabel(d: Device): string {
  const gpu = d.webgl.renderer.replace(/^ANGLE \((?:[^,]+, )?/, "").replace(/ Direct3D.*$|, or similar$|\)$/g, "");
  return `${d.screen.width}×${d.screen.height}${d.dpr === 1 ? "" : ` @${d.dpr}x`}，${d.cores} 核，${gpu}`;
}

/** 这台电脑屏幕上能放窗口的区域。拿不到（测试里）就不限制。 */
export function realScreen(): Size | null {
  if (typeof window === "undefined" || !window.screen?.availWidth) return null;
  return { width: window.screen.availWidth, height: window.screen.availHeight };
}

/**
 * 窗口不能比真实屏幕大：outerWidth > screen.width 在真机上不会出现，网页一比就知道。
 * 环境从大屏电脑导到小屏电脑时，启动前在这里收一下。
 */
export function fitWindow(size: Size, screen: Size | null = realScreen()): Size {
  if (!screen) return size;
  return { width: Math.min(size.width, screen.width), height: Math.min(size.height, screen.height) };
}

export function windowSizesThatFit(screen: Size | null = realScreen()): Size[] {
  const fit = WINDOW_SIZES.filter((s) => !screen || (s.width <= screen.width && s.height <= screen.height));
  return fit.length ? fit : [fitWindow(WINDOW_SIZES[0]!, screen)];
}

export const DEFAULT_REGION: Region = REGIONS.find((r) => r.country === "US") ?? REGIONS[0]!;

/** 地区决定的三样东西，永远成对改。 */
export function regionFields(region: Region, timezone?: string) {
  return {
    timezone: timezone && region.timezones.includes(timezone) ? timezone : region.timezones[0]!,
    locale: region.locale,
    languages: [...region.languages],
  };
}

export function profileFromSeed(
  seed: string,
  platform: PlatformId,
  extras?: Partial<FingerprintProfile>,
  engine: EngineClass = "chromium",
): FingerprintProfile {
  const n = Number.parseInt(seed, 10) >>> 0;
  const rnd = mulberry32(n || 1);
  const pick = <T,>(arr: T[]) => arr[Math.floor(rnd() * arr.length)] as T;
  // 抽的顺序固定：同一个种子、同一个平台、同一类内核，得到的永远是同一套。
  const region = regionFields(DEFAULT_REGION);
  const base = {
    schema: PROFILE_SCHEMA,
    seed,
    seedLocked: true,
    platform,
    platformVersion: extras?.platformVersion ?? defaultPlatformVersion(platform),
    brandVersion: extras?.brandVersion ?? BUNDLED_KERNEL_VERSION,
    locale: extras?.locale ?? region.locale,
    languages: extras?.languages ?? region.languages,
    timezone: extras?.timezone ?? region.timezone,
    webrtc: extras?.webrtc ?? { mode: "replace" as const },
    geolocation: extras?.geolocation ?? { mode: "exit" as const },
    disableSpoofing: extras?.disableSpoofing ?? [],
  };
  if (engine === "firefox") {
    // 一台真机上成套的几项一起抽：屏幕、缩放、显卡、核数不会各抽各的。
    const device = pick(usableDevices(platform));
    const bounds = deviceWindowBounds(device);
    const size = pick(windowSizesThatFit(bounds));
    return {
      ...base,
      brand: "Firefox",
      hardwareConcurrency: extras?.hardwareConcurrency ?? device.cores,
      window: extras?.window ?? size,
      screen: extras?.screen ?? device.screen,
      devicePixelRatio: extras?.devicePixelRatio ?? device.dpr,
      webgl: extras?.webgl ?? device.webgl,
    };
  }
  const cores = pick(CORES_BY_PLATFORM[platform]);
  const size = pick(windowSizesThatFit());
  return {
    ...base,
    brand: extras?.brand ?? "Chrome",
    hardwareConcurrency: extras?.hardwareConcurrency ?? cores,
    window: extras?.window ?? size,
  };
}

/**
 * 安装包自带清单里的内核版本。只在问不到本机服务时兜底用（比如首次引导时服务还没起来）；
 * 正常情况下版本列表和默认版本都来自本机服务。
 */
export const BUNDLED_KERNEL_VERSION = "148.0.7778.215";


export function newEnvironment(partial?: Partial<Environment>): Environment {
  const now = Date.now();
  const seed = randomSeed();
  return {
    id: makeId("env"),
    name: partial?.name ?? "Untitled",
    folderId: partial?.folderId ?? "default",
    tags: partial?.tags ?? [],
    note: partial?.note ?? "",
    profile: partial?.profile ?? profileFromSeed(seed, "windows"),
    proxyId: partial?.proxyId ?? null,
    searchEngine: partial?.searchEngine ?? "none",
    searchProvider: partial?.searchProvider,
    extensionIds: partial?.extensionIds ?? [],
    engine: partial?.engine ?? "chromium",
    kernelVersion: partial?.kernelVersion ?? BUNDLED_KERNEL_VERSION,
    followExit: partial?.followExit ?? true,
    localOnly: partial?.localOnly ?? false,
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
  };
}



/* ── 自动化流程 ─────────────────────────────────────────────
   和本机服务的 workflow.rs 一一对应。步骤参数里可以写 {{变量}}。
   循环节点放在循环体之后：走到它就回头，范围必须整个在它前面。 */

export type WorkflowStep =
  | { type: "open"; url: string }
  | { type: "click"; selector: string }
  | { type: "type"; selector: string; text: string }
  | { type: "press"; key: "Enter" | "Tab" | "Escape" }
  | { type: "scroll"; selector: string; dy: number }
  | { type: "waitFor"; selector: string; timeoutMs: number }
  | { type: "sleep"; ms: number }
  | { type: "extract"; selector: string; var: string }
  | { type: "if"; var: string; op: "contains" | "equals" | "notEmpty"; value: string; goto: number }
  | { type: "loop"; from: number; to: number; times: number };

export type OnFail = { mode: "retry"; times: number } | { mode: "skip" } | { mode: "stop" };

export type WorkflowStepDef = WorkflowStep & { onFail: OnFail };

export type Workflow = {
  id: string;
  name: string;
  steps: WorkflowStepDef[];
  updatedAt: number;
};

export function newWorkflow(name: string): Workflow {
  return { id: `wf_${Math.random().toString(36).slice(2, 10)}`, name, steps: [], updatedAt: Date.now() };
}
