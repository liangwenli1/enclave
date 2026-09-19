# Windows x64 怎么跑通工作台

这是 **本机开发/验证**，不是签过名的 1.0 安装包。内核会在你这台 Windows 上弹出窗口。

## 1. 装工具

- Git for Windows
- Node 22 LTS
- Rust：https://rustup.rs （装完重开终端）
- Visual Studio Build Tools 2022，勾选 **Desktop development with C++**（cargo 链接用）

## 2. 拉代码并启动

PowerShell：

```powershell
git clone git@github.com:liangwenli1/enclave.git
cd enclave
powershell -ExecutionPolicy Bypass -File .\scripts\windows-dev.ps1
```

或手动：

```powershell
npm ci
rustup default stable
cargo build --release -p enclave-host
npm run dev
```

浏览器打开脚本提示的工作台地址。

## 3. 第一次

1. 内核页 → 准入。会下载 win-x64 zip（约 190MB），校验 SHA256。通道是 candidate，哈希已记。
2. 新建环境 → 锁定画像 → 启动。应弹出 fingerprint-chromium 窗口，不是网页里的 Chrome。
3. 实验室采集该窗口。

哈希不符或没准入会拒启，不会假 Running。

## 4. 预览 Release

源码 tag：`v0.9.0-windows-preview`（pre-release）。还不是安装包。

未签名 MSI 在本机打：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\windows-msi.ps1
```

产物在 `apps/desktop/src-tauri/target/release/bundle/msi/`。挂到 GitHub 仍标 pre-release。Authenticode 之前不能叫 1.0。

## 5. 怎么签名

自签证书只能本机玩，SmartScreen 仍会拦，**不能当 1.0**。对外必须用买来的 Authenticode。

1. 买证书（三选一）
   - **Azure Trusted Signing**（微软，推荐走这条）
   - OV 代码签名（DigiCert / Sectigo / SSL.com）
   - EV 代码签名（USB 钥匙或云签，SmartScreen 信誉建立更快）
2. 安装 [Windows SDK](https://developer.microsoft.com/windows/downloads/windows-sdk/) 时勾选 **Windows SDK Signing Tools**，得到 `signtool.exe`。
3. 证书进系统存储后：

```powershell
# 看指纹
certutil -store My

$env:ENCLAVE_CERT_THUMBPRINT = "你的SHA1指纹"
powershell -ExecutionPolicy Bypass -File .\scripts\windows-sign.ps1
```

或 PFX：

```powershell
$env:ENCLAVE_CERT_PFX = "C:\certs\enclave.pfx"
$env:ENCLAVE_CERT_PASSWORD = "..."
powershell -ExecutionPolicy Bypass -File .\scripts\windows-sign.ps1
```

4. 再上传覆盖预览包：

```powershell
gh release upload v0.9.0-windows-preview ".\apps\desktop\src-tauri\target\release\bundle\msi\Enclave_0.9.0_x64_en-US.msi" --clobber
```

Tauri 以后也可以把指纹写进 `tauri.conf.json` 的 `bundle.windows.certificateThumbprint`，打 MSI 时顺带签。没有证书之前不要改。

本地先自签（仅这台电脑）：

```powershell
git pull
powershell -ExecutionPolicy Bypass -File .\scripts\windows-selfsign.ps1
gh release upload v0.9.0-windows-preview ".\apps\desktop\src-tauri\target\release\bundle\msi\Enclave_0.9.0_x64_en-US.msi" --clobber
```

会生成 `CN=Enclave Preview (self-signed)` 并签 MSI。别的电脑仍会 SmartScreen / 未知发布者。



