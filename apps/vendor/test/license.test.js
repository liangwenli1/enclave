import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { test } from "node:test";
import { issueLicense, verifyLicense, planOf, PLANS, GRACE_DAYS } from "../src/license.js";

const keys = generateKeyPairSync("ed25519");
const user = { id: "u1", email: "a@b.com" };

function issue(license) {
  return issueLicense({ privateKey: keys.privateKey, user, license, deviceId: "dev-1" });
}

test("签发的许可证能用对应公钥验过", () => {
  const { token, payload } = issue({ plan: "pro", expires_at: null, device_limit: 2 });
  const verified = verifyLicense(token, keys.publicKey);
  assert.ok(verified, "验签应该通过");
  assert.equal(verified.plan, "pro");
  assert.equal(verified.envLimit, PLANS.pro.envLimit);
  assert.equal(payload.deviceId, "dev-1");
});

test("换一把公钥就验不过", () => {
  const other = generateKeyPairSync("ed25519");
  const { token } = issue({ plan: "pro", expires_at: null, device_limit: 2 });
  assert.equal(verifyLicense(token, other.publicKey), null);
});

test("改一个字节就验不过", () => {
  const { token } = issue({ plan: "pro", expires_at: null, device_limit: 2 });
  const [v, body, sig] = token.split(".");
  const flipped = `${v}.${body.slice(0, -1)}${body.at(-1) === "A" ? "B" : "A"}.${sig}`;
  assert.equal(verifyLicense(flipped, keys.publicKey), null);
});

test("订阅过期的账号按免费档签发，而不是继续发 Pro", () => {
  const { payload } = issue({ plan: "pro", expires_at: Date.now() - 1000, device_limit: 2 });
  assert.equal(payload.plan, "free");
  assert.equal(payload.envLimit, PLANS.free.envLimit);
  assert.equal(payload.expiresAt, null);
});

test("离线宽限期写进了许可证", () => {
  const { payload } = issue({ plan: "solo", expires_at: null, device_limit: 1 });
  assert.equal(payload.graceDays, GRACE_DAYS);
  assert.ok(payload.validUntil > payload.refreshAfter, "宽限期要晚于续签时间");
});

test("不认识的档位当免费档", () => {
  assert.equal(planOf("enterprise").plan, "free");
  assert.equal(planOf(undefined).plan, "free");
});
