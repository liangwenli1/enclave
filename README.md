# Enclave

本机多环境浏览器。内核 fingerprint-chromium 跑在**客户自己的电脑上**，
每个环境独立的 Cookie、指纹和出口。发行物是桌面安装包，不是网页。

交付合同见 [docs/enclave-final-delivery.md](docs/enclave-final-delivery.md)。
视觉规范见 [DESIGN.md](DESIGN.md)（和官网同一套 token）。

## 仓库结构

```
src/                      React 工作台（纯前端 SPA，没有服务端）
crates/host/              Rust 本机服务：哈希准入、spawn、CDP，只绑 127.0.0.1
apps/desktop/src-tauri/   Tauri 壳：生成令牌、拉起本机服务、注入令牌给工作台
apps/vendor/              许可证服务：账号、档位、设备绑定、Ed25519 签名许可证
kernels.manifest.json     内核清单（url / bytes / sha256 / 通道）
docs/  security/          交付合同、内核准入、威胁模型
```

官网在另一个仓库 `enclave-www`，它同时负责把 `apps/vendor` 跑起来。

## 三个进程，一条链路

```
Enclave.exe (Tauri)
 ├─ 生成 32 字节令牌
 ├─ 带着令牌启动 enclave-host（sidecar）
 └─ 把同一个令牌注入 WebView

工作台 (WebView)  ──令牌──>  enclave-host (127.0.0.1:17891)  ──spawn──>  fingerprint-chromium
      │
      └──HTTPS──> 许可证服务（只做登录和续签，不碰环境数据）
```

本机接口三道门：Host 头必须回环、Origin 必须是工作台自己、Bearer 令牌必须匹配。
**没有跳过鉴权的开关。**

## 开发

需要 Node 22+、Rust stable。

```bash
npm ci
npm run dev          # 自动构建并拉起 enclave-host，然后起 vite dev
```

开发模式下工作台从 `data/host.token` 取令牌（只在 `vite dev` 存在这个通道）。
打开 http://127.0.0.1:8080 —— 只绑回环，不在局域网里裸奔。

首次在内核页准入：下载对应平台的内核包、校验 SHA256、解压，并记录**实际可执行文件**
的哈希。之后每次启动环境都核对它。

```bash
npm run build        # 产物在 dist/，Tauri 直接打包这个目录
npm test             # 许可证验签等
npm run typecheck
cargo test -p enclave-host
```

无显示器时内核强制无头，界面会标明。root / 容器里需要在安全中心明确勾选关闭沙箱，默认不开。

## 打 Windows 安装包

在有桌面会话的 Windows 上：

```powershell
$env:VITE_ENCLAVE_VENDOR_URL = "https://你的官网域名"
powershell -ExecutionPolicy Bypass -File .\scripts\windows-msi.ps1
```

细节和代码签名见 [docs/build.md](docs/build.md)。
**没有 Authenticode 正式签名之前不能叫 1.0。**

## 不许做的事

- 内核二进制、`data/`、构建产物进 Git。
- 没有 sha256 的内核进 `stable` 通道。
- 界面上出现没接通的按钮、占位区块、内部术语。
- 向第三方发任何请求（工作台只连本机服务和自己的许可证服务）。
