#!/usr/bin/env bash
# 在 macOS（Apple Silicon）上打 dmg。和 windows-msi.ps1 是同一套步骤。
# 没有 Apple 开发者证书：包是 ad-hoc 签名、未公证的，从浏览器下载后要先
#   xattr -cr /Applications/Enclave.app
# 才能打开。不能叫 1.0。
set -euo pipefail
cd "$(dirname "$0")/.."

for cmd in node npm cargo rustc; do
  command -v "$cmd" >/dev/null || { echo "缺少 $cmd"; exit 1; }
done
triple="$(rustc -vV | sed -n 's/^host: //p')"
[ "$triple" = "aarch64-apple-darwin" ] || { echo "只支持 Apple Silicon，当前是 $triple"; exit 1; }

# 1. 本机 Host（作为 sidecar 打进 app）
npm ci
cargo build --release -p enclave-host
cargo test -p enclave-host
mkdir -p apps/desktop/src-tauri/binaries
cp target/release/enclave-host "apps/desktop/src-tauri/binaries/enclave-host-$triple"

# 2. 工作台。VITE_ENCLAVE_VENDOR_URL 不设也能打，只是包里不能登录账号、额度停在免费档。
[ -n "${VITE_ENCLAVE_VENDOR_URL:-}" ] || echo "注意：没有设置 VITE_ENCLAVE_VENDOR_URL，这个包里的账号登录不可用。"
npm run build
[ -f dist/index.html ] || { echo "dist/index.html 不存在"; exit 1; }

# 3. 打包
npx --yes @tauri-apps/cli@2 build --config "$PWD/apps/desktop/src-tauri/tauri.conf.json" --bundles dmg

echo "dmg 在 apps/desktop/src-tauri/target/release/bundle/dmg/"
echo "算哈希：shasum -a 256 <dmg>"
