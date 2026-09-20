import { PROXY_GEO_TZ, type Environment, type FingerprintProfile, type LabSnapshot, type ProxyItem } from "@/lib/schema";


export type Check = {
  id: string;
  ok: boolean;
  warn?: boolean;
  label: string;
  detail: string;
};

async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function canvasFingerprint(): string {
  try {
    const canvas = document.createElement("canvas");
    canvas.width = 280;
    canvas.height = 80;
    const ctx = canvas.getContext("2d");
    if (!ctx) return "no-2d";
    ctx.fillStyle = "#f60";
    ctx.fillRect(0, 0, 280, 80);
    ctx.fillStyle = "#069";
    ctx.font = "16px serif";
    ctx.fillText("Enclave.lab 🜂 148.0", 8, 32);
    ctx.strokeStyle = "rgba(40,120,80,0.7)";
    ctx.beginPath();
    ctx.arc(90, 40, 28, 0, Math.PI * 2);
    ctx.stroke();
    return canvas.toDataURL().slice(-96);
  } catch {
    return "canvas-blocked";
  }
}

function webglInfo(): { vendor: string; renderer: string } {
  try {
    const canvas = document.createElement("canvas");
    const gl = canvas.getContext("webgl") || canvas.getContext("experimental-webgl");
    if (!gl || !(gl instanceof WebGLRenderingContext)) {
      return { vendor: "none", renderer: "none" };
    }
    const ext = gl.getExtension("WEBGL_debug_renderer_info");
    const vendor = ext
      ? String(gl.getParameter(ext.UNMASKED_VENDOR_WEBGL))
      : String(gl.getParameter(gl.VENDOR));
    const renderer = ext
      ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL))
      : String(gl.getParameter(gl.RENDERER));
    return { vendor, renderer };
  } catch {
    return { vendor: "error", renderer: "error" };
  }
}

function collectWebrtc(timeoutMs = 2500): Promise<string[]> {
  return new Promise((resolve) => {
    const ips = new Set<string>();
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      resolve([...ips]);
    };
    window.setTimeout(finish, timeoutMs);
    try {
      const rtc = new RTCPeerConnection({ iceServers: [] });
      rtc.createDataChannel("enclave");
      rtc.onicecandidate = (event) => {
        const cand = event.candidate?.candidate;
        if (!cand) return;
        const match = cand.match(/(\d{1,3}\.){3}\d{1,3}/);
        if (match?.[0]) ips.add(match[0]);
      };
      void rtc.createOffer().then((offer) => rtc.setLocalDescription(offer));
    } catch {
      finish();
    }
  });
}

export async function collectPageFingerprint(source: LabSnapshot["source"] = "page"): Promise<LabSnapshot> {
  const webgl = webglInfo();
  const canvas = canvasFingerprint();
  const webrtcIps = await collectWebrtc();
  const nav = navigator as Navigator & { deviceMemory?: number; webdriver?: boolean };
  return {
    userAgent: navigator.userAgent,
    platform: navigator.platform,
    vendor: navigator.vendor,
    language: navigator.language,
    languages: [...navigator.languages],
    hardwareConcurrency: navigator.hardwareConcurrency || 0,
    deviceMemory: typeof nav.deviceMemory === "number" ? nav.deviceMemory : null,
    maxTouchPoints: navigator.maxTouchPoints || 0,
    hardware: {
      screenW: window.screen.width,
      screenH: window.screen.height,
      colorDepth: window.screen.colorDepth,
      dpr: window.devicePixelRatio,
    },
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    locale: Intl.DateTimeFormat().resolvedOptions().locale,
    webdriver: typeof nav.webdriver === "boolean" ? nav.webdriver : null,
    canvasHash: await sha256Hex(canvas),
    webglVendor: webgl.vendor,
    webglRenderer: webgl.renderer,
    webrtcIps,
    collectedAt: Date.now(),
    source,
  };
}

export function staticConsistency(
  env: Environment,
  proxy: ProxyItem | undefined,
): Check[] {
  const p = env.profile;
  const checks: Check[] = [];
  checks.push({
    id: "schema",
    ok: p.schema === "fingerprint-profile/v1",
    label: "画像格式",
    detail: p.schema,
  });
  checks.push({
    id: "seed",
    ok: /^\d+$/.test(p.seed) && p.seed !== "0",
    label: "画像种子",
    detail: p.seedLocked ? `${p.seed} · 已锁定` : `${p.seed} · 未锁定`,
  });
  checks.push({
    id: "webrtc",
    ok: p.webrtc.mode !== ("real" as string),
    label: "WebRTC",
    detail: p.webrtc.mode === "disable" ? "关闭" : "不使用非代理 UDP",
  });
  checks.push({
    id: "kernel",
    ok: Boolean(env.kernelPin.sha256 && env.kernelPin.version),
    label: "内核版本",
    detail: `${env.kernelPin.id} ${env.kernelPin.version}`,
  });
  checks.push({
    id: "tz",
    ok: Boolean(p.timezone),
    label: "时区",
    detail: p.timezone,
  });
  if (proxy?.country) {
    const allowed = PROXY_GEO_TZ[proxy.country];
    const aligned = !allowed || allowed.includes(p.timezone);
    checks.push({
      id: "geo",
      ok: aligned,
      warn: !aligned,
      label: "代理地区与时区",
      detail: aligned
        ? `${proxy.country} ↔ ${p.timezone}`
        : `${proxy.country} 与 ${p.timezone} 对不上`,
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

export function snapshotChecks(profile: FingerprintProfile, snap: LabSnapshot): Check[] {
  const uaOk = snap.userAgent.includes("Chrome/") && !snap.userAgent.includes("HeadlessChrome");
  return [
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
      id: "cores",
      ok: snap.hardwareConcurrency === profile.hardwareConcurrency || snap.source === "page",
      warn: snap.source === "page",
      label: "CPU 核数",
      detail: `窗口 ${snap.hardwareConcurrency} · 画像 ${profile.hardwareConcurrency}`,
    },
    {
      id: "tz-live",
      ok: snap.timezone === profile.timezone || snap.source === "page",
      warn: snap.source === "page",
      label: "实际时区",
      detail: `窗口 ${snap.timezone} · 画像 ${profile.timezone}`,
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
}

export function diffSnaps(a?: LabSnapshot, b?: LabSnapshot): { field: string; a: string; b: string; same: boolean }[] {
  if (!a || !b) return [];
  const rows = [
    ["userAgent", a.userAgent, b.userAgent],
    ["platform", a.platform, b.platform],
    ["timezone", a.timezone, b.timezone],
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

