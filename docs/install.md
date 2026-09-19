# 安装（1.0 客户路径）

客户拿到的是 **已签名的 Windows / macOS 安装包**，不是这份仓库里的 `npm run dev`。

本仓库现在交得出：

1. 源码  
2. Linux 验证机上的 Rust Host（真 spawn、哈希准入、CDP）  
3. React 工作台（额度、引导、实验室、安全中心）  
4. 内核 SHA256 清单  

本仓库现在交不出、因此 **不能打 1.0.0 tag**：

- Authenticode 签名的 `.msi` / `.exe`  
- Developer ID + Notarize 的 `.dmg`  
- 厂商账号后台  

要出安装包：在有桌面会话和证书的机器上，按 `apps/desktop/README.md` 用 Tauri 2 打包 `crates/host` + 本工作台。
