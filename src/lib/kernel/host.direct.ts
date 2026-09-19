import type { FingerprintProfile, LabSnapshot } from "@/lib/schema";
import type { KernelStatus, SearchEngineRow, StartResult } from "./host.server";

const HOST = "http://127.0.0.1:17891";

async function hostFetch(pathname: string, init?: RequestInit): Promise<Response> {
  return fetch(`${HOST}${pathname}`, {
    ...init,
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      ...(init?.headers ?? {}),
    },
    signal: init?.signal ?? AbortSignal.timeout(20_000),
  });
}

function downStatus(message: string) {
  return {
    status: {
      state: "error" as const,
      bytesReceived: 0,
      bytesExpected: 0,
      sha256Expected: "",
      signature: "missing" as const,
      error: message,
    },
    kernel: {
      manifest: { sha256: "", id: "fingerprint-chromium", version: "unknown" },
      previousStable: null,
      channel: "stable",
    },
    capabilities: {
      host: "rust-down",
      os: "win32",
      uid: null,
      sandboxLikely: false,
    },
    runtimes: [] as unknown[],
  };
}

export async function getKernelStatus() {
  try {
    const res = await hostFetch("/v1/kernel");
    if (!res.ok) return downStatus(`host HTTP ${res.status}`);
    const body = (await res.json()) as {
      status: KernelStatus;
      kernel: unknown;
      capabilities: unknown;
      runtimes: unknown;
    };
    return {
      status: body.status,
      kernel: body.kernel,
      capabilities: body.capabilities,
      runtimes: Array.isArray(body.runtimes) ? body.runtimes : [],
    };
  } catch (e) {
    return downStatus(e instanceof Error ? e.message : "HOST_UNAVAILABLE");
  }
}

export async function startDownload(): Promise<KernelStatus> {
  const res = await hostFetch("/v1/kernel/admit", { method: "POST", body: "{}" });
  return (await res.json()) as KernelStatus;
}

export async function startEnvironment(input: {
  envId: string;
  profile: FingerprintProfile;
  extraFlags: string[];
  allowNoSandbox: boolean;
  proxyServer?: string;
  searchEngine?: string;
  searchProvider?: { name: string; keyword: string; url: string; suggestUrl?: string };
}): Promise<StartResult> {
  const res = await hostFetch("/v1/environments/start", {
    method: "POST",
    body: JSON.stringify(input),
  });
  return (await res.json()) as StartResult;
}

export async function stopEnvironment(envId: string): Promise<{ ok: boolean }> {
  const res = await hostFetch("/v1/environments/stop", {
    method: "POST",
    body: JSON.stringify({ envId }),
  });
  return (await res.json()) as { ok: boolean };
}

export async function listSearchEngines(envId: string) {
  const res = await hostFetch(`/v1/search-engines?envId=${encodeURIComponent(envId)}`);
  if (!res.ok) return { ok: false as const, engines: [] as SearchEngineRow[] };
  return (await res.json()) as { ok: boolean; engines: SearchEngineRow[] };
}

export async function collectCdp(envId: string): Promise<LabSnapshot> {
  const res = await hostFetch("/v1/lab/collect", {
    method: "POST",
    body: JSON.stringify({ envId }),
  });
  const body = (await res.json()) as { ok: boolean; snapshot?: LabSnapshot; message?: string };
  if (!body.ok || !body.snapshot) {
    throw new Error(body.message ?? "CDP_HANDSHAKE_FAILED");
  }
  return body.snapshot;
}

export async function probeProxy() {
  const started = Date.now();
  try {
    const res = await fetch("https://api.ipify.org?format=json", { signal: AbortSignal.timeout(5000) });
    const json = (await res.json()) as { ip?: string };
    return {
      ok: res.ok,
      latencyMs: Date.now() - started,
      exitIp: json.ip,
      note: "Workbench geo probe does not route through the environment proxy.",
    };
  } catch (err) {
    return {
      ok: false,
      latencyMs: Date.now() - started,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
