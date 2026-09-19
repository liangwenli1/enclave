import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

const profileSchema = z.object({
  schema: z.literal("fingerprint-profile/v1"),
  seed: z.string(),
  seedLocked: z.boolean(),
  platform: z.enum(["windows", "macos", "linux"]),
  platformVersion: z.string(),
  brand: z.enum(["Chrome", "Edge", "Opera", "Vivaldi"]),
  brandVersion: z.string(),
  hardwareConcurrency: z.number(),
  locale: z.string(),
  languages: z.array(z.string()),
  timezone: z.string(),
  screen: z.object({
    width: z.number(),
    height: z.number(),
    colorDepth: z.number(),
    pixelRatio: z.number(),
  }),
  webrtc: z.object({ mode: z.enum(["replace", "disable"]) }),
  disableSpoofing: z.array(z.string()),
  lockedFields: z.array(z.string()),
});

const DIRECT = import.meta.env.VITE_ENCLAVE_DIRECT === "true";

function dataOf<T>(input: T | { data: T }): T {
  if (input && typeof input === "object" && "data" in (input as object)) {
    return (input as { data: T }).data;
  }
  return input;
}

const getKernelStatusServer = createServerFn({ method: "GET" }).handler(async () => {
  const host = await import("./host.server");
  const [status, runtimes, kernel, capabilities] = await Promise.all([
    host.readStatus(),
    host.listRuntimesFresh(),
    host.kernelPublicView(),
    host.hostCapabilities(),
  ]);
  return { status, kernel, capabilities, runtimes };
});

export async function getKernelStatusFn() {
  if (DIRECT) return (await import("./host.direct")).getKernelStatus();
  return getKernelStatusServer();
}

const startKernelDownloadServer = createServerFn({ method: "POST" }).handler(async () => {
  const host = await import("./host.server");
  return host.startDownload();
});

export async function startKernelDownloadFn() {
  if (DIRECT) return (await import("./host.direct")).startDownload();
  return startKernelDownloadServer();
}

const listSearchEnginesServer = createServerFn({ method: "GET" })
  .validator(z.object({ envId: z.string() }))
  .handler(async ({ data }) => {
    const host = await import("./host.server");
    return host.listSearchEngines(data.envId);
  });

export async function listSearchEnginesFn(input: { data: { envId: string } } | { envId: string }) {
  const data = dataOf(input);
  if (DIRECT) return (await import("./host.direct")).listSearchEngines(data.envId);
  return listSearchEnginesServer({ data });
}

const startEnvServer = createServerFn({ method: "POST" })
  .validator(
    z.object({
      envId: z.string(),
      profile: profileSchema,
      extraFlags: z.array(z.string()),
      allowNoSandbox: z.boolean(),
      proxyServer: z.string().optional(),
      searchEngine: z.string().optional(),
      searchProvider: z
        .object({
          name: z.string(),
          keyword: z.string(),
          url: z.string(),
          suggestUrl: z.string().optional(),
        })
        .optional(),
    }),
  )
  .handler(async ({ data }) => {
    const host = await import("./host.server");
    return host.startEnvironment(data);
  });

export async function startEnvFn(input: { data: {
    envId: string;
    profile: z.infer<typeof profileSchema>;
    extraFlags: string[];
    allowNoSandbox: boolean;
    proxyServer?: string;
    searchEngine?: string;
    searchProvider?: { name: string; keyword: string; url: string; suggestUrl?: string };
  } }) {
  const data = dataOf(input);
  if (DIRECT) return (await import("./host.direct")).startEnvironment(data);
  return startEnvServer({ data });
}

const stopEnvServer = createServerFn({ method: "POST" })
  .validator(z.object({ envId: z.string() }))
  .handler(async ({ data }) => {
    const host = await import("./host.server");
    return host.stopEnvironment(data.envId);
  });

export async function stopEnvFn(input: { data: { envId: string } }) {
  const data = dataOf(input);
  if (DIRECT) return (await import("./host.direct")).stopEnvironment(data.envId);
  return stopEnvServer({ data });
}

const collectCdpServer = createServerFn({ method: "POST" })
  .validator(z.object({ envId: z.string() }))
  .handler(async ({ data }) => {
    const host = await import("./host.server");
    return host.collectCdp(data.envId);
  });

export async function collectCdpFn(input: { data: { envId: string } }) {
  const data = dataOf(input);
  if (DIRECT) return (await import("./host.direct")).collectCdp(data.envId);
  return collectCdpServer({ data });
}

const probeProxyServer = createServerFn({ method: "POST" })
  .validator(
    z.object({
      protocol: z.enum(["http", "https", "socks5"]),
      host: z.string(),
      port: z.number(),
    }),
  )
  .handler(async ({ data }) => {
    const started = Date.now();
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 5000);
      const res = await fetch("https://api.ipify.org?format=json", {
        signal: controller.signal,
      });
      clearTimeout(timer);
      const json = (await res.json()) as { ip?: string };
      return {
        ok: res.ok,
        latencyMs: Date.now() - started,
        exitIp: json.ip,
        note: "Workbench geo probe does not route through the environment proxy. Kernel egress uses --proxy-server at spawn.",
      };
    } catch (err) {
      return {
        ok: false,
        latencyMs: Date.now() - started,
        error: err instanceof Error ? err.message : String(err),
        target: `${data.protocol}://${data.host}:${data.port}`,
      };
    }
  });

export async function probeProxyFn(input: {
  data: { protocol: "http" | "https" | "socks5"; host: string; port: number };
}) {
  const data = dataOf(input);
  if (DIRECT) return (await import("./host.direct")).probeProxy();
  return probeProxyServer({ data });
}

const getHostTokenServer = createServerFn({ method: "GET" }).handler(async () => {
  const { readFile } = await import("node:fs/promises");
  try {
    const token = (await readFile("data/host.token", "utf8")).trim();
    return { ok: true as const, token, bind: "127.0.0.1:17891" };
  } catch {
    return { ok: false as const, token: "", bind: "127.0.0.1:17891" };
  }
});

export async function getHostTokenFn() {
  if (DIRECT) return { ok: true as const, token: "", bind: "127.0.0.1:17891" };
  return getHostTokenServer();
}
