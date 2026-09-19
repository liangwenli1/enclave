# Enclave 当前交付物（截至 2026-09-19）

仓库：[github.com/liangwenli1/enclave](https://github.com/liangwenli1/enclave) · commit 跟 `main`。

> 这不是 1.0。1.0 必须是签过名的 Windows / macOS 安装包。  
> 下面按「客户能拿到什么」列。没有的不写成就。

## 有

| 交付件 | 形态 | 位置 |
|---|---|---|
| 源码 | 私有 Git 仓 | `liangwenli1/enclave` |
| Linux 验证机工作台 | React 四区 + 实验室 + 内核 + 安全中心 | `/` 预览 |
| Rust Host | 哈希准入、真 spawn、CDP 只绑本机 | `crates/host` |
| 内核清单 | linux-x64 **stable**；win-x64 / mac-arm64 **candidate** | `kernels.manifest.json`、`docs/hashes.md` |
| 本机额度 | Free 3 / Solo 50 / Pro 200，并发上限 | 设置页，创建/启动时强制 |
| 首次引导 | 选档 → 下内核 → 样例环境 → 实验室 | 工作台 |
| 发行合同 / 威胁模型 / 内核准入 | Markdown | `docs/`、`security/` |
| Tauri 壳配置 | 未在本机构建安装包 | `apps/desktop` |
| 官网 | 刚补：产品 / 套餐 / 下载 / 账号 | `/www` |

## 没有（所以不能叫 1.0）

- Authenticode 签名的 `.msi` / `.exe`
- Developer ID + Notarize 的 `.dmg`
- 厂商许可证服务器（官网登录目前是本机演示账号）
- Win / mac 本机 spawn 行为基线（哈希已记，未在对应系统跑过）

## 内核 SHA256（GitHub Release 148.0.7778.215）

- linux-x64 `70d239830332e5820aa34dfcb284161cac0429eee25da642830afe04bda717f4`
- win-x64 `9ef3f471b7a6641b4224532522b29141ce3746e27d55788d88e2fd951f362579`
- mac-arm64 `b72f091e2e1a7583eed389c4b8e3534ed355e568af8c8bbf8fc30a25e23ca679`

完整表见 `docs/hashes.md`。
