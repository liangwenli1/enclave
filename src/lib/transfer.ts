/**
 * 环境包导出 / 导入。
 *
 * 带走的是"配置"：环境定义、画像、代理设置、搜索引擎。
 * **不带** Cookie、缓存、浏览记录 —— 那些留在各自的 user-data 目录里，
 * 换机器就是换一套登录态，这一点必须让用户清楚。
 *
 * 代理密码默认不导出。填了导出口令才会带上，并且用这个口令单独加密，
 * 跟文件里其他内容不共用密钥。加密和解密都在本机服务里做：密码的明文不经过页面。
 */
import type { Environment, ProxyItem } from "@/lib/schema";
import type { CatalogEngine } from "@/lib/engines";
import { hostJson } from "@/lib/kernel/host-api";
import { useEnclave } from "@/lib/store";

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
    const res = await hostJson<{ ok: true; count: number; sealed?: SealedSecrets }>("/v1/secrets/export", "POST", {
      passphrase,
    });
    if (!res.ok) throw new Error(res.message);
    if (res.sealed) file.secrets = res.sealed;
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
  return file;
}

/** 把文件里的密码交给本机服务解开并存起来。返回导进去几条。 */
export async function importSecrets(file: ExportFile, passphrase: string): Promise<number> {
  if (!file.secrets) return 0;
  const res = await hostJson<{ ok: true; count: number; ids: string[] }>("/v1/secrets/import", "POST", {
    passphrase,
    sealed: file.secrets,
  });
  if (!res.ok) throw new Error(res.message);
  useEnclave.setState({ secretIds: res.ids });
  return res.count;
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
