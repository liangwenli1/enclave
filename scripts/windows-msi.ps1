# 在 Windows 上打 MSI。这个包还没有 Authenticode 正式签名，不能叫 1.0。
$ErrorActionPreference = "Stop"
Set-Location (Split-Path -Parent $PSScriptRoot)

function Need($cmd, $hint) {
  if (-not (Get-Command $cmd -ErrorAction SilentlyContinue)) {
    throw "缺少 $cmd。$hint"
  }
}

Need node "装 Node 22 LTS。"
Need rustup "从 https://rustup.rs 装 Rust。"
Need cargo "rustup default stable 之后重开终端。"
Need npm "Node 安装包会带 npm。"

rustup default stable
Get-Process enclave-host, enclave-desktop, Enclave -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Seconds 1

# 1. 本机 Host（会作为 sidecar 打进安装包）
npm ci
cargo build --release -p enclave-host
if (-not $?) { throw "host 构建失败" }
cargo test -p enclave-host
if (-not $?) { throw "host 测试没过" }

$binDir = Join-Path $PWD "apps\desktop\src-tauri\binaries"
New-Item -ItemType Directory -Force -Path $binDir | Out-Null
Copy-Item "target\release\enclave-host.exe" (Join-Path $binDir "enclave-host-x86_64-pc-windows-msvc.exe") -Force

# 2. 工作台（纯前端 SPA，产物在 dist/，Tauri 直接用）
#    VITE_ENCLAVE_VENDOR_URL 指向许可证服务；不设就是不能登录，额度停在免费档。
if (-not $env:VITE_ENCLAVE_VENDOR_URL) {
  Write-Warning "没有设置 VITE_ENCLAVE_VENDOR_URL，这个包里的账号登录不可用。"
}
npm run build
if (-not $?) { throw "前端构建失败" }
if (-not (Test-Path "dist\index.html")) { throw "dist/index.html 不存在" }

# 3. 打包
npx --yes @tauri-apps/cli@2 build --config (Join-Path $PWD "apps\desktop\src-tauri\tauri.conf.json") --bundles msi
if (-not $?) { throw "tauri msi 失败" }

Write-Host "MSI 在 apps/desktop/src-tauri/target/release/bundle/msi/"
Write-Host "算哈希：Get-FileHash <msi> -Algorithm SHA256，把值更新到官网下载页。"
Write-Host "没有 Authenticode 正式签名之前，不要叫 1.0。"
