import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, verify } from "node:crypto";
import { parseKernel, signKernelList, SIGN_DOMAIN, UPSTREAM_PREFIX } from "../src/kernels.js";

const good = {
  version: "150.0.1.2",
  platform: "win-x64",
  channel: "candidate",
  url: `${UPSTREAM_PREFIX}150.0.1.2/ungoogled-chromium_150.0.1.2-1.1_windows_x64.zip`,
  sha256: "A".repeat(64),
  bytes: 189767686,
};

test("登记：合法的记录通过，文件名取自地址，哈希转小写", () => {
  const { record, error } = parseKernel(good);
  assert.equal(error, undefined);
  assert.equal(record.filename, "ungoogled-chromium_150.0.1.2-1.1_windows_x64.zip");
  assert.equal(record.sha256, "a".repeat(64));
});

test("登记：上游以外的地址、错的哈希、错的平台、错的字节数都当场拒绝", () => {
  assert.match(parseKernel({ ...good, url: "https://evil.example/kernel.zip" }).error, /url/);
  assert.match(parseKernel({ ...good, url: `${UPSTREAM_PREFIX}x/../../../../../evil/repo/releases/download/1/kernel.zip` }).error, /url/);
  assert.match(parseKernel({ ...good, sha256: "abc" }).error, /sha256/);
  assert.match(parseKernel({ ...good, platform: "windows" }).error, /platform/);
  assert.match(parseKernel({ ...good, bytes: "big" }).error, /bytes/);
  assert.match(parseKernel({ ...good, version: "latest" }).error, /version/);
  assert.match(parseKernel({ ...good, channel: "beta" }).error, /channel/);
});

test("签名：带域前缀验得过；当成许可证那样只验 body 验不过；改一个字节验不过", () => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const row = { ...parseKernel(good).record, created_at: 1_790_000_000_000 };
  const [tag, body, sig] = signKernelList(privateKey, [row], 1_790_000_000_001).split(".");
  assert.equal(tag, "k1");
  const signature = Buffer.from(sig, "base64url");
  assert.equal(verify(null, Buffer.from(SIGN_DOMAIN + body), publicKey, signature), true);
  assert.equal(verify(null, Buffer.from(body), publicKey, signature), false);
  const tampered = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body, "base64url")), issuedAt: 1 })).toString("base64url");
  assert.equal(verify(null, Buffer.from(SIGN_DOMAIN + tampered), publicKey, signature), false);

  const payload = JSON.parse(Buffer.from(body, "base64url").toString());
  assert.equal(payload.issuedAt, 1_790_000_000_001);
  assert.equal(payload.kernels[0].id, "fingerprint-chromium");
  assert.equal(payload.kernels[0].releasedAt, new Date(1_790_000_000_000).toISOString());
});
