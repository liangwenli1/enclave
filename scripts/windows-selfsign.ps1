# Self-sign the MSI for local testing. Not 1.0. Other PCs still see SmartScreen.
$ErrorActionPreference = "Stop"
Set-Location (Split-Path -Parent $PSScriptRoot)

$msi = Get-ChildItem "apps\desktop\src-tauri\target\release\bundle\msi\*.msi" | Select-Object -First 1
if (-not $msi) { throw "No MSI. Run scripts\windows-msi.ps1 first." }

$subject = "CN=Enclave Preview (self-signed)"
$cert = Get-ChildItem Cert:\CurrentUser\My |
  Where-Object { $_.Subject -eq $subject -and $_.NotAfter -gt (Get-Date) } |
  Select-Object -First 1
if (-not $cert) {
  $cert = New-SelfSignedCertificate `
    -Type CodeSigningCert `
    -Subject $subject `
    -FriendlyName "Enclave Preview self-signed" `
    -CertStoreLocation Cert:\CurrentUser\My `
    -HashAlgorithm SHA256 `
    -NotAfter (Get-Date).AddYears(2)
}

$cer = Join-Path $env:TEMP "enclave-preview.cer"
Export-Certificate -Cert $cert -FilePath $cer | Out-Null
Import-Certificate -FilePath $cer -CertStoreLocation Cert:\CurrentUser\TrustedPublisher | Out-Null
try {
  Import-Certificate -FilePath $cer -CertStoreLocation Cert:\CurrentUser\Root | Out-Null
} catch {
  Write-Host "Could not add to CurrentUser\Root (often needs a prompt). Signing anyway."
}
Remove-Item $cer -ErrorAction SilentlyContinue

$ts = "http://timestamp.digicert.com"
$sig = Set-AuthenticodeSignature -FilePath $msi.FullName -Certificate $cert -HashAlgorithm SHA256 -TimestampServer $ts
if ($sig.Status -ne "Valid" -and $sig.Status -ne "UnknownError") {
  # UnknownError sometimes appears when the TSA chain is not locally trusted; signature is still present.
  Write-Host "Signature status: $($sig.Status) $($sig.StatusMessage)"
}
if (-not $sig.SignerCertificate) { throw "self-sign failed" }

Write-Host "Self-signed $($msi.Name)"
Write-Host "Thumbprint $($cert.Thumbprint)"
Write-Host "This machine should show publisher Enclave Preview (self-signed)."
Write-Host "Other machines will still warn."
