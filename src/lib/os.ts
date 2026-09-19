import type { FingerprintProfile, PlatformId } from "@/lib/schema";

export const WIN10_VERSION = "10.0.19045";
export const WIN11_VERSION = "10.0.26100";

export function windowsEdition(version: string): "10" | "11" {
  const build = Number(version.split(".")[2] ?? 0);
  return build >= 22000 ? "11" : "10";
}

export function platformLabel(profile: Pick<FingerprintProfile, "platform" | "platformVersion">) {
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
