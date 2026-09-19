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
Need cargo "Install Rust from https://rustup.rs then reopen the terminal."
Need npm "Node installer should provide npm."

npm ci
cargo build --release -p enclave-host
if (-not $?) { throw "host build failed" }

Write-Host "Starting host and workbench. First kernel admit downloads ~190MB zip."
npm run dev
