# 工作台 Release

客户拿到的是 GitHub Release 里的安装包，不是 Linux 容器。

## 现在缺什么

这边出不了 `.msi` / `.dmg`：没有 Windows/macOS 构建机，也没有签名证书。`apps/desktop` 是 Tauri 壳配置，`bundle.active` 仍是关的。

## 怎么打出第一包（未签名，不能叫 1.0）

在 **Windows x64** 或 **macOS Apple Silicon** 本机，不要在这台 Ubuntu 上：

```bash
git clone git@github.com:liangwenli1/enclave.git
cd enclave
npm ci
cargo build --release -p enclave-host
# 装好 Tauri 2 CLI 与平台 WebView 后
# 打开 bundle.active，补 icon，再：
# npx tauri build
```

产物：`Enclave_0.1.0_x64_en-US.msi` 或 `.dmg`。

然后：

```bash
git tag v0.1.0
git push origin v0.1.0
gh release create v0.1.0 ./bundle/msi/*.msi --title "v0.1.0" --notes "unsigned, not 1.0"
```

把 SHA256 填进官网下载页。没有哈希就不要放下载按钮。

## 叫 1.0 之前还要

- Authenticode（Win）
- Developer ID + Notarize（mac）
- win-x64 / mac-arm64 内核在对应系统 spawn 过，通道从 candidate 升 stable
