/** 在工作台自己的页面里采一份指纹，当对照组：它就是这台电脑不经内核伪装时的样子。 */
import type { LabSnapshot } from "@/lib/schema";

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
      outerW: window.outerWidth,
      outerH: window.outerHeight,
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
