# 内核准入

`kernels.manifest.json` 里每个条目单独过这一份。没有 sha256 或没完成行为基线的
平台不得进 `stable`。

## 当前

| 平台 | 通道 | sha256 | 结论 |
|---|---|---|---|
| linux-x64 148.0.7778.215 | stable | `70d23983…17f4` | 官方 Release；已验证 spawn |
| win-x64 | candidate | `9ef3f471…2579` | 官方 Release 哈希已记；未做 spawn/沙箱基线 |
| mac-arm64 | candidate | `b72f091e…a679` | 官方 Release 哈希已记；未在 macOS 上基线 |

## 每个版本的清单

1. 来源只认上游 GitHub Release 或厂商已签通道。
2. 记录 url、bytes、sha256、publisher、releasedAt。
3. 准入时：校验压缩包 → **强制重新解压** → 对可执行文件单独算 sha256 并记录大小与修改时间。
4. 启动前：核对可执行文件。本进程第一次全量 sha256，之后比对大小/修改时间，
   对不上就升级成全量。失败 → `KERNEL_HASH_MISMATCH`。
5. `channel != stable` → `KERNEL_CHANNEL_BLOCKED`，除非用户在安全中心明确同意。
6. 默认开沙箱。`--no-sandbox` 不得作为产品默认，必须用户勾选并写入审计。
7. 补丁源码若延迟，不得宣传"已完整审计"。
8. 禁止覆盖已发布版本的哈希。

## 转 stable 的条件

在目标系统上完成：spawn 出可见窗口、沙箱默认开启可用、CDP 握手成功、
代理与 WebRTC 不泄露本机 IP、连续 3 次启动画像稳定。
记录结果后才能把 `channel` 改成 `stable`。
