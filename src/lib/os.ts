import type { FingerprintProfile, PlatformId } from "@/lib/schema";

/** 这台电脑的系统。Chrome 内核的指纹平台跟着它走，改不了。 */
export function thisPlatform(): PlatformId {
  const ua = typeof navigator === "undefined" ? "" : navigator.userAgent;
  if (/Mac OS X|Macintosh/.test(ua)) return "macos";
  if (/Windows/.test(ua)) return "windows";
  return "linux";
}

export const WIN10_VERSION = "10.0.0";
export const WIN11_VERSION = "19.0.0";

export function windowsEdition(version: string): "10" | "11" {
  const parts = version.split(".").map((n) => Number(n) || 0);
  const major = parts[0] ?? 0;
  const build = parts[2] ?? 0;
  if (major >= 13) return "11";
  if (build >= 22000) return "11";
  return "10";
}

export function platformLabel(profile: Pick<FingerprintProfile, "platform" | "platformVersion" | "brand">) {
  // Firefox 的 UA 里 Windows 10 和 11 是同一个写法，这一类不分。
  if (profile.platform === "windows" && profile.brand === "Firefox") return "Windows";
  if (profile.platform === "windows") {
    return windowsEdition(profile.platformVersion) === "11" ? "Windows 11" : "Windows 10";
  }
  if (profile.platform === "macos") return "macOS";
  return "Linux";
}

export function defaultWinVersion(edition: "10" | "11") {
  return edition === "11" ? WIN11_VERSION : WIN10_VERSION;
}

export function defaultPlatformVersion(platform: PlatformId, winEdition: "10" | "11" = "11") {
  if (platform === "windows") return defaultWinVersion(winEdition);
  if (platform === "macos") return "15.2.0";
  return "6.12.8";
}
