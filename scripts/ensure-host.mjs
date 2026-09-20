#!/usr/bin/env node
/**
 * 开发用：确保本机 Host 已经在跑。
 *
 * Host 自己会在 data/host.token 生成令牌，vite dev 的 /__enclave/host-token
 * 把它交给工作台。打包后的桌面版不走这条路 —— 令牌由 Tauri 壳直接注入。
 */
import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const port = process.env.ENCLAVE_HOST_PORT ?? "17891";
const health = `http://127.0.0.1:${port}/v1/health`;
const bin = path.join(
  root,
  "target",
  "release",
  process.platform === "win32" ? "enclave-host.exe" : "enclave-host",
);

async function healthy() {
  try {
    const res = await fetch(health, { signal: AbortSignal.timeout(1500) });
    return res.ok;
  } catch {
    return false;
  }
}

if (await healthy()) process.exit(0);
await mkdir(path.join(root, "data"), { recursive: true });

const cargo = spawn("cargo", ["build", "--release", "-p", "enclave-host"], {
  cwd: root,
  stdio: "inherit",
});
const cargoCode = await new Promise((resolve) => cargo.on("exit", resolve));
if (cargoCode !== 0) process.exit(cargoCode ?? 1);

const child = spawn(bin, [], {
  cwd: root,
  detached: true,
  stdio: "ignore",
  env: { ...process.env, ENCLAVE_HOST_PORT: port },
});
child.unref();

const start = Date.now();
while (Date.now() - start < 20_000) {
  if (await healthy()) process.exit(0);
  await new Promise((r) => setTimeout(r, 250));
}
console.error("本机服务没有起来。看看 cargo build 的输出。");
process.exit(1);
