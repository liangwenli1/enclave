/**
 * 许可证验签的回归测试。
 *
 * 这里用 Node 的 webcrypto 临时生成一对 Ed25519 密钥，自己签一张许可证，
 * 再把公钥塞进被测模块 —— 所以测的是真实的验签路径，不是打桩。
 */
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { describe, it, before } from "node:test";

const g = globalThis as unknown as { crypto?: Crypto };
g.crypto ??= webcrypto as unknown as Crypto;

const b64url = (buf: ArrayBuffer | Uint8Array) =>
  Buffer.from(buf instanceof Uint8Array ? buf : new Uint8Array(buf)).toString("base64url");

type Keys = { privateKey: CryptoKey; publicKey: CryptoKey };

let keys: Keys;
let rawPublicKey: string;

async function check(token: string) {
  const { verifyLicenseWith } = await import("./verify.ts");
  return verifyLicenseWith(token, rawPublicKey);
}

function payload(overrides: Record<string, unknown> = {}) {
  const now = Date.now();
  return {
    v: 1,
    sub: "user-1",
    email: "a@b.com",
    deviceId: "dev-1",
    plan: "pro",
    label: "Pro",
    envLimit: 200,
    concurrent: 8,
    deviceLimit: 2,
    expiresAt: null,
    issuedAt: now,
    refreshAfter: now + 3600_000,
    validUntil: now + 14 * 86_400_000,
    graceDays: 14,
    ...overrides,
  };
}

async function sign(body: Record<string, unknown>): Promise<string> {
  const encoded = b64url(new TextEncoder().encode(JSON.stringify(body)));
  const sig = await crypto.subtle.sign(
    { name: "Ed25519" },
    keys.privateKey,
    new TextEncoder().encode(encoded),
  );
  return `v1.${encoded}.${b64url(sig)}`;
}

describe("许可证验签", () => {
  before(async () => {
    keys = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
      "sign",
      "verify",
    ])) as unknown as Keys;
    rawPublicKey = b64url(await crypto.subtle.exportKey("raw", keys.publicKey));
  });

  it("接受一张正常签发的许可证", async () => {
    const result = await check(await sign(payload()));
    assert.equal(result.ok, true);
  });

  it("签名被改过就拒绝", async () => {
    const token = await sign(payload());
    const parts = token.split(".");
    const tampered = `${parts[0]}.${parts[1]}.${"A".repeat(parts[2].length)}`;
    const result = await check(tampered);
    assert.equal(result.ok, false);
    assert.equal(result.reason, "bad-signature");
  });

  it("内容被改成更高档位但没重新签名，一样拒绝", async () => {
    const token = await sign(payload({ plan: "free", envLimit: 3 }));
    const parts = token.split(".");
    const forged = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    forged.plan = "pro";
    forged.envLimit = 200;
    const body = b64url(new TextEncoder().encode(JSON.stringify(forged)));
    const result = await check(`v1.${body}.${parts[2]}`);
    assert.equal(result.ok, false);
    assert.equal(result.reason, "bad-signature");
  });

  it("过了离线宽限期就失效", async () => {
    const token = await sign(payload({ validUntil: Date.now() - 1000 }));
    const result = await check(token);
    assert.equal(result.ok, false);
    assert.equal(result.reason, "expired");
  });

  it("订阅已到期就失效", async () => {
    const token = await sign(payload({ expiresAt: Date.now() - 1000 }));
    const result = await check(token);
    assert.equal(result.ok, false);
    assert.equal(result.reason, "expired");
  });

  it("格式不对的字符串不会把人放进来", async () => {
    for (const bad of ["", "nonsense", "v2.a.b", "v1.a", "v1..", "v1.###.###"]) {
      const result = await check(bad);
      assert.equal(result.ok, false, `${bad} 不该通过`);
    }
  });
});
