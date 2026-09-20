/**
 * 许可证验签。
 *
 * 许可证格式：`v1.<base64url(payload)>.<base64url(ed25519 签名)>`
 * 公钥内置在客户端里（见 public-key.ts），私钥只在厂商服务上。
 *
 * 验不过、过了离线宽限期、或者浏览器不支持 Ed25519 —— 三种情况都回落免费档。
 * **绝不在验签失败时"姑且相信"里面写的档位。**
 */
// 只用类型，运行时不产生依赖，这样 `node --test` 能直接跑这个模块。
import type { PlanId, PlanLimits } from "./plans";
// 显式带扩展名：Node 的 ESM 解析不会自己补 .ts，而这个文件要能在测试里直接加载。
import { LICENSE_PUBLIC_KEY } from "./public-key.ts";

/** 认识的档位 id。验签阶段只关心"这个 id 是不是我们发过的"。 */
const KNOWN_PLANS = new Set<PlanId>(["free", "solo", "pro", "team"]);

export type LicensePayload = {
  v: 1;
  sub: string;
  email: string;
  deviceId: string;
  plan: PlanId;
  label: string;
  envLimit: number;
  concurrent: number;
  deviceLimit: number;
  /** 订阅到期，null 表示不过期 */
  expiresAt: number | null;
  issuedAt: number;
  /** 在线时超过这个时间应该去续签 */
  refreshAfter: number;
  /** 离线宽限的硬边界，过了就回落免费档 */
  validUntil: number;
  graceDays: number;
};

function fromBase64Url(input: string): Uint8Array<ArrayBuffer> {
  const b64 = input.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(input.length / 4) * 4, "=");
  const bin = atob(b64);
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

const keyCache = new Map<string, Promise<CryptoKey | null>>();

async function publicKey(raw: string): Promise<CryptoKey | null> {
  let cached = keyCache.get(raw);
  if (!cached) {
    cached = (async () => {
      try {
        return await crypto.subtle.importKey("raw", fromBase64Url(raw), { name: "Ed25519" }, false, [
          "verify",
        ]);
      } catch {
        // 这个 WebView 不支持 Ed25519。宁可当作没有许可证，也不接受未验证的档位。
        return null;
      }
    })();
    keyCache.set(raw, cached);
  }
  return cached;
}

export type VerifyResult =
  | { ok: true; payload: LicensePayload }
  | { ok: false; reason: "malformed" | "bad-signature" | "expired" | "unsupported" };

/** 用内置公钥验签。 */
export function verifyLicense(token: string, nowMs = Date.now()): Promise<VerifyResult> {
  return verifyLicenseWith(token, LICENSE_PUBLIC_KEY, nowMs);
}

/** 指定公钥验签。测试用它注入临时密钥，生产代码只用上面那个。 */
export async function verifyLicenseWith(
  token: string,
  rawPublicKey: string,
  nowMs = Date.now(),
): Promise<VerifyResult> {
  const parts = String(token || "").split(".");
  if (parts.length !== 3 || parts[0] !== "v1") return { ok: false, reason: "malformed" };

  const key = await publicKey(rawPublicKey);
  if (!key) return { ok: false, reason: "unsupported" };

  let valid = false;
  try {
    valid = await crypto.subtle.verify(
      { name: "Ed25519" },
      key,
      fromBase64Url(parts[2]),
      new TextEncoder().encode(parts[1]),
    );
  } catch {
    return { ok: false, reason: "unsupported" };
  }
  if (!valid) return { ok: false, reason: "bad-signature" };

  let payload: LicensePayload;
  try {
    payload = JSON.parse(new TextDecoder().decode(fromBase64Url(parts[1]))) as LicensePayload;
  } catch {
    return { ok: false, reason: "malformed" };
  }

  if (payload.v !== 1 || !KNOWN_PLANS.has(payload.plan)) return { ok: false, reason: "malformed" };
  if (payload.validUntil <= nowMs) return { ok: false, reason: "expired" };
  if (payload.expiresAt != null && payload.expiresAt <= nowMs) return { ok: false, reason: "expired" };

  return { ok: true, payload };
}

/** 许可证里写的上限。签名验过了才会走到这里。 */
export function limitsOf(payload: LicensePayload): PlanLimits {
  return {
    plan: payload.plan,
    label: payload.label,
    envLimit: payload.envLimit,
    concurrent: payload.concurrent,
    deviceLimit: payload.deviceLimit,
  };
}
