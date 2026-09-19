# apps/desktop

Tauri 2 壳。在有桌面会话、代码签名证书的机器上构建。这个目录在 Linux 验证机上不编译、不假装已经能装。

发行物：

- Windows x64 签名 `.msi` / `.exe`
- macOS Apple Silicon 公证 `.dmg`

开发（客户机，不是本仓库的 Vite 预览）：

```
# 需要本机已装 Tauri 2 CLI 与平台 WebView
npm ci
cargo build --release -p enclave-host
# 然后 tauri dev，加载仓库根上的 React 工作台
```

Host 逻辑在 `crates/host`。这里只包 WebView 与 IPC 白名单。没有签过名的包不得称为 1.0。
