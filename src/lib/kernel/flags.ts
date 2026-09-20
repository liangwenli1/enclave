export type FlagClass = "allow" | "warn" | "reject";

export type ClassifiedFlag = {
  raw: string;
  name: string;
  cls: FlagClass;
  reason: string;
};

const ALLOW = new Set([
  "user-data-dir",
  "proxy-server",
  "proxy-bypass-list",
  "fingerprint",
  "fingerprint-platform",
  "fingerprint-platform-version",
  "fingerprint-brand",
  "fingerprint-brand-version",
  "fingerprint-hardware-concurrency",
  "disable-spoofing",
  "disable-non-proxied-udp",
  "disable-webrtc",
  "remote-debugging-port",
  "remote-debugging-address",
  "remote-allow-origins",
  "lang",
  "accept-lang",
  "timezone",
  "window-size",
  "headless",
  "disable-gpu",
  "no-first-run",
  "no-default-browser-check",
  "disable-sync",
  "disable-background-networking",
  "metrics-recording-only",
  "mute-audio",
  "hide-scrollbars",
  "font-render-hinting",
]);

const WARN = new Set([
  "no-sandbox",
  "disable-gpu-sandbox",
  "disable-setuid-sandbox",
  "disable-dev-shm-usage",
  "load-extension",
  "disable-extensions-except",
  "allow-running-insecure-content",
]);

const REJECT = new Set([
  "disable-web-security",
  "disable-site-isolation-trials",
  "disable-features",
  "host-resolver-rules",
  "remote-debugging-address",
]);

function flagName(raw: string): string {
  const trimmed = raw.trim().replace(/^--/, "");
  return trimmed.split("=")[0] ?? trimmed;
}

export function classifyFlag(raw: string): ClassifiedFlag {
  const name = flagName(raw);
  const value = raw.includes("=") ? raw.slice(raw.indexOf("=") + 1) : "";
  if (name === "remote-debugging-address" && value && value !== "127.0.0.1") {
    return {
      raw,
      name,
      cls: "reject",
      reason: "Debug address must be 127.0.0.1",
    };
  }
  if (name === "no-sandbox" || name === "disable-gpu-sandbox") {
    return { raw, name, cls: "warn", reason: "Disables Chromium sandbox" };
  }
  if (REJECT.has(name) && name !== "remote-debugging-address") {
    return { raw, name, cls: "reject", reason: "Not allowed on the launch whitelist" };
  }
  if (WARN.has(name)) {
    return { raw, name, cls: "warn", reason: "Risky; audited if used" };
  }
  if (ALLOW.has(name) || name.startsWith("fingerprint")) {
    return { raw, name, cls: "allow", reason: "Whitelisted" };
  }
  return { raw, name, cls: "reject", reason: "Unknown flag" };
}

export function classifyAll(flags: string[]): ClassifiedFlag[] {
  return flags.map(classifyFlag);
}


