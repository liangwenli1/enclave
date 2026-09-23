/**
 * 同步密钥的交接。真正的加解密都在本机服务里，这里只是遥控器。
 *
 * 一句话：数据密钥只在你自己的设备之间传，服务器经手的全是拆不开的包装。
 */
import { hostJson, type CloudFailure } from "@/lib/kernel/host-api";

export type SyncState = {
  ok: true;
  /** 这个账号开没开同步。 */
  enabled: boolean;
  /** 这台电脑手里有没有当前这把密钥。 */
  hasKey: boolean;
  deviceId: string;
  publicKey: string;
  /** 这台电脑的校验码，给另一台电脑上的人核对。 */
  digits?: string;
  keyId?: string;
};

export type PendingDevice = {
  deviceId: string;
  name: string;
  publicKey: string;
  digits: string;
  lastSeenAt: number;
};

export const syncState = () => hostJson<SyncState>("/v1/sync");

/** 第一台电脑开启同步。恢复码只在这一次拿得到。 */
export const enableSync = () => hostJson<{ ok: true; recoveryCode: string }>("/v1/sync/enable", "POST", {});

export const pendingDevices = () => hostJson<{ ok: true; devices: PendingDevice[] }>("/v1/sync/pending");

/** 批准另一台电脑。digits 是用户核对过的那一串，本机服务会再核一遍。 */
export const approveDevice = (d: PendingDevice) =>
  hostJson<{ ok: true }>("/v1/sync/approve", "POST", {
    deviceId: d.deviceId,
    publicKey: d.publicKey,
    digits: d.digits,
  });

/** 被批准之后收下密钥。 */
export const adoptKey = () => hostJson<{ ok: true; rekeyed: number }>("/v1/sync/adopt", "POST", {});

export const recoverKey = (code: string) => hostJson<{ ok: true; rekeyed: number }>("/v1/sync/recover", "POST", { code });

/** 跑一轮同步：先推本机改过的，再拉云端更新的。加解密都在本机服务里。 */
export const runSync = () =>
  hostJson<{ ok: true; enabled: boolean; hasKey?: boolean; pushed?: number; pulled?: number; stale?: number; unreadable?: number }>(
    "/v1/sync/run",
    "POST",
    {},
  );

/** 云端存了哪些环境的登录态、一共多大。界面上给用户一个交代。 */
export const blobUsage = () =>
  hostJson<{ ok: true; blobs: Array<{ envId: string; bytes: number; updatedAt: number }>; totalBytes: number; maxBytes: number; ready: boolean }>(
    "/v1/sync/usage",
  );

export const disableSync = () => hostJson<{ ok: true }>("/v1/sync/disable", "POST", {});

export type SyncResult<T> = T | CloudFailure;
