import { useCallback, useEffect, useState } from "react";
import { Badge, Button, CodeBlock, Field, Input, Panel, PanelHeader } from "@/components/ui";
import { syncNow, useEnclave } from "@/lib/store";
import {
  adoptKey,
  approveDevice,
  blobUsage,
  disableSync,
  enableSync,
  pendingDevices,
  recoverKey,
  syncState,
  type PendingDevice,
  type SyncState,
} from "@/lib/sync";

/**
 * 同步：设置页上的一块。
 *
 * 用户要做的只有三件事——开启时保存一次恢复码；换电脑时在旧电脑上点一下「允许」并核对 6 位数字；
 * 手边没有旧电脑时输一次恢复码。平时什么都不用做。
 */
function mib(bytes: number): string {
  if (bytes < 1024) return `${bytes} 字节`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function SyncPanel() {
  const syncedAt = useEnclave((s) => s.syncedAt);
  const syncNote = useEnclave((s) => s.syncNote);
  const [state, setState] = useState<SyncState | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [recoveryCode, setRecoveryCode] = useState("");
  const [saved, setSaved] = useState(false);
  const [pending, setPending] = useState<PendingDevice[]>([]);
  const [usage, setUsage] = useState<{ count: number; bytes: number; max: number; ready: boolean } | null>(null);
  const [code, setCode] = useState("");
  const [note, setNote] = useState("");

  const load = useCallback(async () => {
    const res = await syncState();
    if (!res.ok) {
      setError(res.message);
      return;
    }
    setError("");
    setState(res);
    if (res.enabled && res.hasKey) {
      const list = await pendingDevices();
      setPending(list.ok ? list.devices : []);
      const used = await blobUsage();
      setUsage(
        used.ok
          ? { count: used.blobs.length, bytes: used.totalBytes, max: used.maxBytes, ready: used.ready }
          : null,
      );
    } else {
      setPending([]);
      setUsage(null);
    }
  }, []);

  useEffect(() => {
    void load();
    // 另一台电脑点了允许之后，这一台自己就接上了，不用用户来回切。
    const id = window.setInterval(() => void load(), 5000);
    return () => window.clearInterval(id);
  }, [load]);

  const run = async (fn: () => Promise<{ ok: boolean; message?: string }>, done?: string) => {
    setBusy(true);
    setError("");
    setNote("");
    const res = await fn();
    if (!res.ok) setError(res.message ?? "操作未成功。");
    else if (done) setNote(done);
    setBusy(false);
    await load();
    return res.ok;
  };

  if (!state) {
    return (
      <Panel>
        <PanelHeader title="同步" />
        <p className="p-5 text-[13px] text-subtle">{error || "读取中…"}</p>
      </Panel>
    );
  }

  // 开启时拿到的恢复码：用户保存之前不让它消失。
  if (recoveryCode) {
    return (
      <Panel>
        <PanelHeader title="保存恢复码" actions={<Badge tone="warn">仅显示一次</Badge>} />
        <div className="grid gap-4 p-5">
          <p className="text-[13px] leading-relaxed text-muted">
            所有登录过的电脑都没了的时候，靠它把数据找回来。
            <span className="text-bad">我们没有它的副本，丢了就找不回数据。</span>
            抄下来放在安全的地方，或者存进密码管理器。
          </p>
          <CodeBlock label="恢复码" value={recoveryCode} />
          <label className="flex items-center gap-2 text-[13px] text-muted">
            <input
              type="checkbox"
              className="size-4 accent-[var(--enclave-accent)]"
              checked={saved}
              onChange={(e) => setSaved(e.target.checked)}
            />
            我已经保存好了
          </label>
          <div>
            <Button
              variant="primary"
              disabled={!saved}
              onClick={() => {
                setRecoveryCode("");
                setSaved(false);
              }}
            >
              完成
            </Button>
          </div>
        </div>
      </Panel>
    );
  }

  return (
    <Panel>
      <PanelHeader
        title="同步"
        actions={
          <Badge tone={state.enabled ? (state.hasKey ? "ok" : "warn") : "neutral"}>
            {state.enabled ? (state.hasKey ? "已开启" : "等待批准") : "未开启"}
          </Badge>
        }
      />
      <div className="grid gap-4 p-5">
        <p className="text-[13px] leading-relaxed text-muted">
          开启后，环境与登录态加密之后才会上传，密钥只在本人的多台电脑之间传递——
          <span className="text-ink">我们无法读取其中的内容</span>。更换电脑时，在这台电脑上点击「允许」即可。
        </p>

        {/* 还没开：这个账号的第一台电脑 */}
        {!state.enabled ? (
          <div>
            <Button
              variant="primary"
              disabled={busy}
              onClick={() => {
                setBusy(true);
                setError("");
                void enableSync().then((res) => {
                  if (res.ok) {
                    setRecoveryCode(res.recoveryCode);
                    void syncNow();
                  }
                  if (!res.ok) setError(res.message);
                  setBusy(false);
                  void load();
                });
              }}
            >
              {busy ? "处理中…" : "开启同步"}
            </Button>
          </div>
        ) : null}

        {/* 开着、但这台还没拿到钥匙：等另一台批准，或者用恢复码 */}
        {state.enabled && !state.hasKey ? (
          <div className="grid gap-4">
            <div className="rounded-md border border-line px-4 py-3">
              <p className="text-[13px] leading-relaxed text-muted">
                在另一台已经登录过的电脑上打开设置页，会看到这台电脑在等批准。
                <span className="text-ink">核对下面这串数字一致</span>，再点「允许」。
              </p>
              <p className="mt-3 font-mono text-[28px] tracking-[0.3em] text-ink">{state.digits ?? "······"}</p>
            </div>
            <div className="grid gap-3 border-t border-line pt-4">
              <p className="text-[13px] text-muted">手边没有别的电脑了？用开启同步时保存的恢复码。</p>
              <Field label="恢复码" error={error}>
                <Input
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  placeholder="ABCDE-FGHJK-MNPQR-STUVW"
                  className="app-mono"
                  autoComplete="off"
                />
              </Field>
              <div>
                <Button
                  disabled={busy || !code.trim()}
                  onClick={() => void run(async () => {
                    const res = await recoverKey(code.trim());
                    if (res.ok) await syncNow();
                    return res;
                  }, "密钥已接收，正在拉取环境。")}
                >
                  {busy ? "处理中…" : "使用恢复码继续"}
                </Button>
              </div>
            </div>
          </div>
        ) : null}

        {/* 有钥匙：看有没有别的电脑在等 */}
        {state.enabled && state.hasKey ? (
          <div className="grid gap-3">
            {pending.length ? (
              <div className="grid gap-3">
                <p className="text-[13px] font-medium text-ink">有电脑在等着接上同步</p>
                {pending.map((d) => (
                  <div key={d.deviceId} className="rounded-md border border-line px-4 py-3">
                    <p className="text-[13px] text-muted">
                      「{d.name}」要接上同步。<span className="text-ink">先看那台电脑上显示的数字</span>
                      ，和下面这串一致再允许。不一致就不要允许。
                    </p>
                    <p className="my-3 font-mono text-[28px] tracking-[0.3em] text-ink">{d.digits}</p>
                    <div className="flex gap-2">
                      <Button
                        variant="primary"
                        disabled={busy}
                        onClick={() => void run(() => approveDevice(d), `已经把密钥交给「${d.name}」。`)}
                      >
                        数字一致，允许
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-[13px] text-subtle">没有电脑在等。新电脑登录后会出现在这里。</p>
            )}
            <p className="text-[13px] text-subtle">
              {syncNote ?? (syncedAt ? `上次同步：${new Date(syncedAt).toLocaleTimeString("zh-CN")}` : "尚未同步")}
            </p>
            {usage && !usage.ready ? (
              <p className="text-[13px] text-warn">
                环境和代理已经在同步；登录态还没有同步——云端存储还没配置好。
              </p>
            ) : null}
            {usage?.ready ? (
              <p className="text-[13px] text-subtle">
                云端存着 {usage.count} 个环境的登录态，共 {mib(usage.bytes)}。
                单个环境上限 {mib(usage.max)}；不想上传的环境，可以在它的页面上勾「只留在这台电脑上」。
              </p>
            ) : null}
            <div className="flex flex-wrap gap-2 border-t border-line pt-4">
              <Button disabled={busy} onClick={() => void run(async () => { await syncNow(); return { ok: true }; }, "同步完成。")}>
                立刻同步
              </Button>
              <Button disabled={busy} onClick={() => void run(adoptKey)}>
                重新取一次密钥
              </Button>
              <Button
                variant="danger"
                disabled={busy}
                onClick={() =>
                  void run(disableSync, "同步已关闭，云端密文已删除。本机数据不受影响。")
                }
              >
                关掉同步
              </Button>
            </div>
          </div>
        ) : null}

        {note ? <p className="text-[13px] text-ok">{note}</p> : null}
        {error && state.hasKey ? <p className="text-[13px] text-bad">{error}</p> : null}
      </div>
    </Panel>
  );
}
