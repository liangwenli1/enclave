import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, readFileSync } from "node:fs";
import {
  access,
  chmod,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { CDP_COLLECT_SOURCE } from "@/lib/lab-script";
import type { FingerprintProfile, LabSnapshot, PlatformId } from "@/lib/schema";
import { classifyAll } from "@/lib/kernel/flags";

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

type ManifestFile = {
  channel: string;
  kernels: KernelRecord[];
  previousStable: KernelRecord | null;
};

function loadManifest(): ManifestFile {
  const file = path.join(process.cwd(), "kernels.manifest.json");
  return JSON.parse(readFileSync(file, "utf8")) as ManifestFile;
}

const MANIFEST = loadManifest();
export const STABLE_KERNEL = MANIFEST.kernels[0] as KernelRecord;

const ROOT = path.join(process.cwd(), "data");
const KERNEL_ROOT = path.join(ROOT, "kernels");
const DOWNLOADS = path.join(KERNEL_ROOT, "downloads");
const PROFILES = path.join(ROOT, "profiles");
const STATUS_PATH = path.join(KERNEL_ROOT, "status.json");
const RUNTIMES_PATH = path.join(ROOT, "runtimes.json");

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

type RuntimeProc = {
  envId: string;
  pid: number;
  port: number;
  child?: ChildProcess;
  userDataDir: string;
  startedAt: number;
  sha256: string;
};

type GlobalReg = {
  download?: Promise<void>;
  verifyJob?: Promise<void>;
  status: KernelStatus;
  runtimes: Map<string, RuntimeProc>;
};

const g = globalThis as typeof globalThis & { __enclaveHost?: GlobalReg };

function registry(): GlobalReg {
  if (!g.__enclaveHost) {
    g.__enclaveHost = {
      status: {
        state: "absent",
        bytesReceived: 0,
        bytesExpected: STABLE_KERNEL.bytes,
        sha256Expected: STABLE_KERNEL.sha256,
        signature: "missing",
      },
      runtimes: new Map(),
    };
  }
  return g.__enclaveHost;
}

async function ensureDirs() {
  await mkdir(DOWNLOADS, { recursive: true });
  await mkdir(PROFILES, { recursive: true });
  await mkdir(KERNEL_ROOT, { recursive: true });
}

function archivePath() {
  return path.join(DOWNLOADS, STABLE_KERNEL.filename);
}

function extractDir() {
  return path.join(KERNEL_ROOT, `${STABLE_KERNEL.id}-${STABLE_KERNEL.version}`);
}

async function sha256File(file: string): Promise<string> {
  const hash = createHash("sha256");
  await pipeline(createReadStream(file), hash);
  return hash.digest("hex");
}

async function findChrome(dir: string): Promise<string | null> {
  const names = new Set(["chrome", "chromium", "ungoogled-chromium", "chrome-wrapper"]);
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop();
    if (!cur) continue;
    let entries: string[] = [];
    try {
      entries = await readdir(cur);
    } catch {
      continue;
    }
    for (const name of entries) {
      const full = path.join(cur, name);
      let st;
      try {
        st = await stat(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        if (name !== "resources" && name !== "locales") stack.push(full);
      } else if (names.has(name) && st.mode & 0o111) {
        return full;
      } else if (names.has(name)) {
        try {
          await chmod(full, 0o755);
          return full;
        } catch {
          return full;
        }
      }
    }
  }
  return null;
}

async function persistStatus() {
  const { status } = registry();
  await writeFile(STATUS_PATH, JSON.stringify(status, null, 2));
}

export async function readStatus(): Promise<KernelStatus> {
  await ensureDirs();
  const reg = registry();
  if (
    reg.status.state === "downloading" ||
    reg.status.state === "verifying" ||
    reg.status.state === "extracting"
  ) {
    return reg.status;
  }
  try {
    const parsed = JSON.parse(await readFile(STATUS_PATH, "utf8")) as KernelStatus;
    if (parsed?.state) reg.status = { ...reg.status, ...parsed };
  } catch {
    /* first run */
  }
  const exe = await resolveExecutable();
  let size = 0;
  try {
    size = (await stat(archivePath())).size;
  } catch {
    reg.status = {
      state: "absent",
      bytesReceived: 0,
      bytesExpected: STABLE_KERNEL.bytes,
      sha256Expected: STABLE_KERNEL.sha256,
      signature: "missing",
    };
    return reg.status;
  }
  const hashCached = reg.status.sha256Actual === STABLE_KERNEL.sha256;
  if (exe && size === STABLE_KERNEL.bytes && hashCached) {
    reg.status = {
      ...reg.status,
      state: "admitted",
      executable: exe,
      bytesReceived: size,
      bytesExpected: STABLE_KERNEL.bytes,
      sha256Expected: STABLE_KERNEL.sha256,
      signature: "missing",
    };
    return reg.status;
  }
  if (exe && size === STABLE_KERNEL.bytes) {
    if (!reg.verifyJob) {
      reg.verifyJob = (async () => {
        try {
          const ok = await verifyOnDisk();
          reg.status = {
            state: ok.ok ? "admitted" : "hash_mismatch",
            bytesReceived: size,
            bytesExpected: STABLE_KERNEL.bytes,
            sha256Expected: STABLE_KERNEL.sha256,
            sha256Actual: ok.actual,
            signature: "missing",
            executable: exe,
            error: ok.ok ? undefined : ok.reason,
            admittedAt: ok.ok ? Date.now() : undefined,
          };
          await persistStatus();
        } finally {
          reg.verifyJob = undefined;
        }
      })();
    }
    return {
      ...reg.status,
      state: "verifying",
      bytesReceived: size,
      bytesExpected: STABLE_KERNEL.bytes,
      sha256Expected: STABLE_KERNEL.sha256,
      executable: exe,
      signature: "missing",
    };
  }
  reg.status = {
    state: "absent",
    bytesReceived: size,
    bytesExpected: STABLE_KERNEL.bytes,
    sha256Expected: STABLE_KERNEL.sha256,
    signature: "missing",
  };
  return reg.status;
}

export async function resolveExecutable(): Promise<string | null> {
  return findChrome(extractDir());
}

export async function verifyOnDisk(): Promise<{ ok: boolean; actual?: string; reason?: string }> {
  const archive = archivePath();
  try {
    await access(archive);
  } catch {
    return { ok: false, reason: "KERNEL_UNTRUSTED_SOURCE: archive missing" };
  }
  const st = await stat(archive);
  if (st.size !== STABLE_KERNEL.bytes) {
    return {
      ok: false,
      reason: `size ${st.size} != ${STABLE_KERNEL.bytes}`,
      actual: undefined,
    };
  }
  const actual = await sha256File(archive);
  if (actual !== STABLE_KERNEL.sha256) {
    return { ok: false, actual, reason: "KERNEL_HASH_MISMATCH" };
  }
  const exe = await findChrome(extractDir());
  if (!exe) return { ok: false, actual, reason: "executable missing after extract" };
  return { ok: true, actual };
}

async function extractArchive() {
  const dest = extractDir();
  await rm(dest, { recursive: true, force: true });
  await mkdir(dest, { recursive: true });
  await new Promise<void>((resolve, reject) => {
    const child = spawn("tar", ["--no-same-owner", "-xJf", archivePath(), "-C", dest], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let err = "";
    child.stderr.on("data", (d: Buffer) => {
      err += d.toString();
    });
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(err || `tar exit ${code}`));
    });
  });
}

export async function startDownload(): Promise<KernelStatus> {
  const reg = registry();
  if (reg.download) return reg.status;
  if (reg.status.state === "admitted") return reg.status;
  await ensureDirs();
  reg.download = (async () => {
    try {
      reg.status = {
        state: "downloading",
        bytesReceived: 0,
        bytesExpected: STABLE_KERNEL.bytes,
        sha256Expected: STABLE_KERNEL.sha256,
        signature: "missing",
      };
      await persistStatus();
      const res = await fetch(STABLE_KERNEL.url, {
        headers: { "user-agent": "EnclaveKernelManager/1.0" },
        redirect: "follow",
      });
      if (!res.ok || !res.body) {
        throw new Error(`download HTTP ${res.status}`);
      }
      const file = archivePath();
      const tmp = `${file}.part`;
      const out = createWriteStream(tmp);
      const reader = res.body.getReader();
      let received = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        received += value.byteLength;
        out.write(Buffer.from(value));
        reg.status.bytesReceived = received;
      }
      await new Promise<void>((resolve, reject) => {
        out.end(() => resolve());
        out.on("error", reject);
      });
      const { rename } = await import("node:fs/promises");
      await rename(tmp, file);
      reg.status.state = "verifying";
      await persistStatus();
      const actual = await sha256File(file);
      reg.status.sha256Actual = actual;
      if (actual !== STABLE_KERNEL.sha256) {
        reg.status.state = "hash_mismatch";
        reg.status.error = "KERNEL_HASH_MISMATCH";
        await persistStatus();
        return;
      }
      reg.status.state = "extracting";
      await persistStatus();
      await extractArchive();
      const exe = await findChrome(extractDir());
      if (!exe) throw new Error("chrome executable not found in archive");
      await chmod(exe, 0o755).catch(() => undefined);
      reg.status = {
        state: "admitted",
        bytesReceived: STABLE_KERNEL.bytes,
        bytesExpected: STABLE_KERNEL.bytes,
        sha256Expected: STABLE_KERNEL.sha256,
        sha256Actual: actual,
        signature: "missing",
        executable: exe,
        admittedAt: Date.now(),
      };
      await persistStatus();
    } catch (err) {
      reg.status.state = "error";
      reg.status.error = err instanceof Error ? err.message : String(err);
      await persistStatus();
    } finally {
      reg.download = undefined;
    }
  })();
  return reg.status;
}

function pickFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        server.close();
        reject(new Error("port bind failed"));
        return;
      }
      const port = addr.port;
      server.close(() => resolve(port));
    });
    server.on("error", reject);
  });
}

export function buildLaunchArgs(input: {
  profile: FingerprintProfile;
  userDataDir: string;
  port: number;
  proxyServer?: string;
  extraFlags: string[];
  allowNoSandbox: boolean;
}): { args: string[]; rejected: string[]; warned: string[] } {
  const { profile } = input;
  const args = [
    `--user-data-dir=${input.userDataDir}`,
    `--fingerprint=${profile.seed}`,
    `--fingerprint-platform=${profile.platform}`,
    `--fingerprint-platform-version=${profile.platformVersion}`,
    `--fingerprint-brand=${profile.brand}`,
    `--fingerprint-brand-version=${profile.brandVersion}`,
    `--fingerprint-hardware-concurrency=${profile.hardwareConcurrency}`,
    `--lang=${profile.locale}`,
    `--accept-lang=${profile.languages.join(",")}`,
    `--timezone=${profile.timezone}`,
    `--window-size=${profile.screen.width},${profile.screen.height}`,
    `--remote-debugging-port=${input.port}`,
    "--remote-debugging-address=127.0.0.1",
    "--remote-allow-origins=http://127.0.0.1",
    "--disable-non-proxied-udp",
    "--headless=new",
    "--disable-gpu",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-sync",
    "--mute-audio",
  ];
  if (profile.webrtc.mode === "disable") {
    args.push("--disable-webrtc");
  }
  if (profile.disableSpoofing.length) {
    args.push(`--disable-spoofing=${profile.disableSpoofing.join(",")}`);
  }
  if (input.proxyServer) args.push(`--proxy-server=${input.proxyServer}`);
  if (input.allowNoSandbox) args.push("--no-sandbox", "--disable-gpu-sandbox");
  const extra = input.extraFlags.map((f) => (f.startsWith("--") ? f : `--${f}`));
  const classified = classifyAll(extra);
  const rejected = classified.filter((f) => f.cls === "reject").map((f) => f.raw);
  const warned = classified.filter((f) => f.cls === "warn").map((f) => f.raw);
  if (rejected.length) return { args, rejected, warned };
  args.push(...classified.filter((f) => f.cls !== "reject").map((f) => f.raw));
  return { args, rejected, warned };
}

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

export async function startEnvironment(input: {
  envId: string;
  profile: FingerprintProfile;
  extraFlags: string[];
  allowNoSandbox: boolean;
  proxyServer?: string;
}): Promise<StartResult> {
  const reg = registry();
  const existing = reg.runtimes.get(input.envId);
  if (existing) {
    return {
      ok: true,
      pid: existing.pid,
      port: existing.port,
      debugAddress: "127.0.0.1",
      sha256: existing.sha256,
      warned: [],
      userDataDir: existing.userDataDir,
    };
  }
  const verified = await verifyOnDisk();
  if (!verified.ok) {
    return {
      ok: false,
      code: verified.reason?.includes("HASH") ? "KERNEL_HASH_MISMATCH" : "KERNEL_UNTRUSTED_SOURCE",
      message: verified.reason ?? "verify failed",
    };
  }
  const exe = await resolveExecutable();
  if (!exe) {
    return { ok: false, code: "KERNEL_UNTRUSTED_SOURCE", message: "executable missing" };
  }
  const port = await pickFreePort();
  const userDataDir = path.join(PROFILES, `env_${input.envId}`, "user-data");
  await mkdir(userDataDir, { recursive: true });
  const built = buildLaunchArgs({
    profile: input.profile,
    userDataDir,
    port,
    proxyServer: input.proxyServer,
    extraFlags: input.extraFlags,
    allowNoSandbox: input.allowNoSandbox,
  });
  if (built.rejected.length) {
    return {
      ok: false,
      code: "SANDBOX_DISABLED_BLOCKED",
      message: `Rejected flags: ${built.rejected.join(", ")}`,
    };
  }
  const child = spawn(exe, built.args, {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, TZ: input.profile.timezone },
  });
  let stderr = "";
  child.stderr.on("data", (d: Buffer) => {
    stderr += d.toString();
    if (stderr.length > 8000) stderr = stderr.slice(-8000);
  });
  const pid = child.pid;
  if (!pid) {
    return { ok: false, code: "SPAWN_FAILED", message: "no pid" };
  }
  const runtime: RuntimeProc = {
    envId: input.envId,
    pid,
    port,
    child,
    userDataDir,
    startedAt: Date.now(),
    sha256: verified.actual ?? STABLE_KERNEL.sha256,
  };
  child.on("exit", () => {
    const cur = reg.runtimes.get(input.envId);
    if (cur?.pid === pid) reg.runtimes.delete(input.envId);
  });
  const ready = await waitForCdp(port, 12000);
  if (!ready) {
    child.kill("SIGKILL");
    reg.runtimes.delete(input.envId);
    const sandboxHint =
      /no sandbox|namespace|zygote|running as root/i.test(stderr) && !input.allowNoSandbox;
    return {
      ok: false,
      code: sandboxHint ? "SANDBOX_UNAVAILABLE" : "SPAWN_FAILED",
      message: sandboxHint
        ? "Chromium sandbox cannot start on this host. Acknowledge --no-sandbox to continue."
        : stderr.slice(-1200) || "CDP did not come up",
    };
  }
  reg.runtimes.set(input.envId, runtime);
  await persistRuntimes();
  return {
    ok: true,
    pid,
    port,
    debugAddress: "127.0.0.1",
    sha256: runtime.sha256,
    warned: built.warned,
    userDataDir,
  };
}

async function waitForCdp(port: number, timeoutMs: number): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`, {
        signal: AbortSignal.timeout(800),
      });
      if (res.ok) return true;
    } catch {
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  return false;
}

async function persistRuntimes() {
  const rows = listRuntimes();
  await writeFile(RUNTIMES_PATH, JSON.stringify(rows, null, 2));
}

async function restoreRuntime(envId: string): Promise<RuntimeProc | null> {
  const existing = registry().runtimes.get(envId);
  if (existing) return existing;
  try {
    const rows = JSON.parse(await readFile(RUNTIMES_PATH, "utf8")) as Array<{
      envId: string;
      pid: number;
      port: number;
      userDataDir: string;
      startedAt: number;
      sha256: string;
    }>;
    const row = rows.find((r) => r.envId === envId);
    if (!row) return null;
    try {
      process.kill(row.pid, 0);
    } catch {
      return null;
    }
    const ready = await waitForCdp(row.port, 1500);
    if (!ready) return null;
    const rt: RuntimeProc = { ...row };
    registry().runtimes.set(envId, rt);
    return rt;
  } catch {
    return null;
  }
}

export async function stopEnvironment(envId: string): Promise<{ ok: boolean }> {
  const reg = registry();
  const rt = (await restoreRuntime(envId)) ?? reg.runtimes.get(envId);
  if (!rt) return { ok: true };
  try {
    if (rt.child) rt.child.kill("SIGTERM");
    else process.kill(rt.pid, "SIGTERM");
  } catch {
    /* already dead */
  }
  await new Promise((r) => setTimeout(r, 400));
  try {
    process.kill(rt.pid, "SIGKILL");
  } catch {
    /* gone */
  }
  reg.runtimes.delete(envId);
  await persistRuntimes();
  return { ok: true };
}

export function listRuntimes() {
  return [...registry().runtimes.values()].map((r) => ({
    envId: r.envId,
    pid: r.pid,
    port: r.port,
    debugAddress: "127.0.0.1" as const,
    startedAt: r.startedAt,
    sha256: r.sha256,
    userDataDir: r.userDataDir,
  }));
}

export async function listRuntimesFresh() {
  try {
    const rows = JSON.parse(await readFile(RUNTIMES_PATH, "utf8")) as Array<{ envId: string }>;
    for (const row of rows) {
      await restoreRuntime(row.envId);
    }
  } catch {
    /* none */
  }
  return listRuntimes();
}

async function pageWebSocket(port: number): Promise<string> {
  type Target = { type?: string; webSocketDebuggerUrl?: string; url?: string };
  const listed = (await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json())) as Target[];
  const page = listed.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
  if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
  const version = (await fetch(`http://127.0.0.1:${port}/json/version`).then((r) => r.json())) as {
    webSocketDebuggerUrl?: string;
  };
  const browserWs = version.webSocketDebuggerUrl;
  if (!browserWs) throw new Error("no debugger websocket");
  const ws = new WebSocket(browserWs);
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener("open", () => resolve());
    ws.addEventListener("error", () => reject(new Error("browser ws error")));
  });
  const created = await new Promise<string>((resolve, reject) => {
    const id = 1;
    const timer = setTimeout(() => reject(new Error("createTarget timeout")), 5000);
    ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(String(ev.data)) as { id?: number; result?: { targetId?: string } };
      if (msg.id === id) {
        clearTimeout(timer);
        resolve(msg.result?.targetId ?? "");
      }
    });
    ws.send(JSON.stringify({ id, method: "Target.createTarget", params: { url: "about:blank" } }));
  });
  ws.close();
  const again = (await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json())) as Target[];
  const next =
    again.find((t) => t.webSocketDebuggerUrl && t.url?.includes(created)) ??
    again.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
  if (!next?.webSocketDebuggerUrl) throw new Error("no page target after createTarget");
  return next.webSocketDebuggerUrl;
}

export async function collectCdp(envId: string): Promise<LabSnapshot> {
  const rt = await restoreRuntime(envId);
  if (!rt) throw new Error("environment is not running");
  const wsUrl = await pageWebSocket(rt.port);
  const raw = await cdpEvaluate(wsUrl, CDP_COLLECT_SOURCE);
  const canvasHash = await sha256String(String(raw.canvasSample ?? ""));
  return {
    userAgent: String(raw.userAgent ?? ""),
    platform: String(raw.platform ?? ""),
    vendor: String(raw.vendor ?? ""),
    language: String(raw.language ?? ""),
    languages: Array.isArray(raw.languages) ? raw.languages.map(String) : [],
    hardwareConcurrency: Number(raw.hardwareConcurrency ?? 0),
    deviceMemory: raw.deviceMemory == null ? null : Number(raw.deviceMemory),
    maxTouchPoints: Number(raw.maxTouchPoints ?? 0),
    hardware: {
      screenW: Number(raw.hardware?.screenW ?? 0),
      screenH: Number(raw.hardware?.screenH ?? 0),
      colorDepth: Number(raw.hardware?.colorDepth ?? 0),
      dpr: Number(raw.hardware?.dpr ?? 1),
    },
    timezone: String(raw.timezone ?? ""),
    locale: String(raw.locale ?? ""),
    webdriver: typeof raw.webdriver === "boolean" ? raw.webdriver : null,
    canvasHash,
    webglVendor: String(raw.webglVendor ?? ""),
    webglRenderer: String(raw.webglRenderer ?? ""),
    webrtcIps: Array.isArray(raw.webrtcIps) ? raw.webrtcIps.map(String) : [],
    collectedAt: Date.now(),
    source: "cdp",
  };
}

async function sha256String(input: string): Promise<string> {
  const { createHash: h } = await import("node:crypto");
  return h("sha256").update(input).digest("hex");
}

type CdpRaw = {
  userAgent?: string;
  platform?: string;
  vendor?: string;
  language?: string;
  languages?: string[];
  hardwareConcurrency?: number;
  deviceMemory?: number | null;
  maxTouchPoints?: number;
  hardware?: { screenW?: number; screenH?: number; colorDepth?: number; dpr?: number };
  timezone?: string;
  locale?: string;
  webdriver?: boolean | null;
  canvasSample?: string;
  webglVendor?: string;
  webglRenderer?: string;
  webrtcIps?: string[];
};

async function cdpEvaluate(wsUrl: string, expression: string): Promise<CdpRaw> {
  const ws = new WebSocket(wsUrl);
  let id = 0;
  const pending = new Map<number, (v: unknown) => void>();
  const send = (method: string, params?: Record<string, unknown>) => {
    const thisId = ++id;
    ws.send(JSON.stringify({ id: thisId, method, params }));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`cdp timeout ${method}`)), 8000);
      pending.set(thisId, (v) => {
        clearTimeout(timer);
        resolve(v);
      });
    });
  };
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener("open", () => resolve());
    ws.addEventListener("error", () => reject(new Error("cdp socket error")));
  });
  ws.addEventListener("message", (ev) => {
    const msg = JSON.parse(String(ev.data)) as { id?: number; result?: unknown };
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)?.(msg.result);
      pending.delete(msg.id);
    }
  });
  try {
    await send("Runtime.enable");
    const result = (await send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    })) as { result?: { value?: CdpRaw } };
    return result.result?.value ?? {};
  } finally {
    ws.close();
  }
}

export function hostCapabilities() {
  return {
    os: process.platform,
    arch: process.arch,
    uid: typeof process.getuid === "function" ? process.getuid() : null,
    display: Boolean(process.env.DISPLAY),
    vercel: Boolean(process.env.VERCEL),
    loopbackOnly: true,
    headlessForced: true,
    sandboxLikely: process.platform === "linux" && process.getuid?.() !== 0,
  };
}

export function kernelPublicView() {
  return {
    manifest: STABLE_KERNEL,
    previousStable: MANIFEST.previousStable,
    channel: MANIFEST.channel,
  };
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

export { type PlatformId };
