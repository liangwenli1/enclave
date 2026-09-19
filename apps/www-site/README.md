# Enclave 官网

产品介绍、套餐、下载 SHA256、文档、账号。**不是**桌面工作台，也不是内核 Host。

```bash
docker build -t enclave-www .
docker run --rm -p 3011:80 enclave-www
```

或在 `liangwenli1/enclave` 根目录：

```bash
docker compose up -d --build www
```

安装包未签发，下载页没有 `.msi` / `.dmg` 按钮。
