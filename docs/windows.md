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

