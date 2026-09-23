import assert from "node:assert/strict";
import { test } from "node:test";
import { codeFromDeepLink, limitText, toSession } from "./session.ts";

const plan = { plan: "pro", label: "Pro", envLimit: 200, concurrent: 8, deviceLimit: 2, api: "full" as const };

test("只认 enclave://auth?code=… 这一种深链接", () => {
  const code = "Zk3vYw0m1dXq8n2Lr5t7Aa9Bc4De6Fg_h-JKLMNOPQR";
  assert.equal(codeFromDeepLink(`enclave://auth?code=${code}`), code);
  // 任何网页都能让浏览器打开 enclave:// 链接，所以这里进来的东西一律当成不可信的。
  for (const bad of [
    `https://auth?code=${code}`,
    `enclave://evil?code=${code}`,
    "enclave://auth",
    "enclave://auth?code=short",
    "enclave://auth?code=../../v1/session/logout?x=1234567890",
    `enclave://auth?code=${"a".repeat(129)}`,
    "not a url",
    "",
  ]) {
    assert.equal(codeFromDeepLink(bad), null, bad);
  }
});

test("本机服务没应答、没配服务器地址、没登录，各是各的状态", () => {
  assert.equal(toSession({ ok: false, code: "HOST_UNAVAILABLE", message: "无法连接本机服务。" }).state, "host-down");
  assert.equal(toSession({ ok: true, configured: false, signedIn: false, online: true, lost: [] }).state, "unconfigured");
  const out = toSession({
    ok: true,
    configured: true,
    signedIn: false,
    online: true,
    lost: [],
    error: { ok: false, code: "DEVICE_REVOKED", message: "这台电脑的登录已经失效。" },
  });
  assert.equal(out.state, "signed-out");
  assert.equal(out.error, "这台电脑的登录已经失效。");
});

test("断网时不拿旧数字冒充现在的额度", () => {
  const offline = toSession({
    ok: true,
    configured: true,
    signedIn: true,
    online: false,
    email: "a@example.test",
    lost: [],
    error: { ok: false, code: "CLOUD_UNREACHABLE", message: "无法连接服务器。" },
  });
  assert.equal(offline.state, "signed-in");
  assert.equal(offline.plan, null);
  assert.equal(offline.usage, null);
  assert.equal(limitText(offline.plan, (p) => p.envLimit), "—");

  const online = toSession({
    ok: true,
    configured: true,
    signedIn: true,
    online: true,
    email: "a@example.test",
    plan,
    expiresAt: null,
    profiles: 12,
    running: 3,
    lost: [],
  });
  assert.deepEqual(online.usage, { profiles: 12, running: 3 });
  assert.equal(limitText(online.plan, (p) => p.concurrent), "8");
});
