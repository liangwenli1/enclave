# Unsigned Windows MSI. This is not Authenticode-signed and must not be called 1.0.
$ErrorActionPreference = "Stop"
Set-Location (Split-Path -Parent $PSScriptRoot)

function Need($cmd, $hint) {
  if (-not (Get-Command $cmd -ErrorAction SilentlyContinue)) {
    throw "Missing $cmd. $hint"
  }
}

Need git "Install Git for Windows."
Need node "Install Node 22 LTS."
Need rustup "Install Rust from https://rustup.rs"
Need cargo "rustup default stable then reopen the terminal."
Need npm "Node installer should provide npm."

rustup default stable
Get-Process enclave-host, Enclave -ErrorAction SilentlyContinue | Stop-Process -Force

npm ci
cargo build --release -p enclave-host
if (-not $?) { throw "host build failed" }

$binDir = Join-Path $PWD "apps\desktop\src-tauri\binaries"
New-Item -ItemType Directory -Force -Path $binDir | Out-Null
Copy-Item "target\release\enclave-host.exe" (Join-Path $binDir "enclave-host-x86_64-pc-windows-msvc.exe") -Force

$env:VITE_ENCLAVE_DIRECT = "true"
npm run build
if (-not $?) { throw "frontend build failed" }

if (-not (Test-Path "dist\index.html")) {
  if (Test-Path ".vercel\output\static\index.html") {
    New-Item -ItemType Directory -Force -Path dist | Out-Null
    Copy-Item ".vercel\output\static\*" dist -Recurse -Force
  }
}
if (-not (Test-Path "dist\index.html")) {
  throw "frontend dist/index.html missing. Desktop build must emit a static shell."
}

npx --yes @tauri-apps/cli@2 build --config apps/desktop/src-tauri/tauri.conf.json --bundles msi
if (-not $?) { throw "tauri msi failed" }

Write-Host "Unsigned MSI is under apps/desktop/src-tauri/target/release/bundle/msi/"
Write-Host "Do not call this 1.0. Upload with: gh release upload v0.9.0-windows-preview <msi> --clobber"
