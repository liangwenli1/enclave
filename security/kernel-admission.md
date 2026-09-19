# 内核准入

每个 `kernels.manifest.json` 条目单独过这一份。没有 sha256 或未完成行为基线的平台不得进 `stable`。

## 当前

| 平台 | 通道 | sha256 | 结论 |
|---|---|---|---|
| linux-x64 148.0.7778.215 | stable | `70d23983…17f4` | 官方 Release；验证机已 spawn |
| win-x64 zip | candidate | `9ef3f471…2579` | 官方 Release 哈希已记；未在 Windows 上做 spawn/沙箱基线 |
| mac-arm64 dmg | candidate | `b72f091e…a679` | 官方 Release 哈希已记；上游文件名未拆 arm/intel；未在 macOS 上基线 |

## 清单（每个版本）

1. 来源只认 GitHub Release 或厂商已签通道。
2. 记录 url、bytes、sha256、publisher、releasedAt。
3. 启动前 `verifyOnDisk()`，失败 `KERNEL_HASH_MISMATCH` / `KERNEL_UNTRUSTED_SOURCE`。
4. 默认沙箱开。`--no-sandbox` 不得当产品默认。
5. 补丁源码若延迟，不得宣传「已完整审计」。
6. 禁止覆盖已签 version。
