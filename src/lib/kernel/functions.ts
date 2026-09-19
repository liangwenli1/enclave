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

export const getKernelStatusFn = createServerFn({ method: "GET" }).handler(async () => {
  const host = await import("./host.server");
  const status = await host.readStatus();
  const runtimes = await host.listRuntimesFresh();
  return {
    status,
    kernel: host.kernelPublicView(),
    capabilities: host.hostCapabilities(),
    runtimes,
  };
});

export const startKernelDownloadFn = createServerFn({ method: "POST" }).handler(async () => {
  const host = await import("./host.server");
  return host.startDownload();
});

export const startEnvFn = createServerFn({ method: "POST" })
  .validator(
    z.object({
      envId: z.string(),
      profile: profileSchema,
      extraFlags: z.array(z.string()),
      allowNoSandbox: z.boolean(),
      proxyServer: z.string().optional(),
    }),
  )
  .handler(async ({ data }) => {
    const host = await import("./host.server");
    return host.startEnvironment(data);
  });

export const stopEnvFn = createServerFn({ method: "POST" })
  .validator(z.object({ envId: z.string() }))
  .handler(async ({ data }) => {
    const host = await import("./host.server");
    return host.stopEnvironment(data.envId);
  });

export const collectCdpFn = createServerFn({ method: "POST" })
  .validator(z.object({ envId: z.string() }))
  .handler(async ({ data }) => {
    const host = await import("./host.server");
    return host.collectCdp(data.envId);
  });

export const probeProxyFn = createServerFn({ method: "POST" })
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
