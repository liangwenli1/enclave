#!/usr/bin/env node
/** Internal Linux verification only. Not the 1.0 release path. */
import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bind = process.env.ENCLAVE_HOST_BIND ?? "127.0.0.1:17891";
const health = `http://${bind}/v1/health`;
const bin = path.join(root, "target", "release", "enclave-host");

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
  env: { ...process.env, ENCLAVE_HOST_BIND: bind },
});
child.unref();

const start = Date.now();
while (Date.now() - start < 20_000) {
  if (await healthy()) process.exit(0);
  await new Promise((r) => setTimeout(r, 250));
}
console.error("enclave-host did not become healthy");
process.exit(1);
