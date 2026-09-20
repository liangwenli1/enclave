/**
 * 环境包导出 / 导入。
 *
 * 带走的是"配置"：环境定义、画像、代理设置、搜索引擎。
 * **不带** Cookie、缓存、浏览记录 —— 那些留在各自的 user-data 目录里，
 * 换机器就是换一套登录态，这一点必须让用户清楚。
 *
 * 代理密码默认不导出。填了导出口令才会带上，并且用这个口令单独加密，
 * 跟文件里其他内容不共用密钥。
 */
import { normalizeEnvironment, type Environment, type ProxyItem } from "@/lib/schema";
import type { CatalogEngine } from "@/lib/engines";
import { allSecrets, mergeSecrets } from "@/lib/vault";

export const EXPORT_SCHEMA = "enclave-export/v1";

type SealedSecrets = {
  alg: "PBKDF2-SHA256/AES-GCM";
  iterations: number;
  salt: string;
  iv: string;
  ct: string;
};

export type ExportFile = {
  schema: typeof EXPORT_SCHEMA;
  exportedAt: number;
  environments: Environment[];
  proxies: ProxyItem[];
  engines: CatalogEngine[];
  /** 没填导出口令时这一项不存在，文件里就没有任何密码。 */
  secrets?: SealedSecrets;
};

const enc = new TextEncoder();
const dec = new TextDecoder();
const ITERATIONS = 310_000;

function toB64(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function fromB64(s: string): Uint8Array<ArrayBuffer> {
  const bin = atob(s);
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

async function passphraseKey(passphrase: string, salt: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey("raw", enc.encode(passphrase), "PBKDF2", false, [
    "deriveKey",
  ]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt, iterations: ITERATIONS, hash: "SHA-256" },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

export async function buildExport(input: {
  environments: Environment[];
  proxies: ProxyItem[];
  engines: CatalogEngine[];
  /** 留空则不导出任何密码 */
  passphrase?: string;
}): Promise<ExportFile> {
  const file: ExportFile = {
    schema: EXPORT_SCHEMA,
    exportedAt: Date.now(),
    environments: input.environments.filter((e) => !e.deletedAt),
    proxies: input.proxies,
    engines: input.engines,
  };

  const passphrase = input.passphrase?.trim();
  if (passphrase) {
    const secrets = allSecrets();
    if (Object.keys(secrets).length) {
      const salt = crypto.getRandomValues(new Uint8Array(16));
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const key = await passphraseKey(passphrase, salt);
      const ct = await crypto.subtle.encrypt(
        { name: "AES-GCM", iv },
        key,
        enc.encode(JSON.stringify(secrets)),
      );
      file.secrets = {
        alg: "PBKDF2-SHA256/AES-GCM",
        iterations: ITERATIONS,
        salt: toB64(salt),
        iv: toB64(iv),
        ct: toB64(ct),
      };
    }
  }
  return file;
}

export function parseExport(text: string): ExportFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("这不是一个有效的环境包文件。");
  }
  const file = parsed as ExportFile;
  if (!file || file.schema !== EXPORT_SCHEMA) {
    throw new Error("环境包格式不认识，可能是别的软件导出的。");
  }
  if (!Array.isArray(file.environments) || !Array.isArray(file.proxies)) {
    throw new Error("环境包内容不完整。");
  }
  return { ...file, environments: file.environments.map(normalizeEnvironment) };
}

/** 解出密码并写进保险箱。保险箱必须先解锁。 */
export async function importSecrets(file: ExportFile, passphrase: string): Promise<number> {
  if (!file.secrets) return 0;
  const key = await passphraseKey(passphrase, fromB64(file.secrets.salt));
  let plain: string;
  try {
    const out = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: fromB64(file.secrets.iv) },
      key,
      fromB64(file.secrets.ct),
    );
    plain = dec.decode(out);
  } catch {
    throw new Error("导出口令不对，密码没有导入。其余配置不受影响。");
  }
  const secrets = JSON.parse(plain) as Record<string, string>;
  await mergeSecrets(secrets);
  return Object.keys(secrets).length;
}

export function downloadExport(file: ExportFile): void {
  const blob = new Blob([JSON.stringify(file, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  const stamp = new Date(file.exportedAt).toISOString().slice(0, 10);
  a.href = url;
  a.download = `enclave-${stamp}.enclave.json`;
  a.click();
  URL.revokeObjectURL(url);
}
