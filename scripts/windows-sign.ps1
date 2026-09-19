# Authenticode-sign the unsigned MSI. Requires a purchased OV/EV or Azure Trusted Signing cert.
# Self-signed certificates are not 1.0.
$ErrorActionPreference = "Stop"
Set-Location (Split-Path -Parent $PSScriptRoot)

$msi = Get-ChildItem "apps\desktop\src-tauri\target\release\bundle\msi\*.msi" | Select-Object -First 1
if (-not $msi) { throw "No MSI. Run scripts\windows-msi.ps1 first." }

$signtool = @(
  "${env:ProgramFiles(x86)}\Windows Kits\10\bin\10.0.26100.0\x64\signtool.exe",
  "${env:ProgramFiles(x86)}\Windows Kits\10\bin\10.0.22621.0\x64\signtool.exe",
  "${env:ProgramFiles(x86)}\Windows Kits\10\bin\x64\signtool.exe"
) | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $signtool) {
  $found = Get-ChildItem "${env:ProgramFiles(x86)}\Windows Kits\10\bin" -Recurse -Filter signtool.exe -ErrorAction SilentlyContinue |
    Where-Object { $_.FullName -match "\\x64\\signtool.exe$" } |
    Select-Object -First 1
  $signtool = $found.FullName
}
if (-not $signtool) {
  throw "signtool.exe missing. Install Windows SDK (Signing Tools) from Microsoft."
}

$thumb = $env:ENCLAVE_CERT_THUMBPRINT
$pfx = $env:ENCLAVE_CERT_PFX
$pass = $env:ENCLAVE_CERT_PASSWORD
$ts = if ($env:ENCLAVE_TIMESTAMP_URL) { $env:ENCLAVE_TIMESTAMP_URL } else { "http://timestamp.digicert.com" }

if ($thumb) {
  & $signtool sign /fd SHA256 /td SHA256 /tr $ts /sha1 $thumb $msi.FullName
} elseif ($pfx) {
  if ($pass) {
    & $signtool sign /fd SHA256 /td SHA256 /tr $ts /f $pfx /p $pass $msi.FullName
  } else {
    & $signtool sign /fd SHA256 /td SHA256 /tr $ts /f $pfx $msi.FullName
  }
} else {
  throw @"
Set one of:
  `$env:ENCLAVE_CERT_THUMBPRINT = '<cert SHA1 from certmgr>'
  `$env:ENCLAVE_CERT_PFX = 'C:\path\codesign.pfx'; `$env:ENCLAVE_CERT_PASSWORD = '...'
Then rerun this script.
"@
}
if (-not $?) { throw "signtool failed" }

& $signtool verify /pa $msi.FullName
if (-not $?) { throw "signature verify failed" }

Write-Host "Signed $($msi.FullName)"
Write-Host "Upload: gh release upload v0.9.0-windows-preview `"$($msi.FullName)`" --clobber"
