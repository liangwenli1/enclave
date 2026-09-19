# Enclave

开发验证见 Linux Host；**发行物是桌面安装包**。

客户用法（1.0）：官网下载 Windows / macOS 安装包 → 本机打开工作台 → 登录账号 → 启动环境时在**自己电脑**上 spawn 已准入的 fingerprint-chromium。不是 VPS 网页，不是 Serverless，不是 `npm run dev`。

本仓库目前是私有源码 + Linux 真 spawn 验证机。它证明单轨内核链路可走，**不是最终交付物**。合同见 [docs/enclave-final-delivery.md](docs/enclave-final-delivery.md)。

## 现状

| 模块 | 现在 | 1.0 |
|---|---|---|
| React 工作台 | 可用（验证预览） | 塞进 Tauri WebView |
| Linux 内核 148 哈希准入 + 真 spawn | 可用 | 同一套适配器加 win-x64 / mac-arm64 |
| 实验室：对照页 vs 内核 CDP | Linux 无头已跑通 | 采集本机内核窗口，`runtime: native` |
| 签过名的 `.msi` / `.dmg` | 未做 | 必须 |
| 账号订阅与额度 | 未做 | 必须 |
| Tauri Host | P1 进行中 | spawn / 校验 / 保险箱 / 更新全在 Rust |

## 仓库

```
apps/desktop/          # Tauri 壳（有桌面会话的机器上构建）
crates/host/           # Rust Host：校验、spawn、CDP
src/                   # React 工作台（验证期仍由 Vite 加载）
kernels.manifest.json  # linux-x64 stable；win-x64 / mac-arm64 为 pending
docs/enclave-final-delivery.md
security/
deploy/                # 仅内部 Linux 验证机，不是客户交付
```

内核二进制禁止进 Git。没有 sha256 的平台不得进入 `stable`。

## 内部验证机（非 1.0）

Linux x64，常驻进程，用于验证适配器。不要拿去卖。

```bash
npm ci
cargo build --release -p enclave-host
./target/release/enclave-host   # 本机回环 Host
npm run dev                     # 只给开发预览，不是发行路径
```

首次打开「内核」下载并校验 linux-x64 148。无显示器时强制 headless，UI 会标明。root / 容器需在安全中心明确勾选 `--no-sandbox`，默认不开。

[`deploy/enclave.service`](deploy/enclave.service) 只给内部验证机。

## 1.0 还不包含

签名安装包、公证、账号后台、Windows / macOS 已准入内核。那些在交付文档 P2–P4，未完成不得打 `1.0.0`。
