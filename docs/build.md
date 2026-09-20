# 开发与打包（Windows / macOS）

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

### 3a. 不用 Windows 机器：让 GitHub 打

1. （有域名之后再做）仓库 Settings → Secrets and variables → Actions → **Variables**，新建
   `VITE_ENCLAVE_VENDOR_URL` = `https://你的官网域名`。这是许可证服务的地址，构建时写进前端。
   **不设也能打包**：包里的账号页不能登录、额度停在免费档，其余功能照常。和签名没有关系。
2. 版本号在三处，要一致：`package.json`、`apps/desktop/src-tauri/Cargo.toml`、
   `apps/desktop/src-tauri/tauri.conf.json`。
3. 打 tag 并推上去：

   ```bash
   git tag v0.9.2
   git push origin main v0.9.2
   ```

4. Actions 里的 **Release** 跑完（约 15 分钟）后，Releases 页会多一个**草稿**，MSI 已经挂在上面，
   SHA256 和字节数写在说明里，也在那次运行的 Summary 里。
5. 用这两个值更新官网 `site/download.html`（下载地址、文件名、SHA256、字节）和 `docs/hashes.md`，
   然后在草稿上点 **Publish**。先更新官网再发布，下载页上的哈希才不会有一刻对不上。

只想试打一次、不建 Release：Actions → Release → Run workflow，MSI 在那次运行的 Artifacts 里。

同一次运行也会打 macOS 的 dmg，见第 6 节。

### 3b. 在自己的 Windows 机器上打

这一步要能访问 npm 和 github.com：Tauri 第一次打包会下载 WiX。
如果最后 `light.exe` 报错，到「设置 → 可选功能」里启用 **VBSCRIPT**（Win11 24H2 默认没开）。

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

## 6. macOS（Apple Silicon）

和 MSI 一起由 Release 工作流打出来，挂在同一个草稿 Release 上。自己有 Mac 的话：

```bash
./scripts/macos-dmg.sh
```

打包之前，工作流会先在 GitHub 的 mac 机器上跑 `scripts/smoke-host.sh`：用清单里真实的内核走一遍
下载 → 校验哈希 → 挂载 dmg 拷出 `Chromium.app` → 启动 → 调试端口握手 → 停止。这一步不过就不出包。
它验证的是本机服务这条链路；**窗口界面没有人在真 Mac 上看过**。

dmg 是 ad-hoc 签名、未公证的。从浏览器下载的 app 会被 Gatekeeper 标成"已损坏"，装好后先执行：

```bash
xattr -cr /Applications/Enclave.app
```

要去掉这一步，需要 Apple 开发者账号做公证。只支持 Apple Silicon，不出 Intel 包。
