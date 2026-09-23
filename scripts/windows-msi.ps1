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

# 服务器地址在编译 Host 时写进去。工作台要登录后才能用，没有它的安装包装上之后什么都做不了。
$cloud = $env:ENCLAVE_CLOUD_URL
if (-not $cloud) { throw "没有设置 ENCLAVE_CLOUD_URL（https://你的官网域名）。工作台必须登录才能用，没有服务器地址的包没法用。" }
if ($cloud -notmatch '^https://[^/@?#]+$') { throw "ENCLAVE_CLOUD_URL 要写成 https://域名，后面不带路径和斜杠。现在是：$cloud" }

# 1. 本机 Host（会作为 sidecar 打进安装包）
npm ci
cargo build --release -p enclave-host
if (-not $?) { throw "host 构建失败" }
# 核对写进去的就是这个地址：同一个 target 目录里可能刚编译过指向别处的版本（比如冒烟测试用的）。
$hostBytes = [System.IO.File]::ReadAllBytes((Join-Path $PWD "target\release\enclave-host.exe"))
$hostText = [System.Text.Encoding]::ASCII.GetString($hostBytes)
if (-not $hostText.Contains($cloud)) { throw "enclave-host.exe 里没有找到 $cloud，不能打包。" }
if ($hostText.Contains("http://127.0.0.1:17956")) { throw "enclave-host.exe 指向的是冒烟测试的替身服务器，不能打包。" }
cargo test -p enclave-host
if (-not $?) { throw "host 测试没过" }

$binDir = Join-Path $PWD "apps\desktop\src-tauri\binaries"
New-Item -ItemType Directory -Force -Path $binDir | Out-Null
Copy-Item "target\release\enclave-host.exe" (Join-Path $binDir "enclave-host-x86_64-pc-windows-msvc.exe") -Force

# 2. 工作台（纯前端 SPA，产物在 dist/，Tauri 直接用）。页面只和本机 Host 说话，不需要知道服务器在哪。
npm run build
if (-not $?) { throw "前端构建失败" }
if (-not (Test-Path "dist\index.html")) { throw "dist/index.html 不存在" }

# 3. 打包
npx --yes @tauri-apps/cli@2 build --config (Join-Path $PWD "apps\desktop\src-tauri\tauri.conf.json") --bundles msi
if (-not $?) { throw "tauri msi 失败" }

Write-Host "MSI 在 apps/desktop/src-tauri/target/release/bundle/msi/"
Write-Host "算哈希：Get-FileHash <msi> -Algorithm SHA256，把值更新到官网下载页。"
Write-Host "没有 Authenticode 正式签名之前，不要叫 1.0。"
