/**
 * 本机保险箱：代理密码这类机密只以密文落盘。
 *
 * 主密码 → PBKDF2-SHA256(310k) → AES-GCM 密钥。密钥只在内存里，锁屏就丢掉。
 * 磁盘上只有 salt、iv 和密文；没有主密码谁也解不开，包括我们。
 *
 * 没设主密码时**不保存任何密码**——宁可让用户每次填，也不明文落盘。
 */
import { useEnclave } from "@/lib/store";

const KEY = "enclave.vault.v1";
const ITERATIONS = 310_000;

type VaultFile = {
  v: 1;
  salt: string;
  iterations: number;
  /** 用来判断主密码对不对：能解出这个常量就说明对了 */
  check: { iv: string; ct: string };
  items: { iv: string; ct: string };
};

const enc = new TextEncoder();
const dec = new TextDecoder();
const CHECK_PLAINTEXT = "enclave-vault-ok";

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

function readFile(): VaultFile | null {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as VaultFile) : null;
  } catch {
    return null;
  }
}

function writeFile(file: VaultFile | null): void {
  try {
    if (file) localStorage.setItem(KEY, JSON.stringify(file));
    else localStorage.removeItem(KEY);
  } catch {
    /* 存储不可用 */
  }
}

async function deriveKey(password: string, salt: Uint8Array<ArrayBuffer>, iterations: number): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, [
    "deriveKey",
  ]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt, iterations, hash: "SHA-256" },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

async function seal(key: CryptoKey, plaintext: string): Promise<{ iv: string; ct: string }> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, enc.encode(plaintext));
  return { iv: toB64(iv), ct: toB64(ct) };
}

async function open(key: CryptoKey, box: { iv: string; ct: string }): Promise<string | null> {
  try {
    const out = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: fromB64(box.iv) },
      key,
      fromB64(box.ct),
    );
    return dec.decode(out);
  } catch {
    return null;
  }
}

/** 解锁后的密钥只在内存里。锁屏、刷新、退出都会丢。 */
let unlockedKey: CryptoKey | null = null;
let cache: Record<string, string> = {};

/** 界面只从 store 读保险箱状态；这里是唯一的写入点。 */
function notify() {
  useEnclave.setState({ vault: { exists: readFile() !== null, unlocked: unlockedKey !== null } });
}
notify();

/**
 * 第一次设置主密码，或改主密码（已存的密码会用新密码重新加密）。
 * 保险箱锁着时整个界面都被锁屏挡住，所以走到这里时要么还没有保险箱，要么已经解锁。
 */
export async function setMasterPassword(password: string): Promise<void> {
  if (password.length < 8) throw new Error("主密码至少 8 位。");
  const items = { ...cache };

  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await deriveKey(password, salt, ITERATIONS);
  writeFile({
    v: 1,
    salt: toB64(salt),
    iterations: ITERATIONS,
    check: await seal(key, CHECK_PLAINTEXT),
    items: await seal(key, JSON.stringify(items)),
  });
  unlockedKey = key;
  cache = items;
  notify();
}

export async function unlockVault(password: string): Promise<boolean> {
  const file = readFile();
  if (!file) return false;
  const key = await deriveKey(password, fromB64(file.salt), file.iterations);
  if ((await open(key, file.check)) !== CHECK_PLAINTEXT) return false;
  const json = await open(key, file.items);
  unlockedKey = key;
  cache = json ? (JSON.parse(json) as Record<string, string>) : {};
  notify();
  return true;
}

/**
 * 忘了主密码的唯一出路：扔掉保险箱。里面的代理密码一起没了，
 * 所以把每个代理的"已保存密码"标记也清掉，界面才不会说谎。
 */
export function resetVault(): void {
  writeFile(null);
  unlockedKey = null;
  cache = {};
  useEnclave.setState((s) => ({
    proxies: s.proxies.map((p) => (p.auth ? { ...p, auth: { ...p.auth, hasPassword: false } } : p)),
  }));
  notify();
}

export function lockVault(): void {
  unlockedKey = null;
  cache = {};
  notify();
}

async function persist(): Promise<void> {
  const file = readFile();
  if (!file || !unlockedKey) return;
  writeFile({ ...file, items: await seal(unlockedKey, JSON.stringify(cache)) });
}

export async function putSecret(id: string, secret: string): Promise<void> {
  if (!unlockedKey) throw new Error("保险箱是锁着的，先解锁再保存密码。");
  cache[id] = secret;
  await persist();
  notify();
}

export function getSecret(id: string): string | null {
  if (!unlockedKey) return null;
  return cache[id] ?? null;
}

export async function removeSecret(id: string): Promise<void> {
  if (!unlockedKey) return;
  delete cache[id];
  await persist();
  notify();
}

/** 导出环境包时用：拿到全部机密，由调用方用导出口令另行加密。 */
export function allSecrets(): Record<string, string> {
  if (!unlockedKey) return {};
  return { ...cache };
}

/** 导入环境包时用。 */
export async function mergeSecrets(items: Record<string, string>): Promise<void> {
  if (!readFile()) throw new Error("文件里有代理密码，但这台机器还没设主密码。先在上面设好，再导入一次。");
  if (!unlockedKey) throw new Error("保险箱是锁着的，先解锁再导入密码。");
  cache = { ...cache, ...items };
  await persist();
  notify();
}
