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

# 服务器地址在编译 Host 时写进去。工作台要登录后才能用，没有它的安装包装上之后什么都做不了。
cloud="${ENCLAVE_CLOUD_URL:-}"
[ -n "$cloud" ] || { echo "没有设置 ENCLAVE_CLOUD_URL（https://你的官网域名）。工作台必须登录才能用，没有服务器地址的包没法用。"; exit 1; }
[[ "$cloud" =~ ^https://[^/@?#]+$ ]] || { echo "ENCLAVE_CLOUD_URL 要写成 https://域名，后面不带路径和斜杠。现在是：$cloud"; exit 1; }

# 1. 本机 Host（作为 sidecar 打进 app）
npm ci
cargo build --release -p enclave-host
# 核对写进去的就是这个地址：同一个 target 目录里刚编译过指向冒烟替身服务器的版本。
grep -a -q -F "$cloud" target/release/enclave-host || { echo "enclave-host 里没有找到 $cloud，不能打包。"; exit 1; }
if grep -a -q -F "http://127.0.0.1:17956" target/release/enclave-host; then echo "enclave-host 指向的是冒烟测试的替身服务器，不能打包。"; exit 1; fi
cargo test -p enclave-host
mkdir -p apps/desktop/src-tauri/binaries
cp target/release/enclave-host "apps/desktop/src-tauri/binaries/enclave-host-$triple"

# 2. 工作台。页面只和本机 Host 说话，不需要知道服务器在哪。
npm run build
[ -f dist/index.html ] || { echo "dist/index.html 不存在"; exit 1; }

# 3. 打包
npx --yes @tauri-apps/cli@2 build --config "$PWD/apps/desktop/src-tauri/tauri.conf.json" --bundles dmg

echo "dmg 在 apps/desktop/src-tauri/target/release/bundle/dmg/"
echo "算哈希：shasum -a 256 <dmg>"
