# Enclave 官网

产品介绍、套餐、下载 SHA256、文档、账号。**不是**桌面工作台，也不是内核 Host。

静态站点，无构建步骤：

```bash
python3 -m http.server 4173
```

打开 `index.html`。

安装包未签发，下载页不会提供 `.msi` / `.dmg` 按钮。内核哈希来自 GitHub Release `adryfish/fingerprint-chromium` 148.0.7778.215。

工作台源码在私有仓 `liangwenli1/enclave`。
