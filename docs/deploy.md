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

把这个值填进**两处**，然后重新打包客户端：

- `src/lib/license/public-key.ts` —— 工作台用它验许可证；
- `crates/host/src/feed.rs` 的 `VENDOR_PUBLIC_KEY` —— 本机服务用它验内核清单。

两处不一致时 `cargo test` 会失败，不会带着错的钥匙发出去。
**换密钥 = 所有已签发的许可证立刻失效、已发出的客户端不再接受你上架的内核**，必须同时发新版客户端。

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

## 上架一个内核版本

用户不用重装，工作台启动时（以及之后每 6 小时）会来取一次清单，新版本出现在「内核管理」页。

1. 到上游 https://github.com/adryfish/fingerprint-chromium/releases 下载要上架的那个文件。
   **你自己下载、自己算哈希**：这一步就是"由你确认这个文件可以给用户跑"。

   ```bash
   sha256sum ungoogled-chromium_150.0.1.2-1.1_windows_x64.zip      # Windows 上用 Get-FileHash
   stat -c %s ungoogled-chromium_150.0.1.2-1.1_windows_x64.zip     # 字节数
   ```

2. 登记。每个平台登记一次（`win-x64` / `mac-arm64` / `linux-x64`）：

   ```bash
   curl -X POST https://你的域名/api/admin/kernels \
     -H "x-admin-token: $ENCLAVE_ADMIN_TOKEN" \
     -H 'content-type: application/json' \
     -d '{
       "version":  "150.0.1.2",
       "platform": "win-x64",
       "channel":  "candidate",
       "url":      "https://github.com/adryfish/fingerprint-chromium/releases/download/150.0.1.2/ungoogled-chromium_150.0.1.2-1.1_windows_x64.zip",
       "sha256":   "<第 1 步算出来的>",
       "bytes":    189767686
     }'
   ```

   - `channel`：`candidate` 是预览，用户要在安全中心同意过才能下载；`stable` 会成为新建环境的默认版本
     （默认 = 最新的稳定版）。先上 `candidate`，自己跑过没问题，再用同样的命令把它改成 `stable`。
   - 同一个 `version` + `platform` 再登记一次就是修改。
   - `url` 只接受上游那个仓库的 Release 地址，别的地址登记不进来，本机服务也不会去下。

3. 查看 / 下架：

   ```bash
   curl -H "x-admin-token: $ENCLAVE_ADMIN_TOKEN" https://你的域名/api/admin/kernels
   curl -X DELETE -H "x-admin-token: $ENCLAVE_ADMIN_TOKEN" https://你的域名/api/admin/kernels/150.0.1.2/win-x64
   ```

   下架之后：没下载过的用户看不到它了；已经下载的用户照常能用，界面标"已下架"，删掉后不能再下载。
   已有的环境**不会**自动换到新版本——换内核等于换浏览器版本，由用户自己在环境页里改。

安装包自带的那个版本（`kernels.manifest.json`）永远在列表里，远程清单盖不掉它，
所以没有域名、或者许可证服务连不上的时候，一切照旧。
