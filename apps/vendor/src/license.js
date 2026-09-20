/**
 * 档位定义与许可证签发。
 *
 * 许可证是一段 Ed25519 签名的 JSON：
 *   v1.<base64url(payload)>.<base64url(signature)>
 * 客户端内置公钥验签。私钥只在这台服务上。
 *
 * 客户端凭 payload 里的数字强制额度，而不是凭自己代码里那张表——
 * 那张表只在"完全没有许可证"时作为免费档兜底。
 */
import { createPrivateKey, createPublicKey, generateKeyPairSync, sign } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";

/** 一个档位能做什么。改数字可以，改结构要同时改客户端。 */
export const PLANS = {
  free: { plan: "free", label: "Solo Free", envLimit: 3, concurrent: 1, deviceLimit: 1 },
  solo: { plan: "solo", label: "Solo", envLimit: 50, concurrent: 3, deviceLimit: 1 },
  pro: { plan: "pro", label: "Pro", envLimit: 200, concurrent: 8, deviceLimit: 2 },
  team: { plan: "team", label: "Team", envLimit: 200, concurrent: 8, deviceLimit: 6 },
};

export function planOf(id) {
  return PLANS[id] ?? PLANS.free;
}

/** 客户端离线后仍可用许可证的天数。到期后回落免费档。 */
export const GRACE_DAYS = 14;
/** 客户端应在这个间隔后尝试续签（在线时）。 */
export const REFRESH_HOURS = 24;

const b64url = (buf) => Buffer.from(buf).toString("base64url");

export function loadOrCreateKeys(dataDir) {
  const fromEnv = process.env.ENCLAVE_LICENSE_PRIVATE_KEY;
  if (fromEnv) {
    const privateKey = createPrivateKey(fromEnv);
    return { privateKey, publicKey: createPublicKey(privateKey) };
  }
  const keyFile = path.join(dataDir, "license-key.pem");
  if (existsSync(keyFile)) {
    const privateKey = createPrivateKey(readFileSync(keyFile, "utf8"));
    return { privateKey, publicKey: createPublicKey(privateKey) };
  }
  mkdirSync(dataDir, { recursive: true });
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  writeFileSync(keyFile, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
  return { privateKey, publicKey };
}

/** 客户端要内置的公钥：32 字节 raw，base64url。 */
export function publicKeyRaw(publicKey) {
  const der = publicKey.export({ type: "spki", format: "der" });
  return b64url(der.subarray(der.length - 32));
}

export function issueLicense({ privateKey, user, license, deviceId }) {
  const now = Date.now();
  const p = planOf(license.plan);
  const expired = license.expires_at != null && license.expires_at < now;
  const effective = expired ? PLANS.free : p;

  const payload = {
    v: 1,
    sub: user.id,
    email: user.email,
    deviceId,
    plan: effective.plan,
    label: effective.label,
    envLimit: effective.envLimit,
    concurrent: effective.concurrent,
    deviceLimit: license.device_limit ?? effective.deviceLimit,
    // 订阅到期时间（null = 不过期）
    expiresAt: expired ? null : (license.expires_at ?? null),
    issuedAt: now,
    // 在线时到点续签
    refreshAfter: now + REFRESH_HOURS * 3600_000,
    // 离线宽限的硬边界，过了就回落免费档
    validUntil: now + GRACE_DAYS * 86_400_000,
    graceDays: GRACE_DAYS,
  };

  const body = b64url(JSON.stringify(payload));
  const signature = b64url(sign(null, Buffer.from(body), privateKey));
  return { token: `v1.${body}.${signature}`, payload };
}
