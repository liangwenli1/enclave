/**
 * 代理密码和应用锁。真正的保险箱在本机服务里（crates/host/src/vault.rs），这里只是它的遥控器。
 *
 * - 密码只进不出：页面可以存、可以删、可以知道"有没有"，读不回明文。启动环境时由本机服务自己取用。
 * - 平时不需要任何口令：加密用的数据密钥放在系统钥匙串里，由操作系统账号保护。
 * - 「应用锁」是可选的，给共用一台电脑的人用：开了之后每次打开工作台要输口令。
 */
import { useEnclave } from "@/lib/store";
import { hostJson } from "@/lib/kernel/host-api";

type VaultView = { ok: true; appLock: boolean; unlocked: boolean };
type Failure = { ok: false; code: string; message: string };

/** 界面只从 store 读保险箱状态；这里是唯一的写入点。exists = 开着应用锁。 */
function apply(view: VaultView | Failure): boolean {
  if (!view.ok) return false;
  useEnclave.setState({ vault: { exists: view.appLock, unlocked: view.unlocked } });
  return true;
}

export async function refreshVault(): Promise<void> {
  apply(await hostJson<VaultView>("/v1/vault"));
}

export async function unlockVault(passphrase: string): Promise<boolean> {
  return apply(await hostJson<VaultView>("/v1/vault/unlock", "POST", { passphrase }));
}

export async function lockVault(): Promise<void> {
  apply(await hostJson<VaultView>("/v1/vault/lock", "POST", {}));
}

/** 开应用锁，或者换口令。 */
export async function setAppLock(passphrase: string): Promise<void> {
  if (passphrase.length < 8) throw new Error("口令至少 8 位。");
  const res = await hostJson<VaultView>("/v1/vault/app-lock", "POST", { passphrase });
  if (!apply(res)) throw new Error(res.ok ? "" : res.message);
}

export async function removeAppLock(): Promise<void> {
  const res = await hostJson<VaultView>("/v1/vault/app-lock", "POST", {});
  if (!apply(res)) throw new Error(res.ok ? "" : res.message);
}

/**
 * 忘了口令的唯一出路：换一把新的数据密钥。旧钥匙加密的代理密码一起没了，
 * 所以把"已保存密码"的记录也清掉，界面才不会说谎。环境和代理本身不受影响。
 */
export async function resetVault(): Promise<void> {
  if (apply(await hostJson<VaultView>("/v1/vault/reset", "POST", {}))) {
    useEnclave.setState({ secretIds: [] });
  }
}

export async function putSecret(id: string, secret: string): Promise<void> {
  const res = await hostJson<{ ok: true }>(`/v1/secrets/${encodeURIComponent(id)}`, "PUT", { value: secret });
  if (!res.ok) throw new Error(res.message);
  useEnclave.setState((s) => ({ secretIds: [...new Set([...s.secretIds, id])] }));
}

export async function removeSecret(id: string): Promise<void> {
  await hostJson(`/v1/secrets/${encodeURIComponent(id)}`, "DELETE");
  useEnclave.setState((s) => ({ secretIds: s.secretIds.filter((x) => x !== id) }));
}
