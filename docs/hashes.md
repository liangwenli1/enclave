# SHA256 公示

官网下载页显示的就是这张表。改这里必须同时改 `kernels.manifest.json` 和官网。

## 内核

来源：GitHub Release `adryfish/fingerprint-chromium` tag `148.0.7778.215` 的 asset digest。
没有 sha256 的包不得进 `stable` 通道。

| 平台 | 通道 | 文件 | sha256 | bytes |
|---|---|---|---|---|
| linux-x64 | stable | `ungoogled-chromium-148.0.7778.215-1-x86_64_linux.tar.xz` | `70d239830332e5820aa34dfcb284161cac0429eee25da642830afe04bda717f4` | 141269020 |
| win-x64 | candidate | `ungoogled-chromium_148.0.7778.215-1.1_windows_x64.zip` | `9ef3f471b7a6641b4224532522b29141ce3746e27d55788d88e2fd951f362579` | 189767686 |
| mac-arm64 | candidate | `ungoogled-chromium_148.0.7778.215-1.1_macos.dmg` | `b72f091e2e1a7583eed389c4b8e3534ed355e568af8c8bbf8fc30a25e23ca679` | 140187500 |

`candidate` 通道的内核在客户端会被拦住，要用户在安全中心明确同意才能准入
（原因码 `KERNEL_CHANNEL_BLOCKED`）。在对应系统上完成 spawn + 沙箱行为基线后才转 `stable`。

对外文案里不要说"candidate"，说"预览通道"。

## 安装包

| 版本 | 文件 | sha256 | bytes | 说明 |
|---|---|---|---|---|
| 0.9.1 | `Enclave_0.9.1_x64_en-US.msi` | `6af96a9b4dca0f4aa026f6277974e6e37c10d8551c9fb94bda61f5028f270534` | 7245824 | 2026-09 构建，**早于本机接口鉴权等安全更新** |

下一次构建后，用下面的命令取值并更新官网下载页与本表：

```powershell
Get-FileHash .\Enclave_x.y.z_x64_en-US.msi -Algorithm SHA256
(Get-Item .\Enclave_x.y.z_x64_en-US.msi).Length
```
