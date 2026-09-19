# Enclave 官网

静态页。本机映射 `3011`，前面用 Cloudflare Tunnel。

```bash
git clone https://github.com/liangwenli1/enclave-www.git
cd enclave-www
docker compose up -d --build
```

cloudflared 指到 `http://127.0.0.1:3011`（或这台机的 `http://<内网IP>:3011`）。
