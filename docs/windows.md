# Windows：开发与打包

## 1. 工具

- Git for Windows
- Node 22 LTS
- Rust：https://rustup.rs （装完重开终端）
- Visual Studio Build Tools 2022，勾选 **Desktop development with C++**

## 2. 开发模式

```powershell
git clone <仓库地址>
cd enclave
powershell -ExecutionPolicy Bypass -File .\scripts\windows-dev.ps1
```

脚本会构建本机服务、拉起它，然后起开发服务器（http://127.0.0.1:8080，只绑回环）。
开发模式下工作台从 `data/host.token` 取令牌 —— 这个通道只存在于 `vite dev`，
打包产物里没有。

第一次：内核页 → 准入。会下载 win-x64 zip（约 190MB）并校验 SHA256。
win-x64 目前是预览通道，需要先到安全中心勾选"允许使用预览通道的内核"。

## 3. 打 MSI

```powershell
$env:VITE_ENCLAVE_VENDOR_URL = "https://你的官网域名"
powershell -ExecutionPolicy Bypass -File .\scripts\windows-msi.ps1
```

脚本会依次：构建并测试本机服务 → 拷成 sidecar → 构建前端到 `dist/` → 打 MSI。
产物在 `apps\desktop\src-tauri\target\release\bundle\msi\`。

打完之后取哈希，更新官网下载页和 `docs/hashes.md`：

```powershell
Get-FileHash .\Enclave_0.9.2_x64_en-US.msi -Algorithm SHA256
(Get-Item .\Enclave_0.9.2_x64_en-US.msi).Length
```

## 4. 代码签名

自签证书只能自己机器上玩，SmartScreen 仍会拦，**不能当 1.0**。对外必须用买来的 Authenticode。

1. 买证书（三选一）
   - **Azure Trusted Signing**（微软，推荐）
   - OV 代码签名（DigiCert / Sectigo / SSL.com）
   - EV 代码签名（USB 钥匙或云签，SmartScreen 信誉建立更快）
2. 装 [Windows SDK](https://developer.microsoft.com/windows/downloads/windows-sdk/) 时勾选
   **Windows SDK Signing Tools**，得到 `signtool.exe`。
3. 证书进系统存储后：

```powershell
certutil -store My                      # 看指纹
$env:ENCLAVE_CERT_THUMBPRINT = "你的SHA1指纹"
powershell -ExecutionPolicy Bypass -File .\scripts\windows-sign.ps1
```

或用 PFX：

```powershell
$env:ENCLAVE_CERT_PFX = "C:\certs\enclave.pfx"
$env:ENCLAVE_CERT_PASSWORD = "..."
powershell -ExecutionPolicy Bypass -File .\scripts\windows-sign.ps1
```

有证书之后可以把指纹写进 `tauri.conf.json` 的 `bundle.windows.certificateThumbprint`，
打包时顺带签。没有证书之前不要改这个字段。

## 5. 自检

打完包在一台干净的机器上按 `docs/enclave-final-delivery.md` 第 5 节的清单过一遍。
第 6、8、10 条（改内核文件拒启、网页调不动本机接口、锁着保险箱拒启）是这版的重点。
