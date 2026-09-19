# 容器部署（这台 Ubuntu 宿主机）

已占用：`3000` meridian、`3010` trend-top、`8000` vaultwarden、`5432` postgres。

| 服务 | 容器 | 宿主机端口 | 说明 |
|---|---|---|---|
| 官网 | `enclave-www` | `0.0.0.0:3011` | 静态站，可以对外 |
| 工作台 | `enclave-workbench` | `127.0.0.1:3012` | Linux 验证机，只绑本机 |

工作台 **不是** 1.0。容器里没有显示器，内核是无头 spawn。不要把 `3012` 改成 `0.0.0.0`，也不要把 Host `17891` 映射出去。

## 拉代码

私有仓，机器上要有 GitHub 权限。

```bash
cd /opt
git clone git@github.com:liangwenli1/enclave.git
cd enclave
```

只上官网也可以只 clone `liangwenli1/enclave-www`。

## 启动两个

```bash
cd /opt/enclave
docker compose up -d --build
docker compose ps
```

- 官网：`http://<公网IP>:3011`
- 工作台：在这台机器上 `http://127.0.0.1:3012`（SSH 隧道或已有 cloudflared 私有路由）

只起官网：

```bash
docker compose up -d --build www
```

## cloudflared

已有 `cloudflared` 容器。给官网加一条到 `localhost:3011` 的 ingress。工作台不要挂到公网 hostname。

## 工作台第一次

打开内核页点准入。会从 GitHub Release 拉 linux-x64 约 135MB，校验哈希后才能启动环境。数据在 volume `enclave-data`，不打进镜像。

停：

```bash
docker compose down
```

volume 会留下已准入内核。连数据一起删：`docker compose down -v`。
