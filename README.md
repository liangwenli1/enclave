# Enclave

本地优先的多环境浏览器工作台。配置环境、校验 fingerprint-chromium 内核、在 Linux Host 上真实启动隔离进程，并用实验室对照当前页与内核 CDP 页面。

**不要把内核二进制提交进 Git。** 工作台按 [`kernels.manifest.json`](kernels.manifest.json) 从 GitHub Release 下载并校验 sha256。

## 现状

| 能力 | 状态 |
|---|---|
| 工作台（环境 / 网络 / 扩展 / 实验室 / 内核 / 安全中心） | 可用 |
| Linux x64 真实 spawn fingerprint-chromium 148 | 可用 |
| 启动前哈希准入、参数白名单、调试口只绑 127.0.0.1 | 可用 |
| 实验室：当前页对照 + 内核 CDP | 可用 |
| 已签名 Windows / macOS 安装包 | 未交付 |
| 可见 GUI 窗口 | 无显示器时强制 headless |
| Vercel / 无服务器 | **不能跑内核**（进程无法常驻） |

## 服务器部署（Linux x64 VPS）

内核必须在**常驻 Node 进程**里 spawn，不要用 Serverless。建议：Debian/Ubuntu x86_64，内存 ≥ 4 GB，磁盘 ≥ 8 GB。

### 1. 依赖

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs git xz-utils ca-certificates fonts-liberation
node -v   # v22+
```

Chromium 还需要常见系统库。若启动失败，按 stderr 补装，例如：

```bash
sudo apt-get install -y libnss3 libatk-bridge2.0-0 libgtk-3-0 libgbm1 libasound2
```

### 2. 拉代码

```bash
sudo useradd -m -s /bin/bash enclave
sudo -u enclave -H bash -lc '
  git clone https://github.com/liangwenli1/enclave.git ~/enclave
  cd ~/enclave
  npm ci
'
```

### 3. 启动工作台

开发态即可跑 Host（已验证 spawn）：

```bash
cd ~/enclave
npm run dev
```

工作台默认监听所有网卡的 8080。生产请前面加 Nginx / Caddy，只把 443 暴露出去，Node 绑内网。

首次打开 **内核** 页点「下载并校验」。约 135 MB，sha256 必须等于清单里的值，否则拒绝启动。

当前 Host 若以 root 或无 user namespace 的容器运行，Chromium 沙箱起不来。到 **安全中心** 明确勾选 `--no-sandbox`（高风险，写入审计）。自有 VPS 用普通用户跑时，不要勾这项。

### 4. systemd（推荐）

把 [`deploy/enclave.service`](deploy/enclave.service) 拷到 `/etc/systemd/system/enclave.service`，按路径改 `User` / `WorkingDirectory`，然后：

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now enclave
sudo systemctl status enclave
```

### 5. 反向代理示例（Caddy）

```
enclave.example.com {
  reverse_proxy 127.0.0.1:8080
}
```

并改 [`vite.config.ts`](vite.config.ts) 的 `server.host` 为 `127.0.0.1`，避免工作台和 CDP 调试口暴露到公网。CDP 已强制 `127.0.0.1`；工作台本身不要对公网裸奔。

### 不要这样部署

- Vercel / Cloudflare Workers / 任何 Serverless：内核进程会被杀掉。
- 把 `data/kernels/` 打进镜像再分发：绕过哈希准入，属于不受信来源。
- 默认加 `--no-sandbox`、把 `--remote-debugging-address` 绑 `0.0.0.0`。

## 本地开发

```bash
npm ci
npm run dev
npm run typecheck
```

## 许可

工作台源码以本仓库为准。内核是 Ungoogled Chromium + fingerprint-chromium，BSD-3-Clause，补丁源码相对发行有延迟。
