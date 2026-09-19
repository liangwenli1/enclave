# Run the workbench on Windows x64. This is not a signed 1.0 installer.
$ErrorActionPreference = "Stop"
Set-Location (Split-Path -Parent $PSScriptRoot)

function Need($cmd, $hint) {
  if (-not (Get-Command $cmd -ErrorAction SilentlyContinue)) {
    throw "Missing $cmd. $hint"
  }
}

Need git "Install Git for Windows."
Need node "Install Node 22 LTS from https://nodejs.org"
Need rustup "Install Rust from https://rustup.rs then reopen the terminal."
Need npm "Node installer should provide npm."

function Ensure-Rust {
  rustup default stable
  rustc -vV | Out-Null
  if ($LASTEXITCODE -eq 0) { return }
  Write-Host "Rust toolchain is broken. Reinstalling stable..."
  rustup toolchain uninstall stable
  rustup toolchain install stable --force
  rustup default stable
  rustc -vV
  if ($LASTEXITCODE -ne 0) {
    throw "rustc still broken. Run: rustup toolchain uninstall stable; rustup toolchain install stable --force"
  }
}

Ensure-Rust
Need cargo "rustup default stable should provide cargo. Reopen the terminal and retry."

Get-Process enclave-host -ErrorAction SilentlyContinue | Stop-Process -Force

npm ci
cargo build --release -p enclave-host
if (-not $?) { throw "host build failed" }

Write-Host "Starting host and workbench. First kernel admit downloads ~190MB zip."
npm run dev
