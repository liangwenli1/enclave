# Enclave 最终交付与续建说明

> 卖法和客户用法对齐 AdsPower / GoLogin / Multilogin 这一类：  
> **官网下载桌面安装包 + 账号订阅解锁额度。内核跑在客户自己的电脑上。**  
> 不是服务端开 Chrome、客户端只看网页。不是把现在的 Linux `npm run dev` 当成 1.0。

当前仓库 `liangwenli1/enclave` 是私有源码与 Linux Host 真 spawn 验证机。它证明单轨内核链路可走，**不是最终交付物**。

---

## 1. 最终交付物（只认这些）

对外 1.0 必须同时交出下面全部，缺一不可。

### 1.1 客户拿到的

| 交付件 | 形态 | 说明 |
|---|---|---|
| 工作台安装包 | Windows x64 `.msi` / `.exe` | 已 Authenticode 签名 |
| 工作台安装包 | macOS Apple Silicon `.dmg` | Developer ID + Notarize |
| 内置或随通道下发的内核 | fingerprint-chromium 已准入版本 | 安装后由内核管理器校验 sha256；禁止把未校验二进制打进 Git |
| 官网 / 账号后台 | 注册、登录、套餐、下载页、SHA256 | 安装包免费下，功能靠登录解锁 |
| 文档 | 安装、创建环境、代理、实验室、API、安全说明 | 中英至少一种完整 |

### 1.2 客户用法（1.0 必须是这条，不许改成 VPS 网页）

1. 打开官网，注册，选免费档或付费档。  
2. 下载对应系统的安装包，校验哈希，安装。  
3. 打开 **本机 Enclave 工作台**，登录账号。  
4. 额度从账号同步：可创建的环境数、席位数、是否 API。  
5. 新建环境 → 配代理 → 生成并锁定画像 → 点启动。  
6. **本机弹出（或管住）独立内核窗口**。Cookie / 指纹 / 出口只属于这个环境。  
7. 实验室采集的是该内核窗口，不是工作台自己的页面。  
8. 换电脑：安装客户端并登录；云同步若未做，则只能导出/导入环境包。

失败必须拒启并显示原因码（哈希不符、内核缺失、代理失败、握手失败）。禁止绿灯假 Running。

### 1.3 明确不是交付物

- `npm run dev` / Vite 预览  
- 无签名的 Linux 无头验证机  
- Vercel / Serverless / 把工作台当网站卖  
- 「客户打开你们的网页，Chrome 在你们服务器里」  
- 把 `data/kernels/` 打进镜像分发  
- 承诺过某站风控  

Linux Host 真 spawn 只作为内部验证与适配器实现，可继续留在仓库，但发行通道不叫 1.0。

---

## 2. 商业包装（第一版就要做成能卖的结构）

### 2.1 套餐（额度在客户端强制执行）

| 档 | 环境数 | 席位 | API | 窗口同步 |
|---|---|---|---|---|
| Solo Free | 3 | 1 | 关 | 关 |
| Solo | 50 | 1 | 本机只读发现 | 关 |
| Pro | 200 | 1 | 完整本机 API | 开 |
| Team | 200 起 | 3 起 | 完整 | 开 |

数字可调，结构不要改：按环境数 + 席位订阅，安装包不收费。  
内核安全更新对已付费用户不得锁在更高档。

### 2.2 账号与许可

- 登录后拉 `license`: 档位、到期、环境上限、设备绑定策略（第一版可 1 设备，Pro 2 设备）。  
- 离线宽限：已登录过的机器允许 N 天内仍能启动已有环境，不能新建超限环境。  
- 本地强制：创建环境前检查上限；超限只给升级入口。

### 2.3 厂商侧（薄，不是产品本体）

- 发版台：管理员上传已准入内核 + 应用更新，签 `kernels.manifest` / `app.manifest`。  
- 客户端只信厂商公钥，不追 GitHub latest。  
- 许可证与下载 CDN。挂了不影响「已装机器启动已有环境」。

---

## 3. 现在仓库 vs 1.0

| 模块 | `liangwenli1/enclave` 现状 | 1.0 要求 |
|---|---|---|
| UI 四区 + 安全中心 | 可用 | 原样演进，塞进 Tauri WebView |
| KernelAdapter + Linux 148 哈希 + spawn | 可用 | 增加 win-x64 / mac-arm64 适配器；同一接口 |
| 实验室当前页 vs 内核 CDP | 已在 Linux 无头跑通 | 采集目标改为本机内核窗口；文案带 `runtime: native` |
| Vite 开发预览 | 开发用 | 发行版无此端口；本机 API 默认关，仅 127.0.0.1 |
| 签名安装包 / 可见窗 | 未做 | **必须做** |
| 账号订阅 | 未做或仅脚手架 | **必须做** |
| Tauri Host | 进行中（`crates/host`） | **必须做**：spawn / 校验 / 保险箱 / 更新 全在 Rust |

续建原则：不另起一套假启动。React 工作台保留；Native 能力从 Node 托管迁到 Tauri Host。

---

## 4. 目标架构（发行形态）

```
客户电脑
┌─────────────────────────────────────────┐
│  Enclave.exe / Enclave.app   (Tauri)    │
│  ┌─────────────┐   IPC 白名单            │
│  │ React 工作台 │ ◄────────────┐         │
│  └─────────────┘              │         │
│                    Rust Host ─┤         │
│                    许可/保险箱/更新/监护 │
│                               │ spawn    │
│                    fingerprint-chromium  │
│                    user-data 独立        │
│                    CDP 127.0.0.1        │
└─────────────────────────────────────────┘
              │ 仅更新/登录/地理探测
              ▼
        厂商 HTTPS（清单 + 许可证）
```

数据在客户机：`app.sqlite` + `vault.enc` + `profiles/env_*/` + `kernels/`。

---

## 5. 续建工作流（按此顺序，禁止并行铺网页假实现）

### P0 · 冻结发行合同（本周）

- [x] 本文件与规格第 0.2 节保持一致：单轨 Native，管理员发版，禁止双轨。
- [x] README 开头改成：「开发验证见 Linux Host；发行物是桌面安装包。」
- [x] `kernels.manifest.json` 增加 `win-x64` / `mac-arm64` 槽位。官方 Release 哈希已写入，通道为 `candidate`，未基线不得进 stable。

### P1 · Tauri 壳替换 Vite 进程模型

- [x] `crates/host`：Rust 单轨 spawn / verify / CDP（Linux 验证机已跑通）。
- [ ] `apps/desktop` Tauri 2 在有桌面会话的机器上 `tauri dev` / 签包。配置已放，未在本机编译 WebView。
- [x] 原因码：`KERNEL_HASH_MISMATCH` / `KERNEL_UNTRUSTED_SOURCE` / `SANDBOX_DISABLED_BLOCKED` / `CDP_HANDSHAKE_FAILED` / `HOST_UNAVAILABLE`。
- [x] spawn、verifyOnDisk、端口、回收从 Node 挪到 Rust。Node 只转发。
- [x] README 不再把 Vite 公网监听写成发行路径。

### P2 · 三平台内核通道

- [x] win-x64 / mac-arm64 官方 Release 的 url + sha256 已进清单（candidate）。
- [ ] Windows / macOS 上 spawn、扫描、沙箱默认开的行为基线。
- [ ] 管理员发版台。
- [x] 无 DISPLAY 强制 headless 并在 UI 标明；有显示器时不默认 headless。

### P3 · 账号、额度、安装器

- [ ] 登录与许可证拉取。  
- [ ] 本地创建环境受套餐上限约束。  
- [ ] Windows 签名 + macOS 公证。  
- [ ] 官网下载页公示 SHA256。

### P4 · 抛光到可收款

- [ ] 首次引导、主密码与保险箱、API 默认关、诊断包脱敏、runtime=native。

P0–P4 全绿才允许打 `1.0.0` tag 并上架下载。

---

## 6. 1.0 验收清单（发布门）

见原文功能 / 安全 / 商业三表。当前仓库只验收 Linux 验证机上的单轨 spawn，不打 1.0。

---

## 7. 给开发的一句话

继续开发时，每做一个功能先问：

> 客户装上安装包、在自己电脑点启动，这件事会不会发生？

- 会 → 做进 Host / 工作台。  
- 只会在预览网页上发生 → 不做进 1.0。

最终交付物 = **签过名的桌面安装包 + 订阅账号 + 已准入内核通道**。  
Linux 真 spawn 是到达它的垫脚石，不是终点。
