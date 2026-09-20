/**
 * 账号与许可证客户端。
 *
 * 工作台是纯前端（桌面里是 Tauri WebView，开发时是 Vite），没有自己的服务端。
 * 登录直接打厂商 API，换回一个设备令牌和一张 Ed25519 签名的许可证，存在本机。
 *
 * 设计前提：
 *   - 没登录 / 没网 / 验签失败 → 免费档，工作台照常能用。
 *   - 离线宽限期内用本地那张许可证，过期回落免费档。
 *   - 本机只存设备令牌，**从不存账号密码**。
 */
import { FREE, type PlanLimits } from "./plans";
import { VENDOR_URL, vendorConfigured } from "./vendor-url";
import { limitsOf, verifyLicense, type LicensePayload } from "./verify";

const KEY = "enclave.account.v1";
const DEVICE_KEY = "enclave.device.v1";

type Stored = {
  email: string;
  deviceId: string;
  /** 设备令牌：只能换许可证和登出这台设备，改不了账号。 */
  token: string;
  license: string;
  lastSyncAt: number;
};

export type AccountState = {
  signedIn: boolean;
  email: string | null;
  limits: PlanLimits;
  /** 许可证验过签才有；离线宽限期内也有。 */
  license: LicensePayload | null;
  /** 为什么现在是免费档 */
  reason: "signed-out" | "ok" | "expired" | "bad-signature" | "unsupported" | "malformed";
  lastSyncAt: number | null;
};

export const SIGNED_OUT: AccountState = {
  signedIn: false,
  email: null,
  limits: FREE,
  license: null,
  reason: "signed-out",
  lastSyncAt: null,
};

function read(): Stored | null {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as Stored) : null;
  } catch {
    return null;
  }
}

function write(value: Stored | null): void {
  try {
    if (value) localStorage.setItem(KEY, JSON.stringify(value));
    else localStorage.removeItem(KEY);
  } catch {
    /* 存储不可用：这次会话内仍然可用，重启后回到未登录 */
  }
}

/** 设备 id 在本机长期不变，这样同一台机器重复登录不会占掉多个设备名额。 */
export function deviceId(): string {
  try {
    const existing = localStorage.getItem(DEVICE_KEY);
    if (existing) return existing;
    const id = crypto.randomUUID();
    localStorage.setItem(DEVICE_KEY, id);
    return id;
  } catch {
    return crypto.randomUUID();
  }
}

function deviceName(): string {
  const ua = navigator.userAgent;
  const os = /Windows/i.test(ua)
    ? "Windows"
    : /Mac OS X|Macintosh/i.test(ua)
      ? "macOS"
      : /Linux/i.test(ua)
        ? "Linux"
        : "未知系统";
  return `${os} · Enclave 工作台`;
}

export class VendorError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

async function vendor<T>(path: string, init?: RequestInit & { token?: string }): Promise<T> {
  if (!VENDOR_URL) {
    throw new VendorError("VENDOR_NOT_CONFIGURED", "这个版本没有配置账号服务地址。");
  }
  let res: Response;
  try {
    res = await fetch(`${VENDOR_URL}/api${path}`, {
      ...init,
      headers: {
        accept: "application/json",
        ...(init?.body ? { "content-type": "application/json" } : {}),
        ...(init?.token ? { authorization: `Bearer ${init.token}` } : {}),
      },
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new VendorError("OFFLINE", "连不上账号服务。检查网络后再试，本机环境不受影响。");
  }
  type VendorBody = { ok?: boolean; code?: string; message?: string };
  let body: VendorBody | null = null;
  try {
    body = (await res.json()) as VendorBody;
  } catch {
    body = null;
  }
  if (!res.ok || body?.ok === false) {
    throw new VendorError(body?.code ?? `HTTP_${res.status}`, body?.message ?? "账号服务返回了错误。");
  }
  return body as T;
}

/** 把本地存的许可证解出来。验签失败就是免费档。 */
export async function currentAccount(): Promise<AccountState> {
  const stored = read();
  if (!stored) return SIGNED_OUT;
  const result = await verifyLicense(stored.license);
  if (!result.ok) {
    return {
      signedIn: true,
      email: stored.email,
      limits: FREE,
      license: null,
      reason: result.reason,
      lastSyncAt: stored.lastSyncAt,
    };
  }
  return {
    signedIn: true,
    email: stored.email,
    limits: limitsOf(result.payload),
    license: result.payload,
    reason: "ok",
    lastSyncAt: stored.lastSyncAt,
  };
}

export async function signIn(email: string, password: string): Promise<AccountState> {
  const id = deviceId();
  const res = await vendor<{ token: string; deviceId: string; license: string }>("/v1/device/login", {
    method: "POST",
    body: JSON.stringify({ email, password, deviceId: id, deviceName: deviceName() }),
  });
  const verified = await verifyLicense(res.license);
  if (!verified.ok) {
    throw new VendorError(
      "BAD_LICENSE",
      verified.reason === "unsupported"
        ? "这个系统的浏览器内核不支持许可证验签，请升级系统后重试。"
        : "账号服务返回的许可证验签没通过，已拒绝使用。",
    );
  }
  write({
    email,
    deviceId: res.deviceId,
    token: res.token,
    license: res.license,
    lastSyncAt: Date.now(),
  });
  return currentAccount();
}

/** 厂商上架的内核清单，签过名的一段文字。工作台不解读它，原样交给本机服务去验。 */
export async function fetchKernelFeed(): Promise<string> {
  const res = await vendor<{ signed: string }>("/v1/kernels");
  return res.signed;
}

/** 续签。没到期就不打扰服务器；服务器说设备被解绑就清掉本机登录。 */
export async function refresh(force = false): Promise<AccountState> {
  const stored = read();
  if (!stored) return SIGNED_OUT;

  const local = await verifyLicense(stored.license);
  if (!force && local.ok && Date.now() < local.payload.refreshAfter) {
    return currentAccount();
  }

  try {
    const res = await vendor<{ license: string; email: string }>("/v1/license", {
      token: stored.token,
    });
    const verified = await verifyLicense(res.license);
    // 请求在路上时用户可能已经退出登录了；只在还是同一次登录时才写回。
    const now = read();
    if (verified.ok && now?.token === stored.token) {
      write({ ...now, email: res.email, license: res.license, lastSyncAt: Date.now() });
    }
  } catch (err) {
    if (err instanceof VendorError && (err.code === "DEVICE_REVOKED" || err.code === "UNAUTHENTICATED")) {
      write(null);
      return SIGNED_OUT;
    }
    // 离线：继续用本地那张，直到宽限期结束。
  }
  return currentAccount();
}

export async function signOut(): Promise<AccountState> {
  const stored = read();
  write(null);
  if (stored) {
    try {
      await vendor("/v1/device/logout", { method: "POST", token: stored.token });
    } catch {
      /* 离线也要让本机立刻退出登录 */
    }
  }
  return SIGNED_OUT;
}

export { vendorConfigured };
