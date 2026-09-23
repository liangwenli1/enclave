import assert from "node:assert/strict";
import { test } from "node:test";
import { snapshotChecks, staticConsistency } from "./consistency.ts";
import { REGIONS, regionOfCountry } from "./regions.ts";
import {
  CORES_BY_PLATFORM,
  fitWindow,
  newEnvironment,
  profileFromSeed,
  regionFields,
  windowSizesThatFit,
  type LabSnapshot,
} from "./schema.ts";

const find = (checks: ReturnType<typeof staticConsistency>, id: string) => checks.find((c) => c.id === id);

test("同一个种子、同一个平台，得到的是同一套；核数只从这个平台真实存在的里面抽", () => {
  assert.deepEqual(profileFromSeed("12345", "macos"), profileFromSeed("12345", "macos"));
  for (const platform of ["windows", "macos", "linux"] as const) {
    for (let seed = 1; seed < 300; seed += 7) {
      const p = profileFromSeed(String(seed), platform);
      assert.ok(CORES_BY_PLATFORM[platform].includes(p.hardwareConcurrency), `${platform} ${p.hardwareConcurrency}`);
      assert.equal(p.languages[0], p.locale);
    }
  }
  // Apple 芯片没有 4 核的。
  assert.ok(!CORES_BY_PLATFORM.macos.includes(4));
});

test("地区的三样东西成对改", () => {
  const jp = regionOfCountry("jp")!;
  assert.deepEqual(regionFields(jp), { timezone: "Asia/Tokyo", locale: "ja", languages: ["ja", "en-US", "en"] });
  const us = regionOfCountry("US")!;
  assert.equal(regionFields(us, "America/Chicago").timezone, "America/Chicago");
  // 不属于这个国家的时区不会被留下来。
  assert.equal(regionFields(us, "Asia/Tokyo").timezone, us.timezones[0]);
  assert.equal(new Set(REGIONS.flatMap((r) => r.timezones)).size, REGIONS.flatMap((r) => r.timezones).length);
});

test("窗口不会比真实屏幕大", () => {
  const laptop = { width: 1366, height: 728 };
  assert.deepEqual(fitWindow({ width: 1920, height: 1080 }, laptop), laptop);
  assert.deepEqual(fitWindow({ width: 1280, height: 720 }, laptop), { width: 1280, height: 720 });
  assert.deepEqual(fitWindow({ width: 1920, height: 1080 }, null), { width: 1920, height: 1080 });
  assert.ok(windowSizesThatFit(laptop).every((w) => w.width <= 1366 && w.height <= 728));
  // 屏幕比最小的预设还小：给一个收进屏幕里的，而不是空列表。
  assert.deepEqual(windowSizesThatFit({ width: 1024, height: 600 }), [{ width: 1024, height: 600 }]);
});

test("时区和语言不是一对：提醒", () => {
  const env = newEnvironment({
    profile: profileFromSeed("7", "windows", { ...regionFields(regionOfCountry("JP")!), locale: "en-US", languages: ["en-US", "en"] }),
    followExit: false,
  });
  const region = find(staticConsistency(env, undefined), "region")!;
  assert.equal(region.warn, true);
  assert.match(region.detail, /日本/);
  const paired = newEnvironment({ profile: profileFromSeed("7", "windows", regionFields(regionOfCountry("DE")!)) });
  assert.equal(find(staticConsistency(paired, undefined), "region")!.ok, true);
});

test("出口国家和地区：跟着出口走就不算问题，不跟就要对得上", () => {
  const profile = profileFromSeed("7", "windows", regionFields(regionOfCountry("US")!));
  const proxy = { id: "p", name: "p", protocol: "socks5" as const, host: "h", port: 1, country: "DE" };
  const following = newEnvironment({ profile, followExit: true });
  assert.equal(find(staticConsistency(following, proxy), "geo")!.warn, false);
  const manual = newEnvironment({ profile, followExit: false });
  const geo = find(staticConsistency(manual, proxy), "geo")!;
  assert.equal(geo.ok, false);
  assert.match(geo.detail, /德国/);
  // 实测到的出口比代理上手填的国家可信。
  assert.equal(find(staticConsistency(manual, proxy, { exitCountry: "US" }), "geo")!.ok, true);
  // 表里没有的国家：只对齐时区，语言不动，要让用户知道。
  assert.equal(find(staticConsistency(following, proxy, { exitCountry: "KZ" }), "geo")!.warn, true);
});

test("平台上少见的核数、比屏幕大的窗口：提醒但不判错", () => {
  const env = newEnvironment({
    profile: profileFromSeed("7", "macos", { hardwareConcurrency: 4, window: { width: 2560, height: 1440 } }),
  });
  const checks = staticConsistency(env, undefined, { screen: { width: 1920, height: 1040 } });
  assert.equal(find(checks, "cores-platform")!.warn, true);
  assert.equal(find(checks, "window")!.warn, true);
  assert.equal(find(staticConsistency(env, undefined, { screen: null }), "window"), undefined);
});

const snap = (
  over: Partial<Omit<LabSnapshot, "hardware">> & { hardware?: Partial<LabSnapshot["hardware"]> },
): LabSnapshot => ({
  userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36",
  platform: "Win32",
  vendor: "Google Inc.",
  language: "de-DE",
  languages: ["de-DE", "de", "en-US", "en"],
  hardwareConcurrency: 8,
  deviceMemory: 16,
  maxTouchPoints: 0,
  timezone: "Europe/Berlin",
  locale: "de",
  webdriver: false,
  canvasHash: "abc",
  webglVendor: "v",
  webglRenderer: "r",
  webrtcIps: [],
  collectedAt: 0,
  source: "kernel",
  ...over,
  hardware: { screenW: 1920, screenH: 1080, colorDepth: 24, dpr: 1, outerW: 1536, outerH: 864, ...over.hardware },
});

test("窗口里实测：语言、Intl、platform、窗口都对得上时全过", () => {
  const profile = profileFromSeed("7", "windows", { ...regionFields(regionOfCountry("DE")!), hardwareConcurrency: 8 });
  const bad = snapshotChecks(profile, snap({})).filter((c) => !c.ok || c.warn);
  assert.deepEqual(bad.map((c) => c.id), []);
});

test("窗口里实测：抓得到的矛盾", () => {
  const profile = profileFromSeed("7", "windows", { ...regionFields(regionOfCountry("DE")!), hardwareConcurrency: 8 });
  const ids = (s: LabSnapshot) => snapshotChecks(profile, s).filter((c) => !c.ok || c.warn).map((c) => c.id);
  // 只传了 --lang 没设环境变量时的样子：语言是德语，日期数字却按英语格式化。
  assert.deepEqual(ids(snap({ locale: "en-US" })), ["intl"]);
  assert.deepEqual(ids(snap({ platform: "MacIntel" })), ["ua-platform"]);
  assert.deepEqual(ids(snap({ language: "en-US", languages: ["en-US", "en"], locale: "en-US" })), ["lang-live"]);
  assert.deepEqual(ids(snap({ hardware: { outerW: 2560, outerH: 1440 } })), ["window-screen"]);
  // 无头模式下窗口外框是 0，不算矛盾。
  assert.deepEqual(ids(snap({ hardware: { outerW: 0, outerH: 0 } })), []);
});

/* ── Firefox 类 ─────────────────────────────────────────────────────── */

import { FIREFOX_DEVICES, deviceWindowBounds, usableDevices, windowBoundsOf } from "./schema.ts";

test("Firefox 类：屏幕、缩放、显卡、核数来自同一台真机，成套抽", () => {
  for (const platform of ["windows", "macos", "linux"] as const) {
    for (let seed = 1; seed < 200; seed += 9) {
      const p = profileFromSeed(String(seed), platform, {}, "firefox");
      assert.equal(p.brand, "Firefox");
      const device = FIREFOX_DEVICES[platform].find(
        (d) =>
          d.screen.width === p.screen?.width &&
          d.dpr === p.devicePixelRatio &&
          d.webgl.renderer === p.webgl?.renderer &&
          d.cores === p.hardwareConcurrency,
      );
      assert.ok(device, `${platform} 种子 ${seed} 抽出来的不是表里的某一台`);
      // 窗口放得进它自己的屏幕。
      assert.ok(p.window.width <= p.screen!.availWidth && p.window.height <= p.screen!.availHeight);
    }
  }
  assert.deepEqual(profileFromSeed("77", "windows", {}, "firefox"), profileFromSeed("77", "windows", {}, "firefox"));
  // Chromium 类的画像里没有这三项：那一类的内核改不了它们，给了就是骗人。
  const chromium = profileFromSeed("77", "windows");
  assert.equal(chromium.screen, undefined);
  assert.equal(chromium.webgl, undefined);
});

test("Firefox 类：只给这台显示器上用得了的设备，窗口按缩放折算", () => {
  const fullHd = { width: 1920, height: 1080 };
  // 缩放是真的缩放：2 倍的设备在 1920 的显示器上窗口只能到 960 宽，用不了。
  assert.ok(usableDevices("windows", fullHd).every((d) => d.dpr <= 1.5));
  assert.ok(usableDevices("windows", { width: 3840, height: 2160 }).some((d) => d.dpr === 2));
  // macOS 的真机多数是 2 倍屏；1920 的显示器上只剩 1 倍的那些，但不会是空的。
  const mac = usableDevices("macos", fullHd);
  assert.ok(mac.length > 0 && mac.every((d) => d.dpr === 1));
  assert.equal(usableDevices("windows", null).length, FIREFOX_DEVICES.windows.length);

  const device = { screen: { width: 2560, height: 1440, availWidth: 2560, availHeight: 1400, colorDepth: 24 }, dpr: 1.5 };
  assert.deepEqual(deviceWindowBounds(device, fullHd), { width: 1280, height: 720 });
  assert.deepEqual(deviceWindowBounds(device, null), { width: 2560, height: 1400 });
  const env = newEnvironment({ engine: "firefox", profile: profileFromSeed("5", "windows", {}, "firefox") });
  assert.deepEqual(windowBoundsOf(env), { width: env.profile.screen!.availWidth, height: env.profile.screen!.availHeight });
});

test("Firefox 类：窗口里实测到的要就是画像里那一套", () => {
  const profile = profileFromSeed("7", "windows", { ...regionFields(regionOfCountry("DE")!), brandVersion: "152.0.4-beta.30" }, "firefox");
  const good = snap({
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:152.0) Gecko/20100101 Firefox/152.0",
    hardwareConcurrency: profile.hardwareConcurrency,
    deviceMemory: null,
    webglVendor: profile.webgl!.vendor,
    webglRenderer: profile.webgl!.renderer,
    hardware: {
      screenW: profile.screen!.width,
      screenH: profile.screen!.height,
      dpr: profile.devicePixelRatio!,
      outerW: profile.window.width,
      outerH: profile.window.height,
    },
  });
  const ids = (s: LabSnapshot) => snapshotChecks(profile, s, "firefox").filter((c) => !c.ok || c.warn).map((c) => c.id);
  assert.deepEqual(ids(good), []);
  assert.ok(!snapshotChecks(profile, good, "firefox").some((c) => c.id === "memory"), "Firefox 没有 deviceMemory");
  // UA 的版本不是正在跑的内核、或者带着 Camoufox 的名字，都算错。
  assert.deepEqual(ids({ ...good, userAgent: good.userAgent.replaceAll("152.0", "148.0") }), ["ua"]);
  assert.deepEqual(ids({ ...good, userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:152.0) Gecko/20100101 Camoufox/152.0.4" }), ["ua"]);
  assert.deepEqual(ids({ ...good, hardware: { ...good.hardware, screenW: 1600, screenH: 900 } }), ["screen-live"]);
  assert.deepEqual(ids({ ...good, hardware: { ...good.hardware, dpr: profile.devicePixelRatio! + 0.5 } }), ["dpr-live"]);
  assert.deepEqual(ids({ ...good, webglRenderer: "llvmpipe, or similar" }), ["webgl-live"]);
  assert.deepEqual(ids({ ...good, webglRenderer: "none" }), ["webgl-live"]);
});

test("Firefox 类：没有成套设备的环境要指出来；核数不按 Chromium 的表比", () => {
  const broken = newEnvironment({ engine: "firefox", profile: profileFromSeed("7", "macos", { hardwareConcurrency: 2 }) });
  const checks = staticConsistency(broken, undefined);
  assert.equal(find(checks, "device")?.ok, false);
  assert.equal(find(checks, "cores-platform"), undefined);
});
