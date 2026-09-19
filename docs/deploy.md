# 部署

## 官网

仓：https://github.com/liangwenli1/enclave-www  
端口 `3011`。compose 只在那个仓。

```bash
git clone git@github.com:liangwenli1/enclave-www.git
cd enclave-www
docker compose up -d --build
```

cloudflared 指到主机 `3011`。

## 工作台

不要在 Linux 上部署。见 `docs/release.md`。
