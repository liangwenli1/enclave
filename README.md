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
kernels.manifest.json     内核清单（url / bytes / sha256 / 通道）
docs/  security/          交付合同、内核准入、威胁模型
```

官网和云端 API（注册登录、订阅、环境名额与启动授权、内核上架）在另一个仓库 `enclave-www`，两边构建互不依赖。
这个仓库只有桌面客户端。

## 三个进程，一条链路

```
Enclave.exe (Tauri)
 ├─ 生成 32 字节令牌
 ├─ 带着令牌启动 enclave-host（sidecar）
 └─ 把同一个令牌注入 WebView

工作台 (WebView)  ──令牌──>  enclave-host (127.0.0.1:17891)  ──spawn──>  fingerprint-chromium
                                   │
                                   └──HTTPS──> 云端 API（登录、额度、环境名额、运行租约、内核清单）
```

工作台要登录后才能用，订阅状态以服务器为准：新建和启动环境前，本机服务都会现问服务器。
和服务器说话的只有本机服务——设备令牌在系统钥匙串里，页面碰不到，也不直接连外网。
指纹、代理、Cookie 不上传，服务器只知道环境的名字。

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
npm test             # 深链接解析、会话状态
npm run typecheck
cargo test -p enclave-host
```

无显示器时内核强制无头，界面会标明。root / 容器里需要在安全中心明确勾选关闭沙箱，默认不开。

## 打 Windows 安装包

在有桌面会话的 Windows 上：

```powershell
$env:ENCLAVE_CLOUD_URL = "https://你的官网域名"   # 必填：工作台要登录才能用
powershell -ExecutionPolicy Bypass -File .\scripts\windows-msi.ps1
```

细节和代码签名见 [docs/build.md](docs/build.md)。
**没有 Authenticode 正式签名之前不能叫 1.0。**

## 不许做的事

- 内核二进制、`data/`、构建产物进 Git。
- 没有 sha256 的内核进 `stable` 通道。
- 界面上出现没接通的按钮、占位区块、内部术语。
- 向第三方发任何请求（页面只连本机服务；本机服务只连自己的云端 API 和内核的上游下载地址）。
