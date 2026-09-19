(() => {
  const canvasHash = (() => {
    try {
      const c = document.createElement("canvas");
      c.width = 280; c.height = 80;
      const x = c.getContext("2d");
      if (!x) return "no-2d";
      x.fillStyle = "#f60"; x.fillRect(0,0,280,80);
      x.fillStyle = "#069"; x.font = "16px serif";
      x.fillText("Enclave.lab", 8, 32);
      return c.toDataURL().slice(-96);
    } catch { return "canvas-blocked"; }
  })();
  const webgl = (() => {
    try {
      const c = document.createElement("canvas");
      const gl = c.getContext("webgl") || c.getContext("experimental-webgl");
      if (!gl) return { vendor: "none", renderer: "none" };
      const ext = gl.getExtension("WEBGL_debug_renderer_info");
      return {
        vendor: ext ? String(gl.getParameter(ext.UNMASKED_VENDOR_WEBGL)) : String(gl.getParameter(gl.VENDOR)),
        renderer: ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : String(gl.getParameter(gl.RENDERER)),
      };
    } catch { return { vendor: "error", renderer: "error" }; }
  })();
  const nav = navigator;
  return {
    userAgent: nav.userAgent,
    platform: nav.platform,
    vendor: nav.vendor,
    language: nav.language,
    languages: [...nav.languages],
    hardwareConcurrency: nav.hardwareConcurrency || 0,
    deviceMemory: nav.deviceMemory ?? null,
    maxTouchPoints: nav.maxTouchPoints || 0,
    hardware: {
      screenW: screen.width,
      screenH: screen.height,
      colorDepth: screen.colorDepth,
      dpr: window.devicePixelRatio,
    },
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    locale: Intl.DateTimeFormat().resolvedOptions().locale,
    webdriver: typeof nav.webdriver === "boolean" ? nav.webdriver : null,
    canvasSample: canvasHash,
    webglVendor: webgl.vendor,
    webglRenderer: webgl.renderer,
    webrtcIps: [],
  };
})()
