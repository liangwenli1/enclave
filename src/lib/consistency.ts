/**
 * 一致性检查：一个环境自己的各项设置之间、设置和内核窗口里实测到的值之间，对不对得上。
 *
 * 风控看的不是某一项"像不像真的"，而是各项之间矛盾不矛盾：时区在东京、语言是英语；
 * 窗口比屏幕还大；UA 说 Windows、platform 说 Mac。这里只做能确定的判断，拿不准的给提醒而不是判错。
 *
 * 这个文件不碰 DOM，运行时只用相对路径引用，所以能直接在 node 里测。
 */
import { primaryLanguage, regionOfCountry, regionOfTimezone } from "./regions.ts";
import type { EngineClass } from "./kernel/host-api.ts";
import {
  CORES_BY_PLATFORM,
  type Environment,
  type FingerprintProfile,
  type LabSnapshot,
  type ProxyItem,
} from "./schema.ts";

export type Check = {
  id: string;
  ok: boolean;
  warn?: boolean;
  label: string;
  detail: string;
};

type Size = { width: number; height: number };

/**
 * 不启动就能看出来的问题。
 * `exitCountry` 是上次启动时实测到的出口国家；没有就用代理上手填的那个。
 * `screen` 是这台电脑的屏幕，传 null 表示不知道（不检查窗口）。
 */
export function staticConsistency(
  env: Environment,
  proxy: ProxyItem | undefined,
  opts: { exitCountry?: string; screen?: Size | null } = {},
): Check[] {
  const p = env.profile;
  const checks: Check[] = [];
  checks.push({
    id: "seed",
    ok: /^\d+$/.test(p.seed) && p.seed !== "0",
    label: "画像种子",
    detail: p.seedLocked ? `${p.seed}，已锁定` : `${p.seed}，未锁定`,
  });
  if (p.brandVersion !== env.kernelVersion) {
    checks.push({
      id: "brand-version",
      ok: false,
      label: "浏览器版本",
      detail: `画像报 ${p.brandVersion}，内核是 ${env.kernelVersion}`,
    });
  }

  // 时区和语言是不是一对。
  const home = regionOfTimezone(p.timezone);
  if (home) {
    const paired = primaryLanguage(p.locale) === primaryLanguage(home.locale);
    checks.push({
      id: "region",
      ok: paired,
      warn: !paired,
      label: "时区与语言",
      detail: paired
        ? `${home.name}：${p.timezone}，${p.locale}`
        : `时区在${home.name}，语言却是 ${p.locale}（当地通常是 ${home.locale}）`,
    });
  }

  // 出口在哪个国家，时区和语言就该是哪个国家的。
  const country = (opts.exitCountry ?? proxy?.country ?? "").toUpperCase();
  if (country) {
    const exit = regionOfCountry(country);
    const source = opts.exitCountry ? "实测出口" : "代理填的国家";
    if (env.followExit) {
      checks.push({
        id: "geo",
        ok: true,
        warn: !exit,
        label: "出口与地区",
        detail: exit
          ? `${source} ${exit.name}；启动时时区和语言按它设置`
          : `${source} ${country} 不在地区预设里：启动时只对齐时区，语言保持 ${p.locale}`,
      });
    } else {
      const aligned = !exit || exit.timezones.includes(p.timezone);
      checks.push({
        id: "geo",
        ok: aligned,
        warn: !aligned,
        label: "出口与地区",
        detail: aligned
          ? `${source} ${exit?.name ?? country} ↔ ${p.timezone}`
          : `${source}是${exit?.name}，时区却是 ${p.timezone}。打开「跟着代理出口走」，或者把地区改成${exit?.name}`,
      });
    }
  }

  // Firefox 类的核数跟着整台设备走，不单独比。
  if (env.engine === "chromium" && !CORES_BY_PLATFORM[p.platform].includes(p.hardwareConcurrency)) {
    checks.push({
      id: "cores-platform",
      ok: true,
      warn: true,
      label: "核数与平台",
      detail: `${p.hardwareConcurrency} 核在 ${p.platform} 上很少见`,
    });
  }

  if (opts.screen && (p.window.width > opts.screen.width || p.window.height > opts.screen.height)) {
    checks.push({
      id: "window",
      ok: true,
      warn: true,
      label: "窗口大小",
      detail:
        env.engine === "firefox"
          ? `窗口 ${p.window.width}×${p.window.height} 放不进这个环境的屏幕和这台显示器（按缩放折算后最多 ${opts.screen.width}×${opts.screen.height}），启动时会收进去`
          : `窗口 ${p.window.width}×${p.window.height} 比这台电脑的屏幕（${opts.screen.width}×${opts.screen.height}）大，启动时会收到屏幕以内`,
    });
  }
  if (env.engine === "firefox" && (!p.screen || !p.devicePixelRatio || !p.webgl)) {
    checks.push({
      id: "device",
      ok: false,
      label: "设备",
      detail: "这个 Firefox 类环境没有成套的设备（屏幕、缩放、显卡）。到指纹页选一台。",
    });
  }

  if (env.allowNoSandbox || env.extraFlags.some((f) => f.includes("no-sandbox"))) {
    checks.push({
      id: "sandbox",
      ok: false,
      warn: true,
      label: "沙箱",
      detail: "这个环境会以 --no-sandbox 启动",
    });
  }
  return checks;
}

const UA_PLATFORM: Array<[RegExp, RegExp, string]> = [
  [/Windows NT/, /^Win/, "Windows"],
  [/Macintosh/, /^Mac/, "macOS"],
  [/Linux|X11/, /^Linux/, "Linux"],
];

/** "152.0.4-beta.30" → "152"。 */
const major = (version: string) => version.match(/^\d+/)?.[0] ?? "";

/** 在内核窗口里实测到的值，和画像、和它们彼此之间对不对得上。两类内核能核对的项不一样。 */
export function snapshotChecks(
  profile: FingerprintProfile,
  snap: LabSnapshot,
  engine: EngineClass = "chromium",
): Check[] {
  const firefox = engine === "firefox";
  // Firefox 类：UA 里的版本必须就是正在跑的内核的主版本，而且不能带着 Camoufox 自己的名字。
  const uaOk = firefox
    ? snap.userAgent.includes(`Firefox/${major(profile.brandVersion)}.`) &&
      snap.userAgent.includes(`rv:${major(profile.brandVersion)}.`) &&
      !snap.userAgent.includes("Camoufox")
    : snap.userAgent.includes("Chrome/") && !snap.userAgent.includes("HeadlessChrome");
  const fromKernel = snap.source === "kernel";
  const uaFamily = UA_PLATFORM.find(([ua]) => ua.test(snap.userAgent));
  const platformOk = !uaFamily || uaFamily[1].test(snap.platform);
  const intlOk = primaryLanguage(snap.locale) === primaryLanguage(snap.language);
  const { screenW, screenH, outerW, outerH, dpr } = snap.hardware;
  // 无头模式下外框是 0，没有可比的。
  const windowOk = outerW === 0 || (outerW <= screenW && outerH <= screenH);
  const checks: Check[] = [
    {
      id: "webdriver",
      ok: snap.webdriver !== true,
      label: "webdriver 标记",
      detail: snap.webdriver === true ? "暴露了（异常）" : "未暴露",
    },
    {
      id: "ua",
      ok: uaOk,
      warn: snap.userAgent.includes("Headless"),
      label: "User-Agent",
      detail: snap.userAgent.slice(0, 140),
    },
    {
      id: "ua-platform",
      ok: platformOk,
      label: "UA 与 platform",
      detail: platformOk
        ? `${uaFamily?.[2] ?? "—"} ↔ ${snap.platform}`
        : `UA 说是 ${uaFamily?.[2]}，navigator.platform 却是 ${snap.platform}`,
    },
    {
      id: "cores",
      ok: snap.hardwareConcurrency === profile.hardwareConcurrency || !fromKernel,
      warn: !fromKernel,
      label: "CPU 核数",
      detail: `窗口 ${snap.hardwareConcurrency}，画像 ${profile.hardwareConcurrency}`,
    },
    {
      id: "tz-live",
      ok: snap.timezone === profile.timezone || !fromKernel,
      warn: !fromKernel,
      label: "实际时区",
      detail: `窗口 ${snap.timezone}，画像 ${profile.timezone}`,
    },
    {
      id: "lang-live",
      ok: snap.language === profile.locale || !fromKernel,
      warn: !fromKernel,
      label: "实际语言",
      detail: `窗口 ${snap.languages.join("、")}，画像 ${profile.languages.join("、")}`,
    },
    {
      id: "intl",
      ok: intlOk,
      warn: !intlOk,
      label: "语言与 Intl 区域",
      detail: intlOk
        ? `navigator.language ${snap.language} ↔ Intl ${snap.locale}`
        : `navigator.language 是 ${snap.language}，日期和数字却按 ${snap.locale} 格式化。macOS 上内核取的是系统语言，只能把系统语言改成一致的`,
    },
    {
      id: "window-screen",
      ok: windowOk,
      label: "窗口与屏幕",
      detail: windowOk
        ? `屏幕 ${screenW}×${screenH}，缩放 ${dpr}（${firefox ? "这个环境自己的" : "来自这台电脑，所有环境相同"}）${outerW ? `；窗口 ${outerW}×${outerH}` : ""}`
        : `窗口 ${outerW}×${outerH} 比屏幕 ${screenW}×${screenH} 还大，真机上不会出现`,
    },
    {
      id: "canvas",
      ok: Boolean(snap.canvasHash),
      label: "Canvas 指纹",
      detail: snap.canvasHash.slice(0, 16),
    },
    {
      id: "webgl",
      ok: Boolean(snap.webglRenderer),
      label: "WebGL",
      detail: `${snap.webglVendor} / ${snap.webglRenderer}`,
    },
    {
      id: "webrtc",
      ok: profile.webrtc.mode !== "disable" || snap.webrtcIps.length === 0,
      warn: snap.webrtcIps.length > 0 && profile.webrtc.mode !== "disable",
      label: "WebRTC 暴露的 IP",
      detail: snap.webrtcIps.join(", ") || "没有暴露",
    },
  ];
  if (!firefox) {
    // Firefox 没有 navigator.deviceMemory。
    checks.push({
      id: "memory",
      ok: true,
      label: "内存",
      detail: snap.deviceMemory === null ? "页面读不到" : `${snap.deviceMemory} GB（由种子决定）`,
    });
    return checks;
  }
  // 这一类的屏幕、缩放、显卡是环境给的：窗口里实测到的必须就是画像里那一套。
  if (profile.screen) {
    const same = screenW === profile.screen.width && screenH === profile.screen.height;
    checks.push({
      id: "screen-live",
      ok: same || !fromKernel,
      label: "实际屏幕",
      detail: `窗口 ${screenW}×${screenH}，画像 ${profile.screen.width}×${profile.screen.height}`,
    });
  }
  if (profile.devicePixelRatio) {
    checks.push({
      id: "dpr-live",
      ok: Math.abs(dpr - profile.devicePixelRatio) < 0.01 || !fromKernel,
      label: "实际缩放",
      detail: `窗口 ${dpr}，画像 ${profile.devicePixelRatio}`,
    });
  }
  if (profile.webgl) {
    const unavailable = snap.webglRenderer === "none" || snap.webglRenderer === "";
    checks.push({
      id: "webgl-live",
      ok: unavailable || snap.webglRenderer === profile.webgl.renderer || !fromKernel,
      warn: unavailable,
      label: "实际显卡",
      detail: unavailable
        ? "这台电脑上 WebGL 不可用，网站读不到显卡——这本身就少见"
        : `窗口 ${snap.webglRenderer}`,
    });
  }
  return checks;
}

export function diffSnaps(a?: LabSnapshot, b?: LabSnapshot): { field: string; a: string; b: string; same: boolean }[] {
  if (!a || !b) return [];
  const rows = [
    ["userAgent", a.userAgent, b.userAgent],
    ["platform", a.platform, b.platform],
    ["timezone", a.timezone, b.timezone],
    ["language", a.languages.join(","), b.languages.join(",")],
    ["intl", a.locale, b.locale],
    ["screen", `${a.hardware.screenW}x${a.hardware.screenH}@${a.hardware.dpr}`, `${b.hardware.screenW}x${b.hardware.screenH}@${b.hardware.dpr}`],
    ["memory", String(a.deviceMemory), String(b.deviceMemory)],
    ["cores", String(a.hardwareConcurrency), String(b.hardwareConcurrency)],
    ["canvas", a.canvasHash, b.canvasHash],
    ["webgl", `${a.webglVendor}|${a.webglRenderer}`, `${b.webglVendor}|${b.webglRenderer}`],
    ["webdriver", String(a.webdriver), String(b.webdriver)],
    ["webrtc", a.webrtcIps.join(","), b.webrtcIps.join(",")],
  ] as const;
  return rows.map(([field, left, right]) => ({
    field,
    a: left,
    b: right,
    same: left === right,
  }));
}

