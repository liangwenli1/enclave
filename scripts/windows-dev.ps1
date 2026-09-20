# 在 Windows 上跑工作台（开发模式）。不是安装包。
$ErrorActionPreference = "Stop"
Set-Location (Split-Path -Parent $PSScriptRoot)

function Need($cmd, $hint) {
  if (-not (Get-Command $cmd -ErrorAction SilentlyContinue)) {
    throw "缺少 $cmd。$hint"
  }
}

Need git "装 Git for Windows。"
Need node "从 https://nodejs.org 装 Node 22 LTS。"
Need rustup "从 https://rustup.rs 装 Rust，装完重开终端。"
Need npm "Node 安装包会带 npm。"

rustup default stable
rustc -vV | Out-Null
if ($LASTEXITCODE -ne 0) {
  Write-Host "Rust 工具链有问题，重装 stable..."
  rustup toolchain uninstall stable
  rustup toolchain install stable --force
  rustup default stable
}
Need cargo "rustup default stable 之后重开终端再试。"

Get-Process enclave-host -ErrorAction SilentlyContinue | Stop-Process -Force

npm ci
cargo build --release -p enclave-host
if (-not $?) { throw "host 构建失败" }

Write-Host "启动本机服务和工作台。第一次准入内核要下约 190MB。"
Write-Host "开发模式下工作台从 data/host.token 取令牌；这个通道只存在于 vite dev。"
npm run dev
