import { readFile } from "node:fs/promises";
import path from "node:path";
import type { FingerprintProfile, LabSnapshot } from "@/lib/schema";

export type KernelRecord = {
  id: string;
  version: string;
  platform: string;
  channel: string;
  url: string;
  filename: string;
  sha256: string;
  bytes: number;
  signature: string;
  publisher: string;
  releasedAt: string;
  upstream: string;
  license: string;
  notes: string;
};

export type KernelStatus = {
  state:
    | "absent"
    | "downloading"
    | "verifying"
    | "extracting"
    | "admitted"
    | "hash_mismatch"
    | "error";
  bytesReceived: number;
  bytesExpected: number;
  sha256Expected: string;
  sha256Actual?: string;
  signature: "missing" | "verified";
  executable?: string;
  error?: string;
  admittedAt?: number;
};

export type StartResult =
  | {
      ok: true;
      pid: number;
      port: number;
      debugAddress: "127.0.0.1";
      sha256: string;
      warned: string[];
      userDataDir: string;
    }
  | { ok: false; code: string; message: string };

const HOST = process.env.ENCLAVE_HOST_URL ?? "http://127.0.0.1:17891";
const TOKEN_PATH = path.join(process.cwd(), "data", "host.token");

async function hostToken(): Promise<string> {
  try {
    return (await readFile(TOKEN_PATH, "utf8")).trim();
  } catch {
    return "";
  }
}

async function hostFetch(pathname: string, init?: RequestInit): Promise<Response> {
  const token = await hostToken();
  return fetch(`${HOST}${pathname}`, {
    ...init,
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(init?.headers ?? {}),
    },
    signal: init?.signal ?? AbortSignal.timeout(20_000),
  });
}

function unavailableStatus(error: string): KernelStatus {
  return {
    state: "error",
    bytesReceived: 0,
    bytesExpected: 0,
    sha256Expected: "",
    signature: "missing",
    error,
  };
}

export async function readStatus(): Promise<KernelStatus> {
  try {
    const res = await hostFetch("/v1/kernel");
    if (!res.ok) return unavailableStatus(`host HTTP ${res.status}`);
    const body = (await res.json()) as { status: KernelStatus };
    return body.status;
  } catch (e) {
    return unavailableStatus(e instanceof Error ? e.message : String(e));
  }
}

export async function startDownload(): Promise<KernelStatus> {
  try {
    const res = await hostFetch("/v1/kernel/admit", { method: "POST", body: "{}" });
    if (!res.ok) return unavailableStatus(`host HTTP ${res.status}`);
    return (await res.json()) as KernelStatus;
  } catch (e) {
    return unavailableStatus(e instanceof Error ? e.message : String(e));
  }
}

export async function startEnvironment(input: {
  envId: string;
  profile: FingerprintProfile;
  extraFlags: string[];
  allowNoSandbox: boolean;
  proxyServer?: string;
  searchEngine?: string;
}): Promise<StartResult> {
  try {
    const res = await hostFetch("/v1/environments/start", {
      method: "POST",
      body: JSON.stringify(input),
    });
    return (await res.json()) as StartResult;
  } catch (e) {
    return {
      ok: false,
      code: "HOST_UNAVAILABLE",
      message: e instanceof Error ? e.message : String(e),
    };
  }
}

export async function stopEnvironment(envId: string): Promise<{ ok: boolean }> {
  try {
    const res = await hostFetch("/v1/environments/stop", {
      method: "POST",
      body: JSON.stringify({ envId }),
    });
    return (await res.json()) as { ok: boolean };
  } catch {
    return { ok: false };
  }
}

export async function listRuntimesFresh() {
  try {
    const res = await hostFetch("/v1/runtimes");
    if (!res.ok) return [];
    return (await res.json()) as Array<{
      envId: string;
      pid: number;
      port: number;
      debugAddress: "127.0.0.1";
      startedAt: number;
      sha256: string;
      userDataDir: string;
    }>;
  } catch {
    return [];
  }
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

export async function hostCapabilities() {
  try {
    const res = await fetch(`${HOST}/v1/health`, { signal: AbortSignal.timeout(2000) });
    const body = (await res.json()) as { capabilities?: Record<string, unknown> };
    return (
      body.capabilities ?? {
        host: "rust",
        os: process.platform,
        arch: process.arch,
        uid: null,
        display: false,
        loopbackOnly: true,
        headlessForced: true,
        sandboxLikely: false,
        runtime: "native",
      }
    );
  } catch {
    return {
      host: "rust-down",
      os: process.platform,
      arch: process.arch,
      uid: typeof process.getuid === "function" ? process.getuid() : null,
      display: Boolean(process.env.DISPLAY),
      loopbackOnly: true,
      headlessForced: true,
      sandboxLikely: false,
      runtime: "native",
    };
  }
}

export async function kernelPublicView() {
  try {
    const res = await hostFetch("/v1/kernel");
    const body = (await res.json()) as {
      kernel: { manifest: KernelRecord; previousStable: KernelRecord | null; channel: string; kernels?: KernelRecord[] };
    };
    return body.kernel;
  } catch {
    return {
      manifest: {
        id: "fingerprint-chromium",
        version: "unknown",
        platform: "linux-x64",
        channel: "stable",
        url: "",
        filename: "",
        sha256: "",
        bytes: 0,
        signature: "missing",
        publisher: "",
        releasedAt: "",
        upstream: "",
        license: "BSD-3-Clause",
        notes: "rust host unreachable",
      },
      previousStable: null,
      channel: "stable",
    };
  }
}

export function proxyServerUrl(proxy: {
  protocol: string;
  host: string;
  port: number;
  username?: string;
  password?: string;
}): string {
  const auth =
    proxy.username && proxy.password
      ? `${encodeURIComponent(proxy.username)}:${encodeURIComponent(proxy.password)}@`
      : "";
  return `${proxy.protocol}://${auth}${proxy.host}:${proxy.port}`;
}
