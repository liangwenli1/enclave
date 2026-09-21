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
| 0.9.2 | `Enclave_0.9.2_x64_en-US.msi` | `6a7a888aa7d301c8415a9f4ddb14c64f9d8fe891cd08a3d91de87c9d1163126c` | 7122944 | GitHub Actions 构建（提交 `efb0468`）。未签名；**没有配置许可证服务地址，账号登录不可用**；早于「内核管理」 |
| 0.9.2 | `Enclave_0.9.2_aarch64.dmg` | `7b00f8ba371bbfeb4aac7c57b0b5c4080b5dde7f200205f8a9a141dee776a050` | 7207876 | 同上。Apple Silicon，ad-hoc 签名、未公证，装好后要 `xattr -cr`；构建前过了真机冒烟 |
| 0.9.1 | `Enclave_0.9.1_x64_en-US.msi` | `6af96a9b4dca0f4aa026f6277974e6e37c10d8551c9fb94bda61f5028f270534` | 7245824 | 2026-09 构建，**早于本机接口鉴权等安全更新** |

下一次发版后，SHA256 和字节数写在草稿 Release 的说明里（也在那次 Actions 运行的 Summary 里），
照着更新官网下载页与本表，再发布草稿。
