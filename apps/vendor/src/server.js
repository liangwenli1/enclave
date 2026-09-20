/**
 * Enclave 许可证服务。
 *
 * 官网（同源 /api/*，cookie 会话）和桌面工作台（Bearer 设备令牌）共用这一个服务。
 * 零 npm 依赖：http / crypto / sqlite 全部来自 Node 标准库。
 *
 * 它只管账号与档位。**任何环境数据、画像、Cookie 都不经过这里**，
 * 客户端也不会把这些东西发上来。
 */
import http from "node:http";
import { randomBytes, randomUUID, scryptSync, timingSafeEqual, createHash } from "node:crypto";
import path from "node:path";
import { openDb } from "./db.js";
import { PLANS, planOf, effectivePlan, issueLicense, loadOrCreateKeys, publicKeyRaw } from "./license.js";

const PORT = Number(process.env.PORT || 3012);
const DATA_DIR = process.env.ENCLAVE_DATA_DIR || "/data";
const ADMIN_TOKEN = process.env.ENCLAVE_ADMIN_TOKEN || "";
const SESSION_DAYS = 30;

/** 桌面工作台的 WebView 来源。除此之外不接受任何跨域调用。 */
const APP_ORIGINS = new Set([
  "tauri://localhost",
  "http://tauri.localhost",
  "https://tauri.localhost",
  "http://localhost:8080",
  "http://127.0.0.1:8080",
]);

const db = openDb(path.join(DATA_DIR, "vendor.sqlite"));
const keys = loadOrCreateKeys(DATA_DIR);

/* ── 工具 ──────────────────────────────────────────────── */

const now = () => Date.now();
const sha256 = (s) => createHash("sha256").update(s).digest("hex");

function hashPassword(password) {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$16384$8$1$${salt.toString("base64url")}$${hash.toString("base64url")}`;
}

function verifyPassword(password, stored) {
  try {
    const [scheme, N, r, p, saltB64, hashB64] = stored.split("$");
    if (scheme !== "scrypt") return false;
    const salt = Buffer.from(saltB64, "base64url");
    const expected = Buffer.from(hashB64, "base64url");
    const actual = scryptSync(password, salt, expected.length, { N: +N, r: +r, p: +p });
    return timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function validEmail(v) {
  return typeof v === "string" && v.length <= 254 && EMAIL_RE.test(v);
}

/* 登录类接口的简单限流：同一 IP 每分钟 10 次。进程内存即可，
   这个服务是单实例；扩到多实例时再换共享存储。 */
const hits = new Map();
function rateLimited(ip, limit = 10, windowMs = 60_000) {
  const slot = hits.get(ip);
  if (!slot || slot.resetAt < now()) {
    hits.set(ip, { count: 1, resetAt: now() + windowMs });
    return false;
  }
  slot.count += 1;
  return slot.count > limit;
}
setInterval(() => {
  for (const [ip, slot] of hits) if (slot.resetAt < now()) hits.delete(ip);
  // 会话 cookie 和会话同时到期，浏览器不会再带着过期的 cookie 回来，所以得主动清。
  db.prepare("DELETE FROM sessions WHERE expires_at < ?").run(now());
}, 60_000).unref();

/* ── 数据访问 ──────────────────────────────────────────── */

const q = {
  userByEmail: db.prepare("SELECT * FROM users WHERE email = ?"),
  userById: db.prepare("SELECT * FROM users WHERE id = ?"),
  insertUser: db.prepare("INSERT INTO users (id, email, pass_hash, created_at) VALUES (?, ?, ?, ?)"),
  insertLicense: db.prepare(
    "INSERT INTO licenses (user_id, plan, expires_at, device_limit, updated_at) VALUES (?, ?, ?, ?, ?)",
  ),
  licenseOf: db.prepare("SELECT * FROM licenses WHERE user_id = ?"),
  setPlan: db.prepare(
    "UPDATE licenses SET plan = ?, expires_at = ?, device_limit = ?, updated_at = ? WHERE user_id = ?",
  ),
  insertSession: db.prepare("INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)"),
  session: db.prepare("SELECT * FROM sessions WHERE id = ?"),
  deleteSession: db.prepare("DELETE FROM sessions WHERE id = ?"),
  devicesOf: db.prepare("SELECT * FROM devices WHERE user_id = ? ORDER BY last_seen_at DESC"),
  deviceByToken: db.prepare("SELECT * FROM devices WHERE token_hash = ?"),
  deviceById: db.prepare("SELECT * FROM devices WHERE id = ? AND user_id = ?"),
  insertDevice: db.prepare(
    "INSERT INTO devices (id, user_id, name, token_hash, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?)",
  ),
  updateDeviceToken: db.prepare("UPDATE devices SET token_hash = ?, name = ?, last_seen_at = ? WHERE id = ?"),
  touchDevice: db.prepare("UPDATE devices SET last_seen_at = ? WHERE id = ?"),
  deleteDevice: db.prepare("DELETE FROM devices WHERE id = ? AND user_id = ?"),
  openRequest: db.prepare("SELECT * FROM plan_requests WHERE user_id = ? AND status = 'open' ORDER BY created_at DESC"),
  insertRequest: db.prepare(
    "INSERT INTO plan_requests (id, user_id, plan, note, status, created_at) VALUES (?, ?, ?, ?, 'open', ?)",
  ),
  closeRequests: db.prepare("UPDATE plan_requests SET status = 'done' WHERE user_id = ? AND status = 'open'"),
  allOpenRequests: db.prepare(
    `SELECT r.id, r.plan, r.note, r.created_at, u.email
     FROM plan_requests r JOIN users u ON u.id = r.user_id
     WHERE r.status = 'open' ORDER BY r.created_at DESC`,
  ),
  insertMessage: db.prepare("INSERT INTO messages (id, topic, email, message, created_at) VALUES (?, ?, ?, ?, ?)"),
  recentMessages: db.prepare("SELECT * FROM messages ORDER BY created_at DESC LIMIT 200"),
};

function licenseRowOf(userId) {
  return q.licenseOf.get(userId) ?? { user_id: userId, plan: "free", expires_at: null, device_limit: 1 };
}

/* ── HTTP 基础 ─────────────────────────────────────────── */

function send(res, status, body, extraHeaders = {}) {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    // 每个请求进来时算好的 CORS 头，跟着所有响应走
    ...(res.corsHeaders || {}),
    ...extraHeaders,
  });
  res.end(json);
}

const ok = (res, body = {}, headers) => send(res, 200, { ok: true, ...body }, headers);
const fail = (res, status, code, message, headers) => send(res, status, { ok: false, code, message }, headers);

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 64 * 1024) throw new Error("PAYLOAD_TOO_LARGE");
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new SyntaxError("body must be an object");
  return body;
}

function cookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

function sessionCookie(req, id, maxAgeSec) {
  const secure = (req.headers["x-forwarded-proto"] || "").includes("https") ? " Secure;" : "";
  return {
    "set-cookie": `enclave_session=${id}; Path=/; HttpOnly; SameSite=Lax;${secure} Max-Age=${maxAgeSec}`,
  };
}

function currentUser(req) {
  const id = cookies(req).enclave_session;
  if (!id) return null;
  const s = q.session.get(id);
  if (!s) return null;
  if (s.expires_at < now()) {
    q.deleteSession.run(id);
    return null;
  }
  return q.userById.get(s.user_id) ?? null;
}

function bearer(req) {
  const h = req.headers.authorization || "";
  return h.startsWith("Bearer ") ? h.slice(7) : "";
}

function clientIp(req) {
  const fwd = req.headers["x-forwarded-for"];
  if (typeof fwd === "string" && fwd) return fwd.split(",")[0].trim();
  return req.socket.remoteAddress || "unknown";
}

/** 桌面端跨域：只放行工作台自己的 WebView 来源，且只对 /v1/* 生效。 */
function corsHeaders(req, pathname) {
  const origin = req.headers.origin;
  if (!origin || !pathname.startsWith("/v1/") || !APP_ORIGINS.has(origin)) return {};
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
    "access-control-allow-headers": "authorization, content-type",
    "access-control-max-age": "600",
    vary: "Origin",
  };
}

/* ── 路由 ──────────────────────────────────────────────── */

const routes = [];
const route = (method, pattern, handler) => routes.push({ method, pattern, handler });

/* 官网：注册 */
route("POST", "/auth/register", async (req, res) => {
  if (rateLimited(clientIp(req))) return fail(res, 429, "RATE_LIMITED", "尝试太频繁，请一分钟后再试。");
  const body = await readJson(req);
  const email = String(body.email || "").trim().toLowerCase();
  const password = String(body.password || "");
  if (!validEmail(email)) return fail(res, 400, "BAD_EMAIL", "请填写有效的邮箱地址。");
  if (password.length < 10) return fail(res, 400, "WEAK_PASSWORD", "密码至少 10 位。");
  if (q.userByEmail.get(email)) return fail(res, 409, "EMAIL_TAKEN", "这个邮箱已经注册过了，直接登录即可。");

  const id = randomUUID();
  const ts = now();
  q.insertUser.run(id, email, hashPassword(password), ts);
  q.insertLicense.run(id, "free", null, PLANS.free.deviceLimit, ts);

  const sid = randomBytes(32).toString("base64url");
  q.insertSession.run(sid, id, ts, ts + SESSION_DAYS * 86_400_000);
  return ok(res, { user: { email } }, sessionCookie(req, sid, SESSION_DAYS * 86_400));
});

/* 官网：登录 */
route("POST", "/auth/login", async (req, res) => {
  if (rateLimited(clientIp(req))) return fail(res, 429, "RATE_LIMITED", "尝试太频繁，请一分钟后再试。");
  const body = await readJson(req);
  const email = String(body.email || "").trim().toLowerCase();
  const user = q.userByEmail.get(email);
  if (!user || !verifyPassword(String(body.password || ""), user.pass_hash)) {
    return fail(res, 401, "BAD_CREDENTIALS", "邮箱或密码不对。");
  }
  const ts = now();
  const sid = randomBytes(32).toString("base64url");
  q.insertSession.run(sid, user.id, ts, ts + SESSION_DAYS * 86_400_000);
  return ok(res, { user: { email: user.email } }, sessionCookie(req, sid, SESSION_DAYS * 86_400));
});

route("POST", "/auth/logout", async (req, res) => {
  const id = cookies(req).enclave_session;
  if (id) q.deleteSession.run(id);
  return ok(res, {}, sessionCookie(req, "", 0));
});

/* 官网：当前状态 */
route("GET", "/auth/me", async (req, res) => {
  const user = currentUser(req);
  if (!user) return ok(res, { user: null });
  const row = licenseRowOf(user.id);
  const { expired, plan: p } = effectivePlan(row);
  const devices = q.devicesOf.all(user.id).map((d) => ({
    id: d.id,
    name: d.name,
    lastSeenAt: d.last_seen_at,
  }));
  const pending = q.openRequest.all(user.id)[0];
  return ok(res, {
    user: { email: user.email },
    license: {
      plan: p.plan,
      label: p.label,
      envLimit: p.envLimit,
      concurrent: p.concurrent,
      expiresAt: expired ? null : row.expires_at,
      // 过期的那一档叫什么：账号页据此提示「Pro 已于某日到期」
      expiredPlan: expired ? planOf(row.plan).label : null,
      expiredAt: expired ? row.expires_at : null,
      deviceLimit: expired ? p.deviceLimit : (row.device_limit ?? p.deviceLimit),
    },
    devices,
    pendingRequest: pending ? { plan: pending.plan, createdAt: pending.created_at } : null,
  });
});

/* 官网：档位表。档位只在这个服务里定义，页面从这里取，不自己抄。 */
route("GET", "/plans", async (_req, res) => ok(res, { plans: Object.values(PLANS) }));

/* 官网：升级申请 */
route("POST", "/license/request", async (req, res) => {
  const user = currentUser(req);
  if (!user) return fail(res, 401, "UNAUTHENTICATED", "请先登录。");
  const body = await readJson(req);
  const plan = String(body.plan || "");
  if (!PLANS[plan] || plan === "free") return fail(res, 400, "BAD_PLAN", "档位不对。");
  if (q.openRequest.all(user.id).length) return fail(res, 409, "ALREADY_OPEN", "你已经有一条待处理的申请了。");
  q.insertRequest.run(randomUUID(), user.id, plan, String(body.note || "").slice(0, 200), now());
  return ok(res);
});

/* 官网：解绑设备 */
route("DELETE", "/devices/:id", async (req, res, params) => {
  const user = currentUser(req);
  if (!user) return fail(res, 401, "UNAUTHENTICATED", "请先登录。");
  if (!q.deviceById.get(params.id, user.id)) return fail(res, 404, "NOT_FOUND", "没有这台设备。");
  q.deleteDevice.run(params.id, user.id);
  return ok(res);
});

/* 官网：联系表单（不需要登录） */
route("POST", "/contact", async (req, res) => {
  if (rateLimited(clientIp(req), 5)) return fail(res, 429, "RATE_LIMITED", "提交太频繁，请稍后再试。");
  const body = await readJson(req);
  const email = String(body.email || "").trim().toLowerCase();
  const message = String(body.message || "").trim();
  const topic = ["sales", "security", "support"].includes(body.topic) ? body.topic : "support";
  if (!validEmail(email)) return fail(res, 400, "BAD_EMAIL", "请填写有效的邮箱地址。");
  if (message.length < 5) return fail(res, 400, "EMPTY_MESSAGE", "内容太短了，说清楚一点。");
  q.insertMessage.run(randomUUID(), topic, email, message.slice(0, 1000), now());
  return ok(res);
});

/* ── 桌面端 ───────────────────────────────────────────── */

/* 设备登录：换一个长期设备令牌 + 一张签名许可证 */
route("POST", "/v1/device/login", async (req, res) => {
  if (rateLimited(clientIp(req))) return fail(res, 429, "RATE_LIMITED", "尝试太频繁，请一分钟后再试。");
  const body = await readJson(req);
  const email = String(body.email || "").trim().toLowerCase();
  const user = q.userByEmail.get(email);
  if (!user || !verifyPassword(String(body.password || ""), user.pass_hash)) {
    return fail(res, 401, "BAD_CREDENTIALS", "邮箱或密码不对。");
  }

  const deviceId = String(body.deviceId || "").slice(0, 64) || randomUUID();
  const deviceName = String(body.deviceName || "未命名设备").slice(0, 64);
  const row = licenseRowOf(user.id);
  const limit = row.device_limit ?? planOf(row.plan).deviceLimit;
  // 设备 id 跟着这台机器走，不跟账号走。上一个账号离线退出时服务端那行会留下来，
  // 换账号登录就会撞主键。一个安装同一时刻只登录一个账号，所以旧的那行就是残留。
  db.prepare("DELETE FROM devices WHERE id = ? AND user_id <> ?").run(deviceId, user.id);
  const existing = q.deviceById.get(deviceId, user.id);
  if (!existing && q.devicesOf.all(user.id).length >= limit) {
    return fail(
      res,
      409,
      "DEVICE_LIMIT",
      `当前档位最多绑定 ${limit} 台设备。请到官网账号页解绑一台，或申请升级。`,
    );
  }

  const token = randomBytes(32).toString("base64url");
  const ts = now();
  if (existing) q.updateDeviceToken.run(sha256(token), deviceName, ts, deviceId);
  else q.insertDevice.run(deviceId, user.id, deviceName, sha256(token), ts, ts);

  const { token: license, payload } = issueLicense({
    privateKey: keys.privateKey,
    user,
    license: row,
    deviceId,
  });
  return ok(res, { token, deviceId, license, plan: payload.plan });
});

/* 续签 */
route("GET", "/v1/license", async (req, res) => {
  const token = bearer(req);
  if (!token) return fail(res, 401, "UNAUTHENTICATED", "缺少设备令牌。");
  const device = q.deviceByToken.get(sha256(token));
  if (!device) return fail(res, 401, "DEVICE_REVOKED", "这台设备的登录已失效，请重新登录。");
  const user = q.userById.get(device.user_id);
  if (!user) return fail(res, 401, "DEVICE_REVOKED", "账号不存在。");
  q.touchDevice.run(now(), device.id);
  const { token: license, payload } = issueLicense({
    privateKey: keys.privateKey,
    user,
    license: licenseRowOf(user.id),
    deviceId: device.id,
  });
  return ok(res, { license, plan: payload.plan, email: user.email });
});

route("POST", "/v1/device/logout", async (req, res) => {
  const token = bearer(req);
  const device = token ? q.deviceByToken.get(sha256(token)) : null;
  if (device) q.deleteDevice.run(device.id, device.user_id);
  return ok(res);
});

/* 客户端内置的就是这个公钥，放出来方便核对 */
route("GET", "/v1/pubkey", async (_req, res) => ok(res, { alg: "ed25519", publicKey: publicKeyRaw(keys.publicKey) }));

/* ── 运维 ─────────────────────────────────────────────── */

function requireAdmin(req, res) {
  if (!ADMIN_TOKEN) {
    fail(res, 503, "ADMIN_DISABLED", "未配置 ENCLAVE_ADMIN_TOKEN。");
    return false;
  }
  const given = req.headers["x-admin-token"];
  const a = Buffer.from(String(given || ""));
  const b = Buffer.from(ADMIN_TOKEN);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    fail(res, 401, "UNAUTHENTICATED", "管理员令牌不对。");
    return false;
  }
  return true;
}

/* 开通 / 改档：收到付款后运维执行 */
route("POST", "/admin/plan", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const body = await readJson(req);
  const user = q.userByEmail.get(String(body.email || "").trim().toLowerCase());
  if (!user) return fail(res, 404, "NOT_FOUND", "没有这个账号。");
  const plan = String(body.plan || "");
  if (!PLANS[plan]) return fail(res, 400, "BAD_PLAN", "档位不对。");
  // 这个接口是人手敲 curl 调的，输错了必须当场报错，不能静默开出永久订阅或已过期订阅。
  let expiresAt = null;
  if (body.expiresAt != null) {
    expiresAt = Number(body.expiresAt);
    if (!Number.isFinite(expiresAt) || expiresAt <= now()) {
      return fail(res, 400, "BAD_EXPIRES_AT", "expiresAt 要填将来的毫秒时间戳（例如 1790000000000），不是日期字符串，也不是秒。");
    }
  }
  const deviceLimit = body.deviceLimit == null ? PLANS[plan].deviceLimit : Number(body.deviceLimit);
  if (!Number.isInteger(deviceLimit) || deviceLimit < 1) {
    return fail(res, 400, "BAD_DEVICE_LIMIT", "deviceLimit 要填大于等于 1 的整数。");
  }
  q.setPlan.run(plan, expiresAt, deviceLimit, now(), user.id);
  q.closeRequests.run(user.id);

  // 降档后超出上限的设备：保留最近用过的，其余解绑（它们下次续签会回到未登录）。
  const extra = q.devicesOf.all(user.id).slice(deviceLimit);
  for (const d of extra) q.deleteDevice.run(d.id, user.id);
  return ok(res, { email: user.email, plan, expiresAt, deviceLimit, devicesUnbound: extra.length });
});

route("GET", "/admin/requests", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  return ok(res, { requests: q.allOpenRequests.all(), messages: q.recentMessages.all() });
});

route("GET", "/health", async (_req, res) => ok(res, { service: "enclave-vendor" }));

/* ── 分发 ─────────────────────────────────────────────── */

function match(method, pathname) {
  for (const r of routes) {
    if (r.method !== method) continue;
    if (!r.pattern.includes(":")) {
      if (r.pattern === pathname) return { handler: r.handler, params: {} };
      continue;
    }
    const pp = r.pattern.split("/");
    const ap = pathname.split("/");
    if (pp.length !== ap.length) continue;
    const params = {};
    let hit = true;
    for (let i = 0; i < pp.length; i += 1) {
      if (pp[i].startsWith(":")) params[pp[i].slice(1)] = decodeURIComponent(ap[i]);
      else if (pp[i] !== ap[i]) {
        hit = false;
        break;
      }
    }
    if (hit) return { handler: r.handler, params };
  }
  return null;
}

const server = http.createServer(async (req, res) => {
  let pathname;
  try {
    pathname = new URL(req.url, "http://localhost").pathname;
  } catch {
    return fail(res, 400, "BAD_REQUEST", "请求格式不对。");
  }
  if (pathname.startsWith("/api/")) pathname = pathname.slice(4);
  else if (pathname === "/api") pathname = "/";
  res.corsHeaders = corsHeaders(req, pathname);

  if (req.method === "OPTIONS") {
    // 不在放行名单里的来源，预检直接拒绝：浏览器就不会发真正的请求。
    res.writeHead(Object.keys(res.corsHeaders).length ? 204 : 403, res.corsHeaders);
    return res.end();
  }

  try {
    // match() 会解码路径参数，/devices/%ff 这种会抛 URIError；放在 try 外面就是未处理的
    // rejection，Node 直接退出 —— 任何人一条请求就能把服务打挂。
    const hit = match(req.method, pathname);
    if (!hit) return fail(res, 404, "NOT_FOUND", "没有这个接口。");
    await hit.handler(req, res, hit.params);
  } catch (err) {
    if (err instanceof SyntaxError || err instanceof URIError || err.message === "PAYLOAD_TOO_LARGE") {
      return fail(res, 400, "BAD_REQUEST", "请求格式不对。");
    }
    console.error("[vendor]", pathname, err);
    if (!res.headersSent) fail(res, 500, "INTERNAL", "服务出错了，请稍后再试。");
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`[vendor] listening on ${PORT}`);
  console.log(`[vendor] license public key: ${publicKeyRaw(keys.publicKey)}`);
  if (!ADMIN_TOKEN) console.warn("[vendor] ENCLAVE_ADMIN_TOKEN 未设置，开通接口不可用。");
});
