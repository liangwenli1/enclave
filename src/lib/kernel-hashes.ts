export const KERNEL_HASHES = [
  {
    platform: "linux-x64",
    channel: "stable",
    file: "ungoogled-chromium-148.0.7778.215-1-x86_64_linux.tar.xz",
    sha256: "70d239830332e5820aa34dfcb284161cac0429eee25da642830afe04bda717f4",
    bytes: 141269020,
  },
  {
    platform: "win-x64",
    channel: "candidate",
    file: "ungoogled-chromium_148.0.7778.215-1.1_windows_x64.zip",
    sha256: "9ef3f471b7a6641b4224532522b29141ce3746e27d55788d88e2fd951f362579",
    bytes: 189767686,
  },
  {
    platform: "mac-arm64",
    channel: "candidate",
    file: "ungoogled-chromium_148.0.7778.215-1.1_macos.dmg",
    sha256: "b72f091e2e1a7583eed389c4b8e3534ed355e568af8c8bbf8fc30a25e23ca679",
    bytes: 140187500,
  },
] as const;

export const APP_INSTALLERS = [
  {
    platform: "Windows x64",
    file: "Enclave_0.9.0_x64_en-US.msi",
    sha256: "",
    status: "预览 · 自签名",
    href: "https://github.com/liangwenli1/enclave/releases/tag/v0.9.0-windows-preview",
  },
  { platform: "macOS Apple Silicon", file: "Enclave-0.1.0-arm64.dmg", sha256: "", status: "未签发", href: "" },
] as const;
