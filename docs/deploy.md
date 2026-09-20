# 部署

要跑起来的只有两个东西：官网（静态）和许可证服务。工作台不部署，它是安装包。

## 一次起完

许可证服务的源码在本仓库 `apps/vendor`，compose 在 `enclave-www` 仓库。

```bash
# 1. 本仓库：构建许可证服务镜像
docker build -t enclave-vendor:latest apps/vendor

# 2. 官网仓库：配置管理员令牌并起服务
cd ../enclave-www
echo "ENCLAVE_ADMIN_TOKEN=$(openssl rand -hex 32)" > .env
docker compose up -d
```

`www` 映射到主机 `127.0.0.1:3011`，cloudflared 指过去。
`api` 不映射主机端口，只能经官网的 `/api/*` 访问。

## 签名密钥

许可证服务首次启动会生成 Ed25519 密钥，存在 `vendor-data` 卷里，并在日志打印公钥：

```bash
docker compose logs api | grep 'public key'
```

把这个值填进 `src/lib/license/public-key.ts`，然后重新构建工作台。
**换密钥 = 所有已签发的许可证立刻失效**，必须同时发新版客户端。

备份这个卷。丢了私钥等于所有人回落免费档。

## 打包客户端时要指对地址

```powershell
$env:VITE_ENCLAVE_VENDOR_URL = "https://你的官网域名"
```

没设就是空值：工作台照常能用，但账号页会说"这个版本没有配置账号服务地址"，
不会出现一个点了没反应的登录按钮。

## 开通付费档

```bash
curl -X POST https://你的域名/api/admin/plan \
  -H "x-admin-token: $ENCLAVE_ADMIN_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"email":"user@example.com","plan":"pro","expiresAt":1790000000000}'
```

查看待处理申请和留言：

```bash
curl -H "x-admin-token: $ENCLAVE_ADMIN_TOKEN" https://你的域名/api/admin/requests
```
