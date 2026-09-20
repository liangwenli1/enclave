/**
 * 内核上架清单。
 *
 * 管理员登记一个版本（上游下载地址 + 自己下载后算出的 SHA256 和字节数），
 * 客户端拿到的是一段签名的清单：
 *   k1.<base64url(payload)>.<base64url(signature)>
 * 本机 Host 用内置公钥验签后才会照着它去下载、执行。签的是 "enclave-kernels-v1." + body，
 * 和许可证用的是同一把钥匙，加这个前缀是为了让两种签名永远不能互相冒充。
 */
import { sign } from "node:crypto";

export const SIGN_DOMAIN = "enclave-kernels-v1.";
export const PLATFORMS = ["win-x64", "mac-arm64", "linux-x64"];
/** Host 只从这里下载内核。别的地址登记不进来，就算登记进来 Host 也会拒绝。 */
export const UPSTREAM_PREFIX = "https://github.com/adryfish/fingerprint-chromium/releases/download/";

const b64url = (buf) => Buffer.from(buf).toString("base64url");

/** 人手敲 curl 登记的，输错了要当场说清楚错在哪。返回 { record } 或 { error }。 */
export function parseKernel(body) {
  const version = String(body.version ?? "").trim();
  if (!/^\d+(\.\d+){1,3}$/.test(version)) return { error: "version 要像 148.0.7778.215 这样。" };
  const platform = String(body.platform ?? "");
  if (!PLATFORMS.includes(platform)) return { error: `platform 只能是 ${PLATFORMS.join(" / ")}。` };
  const channel = String(body.channel ?? "candidate");
  if (channel !== "stable" && channel !== "candidate") return { error: "channel 只能是 stable 或 candidate。" };
  const url = String(body.url ?? "").trim();
  // 先规整再比：".." 能让一个以上游前缀开头的地址实际指到别的仓库去。
  let normalized = "";
  try {
    normalized = new URL(url).href;
  } catch {
    /* 下面统一报错 */
  }
  if (normalized !== url || !url.startsWith(UPSTREAM_PREFIX)) {
    return { error: `url 必须以 ${UPSTREAM_PREFIX} 开头，且不能带 .. 或空白。` };
  }
  const filename = decodeURIComponent(url.slice(url.lastIndexOf("/") + 1));
  if (!/^[\w.+-]+\.(zip|dmg|tar\.xz)$/.test(filename)) return { error: "url 要指向 .zip / .dmg / .tar.xz 文件。" };
  const sha256 = String(body.sha256 ?? "").trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(sha256)) return { error: "sha256 要填 64 位十六进制（你自己下载后算出来的）。" };
  const bytes = Number(body.bytes);
  if (!Number.isInteger(bytes) || bytes < 1_000_000) return { error: "bytes 要填文件的字节数。" };
  return {
    record: { version, platform, channel, url, filename, sha256, bytes, notes: String(body.notes ?? "").slice(0, 300) },
  };
}

/** 数据库里的一行 → Host 清单里的一条记录（字段名和 kernels.manifest.json 一致）。 */
export function toManifestRecord(row) {
  return {
    id: "fingerprint-chromium",
    version: row.version,
    platform: row.platform,
    channel: row.channel,
    url: row.url,
    filename: row.filename,
    sha256: row.sha256,
    bytes: row.bytes,
    publisher: "adryfish",
    releasedAt: new Date(row.created_at).toISOString(),
    upstream: "Ungoogled Chromium",
    license: "BSD-3-Clause",
    notes: row.notes ?? "",
  };
}

export function signKernelList(privateKey, rows, now = Date.now()) {
  const body = b64url(JSON.stringify({ v: 1, issuedAt: now, kernels: rows.map(toManifestRecord) }));
  const signature = b64url(sign(null, Buffer.from(SIGN_DOMAIN + body), privateKey));
  return `k1.${body}.${signature}`;
}
